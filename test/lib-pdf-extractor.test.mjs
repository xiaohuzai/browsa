// test/lib-pdf-extractor.test.mjs — structural coverage for
// lib/sidepanel/pdf-extractor.js. Real pdf.js parsing (a Worker + real binary
// PDF parsing) can't be meaningfully exercised in this Node test environment
// (pdf.js's browser build requires DOMMatrix/Worker globals a bare Node
// process doesn't have — confirmed while building this feature) — same
// precedent as markmap/mermaid's real rendering not being unit-tested here.
// This file checks the module's shape and capping logic via source
// inspection; the AGENTS.md/plan notes require a manual browser sanity check
// (a real PDF, and a login-gated one) before considering this fully verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../lib/sidepanel/pdf-extractor.js', import.meta.url), 'utf8');

test('extractPdfText is exported', () => {
  assert.match(src, /export async function extractPdfText\(/);
});

test('pdf.js vendor bundle is lazily imported (not a static top-level import)', () => {
  // Static top-level import would eagerly load a 460KB+worker bundle on every
  // sidepanel init even when the user never attaches a PDF -- mirrors the
  // getMarkmapLib()/getEcharts() lazy-loader pattern in lib/sidepanel/render.js.
  assert.doesNotMatch(src, /^import .* from ['"]\.\.\/vendor\/pdf\.bundle\.js['"]/m);
  assert.match(src, /import\(['"]\.\.\/vendor\/pdf\.bundle\.js['"]\)/);
});

test('GlobalWorkerOptions.workerSrc is set to the pdf.worker.bundle.js vendor file via chrome.runtime.getURL', () => {
  assert.match(src, /GlobalWorkerOptions\.workerSrc\s*=\s*chrome\.runtime\.getURL\(['"]lib\/vendor\/pdf\.worker\.bundle\.js['"]\)/);
});

test('pdf lib module is cached after first load (module-level cache, not re-imported per call)', () => {
  assert.match(src, /let pdfLib = null/);
  assert.match(src, /if \(pdfLib\) return pdfLib/);
});

test('extractPdfText caps both page count and total character length', () => {
  assert.match(src, /maxPages = DEFAULT_MAX_PAGES/);
  assert.match(src, /maxChars = DEFAULT_MAX_CHARS/);
  assert.match(src, /Math\.min\(numPages, maxPages\)/);
  assert.match(src, /if \(total > maxChars\) break/);
});

test('wasCapped reflects either character truncation or page truncation', () => {
  const fnMatch = src.match(/export async function extractPdfText\([\s\S]*?\n}/);
  assert.ok(fnMatch, 'extractPdfText body must exist');
  assert.match(fnMatch[0], /wasCapped = text\.length > maxChars \|\| pagesRead < numPages/);
});

test('base64ToUint8Array correctly decodes a known base64 string', async () => {
  // Exercise the actual decode logic by extracting and running it directly --
  // this part IS pure/deterministic and safe to test for real, unlike the
  // pdf.js worker-dependent parts above.
  const fnMatch = src.match(/function base64ToUint8Array\([\s\S]*?\n}/);
  assert.ok(fnMatch, 'base64ToUint8Array must exist');
  global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  const fn = new Function(`${fnMatch[0]}\nreturn base64ToUint8Array;`)();
  const bytes = fn('SGVsbG8='); // "Hello"
  assert.deepEqual(Array.from(bytes), Array.from(Buffer.from('Hello', 'utf8')));
  delete global.atob;
});
