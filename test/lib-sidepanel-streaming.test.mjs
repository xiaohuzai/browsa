// test/lib-sidepanel-streaming.test.mjs — a real execution test of
// sidepanel.js itself (not one of its extracted lib/sidepanel/*.js modules).
//
// sidepanel.js has ZERO exports — it calls init() unconditionally at module
// load and only exposes behavior through DOM events (button clicks, keydown,
// chrome.runtime ports). That's also its only "API" for testing: load the
// real sidepanel.html markup into jsdom, mock the chrome.* surface it needs,
// import the real module, then drive it exactly like a browser would.
//
// This specifically targets what no other test covers: the await/.destroy()
// wiring added across Phase 6 (reveal-pacer) and Phase 9 (KaTeX worker
// offload) inside onSend()'s CHUNK/DONE port listener, since renderStream()
// (and therefore renderSafe()) became async. If a future edit drops an
// `await` there, addCodeCopyButtons()/renderMermaid() would run against a
// bubble whose innerHTML hasn't been updated to the final render yet — this
// test would catch that by including a code block in the final text and
// asserting the copy button (added by addCodeCopyButtons, which only finds
// something to act on once the real <pre> exists) is actually there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/sidepanel.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.location = dom.window.location;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// ─── chrome.* mock ───────────────────────────────────────────────────────────
// Generic fake port: supports multiple onMessage listeners (sidepanel.js
// attaches more than one to the same port — a one-shot ACK listener, then
// the real chunk listener), same pattern already proven in
// test/lib-detail-thread.test.mjs's fake chrome.runtime.connect port.
function makeFakePort(name) {
  const listeners = [];
  const disconnectListeners = [];
  const port = {
    name,
    _listeners: listeners,
    sent: [],
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage: (msg) => {
      port.sent.push(msg);
      // Auto-ACK any *_HELLO handshake so onSend()'s/resumeInFlightStream's
      // ack-wait resolves immediately instead of falling through to its
      // 500ms safety-net timeout.
      if (msg.type === 'STREAM_HELLO') {
        queueMicrotask(() => port.emit({ type: 'STREAM_HELLO_ACK' }));
      }
    },
    disconnect: () => { for (const fn of disconnectListeners) fn(); },
    emit: (msg) => { for (const fn of [...listeners]) fn(msg); },
  };
  return port;
}

let lastChatPort = null;
let sendMessageHandler = async (msg) => ({ ok: true });

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/', title: 'Example' }],
    get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  runtime: {
    connect: ({ name }) => {
      const port = makeFakePort(name);
      if (name === 'browsa-chat') lastChatPort = port;
      return port;
    },
    sendMessage: (msg, cb) => {
      sendMessageHandler(msg).then((res) => cb(res)).catch((e) => cb({ ok: false, error: e.message }));
    },
    lastError: undefined,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
    session: {
      get: async () => ({}),
      remove: async () => {},
    },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

// GET_CONFIG / STREAM_PEEK / CHAT default responses — individual tests
// override sendMessageHandler for the behavior they need.
sendMessageHandler = async (msg) => {
  if (msg.type === 'GET_CONFIG') return { data: {} };
  if (msg.type === 'STREAM_PEEK') return { inFlight: false };
  if (msg.type === 'CHAT') return { ok: true };
  return { ok: true };
};

await import('../sidepanel.js');
// sidepanel.js's init() runs fire-and-forget (not awaited by the module
// itself) — give its promise chain (chrome.tabs.query -> GET_CONFIG ->
// renderHistory -> STREAM_PEEK -> ...) time to settle before driving any UI.
await new Promise((r) => setTimeout(r, 100));

const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const messagesEl = document.getElementById('messages');

test('sidepanel.js: init() completed without throwing (input is usable)', () => {
  assert.ok(inputEl, 'the composer textarea must exist');
  assert.equal(inputEl.disabled, false);
});

test('onSend(): CHUNK deltas render progressively, and DONE only runs addCodeCopyButtons/renderMermaid AFTER the final render has actually landed', async () => {
  inputEl.value = 'hello';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  // Let onSend() run up through its STREAM_HELLO/ACK handshake and attach
  // the real chunk listener.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort, 'onSend() must open a browsa-chat port');
  assert.ok(lastChatPort.sent.some((m) => m.type === 'STREAM_HELLO'));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.ok(assistantEl, 'a placeholder assistant bubble must be appended immediately');

  lastChatPort.emit({ type: 'CHUNK', delta: 'partial' });
  // Deltas are paced (markstream-core) — no assertion on intermediate state
  // needed here, just enough time for it not to interfere with what follows.
  await new Promise((r) => setTimeout(r, 30));

  // Final text includes a fenced code block — addCodeCopyButtons() only
  // finds something to act on once the real <pre><code> exists in the DOM,
  // which only happens after the awaited renderSafe() call resolves. If a
  // future edit drops that `await`, this assertion is what would catch it:
  // addCodeCopyButtons() would run one tick too early, against whatever
  // (possibly still-placeholder) content was in the bubble at that moment.
  const finalText = 'Done.\n\n```js\nconst x = 1;\n```\n';
  lastChatPort.emit({ type: 'DONE', full: finalText });
  // The listener callback is async (awaits renderStream -> renderSafe) —
  // give it a tick to fully resolve before asserting on its result.
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(assistantEl.classList.contains('done'), 'bubble must be marked done once DONE is fully processed');
  assert.match(assistantEl.innerHTML, /<pre[ >]/, 'the final markdown must have been rendered into real HTML');
  assert.ok(assistantEl.querySelector('.code-copy-btn'),
    'addCodeCopyButtons() must have run AFTER the final render — proves the await was not skipped');
});

test('onSend(): a RETRY message destroys the abandoned pacer before building a fresh renderer', async () => {
  inputEl.value = 'hello again';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort);

  lastChatPort.emit({ type: 'CHUNK', delta: 'first attempt text' });
  await new Promise((r) => setTimeout(r, 30));

  // RETRY must not throw (this is exactly where render.js's makeStreamRenderer's
  // .destroy() gets invoked on the previous attempt's renderer — Phase 6).
  assert.doesNotThrow(() => lastChatPort.emit({ type: 'RETRY', attempt: 2, maxAttempts: 3 }));
  await new Promise((r) => setTimeout(r, 30));

  lastChatPort.emit({ type: 'DONE', full: 'second attempt final text' });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.match(assistantEl.textContent, /second attempt final text/);
  assert.doesNotMatch(assistantEl.textContent, /first attempt text/, 'RETRY must have cleared the failed attempt\'s content');
});

test('clicking Stop mid-stream marks the abandoned bubble .done so its blinking cursor stops', async () => {
  // Regression test: cancelStream() used to disconnect the port without
  // ever touching the in-progress bubble. The background's ERROR/ABORTED
  // message (which normally finalizes a bubble via renderStream(..., true))
  // never arrives once the port is gone client-side, so nothing else was
  // ever going to add .done — the cancelled bubble's ::after blinking
  // cursor kept animating forever, even after a brand new message was sent.
  inputEl.value = 'first message, will be cancelled';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort, 'onSend() must open a browsa-chat port');

  lastChatPort.emit({ type: 'CHUNK', delta: 'partial before cancel' });
  await new Promise((r) => setTimeout(r, 30));

  const cancelledEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.ok(!cancelledEl.classList.contains('done'), 'sanity check: not done yet while streaming');

  // sendBtn doubles as Stop while a stream is active (is-stopping state).
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(cancelledEl.classList.contains('done'),
    'the cancelled bubble must be marked .done so its blinking cursor (.msg.assistant::after) stops');

  // Send a second message — its own bubble must be the ONLY one still
  // blinking (i.e. the only .msg.assistant without .done).
  inputEl.value = 'second message';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  lastChatPort.emit({ type: 'DONE', full: 'second message reply' });
  await new Promise((r) => setTimeout(r, 50));

  const stillBlinking = [...messagesEl.querySelectorAll('.msg.assistant')].filter((el) => !el.classList.contains('done'));
  assert.equal(stillBlinking.length, 0, 'after the second message completes, no assistant bubble should still be missing .done');
});

test('TOOL_PROGRESS renders before the bubble (grouped with thinking), not after', async () => {
  inputEl.value = 'use a tool please';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort);

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  lastChatPort.emit({ type: 'TOOL_PROGRESS', text: 'Reading file foo.js' });
  await new Promise((r) => setTimeout(r, 10));

  const tp = assistantEl.previousElementSibling;
  assert.ok(tp?.classList.contains('tool-progress'), 'tool-progress must be the bubble\'s PREVIOUS sibling, not its next one');
  assert.match(tp.textContent, /Reading file foo\.js/);

  // A second TOOL_PROGRESS event must update the same element in place,
  // not create a duplicate — same "overwrite" contract as before the move.
  lastChatPort.emit({ type: 'TOOL_PROGRESS', text: 'Running tests' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(assistantEl.previousElementSibling, tp, 'must reuse the same element, not insert a second one');
  assert.match(tp.textContent, /Running tests/);
  assert.doesNotMatch(tp.textContent, /Reading file/, 'old tool-progress text must be replaced, not appended');

  lastChatPort.emit({ type: 'DONE', full: 'done with tools' });
  await new Promise((r) => setTimeout(r, 50));
});

test('TS_STATUS (auto timestamp-rewrite) shows a transient status before the bubble and is cleared on DONE', async () => {
  inputEl.value = '总结一下这个视频';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort);

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  // The background emits TS_STATUS after v1 finishes streaming, asking the
  // model to reformat with [mm:ss]. It must surface as a tool-progress-style
  // indicator above the bubble - but, unlike TOOL_PROGRESS, it must NOT be
  // recorded into toolEvents (or DONE would render it as a tool-history row).
  lastChatPort.emit({ type: 'TS_STATUS', text: '⏱ 正在补充时间戳…' });
  await new Promise((r) => setTimeout(r, 10));

  const tp = assistantEl.previousElementSibling;
  assert.ok(tp?.classList.contains('tool-progress'), 'TS_STATUS must render a tool-progress indicator before the bubble');
  assert.match(tp.textContent, /正在补充时间戳/);

  // DONE swaps the bubble to the rewritten text (v2) and must clear the
  // transient status indicator - it should not linger as a tool-history row.
  lastChatPort.emit({ type: 'DONE', full: '## 概述 [00:00]\n内容…' });
  await new Promise((r) => setTimeout(r, 50));

  const tpAfter = assistantEl.previousElementSibling;
  assert.ok(!tpAfter || !tpAfter.classList.contains('tool-progress'),
    'TS_STATUS indicator must be cleared on DONE');
  // And no tool-history block should have been rendered for it.
  assert.doesNotMatch(assistantEl.innerHTML, /正在补充时间戳/,
    'TS_STATUS must not leak into the bubble as rendered tool history');
});
