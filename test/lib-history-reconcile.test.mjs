// test/lib-history-reconcile.test.mjs — reconcile 漂移判定（纯函数）：
// 「前裁剪」→ DOM 平移；「追加失败/计数偏高」→ 只重置计数。0.33.0 之前
// 一律按前裁剪处理，provider 在存 user turn 前抛错时会把全部气泡 hidx
// 错误下移，和删除路径的 envelope 误读叠加成连环删错条目。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryReconcile } from '../lib/sidepanel/history-reconcile.js';

const entries = (arr) => arr.map((content) => ({ role: 'user', content }));

test('no drift → none', () => {
  assert.deepEqual(
    planHistoryReconcile({ entries: entries(['a', 'b']), nextHistoryIdx: 2, anchorH: 0, anchorRaw: 'a' }),
    { action: 'none' },
  );
});

test('negative drift (storage longer than counter) → none', () => {
  assert.deepEqual(
    planHistoryReconcile({ entries: entries(['a', 'b', 'c']), nextHistoryIdx: 2, anchorH: 0, anchorRaw: 'a' }),
    { action: 'none' },
  );
});

test('failed append: anchor still at its OWN index → reset only, no shift', () => {
  // bubbles rendered idx 0..2 but storage only has 2 entries — the third
  // append never happened (provider threw). Anchor content matches its own
  // slot, so the correct action is just resetting the counter.
  const plan = planHistoryReconcile({
    entries: entries(['a', 'b']),
    nextHistoryIdx: 3,
    anchorH: 0,
    anchorRaw: 'a',
  });
  assert.deepEqual(plan, { action: 'reset', actualLen: 2 });
});

test('real front-trim: anchor content sits drift-earlier → shift', () => {
  // storage was ['x','a','b'] and trimmed 'x' off the front; the bubble
  // with hidx=1 (raw 'a') now corresponds to storage[0].
  const plan = planHistoryReconcile({
    entries: entries(['a', 'b']),
    nextHistoryIdx: 3,
    anchorH: 1,
    anchorRaw: 'a',
  });
  assert.deepEqual(plan, { action: 'shift', drift: 1, actualLen: 2 });
});

test('undecidable (raw missing / non-matching) → reset only (safe with data.ok-guarded deletes)', () => {
  // anchor raw doesn't match either slot — e.g. content was rewritten
  // post-render. Reset-only degrades to no-op deletes; a wrong shift would
  // corrupt them.
  const plan = planHistoryReconcile({
    entries: entries(['a', 'b']),
    nextHistoryIdx: 3,
    anchorH: 0,
    anchorRaw: '??',
  });
  assert.deepEqual(plan, { action: 'reset', actualLen: 2 });
});

test('array-content entries match via their text part', () => {
  const plan = planHistoryReconcile({
    entries: [[{ type: 'text', text: 'a' }]],
    nextHistoryIdx: 2,
    anchorH: 0,
    anchorRaw: 'a',
  });
  assert.deepEqual(plan, { action: 'reset', actualLen: 1 });
});

test('no anchor bubbles → reset only', () => {
  const plan = planHistoryReconcile({
    entries: entries(['a']),
    nextHistoryIdx: 3,
    anchorH: -1,
    anchorRaw: '',
  });
  assert.deepEqual(plan, { action: 'reset', actualLen: 1 });
});
