// test/lib-pdf-scanned-fallback.test.mjs — scanned-PDF vision fallback +
// U+FFFD encoding-issue flag wiring in extractPdfContent(). Own file because
// the pdf-inspector worker-client's module-level singleton must start fresh
// per scenario (see the note in test/lib-pdf-extractor-content.test.mjs —
// these tests need a DIFFERENT wasm worker result than that file's test 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } };

function installFakeWorker(result) {
  class FakeWorker {
    constructor() { this._listeners = { message: [], error: [] }; }
    addEventListener(type, fn) { this._listeners[type].push(fn); }
    postMessage() {
      for (const fn of this._listeners.message) fn({ data: { ok: true, result } });
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
}

async function freshModule() {
  return import('../lib/sidepanel/pdf-extractor.js?t=' + Math.random() + Math.random());
}

const SAMPLE_BASE64 = btoa('not a real pdf, only byte-length matters to the fake worker');

// --- scanned-PDF vision fallback (opendataloader's scanned-page routing,
// translated to browsa: the figure pass's whole-page renders become the
// attached page images instead of discarding the document) ---

test('extractPdfContent: an empty-text document with rendered page images returns a scanned result, not a throw', async () => {
  // The wasm gate must reject (Scanned type) so the flow reaches the legacy
  // branch, where the _extractText seam stands in for pdf.js (which cannot
  // load in bare Node) and _extractFigures supplies the whole-page renders.
  installFakeWorker({ markdown: undefined, pageCount: 20, pdfType: 'Scanned', confidence: 0.9, pagesNeedingOcr: [1, 2] });
  const { extractPdfContent } = await freshModule();
  const pageImage = (n) => ({ url: `data:image/jpeg;base64,page${n}`, caption: null, page: n });
  const figures = Array.from({ length: 15 }, (_, i) => pageImage(i + 1)); // over the cap on purpose
  const res = await extractPdfContent(SAMPLE_BASE64, {
    extractFigures: true,
    _extractText: async () => ({ text: '', numPages: 20, pagesRead: 20, wasCapped: false, outline: [] }),
    _extractFigures: async () => figures
  });
  assert.equal(res.scanned, true, 'the scanned branch ran instead of the throw');
  assert.match(res.text, /^\[PDF file/, 'keeps the [PDF file prefix hasPdfTrace() gates on');
  assert.match(res.text, /first 12 of 20 pages/, 'note states the attached/total page counts');
  assert.equal(res.figureImages.length, 12, 'page images capped at SCANNED_MAX_PAGE_IMAGES');
  assert.equal(res.figureImages[0].page, 1);
  assert.equal(res.figureImages[11].page, 12, 'first N pages in reading order, not arbitrary ones');
  assert.equal(res.numPages, 20);
  assert.equal(res.viaWasm, false);
});

test('extractPdfContent: empty text AND no rendered figures still throws (placeholder path intact)', async () => {
  installFakeWorker({ markdown: undefined, pageCount: 3, pdfType: 'Scanned', confidence: 0.9, pagesNeedingOcr: [1] });
  const { extractPdfContent } = await freshModule();
  await assert.rejects(
    () => extractPdfContent(SAMPLE_BASE64, {
      extractFigures: true,
      _extractText: async () => ({ text: '', numPages: 3, pagesRead: 3, wasCapped: false, outline: [] }),
      _extractFigures: async () => []
    }),
    /no text/
  );
});

test('extractPdfContent: scanned fallback still rides the outline Contents prepend', async () => {
  // The outline pass runs independently; a scanned doc with bookmarks keeps
  // its Contents section in front of the scanned note.
  installFakeWorker({ markdown: undefined, pageCount: 5, pdfType: 'Scanned', confidence: 0.9, pagesNeedingOcr: [1] });
  const { extractPdfContent } = await freshModule();
  const res = await extractPdfContent(SAMPLE_BASE64, {
    extractFigures: true,
    _extractText: async () => ({ text: '', numPages: 5, pagesRead: 5, wasCapped: false }),
    _extractFigures: async () => [{ url: 'data:image/jpeg;base64,p1', caption: null, page: 1 }]
  });
  assert.equal(res.scanned, true);
  assert.equal(res.outline, undefined, 'no outline on fake bytes (fails harmlessly), and no crash');
});

test('extractPdfContent: fallback path computes hasEncodingIssues from the legacy text ratio', async () => {
  // Same file-scoped Scanned worker (singleton), but a legacy text with real
  // content: the fallback branch must set the flag from OUR ratio, proving
  // the pdf.js path is covered too — clean text stays unflagged, garbage
  // flags, same threshold as the wasm path.
  installFakeWorker({ markdown: undefined, pageCount: 5, pdfType: 'Scanned', confidence: 0.9, pagesNeedingOcr: [1] });
  const { extractPdfContent } = await freshModule();
  const clean = await extractPdfContent(SAMPLE_BASE64, {
    _extractText: async () => ({ text: 'clean ascii body text with no replacement chars', numPages: 5, pagesRead: 5, wasCapped: false })
  });
  assert.equal(clean.hasEncodingIssues, false, 'clean fallback text unflagged');
  assert.equal(clean.viaWasm, false);
  const garbage = await extractPdfContent(SAMPLE_BASE64, {
    _extractText: async () => ({ text: 'x'.repeat(50) + '\uFFFD'.repeat(50), numPages: 5, pagesRead: 5, wasCapped: false })
  });
  assert.equal(garbage.hasEncodingIssues, true, 'half-garbage fallback text flags (ratio 0.5 >= 0.3)');
});

// NOTE: the hasEncodingIssues (U+FFFD ratio) wiring tests for the WASM path
// live in test/lib-pdf-encoding-flag.test.mjs — a different worker scenario
// than this file's.
