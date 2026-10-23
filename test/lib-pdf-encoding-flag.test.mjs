// test/lib-pdf-encoding-flag.test.mjs — the U+FFFD hasEncodingIssues flag on
// extractPdfContent's wasm path. Own file because the pdf-inspector
// worker-client's module-level singleton must start fresh per scenario (see
// the note in test/lib-pdf-extractor-content.test.mjs): this file's worker
// returns a usable TextBased result, a different scenario than
// lib-pdf-scanned-fallback.test.mjs's.

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

test('extractPdfContent: hasEncodingIssues flags a U+FFFD-heavy extraction even when the engine stayed silent', async () => {
  installFakeWorker({ markdown: '\uFFFD'.repeat(100), pageCount: 1, pdfType: 'TextBased', confidence: 0.9, pagesNeedingOcr: [] });
  const { extractPdfContent } = await freshModule();
  const res = await extractPdfContent(SAMPLE_BASE64);
  assert.equal(res.hasEncodingIssues, true, 'CID-font garbage flagged from the ratio alone');
  assert.equal(res.viaWasm, true);
});

// NOTE: the clean-text counterpart is covered on the fallback path in
// test/lib-pdf-scanned-fallback.test.mjs ("fallback path computes
// hasEncodingIssues...") — one wasm worker scenario per file (singleton).
