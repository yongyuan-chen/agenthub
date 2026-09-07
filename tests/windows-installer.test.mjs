import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const installer = fs.readFileSync(new URL('../packages/web/public/install.ps1', import.meta.url), 'utf8');
const setup = fs.readFileSync(new URL('../deploy/setup-node.ps1', import.meta.url), 'utf8');
const wrapper = fs.readFileSync(new URL('../deploy/agenthub-executor-loop.bat.template', import.meta.url), 'utf8');

test('Windows installer bootstraps all dependencies without administrator-only package managers', () => {
  assert.match(installer, /Install-PortableNode/);
  assert.match(installer, /Install-PortableGit/);
  assert.match(installer, /Install-ClaudeCode/);
  assert.match(installer, /nodejs\.org\/dist\/latest-v22\.x/);
  assert.match(installer, /MinGit-/);
  assert.match(installer, /@anthropic-ai\/claude-code@latest/);
  assert.doesNotMatch(installer, /\bwinget\b|\bchoco\b|Start-Process[^\n]*-Verb\s+RunAs/i);
});

test('Windows installer verifies portable archives and has reachable mirror fallbacks', () => {
  assert.match(installer, /Assert-Sha256 \$ZipPath \$ExpectedHash/g);
  assert.match(installer, /registry\.npmmirror\.com\/-\/binary\/git-for-windows/);
  assert.match(installer, /\$Asset\.browser_download_url/);
  assert.match(installer, /registry\.npmjs\.org/);
  assert.match(installer, /registry\.npmmirror\.com/);
  assert.match(installer, /-TimeoutSec \$TimeoutSec/);
});

test('Windows scheduled task supports Claude-only or Codex-only nodes and preserves dependency paths', () => {
  assert.match(setup, /claudeBin\s+=\s+\$ClaudeBin/);
  assert.match(setup, /codexBin\s+=\s+\$CodexBin/);
  assert.match(setup, /-not \$ClaudeCommand -and -not \$CodexCommand/);
  assert.doesNotMatch(setup, /if \(-not \$ClaudeCommand\) \{ throw/);
  assert.match(setup, /__RUNTIME_PATH__/);
  assert.match(wrapper, /set "PATH=__RUNTIME_PATH__;%PATH%"/);
  assert.doesNotMatch(wrapper, /setx/i);
});
