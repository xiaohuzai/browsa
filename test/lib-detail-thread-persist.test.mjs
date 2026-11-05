// test/lib-detail-thread-persist.test.mjs — 追问卡跨侧栏关闭/重开的持久化与恢复。
//
// Chrome tears the side-panel document down when the panel is closed, so the
// card's state now lives in chrome.storage.session and is re-attached by
// restoreDetailThreads() after renderHistory() rebuilds the message list.
// This file simulates the teardown by wiping #messages and recreating the
// host bubble from the same raw text + hidx, exactly like renderHistory does.

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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.CSS ||= { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) };
// Custom Highlight API stand-in: the module registers one shared Highlight and
// adds/removes a Range per card. jsdom has neither CSS.highlights nor Highlight.
globalThis.CSS.escape ||= (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c);
globalThis.CSS.highlights ||= new Map();
globalThis.Highlight ||= class {
  constructor() { this.ranges = []; }
  add(range) { if (!this.ranges.includes(range)) this.ranges.push(range); }
  delete(range) { const i = this.ranges.indexOf(range); if (i >= 0) this.ranges.splice(i, 1); return i >= 0; }
  clear() { this.ranges.length = 0; }
};

const sentMessages = [];
function makeFakePort() {
  const port = {
    _listeners: [],
    onMessage: { addListener: (fn) => port._listeners.push(fn), removeListener: (fn) => { port._listeners = port._listeners.filter(l => l !== fn); } },
    onDisconnect: { addListener: () => {} },
    postMessage: (m) => {
      if (m.type === 'SUBCHAT_HELLO') {
        setTimeout(() => port._listeners.forEach(l => l({ type: 'SUBCHAT_HELLO_ACK' })), 0);
      }
    },
    disconnect: () => {},
    emit: (m) => port._listeners.forEach(l => l(m)),
  };
  return port;
}
let lastPort = null;

// Minimal chrome.storage.session area, shared by all records.
const sessionData = {};
const sessionArea = {
  async get(keys) {
    if (typeof keys === 'string') return { [keys]: sessionData[keys] };
    return { ...sessionData };
  },
  async set(obj) { Object.assign(sessionData, obj); },
  async remove(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionData[k];
  },
};

globalThis.chrome = {
  downloads: { download: async () => {} },
  storage: { session: sessionArea },
  runtime: {
    connect: () => { lastPort = makeFakePort(); return lastPort; },
    sendMessage: (msg, cb) => { sentMessages.push(msg); cb({ ok: true, data: { ok: true } }); },
    lastError: undefined,
  },
};

const {
  openDetailThread, restoreDetailThreads, clearDetailThreads, closeDetailThreadsIn, hideSelectionAskBtn,
  captureDetailCardsIn, reinsertDetailCards, moveSiblingDetailCards, toPersistedMessage,
} = await import('../lib/sidepanel/detail-thread.js');
const { flushDetailThreadStore, loadDetailThreads, saveDetailThread, deleteDetailThread } = await import('../lib/sidepanel/detail-thread-store.js');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const messagesEl = () => document.getElementById('messages');

function makeAssistantBubble(raw, hidx) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.dataset.raw = raw;
  if (hidx != null) el.dataset.hidx = String(hidx);
  el.textContent = raw;
  messagesEl().appendChild(el);
  return el;
}

function teardownPanel() {
  messagesEl().innerHTML = '';
}

async function reset() {
  await clearDetailThreads();
  await flushDetailThreadStore();
  teardownPanel();
  document.querySelectorAll('.detail-thread-card').forEach((c) => c.remove());
  sentMessages.length = 0;
}

async function finishTurn(card, { question, reply, providerLabel } = {}) {
  const input = card.querySelector('.detail-thread-input');
  input.value = question;
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: reply });
  lastPort.emit({ type: 'SUBCHAT_DONE', providerLabel });
  await tick(40); // finalize is async (renderSafe)
  await flushDetailThreadStore();
}

test('a card survives a panel teardown: question, reply and provider chip come back', async () => {
  await reset();
  const bubble = makeAssistantBubble('The full previous reply.', 7);
  openDetailThread(bubble, 'previous reply', bubble);
  const card = bubble.nextElementSibling;
  assert.ok(card, 'card inserted next to its host bubble');

  await finishTurn(card, {
    question: 'what does this mean?',
    reply: 'It means **this**.',
    providerLabel: 'Test Provider · model',
  });

  // Panel closed → document destroyed → panel reopened with the same history.
  teardownPanel();
  const bubble2 = makeAssistantBubble('The full previous reply.', 7);
  await restoreDetailThreads();

  const card2 = bubble2.nextElementSibling;
  assert.ok(card2?.classList.contains('detail-thread-card'), 'card must be restored');
  assert.match(card2.querySelector('.detail-thread-quote').textContent, /previous reply/);

  const msgs = [...card2.querySelectorAll('.detail-thread-messages .msg')];
  assert.equal(msgs.length, 2, 'user question + assistant reply must both be restored');
  assert.match(msgs[0].textContent, /what does this mean\?/);
  assert.match(msgs[1].textContent, /It means this\./);
  assert.ok(msgs[1].classList.contains('done'));
  assert.equal(msgs[1].querySelector('.msg-provider')?.textContent, 'Test Provider · model');

  card2.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('the anchor path is restored: a card opened on list item 2 comes back under item 2', async () => {
  await reset();
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  bubble.dataset.raw = 'list reply';
  bubble.dataset.hidx = '3';
  bubble.innerHTML = '<h2>Title</h2><ol><li>one</li><li>two <strong>bold</strong></li><li>three</li></ol>';
  messagesEl().appendChild(bubble);
  const li2 = bubble.querySelectorAll('li')[1];
  openDetailThread(bubble, 'two bold', li2);
  const card = li2.nextElementSibling;
  assert.ok(card?.classList.contains('detail-thread-card'));
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = document.createElement('div');
  bubble2.className = 'msg assistant';
  bubble2.dataset.raw = 'list reply';
  bubble2.dataset.hidx = '3';
  bubble2.innerHTML = '<h2>Title</h2><ol><li>one</li><li>two <strong>bold</strong></li><li>three</li></ol>';
  messagesEl().appendChild(bubble2);

  await restoreDetailThreads();
  const li2b = bubble2.querySelectorAll('li')[1];
  assert.ok(li2b.nextElementSibling?.classList.contains('detail-thread-card'),
    'restored card must sit after the original list item, not after the whole list');
  assert.equal(li2b.nextElementSibling.parentElement, bubble2.querySelector('ol'),
    'still nested at the original anchor inside the reply bubble');

  li2b.nextElementSibling.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('restore anchors by saved text when the rebuilt DOM has a different block structure', async () => {
  await reset();
  // The render a card was opened against: the <think> block is ONE <details>,
  // so the target paragraph is child #3.
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  bubble.dataset.raw = 'think reply';
  bubble.dataset.hidx = '8';
  bubble.innerHTML =
    '<details class="think-block"><summary>思考</summary><p>think a</p><p>think b</p></details>' +
    '<h2>Title</h2><p>first</p><p>target paragraph</p><p>last</p>';
  messagesEl().appendChild(bubble);
  const target = bubble.querySelectorAll(':scope > p')[1];
  openDetailThread(bubble, 'target paragraph', target, { start: 0, end: 16, text: 'target paragraph' });
  assert.ok(target.nextElementSibling?.classList.contains('detail-thread-card'));
  await flushDetailThreadStore();

  // The reopened panel first paints the SYNC render, where the think content
  // is TWO paragraphs — the saved path [3] now points at "first", and a
  // longer reply can push it past the end (the card used to land after the
  // whole reply, 2026-10-21 user report).
  teardownPanel();
  const bubble2 = document.createElement('div');
  bubble2.className = 'msg assistant';
  bubble2.dataset.raw = 'think reply';
  bubble2.dataset.hidx = '8';
  bubble2.innerHTML =
    '<p>think a</p><p>think b</p><h2>Title</h2><p>first</p><p>target paragraph</p><p>last</p>';
  messagesEl().appendChild(bubble2);

  await restoreDetailThreads();
  const card = messagesEl().querySelector('.detail-thread-card');
  assert.ok(card, 'card must be restored');
  assert.equal(card.parentElement, bubble2, 'card stays nested in its reply, not after the whole bubble');
  assert.equal(card.previousElementSibling?.textContent, 'target paragraph',
    'card must sit under the selected block, located by its saved text');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('a nested card survives an innerHTML upgrade whose block indices shift', async () => {
  await reset();
  const before = document.createElement('div');
  before.innerHTML =
    '<p>think a</p><p>think b</p><h2>Title</h2><p>first</p><p>target paragraph</p><p>last</p>';
  const card = document.createElement('div');
  card.className = 'detail-thread-card';
  before.querySelectorAll('p')[3].insertAdjacentElement('afterend', card); // "target paragraph"
  const captured = captureDetailCardsIn(before);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].text, 'target paragraph', 'the anchor text must be captured');

  // The upgrade collapses the think content into one <details>, shifting
  // every following block by one.
  const after = document.createElement('div');
  after.innerHTML =
    '<details class="think-block"><summary>思考</summary><p>think a</p><p>think b</p></details>' +
    '<h2>Title</h2><p>first</p><p>target paragraph</p><p>last</p>';
  reinsertDetailCards(after, captured);
  const target = [...after.children].find((e) => e.textContent === 'target paragraph');
  assert.equal(card.parentElement, after);
  assert.equal(card.previousElementSibling, target,
    'the card follows the original block, not the index the old DOM pointed at');
});

test('a card opened mid-stream still finds its finished reply (fingerprint drift)', async () => {
  await reset();
  // The record was written mid-stream: its fingerprint describes the partial
  // innerText. The finished reply starts with a think summary the partial
  // render never had, so neither hostHash nor hostPrefix can match.
  saveDetailThread({
    subId: 'sub-midstream', hidx: 9, hostHash: 'stale:0', hostPrefix: '思考过程（partial）',
    anchorPath: [], anchorText: '', quotedText: 'The answer',
    messages: [], wireMessages: [], draft: '', inFlight: false, streamingText: '',
    collapsed: false, height: null, videoSrc: '', updatedAt: Date.now(),
  });
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble('思考过程\n\nThe answer is now complete.', 9);
  await restoreDetailThreads();
  const card = messagesEl().querySelector('.detail-thread-card');
  assert.ok(card, 'card must attach to the reply at the same history index');
  assert.equal(card.previousElementSibling, bubble2,
    'card must sit right after its reply, not at the end of the conversation');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('closing the card deletes its persisted record (it must not come back)', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply.', 1);
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble('Reply.', 1);
  await restoreDetailThreads();
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0,
    'a closed card has no persisted record to restore');
  assert.ok(bubble2);
});

test('a turn interrupted by the panel closing is salvaged as a finished partial reply', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply.', 2);
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'explain';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'partial answer' });

  // The panel document is destroyed without a close click — pagehide is the
  // only chance to flush the in-flight state.
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble('Reply.', 2);
  const before = sentMessages.length;
  await restoreDetailThreads();

  const card2 = bubble2.nextElementSibling;
  assert.ok(card2?.classList.contains('detail-thread-card'));
  const assistant = card2.querySelector('.detail-thread-messages .msg.assistant');
  assert.ok(assistant, 'the partial streamed text must not be lost');
  assert.match(assistant.textContent, /partial answer/);
  assert.ok(assistant.classList.contains('done'));
  assert.ok(sentMessages.slice(before).some((m) => m.type === 'SUBCHAT_ABORT'),
    'the orphaned background run must be cancelled on restore');
  assert.equal(card2.querySelector('.detail-thread-input').disabled, false,
    'the restored card must accept a follow-up');

  card2.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('restoring twice does not duplicate cards', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply.', 4);
  openDetailThread(bubble, 'excerpt', bubble);
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble('Reply.', 4);
  await restoreDetailThreads();
  await restoreDetailThreads();
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 1);
  assert.ok(bubble2.nextElementSibling);

  bubble2.nextElementSibling.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('clearDetailThreads removes the cards and their stored records', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply.', 5);
  openDetailThread(bubble, 'excerpt', bubble);
  await flushDetailThreadStore();
  assert.ok(messagesEl().querySelector('.detail-thread-card'));

  await clearDetailThreads();
  await flushDetailThreadStore();
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0);

  teardownPanel();
  makeAssistantBubble('Reply.', 5);
  await restoreDetailThreads();
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0);
});

test('deleting the host bubble closes its card and deletes the record', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply.', 6);
  openDetailThread(bubble, 'excerpt', bubble);
  await flushDetailThreadStore();

  closeDetailThreadsIn(bubble); // message-delete path calls this before el.remove()
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0);
  await flushDetailThreadStore();

  teardownPanel();
  makeAssistantBubble('Reply.', 6);
  await restoreDetailThreads();
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0,
    'a card whose host reply was deleted must not resurrect');
});

test('deleting the host bubble closes cards even when DONE chrome sits between (usage chip / actions)', async () => {
  // A card opened MID-STREAM anchors right after the bubble; DONE then
  // inserts the token-usage chip / action row via afterend — between the
  // bubble and the card. closeDetailThreadsIn's contiguous-sibling walk
  // stopped at the chip and left the card + record alive (2026-11-05).
  await reset();
  const bubble = makeAssistantBubble('Reply with usage.', 7);
  openDetailThread(bubble, 'excerpt', bubble);
  await flushDetailThreadStore();
  // DONE-path chrome inserted between bubble and card:
  const chip = document.createElement('div');
  chip.className = 'token-usage';
  bubble.after(chip);
  const actions = document.createElement('div');
  actions.className = 'msg-action-row';
  chip.after(actions);
  assert.ok(messagesEl().querySelector('.detail-thread-card'), 'card exists before delete');

  closeDetailThreadsIn(bubble);
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0,
    'the card behind the chrome siblings must be closed too');
  await flushDetailThreadStore();

  teardownPanel();
  makeAssistantBubble('Reply with usage.', 7);
  await restoreDetailThreads();
  assert.equal(messagesEl().querySelectorAll('.detail-thread-card').length, 0,
    'the record must be gone — no floating card at the conversation end');
});

test('stop mid-turn then a late ERROR keeps the user/assistant alternation intact', async () => {
  // stopTurn nulls liveAiEl then awaits renderSafe(partial). An ERROR landing
  // in that window used to run fail(): liveAiEl null → no error shown, but the
  // trailing user turn was popped — stopTurn then pushed its assistant partial
  // with no user predecessor, and the NEXT send shipped assistant-first wire
  // (most APIs reject). fail() must no-op once stopTurn claimed the outcome.
  await reset();
  const bubble = makeAssistantBubble('Host reply.', 8);
  openDetailThread(bubble, 'excerpt', bubble);
  await flushDetailThreadStore();
  const card = messagesEl().querySelector('.detail-thread-card');
  const input = card.querySelector('.detail-thread-input');
  input.value = 'question one';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'partial answer' });
  await tick();

  // ■ stop, and DURING its async final render the port delivers ERROR.
  const stopBtn = card.querySelector('.detail-thread-send');
  stopBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  lastPort.emit({ type: 'SUBCHAT_ERROR', message: 'late failure' });
  await tick(60);
  await flushDetailThreadStore();

  // Follow up: the wire messages must still alternate user/assistant.
  sentMessages.length = 0;
  input.value = 'question two';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();
  const sub = sentMessages.find((m) => m.type === 'SUBCHAT');
  assert.ok(sub, 'follow-up sent');
  const roles = sub.messages.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) {
    assert.notEqual(roles[i], roles[i - 1], `wire must alternate, got ${roles.join(',')}`);
  }
  assert.equal(roles[roles.length - 1], 'user', 'the new question is the tail');
  assert.equal(roles.filter((r) => r === 'user').length, 2,
    'the stopped turn keeps its user+partial pair; the late ERROR must not pop it');
  // Teardown the in-flight follow-up so no SW_PING interval leaks.
  lastPort.emit({ type: 'SUBCHAT_DONE' });
  await tick(40);
});

test('the first streamed chunk is persisted immediately, not after a debounce window', async () => {
  // Chrome may tear the side panel down without firing pagehide; if the first
  // chunk only landed on a 1s debounce, closing right after sending lost the
  // whole partial reply (real-browser report: "card opens but content is gone").
  await reset();
  const bubble = makeAssistantBubble('Reply.', 8);
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const input = card.querySelector('.detail-thread-input');
  input.value = 'quick question';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'partial before close' });
  await flushDetailThreadStore();

  const records = await loadDetailThreads();
  const rec = records.find((r) => r.subId === card.dataset.subId);
  assert.ok(rec, 'the card must have a persisted record');
  assert.equal(rec.streamingText, 'partial before close',
    'the first chunk must be on disk without waiting for the 400ms throttle');
  assert.equal(rec.inFlight, true);

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('the fold button collapses the card and the state survives a panel teardown', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply for the fold button.', 9);
  openDetailThread(bubble, 'excerpt', bubble);
  const card = bubble.nextElementSibling;
  const fold = card.querySelector('.detail-thread-fold');
  assert.ok(fold, 'the card must expose a fold control');
  assert.equal(card.classList.contains('collapsed'), false);
  assert.equal(fold.getAttribute('aria-expanded'), 'true');

  fold.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(card.classList.contains('collapsed'), true);
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble('Reply for the fold button.', 9);
  await restoreDetailThreads();
  const card2 = bubble2.nextElementSibling;
  assert.ok(card2.classList.contains('collapsed'), 'the folded state must be restored');
  assert.equal(card2.querySelector('.detail-thread-fold').getAttribute('aria-expanded'), 'false');

  // Expanding again works and is persisted too.
  card2.querySelector('.detail-thread-fold').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(card2.classList.contains('collapsed'), false);
  await flushDetailThreadStore();
  const rec = (await loadDetailThreads()).find((r) => r.subId === card2.dataset.subId);
  assert.equal(rec.collapsed, false);

  card2.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('the selected passage stays highlighted in the host reply after a panel teardown', async () => {
  await reset();
  const text = 'Alpha bravo charlie delta.';
  const bubble = makeAssistantBubble(text, 10);
  openDetailThread(bubble, 'bravo charlie', bubble, { start: 6, end: 19 });
  const highlight = CSS.highlights.get('detail-thread-quote');
  assert.ok(highlight, 'the module must register a CSS highlight');
  assert.equal(highlight.ranges.length, 1);
  assert.equal(highlight.ranges[0].toString(), 'bravo charlie');
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble(text, 10);
  // Rendered chrome (provider chip, timestamps) can shift the rendered text
  // between the live bubble and the rebuilt one; the stored offsets then land
  // on the wrong passage and the quote-text fallback must win.
  bubble2.textContent = 'Test ' + text;
  await restoreDetailThreads();
  assert.equal(highlight.ranges.length, 1, 'exactly one range is restored');
  assert.equal(highlight.ranges[0].toString(), 'bravo charlie',
    'the highlight must cover the same passage even when chrome shifts the offsets');

  // Closing the card removes its highlight.
  bubble2.nextElementSibling.querySelector('.detail-thread-close')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
  assert.equal(highlight.ranges.length, 0);
});

test('reopening the panel auto-folds restored cards, while a same-document re-render keeps their state', async () => {
  await reset();
  const bubble = makeAssistantBubble('Reply for auto fold.', 11);
  openDetailThread(bubble, 'excerpt', bubble);
  assert.equal(bubble.nextElementSibling.classList.contains('collapsed'), false);
  await flushDetailThreadStore();
  const rec = (await loadDetailThreads())[0];

  // renderHistory while the panel is alive: the live card exists, so the
  // restore must keep the user's expanded state.
  teardownPanel();
  const bubbleSame = makeAssistantBubble('Reply for auto fold.', 11);
  await restoreDetailThreads();
  assert.equal(bubbleSame.nextElementSibling.classList.contains('collapsed'), false,
    'a same-document restore keeps the expanded state');

  // Fresh panel document: no live cards, storage still holds the record.
  await clearDetailThreads();
  await saveDetailThread(rec);
  teardownPanel();
  const bubble2 = makeAssistantBubble('Reply for auto fold.', 11);
  await restoreDetailThreads();
  const card2 = bubble2.nextElementSibling;
  assert.ok(card2.classList.contains('collapsed'), 'reopening the panel auto-folds the card');
  assert.equal(card2.querySelector('.detail-thread-fold').getAttribute('aria-expanded'), 'false');
  assert.ok(card2.querySelector('.detail-thread-quote'), 'the quote stays visible when folded');

  card2.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('the ask button always uses the CURRENT selection, not the first one', async () => {
  // Regression: the button element is created once and a closure over the
  // first selection used to anchor/highlight the FIRST passage on every later
  // use — the newly selected text got no highlight (user-reported).
  await reset();
  hideSelectionAskBtn();
  dom.window.getSelection()?.removeAllRanges();
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30,
  });

  const first = makeAssistantBubble('Alpha bravo charlie.', 12);
  const second = makeAssistantBubble('Delta echo foxtrot.', 13);
  const select = async (bubble, from, to) => {
    const range = document.createRange();
    range.setStart(bubble.firstChild, from);
    range.setEnd(bubble.firstChild, to);
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    messagesEl().dispatchEvent(new dom.window.Event('mouseup', { bubbles: true }));
    await tick();
    return sel.toString();
  };

  await select(first, 0, 5); // "Alpha"
  const btn = document.querySelector('.selection-ask-btn');
  assert.ok(btn, 'the ask button appears after the first selection');

  await select(second, 6, 10); // "echo"
  btn.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  const card = second.nextElementSibling;
  assert.ok(card?.classList.contains('detail-thread-card'), 'the card opens on the CURRENT bubble');
  assert.equal(first.nextElementSibling, second, 'no card was attached to the stale first bubble');
  assert.match(card.querySelector('.detail-thread-quote').textContent, /echo/,
    'the card quotes the current selection');
  const highlight = CSS.highlights.get('detail-thread-quote');
  assert.equal(highlight?.ranges?.length, 1);
  assert.equal(highlight.ranges[0].toString(), 'echo',
    'the highlight covers the CURRENT selection, not the first one');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('a selection containing a formula keeps its highlight (rendered text fingerprint)', async () => {
  // Regression (2026-10-21): a selection with inline KaTeX has two different
  // texts — the quote the card/model gets (LaTeX source) and what the bubble
  // actually renders (MathML + HTML copies, duplicated glyphs). Validating the
  // offsets against the QUOTE text rejected the correct range, so the reply
  // highlight silently disappeared. The record now carries the rendered text.
  await reset();
  const rendered = 'Math like x=2x=2 is inline.';
  const quoted = 'Math like $x=2$ is inline.';
  const bubble = makeAssistantBubble(rendered, 15);
  openDetailThread(bubble, quoted, bubble, { start: 0, end: rendered.length, text: rendered });
  const highlight = CSS.highlights.get('detail-thread-quote');
  assert.equal(highlight?.ranges?.length, 1, 'the range must survive quote/render divergence');
  assert.equal(highlight.ranges[0].toString(), rendered);

  // The rendered fingerprint is persisted and still wins after a teardown.
  await flushDetailThreadStore();
  const rec = (await loadDetailThreads())[0];
  assert.equal(rec.highlightRange.text, rendered, 'the rendered text must be stored');

  teardownPanel();
  const bubble2 = makeAssistantBubble(rendered, 15);
  await restoreDetailThreads();
  assert.equal(highlight.ranges.length, 1, 'exactly one range after restore');
  assert.equal(highlight.ranges[0].toString(), rendered);

  bubble2.nextElementSibling.querySelector('.detail-thread-close')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('closing a card during DONE finalization must not resurrect its record', async () => {
  // Regression (2026-10-21 release audit, reproduced in real Chromium):
  // finalize() awaits the final render, then persistNow() in its finally. If
  // the user clicks X in that window, the queued save landed AFTER
  // deleteDetailThread and re-created the closed card (and could leak it into
  // a newly switched conversation). closeCard sets a sticky `closed` flag that
  // snapshot/persistNow/persistSoon honor.
  await reset();
  const bubble = makeAssistantBubble('A host reply for the close race.', 21);
  openDetailThread(bubble, 'A host reply', bubble);
  const card = bubble.nextElementSibling;
  card.querySelector('.detail-thread-input').value = 'quick question';
  card.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();
  lastPort.emit({ type: 'SUBCHAT_CHUNK', delta: 'partial answer' });
  lastPort.emit({ type: 'SUBCHAT_DONE', providerLabel: 'T' });
  // Same tick as DONE: finalize has started and is parked on its async render.
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick(80);
  await flushDetailThreadStore();
  assert.equal(document.querySelector('.detail-thread-card'), null, 'card must stay removed');
  assert.equal((await loadDetailThreads()).length, 0, 'the closed card must not write its record back');
});

test('a card closed during an async re-render is not re-inserted as a zombie', async () => {
  // The DONE/ABORTED handlers capture nested cards, await the final render,
  // then reinsert. If X is clicked during that await, reinserting the captured
  // node would put a card with no persisted record back on screen.
  await reset();
  const bubble = makeAssistantBubble('host reply body', 40);
  const p = document.createElement('p');
  p.textContent = 'target paragraph';
  bubble.appendChild(p);
  openDetailThread(bubble, 'target paragraph', p);
  const card = p.nextElementSibling;
  assert.equal(card?.parentElement, bubble, 'card is nested for the capture');

  const captured = captureDetailCardsIn(bubble);
  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  bubble.innerHTML = '<p>target paragraph</p>';
  reinsertDetailCards(bubble, captured);
  assert.equal(card.isConnected, false, 'the closed card must stay detached');
  assert.equal(bubble.querySelectorAll('.detail-thread-card').length, 0);
  await flushDetailThreadStore();
});

test('a card opened mid-stream restores onto the finished reply even without hidx', async () => {
  // Regression (2026-10-21 release audit): hidx is stamped only at DONE. A
  // card opened while the main reply was still streaming persisted hidx:null
  // plus the partial fingerprint; after the reply finished, findHostBubble
  // skipped every prefix/text fallback (they lived inside `hidx !== null`), so
  // the restored card was appended at the very end of the conversation.
  await reset();
  const partial = 'Streaming answer first part with enough text to fingerprint.';
  const bubble = makeAssistantBubble(partial, null);
  openDetailThread(bubble, 'the selected passage', bubble);
  await flushDetailThreadStore();
  assert.equal((await loadDetailThreads())[0].hidx, null, 'mid-stream records have no hidx');

  teardownPanel();
  const finished = makeAssistantBubble(
    partial + ' Then the finished reply continues and contains the selected passage here.', 9);
  await restoreDetailThreads();
  const card = document.querySelector('.detail-thread-card');
  assert.ok(card, 'card must be restored');
  assert.equal(card.previousElementSibling, finished,
    'the card must follow its finished host, not the last message in the list');
});

test('an orphaned card is never re-parented into an unrelated reply', async () => {
  // Regression (2026-10-21 release audit): a record whose host was trimmed is
  // appended at the end of the message list. The next bubble's full-render
  // upgrade runs moveSiblingDetailCards on its siblings; a stale path could
  // resolve inside that unrelated bubble and swallow the orphan.
  await reset();
  const hostA = makeAssistantBubble('Host A text with the selected passage.', 31);
  openDetailThread(hostA, 'selected passage', hostA);
  const card = hostA.nextElementSibling;
  assert.ok(card?.classList.contains('detail-thread-card'));

  // Orphan the card at the end, after an unrelated bubble whose DOM has a
  // child the stale path would match.
  const hostB = makeAssistantBubble('Unrelated reply body.', 32);
  hostB.innerHTML = '<p>Unrelated paragraph</p>';
  messagesEl().appendChild(card);
  card.dataset.anchorPath = '[0]';
  card.dataset.anchorText = 'Unrelated paragraph';

  moveSiblingDetailCards(hostB);
  assert.equal(card.parentElement, messagesEl(),
    'the orphan must stay at the message-list level');
  assert.equal(card.previousElementSibling, hostB,
    'the orphan must not be re-parented into the unrelated bubble');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('asking again on a folded card expands it instead of focusing a hidden input', async () => {
  await reset();
  const bubble = makeAssistantBubble('A reply with a quoted passage.', 33);
  openDetailThread(bubble, 'quoted passage', bubble);
  const card = bubble.nextElementSibling;
  card.querySelector('.detail-thread-fold').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.ok(card.classList.contains('collapsed'), 'card starts folded');

  openDetailThread(bubble, 'quoted passage again', bubble);
  assert.equal(document.querySelectorAll('.detail-thread-card').length, 1,
    'the same anchor reuses the card');
  assert.equal(card.classList.contains('collapsed'), false,
    're-asking must expand the card so the input row is visible');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('cross-document writes serialize through the Web Locks API when available', async () => {
  // Two side-panel documents (two Chrome windows) each have their own module
  // queue; without a cross-document lock the read-modify-write on the shared
  // session key can drop one card's update.
  await reset();
  const names = [];
  const prevLocks = navigator.locks;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (name, fn) => { names.push(name); return fn(); } },
  });
  try {
    await saveDetailThread({ subId: 'lock-test', updatedAt: Date.now(), messages: [], wireMessages: [] });
    await flushDetailThreadStore();
  } finally {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: prevLocks });
  }
  assert.ok(names.includes('browsa.detailThreads.v1'), 'the shared store key is the lock name');
  await deleteDetailThread('lock-test');
  await flushDetailThreadStore();
});

test('sidepanel wiring pins: renderHistory restores, destructive paths clear', async () => {
  const fs = await import('node:fs/promises');
  const sidepanel = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  assert.match(sidepanel, /restoreDetailThreads\(\)/, 'renderHistory must re-attach persisted cards');
  assert.match(sidepanel, /void clearDetailThreads\(\);/, 'new chat / clear history must drop the records');
  assert.match(sidepanel, /closeDetailThreadsIn: \(el\) => closeDetailThreadsIn\(el\)/,
    'multiselect deletion must close the cards of removed bubbles');
  // 气泡替换事务的顺序不变量改由下方 swapBubbleContent 行为测试钉住（源码正则
  // 只能证明「某处存在 capture…reinsert」，钉不住第 8 处缺失——2026-11-03 审计）；
  // 各调用点经事务的接线由 lib-sidepanel-streaming / resume-streaming 执行测试钉住。
  assert.match(sidepanel, /swapBubbleContent/,
    'bubble-content replacement must go through the detail-thread transaction');

  const css = await fs.readFile(new URL('../sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /::highlight\(detail-thread-quote\)/,
    'the quote highlight must be painted by CSS');
  assert.match(css, /\.detail-thread-card\.collapsed/,
    'the folded card must hide its body');

  const sessions = await fs.readFile(new URL('../lib/sidepanel/sessions-ui.js', import.meta.url), 'utf8');
  assert.match(sessions, /_deps\.clearDetailThreads\?\.\(\)/,
    'loading another saved conversation must drop the previous conversation’s cards');

  const multiselect = await fs.readFile(new URL('../lib/sidepanel/multiselect.js', import.meta.url), 'utf8');
  assert.match(multiselect, /_deps\.closeDetailThreadsIn\?\.\(el\)/);
});

// ─── 引用图片的持久化与恢复（2026-10-23）────────────────────────────────────
// 引用图是选区快照的一部分：重开侧栏后缩略图与「首轮随附」都要能复原，
// 但受 storage.session 配额约束（超预算的图跳过，不写爆整个 key）。

test('引用图片随卡片持久化，重开侧栏后缩略条恢复', async () => {
  await reset();
  const img = 'data:image/png;base64,QUJD';
  const bubble = makeAssistantBubble('A reply with a figure.', 41);
  openDetailThread(bubble, 'a figure', bubble, null, [img]);
  const card = bubble.nextElementSibling;
  assert.equal(card.querySelectorAll('.detail-thread-quote-imgs img').length, 1);
  await flushDetailThreadStore();

  const rec = (await loadDetailThreads())[0];
  assert.deepEqual(rec.quotedImages, [img], '引用图必须进持久化记录');

  teardownPanel();
  const bubble2 = makeAssistantBubble('A reply with a figure.', 41);
  await restoreDetailThreads();
  const restored = bubble2.nextElementSibling;
  const thumbs = restored.querySelectorAll('.detail-thread-quote-imgs img');
  assert.equal(thumbs.length, 1, '重开后引用图缩略图恢复');
  assert.equal(thumbs[0].getAttribute('src'), img);

  restored.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('引用图片持久化受配额约束：http(s) 保留、超大 data URL 跳过且不丢其余字段', async () => {
  await reset();
  const small = 'https://cdn.example.com/a.png';
  // 单张超过 1.5M 字符预算（≈1.1MB 二进制），必须被跳过而不是整体写入失败。
  const huge = 'data:image/png;base64,' + 'A'.repeat(1_600_000);
  const bubble = makeAssistantBubble('Reply text here.', 42);
  openDetailThread(bubble, 'quote', bubble, null, [small, huge]);
  const card = bubble.nextElementSibling;
  // 活卡片仍展示两张（内存里不受持久化预算影响）。
  assert.equal(card.querySelectorAll('.detail-thread-quote-imgs img').length, 2);
  await flushDetailThreadStore();

  const rec = (await loadDetailThreads())[0];
  assert.deepEqual(rec.quotedImages, [small], '超预算的那张跳过，便宜的 URL 保留');
  assert.equal(rec.quotedText, 'quote', '其余字段不受影响');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('恢复后的卡片：首轮仍然随附引用图（重开后追问不丢图）', async () => {
  await reset();
  const img = 'https://cdn.example.com/restored.png';
  const bubble = makeAssistantBubble('Reply about a picture.', 43);
  openDetailThread(bubble, 'a picture', bubble, null, [img]);
  await flushDetailThreadStore();

  teardownPanel();
  const bubble2 = makeAssistantBubble('Reply about a picture.', 43);
  await restoreDetailThreads();
  const restored = bubble2.nextElementSibling;
  assert.ok(restored?.classList.contains('detail-thread-card'));

  restored.querySelector('.detail-thread-fold')?.classList.contains('collapsed')
    && restored.querySelector('.detail-thread-fold').click();
  const input = restored.querySelector('.detail-thread-input');
  input.value = 'what is in it?';
  restored.querySelector('.detail-thread-send').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await tick();

  const sub = sentMessages.find((m) => m.type === 'SUBCHAT');
  assert.ok(sub, 'restored card must still send SUBCHAT');
  assert.deepEqual(sub.images, [img], '恢复出的卡片首轮同样随附引用图');

  restored.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

// ─── 气泡替换事务（2026-11-03 审计 panel-1 结构修）─────────────────────────────
// capture→swap→reinsert→(move)→(decorate)→(refresh) 的顺序此前在 sidepanel.js
// 8 处手写并已漂移（cancelStream 漏 refresh）。顺序不变量改钉在事务函数的
// 行为上；各调用点的接线由 lib-sidepanel-streaming / resume-streaming 执行测试钉。

function makeParagraphBubble(raw, hidx) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.dataset.raw = raw;
  if (hidx != null) el.dataset.hidx = String(hidx);
  el.innerHTML = `<p>${raw}</p>`;
  messagesEl().appendChild(el);
  return el;
}

test('swapBubbleContent: nested card survives the swap, decorate runs after reinsert, highlight rebuilt', async () => {
  await reset();
  const { swapBubbleContent } = await import('../lib/sidepanel/detail-thread.js');
  const bubble = makeParagraphBubble('First paragraph here.', 60);
  openDetailThread(bubble, 'First paragraph', bubble.querySelector('p'), { start: 0, end: 5, text: 'First' });
  const card = bubble.querySelector('.detail-thread-card');
  assert.ok(card, 'sanity: card nested in the bubble');
  const h = CSS.highlights.get('detail-thread-quote');
  assert.equal(h.ranges.length, 1, 'sanity: creation painted the quote highlight');

  const order = [];
  await swapBubbleContent(bubble, () => {
    order.push('swap');
    bubble.innerHTML = '<p>First paragraph here. Extended.</p>';
  }, { decorate: () => order.push(bubble.contains(card) ? 'decorate:card-in' : 'decorate:card-out') });

  assert.deepEqual(order, ['swap', 'decorate:card-in'],
    'reinsert 必须先于注入的 decorate 回调（finishBubble 等装饰看到的就是完整气泡）');
  assert.ok(bubble.contains(card), '嵌套卡必须活过 innerHTML 替换');
  assert.equal(h.ranges.length, 1);
  assert.ok(h.ranges[0].startContainer.isConnected, '高亮 Range 必须重建在新文本节点上');
  assert.equal(h.ranges[0].toString(), 'First');

  card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

test('swapBubbleContent: closed card stays dead, refresh:false skips rehighlight, throwing swap still reinserts', async () => {
  await reset();
  const { swapBubbleContent } = await import('../lib/sidepanel/detail-thread.js');

  // (a) closed-card 守卫原样复用：swap 中途关掉的卡不得复活。
  const bubble = makeParagraphBubble('Alpha beta gamma.', 61);
  openDetailThread(bubble, 'Alpha', bubble.querySelector('p'), { start: 0, end: 5, text: 'Alpha' });
  const card = bubble.querySelector('.detail-thread-card');
  await swapBubbleContent(bubble, () => {
    card.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    bubble.innerHTML = '<p>Alpha beta gamma, replaced.</p>';
  });
  assert.equal(bubble.querySelector('.detail-thread-card'), null,
    '异步渲染期间关闭的卡不得被 reinsert 复活成僵尸');
  await flushDetailThreadStore();

  // (b) refresh:false（RETRY 清空点的刻意语义）：旧 Range 脱挂但不动它，
  // DONE 会重建。
  const bubble2 = makeParagraphBubble('Alpha beta gamma.', 62);
  openDetailThread(bubble2, 'Alpha', bubble2.querySelector('p'), { start: 0, end: 5, text: 'Alpha' });
  const card2 = bubble2.querySelector('.detail-thread-card');
  const h = CSS.highlights.get('detail-thread-quote');
  const stale = h.ranges[h.ranges.length - 1];
  await swapBubbleContent(bubble2, () => { bubble2.innerHTML = '<p>Alpha beta gamma, longer.</p>'; }, { refresh: false });
  assert.ok(bubble2.contains(card2), '卡照常回位');
  // jsdom/浏览器的 Range 会随 DOM 移除活体变异：旧 Range 被折叠成空（高亮
  // 就此消失），不一定脱挂——断言「失效」而非「脱挂」。
  assert.ok(stale.collapsed || !stale.startContainer.isConnected, 'swap 必须已使旧 Range 失效');
  assert.ok(h.ranges.includes(stale), 'refresh:false 不得重建高亮（旧文本已不存在，DONE 重建）');
  card2.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();

  // (c) swap 抛错：finally 仍把卡放回气泡（卡不能丢进稀薄空气）。
  const bubble3 = makeParagraphBubble('Alpha beta gamma.', 63);
  openDetailThread(bubble3, 'Alpha', bubble3.querySelector('p'));
  const card3 = bubble3.querySelector('.detail-thread-card');
  await assert.rejects(swapBubbleContent(bubble3, () => {
    bubble3.innerHTML = '<p>Alpha beta gamma.</p>';
    throw new Error('swap boom');
  }), /swap boom/);
  assert.ok(bubble3.contains(card3), 'swap 抛错后嵌套卡仍须留在气泡里');
  card3.querySelector('.detail-thread-close').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushDetailThreadStore();
});

// --------------- persisted message shape (one builder for write + snapshot) ----

test('toPersistedMessage: the field set restoreDetailThreads reads back', () => {
  // The write side (finalize/fail) and the snapshot side both build records; before
  // the builder existed a field added to only one of them vanished on reload with
  // nothing failing. Pin the contract as data, not as "the two copies agree".
  assert.deepEqual(toPersistedMessage({ role: 'user', content: 'q' }), { role: 'user', content: 'q' },
    'a plain message keeps only role+content (no empty optional keys)');
  assert.deepEqual(
    toPersistedMessage({
      role: 'assistant', content: 'a', providerLabel: 'P', usage: { input_tokens: 1 },
      usageScope: 'turn', durationMs: 42,
    }),
    { role: 'assistant', content: 'a', providerLabel: 'P', usage: { input_tokens: 1 }, usageScope: 'turn', durationMs: 42 },
    'every optional field the restore path reads must survive the builder',
  );
  assert.deepEqual(toPersistedMessage({ role: 'assistant', content: 'boom', error: true }),
    { role: 'assistant', content: 'boom', error: true }, 'the failure flag is part of the contract');
  assert.deepEqual(
    toPersistedMessage({ role: 'assistant', content: 'a', providerLabel: '', usage: null, usageScope: '', durationMs: 0 }),
    { role: 'assistant', content: 'a' },
    'falsy optional values are omitted (no empty chips after reload)',
  );
});

