// test/sse-aggregator.test.mjs — lib/sse-reader.js createSseAggregator（bridge 与
// opencode 共用的 line→event 聚合）。2026-11-03 审计：两份手写聚合曾共享一个毒化
// bug——一条非 JSON 的 data: 帧（keepalive 文本/坏帧）parse 失败后留在缓冲区，
// 之后每条事件都拼在它后面永远 parse 失败、永不派发（bridge 丢 done→整轮失败；
// opencode 丢全部直播 delta）。收编单份后在此钉住行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseAggregator } from '../lib/sse-reader.js';

const collect = (opts) => {
  const events = [];
  const beats = [];
  const onLine = createSseAggregator((e) => events.push(e), {
    onHeartbeat: opts?.heartbeat ? () => beats.push(1) : null,
  });
  return { events, beats, onLine };
};
const data = (obj) => `data: ${JSON.stringify(obj)}`;

test('single-line events dispatch immediately (no blank-line separator needed)', () => {
  const { events, onLine } = collect();
  onLine(data({ type: 'delta', text: 'a' }));
  onLine(data({ type: 'delta', text: 'b' }));
  onLine(data({ type: 'done' }));
  assert.deepEqual(events.map((e) => e.type), ['delta', 'delta', 'done']);
});

test('a JSON value split across multiple data: lines parses once complete', () => {
  const { events, onLine } = collect();
  // {"type":"delta","text":"hi"} 拆成三行 data:
  onLine('data: {"type":"delta",');
  onLine('data: "text":"hi"');
  onLine('data: }');
  assert.equal(events.length, 1, 'intermediate fragments must not dispatch');
  assert.deepEqual(events[0], { type: 'delta', text: 'hi' });
});

test('poison guard: a malformed event at a boundary is discarded; later events still dispatch', () => {
  const { events, onLine } = collect();
  onLine('data: keepalive-not-json');   // 坏帧
  onLine('');                            // 事件边界 → 丢弃坏帧
  onLine(data({ type: 'delta', text: 'ok' }));
  onLine('');
  onLine(data({ type: 'done' }));
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done'],
    'the malformed frame must not wedge the stream; done must still dispatch');
});

test('poison guard: malformed frame followed by blank-line-separated good events (bridge terminal-event regression)', () => {
  const { events, onLine } = collect();
  onLine('data: {broken');
  onLine('');
  onLine(data({ type: 'start', sessionId: 's1' }));
  onLine('');
  onLine(data({ type: 'delta', text: 'hello' }));
  onLine('');
  onLine(data({ type: 'done' }));
  onLine('');
  assert.deepEqual(events.map((e) => e.type), ['start', 'delta', 'done']);
});

test('[DONE] sentinel clears the buffer without dispatching', () => {
  const { events, onLine } = collect();
  onLine('data: [DONE]');
  onLine(data({ type: 'delta', text: 'after' }));
  assert.deepEqual(events.map((e) => e.type), ['delta']);
});

test('flush() at EOF dispatches a final event with no trailing blank line; discards a malformed tail', () => {
  const { events, onLine } = collect();
  onLine(data({ type: 'delta', text: 'last' }));
  onLine.flush();
  assert.deepEqual(events.map((e) => e.type), ['delta'], 'EOF flush dispatches the tail event');

  const bad = collect();
  bad.onLine('data: {broken-tail');
  bad.onLine.flush();
  assert.equal(bad.events.length, 0, 'a malformed tail is discarded, not dispatched');
});

test('comment lines: with onHeartbeat fire it (no dispatch); without, act as a boundary', () => {
  const hb = collect({ heartbeat: true });
  hb.onLine(data({ type: 'delta', text: 'x' }));
  hb.onLine(': keepalive');
  assert.equal(hb.beats.length, 1, 'heartbeat fired');
  assert.equal(hb.events.length, 1, 'comment did not double-dispatch');

  const noHb = collect();
  noHb.onLine('data: {broken');
  noHb.onLine(': keepalive');            // 无 heartbeat → 边界，丢弃坏帧
  noHb.onLine(data({ type: 'done' }));
  assert.deepEqual(noHb.events.map((e) => e.type), ['done']);
});