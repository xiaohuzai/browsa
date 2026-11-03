// test/llm-client-fetch-abort.test.mjs
// 2026-10-24 protocol audit regression: string-reason aborts during the
// FETCH phase must classify as AbortError on EVERY SSE style, not just
// chatStream.
//
// All abort call sites abort with a STRING reason ('user-cancel' /
// 'idle-timeout' / 'drop'), which makes fetch reject with that raw string —
// no .name, no .message. The old guard (`e?.name === 'AbortError'` only,
// with chatStream alone carrying the extra signal check) let the other
// legs wrap the rejection as ProviderNetworkError('… : user-cancel'):
// chat-handler's transient-retry ladder then RE-SENT the cancelled turn
// (up to 2 more times), the clean-cancel branch never fired (no
// interrupted-salvage, no stopHermesRun — the server-side run kept
// burning), and subchat rendered the user's own Esc as an error card.
//
// Also pins: a chat-dialect data event carrying {"error": …} must throw
// ProviderAPIError (Azure content-filter / LiteLLM gateways terminate
// HTTP-200 streams that way; the parser used to return {} and the loop
// ended like a clean finish, persisting the partial reply as complete).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseResponseLike } from './helpers/sse-fixtures.mjs';

const realFetch = globalThis.fetch;

/** A fetch that hangs until the caller's signal aborts, then rejects with the
 * signal's raw reason — byte-for-byte what Chrome does on abort('user-cancel'). */
function hangingFetch() {
  return async (url, opts) => new Promise((resolve, reject) => {
    const sig = opts?.signal;
    if (!sig) throw new Error('fetch must be called with a signal');
    if (sig.aborted) { reject(sig.reason); return; }
    sig.addEventListener('abort', () => reject(sig.reason), { once: true });
  });
}

const sseResponse = (frames) => sseResponseLike(frames, { text: async () => '' });

async function expectAbortError(promise, label) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: must reject`);
  assert.equal(err?.name, 'AbortError',
    `${label}: string-reason abort must classify as AbortError, got ${err?.constructor?.name}: ${err?.message}`);
}

// 2026-11-03 proto-3：abort 归一的单点 owner。此前同形三行拷贝散在
// renegotiateOutputCap / openSseStream / runsApiStream POST / opencode apiFetch /
// squillaStream catch 五处，每个新 fetch 点都要靠调用者自觉重抄。helper 契约
// 刻意窄：只做 abort 判定与归一，非 abort 错误落空返回——包装留在各调用点
// （networkErrLabel 措辞字节稳定，error-classifier 按串匹配；opencode 的非
// abort 分支是裸 rethrow，统一包装会改错误面）。
test('classifyFetchAbort: single-owner normalization, narrow contract', async () => {
  const { classifyFetchAbort } = await import('../lib/llm-client.js');
  assert.equal(typeof classifyFetchAbort, 'function');

  // leg 1: signal.aborted 权威——裸字符串 reason（无 .name/.message）归一为 AbortError。
  const ac = new AbortController();
  ac.abort('user-cancel');
  assert.throws(() => classifyFetchAbort('user-cancel', ac.signal), (e) => e?.name === 'AbortError');
  // signal 已 aborted 时即使 e 长得像真实错误也判取消（signal 是权威判据）。
  assert.throws(() => classifyFetchAbort(new Error('socket hang up'), ac.signal), (e) => e?.name === 'AbortError');

  // leg 2: 本回合 signal 未 aborted，但 e 是 AbortError（嵌套 timeout controller）→ 原样 rethrow。
  const nested = new DOMException('The operation timed out', 'AbortError');
  assert.throws(() => classifyFetchAbort(nested, new AbortController().signal), (e) => e === nested);
  assert.throws(() => classifyFetchAbort(nested, null), (e) => e === nested);

  // leg 3: 非 abort → 落空返回，包装/重抛留在调用点。
  assert.equal(classifyFetchAbort(new Error('net down'), new AbortController().signal), undefined);
  assert.equal(classifyFetchAbort('weird rejection', undefined), undefined);
  assert.equal(classifyFetchAbort(undefined, null), undefined);
});

test('fetch-phase string-reason aborts are AbortError on chat/responses/anthropic styles', async () => {
  const { chatStream, responsesStream, anthropicStream } = await import('../lib/llm-client.js');

  const cases = [
    ['chatStream', (signal) => chatStream({
      baseUrl: 'http://t', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], signal,
    })],
    ['responsesStream', (signal) => responsesStream({
      baseUrl: 'http://t', apiKey: 'k', model: 'm',
      input: [{ role: 'user', content: 'hi' }], signal,
    })],
    ['anthropicStream', (signal) => anthropicStream({
      baseUrl: 'http://t', apiKey: 'k', model: 'm', system: '',
      messages: [{ role: 'user', content: 'hi' }], signal,
    })],
  ];

  for (const [name, call] of cases) {
    const ac = new AbortController();
    globalThis.fetch = hangingFetch();
    try {
      const p = call(ac.signal);
      await new Promise((r) => setTimeout(r, 5));
      ac.abort('user-cancel');
      await expectAbortError(p, name);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test('runsApiStream: string-reason abort on the events GET is AbortError', async () => {
  const { runsApiStream } = await import('../lib/llm-client.js');
  const ac = new AbortController();
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    if (String(url).endsWith('/v1/runs')) {
      // Step 1 succeeds; the events GET (step 2) hangs until abort.
      return {
        ok: true, status: 200,
        json: async () => ({ run_id: 'run-1' }),
      };
    }
    return await new Promise((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  };
  try {
    const p = runsApiStream({
      baseUrl: 'http://t', apiKey: 'k', sessionId: 's1',
      input: [{ role: 'user', content: 'hi' }], signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 2, 'POST /v1/runs then GET /events must both have fired');
    ac.abort('user-cancel');
    await expectAbortError(p, 'runsApiStream events GET');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('renegotiation fetch aborted mid-flight is AbortError (not a retried network error)', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  const ac = new AbortController();
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    if (calls === 1) {
      // 400 whose text names max_tokens with a smaller cap → triggers the
      // one-shot renegotiation retry.
      return {
        ok: false, status: 400,
        text: async () => 'this model supports at most 8192 max_tokens',
      };
    }
    // Renegotiation fetch: hang until abort, then reject with the raw reason.
    return await new Promise((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  };
  try {
    const p = chatStream({
      baseUrl: 'http://t', apiKey: 'k', model: 'm', maxTokens: 40000,
      messages: [{ role: 'user', content: 'hi' }], signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 2, 'the renegotiation retry must have fired');
    ac.abort('user-cancel');
    await expectAbortError(p, 'renegotiateOutputCap');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('chatStream: an in-stream {"error": …} data event throws ProviderAPIError', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"partial "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"text"}}]}\n\n',
    'data: {"error":{"message":"content filter triggered","code":"content_filter"}}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    let err = null;
    try {
      await chatStream({
        baseUrl: 'http://t', apiKey: 'k', model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      });
    } catch (e) { err = e; }
    assert.ok(err, 'the error event must reject the stream');
    assert.match(String(err?.message || err), /content filter/,
      'the server-side message must surface (was silently swallowed as a clean finish)');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('parseChatEvent keeps ignoring malformed payloads (no behavior change)', async () => {
  const { chatStream } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: not json at all\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const r = await chatStream({
      baseUrl: 'http://t', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.full, 'ok', 'malformed events are skipped, the stream still completes');
  } finally {
    globalThis.fetch = realFetch;
  }
});
