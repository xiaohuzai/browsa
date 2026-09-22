// test/chat-stateless-dispatch.test.mjs
// Regression coverage for the CHAT handler's stateless LLM dispatch leg.
//
// The 2026-09-20 turn-request refactor (#148) moved the per-kind request
// shapes into `turn` but left a bare `anthropicSystem,` shorthand at the
// dispatchStyleStream call site — an undeclared identifier that threw
// `ReferenceError: anthropicSystem is not defined` on EVERY stateless
// (chat/responses/anthropic) turn, i.e. the main path for regular LLM
// providers. No existing test drove handleChat end-to-end through a
// stateless provider (chat-handler-internals.test.mjs deliberately tests
// only the exported helpers), so the crash shipped silently. This file
// runs the real handleChat with a chat-style provider and a stubbed SSE
// fetch — the ReferenceError class of bug can never slip through again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- in-memory chrome.storage areas (same pattern as test/storage.test.mjs)
function makeStorageArea() {
  let store = {};
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { store = { ...store, ...obj }; },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
    _reset() { store = {}; },
  };
}

const localArea = makeStorageArea();
const sessionArea = makeStorageArea();

Object.defineProperty(globalThis, 'chrome', {
  value: {
    storage: { local: localArea, session: sessionArea, onChanged: { addListener: () => {} } },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} },
  },
  writable: true,
  configurable: true,
});

const { handleChat } = await import('../lib/handlers/chat-handler.js');

function sseResponse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, headers: { get: () => 'text/event-stream' } };
}

async function seedChatProvider() {
  localArea._reset();
  sessionArea._reset();
  await localArea.set({
    providers: {
      myllm: { type: 'llm', alias: 'MyLLM', baseUrl: 'https://api.test/v1', apiKey: 'k-test', apiStyle: 'chat' },
    },
    activeProvider: 'myllm',
  });
}

test('handleChat completes a chat-style (stateless) turn end-to-end', async () => {
  await seedChatProvider();
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  try {
    const result = await handleChat(
      { tabId: 42, userText: 'hi there' },
      'capability-hint-text', // capabilityHints
      ''                      // choiceRequestHint
    );
    assert.equal(result.full, 'Hello world', 'the streamed reply must come back');
    assert.equal(calls.length, 1, 'exactly one completions request');
    assert.match(calls[0].url, /api\.test.*chat\/completions$/);
    // The request must carry the user turn + system prompt (proves the whole
    // turn.prepare() → buildMessages path ran, not just the fetch).
    const roles = calls[0].body.messages.map((m) => m.role);
    assert.ok(roles.includes('user'), 'user turn must be in the request');
    assert.ok(roles.includes('system'), 'system prompt must be in the request');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handleChat uses turn.anthropicSystem for anthropic-style providers (no bare identifier)', async () => {
  // Same seam, anthropic style: the dispatch used to reference a bare
  // `anthropicSystem` identifier here (ReferenceError). Driving the real
  // handler through an anthropic-style provider pins the fix.
  localArea._reset();
  sessionArea._reset();
  await localArea.set({
    providers: {
      antic: { type: 'llm', alias: 'Anti', baseUrl: 'https://anti.test', apiKey: 'k', apiStyle: 'anthropic' },
    },
    activeProvider: 'antic',
  });
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    return sseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  try {
    const result = await handleChat({ tabId: 43, userText: 'ping' }, 'sys-hint', '');
    assert.equal(result.full, 'ok');
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
