// test/attach-page-change-detection.test.mjs — end-to-end wiring test for
// local re-attach change detection (lib/handlers/attach-change-tracker.js)
// through the real background.js ATTACH_PAGE case. Mirrors the chrome mock
// setup from test/attach-page-summarize.test.mjs, but drives 'jina' mode
// (a simple fetch-based path, mocked, that doesn't need Readability/DOM
// injection) since 'selected' mode is deliberately excluded from change
// detection — a text selection legitimately differs every time by design,
// so it's not a "did the page change" signal.

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
  providers: {
    compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' },
  },
  autoSummarizeAttachments: false, // keep the unrelated summarizer feature out of these tests
});
const sessionArea = makeStorageArea();

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
  sidePanel: {
    setOptions: () => {},
    setPanelBehavior: async () => {},
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => [{ result: { text: 'unused', articleTitle: 'Mock', wasCapped: false, rawTextLength: 20 } }],
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: localArea,
    session: sessionArea,
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

const bg = await import('../background.js');
const { handle } = bg;

let nextTabId = 300;

function mockJinaFetch(markdown) {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => markdown });
}

test('first attach of a URL: no change note in the stored history entry', async () => {
  const tabId = nextTabId++;
  mockJinaFetch('This is the original article content, long enough to pass the 50-char floor.');

  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);

  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.doesNotMatch(entry.content, /changed since it was last attached/);
});

test('second attach of the same URL with different content: stored history entry includes the change note', async () => {
  const tabId = nextTabId++;
  mockJinaFetch('First version of the article, long enough to pass the 50-char floor easily.');
  await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });

  mockJinaFetch('Second version of the article -- the content has genuinely changed this time.');
  const res2 = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });
  assert.equal(res2.ok, true);

  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /changed since it was last attached/);
});

test('re-attaching the same URL with identical content: no change note', async () => {
  const tabId = nextTabId++;
  const same = 'Stable content that never changes between attaches, long enough to pass the floor.';
  mockJinaFetch(same);
  await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });
  mockJinaFetch(same);
  const res2 = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });
  assert.equal(res2.ok, true);

  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.doesNotMatch(entry.content, /changed since it was last attached/);
});
