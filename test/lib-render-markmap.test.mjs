// test/lib-render-markmap.test.mjs — structural regression tests for the
// ```markmap fenced-code-block rendering pipeline (lib/sidepanel/render.js),
// ported from auditing BiliNote's markmap-based mind-map notes. Same
// treatment as the existing echarts tests in test/lib-render.test.mjs: no
// real markmap-lib/markmap-view engine load (heavy, and markmap-view needs
// a real laid-out DOM to measure text extents, not worth it for a unit
// test) — instead assert the source actually wires the real API up the way
// the mermaid/echarts precedent does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');

test('renderMarkmap selects code.language-markmap blocks', () => {
  assert.match(src, /el\.querySelectorAll\('code\.language-markmap'\)/);
});

test('renderMarkmap lazily loads markmap-lib and markmap-view vendor bundles', () => {
  assert.match(src, /import\(['"]\.\.\/vendor\/markmap-lib\.bundle\.js['"]\)/);
  assert.match(src, /import\(['"]\.\.\/vendor\/markmap-view\.bundle\.js['"]\)/);
});

test('renderMarkmap loads markmap-lib and markmap-view in parallel (Promise.all), not sequentially', () => {
  // markmap-lib (1.7MB) and markmap-view (80KB) are independent — parallel
  // load avoids markmap-view waiting behind markmap-lib's much larger parse time.
  assert.match(src, /Promise\.all\(\[getMarkmapLib\(\), getMarkmapView\(\)\]\)/);
});

test('renderMarkmap injects markmap-view\'s globalCSS once on first load', () => {
  assert.match(src, /style\.textContent = markmapViewModule\.globalCSS/);
  assert.match(src, /document\.head\.appendChild\(style\)/);
});

test('renderMarkmap transforms the code block source via Transformer and renders via Markmap.create', () => {
  assert.match(src, /new lib\.Transformer\(\)\.transform\(source\)/);
  assert.match(src, /view\.Markmap\.create\(svgEl, \{\}, root\)/);
});

test('renderMarkmap wraps the diagram in .markmap-diagram containing an svg.markmap-svg', () => {
  assert.match(src, /wrapper\.className = 'markmap-diagram'/);
  assert.match(src, /svgEl\.setAttribute\('class', 'markmap-svg'\)/);
});

test('renderMarkmap regression: a render failure must replace the wrapper actually in the DOM, not the already-detached <pre>', () => {
  // The wrapper is inserted (pre.replaceWith(wrapper)) BEFORE Markmap.create
  // runs, because markmap-view needs a DOM-attached <svg> to measure text
  // extents during layout — unlike mermaid/echarts, whose risky work all
  // happens before their own replaceWith. A naive catch block that calls
  // pre.replaceWith(errDiv) here would be a no-op (pre is already detached),
  // silently leaving a broken/empty diagram visible instead of the error UI.
  assert.match(src, /wrapper\.replaceWith\(errDiv\)/,
    'the catch block must replace the wrapper, not the stale pre reference');
});

test('renderMarkmap error UI mirrors mermaid\'s: message + copy button + collapsible raw source', () => {
  assert.match(src, /errDiv\.className = 'markmap-error'/);
  assert.match(src, /markmap-err-copy/);
  assert.match(src, /markmap-err-src/);
});

test('addCodeCopyButtons excludes markmap (alongside mermaid/diff/patch) from highlight.js syntax highlighting', () => {
  assert.match(src, /lang !== 'mermaid' && lang !== 'markmap' && lang !== 'diff' && lang !== 'patch'/);
});

test('renderMarkmap is exported', () => {
  assert.match(src, /export async function renderMarkmap\(el\)/);
});

// ─── Toolbar (zoom/reset/copy/export) ────────────────────────────────────────
// markmap-view is built on d3-zoom and already drives its own transform on
// the inner <g> — reusing mermaid's viewBox-mutation zoom functions would
// fight that instead of cooperating with it, so the toolbar must drive
// markmap-view's own .fit()/.rescale() API. This requires Markmap.create()'s
// return value to actually be captured, not discarded.

test('renderMarkmap captures Markmap.create()\'s return value instead of discarding it', () => {
  assert.match(src, /const mm = view\.Markmap\.create\(svgEl, \{\}, root\)/,
    'the Markmap instance must be kept so the toolbar can call .fit()/.rescale() on it');
});

test('renderMarkmap appends a toolbar only on the success path, using the same mm instance', () => {
  assert.match(src, /wrapper\.appendChild\(_markmapToolbar\(mm, source, svgEl, wrapper\)\)/);
});

test('_markmapToolbar reuses the mermaid-toolbar/mermaid-btn CSS classes (no markmap-specific class names)', () => {
  const fnMatch = src.match(/function _markmapToolbar\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, '_markmapToolbar function must exist');
  assert.match(fnMatch[0], /bar\.className = 'mermaid-toolbar'/);
  assert.match(fnMatch[0], /btn\.className = 'mermaid-btn'/);
});

test('_markmapToolbar drives zoom via _markmapZoomBy and reset via mm.fit() — never mermaid\'s viewBox-mutation helpers', () => {
  const fnMatch = src.match(/function _markmapToolbar\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.match(fnMatch[0], /_markmapZoomBy\(mm, svgEl,/);
  assert.match(fnMatch[0], /mm\.fit\(\)/);
  assert.doesNotMatch(fnMatch[0], /_mermaidZoom|_mermaidReset|_mermaidApply/,
    'markmap must not reuse mermaid\'s viewBox-mutation zoom scheme — it would fight markmap-view\'s own d3-zoom transform');
});

test('_markmapZoomBy calls mm.rescale() with the RELATIVE factor needed to reach clamped target — not the current scale pre-multiplied', () => {
  // Real bug this tests against: the original implementation passed
  // rescale(current * factor) where rescale() ALSO multiplies current scale
  // by its argument internally — squaring the current scale and causing both
  // + and - to shrink the diagram (since auto-fit scale is <1 and x^2 < x
  // when x<1). Fix: pass target/current (the relative factor needed to land
  // exactly on the clamped target absolute scale) instead.
  const fnMatch = src.match(/function _markmapZoomBy\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, '_markmapZoomBy must exist');
  assert.match(fnMatch[0], /mm\.rescale\(/);
  assert.match(fnMatch[0], /target \/ current/, 'must pass the relative factor (target/current) to rescale(), not the raw target');
  assert.doesNotMatch(fnMatch[0], /rescale\(Math/, 'must not call rescale(Math.min/max...) directly — that was the bug');
});

test('_markmapToolbar reuses _mermaidExportSvg (no duplicate export function) for the export button, passed the wrapper', () => {
  const fnMatch = src.match(/function _markmapToolbar\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.match(fnMatch[0], /_mermaidExportSvg\(wrapper\)/);
});

test('renderMarkmap wires a ResizeObserver to re-fit the mind map on container size changes', () => {
  assert.match(src, /new ResizeObserver\(\(\) => mm\.fit\(\)\)\.observe\(wrapper\)/);
});

test('_markmapScale reads the live d3-zoom transform from the SVG node\'s __zoom field, not a separate d3 import', () => {
  assert.match(src, /function _markmapScale\(svgEl\)/);
  assert.match(src, /svgEl\.__zoom\?\.k/);
});
