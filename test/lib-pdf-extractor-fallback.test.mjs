// test/lib-pdf-extractor-fallback.test.mjs — isolated-process test for
// extractPdfContent()'s fallback path when a wasm result fails the usability
// gate. Kept in its own file so worker-inspector-worker-client.js's
// module-level singleton starts fresh (see the note in
// test/lib-pdf-extractor-content.test.mjs for why this must be a separate
// file rather than another test case in the same one).

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } };

class FakeWorker {
  constructor() { this._listeners = { message: [], error: [] }; }
  addEventListener(type, fn) { this._listeners[type].push(fn); }
  postMessage() {
    const result = { markdown: undefined, pageCount: 1, pdfType: 'Scanned', confidence: 0.9, pagesNeedingOcr: [1] };
    for (const fn of this._listeners.message) fn({ data: { ok: true, result } });
  }
  terminate() {}
}
globalThis.Worker = FakeWorker;

test('extractPdfContent: an unusable wasm result (Scanned, no text) falls through toward the pdf.js legacy path', async () => {
  const { extractPdfContent } = await import('../lib/sidepanel/pdf-extractor.js');
  const base64 = btoa('not a real pdf, only byte-length matters to the fake worker');
  // pdf.js itself can't run in bare Node (no DOMMatrix/Worker for its own
  // internal use) -- the fallback attempt throwing IS the proof that
  // extractPdfContent actually fell through rather than returning the
  // unusable Scanned result.
  await assert.rejects(() => extractPdfContent(base64));
});
