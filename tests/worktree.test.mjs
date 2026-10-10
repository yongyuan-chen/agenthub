// prepareWorkspace() splits on one question: is there already a directory on
// this machine to work in?
//   local path  → used exactly as given. No clone, no worktree, no branch, no
//                 git at all (whether or not it happens to be a repo).
//   remote URL  → nothing local exists, so clone + an isolated worktree per
//                 task, which is where the default-branch detection matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareWorkspace, isManagedDir } from '../packages/executor/src/worktree.mjs';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeSourceRepo(defaultBranch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-src-'));
  git(dir, 'init', '-q', '-b', defaultBranch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

// A file:// URL is how these exercise the remote path: there is no local
// directory at that string, so prepareWorkspace treats it as a real remote
// and takes the clone+worktree branch, without the test needing network.
const remote = (dir) => pathToFileURL(dir).href;

test('prepareWorkspace: auto-detects a non-main default branch when baseBranch is unset', async () => {
  const sourceRepo = makeSourceRepo('master');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
  const config = { workRoot };
  const taskId = 'task-nomaindefault';

  const { dir, branchName } = await prepareWorkspace(config, { taskId, repoUrl: remote(sourceRepo), baseBranch: null });

  assert.equal(branchName, `task/${taskId}`);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'worktree checked out from the detected default branch');
  const branches = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(branches, branchName);
});

test('prepareWorkspace: an explicit baseBranch still wins over auto-detection', async () => {
  const sourceRepo = makeSourceRepo('master');
  git(sourceRepo, 'checkout', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(sourceRepo, 'develop-only.txt'), 'x\n');
  git(sourceRepo, 'add', '-A');
  git(sourceRepo, 'commit', '-q', '-m', 'develop commit');

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
  const config = { workRoot };
  const taskId = 'task-explicitbranch';

  const { dir } = await prepareWorkspace(config, { taskId, repoUrl: remote(sourceRepo), baseBranch: 'develop' });
  assert.ok(fs.existsSync(path.join(dir, 'develop-only.txt')), 'used the explicitly requested branch, not the default');
});

test('prepareWorkspace: a local git repo is worked in directly, never cloned into a worktree', async () => {
  // The user-visible bug this fixes: the board showed the task's repo as
  // C:\...\Desktop\quant\quant while the file browser (which resolves a
  // taskId to the task's real dir) served C:\...\agenthub\wt-<taskId> — a
  // clone of the default branch that never saw the user's uncommitted work.
  const sourceRepo = makeSourceRepo('master');
  fs.writeFileSync(path.join(sourceRepo, 'uncommitted.txt'), 'work in progress\n');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
  const config = { workRoot };
  const taskId = 'task-localrepo';

  const { dir, branchName } = await prepareWorkspace(config, { taskId, repoUrl: sourceRepo, baseBranch: null });

  assert.equal(dir, sourceRepo, 'the working directory IS the path the user gave');
  assert.equal(branchName, null, 'no branch is created — the repo stays on whatever it was checked out to');
  assert.ok(fs.existsSync(path.join(dir, 'uncommitted.txt')), 'uncommitted work is visible, which a fresh clone would have missed');
  assert.ok(!fs.existsSync(path.join(workRoot, `wt-${taskId}`)), 'no worktree');
  // config.mjs pre-creates repos/ on a real node; here its absence is the
  // cleanest possible proof that the clone path was never entered.
  const cached = fs.existsSync(path.join(workRoot, 'repos')) ? fs.readdirSync(path.join(workRoot, 'repos')) : [];
  assert.deepEqual(cached, [], 'nothing cloned into the repo cache');
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: sourceRepo, encoding: 'utf8' }).trim(), 'master',
    'the user\'s checked-out branch is untouched',
  );
});

test('prepareWorkspace: an explicit baseBranch cannot drag a local repo off its checkout', async () => {
  // baseBranch only means anything on the clone path. A local directory is
  // worked in as-is — silently checking out a different branch would be
  // rewriting the user's working tree out from under them.
  const sourceRepo = makeSourceRepo('master');
  git(sourceRepo, 'branch', 'develop');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));

  const { dir } = await prepareWorkspace({ workRoot }, { taskId: 'task-localbase', repoUrl: sourceRepo, baseBranch: 'develop' });

  assert.equal(dir, sourceRepo);
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: sourceRepo, encoding: 'utf8' }).trim(), 'master',
    'still on master — baseBranch was ignored rather than applied destructively',
  );
});

test('isManagedDir: only scratch dirs and worktrees under workRoot are ours to run git against', () => {
  const workRoot = path.join(os.tmpdir(), 'ah-managed-root');
  const config = { workRoot };

  assert.equal(isManagedDir(config, path.join(workRoot, 'wt-task123')), true);
  assert.equal(isManagedDir(config, path.join(workRoot, 'scratch', 'task123')), true);
  assert.equal(isManagedDir(config, workRoot), true);
  assert.equal(isManagedDir(config, '/Users/someone/Desktop/quant/quant'), false);
  assert.equal(isManagedDir(config, `${workRoot}-not-actually-inside`), false, 'prefix match must respect the path separator');
  assert.equal(isManagedDir(config, null), false);
  assert.equal(isManagedDir({}, path.join(workRoot, 'wt-x')), false);
});

test('prepareWorkspace: a local path that exists but is not a git repo is used directly, not cloned', async () => {
  // Found live: a user pointed a task at a real Windows folder that was
  // never git-initialized — `git clone <that path>` fails with "does not
  // appear to be a git repository", which used to fail the whole task.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plain-'));
  fs.writeFileSync(path.join(plainDir, 'strategy.py'), 'print("hi")\n');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
  const config = { workRoot };
  const taskId = 'task-plaindir';

  const { dir, branchName } = await prepareWorkspace(config, { taskId, repoUrl: plainDir, baseBranch: null });

  assert.equal(dir, plainDir, 'operates directly in the given folder instead of attempting an isolated clone');
  assert.equal(branchName, null, 'no worktree/branch machinery for a non-git directory');
  assert.ok(fs.existsSync(path.join(dir, 'strategy.py')), 'the real file is visible — nothing was cloned/copied');
});

test('prepareWorkspace: a genuinely bad remote URL still fails loudly, not silently degraded', async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
  const config = { workRoot };
  await assert.rejects(
    prepareWorkspace(config, { taskId: 'task-badremote', repoUrl: 'https://example.invalid/nope.git', baseBranch: null }),
  );
});
