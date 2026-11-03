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

// 2026-11-03 proto-2/audit-3：注释行语义两模式同构——恒为事件边界，onHeartbeat
// 只是通知，不改变边界判定。旧实现带 onHeartbeat 时注释行 return 不走边界，
// 「无空行流」兼容模式下坏帧后只有 ': ka' 分隔时毒化永久卡死（见下一条回归）。
// 已知残余取舍：严格按 SSE 规范注释行可插在合法多行事件中间，视为边界会丢弃该
// 未完成事件——no-heartbeat 路径原本就是此行为，且两个真实生产者都发单行
// JSON+空行（bridge 每帧一次 write 含尾随 \n\n），实际无回归面。勿引入
// 「只在坏帧时清缓冲」启发式：无法区分坏帧与合法多行中间态，正是原毒化根源。
test('comment lines are always a boundary; onHeartbeat is notification only (both modes isomorphic)', () => {
  const hb = collect({ heartbeat: true });
  hb.onLine(data({ type: 'delta', text: 'x' }));
  hb.onLine(': keepalive');
  assert.equal(hb.beats.length, 1, 'heartbeat fired');
  assert.equal(hb.events.length, 1, 'comment did not double-dispatch');

  const noHb = collect();
  noHb.onLine('data: {broken');
  noHb.onLine(': keepalive');            // 边界，丢弃坏帧（有无 heartbeat 同构）
  noHb.onLine(data({ type: 'done' }));
  assert.deepEqual(noHb.events.map((e) => e.type), ['done']);
});

test('poison guard holds in heartbeat mode: bad frame + comment separator + no blank lines still dispatches', () => {
  // bridge 配置（onHeartbeat）+ 无空行流：坏帧后的 ': ka' 必须清掉不可解析
  // 残留，否则 done 永远拼在坏帧后面不派发（整轮 "stream ended without a
  // terminal event"）。231ae82 消灭的毒化类不得在 heartbeat 配置下复活。
  const { events, beats, onLine } = collect({ heartbeat: true });
  onLine('data: not-json');
  onLine(': ka');
  onLine(data({ type: 'delta', text: 'ok' }));
  onLine(': ka');
  onLine(data({ type: 'done' }));
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done'],
    'the malformed frame must not wedge a heartbeat-mode stream');
  assert.equal(beats.length, 2, 'heartbeats still fire');
});