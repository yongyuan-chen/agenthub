// Workspace management: git worktrees for repo tasks, scratch dirs otherwise.
// prepareWorkspace is async — clone/fetch can take minutes and must not starve
// the event loop (heartbeats would stop and the cloud would mark us offline).
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const execFileP = promisify(execFile);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function gitAsync(cwd, ...args) {
  const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Many repos (especially older ones, or ones cloned from a local path) don't
// use 'main' as their default branch — blindly assuming it breaks worktree
// creation with "Not a valid object name: 'main'". Ask the clone itself.
function detectDefaultBranch(repoDir) {
  try {
    const ref = git(repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim(); // 'origin/master'
    if (ref) return ref.replace(/^origin\//, '');
  } catch { /* origin/HEAD not set — fall through */ }
  try {
    const cur = git(repoDir, 'branch', '--show-current').trim();
    if (cur) return cur;
  } catch { /* detached HEAD / empty repo */ }
  return null;
}

// Is this a directory AgentHub itself made (a scratch dir or a worktree under
// workRoot), or a real project directory the user pointed a task at? Only the
// former may be touched with mutating git commands — see manager.mjs's
// _publishDiff, which collects no diff at all in a user directory rather than
// running `git add -A` inside someone's actual working repo.
export function isManagedDir(config, dir) {
  if (!dir || !config?.workRoot) return false;
  const root = path.resolve(config.workRoot);
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export async function prepareWorkspace(config, task) {
  if (!task.repoUrl) {
    const dir = path.join(config.workRoot, 'scratch', task.taskId);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) git(dir, 'init', '-q');
    return { dir, branchName: null };
  }
  // A path that already exists on this machine *is* the workspace — used
  // exactly as given, with no clone, no worktree, no branch, and no git
  // command of any kind. The agent works in the user's real directory and
  // the file browser (which resolves a taskId to this same dir) shows that
  // real path, which is the whole point: the isolated-worktree flow left the
  // board reporting a repo of C:\...\Desktop\quant\quant while every file it
  // opened came from C:\...\agenthub\wt-<taskId>, an unrelated clone of the
  // default branch that never saw the user's uncommitted work.
  // Deliberately not conditional on the directory being a git repo: whether
  // the project is version-controlled is the user's business, not a thing
  // that should change where their agent runs.
  let stat;
  try { stat = fs.statSync(task.repoUrl); } catch { stat = null; }
  if (stat?.isDirectory()) return { dir: task.repoUrl, branchName: null };
  // Only a genuine remote (or a file:// URL) reaches here: nothing local to
  // work in, so a clone is the only option and an isolated worktree per task
  // costs nothing. A failure here is a real failure — bad URL, auth,
  // network — and must surface rather than silently degrade.
  const repoKey = createHash('sha256').update(task.repoUrl).digest('hex').slice(0, 12);
  const repoDir = path.join(config.workRoot, 'repos', repoKey);
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    await execFileP('git', ['clone', task.repoUrl, repoDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } else {
    try { await gitAsync(repoDir, 'fetch', '--all', '-q'); } catch { /* offline: use local state */ }
  }
  const branchName = `task/${task.taskId}`;
  const wtDir = path.join(config.workRoot, 'wt-' + task.taskId);
  if (!fs.existsSync(wtDir)) {
    const base = task.baseBranch || detectDefaultBranch(repoDir) || 'main';
    let baseRef = base;
    try { git(repoDir, 'rev-parse', '--verify', `origin/${base}`); baseRef = `origin/${base}`; } catch { /* local branch */ }
    await gitAsync(repoDir, 'worktree', 'add', '-b', branchName, wtDir, baseRef);
  }
  return { dir: wtDir, branchName };
}

// Diff of everything the agent changed (staged view so new files are included).
export function collectDiff(task) {
  const dir = task.dir;
  if (!dir || !fs.existsSync(dir)) return { stat: '', patch: '' };
  try {
    git(dir, 'add', '-A');
    const base = task.repo_url || task.repoUrl
      ? (mergeBase(dir, task.base_branch || task.baseBranch || detectDefaultBranch(dir) || 'main'))
      : emptyTree(dir);
    const stat = git(dir, 'diff', '--cached', '--stat', base);
    let patch = git(dir, 'diff', '--cached', base);
    const LIMIT = 800_000;
    if (patch.length > LIMIT) patch = patch.slice(0, LIMIT) + '\n... [diff truncated] ...\n';
    return { stat: stat.trim(), patch };
  } catch (e) {
    return { stat: '', patch: `(diff unavailable: ${e.message})` };
  }
}

function mergeBase(dir, baseBranch) {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try { return git(dir, 'merge-base', ref, 'HEAD').trim(); } catch { /* try next */ }
  }
  return emptyTree(dir);
}

function emptyTree(dir) {
  try { return git(dir, 'rev-parse', 'HEAD').trim(); }
  catch { return git(dir, 'hash-object', '-t', 'tree', '/dev/null').trim(); }
}
