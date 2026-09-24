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

test('the card input is a textarea (long questions wrap) and Shift+Enter never sends', async () => {
  // 2026-09-23 user report: the card input was a single-line <input> — text
  // past a screenful just scrolled sideways instead of breaking into lines.
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  assert.equal(input.tagName, 'TEXTAREA', 'a single-line input can never wrap — must be a textarea');

  input.value = 'a question long enough to wrap';
  const shiftEnter = input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
  }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!sentMessages.some(m => m.type === 'SUBCHAT'), 'Shift+Enter must not send');
  assert.equal(shiftEnter, true, 'Shift+Enter must not be preventDefault-ed (native newline stands)');

  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sentMessages.some(m => m.type === 'SUBCHAT'), 'plain Enter must send');

  // Tear the in-flight turn down (AGENTS.md jsdom gotcha: a dangling turn
  // port leaks its 20s SW_PING interval and hangs node --test).
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
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
  // Swap in a failing sendMessage for THIS test only — restore afterwards.
  // (An unconditional override here leaked into every later test in this
  // file: their send() calls saw ok:false and took the fail() path too.)
  const originalSendMessage = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = (msg, cb) => { sentMessages.push(msg); cb({ ok: false, error: 'boom' }); };
  try {
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
  } finally {
    chrome.runtime.sendMessage = originalSendMessage;
  }
});

test('hideSelectionAskBtn is a safe no-op when no button is showing', () => {
  assert.doesNotThrow(() => hideSelectionAskBtn());
});

test('the send button becomes a stop button mid-turn: click aborts but keeps the card and finalizes the partial text', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  const sendBtn = card.querySelector('.detail-thread-send');
  input.value = 'explain slowly';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sendBtn.classList.contains('is-stopping'), 'button must read as stop while streaming');
  assert.equal(input.disabled, true, 'input must be locked while streaming');

  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'partial answer text' });
  await new Promise((r) => setTimeout(r, 20)); // rawAccum updates synchronously; wait for the send() chain to settle
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // now ■ stop
  await new Promise((r) => setTimeout(r, 30)); // stopTurn() finalizes async (renderSafe)

  assert.ok(sentMessages.some(m => m.type === 'SUBCHAT_ABORT'), 'stop must send SUBCHAT_ABORT');
  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(liveAi, 'the card and its reply bubble must survive the stop');
  assert.equal(liveAi.classList.contains('done'), true, 'partial text must be finalized in place');
  assert.match(liveAi.textContent, /partial answer text/, 'the partial text must be kept, not discarded');
  assert.equal(input.disabled, false, 'input re-enabled so the thread can continue');
  assert.ok(!sendBtn.classList.contains('is-stopping'), 'button swaps back to send');
  assert.ok(!card.querySelector('.live-think'), 'no live think block left stranded after teardown');
});

test('stopping before any text arrives removes the empty reply bubble instead of leaving a blank done bubble', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'quick question';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(sentMessages.some(m => m.type === 'SUBCHAT_ABORT'));
  const assistants = card.querySelectorAll('.detail-thread-messages .msg.assistant');
  assert.equal(assistants.length, 0, 'empty reply bubble must be removed, not finalized as a blank');
  assert.equal(input.disabled, false, 'input re-enabled for a retry');
});

test('SUBCHAT_DONE stamps the finalized reply with the provider label chip at the top of the bubble', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'who are you';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'hello' });
  lastPort.emit({ type: 'SUBCHAT_DONE', providerLabel: 'Hermes Agent · glm-4.7', providerKey: { name: 'hermes', model: 'glm-4.7' } });
  await new Promise((r) => setTimeout(r, 30));

  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  const chip = liveAi?.querySelector('.msg-provider');
  assert.ok(chip, 'a .msg-provider chip must render on the finalized reply');
  assert.equal(chip.textContent, 'Hermes Agent · glm-4.7');
  assert.equal(liveAi.firstElementChild, chip, 'chip sits at the top of the bubble (sender-label position, same as main chat)');
});

test('SUBCHAT_TOOL_PROGRESS renders the main panel\'s pre-bubble progress line and it clears on DONE', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'go search';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  // Waiting indicator (思考中… Ns) fills the pre-bubble slot until the first
  // real event — same first-token-latency treatment as the main panel (B4).
  const wait = card.querySelector('.detail-thread-messages .wait-indicator');
  assert.ok(wait, 'a wait indicator must appear between send and the first event');

  lastPort.emit({ type: 'SUBCHAT_TOOL_PROGRESS', text: 'web_search: querying duckduckgo' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!card.querySelector('.wait-indicator'), 'the first real event must stop the wait indicator');
  const line = card.querySelector('.detail-thread-messages .tool-progress');
  assert.ok(line, 'a .tool-progress line must appear above the streaming bubble inside the card');
  assert.match(line.textContent, /web_search: querying duckduckgo/);
  assert.equal(line.dataset.tier, 'searching', 'tier classification must match the main panel\'s regexes');

  lastPort.emit({ type: 'SUBCHAT_DONE', providerLabel: 'x' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!card.querySelector('.tool-progress'), 'progress line must clear once the turn finalizes');
  // closeBtn path: stops the 20s SW_PING interval so the test process can exit
  // (a still-open turnPort holds a live setInterval that keeps node --test alive).
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});

test('SUBCHAT_APPROVAL renders an approval card in the card; clicking a choice relays SUBCHAT_APPROVAL_RESPOND with subId', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'run it';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  lastPort.emit({ type: 'SUBCHAT_APPROVAL', data: { tool: 'execute_code', command: 'rm -rf /tmp/x', risk_level: 'high', choices: ['once', 'deny'] } });
  await new Promise((r) => setTimeout(r, 10));
  const ap = card.querySelector('.approval-card');
  assert.ok(ap, 'an approval card must render inside the detail-thread card');
  assert.match(ap.textContent, /execute_code/);

  ap.querySelector('[data-choice="once"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const sent = sentMessages.find(m => m.type === 'SUBCHAT_APPROVAL_RESPOND');
  assert.ok(sent, 'clicking a choice must send SUBCHAT_APPROVAL_RESPOND');
  assert.equal(sent.choice, 'once');
  assert.equal(sent.subId, ap.dataset.subId);
  assert.ok(!card.querySelector('.approval-card'), 'card must be removed after answering');
  // Turn never completes (the agent is waiting on the approval); close the
  // card to tear down the port + its SW_PING interval so the process can exit.
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});

test('SUBCHAT_CLARIFY renders a question card; submitting relays SUBCHAT_CLARIFY_RESPOND with subId', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'ask';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  lastPort.emit({ type: 'SUBCHAT_CLARIFY', data: { question: 'Which file do you mean?' } });
  await new Promise((r) => setTimeout(r, 10));
  const cl = card.querySelector('.clarify-card');
  assert.ok(cl, 'a clarify card must render inside the detail-thread card');
  assert.match(cl.textContent, /Which file do you mean\?/);

  cl.querySelector('.clarify-input').value = 'the config file';
  cl.querySelector('.clarify-submit').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const sent = sentMessages.find(m => m.type === 'SUBCHAT_CLARIFY_RESPOND');
  assert.ok(sent, 'submitting must send SUBCHAT_CLARIFY_RESPOND');
  assert.equal(sent.response, 'the config file');
  assert.ok(!card.querySelector('.clarify-card'), 'card must be removed after answering');
  // Same teardown rationale as the approval test above.
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});

test('DONE folds tool events into a tool-history details block and renders the token usage chip (main-panel parity)', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'go';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  lastPort.emit({ type: 'SUBCHAT_TOOL_PROGRESS', text: 'web_search: hermes agent github' });
  lastPort.emit({ type: 'SUBCHAT_TOOL_PROGRESS', text: 'web_search ✓' });
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'Answer text.' });
  lastPort.emit({ type: 'SUBCHAT_DONE', providerLabel: 'Hermes Agent', usage: { input_tokens: 8700, output_tokens: 596, total_tokens: 9296 } });
  await new Promise((r) => setTimeout(r, 30));

  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(!card.querySelector('.detail-thread-messages .tool-progress'), 'live progress line must be gone');
  const fold = card.querySelector('.detail-thread-messages .tool-history');
  assert.ok(fold, 'tool events must fold into a .tool-history details above the bubble');
  assert.match(fold.querySelector('summary').textContent, /2 steps/);
  assert.equal(fold.querySelectorAll('li').length, 2, 'each tool event becomes a list row');
  assert.match(fold.textContent, /web_search: hermes agent github/);

  const chip = card.querySelector('.detail-thread-messages .token-usage');
  assert.ok(chip, 'a token usage chip must render below the finalized bubble');
  assert.match(chip.textContent, /↑ 8\.7k/);
  assert.match(chip.textContent, /↓ 596/);

  // Next turn resets the accumulators — a DONE with neither usage nor tool
  // events must not leave a stale fold/chip behind.
  input.value = 'again';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  lastPort.emit({ type: 'SUBCHAT_DONE', providerLabel: 'Hermes Agent' });
  await new Promise((r) => setTimeout(r, 30));
  const folds = card.querySelectorAll('.detail-thread-messages .tool-history');
  assert.equal(folds.length, 1, 'exactly the first turn\'s fold remains — second turn must not stack an empty one');
  assert.equal(card.querySelectorAll('.detail-thread-messages .token-usage').length, 1, 'exactly the first turn\'s usage chip remains');
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});

test('reasoning deltas render as the main chat\'s live Thinking block and settle into a final collapsible think-block', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'think then answer';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  // llm-client inlines reasoning as <thinking>…</thinking> inside the delta
  // stream for every apiStyle — the card must route it to the live collapsible,
  // not smear it into the reply body.
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: '<thinking>pondering the question</thinking>' });
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'The answer is **42**.' });
  await new Promise((r) => setTimeout(r, 400)); // pacer startDelay 80ms + reveal ticks
  assert.ok(card.querySelector('.think-block.live-think'), 'a live Thinking collapsible must appear above the reply bubble');
  const liveAi = card.querySelector('.detail-thread-messages .msg.assistant');
  assert.doesNotMatch(liveAi.innerHTML, /pondering/, 'think content must not leak into the display bubble');

  lastPort.emit({ type: 'SUBCHAT_DONE' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!card.querySelector('.think-block.live-think'), 'live think block removed once the final render lands');
  assert.ok(card.querySelector('.detail-thread-messages .msg.assistant .think-block'), 'final render keeps a collapsible think-block');
  assert.match(liveAi.innerHTML, /<strong>42<\/strong>/);
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

test('the card input recalls its own sent questions with ↑, never main-composer sends', async () => {
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'recall me later';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(input.value, '', 'send clears the input');

  // A MAIN-composer send must never surface in the card: push straight into
  // the main scope (same composer-state module instance detail-thread uses —
  // a shared-list bug would make this the newest entry and win the first ↑).
  const { pushInputHistory } = await import('../lib/sidepanel/composer-state.js');
  pushInputHistory('MAIN-only question');

  // ↑ recalls the just-sent card question from the card's OWN scope.
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(input.value, 'recall me later', '↑ recalls the just-sent card question, not the main-composer send');

  // Typing disarms the walk and restores the pre-nav draft (nav started
  // from an empty input) — same job attachDraftPersistence does for the
  // main composer, minus draft persistence (the card is ephemeral).
  input.value = 'typed during recall';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(input.value, '');

  // ↓ with no active walk is left alone (normal caret movement).
  input.value = 'fresh text';
  const down = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  input.dispatchEvent(down);
  assert.equal(down.defaultPrevented, false, '↓ without an active walk must not be intercepted');
  assert.equal(input.value, 'fresh text');

  // Turn never completes — close the card to tear down the port + its
  // SW_PING interval so the test process can exit.
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});

test('the card recall list spans cards but stays separate from the main composer', async () => {
  sentMessages.length = 0;
  const bubbleA = makeAssistantBubble('Reply A.');
  openDetailThread(bubbleA, 'excerpt', bubbleA);
  const cardA = bubbleA.nextElementSibling;
  const inputA = cardA.querySelector('.detail-thread-input');
  inputA.value = 'question in card A';
  cardA.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  // A second card on a different anchor — both live at once and share the
  // card scope (cards are ephemeral; a per-card empty list would make ↑
  // useless in a freshly opened card).
  const bubbleB = makeAssistantBubble('Reply B.');
  openDetailThread(bubbleB, 'other excerpt', bubbleB);
  const cardB = bubbleB.nextElementSibling;
  const inputB = cardB.querySelector('.detail-thread-input');

  // ↑ in card B recalls card A's just-sent question — the card scope spans
  // cards, and a main-composer send (pushed here) must not displace it.
  const { pushInputHistory } = await import('../lib/sidepanel/composer-state.js');
  pushInputHistory('MAIN-only question');
  inputB.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(inputB.value, 'question in card A', 'first ↑ lands on the newest CARD send, skipping main-composer pushes');
  // Second ↑ walks back through earlier card-scope entries (this file's own
  // previous card sends).
  inputB.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.notEqual(inputB.value, 'question in card A', 'the second ↑ walks back through the card scope');
  assert.notEqual(inputB.value, 'MAIN-only question', 'main-composer sends never appear in the card walk');

  // Card A's ↑ starts its OWN fresh walk at the newest entry — the leaked
  // variant would resume card B's in-progress walk at the older entry.
  inputA.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(inputA.value, 'question in card A', 'a new input starts fresh at the newest, not at the other walk\'s position');

  // Card A's ↓ walks forward on its own (past the newest → restores card A's
  // pre-nav draft, empty after its send) while card B stays armed.
  inputA.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(inputA.value, '', "past-the-end restores card A's own pre-nav draft");

  // Both turns never complete — close both cards to tear down ports and
  // their SW_PING intervals so the test process can exit.
  cardA.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  cardB.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});

test('Enter confirming an IME candidate must NOT send the half-typed card question', async () => {
  // User report 2026-09-21: the card input was the one Enter-submits surface
  // with no IME guard — pressing Enter to confirm a Chinese-IME candidate
  // fired send() with the unfinished sentence.
  sentMessages.length = 0;
  const bubble = makeAssistantBubble('Reply.');
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');

  input.value = 'half-typed 中文';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sentMessages.filter(m => m.type === 'SUBCHAT').length, 0, 'isComposing Enter must not send');
  assert.equal(input.value, 'half-typed 中文', 'the draft stays in the input');

  // keyCode 229 belt-and-braces: same verdict when an IME driver reports
  // the process-key code instead of isComposing.
  input.value = 'half-typed again';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sentMessages.filter(m => m.type === 'SUBCHAT').length, 0, 'keyCode-229 Enter must not send either');

  // A plain Enter (no IME flags) still sends.
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sentMessages.some(m => m.type === 'SUBCHAT'), 'a plain Enter still sends');

  // Turn never completes — close the card to tear down the port + its
  // SW_PING interval so the test process can exit.
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
});
