// test/llm-client-anthropic.test.mjs
// Unit tests for anthropicStream() (/v1/messages) in lib/llm-client.js — the
// Anthropic Messages API path selectable via provider.apiStyle === 'anthropic'.
// Asserts the endpoint, the REQUIRED max_tokens field (Anthropic 400s without
// it — a real design point this file guards), the system top-level field, and
// the content_block_delta / message_delta / message_stop SSE parsing.

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

function mockFetchWithStream(blocks, capture) {
  globalThis.fetch = async (url, opts) => {
    capture.url = String(url);
    capture.body = JSON.parse(opts.body);
    return { ok: true, status: 200, body: buildSseStream(blocks), text: async () => '' };
  };
}

test('anthropicStream: POSTs to /v1/messages with system + max_tokens and streams text_delta', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ], cap);

  let full = '';
  const result = await anthropicStream({
    baseUrl: 'http://test',
    apiKey: 'sk-ant-x',
    model: 'claude-3-5-sonnet',
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => { full += d; },
    temperature: 0.3,
    maxTokens: 0, // unset → DEFAULT_MAX_TOKENS must be sent (Anthropic requires it)
  });

  assert.equal(cap.url, 'http://test/v1/messages');
  assert.equal(cap.body.model, 'claude-3-5-sonnet');
  assert.deepEqual(cap.body.system, [{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }],
    'system is sent as a block carrying a cache_control breakpoint (Anthropic caches nothing without one)');
  assert.equal(cap.body.stream, true);
  assert.equal(cap.body.temperature, 0.3);
  assert.ok(cap.body.max_tokens > 0, 'max_tokens must ALWAYS be sent — Anthropic 400s without it');
  assert.deepEqual(cap.body.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
  }], 'the last message carries the moving cache_control breakpoint');
  assert.equal(full, 'Hello, world');
  assert.equal(result.full, 'Hello, world');
  assert.equal(result.finishReason, 'stop');
});

test('anthropicStream: cache_control breakpoints — system + last message (string and array content)', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'message_stop', data: { type: 'message_stop' } },
  ], cap);
  await anthropicStream({
    baseUrl: 'http://test', apiKey: 'k',
    system: 'sys prompt',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'page context...' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'question?' },
    ],
  });
  // Last message: string content converted to a single text block with the breakpoint.
  const last = cap.body.messages[2];
  assert.deepEqual(last.content, [{ type: 'text', text: 'question?', cache_control: { type: 'ephemeral' } }]);
  // Earlier messages must NOT be mutated (breakpoint only on the last).
  assert.deepEqual(cap.body.messages[0].content[0], { type: 'text', text: 'page context...' });
  assert.equal(cap.body.messages[1].content, 'ok');
  // System block breakpoint.
  assert.equal(cap.body.system[0].cache_control.type, 'ephemeral');
});

test('anthropicStream: array content on the last message gets the breakpoint on its LAST block; empty content skipped', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([{ event: 'message_stop', data: { type: 'message_stop' } }], cap);
  await anthropicStream({
    baseUrl: 'http://test', apiKey: 'k',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }],
  });
  const blocks = cap.body.messages[0].content;
  assert.equal(blocks[0].cache_control, undefined, 'earlier blocks untouched');
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' }, 'breakpoint rides the last block (image blocks accept it too)');

  const cap2 = {};
  mockFetchWithStream([{ event: 'message_stop', data: { type: 'message_stop' } }], cap2);
  await anthropicStream({ baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: '   ' }] });
  assert.deepEqual(cap2.body.messages, [{ role: 'user', content: '   ' }],
    'whitespace-only string content left untouched (empty text blocks would 400)');
});

test('anthropicStream: explicit provider maxTokens overrides the default and is sent as-is', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ], cap);
  await anthropicStream({ baseUrl: 'http://test', apiKey: '', messages: [], maxTokens: 5000 });
  assert.equal(cap.body.max_tokens, 5000, 'explicit maxTokens must be sent verbatim');
});

test('anthropicStream: stop_reason === max_tokens maps to finishReason length', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ], cap);
  const result = await anthropicStream({ baseUrl: 'http://test', apiKey: '', messages: [] });
  assert.equal(result.finishReason, 'length', 'max_tokens stop reason must surface truncation');
});

test('anthropicStream: message_stop ends the stream before any later events', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'only' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
    // A malformed/trailing event AFTER message_stop must NOT be read.
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'LEAKED' } } },
  ], cap);
  const result = await anthropicStream({ baseUrl: 'http://test', apiKey: '', messages: [] });
  assert.equal(result.full, 'only', 'message_stop must terminate the read loop');
});

test('anthropicStream: error event throws ProviderAPIError', async () => {
  const { anthropicStream, ProviderAPIError } = await import('../lib/llm-client.js');
  mockFetchWithStream([
    { event: 'error', data: { type: 'error', error: { message: 'invalid request' } } },
  ], {});
  await assert.rejects(
    () => anthropicStream({ baseUrl: 'http://test', apiKey: '', messages: [] }),
    (e) => e.name === 'ProviderAPIError' && /invalid request/.test(e.message)
  );
});

test('anthropicStream: non-ok HTTP response throws ProviderAPIError with status text', async () => {
  const { anthropicStream } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(
    () => anthropicStream({ baseUrl: 'http://test', apiKey: '', messages: [] }),
    (e) => e.name === 'ProviderAPIError' && /HTTP 429/.test(e.message)
  );
});
