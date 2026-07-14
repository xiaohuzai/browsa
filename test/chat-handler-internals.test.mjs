// test/chat-handler-internals.test.mjs
// Coverage for chat-handler.js support logic that wasn't exercised by any
// existing test file: llms.txt fetch/cache/TTL, the CHOICE_REQUEST
// trailing-JSON parse/strip contract, per-domain system-prompt matching,
// and the SW_PING -> resetIdleTimer wiring in background.js's browsa-chat
// port handler (documented in CLAUDE.md as a real bug class: without it,
// long tool calls with minutes of SSE silence hit the 5-minute idle
// timeout and get falsely cancelled).
//
// handleChat() itself needs a fuller chrome.storage.local mock than any
// other test file in this suite sets up (see subchat.test.mjs's header
// comment for the same tradeoff) -- so fetchLlmsTxt is tested directly
// (exported for this reason) and the CHOICE_REQUEST/domain-rule pieces are
// tested by replicating the exact literal regex/logic from the source,
// same convention as test/page-extractor.test.mjs's zero-width-char test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CHAT_HANDLER_PATH = fileURLToPath(new URL('../lib/handlers/chat-handler.js', import.meta.url));

// --------------- llms.txt fetch/cache/TTL -----------------------------------

test('fetchLlmsTxt fetches and caches /llms.txt for the tab origin', async () => {
  const { fetchLlmsTxt, llmsTxtCache } = await import('../lib/handlers/chat-handler.js');
  llmsTxtCache.clear();
  let fetchCalls = 0;
  globalThis.fetch = async (url) => {
    fetchCalls++;
    assert.equal(url, 'https://example.com/llms.txt');
    return { ok: true, text: async () => 'Be concise.' };
  };
  const text = await fetchLlmsTxt('https://example.com/some/page?x=1');
  assert.equal(text, 'Be concise.');

  // Second call within the TTL window must hit the cache, not fetch again.
  const text2 = await fetchLlmsTxt('https://example.com/other/page');
  assert.equal(text2, 'Be concise.');
  assert.equal(fetchCalls, 1, 'second call within TTL must be served from cache');
});

test('fetchLlmsTxt caches null on a non-ok response (e.g. 404) without retrying within TTL', async () => {
  const { fetchLlmsTxt, llmsTxtCache } = await import('../lib/handlers/chat-handler.js');
  llmsTxtCache.clear();
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return { ok: false, status: 404, text: async () => '' }; };

  const text = await fetchLlmsTxt('https://noindex.example.com/');
  assert.equal(text, null);
  const text2 = await fetchLlmsTxt('https://noindex.example.com/other');
  assert.equal(text2, null);
  assert.equal(fetchCalls, 1, 'a cached 404 must not be retried within the TTL window');
});

test('fetchLlmsTxt caches null and does not throw when fetch rejects (network error/timeout)', async () => {
  const { fetchLlmsTxt, llmsTxtCache } = await import('../lib/handlers/chat-handler.js');
  llmsTxtCache.clear();
  globalThis.fetch = async () => { throw new Error('network down'); };

  const text = await fetchLlmsTxt('https://unreachable.example.com/');
  assert.equal(text, null, 'network errors must resolve to null, not throw');
});

test('fetchLlmsTxt caps content at 8000 characters', async () => {
  const { fetchLlmsTxt, llmsTxtCache } = await import('../lib/handlers/chat-handler.js');
  llmsTxtCache.clear();
  const long = 'x'.repeat(20000);
  globalThis.fetch = async () => ({ ok: true, text: async () => long });

  const text = await fetchLlmsTxt('https://bigfile.example.com/');
  assert.equal(text.length, 8000, 'content must be capped at 8 KB');
});

test('fetchLlmsTxt returns null for an unparsable tab URL without throwing', async () => {
  const { fetchLlmsTxt } = await import('../lib/handlers/chat-handler.js');
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const text = await fetchLlmsTxt('not-a-valid-url');
  assert.equal(text, null);
});

test('fetchLlmsTxt returns null immediately for an empty/falsy tabUrl (no network call)', async () => {
  const { fetchLlmsTxt } = await import('../lib/handlers/chat-handler.js');
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, text: async () => 'x' }; };
  const text = await fetchLlmsTxt('');
  assert.equal(text, null);
  assert.equal(called, false, 'must not call fetch for an empty tabUrl');
});

// --------------- CHOICE_REQUEST trailing-JSON parse/strip -------------------
// Mirrors the exact regex/flow from chat-handler.js's post-stream parse
// step (search CHOICE_REQUEST_HINT in CLAUDE.md / background.js for the
// full contract): the agent may end its reply with a literal
// `CHOICE_REQUEST:{"question":"...","choices":[...]}` block, which must be
// parsed out, stripped from the text stored to history, and forwarded
// separately so the side panel can render clickable buttons.

function parseChoiceRequest(fullReply) {
  let choiceRequest = null;
  const choiceMatch = fullReply.match(/CHOICE_REQUEST:(\{[\s\S]*?\})\s*$/);
  if (choiceMatch) {
    try {
      choiceRequest = JSON.parse(choiceMatch[1]);
      fullReply = fullReply.slice(0, choiceMatch.index).trimEnd();
    } catch (_) { /* malformed JSON -- leave as-is */ }
  }
  return { fullReply, choiceRequest };
}

test('chat-handler.js source defines the CHOICE_REQUEST regex used by this test (stay in lockstep)', async () => {
  const src = await readFile(CHAT_HANDLER_PATH, 'utf8');
  assert.ok(src.includes('CHOICE_REQUEST:(\\{[\\s\\S]*?\\})\\s*$'),
    'production regex literal must match the one this test replicates -- if it changes, update parseChoiceRequest() above too');
});

test('parseChoiceRequest strips a well-formed trailing CHOICE_REQUEST and parses it', () => {
  const raw = 'Here is my answer.\n\nCHOICE_REQUEST:{"question":"Which one?","choices":["A","B"]}';
  const { fullReply, choiceRequest } = parseChoiceRequest(raw);
  assert.equal(fullReply, 'Here is my answer.');
  assert.deepEqual(choiceRequest, { question: 'Which one?', choices: ['A', 'B'] });
});

test('parseChoiceRequest leaves the reply untouched when there is no trailing CHOICE_REQUEST', () => {
  const raw = 'Just a normal reply, no choices needed.';
  const { fullReply, choiceRequest } = parseChoiceRequest(raw);
  assert.equal(fullReply, raw);
  assert.equal(choiceRequest, null);
});

test('parseChoiceRequest leaves the reply untouched when the trailing JSON is malformed', () => {
  const raw = 'My answer.\n\nCHOICE_REQUEST:{not valid json}';
  const { fullReply, choiceRequest } = parseChoiceRequest(raw);
  assert.equal(fullReply, raw, 'malformed JSON must leave the text as-is (not silently truncate the reply)');
  assert.equal(choiceRequest, null);
});

test('parseChoiceRequest only matches CHOICE_REQUEST at the very end of the reply, not mid-text', () => {
  // A CHOICE_REQUEST-looking string embedded mid-reply (e.g. the model
  // discussing the feature itself) must not be treated as a real request --
  // the regex is anchored with \s*$.
  const raw = 'CHOICE_REQUEST:{"a":1} is a feature I added earlier. The actual answer is 42.';
  const { fullReply, choiceRequest } = parseChoiceRequest(raw);
  assert.equal(fullReply, raw);
  assert.equal(choiceRequest, null);
});

// --------------- per-domain system-prompt matching ---------------------------
// Mirrors chat-handler.js's `domainRules.find(r => r.pattern && tabUrl.includes(r.pattern))`.

function matchDomainRule(domainRules, tabUrl) {
  return domainRules.find(r => r.pattern && tabUrl.includes(r.pattern));
}

test('chat-handler.js source defines the domain-rule matching used by this test (stay in lockstep)', async () => {
  const src = await readFile(CHAT_HANDLER_PATH, 'utf8');
  assert.match(src, /domainRules\.find\(r => r\.pattern && tabUrl\.includes\(r\.pattern\)\)/,
    'production domain-rule matching logic must match the one this test replicates -- if it changes, update matchDomainRule() above too');
});

test('matchDomainRule picks the rule whose pattern is a substring of the tab URL', () => {
  const rules = [
    { pattern: 'github.com', prompt: 'Be terse, this is a code review context.' },
    { pattern: 'news.ycombinator.com', prompt: 'Summarize discussion threads.' },
  ];
  const matched = matchDomainRule(rules, 'https://github.com/foo/bar/pull/1');
  assert.equal(matched.prompt, 'Be terse, this is a code review context.');
});

test('matchDomainRule returns undefined when no rule pattern matches', () => {
  const rules = [{ pattern: 'github.com', prompt: 'x' }];
  const matched = matchDomainRule(rules, 'https://example.com/');
  assert.equal(matched, undefined);
});

test('matchDomainRule skips rules with an empty/falsy pattern (avoids matching everything)', () => {
  const rules = [{ pattern: '', prompt: 'would match every URL if not skipped' }];
  const matched = matchDomainRule(rules, 'https://example.com/');
  assert.equal(matched, undefined, 'a rule with an empty pattern must never match (tabUrl.includes(\'\') is always true otherwise)');
});

// --------------- SW_PING -> resetIdleTimer wiring ----------------------------
// Regression coverage for the documented bug class: sidepanel sends
// SW_PING every 20s while a stream is in flight to keep the SW alive AND
// reset the 5-minute idle-abort timer. Without background.js's browsa-chat
// port handler explicitly wiring SW_PING to idleTimerResetters, the ping
// only keeps the SW process alive -- resetIdleTimer never fires, so a long
// tool call with minutes of SSE silence gets falsely cancelled.

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: (fn) => { chromeMock.runtime._onConnect = fn; } },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => ({
      name: 'browsa-chat',
      postMessage: () => {},
      disconnect: () => {},
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} }
    }),
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com', title: 'Test' }),
  },
  sidePanel: {
    setOptions: () => {},
    setPanelBehavior: async () => {},
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => [{ result: { text: '# Mock page\n\nMock.', articleTitle: 'Mock', wasCapped: false, rawTextLength: 20 } }],
  },
  storage: {
    onChanged: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

await import('../background.js'); // registers the onConnect listener captured above
const { idleTimerResetters } = await import('../lib/state.js');

function makeFakePort(name) {
  const port = {
    name,
    _messageListener: null,
    onMessage: { addListener: (fn) => { port._messageListener = fn; } },
    onDisconnect: { addListener: () => {} },
    postMessage: () => {},
    disconnect: () => {},
  };
  return port;
}

test('SW_PING on a claimed browsa-chat port calls the tab\'s resetIdleTimer', async () => {
  idleTimerResetters.clear();
  assert.equal(typeof chromeMock.runtime._onConnect, 'function', 'background.js must have registered an onConnect listener');

  const port = makeFakePort('browsa-chat');
  chromeMock.runtime._onConnect(port);
  assert.ok(port._messageListener, 'browsa-chat connect handler must register an onMessage listener');

  // Claim the port for tab 55 (mirrors onSend()'s STREAM_HELLO handshake).
  port._messageListener({ type: 'STREAM_HELLO', tabId: 55 });

  let resetCalled = false;
  idleTimerResetters.set(55, () => { resetCalled = true; });

  port._messageListener({ type: 'SW_PING' });
  assert.equal(resetCalled, true, 'SW_PING must invoke the resetIdleTimer stored for the claimed tab');
});

test('SW_PING before STREAM_HELLO (no claimed tabId yet) is a safe no-op', async () => {
  idleTimerResetters.clear();
  const port = makeFakePort('browsa-chat');
  chromeMock.runtime._onConnect(port);

  // No STREAM_HELLO sent yet, so claimedTabId is still null.
  assert.doesNotThrow(() => port._messageListener({ type: 'SW_PING' }));
});

test('SW_PING for a tab with no registered resetIdleTimer is a safe no-op', async () => {
  idleTimerResetters.clear();
  const port = makeFakePort('browsa-chat');
  chromeMock.runtime._onConnect(port);
  port._messageListener({ type: 'STREAM_HELLO', tabId: 77 });

  assert.doesNotThrow(() => port._messageListener({ type: 'SW_PING' }));
});
