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
    providerLabel: '方舟 Coding · glm-5.3-flash',
    providerKey: { name: 'llm-1', model: 'glm-5.3-flash' },
  },
  { role: 'user', content: 'Q2: how does it compare to diffusion?' },
  {
    role: 'assistant',
    content: 'Flow matching is generally **faster** than diffusion models.',
    providerLabel: '方舟 Coding · glm-5.3-flash',
    providerKey: { name: 'llm-1', model: 'glm-5.3-flash' },
  },
  {
    role: 'assistant', content: '', interrupted: true,
    providerLabel: '方舟 Coding · glm-5.3-flash',
    providerKey: { name: 'llm-1', model: 'glm-5.3-flash' },
    steps: [{ k: 'tool', name: 'read', target: 'src/app.ts' },
      { k: 'tool', name: 'test', target: 'npm test', ok: false }],
  },
  { role: 'user', content: 'Q3: what happened?' },
];

let lastChatPort = null;
const ORIGIN_HISTORY = FAKE_HISTORY;
const OTHER_HISTORY = [{ role: 'user', content: 'other conversation' }];
let currentHistory = ORIGIN_HISTORY;

globalThis.chrome = makeSidepanelChromeMock({
  onConnect: (name, port) => { if (name === 'browsa-chat') lastChatPort = port; },
  sendMessage: wireSendMessage((msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    if (msg.type === 'REMOVE_HISTORY_ENTRY_BY_INDEX') {
      currentHistory = currentHistory.filter((_, i) => i !== msg.index);
      return { ok: true, data: { ok: true } };
    }
    if (msg.type === 'TRUNCATE_HISTORY_FROM_INDEX') {
      currentHistory = currentHistory.slice(0, msg.index);
      return { ok: true, data: { ok: true } };
    }
    if (msg.type === 'LOAD_SESSION') {
      currentHistory = msg.id === 'other' ? OTHER_HISTORY : ORIGIN_HISTORY;
      return { ok: true, data: { ok: true } };
    }
    if (msg.type === 'CHAT') {
      currentHistory = [...currentHistory, { role: 'user', content: msg.userText }];
    }
    return { ok: true };
  }),
});
// Seed the 'history' key while keeping the mock's functional store for the
// send preflight's historyGeneration mint (other keys fall through to it).
const baseLocalGet = globalThis.chrome.storage.local.get.bind(globalThis.chrome.storage.local);
globalThis.chrome.storage.local.get = async (key) =>
  key === 'history' ? { history: currentHistory } : baseLocalGet(key);

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
  assert.equal(userMsgs.length, 3, 'all user turns must render');
  assert.equal(assistantMsgs.length, 3, 'all assistant turns must render');
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
  assert.equal(assistantMsgs.length, 3, 'sanity check: all assistant turns present');
  for (const el of assistantMsgs) {
    assert.ok(el.querySelector('.msg-actions'), 'each assistant bubble must still have its .msg-actions row after the async upgrade replaced innerHTML');
    assert.ok(el.querySelector('.msg-actions button'), 'the actions row must contain actual buttons, not just an empty wrapper');
  }
});

test('renderHistory(): reply-source chip sits at the TOP-LEFT of the bubble and survives the async upgrade', () => {
  // 2026-09-09 用户反馈：来源标注在气泡底端靠右像元数据、与习惯不符——按
  // 「发信人标签」的惯例放到顶端靠左（气泡的第一个元素子节点）。异步升级
  // 会 el.innerHTML 清空，芯片必须随之重新前置（与 .msg-actions 同一纪律）。
  const assistantMsgs = [...messagesEl.querySelectorAll('.msg.assistant')];
  assert.equal(assistantMsgs.length, 3);
  for (const el of assistantMsgs) {
    const chip = el.querySelector('.msg-provider');
    assert.ok(chip, '每个 assistant 气泡都带来源芯片');
    assert.equal(el.firstElementChild, chip, '芯片是气泡第一个元素子节点 = 顶端靠左');
    assert.equal(chip.textContent, '方舟 Coding · glm-5.3-flash');
  }
});

test('renderHistory(): a steps-only interrupted turn stays visible after the full render and keeps history indices', () => {
  const el = messagesEl.querySelector('.msg.assistant[data-hidx="4"]');
  assert.ok(el, 'the recovered record has a bubble at its real history index');
  assert.equal(el.dataset.raw, '', 'the stored assistant reply remains empty');
  assert.match(el.textContent, /interrupt/i, 'the bubble explains why there is no reply');
  const details = el.querySelector('.tool-history');
  assert.ok(details, 'the recovered steps belong to the bubble');
  assert.match(details.textContent, /read.*src\/app\.ts/);
  assert.match(details.textContent, /outcome unknown/i);
  assert.match(details.textContent, /test.*npm test.*✗/);
  assert.doesNotMatch(details.textContent, /in progress/i);
  assert.ok(messagesEl.querySelector('.msg.user[data-hidx="5"]'), 'the next message keeps its actual index');
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

test('deleting a recovered turn removes its displayed steps and shifts the following history index', async () => {
  const el = messagesEl.querySelector('.msg.assistant[data-hidx="4"]');
  const stepList = messagesEl.querySelector('.tool-history');
  assert.ok(stepList?.textContent.includes('src/app.ts'));
  el.querySelector('.delete-icon').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(el.isConnected, false);
  assert.equal(stepList.isConnected, false, 'steps belong to the deleted entry and cannot remain orphaned');
  assert.ok(messagesEl.querySelector('.msg.user[data-hidx="4"]'), 'the next entry shifts to its new index');
});

test('switching away and back rebuilds recovered steps in the correct conversation', async () => {
  const { loadSession } = await import('../lib/sidepanel/sessions-ui.js');
  await loadSession('other', 'Other');
  assert.equal(messagesEl.querySelector('.tool-history'), null);
  assert.match(messagesEl.textContent, /other conversation/);
  await loadSession('origin', 'Origin');
  await new Promise(r => setTimeout(r, 50));
  const recovered = messagesEl.querySelector('.msg.assistant[data-hidx="4"]');
  assert.ok(recovered?.querySelector('.tool-history'));
  assert.equal(messagesEl.querySelectorAll('.tool-history').length, 1);
});

test('editing and resending an earlier user turn removes the later recovered steps', async () => {
  const user = messagesEl.querySelector('.msg.user[data-hidx="2"]');
  user.querySelector('[title="Edit & resend"]').click();
  const textarea = user.querySelector('.msg-edit-textarea');
  assert.ok(textarea);
  textarea.value = 'a revised question';
  user.querySelector('.msg-edit-save').click();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(messagesEl.querySelector('.tool-history'), null);
  assert.equal(messagesEl.querySelector('.msg.assistant[data-hidx="4"]'), null);
  assert.ok(lastChatPort);
  lastChatPort.emit({ type: 'DONE', full: 'new reply' });
  await new Promise(r => setTimeout(r, 30));
});
