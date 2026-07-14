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
  sendMessage, _findCard, _insertCard
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

test('showConfirmDialog resolves true when the confirm button is clicked', async () => {
  const p = showConfirmDialog({ title: 'Delete?', message: 'Are you sure?', confirmLabel: 'Delete', danger: true });
  const modal = document.querySelector('.confirm-modal');
  assert.ok(modal, 'a .confirm-modal must be created');
  assert.match(modal.querySelector('.confirm-title').textContent, /Delete\?/);
  modal.querySelector('.confirm-ok').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(await p, true);
  assert.equal(document.querySelector('.confirm-overlay'), null, 'overlay must be removed after resolving');
});

test('showConfirmDialog resolves false on Escape key', async () => {
  const p = showConfirmDialog({ title: 'Clear?', message: 'Sure?' });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await p, false);
});

test('_findCard finds a card of the given class within the next 4 siblings', () => {
  const bubble = document.createElement('div');
  const other = document.createElement('div'); other.className = 'tool-progress';
  const card = document.createElement('div'); card.className = 'approval-card';
  document.body.append(bubble, other, card);
  assert.equal(_findCard(bubble, 'approval-card'), card);
  assert.equal(_findCard(bubble, 'clarify-card'), null);
});

test('_insertCard inserts after the tool-progress line when present, else after the bubble itself', () => {
  const bubble = document.createElement('div');
  const tp = document.createElement('div'); tp.className = 'tool-progress';
  const parent = document.createElement('div');
  parent.append(bubble, tp);
  document.body.appendChild(parent);

  const card = document.createElement('div'); card.className = 'clarify-card';
  _insertCard(bubble, card);
  assert.equal(tp.nextElementSibling, card, 'card must land right after tool-progress, not right after bubble');

  const bubble2 = document.createElement('div');
  parent.appendChild(bubble2);
  const card2 = document.createElement('div'); card2.className = 'approval-card';
  _insertCard(bubble2, card2);
  assert.equal(bubble2.nextElementSibling, card2, 'with no tool-progress sibling, card lands right after the bubble');
});
