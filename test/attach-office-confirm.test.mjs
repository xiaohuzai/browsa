// test/attach-office-confirm.test.mjs — end-to-end wiring test for the
// Office-document attach path (docling.rs-wasm): page-extractor.js's
// tryOfficeExtraction gating + byte fetch / placeholder fallback through the
// real background.js ATTACH_PAGE case, ATTACH_OFFICE_CONFIRM's history
// storage, and the module-level pure helpers (isOfficeUrl /
// officeFilenameFromUrl). The wasm conversion itself runs in a browser
// Worker and can't be exercised here (see the spike notes in
// test/lib-office-worker-fallback.test.mjs); like attach-pdf-confirm.test.mjs,
// this file covers the message wiring only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOfficeUrl, officeFilenameFromUrl } from '../lib/page-extractor.js';

// ── pure helpers ────────────────────────────────────────────────────────────

test('isOfficeUrl: extension gate matrix', () => {
  for (const url of [
    'https://example.com/report.docx',
    'https://example.com/deck.PPTX?raw=1',
    'https://example.com/data.xlsx#frag',
    'https://example.com/paper.epub',
    'https://example.com/notes.odt',
    'https://example.com/reader.rtf',
    'https://raw.githubusercontent.com/o/r/main/res/data.csv',
    'https://example.com/subs.vtt',
  ]) {
    assert.ok(isOfficeUrl(url), `should gate: ${url}`);
  }
  for (const url of [
    'https://example.com/', // no extension
    'https://example.com/legacy.doc', // legacy formats are not in the wasm build's list
    'https://example.com/legacy.xls',
    'https://example.com/legacy.ppt',
    'https://example.com/page.html', // pages stay with the generic pipeline
    'https://example.com/doc.pdf', // pdf has its own path
    'https://example.com/api/data.json',
    '', // empty
    null,
  ]) {
    assert.equal(isOfficeUrl(url), false, `should NOT gate: ${url}`);
  }
});

test('officeFilenameFromUrl: basename + query stripping + fallback', () => {
  assert.equal(officeFilenameFromUrl('https://example.com/a/b/report.docx'), 'report.docx');
  assert.equal(officeFilenameFromUrl('https://example.com/deck.pptx?dl=1'), 'deck.pptx');
  assert.equal(officeFilenameFromUrl('https://example.com/%E6%8A%A5%E5%91%8A.docx'), '报告.docx');
  assert.equal(officeFilenameFromUrl('https://example.com/'), 'document', 'no basename -> generic name');
  assert.equal(officeFilenameFromUrl('not a url'), 'document');
});

// ── background wiring ───────────────────────────────────────────────────────

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
});
const sessionArea = makeStorageArea();

// Mutable per-test; keyed by the injected function's name so the
// isPdfDocument probe (anonymous func) answers false while
// _fetchOfficeBytesInPageWorld answers with the configured result.
let officeFetchResult = { error: 'not configured for this test' };
let throwOnFetch = false;
const executeScriptImpl = async (injection) => {
  if (injection?.func?.name === '_fetchOfficeBytesInPageWorld') {
    if (throwOnFetch) throw new Error('scripting API unavailable');
    return [{ result: officeFetchResult }];
  }
  return [{ result: false }]; // isPdfDocument probe -> not a PDF
};

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
    query: async () => [{ id: 1, url: 'https://example.com/report.docx', title: 'Quarterly Report' }],
    get: async () => ({ id: 1, url: 'https://example.com/report.docx', title: 'Quarterly Report', favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: { executeScript: executeScriptImpl },
  storage: { onChanged: { addListener: () => {} }, local: localArea, session: sessionArea },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

const bg = await import('../background.js');
const { handle } = bg;

let nextTabId = 500;

test('ATTACH_PAGE on a .docx URL: byte fetch returns office-pending WITHOUT storing to history', async () => {
  officeFetchResult = { base64: 'ZmFrZS1vZmZpY2UtYnl0ZXM=', byteLength: 18 };
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'office-pending');
  assert.equal(res.ctx.officeBase64, 'ZmFrZS1vZmZpY2UtYnl0ZXM=');
  assert.equal(res.ctx.filename, 'report.docx', 'filename derived from the URL for docling format detection');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 0, 'office-pending must not be stored to history yet');
});

test('ATTACH_PAGE on a .docx URL: byte fetch failure falls back to the office-url placeholder', async () => {
  officeFetchResult = { error: 'not an office document (html viewer page): text/html' };
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'office-url');
  assert.match(res.ctx.text, /agent should fetch and read directly/);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /agent should fetch and read directly/, 'placeholder stored to history like the PDF path');
});

test('ATTACH_PAGE on a .docx URL: executeScript throwing also falls back to the placeholder', async () => {
  throwOnFetch = true;
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'office-url');
  throwOnFetch = false;
});

test('ATTACH_OFFICE_CONFIRM: stores the converted markdown with an office context header', async () => {
  const before = ((await localArea.get('history')).history || []).length;
  const res = await handle({
    type: 'ATTACH_OFFICE_CONFIRM',
    text: '# Converted\n\nMarkdown body from docx.',
    metaUrl: 'https://example.com/report.docx',
    metaTitle: 'Quarterly Report',
    ext: 'docx'
  }, {});
  assert.equal(res.ok, true);
  assert.ok(res.attachId, 'attachId (undo identity) is returned');
  const history = await localArea.get('history');
  assert.equal(((history.history || []).length), before + 1);
  const entry = history.history[history.history.length - 1];
  assert.equal(typeof entry.content, 'string', 'no figures in v1 -> plain-string content shape');
  assert.match(entry.content, /# Converted/);
  assert.match(entry.content, /Mode: office \| docx-text/);
  assert.ok(entry.attachId, 'attachId stamped on the entry for 撤销');
});

test('ATTACH_OFFICE_CONFIRM: empty text is rejected with the inner {ok:false}', async () => {
  const res = await handle({
    type: 'ATTACH_OFFICE_CONFIRM',
    text: '',
    metaUrl: 'https://example.com/report.docx',
    metaTitle: 'Quarterly Report'
  }, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no text');
});
