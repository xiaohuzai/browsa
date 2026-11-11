// test/lib-ui-utils.test.mjs — execution tests (not just source-regex) for
// lib/ui-utils.js, extracted from sidepanel.js in the Phase 3 modularization
// refactor. Uses jsdom so the module's real DOM code actually runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 21+ defines a read-only `navigator` global — redefine it instead of assigning.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;

let lastSendMessage = null;
globalThis.chrome = {
  runtime: {
    sendMessage: (msg, cb) => {
      lastSendMessage = msg;
      cb(chrome.runtime.lastError ? undefined : chrome.runtime._nextResponse);
    },
    lastError: undefined,
    _nextResponse: { ok: true, data: {} },
  },
};

const {
  $, escM, _copyText, _fallbackCopy, showToast, showConfirmDialog,
  openPanelDialog, sendMessage, _findCard, _insertCard
} = await import('../lib/sidepanel/ui-utils.js');

test('$ is document.getElementById', () => {
  const el = document.createElement('div');
  el.id = 'foo-el';
  document.body.appendChild(el);
  assert.equal($('foo-el'), el);
  assert.equal($('does-not-exist'), null);
});

test('escM escapes & < > but not quotes', () => {
  assert.equal(escM('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(escM(null), '');
  assert.equal(escM(undefined), '');
});

test('sendMessage resolves with the background response on success', async () => {
  chrome.runtime.lastError = undefined;
  chrome.runtime._nextResponse = { ok: true, data: { hello: 'world' } };
  const res = await sendMessage({ type: 'GET_CONFIG' });
  assert.deepEqual(lastSendMessage, { type: 'GET_CONFIG' });
  assert.deepEqual(res, { ok: true, data: { hello: 'world' } });
});

test('sendMessage resolves {ok:false, code:NoReceiver} when chrome.runtime.lastError is set', async () => {
  chrome.runtime.lastError = { message: 'Could not establish connection' };
  const res = await sendMessage({ type: 'CHAT' });
  chrome.runtime.lastError = undefined;
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NoReceiver');
  assert.equal(res.error, 'Could not establish connection');
});

test('sendMessage resolves {ok:false, code:NoResponse} when the callback gets no response', async () => {
  chrome.runtime.lastError = undefined;
  chrome.runtime._nextResponse = undefined;
  const res = await sendMessage({ type: 'CHAT' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NoResponse');
});

test('_copyText uses navigator.clipboard.writeText in a secure context', async () => {
  let written = null;
  const origClipboard = navigator.clipboard;
  const origSecure = window.isSecureContext;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: (t) => { written = t; return Promise.resolve(); } },
    configurable: true
  });
  await _copyText('hello clipboard');
  assert.equal(written, 'hello clipboard');
  Object.defineProperty(window, 'isSecureContext', { value: origSecure, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: origClipboard, configurable: true });
});

test('_fallbackCopy does not throw when document.execCommand is unavailable (jsdom has none)', async () => {
  // jsdom doesn't implement execCommand — _fallbackCopy must reject cleanly,
  // not throw synchronously and crash the caller.
  await assert.rejects(_fallbackCopy('x'));
});

test('showToast creates a toast with the given message and an auto-derived type', () => {
  showToast('Copied', 'success');
  const toast = document.querySelector('.toast-success');
  assert.ok(toast, 'a .toast-success element must be created');
  assert.match(toast.textContent, /Copied/);
});

test('showToast auto-classifies an error-looking message as type=error with Copy+Dismiss buttons', () => {
  showToast('Failed to load session');
  const toast = document.querySelector('.toast-error');
  assert.ok(toast, 'message containing "Failed" must be classified as error');
  assert.ok(toast.querySelector('.toast-copy'), 'error toasts get a Copy button');
  assert.ok(toast.querySelector('.toast-x'), 'error toasts get a Dismiss button');
});

test('showToast: error toast dismisses on clicking anywhere outside it', async () => {
  showToast('some failure', 'error');
  const toast = document.querySelector('.toast-error:last-child');
  assert.ok(toast, 'toast exists');
  await new Promise((r) => setTimeout(r, 10)); // outside-click 监听延后一拍挂上
  document.body.click(); // 点 toast 外
  assert.ok(!toast.isConnected, 'outside click must dismiss the toast');
});

test('showToast: clicking ON the toast does not dismiss it', async () => {
  showToast('another failure', 'error');
  const toast = document.querySelector('.toast-error:last-child');
  await new Promise((r) => setTimeout(r, 10));
  toast.click(); // 点 toast 本身（选文本/误触）
  assert.ok(toast.isConnected, 'clicking the toast must keep it');
  toast.querySelector('.toast-x').click(); // Dismiss 仍然有效
  assert.ok(!toast.isConnected);
});

test('showToast: overlong messages are truncated for display (buttons stay reachable)', () => {
  // 2026-08-28 实测：原始 JSON 报错把 Dismiss 顶出视口 → “关不掉”。
  const long = '视频解析失败：' + JSON.stringify({ error: { code: 'AuthenticationError', message: 'x'.repeat(800) } });
  showToast(long, 'error');
  const toast = document.querySelector('.toast-error:last-child');
  const span = toast.querySelector('span');
  assert.ok(span.textContent.length < 600, 'display text must be capped');
  assert.ok(span.textContent.endsWith('…'), 'truncation must be marked with an ellipsis');
  toast.querySelector('.toast-x').click();
});

test('showConfirmDialog resolves true when the confirm button is clicked', async () => {
  const p = showConfirmDialog({ title: 'Delete?', message: 'Are you sure?', confirmLabel: 'Delete', danger: true });
  const modal = document.querySelector('.confirm-modal');
  assert.ok(modal, 'a .confirm-modal must be created');
  assert.match(modal.querySelector('.confirm-title').textContent, /Delete\?/);
  const dialog = modal.closest('dialog.panel-modal');
  assert.ok(dialog, 'the card must live inside a native <dialog> (platform owns trap/inert/Esc)');
  assert.equal(dialog.getAttribute('aria-labelledby'), modal.querySelector('.confirm-title').id);
  assert.equal(modal.querySelector('.confirm-ok').classList.contains('danger'), true);
  assert.equal(document.activeElement, modal.querySelector('.confirm-cancel'), 'danger defaults focus to Cancel');
  modal.querySelector('.confirm-ok').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(await p, true);
  assert.equal(document.querySelector('dialog.panel-modal'), null, 'dialog must be removed after resolving');
});

test('showConfirmDialog resolves false on Escape key', async () => {
  const p = showConfirmDialog({ title: 'Clear?', message: 'Sure?' });
  // jsdom fallback path: Esc lands on the dialog (real Chrome: cancel→close).
  document.querySelector('dialog.panel-modal')
    .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await p, false);
});

test('showConfirmDialog: scrim click cancels, content click keeps focus semantics', async () => {
  const p = showConfirmDialog({ title: 'T', message: 'M' });
  const dialog = document.querySelector('dialog.panel-modal');
  dialog.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(await p, false, 'a click on the dialog wrapper itself is the scrim');

  const p2 = showConfirmDialog({ title: 'T', message: 'M', danger: true });
  const dialog2 = document.querySelector('dialog.panel-modal');
  dialog2.querySelector('.confirm-title').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.activeElement, dialog2.querySelector('.confirm-cancel'),
    'clicking text refocuses the default button so a following Enter keeps button semantics');
  dialog2.querySelector('.confirm-cancel').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(await p2, false);
});

test('showConfirmDialog: Enter confirms, IME-composing Enter does not, focused button keeps its own activation', async () => {
  const p = showConfirmDialog({ title: 'T', message: 'M' });
  const dialog = document.querySelector('dialog.panel-modal');
  dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  // still open — the IME gate held
  assert.ok(document.querySelector('dialog.panel-modal'), 'IME Enter must not resolve the dialog');
  dialog.querySelector('.confirm-msg').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(await p, true, 'Enter on non-button content confirms');

  const p2 = showConfirmDialog({ title: 'T', message: 'M', danger: true });
  const cancel = document.querySelector('.confirm-cancel');
  cancel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // the hook defers to the button's own activation — resolve happens on click
  cancel.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(await p2, false, 'Enter on the focused Cancel must cancel, not confirm');
});

test('openPanelDialog resolves exactly once across close paths and returns focus to the invoker', async () => {
  const invoker = document.createElement('button');
  document.body.appendChild(invoker);
  invoker.focus();
  const body = document.createElement('div');
  body.textContent = 'inspector body';
  const { dialog, close, result } = openPanelDialog({ body });
  assert.equal(dialog.hasAttribute('open'), true, 'jsdom fallback marks the dialog open');
  assert.equal(dialog.querySelector('div').textContent, 'inspector body');
  close('first');
  close('second'); // late duplicate (e.g. close event after manual close) must not re-resolve
  dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await result, 'first');
  assert.equal(document.querySelector('dialog.panel-modal'), null);
  assert.equal(document.activeElement, invoker, 'focus returns to the invoker');
  invoker.remove();
});

test('_findCard finds a card of the given class within the next 4 siblings', () => {
  const bubble = document.createElement('div');
  const other = document.createElement('div'); other.className = 'tool-progress';
  const card = document.createElement('div'); card.className = 'approval-card';
  document.body.append(bubble, other, card);
  assert.equal(_findCard(bubble, 'approval-card'), card);
  assert.equal(_findCard(bubble, 'clarify-card'), null);
});

test('_insertCard always inserts directly after the bubble — tool-progress lives before the bubble now, not after', () => {
  const bubble = document.createElement('div');
  // A tool-progress element positioned BEFORE the bubble (its actual position
  // now — see turn-chrome.js's showToolProgress) must not affect where the
  // card lands relative to the bubble.
  const tp = document.createElement('div'); tp.className = 'tool-progress';
  const parent = document.createElement('div');
  parent.append(tp, bubble);
  document.body.appendChild(parent);

  const card = document.createElement('div'); card.className = 'clarify-card';
  _insertCard(bubble, card);
  assert.equal(bubble.nextElementSibling, card, 'card must land right after the bubble');

  const bubble2 = document.createElement('div');
  parent.appendChild(bubble2);
  const card2 = document.createElement('div'); card2.className = 'approval-card';
  _insertCard(bubble2, card2);
  assert.equal(bubble2.nextElementSibling, card2, 'with no following sibling, card lands right after the bubble');
});


test('scheduleIdle invokes fn via the setTimeout fallback when requestIdleCallback is absent', async () => {
  const { scheduleIdle } = await import('../lib/sidepanel/ui-utils.js');
  // jsdom has no requestIdleCallback — the call must still land (setTimeout fallback).
  await new Promise((resolve) => scheduleIdle(resolve, 50));
});
