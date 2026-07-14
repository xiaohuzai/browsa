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

function makeFakePort(name) {
  const listeners = [];
  const disconnectListeners = [];
  const port = {
    name,
    sent: [],
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage: (msg) => {
      port.sent.push(msg);
      if (msg.type === 'STREAM_HELLO') {
        queueMicrotask(() => port.emit({ type: 'STREAM_HELLO_ACK' }));
      }
    },
    disconnect: () => { for (const fn of disconnectListeners) fn(); },
    emit: (msg) => { for (const fn of [...listeners]) fn(msg); },
  };
  return port;
}

let lastChatPort = null;
const storageSetCalls = [];

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/', title: 'Example' }],
    get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  runtime: {
    connect: ({ name }) => {
      const port = makeFakePort(name);
      if (name === 'browsa-chat') lastChatPort = port;
      return port;
    },
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg.type === 'GET_CONFIG') res = { data: { quickbarCollapsed: true } };
      if (msg.type === 'STREAM_PEEK') res = { inFlight: false };
      cb(res);
    },
    lastError: undefined,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async (obj) => { storageSetCalls.push(obj); },
      remove: async () => {},
    },
    session: {
      get: async () => ({}),
      remove: async () => {},
    },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

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

test('assistant reply\'s copy action carries the copy-icon class (kept visible without hover, unlike the other actions)', async () => {
  inputEl.value = 'hello';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort, 'onSend() must open a browsa-chat port');

  lastChatPort.emit({ type: 'DONE', full: 'a short reply' });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  const copyBtn = assistantEl.querySelector('.msg-action-icon.copy-icon');
  assert.ok(copyBtn, 'the copy button must carry .copy-icon so CSS can keep it visible without a parent-opacity hover gate');
  const replyOrDeleteBtn = assistantEl.querySelector('.msg-action-icon:not(.copy-icon):not(.fold-btn)');
  assert.ok(replyOrDeleteBtn, 'sanity check: other action icons (reply/delete) must still exist, just without the always-visible class');
});
