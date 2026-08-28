// test/responses-stream.test.mjs
// Regression test for the "reasoning block swallows the final agent
// reply" bug, now covering runsApiStream() (the /v1/runs replacement for
// the retired responsesApiStream()/v1/responses path — same underlying
// bug shape, same fix pattern).
//
// run.completed diffed its output text against `full.length`, but `full`
// also accumulates injected <thinking>...</thinking> block text from
// reasoning.available events. When a tool-using turn only emits its real
// answer inside run.completed, a thinking block longer than that answer
// made `completedText.length > full.length` false, and the answer was
// silently dropped — never reaching onDelta, never persisted to history.
//
// Fix: track `messageTextLen` (message-only text length, from message.delta
// only) separately from `full`, and diff run.completed against that instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Builds a fake SSE ReadableStream body from a list of {event, data} pairs,
// in the "event: X\ndata: {...}\n\n" shape runsApiStream() parses.
function buildSseStream(events) {
  const encoder = new TextEncoder();
  let text = '';
  for (const { event, data } of events) {
    text += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

// runsApiStream makes two fetches: POST /v1/runs (returns run_id as JSON),
// then GET /v1/runs/{id}/events (returns the SSE stream).
function mockFetchWithEvents(events) {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({ run_id: 'run_1' }) };
    }
    return { ok: true, status: 200, body: buildSseStream(events), text: async () => '' };
  };
}

test('runsApiStream: reasoning block does not swallow a tool-turn final answer (regression)', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');

  // Thinking text is deliberately longer than the final answer, which is
  // exactly the shape that triggered the bug: full.length (padded by the
  // <thinking> block) ends up bigger than completedText.length, so the
  // old `completedText.length > full.length` check never fires.
  mockFetchWithEvents([
    {
      event: 'reasoning.available',
      data: { text: 'Let me think about this problem carefully and check the available tools before answering.' }
    },
    {
      event: 'run.completed',
      data: { output: 'Done.', usage: { total_tokens: 42 } }
    }
  ]);

  const deltas = [];
  const result = await runsApiStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    input: 'hi',
    onDelta: (d) => deltas.push(d)
  });

  const emitted = deltas.join('');
  assert.ok(emitted.includes('Done.'), `final answer must be emitted via onDelta, got: ${JSON.stringify(deltas)}`);
  assert.ok(result.full.includes('Done.'), `final answer must be present in the returned full text, got: ${JSON.stringify(result.full)}`);
  assert.equal(result.usage?.total_tokens, 42);
});

test('runsApiStream: plain delta-only turn (no thinking, no tools) is unaffected', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');

  mockFetchWithEvents([
    { event: 'message.delta', data: { delta: 'Hello' } },
    { event: 'message.delta', data: { delta: ' world' } },
    { event: 'run.completed', data: { output: 'Hello world' } }
  ]);

  const deltas = [];
  const result = await runsApiStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    input: 'hi',
    onDelta: (d) => deltas.push(d)
  });

  assert.equal(deltas.join(''), 'Hello world', 'run.completed must not re-emit text already streamed via message.delta');
  assert.equal(result.full, 'Hello world');
});

test('runsApiStream: partial deltas before tools, remainder streamed after (no duplication, no loss)', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');

  mockFetchWithEvents([
    { event: 'message.delta', data: { delta: 'Pre-tool text. ' } },
    { event: 'tool.started', data: { name: 'search' } },
    { event: 'run.completed', data: { output: 'Pre-tool text. Post-tool answer.' } }
  ]);

  const deltas = [];
  const result = await runsApiStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    input: 'hi',
    onDelta: (d) => deltas.push(d),
    onToolProgress: () => {}
  });

  assert.equal(deltas.join(''), 'Pre-tool text. Post-tool answer.', 'only the unstreamed remainder should be emitted after run.completed');
  assert.equal(result.full, 'Pre-tool text. Post-tool answer.');
});

// ─── CRLF SSE: \r\n\r\n block separators must not lose the whole reply ──────
// The parsers split events on '\n\n'; a provider emitting \r\n line endings
// produces \r\n\r\n blocks that never match, so runs/responses/anthropic
// adapters used to return an empty reply.

test('runsApiStream: CRLF (\\r\\n) SSE framing still delivers the full reply', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js?crlf=' + Math.random());

  const sse = 'event: message.delta\r\ndata: {"delta":"hello from crlf"}\r\n\r\n'
    + 'event: run.completed\r\ndata: {"output":"hello from crlf"}\r\n\r\n';
  const bytes = new TextEncoder().encode(sse);
  // runsApiStream makes two fetches: POST /v1/runs, then the events GET.
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ run_id: 'run_crlf' }) };
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); }
      }),
      text: async () => ''
    };
  };

  const deltas = [];
  const result = await runsApiStream({ baseUrl: 'http://test', apiKey: 'k', input: 'hi', onDelta: (d) => deltas.push(d) });
  assert.match(result.full, /hello from crlf/, 'CRLF framing must not lose the reply');
  assert.match(deltas.join(''), /hello from crlf/, 'deltas must stream under CRLF framing too');
});

// ─── hermes run.completed divergence: never chop the answer's head ────────
test('runsApiStream: run.completed output diverging from streamed deltas is delivered whole, not head-sliced', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js?div=' + Math.random());

  const streamed = 'A'.repeat(10);           // message.delta narration
  const finalOutput = 'B'.repeat(20);        // authoritative answer, no shared prefix
  const sse = `event: message.delta\ndata: {"delta":"${streamed}"}\n\n`
    + `event: run.completed\ndata: {"output":"${finalOutput}"}\n\n`;
  const bytes = new TextEncoder().encode(sse);
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ run_id: 'run_div' }) };
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); }
      }),
      text: async () => ''
    };
  };

  const deltas = [];
  const result = await runsApiStream({ baseUrl: 'http://test', apiKey: 'k', input: 'hi', onDelta: (d) => deltas.push(d) });
  const emitted = deltas.join('');
  assert.ok(emitted.includes(finalOutput), `the WHOLE final output must be emitted, got: ${JSON.stringify(emitted)}`);
  assert.ok(result.full.includes(finalOutput));
});
