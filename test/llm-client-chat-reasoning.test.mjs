// test/llm-client-chat-reasoning.test.mjs
// Tests for reasoning-model thinking in lib/llm-client.js's stateless streams:
// chatStream now parses the DeepSeek-style `reasoning_content` delta field
// (plus the `reasoning` alias some gateways use), and all three stateless
// stream functions take a `thinking` option — 'inline' wraps the reasoning
// run in ONE <thinking> block (same shape runs/responses already inject),
// 'omit' (the default) drops it entirely so non-chat consumers (summarizer,
// mermaid-repair, selection-explain, agentic-extract) keep receiving clean
// text exactly as before this existed.
//
// SSE harness mirrors llm-client-responses.test.mjs (fake ReadableStream).

import { test } from 'node:test';
import assert from 'node:assert/strict';

function buildSseStream(blocks) {
  const encoder = new TextEncoder();
  let text = '';
  for (const b of blocks) {
    // Chat blocks are the raw wire object; responses blocks are {event, data}
    // wrappers (their SSE event name rides in `event`, per llm-client-responses).
    if (b.event) text += `event: ${b.event}\n`;
    text += `data: ${JSON.stringify(b.data ?? b)}\n\n`;
  }
  text += 'data: [DONE]\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

function mockFetchWithStream(blocks, capture) {
  globalThis.fetch = async (url, opts) => {
    capture.url = String(url);
    if (opts?.body) capture.body = JSON.parse(opts.body);
    return { ok: true, status: 200, body: buildSseStream(blocks), text: async () => '' };
  };
}

const REASONING_STREAM = [
  { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: 'pondering ' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: 'the math' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'The answer is 4.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 9 } },
];

test('chatStream thinking:inline wraps a reasoning_content run in ONE <thinking> block before the content', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream(REASONING_STREAM, cap);

  const seen = [];
  const result = await chatStream({
    baseUrl: 'http://test', apiKey: 'sk-x', model: 'deepseek-r1',
    messages: [{ role: 'user', content: '2+2' }],
    onDelta: (d) => seen.push(d),
    thinking: 'inline',
  });

  assert.equal(seen[0], '<thinking>\n');
  assert.equal(seen[1] + seen[2], 'pondering the math');
  assert.equal(seen[3], '\n</thinking>\n');
  assert.equal(seen[4], 'The answer is 4.');
  assert.equal(result.full, '<thinking>\npondering the math\n</thinking>\nThe answer is 4.');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { total_tokens: 9 });
});

test('chatStream thinking:inline also accepts the `reasoning` field alias', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { choices: [{ index: 0, delta: { reasoning: 'hmm' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] },
  ], cap);

  let full = '';
  const result = await chatStream({
    baseUrl: 'http://test', apiKey: 'sk-x',
    messages: [{ role: 'user', content: 'x' }],
    onDelta: (d) => { full += d; },
    thinking: 'inline',
  });
  assert.equal(full, '<thinking>\nhmm\n</thinking>\nhi');
  assert.equal(result.full, full);
});

test('chatStream default (omit) drops reasoning entirely — byte-identical to the pre-reasoning behavior', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream(REASONING_STREAM, cap);

  let full = '';
  const result = await chatStream({
    baseUrl: 'http://test', apiKey: 'sk-x',
    messages: [{ role: 'user', content: '2+2' }],
    onDelta: (d) => { full += d; },
  });
  assert.equal(full, 'The answer is 4.');
  assert.equal(result.full, 'The answer is 4.');
});

test('chatStream thinking:inline closes an unclosed reasoning run at stream end', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  const cap = {};
  mockFetchWithStream([
    { choices: [{ index: 0, delta: { reasoning_content: 'never finishes' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ], cap);

  let full = '';
  await chatStream({
    baseUrl: 'http://test', apiKey: 'sk-x',
    messages: [{ role: 'user', content: 'x' }],
    onDelta: (d) => { full += d; },
    thinking: 'inline',
  });
  assert.equal(full, '<thinking>\nnever finishes\n</thinking>\n',
    'the defensive close must land so the final render never sees an unclosed tag');
});

test('responsesStream default (omit) drops reasoning summary events; inline surfaces them', async () => {
  const { responsesStream } = await import('../lib/llm-client.js');
  const blocks = [
    { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: 'thinking...' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Answer' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { total_tokens: 3 } } } },
  ];

  // omit (default): reasoning summary must not reach the stream.
  let cap = {};
  mockFetchWithStream(blocks, cap);
  let full = '';
  await responsesStream({
    baseUrl: 'http://test', apiKey: 'sk-x',
    input: [{ role: 'user', content: 'q' }],
    onDelta: (d) => { full += d; },
  });
  assert.equal(full, 'Answer', 'default must omit the reasoning summary');

  // inline: wrapped like every other adapter.
  cap = {};
  mockFetchWithStream(blocks, cap);
  full = '';
  await responsesStream({
    baseUrl: 'http://test', apiKey: 'sk-x',
    input: [{ role: 'user', content: 'q' }],
    onDelta: (d) => { full += d; },
    thinking: 'inline',
  });
  assert.equal(full, '<thinking>\nthinking...\n</thinking>\nAnswer');
});
