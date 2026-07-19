// test/lib-sidepanel-status-dot.test.mjs — execution test for the topbar
// status dot (`.status-dot` + `.wordmark` in sidepanel.html/css, driven by
// `setStatusDotState()` in sidepanel.js). Same black-box jsdom approach as
// test/lib-sidepanel-streaming.test.mjs (sidepanel.js has zero exports), but
// its own file/JSDOM instance so this doesn't share module state with the
// other sidepanel.js execution tests.
//
// This replaces an earlier "Margin Rail" design (a persistent stitched line
// down the panel's left edge, formerly test/lib-sidepanel-rail.test.mjs) —
// removed after live testing read as an odd, unexplained vertical line
// rather than a legible status signal. Same three-state idea, now a small
// dot next to the wordmark instead.
//
// Covers: the status-dot/wordmark markup exists; setStatusDotState('streaming')
// fires while a chat request is in flight and reverts to 'idle' once it
// settles; setStatusDotState('error') fires on a real error path (a failed
// page attach) and auto-reverts to 'idle' after its timeout rather than
// getting stuck red.

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

function makeFakePort(name) {
  const listeners = [];
  const disconnectListeners = [];
  const port = {
    name,
    sent: [],
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage: (msg) => {
      port.sent.push(msg);
      if (msg.type === 'STREAM_HELLO') {
        queueMicrotask(() => port.emit({ type: 'STREAM_HELLO_ACK' }));
      }
    },
    disconnect: () => { for (const fn of disconnectListeners) fn(); },
    emit: (msg) => { for (const fn of [...listeners]) fn(msg); },
  };
  return port;
}

// Lets a single test hold the CHAT sendMessage response open (simulating a
// request genuinely in flight) so the transient 'streaming' dot state can
// be observed before resolving it, rather than racing against an
// immediately-resolved mock.
let pendingChatResolve = null;

let sendMessageHandler = async (msg) => {
  if (msg.type === 'GET_CONFIG') return { data: {} };
  if (msg.type === 'STREAM_PEEK') return { inFlight: false };
  if (msg.type === 'CHAT') {
    return new Promise((resolve) => { pendingChatResolve = resolve; });
  }
  return { ok: true };
};

let lastChatPort = null;

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
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const attachBtn = document.getElementById('attach');
const dotEl = document.getElementById('status-dot');

test('the status dot and wordmark markup exist and start with no explicit state', () => {
  assert.ok(dotEl, '#status-dot must exist');
  assert.equal(dotEl.className, 'status-dot');
  // sidepanel.html ships the element with no data-state attribute at all —
  // sidepanel.css's base `.status-dot` rule (which already paints the idle
  // --border-strong color) applies with no attribute selector needed, and
  // setStatusDotState() only ever gets called once a stream starts or an
  // error occurs. So "idle" on fresh load means "attribute absent", not
  // a stamped "idle" value.
  assert.equal(dotEl.dataset.state, undefined, 'dot must have no explicit state on fresh load (idle is the CSS default, not a stamped attribute)');

  const wordmark = document.querySelector('.wordmark');
  assert.ok(wordmark, '.wordmark must exist in the topbar');
  assert.equal(wordmark.textContent, 'browsa');
});

test('setStatusDotState(\'streaming\'): the dot switches to streaming while a chat request is in flight, and back to idle once it settles', async () => {
  inputEl.value = 'hello';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  // onSend() awaits chrome.tabs.get() before calling setStreamingUI(true) —
  // give that one microtask hop time to land.
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(dotEl.dataset.state, 'streaming', 'dot must reflect the in-flight request');
  assert.ok(pendingChatResolve, 'the CHAT sendMessage call must still be pending at this point');
  assert.ok(lastChatPort, 'onSend() must have opened its browsa-chat port by now');

  // End the stream the same way the real background does: a DONE chunk over
  // the port. wireChatStreamPort()'s DONE branch is what actually clears
  // onSend()'s SW-keepalive setInterval (stopKeepAlive) — merely resolving
  // the outer CHAT sendMessage call, without this, would leave that interval
  // running forever and hang the test process on exit.
  lastChatPort.emit({ type: 'DONE', full: 'reply text' });
  // Resolve the held-open CHAT response too, so onSend()'s own await/finally
  // completes cleanly instead of leaving a dangling pending promise.
  pendingChatResolve({ ok: true });
  pendingChatResolve = null;
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dotEl.dataset.state, 'idle', 'dot must revert to idle once the request settles with no error');
});

test('setStatusDotState(\'error\'): a real failure path (failed page attach) turns the dot red, then auto-reverts to idle without getting stuck', async () => {
  sendMessageHandler = async (msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    if (msg.type === 'ATTACH_PAGE') return { ok: false, error: 'boom' };
    return { ok: true };
  };

  attachBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(dotEl.dataset.state, 'error', 'a failed attach must turn the dot red via appendError() -> setStatusDotState(\'error\')');

  // setStatusDotState('error') schedules a 1600ms auto-revert so a single
  // failed request never leaves the dot permanently red.
  await new Promise((r) => setTimeout(r, 1650));
  assert.equal(dotEl.dataset.state, 'idle', 'the error state must auto-revert to idle (no stream active) after its timeout');
});
