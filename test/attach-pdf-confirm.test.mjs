// test/attach-pdf-confirm.test.mjs — end-to-end wiring test for client-side
// PDF text extraction (Feature A from firecrawl research) through the real
// background.js ATTACH_PAGE / ATTACH_PDF_CONFIRM cases. pdf.js itself (real
// Worker + binary parsing) can't be meaningfully exercised in this Node test
// environment -- see test/lib-pdf-extractor.test.mjs for structural coverage
// of lib/sidepanel/pdf-extractor.js, and the CLAUDE.md/plan notes for the
// required manual browser sanity check. This file only covers the
// background.js message wiring: tryPdfExtraction's in-tab byte fetch +
// fallback, and ATTACH_PDF_CONFIRM's history-storage path.

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
});
const sessionArea = makeStorageArea();

// Mutable per-test so different tests can control what the in-tab
// _fetchPdfBytesInPageWorld executeScript call "returns".
let executeScriptImpl = async () => [{ result: { error: 'not configured for this test' } }];

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
    query: async () => [{ id: 1, url: 'https://example.com/doc.pdf', title: 'A Document' }],
    get: async () => ({ id: 1, url: 'https://example.com/doc.pdf', title: 'A Document', favIconUrl: '' }),
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
    executeScript: (...args) => executeScriptImpl(...args),
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

let nextTabId = 400;

test('ATTACH_PAGE on a PDF URL: successful byte fetch returns pdf-pending WITHOUT storing to history', async () => {
  executeScriptImpl = async () => [{ result: { base64: 'ZmFrZS1wZGYtYnl0ZXM=', byteLength: 15 } }];
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'pdf-pending');
  assert.equal(res.ctx.pdfBase64, 'ZmFrZS1wZGYtYnl0ZXM=');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 0, 'pdf-pending must not be stored to history yet');
});

test('ATTACH_PAGE on a PDF URL: byte fetch failure falls back to the placeholder text unchanged', async () => {
  executeScriptImpl = async () => [{ result: { error: 'pdf too large: 99999999' } }];
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'pdf-url');
  assert.match(res.ctx.text, /agent should fetch and read directly/);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /agent should fetch and read directly/, 'placeholder must still be stored to history like before this feature existed');
});

test('ATTACH_PAGE on a PDF URL: executeScript throwing also falls back to the placeholder', async () => {
  executeScriptImpl = async () => { throw new Error('scripting API unavailable'); };
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'pdf-url');
});

test('ATTACH_PDF_CONFIRM: stores the given text to history via buildPageContextText', async () => {
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: 'Extracted PDF body text here.',
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'A Document',
    numPages: 3
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /Extracted PDF body text here\./);
  assert.match(entry.content, /Mode: pdf/);
  assert.match(entry.content, /3 pages/);
});

test('ATTACH_PDF_CONFIRM: figureImages with captions become a caption-anchored multimodal entry', async () => {
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: 'PDF body with figures referenced.',
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'Figured Doc',
    numPages: 5,
    figureImages: [
      { url: 'data:image/jpeg;base64,AAA', caption: 'Figure 1: a diagram', page: 3 },
      { url: 'data:image/jpeg;base64,BBB', caption: null, page: 7 }
    ]
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.ok(Array.isArray(entry.content), 'figures present -> content is a multimodal array');
  assert.equal(entry.content[0].type, 'text');
  assert.match(entry.content[0].text, /PDF body with figures referenced\./);
  assert.match(entry.content[0].text, /Mode: pdf/);
  // The Figures section lists captions in order as the positional anchor the
  // model matches to the prose's "Figure N" reference.
  assert.match(entry.content[0].text, /## Figures/);
  assert.match(entry.content[0].text, /1\. Figure 1: a diagram/);
  assert.match(entry.content[0].text, /2\. Figure on page 7/, 'no-caption figure falls back to a page label');
  const imgs = entry.content.filter((b) => b.type === 'image_url');
  assert.equal(imgs.length, 2, 'both figure JPEGs stored as image_url blocks');
  assert.equal(imgs[0].image_url.url, 'data:image/jpeg;base64,AAA');
  assert.equal(imgs[1].image_url.url, 'data:image/jpeg;base64,BBB');
});

test('ATTACH_PDF_CONFIRM: bare-string figureImages still work (normalized to {url}, page-label anchors)', async () => {
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: 'PDF body.',
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'Figured Doc',
    numPages: 5,
    figureImages: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.ok(Array.isArray(entry.content));
  assert.match(entry.content[0].text, /1\. Figure on page \?/, 'bare strings have no caption/page -> page-label fallback');
  assert.equal(entry.content.filter((b) => b.type === 'image_url').length, 2);
});

test('ATTACH_PDF_CONFIRM: empty figureImages keeps the plain-string content shape', async () => {
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: 'Text-only PDF, no figures.',
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'Text Doc',
    figureImages: []
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.equal(typeof entry.content, 'string', 'no figures -> plain-string content, history stays uniform');
  assert.match(entry.content, /Text-only PDF, no figures\./);
});

test('ATTACH_PDF_CONFIRM: applies mask rules like the normal ATTACH_PAGE path', async () => {
  localArea._set({ maskRules: [{ pattern: 'SECRET-\\d+', flags: 'g', replacement: '[REDACTED]' }] });
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: 'Contract number SECRET-12345 must stay private.',
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'Contract'
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /\[REDACTED\]/);
  assert.doesNotMatch(entry.content, /SECRET-12345/);
  localArea._set({ maskRules: [] });
});

test('ATTACH_PDF_CONFIRM: missing text is a no-op error, not a crash', async () => {
  const res = await handle({ type: 'ATTACH_PDF_CONFIRM', metaUrl: 'https://example.com/doc.pdf' }, {});
  assert.equal(res.ok, false);
});

// Same asymmetry test as test/attach-page-summarize.test.mjs, but through
// ATTACH_PDF_CONFIRM -- this is a regression test for a real gap: PDF
// attachments used to bypass the auto-summarize feature entirely (no
// attachId stamp, no shouldSummarize check), unlike same-sized page
// attachments via ATTACH_PAGE.

function sseFor(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

test('ATTACH_PDF_CONFIRM: below-threshold PDF text gets no attachId, no summarize call', async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };

  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: 'short pdf text well under the threshold',
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'A Document'
  }, {});
  await flush();

  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.equal(entry.attachId, undefined, 'short PDF attachments must not get an attachId');
  assert.equal(fetchCalled, false, 'no summarization call should happen for short content');
});

test('ATTACH_PDF_CONFIRM: above-threshold PDF text gets an attachId and is auto-summarized like a page attachment', async () => {
  localArea._set({ summarizeThresholdChars: 100 }); // low threshold so a short test string still triggers it
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sseFor('CONDENSED PDF'), text: async () => '' });

  const longText = 'p'.repeat(500);
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: longText,
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'A Long Document',
    numPages: 80
  }, {});

  assert.equal(res.ok, true);
  const historyRightAfter = await localArea.get('history');
  const entry = historyRightAfter.history[historyRightAfter.history.length - 1];
  assert.ok(entry.attachId, 'above-threshold PDF attachment must be stamped with an attachId immediately');
  assert.match(entry.content, /p{500}/);

  await flush();

  const historyAfterFlush = await localArea.get('history');
  const updated = historyAfterFlush.history.find((m) => m.attachId === entry.attachId);
  assert.match(updated.content, /CONDENSED PDF/, 'the entry content must be replaced with the summarized text once the background pipeline completes');
  assert.equal(updated.summarized, true);
  assert.match(updated.content, /Mode: pdf/, 'summarized entry must still be rebuilt via buildPageContextText with mode:pdf');

  localArea._set({ summarizeThresholdChars: undefined });
});

test('ATTACH_PDF_CONFIRM: figures survive auto-summarize (image_url blocks preserved alongside condensed text)', async () => {
  localArea._set({ summarizeThresholdChars: 100 });
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sseFor('CONDENSED FIGURED PDF'), text: async () => '' });

  const longText = 'p'.repeat(500);
  const res = await handle({
    type: 'ATTACH_PDF_CONFIRM',
    text: longText,
    metaUrl: 'https://example.com/doc.pdf',
    metaTitle: 'Long Figured Doc',
    numPages: 80,
    figureImages: [
      { url: 'data:image/jpeg;base64,FIG1', caption: 'Figure 1: arch', page: 4 },
      { url: 'data:image/jpeg;base64,FIG2', caption: 'Figure 2: plot', page: 9 }
    ]
  }, {});
  assert.equal(res.ok, true);

  const historyRightAfter = await localArea.get('history');
  const entry = historyRightAfter.history[historyRightAfter.history.length - 1];
  assert.ok(entry.attachId, 'above-threshold -> attachId stamped');
  assert.ok(Array.isArray(entry.content), 'figures present -> content starts as a multimodal array');
  assert.equal(entry.content.filter((b) => b.type === 'image_url').length, 2);

  await flush();

  const historyAfterFlush = await localArea.get('history');
  const updated = historyAfterFlush.history.find((m) => m.attachId === entry.attachId);
  assert.ok(Array.isArray(updated.content), 'content must STAY a multimodal array after summarize, not collapse to a string');
  assert.equal(updated.content[0].type, 'text');
  assert.match(updated.content[0].text, /CONDENSED FIGURED PDF/, 'text block holds the condensed text');
  const imgs = updated.content.filter((b) => b.type === 'image_url');
  assert.equal(imgs.length, 2, 'both figure blocks preserved through the summarize rewrite');
  assert.equal(imgs[0].image_url.url, 'data:image/jpeg;base64,FIG1');
  assert.equal(updated.summarized, true);

  localArea._set({ summarizeThresholdChars: undefined });
});
