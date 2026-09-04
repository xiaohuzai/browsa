// test/lib-sidepanel-ui-prefs.test.mjs — real execution tests for two small
// UI-preference affordances added to sidepanel.js: the quickbar collapse
// toggle and the always-visible "copy" action on assistant replies.
//
// Same harness pattern as test/lib-sidepanel-streaming.test.mjs (sidepanel.js
// has zero exports, so it's driven via real DOM events against the real
// sidepanel.html + sidepanel.js), kept in its own file so this file's
// GET_CONFIG response (quickbarCollapsed: true) doesn't collide with the
// streaming test file's shared module-level state.

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

let lastChatPort = null;
const storageSetCalls = [];

globalThis.chrome = makeSidepanelChromeMock({
  onConnect: (name, port) => { if (name === 'browsa-chat') lastChatPort = port; },
  storageLocalSet: async (obj) => { storageSetCalls.push(obj); },
  sendMessage: wireSendMessage((msg) => {
    if (msg.type === 'GET_CONFIG') return { data: { quickbarCollapsed: true } };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    return { ok: true };
  }),
});

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const messagesEl = document.getElementById('messages');
const quickbarEl = document.getElementById('quickbar');
const quickbarToggleBtn = document.getElementById('quickbar-toggle');

test('quickbar starts collapsed when cfg.quickbarCollapsed is true', () => {
  assert.ok(quickbarEl.classList.contains('collapsed'),
    'init() must apply the persisted quickbarCollapsed preference to #quickbar');
});

test('clicking quickbar-toggle un-collapses the quickbar and persists the new state', () => {
  storageSetCalls.length = 0;
  quickbarToggleBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.ok(!quickbarEl.classList.contains('collapsed'), 'first click must expand the quickbar');
  assert.ok(storageSetCalls.some((c) => c.quickbarCollapsed === false),
    'must persist the new (expanded) state via chrome.storage.local.set');
});

test('clicking quickbar-toggle again re-collapses it and persists that too', () => {
  storageSetCalls.length = 0;
  quickbarToggleBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.ok(quickbarEl.classList.contains('collapsed'), 'second click must re-collapse the quickbar');
  assert.ok(storageSetCalls.some((c) => c.quickbarCollapsed === true),
    'must persist the re-collapsed state');
});

test('assistant reply\'s copy action is a plain msg-action-icon (no always-visible special case)', async () => {
  inputEl.value = 'hello';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort, 'onSend() must open a browsa-chat port');

  lastChatPort.emit({ type: 'DONE', full: 'a short reply' });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  const copyBtn = assistantEl.querySelector('.msg-actions .msg-action-icon');
  assert.ok(copyBtn, 'the copy button must exist in the hover actions row');
  // The action bar floats over the bubble's top-right text, so NO action may
  // carry an extra visibility class that CSS could pin permanently visible —
  // every icon shares the hover fade-in. Regression guard for the retired
  // copy-icon special case (it used to occlude message text).
  const allowed = new Set(['msg-action-icon', 'msg-action-icon delete-icon', 'msg-action-icon fold-btn']);
  const special = [...assistantEl.querySelectorAll('.msg-actions .msg-action-icon')]
    .filter((b) => !allowed.has(b.className));
  assert.equal(special.length, 0, `no action icon may opt out of the uniform hover gate, got: ${special.map((b) => b.className).join(', ')}`);
});
