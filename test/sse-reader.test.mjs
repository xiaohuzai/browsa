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
