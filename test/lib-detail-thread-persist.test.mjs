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
  captureDetailCardsIn, reinsertDetailCards,
} = await import('../lib/sidepanel/detail-thread.js');
const { flushDetailThreadStore, loadDetailThreads, saveDetailThread } = await import('../lib/sidepanel/detail-thread-store.js');

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

test('sidepanel wiring pins: renderHistory restores, destructive paths clear', async () => {
  const fs = await import('node:fs/promises');
  const sidepanel = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  assert.match(sidepanel, /restoreDetailThreads\(\)/, 'renderHistory must re-attach persisted cards');
  assert.match(sidepanel, /void clearDetailThreads\(\);/, 'new chat / clear history must drop the records');
  assert.match(sidepanel, /closeDetailThreadsIn: \(el\) => closeDetailThreadsIn\(el\)/,
    'multiselect deletion must close the cards of removed bubbles');
  assert.match(sidepanel, /captureDetailCardsIn\(el\)/,
    'every innerHTML rebuild must preserve nested cards');
  assert.match(sidepanel, /refreshDetailHighlights\(el\)/,
    'the final render must rebuild the quote highlight');

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
