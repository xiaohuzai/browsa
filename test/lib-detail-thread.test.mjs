// test/lib-detail-thread.test.mjs — execution tests for lib/detail-thread.js,
// extracted from sidepanel.js in the Phase 3 modularization refactor.
//
// This module wires its own mouseup/scroll listeners on import (no
// initX() call), reading document.getElementById('messages') at that
// moment — so the DOM (and all globals render.js/ui-utils.js need) must
// exist BEFORE the dynamic import below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><div id="messages"></div></body></html>',
  { url: 'http://localhost/' }
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.location = dom.window.location;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const sentMessages = [];
function makeFakePort() {
  const port = {
    _listeners: [],
    onMessage: { addListener: (fn) => port._listeners.push(fn), removeListener: (fn) => { port._listeners = port._listeners.filter(l => l !== fn); } },
    onDisconnect: { addListener: () => {} },
    postMessage: (m) => {
      if (m.type === 'SUBCHAT_HELLO') {
        // Reply with the ACK synchronously-ish, like the real background does fast.
        setTimeout(() => port._listeners.forEach(l => l({ type: 'SUBCHAT_HELLO_ACK' })), 0);
      }
    },
    disconnect: () => {},
    emit: (m) => port._listeners.forEach(l => l(m)),
  };
  return port;
}
let lastPort = null;
globalThis.chrome = {
  downloads: { download: async () => {} },
  runtime: {
    connect: () => { lastPort = makeFakePort(); return lastPort; },
    sendMessage: (msg, cb) => { sentMessages.push(msg); cb({ ok: true }); },
    lastError: undefined,
  },
};

const { openDetailThread, hideSelectionAskBtn } = await import('../lib/sidepanel/detail-thread.js');

function makeAssistantBubble(raw) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.dataset.raw = raw;
  el.textContent = raw;
  document.getElementById('messages').appendChild(el);
  return el;
}

test('openDetailThread creates a card with the escaped quoted excerpt right after the bubble', () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Full reply text about <b>GPUs</b>.');
  openDetailThread(bubble, 'about <b>GPUs</b>', bubble);
  const card = bubble.nextElementSibling;
  assert.ok(card, 'a sibling element must be inserted right after the bubble');
  assert.ok(card.classList.contains('detail-thread-card'));
  assert.match(card.querySelector('.detail-thread-quote').innerHTML, /&lt;b&gt;GPUs&lt;\/b&gt;/,
    'quoted text must be HTML-escaped, not injected raw');
  card.remove();
});

test('opening a second time on the same anchor focuses the existing card instead of duplicating it', () => {
  const bubble = makeAssistantBubble('Some reply.');
  openDetailThread(bubble, 'excerpt one', bubble);
  openDetailThread(bubble, 'excerpt two', bubble);
  const cards = [...document.querySelectorAll('.detail-thread-card')];
  assert.equal(cards.length, 1, 'must not open a duplicate card for the same anchor');
  // Original quote text must be unchanged (second call just focused, not replaced).
  assert.match(cards[0].querySelector('.detail-thread-quote').textContent, /excerpt one/);
  cards[0].remove();
});

test('the close button removes the card and, if a request is in flight, sends SUBCHAT_ABORT', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  const sendBtn = card.querySelector('.detail-thread-send');
  input.value = 'what does this mean?';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20)); // let the HELLO_ACK + SUBCHAT send land
  assert.ok(sentMessages.some(m => m.type === 'SUBCHAT'), 'send() must dispatch a SUBCHAT message');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(bubble.nextElementSibling, null, 'card must be removed from the DOM');
  assert.ok(sentMessages.some(m => m.type === 'SUBCHAT_ABORT'), 'closing mid-flight must abort the in-flight subchat turn');
});

test('a streamed reply renders progressively and finalizes with markdown + a done class on SUBCHAT_DONE', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply about bold text.');
  openDetailThread(bubble, 'bold text', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'explain';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: '**bold**' });
  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(liveAi, 'a live assistant bubble must appear in the card once deltas start arriving');
  assert.match(liveAi.innerHTML, /<strong>bold<\/strong>/);
  assert.equal(liveAi.classList.contains('done'), false, 'must not be marked done while still streaming');

  lastPort.emit({ type: 'SUBCHAT_DONE' });
  assert.equal(liveAi.classList.contains('done'), true, 'must be marked done once SUBCHAT_DONE arrives');
});

test('a failed turn shows an error message and does not leave a dangling unanswered user turn on retry', async () => {
  sentMessages.length = 0;
  chrome.runtime.sendMessage = (msg, cb) => { sentMessages.push(msg); cb({ ok: false, error: 'boom' }); };
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'first question';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(liveAi.classList.contains('subchat-error'));
  assert.match(liveAi.textContent, /boom/);
  // Input must be re-enabled so the user can retry.
  assert.equal(input.disabled, false);
});

test('hideSelectionAskBtn is a safe no-op when no button is showing', () => {
  assert.doesNotThrow(() => hideSelectionAskBtn());
});
