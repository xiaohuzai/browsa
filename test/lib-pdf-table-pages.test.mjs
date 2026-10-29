// test/lib-pdf-table-pages.test.mjs — pure tests for selectTablePages(), the
// table-page candidate rule behind the PDF table-page vision attach (2026-10-28,
// informed by OpenRouter's extract-tables-from-pdf tutorial: models reading page
// IMAGES beat every text-layer parser on complex tables — 644/644 cells incl.
// rough scans — while text-layer extraction silently returns mangled tables).
//
// browsa already renders caption-matched "Table N" pages whole via the figure
// pass; the gap this closes is UNCAPTIONED table pages, which the wasm engine
// flags in layout.pagesWithTables but whose text arrives mangled. The selector
// is the only decision logic; the renderer (pdf.js canvas) is DOM-bound and
// covered by the same "not unit-tested in CI" convention as extractPdfFigures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTablePages } from '../lib/sidepanel/pdf-extractor.js';

const FIGURE_MAX_IMAGES = 30; // mirrors the module constant the slots math uses

test('selectTablePages: keeps in-range pages only, dedupes, sorts ascending', () => {
  const out = selectTablePages([4, 2, 4, 11, 2], [], 12);
  assert.deepEqual(out, [2, 4, 11]);
});

test('selectTablePages: drops garbage — 0, negatives, non-integers, beyond maxPage', () => {
  assert.deepEqual(selectTablePages([0, -3, 1.5, NaN, '7', 13], [], 12), [7]);
  assert.deepEqual(selectTablePages([], [], 12), []);
  assert.deepEqual(selectTablePages(null, [], 12), []);
});

test('selectTablePages: excludes pages already covered by a figure entry (caption-matched whole-page tables)', () => {
  const figures = [
    { url: 'data:1', caption: 'Table 3', page: 3 },
    { url: 'data:2', caption: 'Figure 1', page: 2 },
  ];
  const out = selectTablePages([2, 3, 5, 9], figures, 12);
  assert.deepEqual(out, [5, 9], 'pages 2/3 already ride along as figure attachments');
});

test('selectTablePages: caps to the REMAINING figure budget (FIGURE_MAX_IMAGES - figures.length)', () => {
  const figures = Array.from({ length: 28 }, (_, i) => ({ url: `data:${i}`, page: i + 1 }));
  const out = selectTablePages([30, 32, 34, 36, 38], figures, 40);
  assert.deepEqual(out, [30, 32], 'only 2 slots remain of 30');
});

test('selectTablePages: full budget → nothing is added', () => {
  const figures = Array.from({ length: FIGURE_MAX_IMAGES }, (_, i) => ({ url: `data:${i}`, page: i + 1 }));
  assert.deepEqual(selectTablePages([5, 6], figures, 30), []);
});

test('selectTablePages: figure entries without a page number do not cover anything', () => {
  const out = selectTablePages([4], [{ url: 'data:x' }], 10);
  assert.deepEqual(out, [4]);
});
