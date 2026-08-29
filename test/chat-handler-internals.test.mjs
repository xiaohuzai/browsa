// test/chat-handler-internals.test.mjs
// Coverage for chat-handler.js support logic that wasn't exercised by any
// existing test file: llms.txt fetch/cache/TTL, the CHOICE_REQUEST
// trailing-JSON parse/strip contract, and the SW_PING -> resetIdleTimer
// wiring in background.js's browsa-chat
// port handler (documented in CLAUDE.md as a real bug class: without it,
// long tool calls with minutes of SSE silence hit the 5-minute idle
// timeout and get falsely cancelled).
//
// handleChat() itself needs a fuller chrome.storage.local mock than any
// other test file in this suite sets up (see subchat.test.mjs's header
// comment for the same tradeoff) -- so fetchLlmsTxt is tested directly
// (exported for this reason) and the CHOICE_REQUEST pieces are
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

// --------------- auto timestamp-rewrite (video notes) ----------------------
// When the user asks for video notes/summary but the model's first reply
// has no [mm:ss] timestamps, the background silently asks it ONCE to
// reformat with them (deltas swallowed; v2 delivered as the DONE chunk's
// `full`, which the side panel re-renders the bubble from). The gate must
// be conservative: a specific question on a video page ("作者是谁") must
// NOT trigger a rewrite, and a reply that already has [mm:ss] must not be
// rewritten. Replicated here in lockstep with chat-handler.js's source.

const TS_PRESENT_RE = /\[(?:\d+:)?\d{1,2}:\d{2}\]/;
const NOTES_REQUEST_RE = /总结|笔记|纪要|要点|大纲|概要|梳理|summary|summarize|notes?|outline|takeaways?|key points/i;
function shouldRewriteTimestamps({ videoSrc, fullReply, userText }) {
  return !!videoSrc
    && !TS_PRESENT_RE.test(fullReply)
    && NOTES_REQUEST_RE.test(userText || '')
    && fullReply.length > 50;
}

test('chat-handler.js source defines the timestamp-rewrite gate (stay in lockstep)', async () => {
  const src = await readFile(CHAT_HANDLER_PATH, 'utf8');
  // _NOTES_REQUEST_RE has no backslashes - pin it exactly.
  assert.ok(src.includes('_NOTES_REQUEST_RE = /总结|笔记|纪要|要点|大纲|概要|梳理|summary|summarize|notes?|outline|takeaways?|key points/i'),
    '_NOTES_REQUEST_RE literal must match the replicated one');
  assert.ok(src.includes('_TS_PRESENT_RE = /'), 'defines _TS_PRESENT_RE as a regex');
  // Gate-condition components (backslash-free substrings of the source).
  assert.ok(src.includes('videoSrc && !_TS_PRESENT_RE.test(fullReply)'),
    'gate requires videoSrc AND absence of bracketed timestamps');
  assert.ok(src.includes('_NOTES_REQUEST_RE.test(msg.userText'),
    'gate requires the user message to look like a notes/summary request');
  assert.ok(src.includes('fullReply.length > 50'), 'gate requires a non-trivial reply');
});

test('chat-handler.js wires the silent rewrite + TS_STATUS + v1 fallback (stay in lockstep)', async () => {
  const src = await readFile(CHAT_HANDLER_PATH, 'utf8');
  assert.ok(src.includes('const doStream = async (opts = {}) =>'),
    'doStream must accept an opts arg so it can run silently');
  assert.ok(src.includes('await doStream({ silent: true })'),
    'the rewrite must invoke doStream silently (deltas swallowed, not pushed to UI)');
  assert.ok(src.includes("type: 'TS_STATUS'"),
    'the rewrite must push a TS_STATUS chunk so the side panel shows a transient status');
  assert.ok(src.includes('keeping original reply'),
    'on abort/error during the rewrite, v1 must be kept (not discarded)');
});

test('shouldRewriteTimestamps: triggers on a notes request whose reply lacks timestamps', () => {
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'youtube' }, fullReply: '# 概述\n'.repeat(12), userText: '总结一下这个视频' }), true);
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'bilibili' }, fullReply: 'a'.repeat(80), userText: 'please summarize' }), true);
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'bilibili' }, fullReply: 'a'.repeat(80), userText: '帮我做个笔记' }), true);
});

test('shouldRewriteTimestamps: skips when the reply already has bracketed [mm:ss]', () => {
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'youtube' }, fullReply: '章节一 [12:34]\n内容'.repeat(12), userText: '总结' }), false);
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'youtube' }, fullReply: 'see [1:23:45] here ' + 'x'.repeat(60), userText: 'summary' }), false);
});

test('shouldRewriteTimestamps: skips a specific question on a video page (no notes keyword)', () => {
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'bilibili' }, fullReply: '作者是张三，视频讲的是基础知识。'.repeat(3), userText: '这个视频作者是谁？' }), false);
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'bilibili' }, fullReply: 'a'.repeat(80), userText: '视频里提到的工具叫什么' }), false);
});

test('shouldRewriteTimestamps: skips when there is no videoSrc (non-video page)', () => {
  assert.equal(shouldRewriteTimestamps({ videoSrc: null, fullReply: 'a'.repeat(80), userText: '总结一下' }), false);
});

test('shouldRewriteTimestamps: skips a trivially short reply', () => {
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'youtube' }, fullReply: '简短回答', userText: '总结' }), false);
});

test('shouldRewriteTimestamps: bare mm:ss without brackets does NOT count as present', () => {
  // linkifyTimestamps only matches bracketed [mm:ss]; a bare 1:23 wouldn't
  // be linkified, so the rewrite should still fire to fix it.
  assert.equal(shouldRewriteTimestamps({ videoSrc: { platform: 'youtube' }, fullReply: 'see 1:23 for the demo ' + 'x'.repeat(60), userText: '总结' }), true);
});

// --------------- buildRunsConversationHistory (Hermes /v1/runs) ------------
// Verifies inline images are preserved as input_image parts (not flattened to
// text), so XHS / PDF figures / screenshots attached via 📎 reach Hermes.
// handleChat itself needs a heavier chrome.storage mock than this suite sets
// up, so the pure helper is tested directly.

let _buildRunsConversationHistory;
async function buildRunsConversationHistory(history) {
  if (!_buildRunsConversationHistory) {
    ({ buildRunsConversationHistory: _buildRunsConversationHistory } = await import('../lib/handlers/chat-handler.js'));
  }
  return _buildRunsConversationHistory(history);
}

test('buildRunsConversationHistory: plain text turns pass through as strings', async () => {
  const out = await buildRunsConversationHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'another question' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'another question' },
  ]);
});

test('buildRunsConversationHistory: multimodal user turn keeps image_url -> input_image', async () => {
  // The exact shape stored by ATTACH_PAGE/ATTACH_PDF_CONFIRM/screenshot: a text
  // block plus one or more {type:'image_url', image_url:{url}} blocks.
  const out = await buildRunsConversationHistory([
    {
      role: 'user',
      content: [
        { type: 'text', text: '[Page context]\nURL: https://example.com\n...\n## Figures\n1. Figure 1.1: ...' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIG1' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIG2' } },
      ],
    },
    { role: 'assistant', content: 'What would you like to know?' },
    { role: 'user', content: 'Describe the figures' },
  ]);
  assert.equal(out.length, 3);
  // First turn: text normalized to input_text, both images become input_image,
  // order preserved (text first, then images in storage order).
  assert.deepEqual(out[0], {
    role: 'user',
    content: [
      { type: 'input_text', text: '[Page context]\nURL: https://example.com\n...\n## Figures\n1. Figure 1.1: ...' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,FIG1' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,FIG2' },
    ],
  });
  assert.deepEqual(out[1], { role: 'assistant', content: 'What would you like to know?' });
  assert.deepEqual(out[2], { role: 'user', content: 'Describe the figures' });
});

test('buildRunsConversationHistory: image-only turn is kept (not dropped, not "[multimodal message]")', async () => {
  // Regression guard for the old text-only flatten, which turned an image-only
  // turn into the literal '[multimodal message]' placeholder. The image must
  // survive as an input_image part, and the turn must NOT be filtered out.
  const out = await buildRunsConversationHistory([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ONLY' } }] },
  ]);
  assert.equal(out.length, 1, 'image-only turn must not be dropped');
  assert.deepEqual(out[0], {
    role: 'user',
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,ONLY' }],
  });
  assert.notEqual(out[0].content, '[multimodal message]');
});

test('buildRunsConversationHistory: accepts bare-string image_url shape defensively', async () => {
  // /v1/responses uses {type:'image_url', image_url:'data:...'} (string, not
  // nested). Old history or other callers might store that shape; handle it.
  const out = await buildRunsConversationHistory([
    { role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: 'data:image/png;base64,BARE' },
    ] },
  ]);
  assert.deepEqual(out[0].content, [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: 'data:image/png;base64,BARE' },
  ]);
});

test('buildRunsConversationHistory: drops empty turns but keeps image-only ones', async () => {
  const out = await buildRunsConversationHistory([
    { role: 'user', content: '' },                       // empty string -> drop
    { role: 'user', content: '   ' },                    // whitespace -> drop
    { role: 'assistant', content: 'real answer' },       // keep
    { role: 'user', content: [] },                       // empty array -> drop
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,X' } }] }, // image-only -> keep
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[1].content.length, 1);
  assert.equal(out[1].content[0].type, 'input_image');
});

test('buildRunsConversationHistory: filters to user/assistant roles only', async () => {
  const out = await buildRunsConversationHistory([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'tool result' },
    { role: 'assistant', content: 'hey' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hey' },
  ]);
});

test('buildRunsConversationHistory: null/undefined history -> []', async () => {
  assert.deepEqual(await buildRunsConversationHistory(null), []);
  assert.deepEqual(await buildRunsConversationHistory(undefined), []);
});

// --------------- buildHermesTurn (current-turn image routing) ---------------
// Verifies pasted images go directly into `input` as input_image parts (read
// natively by a vision-capable Hermes model), alongside the text -- NOT into a
// synthetic conversation_history turn. conversation_history is just the built
// prior history.

let _buildHermesTurn;
async function buildHermesTurn(msg, history) {
  if (!_buildHermesTurn) {
    ({ buildHermesTurn: _buildHermesTurn } = await import('../lib/handlers/chat-handler.js'));
  }
  return _buildHermesTurn(msg, history);
}

test('buildHermesTurn: no images -> input is the text, history is built normally', async () => {
  const out = await buildHermesTurn(
    { userText: 'hello', images: [] },
    [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'reply' }],
  );
  assert.equal(out.input, 'hello');
  assert.deepEqual(out.conversationHistory, [
    { role: 'user', content: 'prior' },
    { role: 'assistant', content: 'reply' },
  ]);
});

test('buildHermesTurn: pasted images go into input as input_image, NOT into conversation_history', async () => {
  const out = await buildHermesTurn(
    { userText: 'what color is this?', images: ['data:image/png;base64,A', 'data:image/png;base64,B'] },
    [{ role: 'assistant', content: 'earlier reply' }],
  );
  // input is a structured user message: text + both images as input_image,
  // order preserved (text first, then images). NOT a plain string.
  assert.deepEqual(out.input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'what color is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,A' },
      { type: 'input_image', image_url: 'data:image/png;base64,B' },
    ],
  }]);
  // conversation_history is just the built prior history -- NO synthetic
  // trailing image turn appended.
  assert.deepEqual(out.conversationHistory, [{ role: 'assistant', content: 'earlier reply' }]);
});

test('buildHermesTurn: empty userText with images -> input_text is empty string, image still in input', async () => {
  const out = await buildHermesTurn({ userText: '', images: ['data:image/png;base64,X'] }, []);
  assert.deepEqual(out.input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: '' },
      { type: 'input_image', image_url: 'data:image/png;base64,X' },
    ],
  }]);
  assert.deepEqual(out.conversationHistory, []);
});

test('buildHermesTurn: prior history images preserved in conversation_history, new pasted image in input', async () => {
  // A prior page-context turn (text + image) is in history; the user now
  // pastes another image. The prior image stays in conversation_history (via
  // buildRunsConversationHistory -> input_image); the new pasted image goes in
  // the current `input`.
  const out = await buildHermesTurn(
    { userText: 'and this one?', images: ['data:image/png;base64,NEW'] },
    [{
      role: 'user',
      content: [
        { type: 'text', text: '[Page context]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIOR' } },
      ],
    }],
  );
  // New pasted image is in input, alongside the text question.
  assert.deepEqual(out.input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'and this one?' },
      { type: 'input_image', image_url: 'data:image/png;base64,NEW' },
    ],
  }]);
  // Prior turn (text + prior image) preserved in conversation_history.
  assert.equal(out.conversationHistory.length, 1);
  assert.equal(out.conversationHistory[0].content[0].type, 'input_text');
  assert.equal(out.conversationHistory[0].content[1].type, 'input_image');
  assert.equal(out.conversationHistory[0].content[1].image_url, 'data:image/png;base64,PRIOR');
});

test('buildHermesTurn: null/undefined msg -> empty input, built history', async () => {
  const out = await buildHermesTurn(undefined, [{ role: 'user', content: 'hi' }]);
  assert.equal(out.input, '');
  assert.deepEqual(out.conversationHistory, [{ role: 'user', content: 'hi' }]);
});

// --------------- buildResponsesInput (OpenAI /v1/responses) ---------------

let _buildResponsesInput;
async function buildResponsesInput(msg, history) {
  if (!_buildResponsesInput) {
    ({ buildResponsesInput: _buildResponsesInput } = await import('../lib/handlers/chat-handler.js'));
  }
  return _buildResponsesInput(msg, history);
}

test('buildResponsesInput: prior history in input_text/input_image parts + current turn appended', async () => {
  const out = await buildResponsesInput(
    { userText: 'now', images: ['data:image/png;base64,CUR'] },
    [
      { role: 'user', content: 'prior text' },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,PRIOR' } }] },
    ],
  );
  // Prior turns: plain text stays a string, image-only turn becomes input_image.
  assert.deepEqual(out[0], { role: 'user', content: 'prior text' });
  assert.equal(out[1].content[0].type, 'input_image');
  assert.equal(out[1].content[0].image_url, 'data:image/png;base64,PRIOR');
  // Current turn: text + pasted images in one user input.
  assert.equal(out[2].role, 'user');
  assert.equal(out[2].content[0].type, 'input_text');
  assert.equal(out[2].content[0].text, 'now');
  assert.equal(out[2].content[1].type, 'input_image');
  assert.equal(out[2].content[1].image_url, 'data:image/png;base64,CUR');
});

test('buildResponsesInput: no images -> current turn is a plain string', async () => {
  const out = await buildResponsesInput({ userText: 'hi' }, []);
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
});

// --------------- buildAnthropicMessages (Anthropic /v1/messages) -----------

let _buildAnthropicMessages;
async function buildAnthropicMessages(msg, history) {
  if (!_buildAnthropicMessages) {
    ({ buildAnthropicMessages: _buildAnthropicMessages } = await import('../lib/handlers/chat-handler.js'));
  }
  return _buildAnthropicMessages(msg, history);
}

test('buildAnthropicMessages: text turns pass through as strings; system-only content dropped', async () => {
  const out = await buildAnthropicMessages(
    { userText: 'hello', images: [] },
    [
      { role: 'system', content: 'not a real message for Anthropic' },
      { role: 'user', content: 'prior' },
      { role: 'assistant', content: 'reply' },
    ],
  );
  // System messages must NOT appear in the Anthropic messages array (system is
  // a top-level field, not a message).
  assert.equal(out.length, 3, 'system dropped, user + assistant + current user');
  assert.deepEqual(out[0], { role: 'user', content: 'prior' });
  assert.deepEqual(out[1], { role: 'assistant', content: 'reply' });
  assert.deepEqual(out[2], { role: 'user', content: 'hello' });
});

test('buildAnthropicMessages: data: URL images become base64 image blocks; non-data URLs skipped', async () => {
  const out = await buildAnthropicMessages(
    { userText: 'look', images: ['data:image/png;base64,QUJD', 'https://not-a-data-url.example/x.png'] },
    [],
  );
  const content = out[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, 'look');
  assert.deepEqual(content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
  });
  assert.equal(content.length, 2, 'non-data-URL image must be skipped (Anthropic needs base64)');
});

test('buildAnthropicMessages: history image_url data URLs convert to base64 image blocks too', async () => {
  const out = await buildAnthropicMessages(
    { userText: 'q', images: [] },
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,WFla' } }, { type: 'text', text: 'note' }] }],
  );
  const content = out[0].content;
  assert.equal(content[0].type, 'image', 'parts keep the original array order (image came first)');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.equal(content[0].source.data, 'WFla');
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, 'note');
});



// --------------- auto-continuation on output-cap truncation ------------------
// handleChat() 本身不做端到端 mock（见文件头说明），这里按本文件惯例做源级
// 结构断言：续写块必须存在、必须门控在 replyTruncated、必须静默第二遍、
// 必须在时间戳重写【之前】执行（重写作用于续写后的全文）。

test('chat-handler: auto-continuation block sits between the retry loop and the timestamp rewrite', async () => {
  const src = await readFile(CHAT_HANDLER_PATH, 'utf8');
  const contIdx = src.indexOf('Auto-continuation on output-cap truncation');
  const rewriteIdx = src.indexOf('Auto timestamp rewrite (video notes)');
  assert.ok(contIdx > 0, 'continuation block must exist');
  assert.ok(rewriteIdx > contIdx, 'continuation must run BEFORE the timestamp rewrite (rewrite operates on the merged full text)');

  const block = src.slice(contIdx, rewriteIdx);
  assert.match(block, /if \(replyTruncated && fullReply\)/, 'gated on the truncation flag');
  assert.match(block, /doStream\(\{ silent: true \}\)/, 'second pass is silent (deltas swallowed, DONE.full replaces the bubble)');
  assert.match(block, /fullReply = fullReply \+ rc\.full/, 'merged, not replaced (continuation resumes mid-sentence)');
  assert.match(block, /replyTruncated = rc\.finishReason === 'length'/, 'still-truncated flag re-derived from the continuation leg');
  assert.match(block, /isHermes/, 'Hermes runs-path mirrors the rewrite conversation rebuild');
  assert.match(block, /Do NOT repeat any content already written/, 'anti-repetition instruction present');
});

test('chat-handler: continuation reuses the silent-second-pass contract (TS_STATUS pushed, acc reset+merged)', async () => {
  const src = await readFile(CHAT_HANDLER_PATH, 'utf8');
  const block = src.slice(src.indexOf('Auto-continuation on output-cap truncation'), src.indexOf('Auto timestamp rewrite (video notes)'));
  assert.match(block, /pushChunk\(tabId, \{ type: 'TS_STATUS'/, 'user-visible status while the silent pass runs');
  assert.match(block, /_stCont\.acc = ''/, 'stream-state accumulator reset before the silent pass (no v1+v2 double in PEEK)');
  assert.match(block, /_stCont\.acc = fullReply/, 'acc holds the MERGED text after the continuation (tab-switch PEEK correctness)');
});
