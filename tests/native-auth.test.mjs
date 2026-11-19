import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pickShellVars, nativeEnv, parseClaudeStatus, parseCodexStatus, codexConfiguredProvider, detectNativeAuth,
} from '../packages/executor/src/native-auth.mjs';

test('native auth: only whitelisted shell variables are imported', () => {
  const raw = [
    'ANTHROPIC_BASE_URL=https://relay', 'ANTHROPIC_AUTH_TOKEN=tok', 'OPENAI_API_KEY=sk', 'CODEX_API_KEY=ck',
    'https_proxy=http://127.0.0.1:7890', 'NO_PROXY=localhost', 'CLAUDE_CODE_USE_BEDROCK=1', 'AWS_REGION=us-east-1',
    'PATH=/evil', 'PS1=$ ', 'CODEX_HOME=/elsewhere', 'CLAUDE_CONFIG_DIR=/elsewhere', 'MULTI=a=b',
  ].join('\0');
  assert.deepEqual(pickShellVars(raw), {
    ANTHROPIC_BASE_URL: 'https://relay', ANTHROPIC_AUTH_TOKEN: 'tok', OPENAI_API_KEY: 'sk', CODEX_API_KEY: 'ck',
    https_proxy: 'http://127.0.0.1:7890', NO_PROXY: 'localhost', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1',
  });
});

test('native auth: the child env keeps host credentials but drops AgentHub/IDE leftovers', () => {
  const env = nativeEnv(
    { PATH: '/bin', ANTHROPIC_API_KEY: 'host', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/isolated', CODEX_HOME: '/isolated' },
    { ANTHROPIC_API_KEY: 'from-shell', HTTPS_PROXY: 'http://p' },
  );
  assert.deepEqual(env, { PATH: '/bin', ANTHROPIC_API_KEY: 'from-shell', HTTPS_PROXY: 'http://p' });
});

test('native auth: claude status is reduced to non-secret fields', () => {
  assert.deepEqual(
    parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgId":"x"}'),
    { loggedIn: true, method: 'claude.ai', provider: 'firstParty', source: null },
  );
  assert.deepEqual(
    parseClaudeStatus('warning: something\n{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}'),
    { loggedIn: true, method: 'api_key', provider: null, source: 'ANTHROPIC_API_KEY' },
  );
  assert.equal(parseClaudeStatus('error: unknown command auth'), null, 'an old CLI without `auth status`');
});

test('native auth: codex status never forwards the key suffix', () => {
  assert.deepEqual(parseCodexStatus(0, 'Logged in using ChatGPT\n'), { loggedIn: true, method: 'chatgpt' });
  const k = parseCodexStatus(0, 'Logged in using an API key - sk-proj-***abcd\n');
  assert.deepEqual(k, { loggedIn: true, method: 'api_key' });
  assert.deepEqual(parseCodexStatus(1, 'Not logged in\n'), { loggedIn: false, method: null });
});

test('native auth: a top-level model_provider in config.toml counts as configured', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-home-'));
  assert.equal(codexConfiguredProvider(home), null);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5"\nmodel_provider = "myrelay"\n[model_providers.myrelay]\nbase_url = "https://x"\n');
  assert.equal(codexConfiguredProvider(home), 'myrelay');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5"\n[profiles.work]\nmodel_provider = "other"\n');
  assert.equal(codexConfiguredProvider(home), null, 'a profile-scoped provider is opt-in, not the default');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider = "openai"\n');
  assert.equal(codexConfiguredProvider(home), null, 'the built-in provider is just the login');
});

test('native auth: detection skips CLIs that are not installed', async () => {
  const calls = [];
  const info = await detectNativeAuth({ claudeBin: 'claude', codexBin: 'codex' }, {
    installed: { claude: true, codex: false }, env: {}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ah-home-')),
    runImpl: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, out: '{"loggedIn":false}' }; },
  });
  assert.deepEqual(calls, [['claude', 'auth', 'status', '--json']]);
  assert.deepEqual(info.claude, { loggedIn: false, method: null, provider: null, source: null });
  assert.equal(info.codex, null);
});

test('native auth: a relay set up on the machine is told apart from an official login', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-home-'));
  const runImpl = async () => ({ code: 0, out: '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}' });
  const opts = { installed: { claude: true, codex: false }, runImpl, home };
  assert.equal((await detectNativeAuth({}, { ...opts, env: {} })).claude.customEndpoint, undefined);
  assert.equal((await detectNativeAuth({}, { ...opts, env: { ANTHROPIC_BASE_URL: 'https://relay' } })).claude.customEndpoint, true);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay' } }));
  const info = await detectNativeAuth({}, { ...opts, env: {} });
  assert.equal(info.claude.customEndpoint, true);
  assert.equal(JSON.stringify(info).includes('relay'), false, 'the URL itself never leaves the node');
});
