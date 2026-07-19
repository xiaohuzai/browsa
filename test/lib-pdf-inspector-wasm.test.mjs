// test/lib-pdf-inspector-wasm.test.mjs — real execution tests against the
// vendored lib/vendor/pdf_inspector_wasm_bg.wasm + pdf_inspector_wasm.js.
// Unlike pdf.js (which needs DOMMatrix/a real Worker and only ever got
// structural tests, see test/lib-pdf-extractor.test.mjs), plain WebAssembly
// runs directly in Node — initSync({module: bytes}) avoids needing to mock
// fetch/chrome.runtime.getURL entirely, so these assert on the actual
// engine's returned markdown/pdfType/confidence against small generated PDF
// fixtures, not just "the function exists and has the right shape".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(__dirname, '..', 'lib', 'vendor');

const mod = await import(join(VENDOR, 'pdf_inspector_wasm.js'));
mod.initSync({ module: readFileSync(join(VENDOR, 'pdf_inspector_wasm_bg.wasm')) });

// Builds a minimal valid single-page PDF with one BT/Tj text run — enough for
// pdf-inspector's own extraction pipeline to run end to end, without needing
// the full apparatus of a real-world PDF.
function buildMinimalPdf(text) {
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [4, null], // filled below, depends on content length
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  ];
  const content = `BT /F1 24 Tf 20 150 Td (${text}) Tj ET`;
  objs[3][1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [id, body] of objs) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const off of offsets.slice(1)) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// A page with an empty content stream — no text at all, mirroring a
// scanned/image-only PDF's text layer (or lack thereof).
function buildEmptyPdf() {
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>'],
    [4, '<< /Length 0 >>\nstream\n\nendstream']
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [id, body] of objs) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const off of offsets.slice(1)) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('processPdf: extracts real text from a minimal text-based PDF as markdown', () => {
  const result = mod.processPdf(buildMinimalPdf('Hello World'), {});
  assert.equal(result.pdfType, 'TextBased');
  assert.equal(result.pageCount, 1);
  assert.match(result.markdown, /Hello World/);
});

test('processPdf: a page with no text content is classified Scanned with no markdown', () => {
  const result = mod.processPdf(buildEmptyPdf(), {});
  assert.equal(result.pdfType, 'Scanned');
  assert.equal(result.markdown, undefined);
  assert.ok(result.pagesNeedingOcr.includes(1));
});

test('classifyPdf: lightweight classification without extracting markdown', () => {
  const cls = mod.classifyPdf(buildMinimalPdf('Classify me'));
  assert.equal(cls.pdfType, 'TextBased');
  assert.equal(cls.pageCount, 1);
});

test('extractText: plain text extraction without markdown conversion', () => {
  const text = mod.extractText(buildMinimalPdf('Plain text run'));
  assert.match(text, /Plain text run/);
});

test('processPdf: rejects non-PDF bytes', () => {
  assert.throws(() => mod.processPdf(new Uint8Array([1, 2, 3]), {}));
});

test('version: reports the vendored package version', () => {
  assert.equal(typeof mod.version(), 'string');
  assert.match(mod.version(), /^\d+\.\d+\.\d+$/);
});
