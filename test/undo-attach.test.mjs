// test/undo-attach.test.mjs — the 撤销 button must remove the history entry
// the CLICKED label owns, not "the last page-context in history". Real bug
// (2026-09-03): attach page A, attach page B, undo A → the legacy
// UNDO_ATTACH (no identity) removed B's entry, A's content stayed in
// history, and the model still answered from the "undone" page A. The fix
// stamps an attachId on every attach entry; the panel sends it and the
// handler removes by identity. Runs through the real background.js handle()
// like test/attach-page-summarize.test.mjs (selected mode = the simplest
// path that reaches the history-append code).

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

// No summarize/LLM traffic in these tests; if anything unexpectedly fetches,
// fail loudly instead of hanging.
globalThis.fetch = async () => { throw new Error('unexpected fetch in undo-attach test'); };

const bg = await import('../background.js');
const { handle } = bg;

const PAGE_CONTEXT_PREFIX = '[Page context attached by browsa]';

async function attachTwoPages() {
  // Two DIFFERENT tabIds — mirrors the real "attach page A, then attach page
  // B (another tab)" scenario. 'selected' mode prefers the background's
  // per-tab selection cache over msg.text (focus-shift rationale), so a
  // same-tab second attach in this SW-less harness would reuse the first
  // selection instead of the new text.
  const resA = await handle({ type: 'ATTACH_PAGE', tabId: 1, mode: 'selected', text: 'PAGE A CONTENT about ancient Rome' }, { tab: { id: 1 } });
  const resB = await handle({ type: 'ATTACH_PAGE', tabId: 2, mode: 'selected', text: 'PAGE B CONTENT about quantum physics' }, { tab: { id: 2 } });
  return { resA, resB };
}

test('undoing the FIRST of two attachments removes the FIRST entry (by attachId), keeping the second', async () => {
  localArea._set({ history: [] });
  const { resA, resB } = await attachTwoPages();
  assert.ok(resA.ok && resB.ok);
  assert.notEqual(resA.attachId, resB.attachId, 'each attach gets its own identity');

  const undo = await handle({ type: 'UNDO_ATTACH', attachId: resA.attachId }, {});
  assert.equal(undo.ok, true);
  assert.equal(undo.removedIdx, 0, 'entry A was the first in history');

  const { history } = await localArea.get('history');
  assert.equal(history.length, 1);
  assert.ok(history[0].content.includes('PAGE B CONTENT'), 'page B entry must survive');
  assert.ok(!history.some((m) => String(m.content).includes('PAGE A CONTENT')), 'undone page A must be GONE from what the model would receive');
});

test('undoing the SECOND attachment removes the second entry — the older one survives', async () => {
  localArea._set({ history: [] });
  const { resA, resB } = await attachTwoPages();

  const undo = await handle({ type: 'UNDO_ATTACH', attachId: resB.attachId }, {});
  assert.equal(undo.ok, true);

  const { history } = await localArea.get('history');
  assert.equal(history.length, 1);
  assert.ok(history[0].content.includes('PAGE A CONTENT'), 'page A entry must survive');
});

test('undo with an unknown attachId is an honest failure — history untouched (no wrong-entry fallback)', async () => {
  localArea._set({ history: [] });
  const { resA, resB } = await attachTwoPages();

  const undo = await handle({ type: 'UNDO_ATTACH', attachId: 'already-trimmed-id' }, {});
  assert.equal(undo.ok, false, 'not-found must not masquerade as success');
  assert.equal(undo.removedIdx, -1);

  const { history } = await localArea.get('history');
  assert.equal(history.length, 2, 'neither attachment may be removed on a miss');
  void resA; void resB;
});

test('legacy no-attachId caller keeps the old remove-last-page-context behavior', async () => {
  localArea._set({ history: [] });
  await attachTwoPages();

  const undo = await handle({ type: 'UNDO_ATTACH' }, {});
  assert.equal(undo.ok, true);

  const { history } = await localArea.get('history');
  assert.equal(history.length, 1);
  assert.ok(history[0].content.includes('PAGE B CONTENT') === false, 'legacy path removes the LAST page-context');
  assert.ok(history[0].content.includes('PAGE A CONTENT'));
});

test('every stored attach entry carries a page-context prefix + attachId pair (undo identity invariant)', async () => {
  localArea._set({ history: [] });
  await attachTwoPages();
  const { history } = await localArea.get('history');
  const ctxEntries = history.filter((m) => m.role === 'user' && String(m.content).startsWith(PAGE_CONTEXT_PREFIX));
  assert.equal(ctxEntries.length, 2);
  for (const m of ctxEntries) {
    assert.ok(m.attachId, 'each page-context entry must carry an attachId for undo identity');
  }
});
