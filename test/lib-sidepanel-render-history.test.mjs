// test/lib-sidepanel-render-history.test.mjs — execution test for
// renderHistory() with a REAL non-empty history containing assistant
// messages (markdown, tables, code fences).
//
// Regression this exists to catch: renderHistory() was rewritten (two-pass
// render — sync renderStreamingSafe() first so the panel shows something
// immediately, then renderSafe() upgrades in parallel) but the new
// renderStreamingSafe() call site was never added to sidepanel.js's import
// list from lib/sidepanel/render.js. Every OTHER sidepanel.js execution test
// file mocks chrome.storage.local.get('history') to return `{}` (empty), so
// the assistant-message branch inside renderHistory()'s loop — the only
// place that referenced the missing import — never actually executed in any
// test, and the bare `ReferenceError: renderStreamingSafe is not defined`
// went undetected by node --check (syntax-only) and by every existing test.
//
// The failure mode was severe: renderHistory() is awaited directly inside
// init(), with no try/catch around the call. The thrown ReferenceError
// aborted init() entirely — every event listener wired AFTER the
// `await renderHistory()` line (send button, attach button, keyboard
// shortcuts, session drawer, everything) was never registered. Symptom
// reported by a real user: after reopening the side panel, only their own
// latest question was visible (previous assistant replies gone — actually
// never rendered because the loop threw partway through), AND every button
// in the UI appeared completely dead.
//
// This test seeds a realistic multi-turn history (user/assistant pairs,
// including markdown a real reply would contain — a table and a fenced
// code block) so the assistant-message branch of renderHistory() actually
// runs, and asserts both that all messages render AND that init() completed
// far enough to wire up the send button.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { makeSidepanelChromeMock, wireSendMessage } from './helpers/chrome-mock.mjs';

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

const FAKE_HISTORY = [
  { role: 'user', content: 'Q1: what is flow matching?' },
  {
    role: 'assistant',
    content: '## Flow Matching\n\nA generative modeling technique.\n\n| Method | Score |\n|---|---|\n| FM | 0.9 |\n\n```python\nx = 1\n```',
  },
  { role: 'user', content: 'Q2: how does it compare to diffusion?' },
  { role: 'assistant', content: 'Flow matching is generally **faster** than diffusion models.' },
];

let lastChatPort = null;

globalThis.chrome = makeSidepanelChromeMock({
  onConnect: (name, port) => { if (name === 'browsa-chat') lastChatPort = port; },
  sendMessage: wireSendMessage((msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    return { ok: true };
  }),
});
// makeSidepanelChromeMock's storage.local.get always resolves {} — override
// with one that returns the seeded history for the 'history' key specifically,
// matching real chrome.storage.local.get(key) semantics.
globalThis.chrome.storage.local.get = async (key) =>
  key === 'history' ? { history: FAKE_HISTORY } : {};

await import('../sidepanel.js');
// renderHistory()'s second pass (parallel renderSafe() upgrades, which go
// through the real KaTeX-threshold/worker-client machinery) needs more than
// the usual 100ms settle time other sidepanel test files use.
await new Promise((r) => setTimeout(r, 500));

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');

test('renderHistory(): all seeded user/assistant messages actually render (regression: a missing renderStreamingSafe import threw inside the assistant branch, silently dropping every message from that point on)', () => {
  const userMsgs = messagesEl.querySelectorAll('.msg.user');
  const assistantMsgs = messagesEl.querySelectorAll('.msg.assistant');
  assert.equal(userMsgs.length, 2, 'both user turns must render');
  assert.equal(assistantMsgs.length, 2, 'both assistant turns must render');
});

test('renderHistory(): markdown in assistant replies (tables, code fences) is actually rendered to HTML, not left as an empty/broken bubble', () => {
  const assistantMsgs = [...messagesEl.querySelectorAll('.msg.assistant')];
  const withTable = assistantMsgs.find((el) => el.innerHTML.includes('<table>'));
  assert.ok(withTable, 'the reply containing a markdown table must render a real <table>');
  assert.ok(assistantMsgs.some((el) => el.textContent.includes('faster')),
    'the second assistant reply\'s text must be present');
});

test('renderHistory(): assistant bubbles still have their .msg-actions (copy/reply/fold buttons) after the background renderSafe() upgrade finishes (regression: addMsgActions appends .msg-actions as a CHILD of the bubble during the sync pass; the background upgrade then does `el.innerHTML = html`, which silently wiped that child out once the upgrade resolved — buttons were visible right after the fast paint and then vanished a moment later)', () => {
  const assistantMsgs = [...messagesEl.querySelectorAll('.msg.assistant')];
  assert.equal(assistantMsgs.length, 2, 'sanity check: both assistant turns present');
  for (const el of assistantMsgs) {
    assert.ok(el.querySelector('.msg-actions'), 'each assistant bubble must still have its .msg-actions row after the async upgrade replaced innerHTML');
    assert.ok(el.querySelector('.msg-actions button'), 'the actions row must contain actual buttons, not just an empty wrapper');
  }
});

test('init() ran to completion past renderHistory() — the send button is wired and a click actually starts onSend()', async () => {
  // This is the real regression signal: if renderHistory() throws, every
  // addEventListener call after `await renderHistory()` in init() (send
  // button, attach button, etc.) never runs, and clicking does nothing.
  assert.equal(inputEl.disabled, false, 'the composer must be enabled (init() reached that point)');

  inputEl.value = 'a new question';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(lastChatPort, 'clicking Send must have actually invoked onSend() and opened a browsa-chat port — proves the click listener was registered');

  // Emit DONE to clear onSend()'s internal SW-keepalive setInterval so the
  // test process can exit cleanly — same pattern as lib-sidepanel-status-dot.
  // Without this the 20s interval keeps the Node process alive and the test
  // times out. See the same pattern in lib-sidepanel-status-dot.test.mjs.
  lastChatPort.emit({ type: 'DONE', full: 'reply text' });
  await new Promise((r) => setTimeout(r, 30));
});
