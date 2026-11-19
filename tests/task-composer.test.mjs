import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as store from '../packages/web/src/store.js';
import { api } from '../packages/web/src/api.js';

const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(new URL('../packages/web/src/task.jsx', import.meta.url), 'utf8');
const { code } = transformSync(source.replace(/^import[\s\S]*?from '[^']+';\n/gm, ''), { loader: 'jsx', format: 'cjs' });
function load(bindings = {}) {
  const deps = {
    React, ...React, ...store, api, RUNNING_STATUSES: new Set(['running', 'starting']),
    STATUS_META: {}, useElapsed: () => null, isSubagentInternal: m => !!m.content?.parentToolUseId,
    renderMarkdown: text => text, fmtDuration: String, fmtAge: String,
    AttachmentStrip: () => null, AttachButton: () => null,
    useAttachments: () => ({ attachments: [], wireImages: () => [], clearAttachments() {} }),
    ...bindings,
  };
  const module = { exports: {} };
  new Function('module', 'exports', ...Object.keys(deps), code)(module, module.exports, ...Object.values(deps));
  return module.exports;
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(n => nodes(n, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function harness(task = {}, pending = [], apiOverrides = {}) {
  store.resetUserState();
  store.upsertTask({ id: 'T', owner_user_id: 'me', lease: 'daemon', status: 'idle', ...task });
  store.setPendingMessages('T', pending);
  const slots = [];
  let cursor = 0;
  const calls = [];
  const slot = initial => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { TaskPane } = load({
    useState: slot, useRef: value => slot(() => ({ current: value }))[0],
    useEffect() {}, useLayoutEffect() {},
    api: {
      cancel: async id => { calls.push(['cancel', id]); },
      sendMessage: async (...args) => { calls.push(['send', ...args]); return { ok: true }; },
      editLastMessage: async (...args) => { calls.push(['edit', ...args]); return { ok: true }; },
      ...apiOverrides,
    },
  });
  return {
    calls,
    render() { cursor = 0; return TaskPane({ taskId: 'T', user: { id: 'me' } }); },
  };
}
const button = (tree, label) => nodes(tree, n => n.type === 'button' && (n.props['aria-label'] === label || n.props.children === label))[0];

test('composer adds an explicit stop for active statuses and outbound pending, but not failed or held sends', async () => {
  for (const status of ['running', 'starting', 'waiting_human']) {
    const h = harness({ status });
    const tree = h.render();
    assert.equal(button(tree, '停止任务').props.type, 'button');
    assert.equal(button(tree, '发送').props.type, 'submit', 'send stays available so mid-turn messages can queue');
    await nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    assert.deepEqual(h.calls, [], 'implicit submit never cancels');
    await button(tree, '停止任务').props.onClick();
    assert.deepEqual(h.calls, [['cancel', 'T']]);
  }
  assert.ok(button(harness({}, [{ clientMessageId: 'p', state: 'pending' }]).render(), '停止任务'));
  assert.equal(button(harness({}, [{ clientMessageId: 'p', state: 'queued' }]).render(), '停止任务'), undefined);
  assert.equal(button(harness({}, [{ clientMessageId: 'p', state: 'failed' }]).render(), '停止任务'), undefined);
});

test('sending while a turn runs goes out with queueing on, and Enter works too', async () => {
  for (const submit of ['form', 'enter']) {
    const h = harness({ status: 'running' });
    let tree = h.render();
    nodes(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'next' } });
    tree = h.render();
    if (submit === 'form') await nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    else await nodes(tree, n => n.type === 'textarea')[0].props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} });
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 1);
    const [kind, id, text, , , queue] = h.calls[0];
    assert.deepEqual([kind, id, text, queue], ['send', 'T', 'next', true]);
  }
});

test('stop works for project members but not human leases; Enter never stops', async () => {
  const member = harness({ status: 'running', owner_user_id: 'other' });
  let tree = member.render();
  assert.equal(button(tree, '停止任务').props.disabled, false);
  await button(tree, '停止任务').props.onClick();
  assert.deepEqual(member.calls, [['cancel', 'T']]);

  const h = harness({ status: 'running', lease: 'human' });
  tree = h.render();
  assert.equal(button(tree, '停止任务').props.disabled, true);
  await button(tree, '停止任务').props.onClick();
  nodes(tree, n => n.type === 'textarea')[0].props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} });
  assert.deepEqual(h.calls, []);
});

test('stop waits for an in-flight send before cancelling and ignores duplicate clicks', async () => {
  let accept;
  const request = new Promise(resolve => { accept = resolve; });
  const h = harness({}, [], { sendMessage: () => request });
  let tree = h.render();
  nodes(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'hello' } });
  tree = h.render();
  const sending = nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  tree = h.render();
  const stop = button(tree, '停止任务');
  assert.ok(stop);
  const stopping = stop.props.onClick();
  await stop.props.onClick();
  assert.deepEqual(h.calls, []);
  accept({ ok: true });
  await Promise.all([sending, stopping]);
  assert.deepEqual(h.calls, [['cancel', 'T']]);
});

test('editing resends original images and resets the complete message window', async () => {
  const h = harness();
  const images = [{ mediaType: 'image/png', data: 'original' }];
  store.addMessage('T', { seq: 1, role: 'user', content: { text: 'old', images } });
  store.addMessage('T', { seq: 2, role: 'assistant', content: { text: 'old reply' } });
  let tree = h.render();
  nodes(tree, n => n.props?.onEdit && n.props?.messages)[0].props.onEdit(store.taskMessages('T')[0]);
  tree = h.render();
  assert.ok(button(tree, '取消编辑'));
  nodes(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'new' } });
  tree = h.render();
  await nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(h.calls[0].slice(0, 5), ['edit', 'T', 1, 'new', images]);
  assert.equal(typeof h.calls[0][5], 'string');
  assert.deepEqual(store.taskMessages('T'), []);
  assert.equal(store.state.messageEpochs.T, 1);
});

test('editing busy cannot submit twice and a failure retains text and original images', async () => {
  let reject;
  let edits = 0;
  const request = new Promise((resolve, fail) => { reject = fail; });
  const h = harness({ status: 'running' }, [], { editLastMessage: () => { edits++; return request; } });
  const msg = { seq: 1, role: 'user', content: { text: 'original', images: [{ mediaType: 'image/png', data: 'kept' }] } };
  store.addMessage('T', msg);
  let tree = h.render();
  nodes(tree, n => n.props?.onEdit && n.props?.messages)[0].props.onEdit(msg);
  tree = h.render();
  const submit = nodes(tree, n => n.type === 'form')[0].props.onSubmit;
  const sending = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(edits, 1);
  tree = h.render();
  assert.equal(button(tree, '保存并重新发送').props.disabled, true);
  assert.equal(button(tree, '停止任务').props.type, 'button');
  reject(new Error('offline'));
  await sending;
  tree = h.render();
  assert.equal(nodes(tree, n => n.type === 'textarea')[0].props.value, 'original');
  assert.ok(button(tree, '取消编辑'));
  assert.equal(store.taskMessages('T')[0].content.images[0].data, 'kept');
});

test('live sender changes block stale edit handlers before the next render', async () => {
  const h = harness();
  let tree = h.render();
  const msg = { seq: 1, role: 'user', content: { text: 'old' } };
  store.addMessage('T', msg);
  nodes(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value: '' } });
  tree = h.render();
  nodes(tree, n => n.props?.onEdit && n.props?.messages)[0].props.onEdit(msg);
  tree = h.render();
  msg.content.senderUserId = 'other';
  await nodes(tree, n => n.type === 'form')[0].props.onSubmit();
  assert.deepEqual(h.calls, []);
});

test('cancel editing restores the existing text draft without sending', () => {
  const h = harness();
  const msg = { seq: 1, role: 'user', content: { text: 'old' } };
  store.addMessage('T', msg);
  let tree = h.render();
  nodes(tree, n => n.props?.onEdit && n.props?.messages)[0].props.onEdit(msg);
  tree = h.render();
  button(tree, '取消编辑').props.onClick();
  assert.equal(nodes(h.render(), n => n.type === 'textarea')[0].props.value, '');
  assert.deepEqual(h.calls, []);
});

test('latest own user has an accessible edit button; older, foreign and static history do not', () => {
  const { ConversationMessages } = load();
  const messages = [1, 2].map(seq => ({ seq, role: 'user', content: { text: `message ${seq}`, senderUserId: 'me' } }));
  const props = { messages, task: { id: 'T', lease: 'daemon' }, isCreator: true, userId: 'me', onEdit() {} };
  const render = extra => renderToStaticMarkup(React.createElement(ConversationMessages, { ...props, ...extra }));
  assert.equal((render({}).match(/编辑最后一条用户消息/g) || []).length, 1);
  for (const extra of [{ staticHistory: true }, { isCreator: false }, { userId: 'other' }, { task: { lease: 'human' } }]) {
    assert.doesNotMatch(render(extra), /编辑最后一条用户消息/);
  }
});

test('messages_reset clears only its task and synchronously invalidates stale loads', () => {
  store.resetUserState();
  for (const id of ['T', 'other']) {
    store.addMessage(id, { seq: 4, role: 'user', content: {} });
    store.upsertPendingMessage(id, { clientMessageId: id, state: 'pending' });
  }
  const stale = store.messageLoadGuard('T');
  const other = store.messageLoadGuard('other');
  store.applyWsMessage({ t: 'messages_reset', taskId: 'T' });
  assert.equal(stale(), false);
  assert.equal(other(), true);
  assert.deepEqual(store.taskMessages('T'), []);
  assert.deepEqual(store.taskPendingMessages('T'), []);
  assert.equal(store.taskMessages('other').length, 1);
  const current = store.messageLoadGuard('T');
  assert.equal(current(), true);
  store.resetUserState();
  assert.equal(current(), false);
});

test('missed WS reset invalidates overlapping cached history and stale forward/older pages', () => {
  store.resetUserState();
  store.setMessageWindow('T', [
    { seq: 1, role: 'user', content: { text: 'keep' } },
    { seq: 2, role: 'assistant', content: { text: 'deleted suffix' } },
  ]);
  store.upsertPendingMessage('T', { clientMessageId: 'old', state: 'pending' });
  const staleOlder = store.messageLoadGuard('T');
  // A forward response can be empty after a rewind; its watermark still resets.
  assert.equal(store.acceptMessageResetSeq('T', 10), false);
  assert.equal(staleOlder(), false);
  assert.deepEqual(store.taskMessages('T'), []);
  assert.deepEqual(store.taskPendingMessages('T'), []);
  assert.equal(store.state.messageEpochs.T, 1);
  assert.equal(store.acceptMessageResetSeq('T', 10), true);
  store.setMessageWindow('T', [{ seq: 1, role: 'user', content: { text: 'keep' } }]);
  assert.deepEqual(store.taskMessages('T').map(m => m.seq), [1]);
  assert.equal(store.acceptMessageResetSeq('T', 9), false, 'stale server snapshots cannot resurrect deleted rows');
  store.applyWsMessage({ t: 'messages_reset', taskId: 'T', resetSeq: 10 });
  assert.equal(store.state.messageEpochs.T, 1, 'late duplicate WS reset does not wipe a refreshed tail');
  store.applyWsMessage({ t: 'messages_reset', taskId: 'T', resetSeq: 20 });
  assert.equal(store.state.messageEpochs.T, 2);
  assert.equal(store.acceptMessageResetSeq('T', 20), true);
});

test('editLastMessage uses the agreed API contract', async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await api.editLastMessage('T', 8, 'changed', [], 'cm-edit');
    assert.equal(request.url, '/api/tasks/T/edit-message');
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { seq: 8, text: 'changed', images: [], clientMessageId: 'cm-edit' });
  } finally { globalThis.fetch = original; }
});
