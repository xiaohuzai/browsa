// test/llm-client-responses.test.mjs
// Unit tests for responsesStream() (/v1/responses) in lib/llm-client.js — the
// OpenAI Responses API path selectable via provider.apiStyle === 'responses'.
// Mirrors the SSE-shape tests in chat-stream-approval.test.mjs: fake
// ReadableStream bodies, assert the request body + endpoint + parsed output.
//
// The /v1/responses SSE event names (response.output_text.delta /
// response.completed) are distinct from /v1/chat/completions's
// choices[0].delta.content — this file is the regression guard that the
// Responses path parses ITS OWN event shape, not a copy-paste of chatStream.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function buildSseStream(blocks) {
  const encoder = new TextEncoder();
  let text = '';
  for (const b of blocks) {
    if (b.event) text += `event: ${b.event}\n`;
    text += `data: ${JSON.stringify(b.data)}\n\n`;
  }
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

// Captures the request body so we can assert the /v1/responses payload shape.
function mockFetchWithStream(blocks, capture) {
  globalThis.fetch = async (url, opts) => {
    capture.url = String(url);
    capture.body = JSON.parse(opts.body);
    return { ok: true, status: 200, body: buildSseStream(blocks), text: async () => '' };
  };
}

test('responsesStream: POSTs to /v1/responses with input/instructions and streams output_text.delta', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hello' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: ', world' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { total_tokens: 12 }, incomplete_details: null } } },
  ], cap);

  let full = '';
  const result = await responsesStream({
    baseUrl: 'http://test',
    apiKey: 'sk-x',
    model: 'gpt-5',
    input: [{ role: 'user', content: 'hi' }],
    instructions: 'Be concise.',
    onDelta: (d) => { full += d; },
    temperature: 0.5,
    maxTokens: 1000,
  });

  assert.equal(cap.url, 'http://test/v1/responses');
  assert.equal(cap.body.model, 'gpt-5');
  assert.equal(cap.body.instructions, 'Be concise.');
  assert.equal(cap.body.stream, true);
  assert.equal(cap.body.temperature, 0.5);
  assert.equal(cap.body.max_output_tokens, 1000, 'responses uses max_output_tokens, not max_tokens');
  assert.deepEqual(cap.body.input, [{ role: 'user', content: 'hi' }]);
  assert.equal(full, 'Hello, world');
  assert.equal(result.full, 'Hello, world');
  assert.deepEqual(result.usage, { total_tokens: 12 });
  assert.equal(result.finishReason, 'completed');
});

test('responsesStream: incomplete_details.reason === max_output_tokens maps to finishReason length', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'partial' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } } },
  ], cap);

  const result = await responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi', onDelta: () => {} });
  assert.equal(result.finishReason, 'length', 'truncation must be surfaced as length (callers show 继续 hint)');
  assert.equal(result.full, 'partial');
});

test('responsesStream: response.failed throws ProviderAPIError', async () => {
  const { responsesStream, ProviderAPIError } = await import('../lib/llm-client.js');
  mockFetchWithStream([
    { event: 'response.failed', data: { type: 'response.failed', error: { message: 'model exploded' } } },
  ], {});
  await assert.rejects(
    () => responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi', onDelta: () => {} }),
    (e) => e.name === 'ProviderAPIError' && /model exploded/.test(e.message)
  );
});

test('responsesStream: non-ok HTTP response throws ProviderAPIError with status text', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  await assert.rejects(
    () => responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi' }),
    (e) => e.name === 'ProviderAPIError' && /HTTP 400/.test(e.message)
  );
});

test('responsesStream: aborted signal throws AbortError', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');
  const ctrl = new AbortController();
  const enc = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    // Stream stays OPEN after the first delta: the abort cancels the pending
    // reader.read(), which the loop must surface as AbortError.
    body: new ReadableStream({
      start(c) { c.enqueue(enc.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"abc"}\n\n')); }
    }),
    text: async () => '',
  });
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(
    () => responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi', signal: ctrl.signal, onDelta: () => {} }),
    (e) => e.name === 'AbortError'
  );
});

test('responsesStream: no model sent when model is empty', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } },
  ], cap);
  await responsesStream({ baseUrl: 'http://test', apiKey: '', input: 'hi' });
  assert.equal(cap.body.model, undefined, 'omit model when none configured');
});
