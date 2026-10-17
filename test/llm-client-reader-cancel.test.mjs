// test/llm-client-reader-cancel.test.mjs — openSseStream's reader lifecycle.
//
// A fatal provider event (response.failed / run.failed / error) is thrown
// from INSIDE parseEvent, i.e. while the read loop is suspended between
// reads. Before the try/finally wrapper the reader was never cancelled on
// that path: the HTTP body stayed open (server may keep generating/billing)
// and the reader hung around until the service worker was recycled. This
// test pins the contract for the responses protocol (the shared skeleton is
// the same for chat / runs / anthropic).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const enc = new TextEncoder();

test('openSseStream cancels the response reader when a fatal event throws mid-stream', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');

  let cancelCalls = 0;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(
        'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","delta":"abc"}\n\n'
      ));
      // A fatal event: parseEvent throws from here, aborting the loop.
      c.enqueue(enc.encode(
        'event: response.failed\n' +
        'data: {"type":"response.failed","error":{"message":"model exploded"}}\n\n'
      ));
      // Deliberately left OPEN: without cancel() this stream would keep living.
    },
    cancel() { cancelCalls++; },
  });

  globalThis.fetch = async () => ({ ok: true, status: 200, body, text: async () => '' });

  await assert.rejects(
    () => responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi', onDelta: () => {} }),
    (e) => e.name === 'ProviderAPIError' && /model exploded/.test(e.message)
  );

  // The loop throws synchronously after reading the failed event, so the
  // finally block has already run by the time the rejection is observed.
  assert.equal(cancelCalls, 1, 'the reader must be cancelled exactly once on the fatal-event path');
});

test('openSseStream also releases the reader on normal completion (teardown is a no-op, never a failure)', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');

  let cancelCalls = 0;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(
        'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","delta":"done"}\n\n' +
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      ));
      c.close();
    },
    cancel() { cancelCalls++; },
  });

  globalThis.fetch = async () => ({ ok: true, status: 200, body, text: async () => '' });

  const r = await responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi', onDelta: () => {} });
  assert.equal(r.full, 'done');
  // A reader over an already-closed stream treats cancel() as a no-op, so the
  // underlying sink may never be told — the contract here is only that the
  // unconditional teardown doesn't throw or alter the result.
  assert.ok(cancelCalls <= 1, 'teardown must never cancel more than once');
});
