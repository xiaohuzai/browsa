// test/runs-api.test.mjs
// Unit tests for runsApiStream() (lib/llm-client.js) — the Hermes /v1/runs
// client added to replace /v1/responses. Covers the event types that
// responses-stream.test.mjs does NOT: approval, clarification, run_id
// propagation, failure/cancellation, and tool progress formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Builds a fake SSE ReadableStream body from a list of {event, data} pairs.
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

// runsApiStream makes two fetches: POST /v1/runs (JSON with run_id), then
// GET /v1/runs/{id}/events (the SSE stream). runIdOverride lets a test
// simulate a malformed/missing run_id response.
function mockFetchWithEvents(events, { runIdOverride } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return {
        ok: true, status: 200,
        json: async () => (runIdOverride !== undefined ? runIdOverride : { run_id: 'run_1' }),
      };
    }
    return { ok: true, status: 200, body: buildSseStream(events), text: async () => '' };
  };
  return calls;
}

test('runsApiStream: onRunId fires with the run_id before the events fetch', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([{ event: 'run.completed', data: { output: 'ok' } }]);

  let seenRunId = null;
  const result = await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onRunId: (id) => { seenRunId = id; },
  });

  assert.equal(seenRunId, 'run_1');
  assert.equal(result.runId, 'run_1');
});

test('runsApiStream: sessionId is sent as X-Hermes-Session-Id/-Key headers and session_id body field on both requests', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  const calls = mockFetchWithEvents([{ event: 'run.completed', data: { output: 'ok' } }]);

  await runsApiStream({
    baseUrl: 'http://test', apiKey: 'sk-1', input: 'hi', sessionId: 'sess-42',
  });

  assert.equal(calls.length, 2, 'expected one POST /v1/runs and one GET /v1/runs/{id}/events');

  const [runCall, eventsCall] = calls;
  assert.equal(runCall.opts.headers['X-Hermes-Session-Id'], 'sess-42');
  assert.equal(runCall.opts.headers['X-Hermes-Session-Key'], 'browsa:sess-42');
  const runBody = JSON.parse(runCall.opts.body);
  assert.equal(runBody.session_id, 'sess-42');

  assert.equal(eventsCall.opts.headers['X-Hermes-Session-Id'], 'sess-42', 'events fetch must reuse the same session headers');
  assert.equal(eventsCall.opts.headers['X-Hermes-Session-Key'], 'browsa:sess-42');
});

test('runsApiStream: omits session headers/body field entirely when no sessionId is given', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  const calls = mockFetchWithEvents([{ event: 'run.completed', data: { output: 'ok' } }]);

  await runsApiStream({ baseUrl: 'http://test', apiKey: 'sk-1', input: 'hi' });

  const [runCall] = calls;
  assert.equal('X-Hermes-Session-Id' in runCall.opts.headers, false);
  assert.equal('X-Hermes-Session-Key' in runCall.opts.headers, false);
  const runBody = JSON.parse(runCall.opts.body);
  assert.equal('session_id' in runBody, false);
});

test('runsApiStream: throws ProviderAPIError when POST /v1/runs returns no run_id', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([], { runIdOverride: {} }); // no run_id, no id

  await assert.rejects(
    () => runsApiStream({ baseUrl: 'http://test', apiKey: 'k', input: 'hi' }),
    /no run_id/,
  );
});

test('runsApiStream: approval.request invokes onApproval with the run_id attached', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([
    { event: 'approval.request', data: { tool: 'terminal', command: 'rm -rf /tmp/x', approval_id: 'appr_1', risk_level: 'high' } },
    { event: 'run.completed', data: { output: '' } },
  ]);

  let seen = null;
  await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onApproval: (data) => { seen = data; },
  });

  assert.ok(seen, 'onApproval must be called');
  assert.equal(seen.tool, 'terminal');
  assert.equal(seen.approval_id, 'appr_1');
  assert.equal(seen.runId, 'run_1', 'the run_id must be attached so the caller can respond later');
});

test('runsApiStream: clarification.request (and clarify.request alias) invokes onClarify', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');

  for (const eventName of ['clarification.request', 'clarify.request']) {
    mockFetchWithEvents([
      { event: eventName, data: { question: 'Which file?', clarify_id: 'clar_1' } },
      { event: 'run.completed', data: { output: '' } },
    ]);

    let seen = null;
    await runsApiStream({
      baseUrl: 'http://test', apiKey: 'k', input: 'hi',
      onClarify: (data) => { seen = data; },
    });

    assert.ok(seen, `onClarify must be called for event "${eventName}"`);
    assert.equal(seen.question, 'Which file?');
    assert.equal(seen.runId, 'run_1');
  }
});

test('runsApiStream: run.failed rejects with the server-provided error message', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([
    { event: 'run.failed', data: { error: 'tool execution crashed' } },
  ]);

  await assert.rejects(
    () => runsApiStream({ baseUrl: 'http://test', apiKey: 'k', input: 'hi' }),
    /tool execution crashed/,
  );
});

test('runsApiStream: run.cancelled rejects with an AbortError', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([
    { event: 'run.cancelled', data: {} },
  ]);

  await assert.rejects(
    () => runsApiStream({ baseUrl: 'http://test', apiKey: 'k', input: 'hi' }),
    (e) => e.name === 'AbortError',
  );
});

test('runsApiStream: tool.started formats name + first string arg as a preview', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([
    { event: 'tool.started', data: { name: 'terminal', args: { command: 'ls -la /very/long/path/that/should/get/truncated/eventually/because/it/is/way/too/long/for/one/line' } } },
    { event: 'run.completed', data: { output: '' } },
  ]);

  const progress = [];
  await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onToolProgress: (text) => progress.push(text),
  });

  assert.equal(progress.length, 1);
  assert.match(progress[0], /^terminal: ls -la/);
  assert.ok(progress[0].length <= 'terminal: '.length + 81 + 1, 'preview must be truncated to ~80 chars plus ellipsis');
});

test('runsApiStream: tool.completed appends a checkmark or cross depending on is_error', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  mockFetchWithEvents([
    { event: 'tool.completed', data: { name: 'search', is_error: false } },
    { event: 'tool.completed', data: { name: 'terminal', is_error: true } },
    { event: 'run.completed', data: { output: '' } },
  ]);

  const progress = [];
  await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onToolProgress: (text) => progress.push(text),
  });

  assert.equal(progress[0], 'search ✓');
  assert.equal(progress[1], 'terminal ✗');
});

// --------------- reasoning.available echo-of-final-answer (regression) ------
// Real-world reproduction (2026-07-04 user report): Hermes sent the ENTIRE
// final assistant message twice — once via many message.delta chunks, then
// AGAIN via a single reasoning.available event carrying the identical text,
// followed by run.completed with the same output. Wrapping every
// reasoning.available event in a <thinking> block (the old behavior)
// duplicated the whole reply and pushed any trailing CHOICE_REQUEST marker
// out of the string's true end, breaking button rendering too.

test('runsApiStream: reasoning.available that echoes the already-streamed message is NOT re-emitted (regression)', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  const longMessage = '我来帮你整理一份详细的文字版。这是一篇 87 分钟的深度对谈，信息密度很高，涉及了很多话题和细节，需要完整梳理出来给你看看究竟发生了什么。';

  mockFetchWithEvents([
    { event: 'message.delta', data: { delta: longMessage } },
    // Hermes mislabels the final consolidated text as "reasoning" here —
    // identical to what was just streamed via message.delta.
    { event: 'reasoning.available', data: { text: longMessage } },
    { event: 'run.completed', data: { output: longMessage } },
  ]);

  const deltas = [];
  const result = await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(deltas.length, 1, 'only the original message.delta should have been emitted, no <thinking> echo');
  assert.equal(result.full, longMessage, 'the reply must not contain a duplicated copy of the message');
  assert.ok(!result.full.includes('<thinking>'), 'no stray <thinking> block should appear for an echoed message');
});

test('runsApiStream: reasoning.available with genuinely distinct short reasoning is still emitted', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');

  mockFetchWithEvents([
    { event: 'reasoning.available', data: { text: 'Let me check the tool results before answering.' } },
    { event: 'message.delta', data: { delta: 'Here is the answer.' } },
    { event: 'run.completed', data: { output: 'Here is the answer.' } },
  ]);

  const deltas = [];
  await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onDelta: (d) => deltas.push(d),
  });

  const thinkingBlock = deltas.find(d => d.includes('<thinking>'));
  assert.ok(thinkingBlock, 'genuine, distinct reasoning content must still be emitted as a <thinking> block');
  assert.match(thinkingBlock, /Let me check the tool results/);
});

test('runsApiStream: SHORT reasoning.available echoes (per-step narration) are also filtered (regression)', async () => {
  // Real-world reproduction (2026-07-04 follow-up report): the 60-char-only
  // anchor missed short (~30 char) per-step narration bursts that Hermes
  // echoed via reasoning.available throughout a long task — only the final,
  // long consolidated message happened to be long enough to get caught by
  // the original fix. Every short burst must be caught too.
  const { runsApiStream } = await import('../lib/llm-client.js');
  const short1 = '好的，我来出一版详细的。我先把你的飞书知识库结构摸清楚，再写。';
  const short2 = '工具被拦了，我换成正常的shell调用。';

  mockFetchWithEvents([
    { event: 'message.delta', data: { delta: short1 } },
    { event: 'reasoning.available', data: { text: short1 } }, // echo — must be dropped
    { event: 'message.delta', data: { delta: short2 } },
    { event: 'reasoning.available', data: { text: short2 } }, // echo — must be dropped
    { event: 'run.completed', data: { output: short1 + short2 } },
  ]);

  const deltas = [];
  const result = await runsApiStream({
    baseUrl: 'http://test', apiKey: 'k', input: 'hi',
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(deltas.length, 2, 'only the two original message.delta chunks should have been emitted');
  assert.equal(result.full, short1 + short2, 'no duplicated narration should appear in the final text');
  assert.ok(!result.full.includes('<thinking>'), 'no stray <thinking> blocks for the echoed short bursts');
});

