// test/lib-pdf-extractor-content.test.mjs — real execution tests for
// extractPdfContent()'s wasm-primary path in lib/sidepanel/pdf-extractor.js.
// The "unusable wasm result falls through" scenario lives in its own file
// (test/lib-pdf-extractor-fallback.test.mjs) because pdf-extractor.js's
// internal `import('./pdf-inspector-worker-client.js')` is NOT cache-busted
// (unlike this file's own cache-busted `import(pdf-extractor.js?t=...)`),
// so the worker-client's module-level singleton `worker` instance is shared
// across every test in one process -- node's test runner isolates separate
// FILES into separate processes, which is the only way to get a truly fresh
// worker-client singleton per scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('extractPdfContent: a usable wasm result is returned directly (viaWasm:true) and capped like the pdf.js path', async () => {
  installFakeWorker({
    markdown: '# Real Document\n\n' + 'x'.repeat(100),
    pageCount: 3,
    pdfType: 'TextBased',
    confidence: 0.95,
    pagesNeedingOcr: []
  });
  const { extractPdfContent } = await freshModule();

  const res = await extractPdfContent(SAMPLE_BASE64);
  assert.equal(res.viaWasm, true);
  assert.equal(res.numPages, 3);
  assert.equal(res.pdfType, 'TextBased');
  assert.match(res.text, /Real Document/);
  assert.deepEqual(res.pagesNeedingOcr, []);
  assert.equal(res.wasCapped, false, 'well under the default cap');

  const capped = await extractPdfContent(SAMPLE_BASE64, { maxChars: 40 });
  assert.equal(capped.wasCapped, true);
  assert.ok(capped.text.length <= 40 + 40, 'capped text plus truncation marker must not balloon back to the original length');
  assert.match(capped.text, /truncated at 40 chars/);
});

test('isUsableWasmResult rejects undefined/empty markdown and Scanned pdfType, accepts real text', async () => {
  const src = await readFile(new URL('../lib/sidepanel/pdf-extractor.js', import.meta.url), 'utf8');
  const fnMatch = src.match(/function isUsableWasmResult\([\s\S]*?\n}/);
  assert.ok(fnMatch, 'isUsableWasmResult must exist');
  const isUsableWasmResult = new Function(`${fnMatch[0]}\nreturn isUsableWasmResult;`)();

  assert.equal(isUsableWasmResult(null), false);
  assert.equal(isUsableWasmResult({ markdown: undefined, pdfType: 'TextBased' }), false);
  assert.equal(isUsableWasmResult({ markdown: '', pdfType: 'TextBased' }), false);
  assert.equal(isUsableWasmResult({ markdown: '   ', pdfType: 'TextBased' }), false);
  assert.equal(isUsableWasmResult({ markdown: 'real text', pdfType: 'Scanned' }), false);
  assert.equal(isUsableWasmResult({ markdown: 'real text', pdfType: 'TextBased' }), true);
});

test('isEmptyText: catches the case pdf.js itself never throws for (a fully scanned PDF joins to an empty string)', async () => {
  const src = await readFile(new URL('../lib/sidepanel/pdf-extractor.js', import.meta.url), 'utf8');
  const fnMatch = src.match(/function isEmptyText\([\s\S]*?\n}/);
  assert.ok(fnMatch, 'isEmptyText must exist');
  const isEmptyText = new Function(`${fnMatch[0]}\nreturn isEmptyText;`)();

  assert.equal(isEmptyText(''), true);
  assert.equal(isEmptyText('   \n\n  '), true);
  assert.equal(isEmptyText(undefined), true);
  assert.equal(isEmptyText('a couple pages of real text, even if partial (Mixed doc)'), false);
});
