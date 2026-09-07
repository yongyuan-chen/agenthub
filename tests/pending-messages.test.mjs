// Rendering + store checks for pending (in-flight) chat messages.
//
// These exist because the failure being fixed is invisible-by-nature: a
// message that was sent but not delivered used to render as *nothing*, which
// is indistinguishable from "never typed it". So the assertions are about
// what the user can actually see — the text stays on screen while in flight,
// it doesn't double up when the real message lands, and a delivery that
// fails becomes a retry affordance rather than silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.join(here, '../packages/web/src');
// react/react-dom are installed under packages/web (that's where the frontend
// builds from), so resolve them from there rather than the repo root.
const webRequire = createRequire(path.join(here, '../packages/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

// task.jsx is JSX and pulls in the whole app graph; compiling just the one
// component under test keeps this a rendering test rather than an app boot.
function loadPendingMessage() {
  const source = fs.readFileSync(path.join(webSrc, 'task.jsx'), 'utf8');
  const start = source.indexOf('function PendingMessage(');
  assert.ok(start > 0, 'PendingMessage component still exists in task.jsx');
  const end = source.indexOf('\nfunction ', start + 1);
  const component = source.slice(start, end === -1 ? undefined : end);
  const { code } = transformSync(
    // Md/AttachedImages are stubbed: this asserts the pending row's own
    // markup (状态文案, failed styling, retry button), not markdown rendering.
    `const Md = ({ text }) => React.createElement('div', { className: 'md' }, text);
     const AttachedImages = ({ images }) => images?.length
       ? React.createElement('div', { className: 'msg-images' }, String(images.length)) : null;
     ${component}
     module.exports = { PendingMessage };`,
    { loader: 'jsx', format: 'cjs' },
  );
  const module = { exports: {} };
  new Function('module', 'exports', 'React', 'require', code)(module, module.exports, React, webRequire);
  return module.exports.PendingMessage;
}

const PendingMessage = loadPendingMessage();

test('pending message: an in-flight send keeps the user text on screen', () => {
  const html = renderToStaticMarkup(React.createElement(PendingMessage, {
    pending: { clientMessageId: 'cm-1', text: '还没送到的消息', images: [], state: 'pending' },
    canRetry: true, onRetry: () => {}, onImageClick: () => {},
  }));
  assert.match(html, /还没送到的消息/, 'the text the user typed is visible, not swallowed');
  assert.match(html, /正在等待节点接收/, 'and is labelled as still on its way');
  assert.doesNotMatch(html, /重发/, 'no retry button while it may still land on its own');
});

test('pending message: a failed send becomes retryable instead of disappearing', () => {
  const html = renderToStaticMarkup(React.createElement(PendingMessage, {
    pending: { clientMessageId: 'cm-2', text: '送不到的消息', images: [], state: 'failed' },
    canRetry: true, onRetry: () => {}, onImageClick: () => {},
  }));
  assert.match(html, /送不到的消息/, 'the text survives the failure');
  assert.match(html, /消息没有丢/, 'and the user is told so explicitly');
  assert.match(html, /重发<\/button>/, 'with a way to send it again');
  assert.match(html, /pending-msg failed/, 'visually distinguished from a still-in-flight one');
});

test('pending message: retry is hidden while the IDE owns the session', () => {
  const html = renderToStaticMarkup(React.createElement(PendingMessage, {
    pending: { clientMessageId: 'cm-3', text: 'x', images: [], state: 'failed' },
    canRetry: false, onRetry: () => {}, onImageClick: () => {},
  }));
  assert.doesNotMatch(html, /重发<\/button>/, 'no button that would just be refused server-side');
});

// ---- store: the pending/real handoff ----
// Loaded through the same compile path (store.js is plain JS but imports
// nothing else, so a direct import is enough).
const store = await import('../packages/web/src/store.js');

test('pending store: the real message retires its own pending bubble', () => {
  store.resetUserState();
  store.upsertPendingMessage('T1', { clientMessageId: 'cm-a', text: '你好', state: 'pending', createdAt: 1 });
  assert.equal(store.taskPendingMessages('T1').length, 1);

  store.addMessage('T1', { seq: 5, role: 'user', content: { text: '你好', clientMessageId: 'cm-a' } });
  assert.deepEqual(store.taskPendingMessages('T1'), [], 'no duplicate bubble once the message really lands');
});

test('pending store: a replayed pending_msg cannot resurrect a delivered message', () => {
  store.resetUserState();
  store.addMessage('T2', { seq: 3, role: 'user', content: { text: '已送达', clientMessageId: 'cm-b' } });
  // e.g. a reconnect replaying an accept the client already saw settle.
  store.upsertPendingMessage('T2', { clientMessageId: 'cm-b', text: '已送达', state: 'pending', createdAt: 1 });
  assert.deepEqual(store.taskPendingMessages('T2'), [], 'the conversation does not show it twice');
});

test('pending store: the server list is authoritative on refresh', () => {
  store.resetUserState();
  store.upsertPendingMessage('T3', { clientMessageId: 'stale', text: '旧的', state: 'pending', createdAt: 1 });
  // What GET /messages returned: 'stale' is gone (delivered while away),
  // 'live' is still in flight.
  store.setPendingMessages('T3', [{ clientMessageId: 'live', text: '新的', state: 'pending', createdAt: 2 }]);
  assert.deepEqual(store.taskPendingMessages('T3').map(p => p.clientMessageId), ['live']);

  store.setPendingMessages('T3', []);
  assert.deepEqual(store.taskPendingMessages('T3'), [], 'an empty server list clears the local copy');
});

test('pending store: failure is reflected without losing the text', () => {
  store.resetUserState();
  store.upsertPendingMessage('T4', { clientMessageId: 'cm-c', text: '重要内容', state: 'pending', createdAt: 1 });
  store.markPendingMessageFailed('T4', 'cm-c');
  const [pending] = store.taskPendingMessages('T4');
  assert.equal(pending.state, 'failed');
  assert.equal(pending.text, '重要内容', 'the text is still there to retry with');
});
