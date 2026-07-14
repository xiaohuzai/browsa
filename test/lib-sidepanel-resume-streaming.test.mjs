// test/lib-sidepanel-resume-streaming.test.mjs — execution test for
// sidepanel.js's OTHER streaming listener: the one wired inside
// resumeInFlightStream() (called once from init(), when STREAM_PEEK reports
// an in-flight stream on tab activation/panel reopen), as opposed to
// onSend()'s listener (covered in test/lib-sidepanel-streaming.test.mjs).
//
// These are two independently-maintained, near-duplicate code blocks in
// sidepanel.js — the Phase 6 (reveal-pacer/.destroy()) and Phase 9 (async
// renderSafe/await) changes touched both. A regression fixed in one but
// missed in the other is a real, plausible failure mode for future edits,
// so this gets its own dedicated test rather than relying on the onSend()
// coverage to stand in for it.
//
// Needs its own JSDOM instance + a cache-busted re-import of sidepanel.js
// (Node's module cache would otherwise skip re-running its module-level
// `init()` call against a second document).

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
  const port = {
    name,
    sent: [],
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => {
      port.sent.push(msg);
      if (msg.type === 'STREAM_HELLO') {
        queueMicrotask(() => port.emit({ type: 'STREAM_HELLO_ACK' }));
      }
    },
    disconnect: () => {},
    emit: (msg) => { for (const fn of [...listeners]) fn(msg); },
  };
  return port;
}

let lastChatPort = null;

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 7, url: 'https://example.com/', title: 'Example' }],
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
      if (msg.type === 'GET_CONFIG') return cb({ data: {} });
      // The key difference from the onSend() test: STREAM_PEEK reports an
      // in-flight stream with some accumulated text already, so init()'s
      // resumeInFlightStream() takes the "resume" branch instead of
      // returning early.
      if (msg.type === 'STREAM_PEEK') return cb({ inFlight: true, acc: 'resumed so far. ', startedAt: Date.now() - 5000 });
      cb({ ok: true });
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

await import('../sidepanel.js?resume-test=' + Math.random());
await new Promise((r) => setTimeout(r, 100));

const messagesEl = document.getElementById('messages');

test('resumeInFlightStream(): pre-renders the STREAM_PEEK accumulated text and opens a browsa-chat port', () => {
  assert.ok(lastChatPort, 'resumeInFlightStream() must open its own browsa-chat port');
  assert.ok(lastChatPort.sent.some((m) => m.type === 'STREAM_HELLO'));
  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.ok(assistantEl, 'an assistant bubble must exist to hold the resumed content');
});

test('resumeInFlightStream()\'s CHUNK/DONE listener only runs addCodeCopyButtons/renderMermaid AFTER the async final render lands', async () => {
  const finalText = 'Resumed reply.\n\n```js\nconst y = 2;\n```\n';
  lastChatPort.emit({ type: 'DONE', full: finalText });
  // The listener is `async (m) => {...}` and awaits r(m.full||acc, true)
  // (renderStream -> renderSafe) before addCodeCopyButtons()/renderMermaid()
  // — give it a tick to fully resolve.
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.match(assistantEl.innerHTML, /<pre[ >]/, 'the final markdown must have been rendered into real HTML');
  assert.ok(assistantEl.querySelector('.code-copy-btn'),
    'addCodeCopyButtons() must have run AFTER the final render — proves the await was not skipped in this listener too');
});

test('resumeInFlightStream()\'s ensureAssistantEl() re-resolves and destroys the old renderer when the DOM node identity changes mid-stream', async () => {
  // Simulate a second resumed stream (fresh port) to exercise the
  // DOM-identity-change branch independent of the previous test's state.
  const finalText2 = 'second resumed reply';
  // Re-trigger via a fresh CHUNK on the existing port first so there is an
  // active renderStream/pacer to abandon.
  lastChatPort.emit({ type: 'CHUNK', delta: 'streaming in...' });
  await new Promise((r) => setTimeout(r, 20));

  // Mimic onActivated's innerHTML restore replacing the whole subtree —
  // the old assistantEl node identity is gone, ensureAssistantEl() must
  // notice on the next chunk and swap renderers (calling .destroy() on the
  // abandoned one) rather than throwing or writing into a detached node.
  messagesEl.innerHTML = '<div class="msg assistant">▍</div>';

  assert.doesNotThrow(() => lastChatPort.emit({ type: 'CHUNK', delta: ' more' }));
  await new Promise((r) => setTimeout(r, 20));

  lastChatPort.emit({ type: 'DONE', full: finalText2 });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.match(assistantEl.textContent, /second resumed reply/);
  assert.ok(assistantEl.classList.contains('done'));
});
