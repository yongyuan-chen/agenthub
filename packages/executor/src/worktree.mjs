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

export async function prepareWorkspace(config, task) {
  if (!task.repoUrl) {
    const dir = path.join(config.workRoot, 'scratch', task.taskId);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) git(dir, 'init', '-q');
    return { dir, branchName: null };
  }
  const repoKey = createHash('sha256').update(task.repoUrl).digest('hex').slice(0, 12);
  const repoDir = path.join(config.workRoot, 'repos', repoKey);
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    try {
      await execFileP('git', ['clone', task.repoUrl, repoDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      // `git clone <local-path>` only ever works when that path is itself a
      // git repo — but pointing at a plain project folder (no .git at all)
      // to just work in directly is completely reasonable and was silently
      // unsupported (found live: a Windows path to a non-git folder failed
      // with "does not appear to be a git repository", surfaced to the user
      // as an opaque "workspace: Command failed" task failure). Fall back to
      // operating directly in it, same philosophy manager.mjs's
      // session-resume path already uses for an arbitrary local directory —
      // but only when the source really is a local dir; a genuine remote
      // clone failure (bad URL, auth, network) must still surface as an
      // error rather than silently degrading.
      let stat;
      try { stat = fs.statSync(task.repoUrl); } catch { stat = null; }
      if (stat?.isDirectory()) return { dir: task.repoUrl, branchName: null };
      throw e;
    }
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
