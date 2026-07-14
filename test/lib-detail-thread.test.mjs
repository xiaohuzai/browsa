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
// Must pass a real timestamp: appendDelta now routes through a reveal-pacer
// (markstream-core) whose tick() does real arithmetic on the rAF timestamp —
// an undefined one makes several of its calculations evaluate to NaN, which
// breaks its per-tick char-count cap and reveals everything in one tick.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
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
  // appendDelta now routes through a reveal-pacer (markstream-core) instead
  // of rendering synchronously — wait past its 80ms startDelay plus enough
  // time to reveal all 8 characters at the 40 chars/sec floor rate.
  await new Promise((r) => setTimeout(r, 400));
  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(liveAi, 'a live assistant bubble must appear in the card once deltas start arriving');
  assert.match(liveAi.innerHTML, /<strong>bold<\/strong>/);
  assert.equal(liveAi.classList.contains('done'), false, 'must not be marked done while still streaming');

  lastPort.emit({ type: 'SUBCHAT_DONE' });
  // finalize() is now async (renderSafe awaits the KaTeX worker/threshold
  // path) and SUBCHAT_DONE's handler calls it fire-and-forget — give it a
  // tick to complete before asserting on its result.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(liveAi.classList.contains('done'), true, 'must be marked done once SUBCHAT_DONE arrives');
});

test('SUBCHAT_DONE arriving before the reveal-pacer has caught up still finalizes with the full text, not a truncated one', async () => {
  // Regression: appendDelta feeds the pacer, but finalize() must render the
  // true full accumulated text (rawAccum), never the paced display text
  // (liveAiText) — if it used the latter, a still-draining pacer backlog at
  // SUBCHAT_DONE time would get silently dropped from the final reply.
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'explain';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const fullText = 'a much longer reply than the pacer could reveal in a few milliseconds';
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: fullText });
  // Finalize immediately — well before the pacer's 80ms startDelay even
  // elapses, so nothing should have been paced-revealed into liveAiText yet.
  lastPort.emit({ type: 'SUBCHAT_DONE' });
  // finalize() is now async — give it a tick to complete before asserting.
  await new Promise((r) => setTimeout(r, 20));

  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(liveAi, 'a live assistant bubble must appear even if finalize() lands before the pacer reveals anything');
  assert.match(liveAi.textContent, /a much longer reply than the pacer could reveal in a few milliseconds/,
    'the full delta must be present in the final render, not truncated to whatever the pacer had revealed');
  assert.equal(liveAi.classList.contains('done'), true);
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

test('regression: .detail-thread-input-row (and everything after it, including the resize handle) must stay pinned to the card bottom via margin-top:auto', async () => {
  // Real bug this guards against: before any message exists,
  // .detail-thread-messages (the only flex-grow child) is display:none
  // (":empty" rule below) — with no flex-grow sibling to absorb it,
  // dragging the card taller left the extra height as a gap somewhere in
  // the middle instead of pushing content down to the new bottom edge.
  // First attempt put margin-top:auto on the resize handle alone, which
  // pinned the handle correctly but stranded the input row above a
  // growing gap (nothing was pushing the input row itself down). The fix
  // moved margin-top:auto to .detail-thread-input-row instead — pinning
  // the input row to the bottom pulls everything after it (the handle,
  // which sits immediately after with only its own small fixed margin)
  // along with it, since there's nothing else between them to leave a gap.
  //
  // This is a structural (source-text) check, not a real layout test —
  // jsdom has no real layout engine (getBoundingClientRect/offsetHeight
  // always return 0), so there is no way to execute-test actual CSS
  // flexbox behavior in this repo's test environment. This at least
  // catches an accidental revert of the fix itself.
  const fs = await import('node:fs/promises');
  const css = await fs.readFile(new URL('../sidepanel.css', import.meta.url), 'utf8');
  const inputRowRule = css.match(/\.detail-thread-input-row\s*\{[^}]*\}/);
  assert.ok(inputRowRule, '.detail-thread-input-row rule must exist in sidepanel.css');
  assert.match(inputRowRule[0], /margin-top:\s*auto/,
    'the input row must have margin-top:auto so it (and the handle after it) are pinned to the bottom');
  const handleRule = css.match(/\.detail-thread-resize-handle\s*\{[^}]*\}/);
  assert.ok(handleRule);
  assert.doesNotMatch(handleRule[0], /margin:\s*auto/,
    'margin-top:auto must live on the input row, not the handle — putting it on the handle alone leaves the input row stranded');
  assert.match(css, /\.detail-thread-messages:empty\s*\{\s*display:\s*none/,
    'the display:none-when-empty rule this fix accounts for must still be in place');
});
