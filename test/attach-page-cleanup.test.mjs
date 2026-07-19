// test/attach-page-cleanup.test.mjs — end-to-end wiring test confirming
// preExtractCleanup runs unconditionally on every generic ATTACH_PAGE call.
// Real cleanup DOM behavior is covered by test/lib-pre-extract-cleanup.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeStorageArea(initial = {}) {
  let store = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { store = { ...store, ...obj }; },
    async remove(key) { delete store[key]; },
    _set(obj) { store = { ...store, ...obj }; },
    _dump() { return store; },
  };
}

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
  autoSummarizeAttachments: false,
});
const sessionArea = makeStorageArea();

let executeScriptCalls = [];

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://example.com/article', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com/article', title: 'Test', favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts) => {
      executeScriptCalls.push(opts);
      // Inline arrow funcs (isPdfDocument, probe etc.) have name 'func'
      // via V8 property-key inference; returning true for those would mis-route
      // the extraction through the PDF path, bypassing runGenericExtraction.
      if (opts.func?.name === 'func' || opts.func?.name === '') return [{ result: false }];
      if (opts.func?.name === 'preExtractCleanup') return [{ result: {} }];
      return [{ result: { text: 'mock dom text that is long enough to count', rawTextLength: 40, wasCapped: false } }];
    },
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: localArea,
    session: sessionArea,
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};

Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });

const bg = await import('../background.js');
const { handle } = bg;

test('ATTACH_PAGE: preExtractCleanup always runs unconditionally on a generic page (no user setting required)', async () => {
  executeScriptCalls = [];
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 1, mode: 'dom' }, { tab: { id: 1 } });
  assert.equal(res.ok, true);
  const cleanupCalls = executeScriptCalls.filter((c) => c.func?.name === 'preExtractCleanup');
  assert.equal(cleanupCalls.length, 1, 'preExtractCleanup must run on every generic page attach');
});

test('ATTACH_PAGE: the main extraction call still runs after cleanup, not instead of it', async () => {
  executeScriptCalls = [];
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 1, mode: 'dom' }, { tab: { id: 1 } });
  assert.equal(res.ok, true);
  const extractCalls = executeScriptCalls.filter((c) => c.func?.name !== 'preExtractCleanup' && c.func?.name !== 'func');
  assert.ok(extractCalls.length >= 1, 'extraction must still happen after cleanup');
});
