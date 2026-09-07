import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutNeedsSave, mergeCloudLayout, samePaneList } from '../packages/web/src/layout-sync.js';

test('layout sync: a never-saved scope does not upload a transient empty list', () => {
  assert.equal(layoutNeedsSave(undefined, []), false);
  assert.equal(layoutNeedsSave(undefined, ['task-1']), true);
});

test('layout sync: an explicitly saved scope can still close its final pane', () => {
  assert.equal(layoutNeedsSave(['task-1'], []), true);
  assert.equal(layoutNeedsSave([], []), false);
});

test('layout sync: cloud panes repair a stale empty local bucket', () => {
  const local = { project: [] };
  const merged = mergeCloudLayout(local, { project: ['task-1', 'task-2'] });
  assert.deepEqual(merged, { project: ['task-1', 'task-2'] });
});

test('layout sync: populated local panes are not erased by stale cloud state', () => {
  const local = { project: ['local-task'] };
  assert.equal(mergeCloudLayout(local, { project: [] }), local);
  assert.equal(mergeCloudLayout(local, { project: ['cloud-task'] }), local);
});

test('layout sync: pane equality is ordered', () => {
  assert.equal(samePaneList(['a', 'b'], ['a', 'b']), true);
  assert.equal(samePaneList(['a', 'b'], ['b', 'a']), false);
});
