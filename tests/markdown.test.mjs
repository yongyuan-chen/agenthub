import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeMarkdownUrl } from '../packages/web/src/md.js';

test('Markdown URL policy rejects executable schemes including control-obfuscated forms', () => {
  for (const value of [
    'javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,x', 'vbscript:msgbox(1)', '  JAVASCRIPT:alert(1)',
  ]) assert.equal(isSafeMarkdownUrl(value, 'href'), false, value);
  assert.equal(isSafeMarkdownUrl('https://example.com/a', 'href'), true);
  assert.equal(isSafeMarkdownUrl('/relative/path', 'href'), true);
  assert.equal(isSafeMarkdownUrl('mailto:test@example.com', 'href'), true);
  assert.equal(isSafeMarkdownUrl('data:image/png;base64,aGVsbG8=', 'src'), true);
  assert.equal(isSafeMarkdownUrl('data:image/svg+xml;base64,PHN2Zz4=', 'src'), false);
});
