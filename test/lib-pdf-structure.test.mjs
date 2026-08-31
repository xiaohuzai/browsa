// test/lib-pdf-structure.test.mjs — pure-function coverage for the PDF
// document-structure helpers in lib/sidepanel/pdf-extractor.js: page-marker
// normalization, two-column reading-order reconstruction, and outline
// flattening/rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const pe = await import('../lib/sidepanel/pdf-extractor.js');

// ─── pdf-extractor: page markers ────────────────────────────────────────────

test('normalizePageMarkers: wasm HTML comments become visible [Page N] lines; consecutive duplicate markers collapse', () => {
  assert.equal(
    pe.normalizePageMarkers('a\n<!-- Page 3 -->\nb'),
    'a\n\n[Page 3]\n\nb'
  );
  assert.equal(
    pe.normalizePageMarkers('b\n\n<!-- Page 4 -->\n<!-- Page 4 -->\n\nc'),
    'b\n\n[Page 4]\n\nc',
    'a page boundary emitted twice must read as one page'
  );
  assert.equal(pe.normalizePageMarkers(''), '');
  assert.equal(pe.normalizePageMarkers(null), '');
});

// ─── pdf-extractor: reading-order reconstruction ────────────────────────────

// Items as pdf.js's getTextContent() would deliver a two-column page in
// content-stream order: left/right column lines interleaved.
function item(str, x, y, width = 100, size = 10) {
  return { str, transform: [size, 0, 0, size, x, y], width, hasEOL: true };
}

test('reconstructPageText: two-column page is re-ordered column by column, not content-stream order', () => {
  const items = [
    item('Left intro text', 50, 700),
    item('Right results text', 320, 700),
    item('Left second line', 50, 688),
    item('Right second line', 320, 688)
  ];
  const out = pe.reconstructPageText(items);
  const l1 = out.indexOf('Left intro text');
  const l2 = out.indexOf('Left second line');
  const r1 = out.indexOf('Right results text');
  const r2 = out.indexOf('Right second line');
  assert.ok(l1 !== -1 && l2 !== -1 && r1 !== -1 && r2 !== -1);
  assert.ok(l1 < l2 && l2 < r1 && r1 < r2, `column order left-block then right-block, got: ${JSON.stringify(out)}`);
});

test('reconstructPageText: single-column page keeps line order and joins same-line runs with spaces', () => {
  const items = [
    item('Abstract. This paper ', 50, 700, 100),
    item('presents a method.', 155, 700, 95),
    item('Second paragraph here.', 50, 686)
  ];
  const out = pe.reconstructPageText(items);
  assert.match(out, /Abstract\. This paper presents a method\./);
  assert.ok(out.indexOf('presents a method.') < out.indexOf('Second paragraph here.'));
});

test('reconstructPageText: subscript/superscript runs (small baseline offset) stay on the line; whitespace-only items drop', () => {
  const items = [
    item('x', 50, 700, 5, 10),
    item('2', 55, 703, 4, 6), // superscript: baseline above, smaller size
    item('= 4 total', 60, 700, 45, 10),
    item('   ', 200, 700, 10)
  ];
  const out = pe.reconstructPageText(items);
  assert.match(out, /x/, 'main run survives');
  assert.match(out, /= 4 total/, 'same-line runs join');
  assert.ok(!/\s{3,}/.test(out));
});

test('reconstructPageText: empty items → empty string (never throws)', () => {
  assert.equal(pe.reconstructPageText([]), '');
  assert.equal(pe.reconstructPageText(null), '');
  assert.equal(pe.reconstructPageText([{ str: '', transform: [1, 0, 0, 1, 0, 0] }]), '');
});

// ─── pdf-extractor: outline flatten + render ────────────────────────────────

function fakeDoc() {
  // dest arrays: [pageRef, /XYZ, x, y, zoom]; getPageIndex maps the ref's num
  // to a 0-based index (refs are compared by value here, since the outline
  // items under test construct their dest objects inline).
  return {
    getDestination: async (name) => (name === 'sec2' ? [{ num: 2 }, { name: 'XYZ' }, 0, 100, null] : null),
    getPageIndex: async (ref) => (ref && ref.num >= 1 && ref.num <= 3 ? ref.num - 1 : -1)
  };
}

test('flattenOutline: nested items flatten with levels; string dests resolve via getDestination; unresolvable dests keep page null', async () => {
  const doc = fakeDoc();
  const items = [
    { title: 'Introduction', dest: [{ num: 1 }, { name: 'XYZ' }, 0, 720, null], items: [
      { title: 'Setup', dest: 'sec2' },
      { title: 'Related', dest: 'named-missing' }
    ]},
    { title: 'Results', dest: [{ num: 3 }, { name: 'XYZ' }, 0, 100, null] },
    { title: '' , dest: null }, // no title → dropped
  ];
  const flat = await pe.flattenOutline(doc, items);
  assert.deepEqual(
    flat,
    [
      { title: 'Introduction', page: 1, level: 1 },
      { title: 'Setup', page: 2, level: 2 },
      { title: 'Related', page: null, level: 2 },
      { title: 'Results', page: 3, level: 1 }
    ]
  );
});

test('formatOutlineMarkdown: renders indented Contents block with page refs', () => {
  const md = pe.formatOutlineMarkdown([
    { title: 'Intro', page: 1, level: 1 },
    { title: 'Method', page: 3, level: 1 },
    { title: 'Setup', page: 4, level: 2 }
  ]);
  assert.match(md, /^## Contents/);
  assert.match(md, /- Intro — p\.1/);
  assert.match(md, /\n {2}- Setup — p\.4/, 'level 2 indented under level 1');
  assert.equal(pe.formatOutlineMarkdown([]), '');
});
