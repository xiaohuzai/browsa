// test/lib-llm-cap-fallback.test.mjs — 输出预算自动协商：从 400 报错解析真实
// 上限（OpenAI / Anthropic 两种报错形态）、解析不出但提到 max_tokens 时退回
// 16384 旧默认档、与预算无关的报错原样抛出；chatStream / anthropicStream 端到端
// 重试验证（第二次请求的 max_tokens 必须等于解析出的上限）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOutputCapFromError,
  outputCapRetryBudget,
  chatStream,
  anthropicStream,
  DEFAULT_MAX_TOKENS,
} from '../lib/llm-client.js';

test('DEFAULT_MAX_TOKENS 起步 32768（方舟类夹取服务器无感受益，OpenAI/Anthropic 由重试兜底）', () => {
  assert.equal(DEFAULT_MAX_TOKENS, 32768);
});

test('parseOutputCapFromError: OpenAI 与 Anthropic 两种报错形态都解析得出', () => {
  assert.equal(
    parseOutputCapFromError('HTTP 400: {"error":{"message":"max_tokens is too large: 32768. This model supports at most 16384 max_tokens"}}'),
    16384,
  );
  assert.equal(
    parseOutputCapFromError('max_tokens: 100000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022'),
    8192,
  );
  assert.equal(parseOutputCapFromError('some unrelated 500 error'), 0);
  assert.equal(parseOutputCapFromError(''), 0);
});

test('outputCapRetryBudget: 解析出更小上限→用它；解析不出但提到 max_tokens→退 16384；无关报错→0', () => {
  assert.equal(outputCapRetryBudget('This model supports at most 16384 max_tokens', 32768), 16384);
  assert.equal(outputCapRetryBudget('max_tokens: 100000 > 8192, which is the maximum allowed', 32768), 8192);
  assert.equal(outputCapRetryBudget('max_tokens must be at least 1', 32768), 16384, '提到 max_tokens 但解析不出上限 → 退旧默认档');
  assert.equal(outputCapRetryBudget('This model supports at most 16384 max_tokens', 8192), 0, '请求本就低于上限 → 不重试');
  assert.equal(outputCapRetryBudget('invalid api key', 32768), 0, '与预算无关的报错');
  assert.equal(outputCapRetryBudget('max_tokens too large', 0), 0, '请求里根本没发预算 → 不重试');
});

function sseStream(text) {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  );
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

test('chatStream: 32768 被 400（带真实上限）后自动用 16384 重发并正常出流', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.max_tokens === 32768) {
      return { ok: false, status: 400, text: async () => 'max_tokens is too large: 32768. This model supports at most 16384 max_tokens' };
    }
    return { ok: true, status: 200, body: sseStream('ok'), text: async () => '' };
  };
  const res = await chatStream({
    baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }],
    onDelta: () => {}, maxTokens: 32768,
  });
  assert.equal(bodies.length, 2, '恰好一次重试');
  assert.equal(bodies[0].max_tokens, 32768);
  assert.equal(bodies[1].max_tokens, 16384, '第二次请求使用解析出的真实上限');
  assert.equal(res.full, 'ok');
  assert.equal(res.finishReason, 'stop');
});

test('chatStream: 与预算无关的 400 原样抛出（不重试）', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 401, text: async () => 'invalid api key' };
  };
  await assert.rejects(
    chatStream({ baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], onDelta: () => {}, maxTokens: 32768 }),
    /401/,
  );
  assert.equal(calls, 1, '只发一次');
});

test('anthropicStream: 超上限报错解析出 8192 并自动重发（Anthropic 必发 max_tokens）', async () => {
  const bodies = [];
  const bytes = new TextEncoder().encode(
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hey' } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
  );
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.max_tokens === 32768) {
      return { ok: false, status: 400, text: async () => 'max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022' };
    }
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), text: async () => '' };
  };
  const res = await anthropicStream({
    baseUrl: 'http://test', apiKey: 'k', system: '', messages: [{ role: 'user', content: 'hi' }],
    onDelta: () => {},
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].max_tokens, 8192);
  assert.equal(res.full, 'hey');
});
