// test/sse-reader.test.mjs — the shared line-SSE transport used by
// bridge-client and opencode-client (both previously hand-rolled this loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const enc = new TextEncoder();

function readerOf(chunks, { close = true } = {}) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      if (close) c.close();
    },
  }).getReader();
}

test('splits lines across chunk boundaries and strips a trailing CR', async () => {
  const lines = [];
  await (await import('../lib/sse-reader.js')).readSseLines(
    readerOf(['data: {"a":1}\r', '\n', 'data: {"b"', ':2}\n']),
    { onLine: (l) => lines.push(l) }
  );
  assert.deepEqual(lines, ['data: {"a":1}', 'data: {"b":2}']);
});

test('a multi-byte character split across chunks decodes correctly', async () => {
  const bytes = enc.encode('data: 中文\n');
  const mid = 8; // inside the multi-byte run
  const lines = [];
  await (await import('../lib/sse-reader.js')).readSseLines(
    readerOf([bytes.slice(0, mid), bytes.slice(mid)]),
    { onLine: (l) => lines.push(l) }
  );
  assert.deepEqual(lines, ['data: 中文']);
});

test('two concurrent streams never share a decoder (CJK split must not leak)', async () => {
  // Regression (2026-10-21 release audit): the module-level TextDecoder was
  // stateful across streams. Stream A ended a chunk inside a 3-byte CJK char,
  // leaving its lead bytes pending; stream B's next decode consumed them and
  // corrupted B's first line ("�data: …"), dropping the event. Each call must
  // own its decoder.
  const { readSseLines } = await import('../lib/sse-reader.js');
  const mid = enc.encode('中');
  const a = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: '));
      c.enqueue(mid.slice(0, 2)); // incomplete character, stream stays open
    },
  }).getReader();
  const linesA = [];
  const pA = readSseLines(a, { onLine: (l) => linesA.push(l) });
  await new Promise((r) => setTimeout(r, 20)); // A has decoded the partial bytes

  const linesB = [];
  await readSseLines(readerOf(['data: 文\n']), { onLine: (l) => linesB.push(l) });
  assert.deepEqual(linesB, ['data: 文'], 'B must decode independently of A\'s pending bytes');

  await a.cancel();
  await pA;
});

test('isAborted ends the loop without consuming the rest of the stream', async () => {
  let aborted = false;
  const lines = [];
  const reader = readerOf(['line1\n', 'line2\n', 'line3\n'], { close: false });
  const p = (await import('../lib/sse-reader.js')).readSseLines(reader, {
    isAborted: () => aborted,
    abortPend: new Promise((r) => { setTimeout(() => { aborted = true; r(); }, 5); }),
    onLine: (l) => { lines.push(l); if (l === 'line1') aborted = true; },
  });
  assert.equal(await p, 'aborted');
  assert.deepEqual(lines, ['line1'], 'no further lines after abort');
});

test('abortPend wins even when the read is pending (never-resolving stream)', async () => {
  let aborted = false;
  const reader = new ReadableStream({ start() { /* stays open */ } }).getReader();
  const res = await (await import('../lib/sse-reader.js')).readSseLines(reader, {
    isAborted: () => aborted,
    abortPend: new Promise((r) => setTimeout(() => { aborted = true; r(); }, 5)),
    onLine: () => {},
  });
  assert.equal(res, 'aborted');
});

// 2026-11-03 audit-4：payload 提取归叶子模块（原在 llm-client——108 行的传输
// 叶子反向 import 1107 行协议层，依赖方向倒置）。llm-client 必须继续 re-export
// 同一函数：lib/handlers/asr-shared.js 仍从 llm-client import 它。
test('sseDataPayload lives in sse-reader; llm-client re-exports the SAME function', async () => {
  const sse = await import('../lib/sse-reader.js');
  const llm = await import('../lib/llm-client.js');
  assert.equal(typeof sse.sseDataPayload, 'function', 'sse-reader must own sseDataPayload');
  assert.equal(llm.sseDataPayload, sse.sseDataPayload, 'llm-client re-export must be the same function (asr-shared consumer)');
  // 行为地板：多行 data: 以 \n 连接、字段名与一个可选空格剥离、注释行不带数据。
  assert.equal(sse.sseDataPayload('event: x\ndata: {"a":\ndata: 1}\n: ka'), '{"a":\n1}');
  assert.equal(sse.sseDataPayload(': keep-alive only'), '');
});

// 2026-11-03 proto-4：五件套编排（aborted 标志 + abortPend + 聚合器组装 +
// EOF flush + finally cancel）收编单入口——两个 consumer 曾逐字复制且已漂移
// （opencode 的 cancel 不在 finally，readSseLines 抛错即跳过）。三个必须保留
// 的现行为在此钉住：① 'aborted' 出口也 flush；② 异常路径不 flush、dispatcher
// 异常原样外抛；③ onHeartbeat 透传（通知不改边界语义）。
test('readSseEvents: dispatches events, flushes the unterminated tail, cancels the body, returns done', async () => {
  const { readSseEvents } = await import('../lib/sse-reader.js');
  const body = new ReadableStream({
    start(c) {
      // 尾事件有换行但无空行边界（无换行的残行不属于任何 complete line，
      // readSseLines 与两个原 consumer 都不将其交给聚合器——行为不变）。
      c.enqueue(enc.encode('data: {"type":"delta"}\n\ndata: {"type":"done"}\n'));
      c.close();
    },
  });
  // closed 流的 cancel() 不触发 underlying cancel（规范），在 reader 层记录调用。
  let cancelled = false;
  const origGetReader = body.getReader.bind(body);
  body.getReader = () => {
    const r = origGetReader();
    const origCancel = r.cancel.bind(r);
    r.cancel = (...a) => { cancelled = true; return origCancel(...a); };
    return r;
  };
  const events = [];
  const res = await readSseEvents(body, { onEvent: (e) => events.push(e) });
  assert.equal(res, 'done');
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done'], 'EOF flush must dispatch the tail event');
  assert.ok(cancelled, 'reader.cancel must run on the done path');
});

test('readSseEvents: abort exits cleanly with aborted and still cancels the body', async () => {
  const { readSseEvents } = await import('../lib/sse-reader.js');
  const ac = new AbortController();
  let cancelled = false;
  let flushedTail = null;
  const body = new ReadableStream({
    start(c) {
      // 首帧完整事件触发 abort；第二帧在 abort 前已入 buffer 的不保证消费，
      // 但 'aborted' 出口必须走 flush（源码 pin 在下面单独断言）。
      c.enqueue(enc.encode('data: {"type":"delta"}\n'));
    },
    cancel() { cancelled = true; },
  });
  const res = await readSseEvents(body, {
    signal: ac.signal,
    onEvent: (e) => { flushedTail = e; ac.abort(); },
  });
  assert.equal(res, 'aborted');
  assert.deepEqual(flushedTail, { type: 'delta' });
  assert.ok(cancelled, 'reader.cancel must run on the aborted path');
});

test('readSseEvents: a pre-aborted signal never reads the body', async () => {
  const { readSseEvents } = await import('../lib/sse-reader.js');
  const ac = new AbortController();
  ac.abort();
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {}\n')); c.close(); } });
  const events = [];
  const res = await readSseEvents(body, { signal: ac.signal, onEvent: (e) => events.push(e) });
  assert.equal(res, 'aborted');
  assert.equal(events.length, 0, 'a pre-aborted signal must dispatch nothing');
});

test('readSseEvents: dispatcher errors propagate verbatim AND the body is cancelled (finally, not sequential)', async () => {
  const { readSseEvents } = await import('../lib/sse-reader.js');
  let cancelled = false;
  const body = new ReadableStream({
    // 流保持 open：closed 流的 cancel() 按规范不触发 underlying cancel，
    // 观察不到 finally 是否执行。
    start(c) { c.enqueue(enc.encode('data: {"boom":true}\n')); },
    cancel() { cancelled = true; },
  });
  const sentinel = new Error('dispatcher sentinel');
  await assert.rejects(
    () => readSseEvents(body, { onEvent: () => { throw sentinel; } }),
    (e) => e === sentinel,
    'the dispatcher error must reach the caller un-wrapped (opencode sse-error classification)'
  );
  assert.ok(cancelled, 'cancel must be in finally — the old opencode sequential cancel skipped this path');
});

test('readSseEvents: onHeartbeat is passed through as notification; comments stay boundaries', async () => {
  const { readSseEvents } = await import('../lib/sse-reader.js');
  const body = new ReadableStream({
    start(c) { c.enqueue(enc.encode('data: bad-frame\n: ka\ndata: {"type":"done"}\n')); c.close(); },
  });
  const events = [];
  const beats = [];
  const res = await readSseEvents(body, { onEvent: (e) => events.push(e), onHeartbeat: () => beats.push(1) });
  assert.equal(res, 'done');
  assert.deepEqual(events.map((e) => e.type), ['done'], 'poison guard must hold through the single entry');
  assert.equal(beats.length, 1);
});

test('readSseEvents source pin: flush runs on BOTH exits (after readSseLines, before return), cancel in finally', async () => {
  // flush 在 'aborted' 出口的可观测效应与即时派发重叠，行为测试难以区分——
  // 源码形状钉住顺序约束（flush 无条件跟在 readSseLines 后；cancel 在 finally）。
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/sse-reader.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function readSseEvents'));
  assert.match(fn, /await readSseLines\([\s\S]*?\);\s*\n\s*onLine\.flush\(\);[^\n]*\n\s*return/,
    'flush must follow readSseLines unconditionally (both done and aborted exits)');
  assert.match(fn, /finally\s*\{[\s\S]*?reader\.cancel\(\)/, 'cancel must live in finally');
});
