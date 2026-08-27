// Regression test: prepareWorkspace() must not assume a repo's default
// branch is 'main' — many repos (older projects, or ones cloned from a local
// path) default to 'master' or something else, which used to fail worktree
// creation with "Not a valid object name: 'main'".
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareWorkspace } from '../packages/executor/src/worktree.mjs';

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

test('prepareWorkspace: auto-detects a non-main default branch when baseBranch is unset', async () => {
  const sourceRepo = makeSourceRepo('master');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
  const config = { workRoot };
  const taskId = 'task-nomaindefault';

  const { dir, branchName } = await prepareWorkspace(config, { taskId, repoUrl: sourceRepo, baseBranch: null });

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

  const { dir } = await prepareWorkspace(config, { taskId, repoUrl: sourceRepo, baseBranch: 'develop' });
  assert.ok(fs.existsSync(path.join(dir, 'develop-only.txt')), 'used the explicitly requested branch, not the default');
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
