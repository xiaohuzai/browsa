// test/attach-page-summarize.test.mjs — end-to-end wiring test for the
// auto-summarize-long-attachments feature (lib/handlers/attach-summarizer.js)
// through the real background.js ATTACH_PAGE case, not just the isolated
// module. Uses the same handle()-via-'selected'-mode approach
// (the simplest path that reaches the history-append
// code without needing to mock Readability/DOM extraction).
//
// The summarization pipeline is fire-and-forget (ATTACH_PAGE's response must
// stay fast — the raw text is never rendered in the chat bubble, so there's
// no UI to block on). Tests await a short flush after calling handle() to
// let the already-mocked-to-resolve-instantly chatStream() calls settle.

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
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com', title: 'Test', favIconUrl: '' }),
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
    executeScript: async () => [{ result: { text: 'unused in selected mode', articleTitle: 'Mock', wasCapped: false, rawTextLength: 20 } }],
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

let nextTabId = 200;

function sseFor(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

async function flush() {
  // Let the fire-and-forget summarization's already-resolved-instantly
  // fetch/JSON promise chain settle before asserting on storage.
  await new Promise((r) => setTimeout(r, 20));
}

test('below-threshold attachment: attachId stamped (undo identity) but no summarize call made', async () => {
  const tabId = nextTabId++;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };

  const res = await handle({
    type: 'ATTACH_PAGE', tabId, mode: 'selected', text: 'short text well under the threshold'
  }, { tab: { id: tabId } });
  await flush();

  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  assert.equal(history.history.length, 1);
  // attachId is not a summarize marker anymore — EVERY attach entry carries
  // one, because the panel's 撤销 button removes the entry by this id
  // (UNDO_ATTACH). Only the summarize pipeline stays threshold-gated.
  assert.ok(history.history[0].attachId, 'every attachment gets an attachId (undo identity)');
  assert.equal(typeof res.attachId, 'string', 'ATTACH_PAGE returns the attachId for the label');
  assert.equal(fetchCalled, false, 'no summarization call should happen for short content');
});

test('above-threshold attachment: gets an attachId, and the fire-and-forget summarization eventually replaces the stored content', async () => {
  const tabId = nextTabId++;
  localArea._set({ summarizeThresholdChars: 100 }); // low threshold so a short test string still triggers it
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sseFor('CONDENSED'), text: async () => '' });

  const longText = 'x'.repeat(500);
  const res = await handle({
    type: 'ATTACH_PAGE', tabId, mode: 'selected', text: longText
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true);
  const historyRightAfter = await localArea.get('history');
  const entry = historyRightAfter.history[historyRightAfter.history.length - 1];
  assert.ok(entry.attachId, 'above-threshold attachment must be stamped with an attachId immediately');
  // Immediately after the (synchronous) response, the raw text should still
  // be present — summarization hasn't had a chance to run yet.
  assert.match(entry.content, /x{500}/);

  await flush();

  const historyAfterFlush = await localArea.get('history');
  const updated = historyAfterFlush.history.find((m) => m.attachId === entry.attachId);
  assert.match(updated.content, /CONDENSED/, 'the entry content must be replaced with the summarized text once the background pipeline completes');
  assert.equal(updated.summarized, true);
});

test('autoSummarizeAttachments: false disables the feature entirely, even above threshold', async () => {
  const tabId = nextTabId++;
  localArea._set({ summarizeThresholdChars: 100, autoSummarizeAttachments: false });
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };

  const res = await handle({
    type: 'ATTACH_PAGE', tabId, mode: 'selected', text: 'y'.repeat(500)
  }, { tab: { id: tabId } });
  await flush();

  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  // attachId is unconditional now (undo identity); "disabled" means no
  // summarize fetch happens — not "no attachId".
  assert.ok(entry.attachId);
  assert.equal(fetchCalled, false);
  // restore for any subsequent tests in this file
  localArea._set({ autoSummarizeAttachments: true });
});
