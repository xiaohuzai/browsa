// test/lib-nn-render.test.mjs — lib/sidepanel/render.js's parseNnBlock (pure)
// and renderNn (jsdom): the ```nn fence renders publication-style neural
// network architecture figures from compact JSON. The parser is the contract
// surface the model writes against, so its tolerance rules (one bad layer is
// dropped, oversized nets truncate with a "+N more" row, skips validated) are
// the most important thing to pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.XMLSerializer = window.XMLSerializer;
// matchMedia is absent in jsdom — renderNn reads it for the export backdrop.
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));

const { parseNnBlock, renderNn } = await import('../lib/sidepanel/render.js');

// ── parseNnBlock ─────────────────────────────────────────────────────────────

test('parseNnBlock: valid stack spec with strings, objects, parallel group and skips', () => {
  const spec = parseNnBlock(JSON.stringify({
    layers: [
      'Input 224×224×3',
      { name: 'Conv2D 64', out: '112×112×64' },
      { name: 'Residual', parallel: [{ name: 'Conv 3×3' }, { name: 'Conv 1×1' }] },
      'Dense 10',
    ],
    skips: [{ from: 1, to: 3, label: 'residual' }],
  }));
  assert.ok(spec, 'expected a spec');
  assert.equal(spec.style, 'stack');
  assert.equal(spec.layers.length, 4);
  assert.equal(spec.layers[0].name, 'Input 224×224×3');
  assert.equal(spec.layers[1].out, '112×112×64');
  assert.deepEqual(spec.layers[2].parallel.map((p) => p.name), ['Conv 3×3', 'Conv 1×1']);
  assert.deepEqual(spec.skips, [{ from: 1, to: 3, label: 'residual' }]);
});

test('parseNnBlock: first/last real layers auto-kind to input/output when no explicit kind', () => {
  const spec = parseNnBlock(JSON.stringify({ layers: ['Input', 'Hidden', 'Output'] }));
  assert.equal(spec.layers[0].autoKind, 'input');
  assert.equal(spec.layers[1].autoKind, undefined);
  assert.equal(spec.layers[2].autoKind, 'output');
  // explicit kind wins and suppresses autokind entirely
  const spec2 = parseNnBlock(JSON.stringify({ layers: [{ name: 'A', kind: 'output' }, 'B'] }));
  assert.equal(spec2.layers[0].kind, 'output');
  assert.equal(spec2.layers[1].autoKind, undefined);
  // parallel rows never get autokind
  const spec3 = parseNnBlock(JSON.stringify({ layers: [{ parallel: [{ name: 'a' }, { name: 'b' }] }, 'x', 'y'] }));
  assert.equal(spec3.layers[0].autoKind, undefined);
});

test('parseNnBlock: oversized layer list truncates to 18 with a "+N more" pseudo-row', () => {
  const spec = parseNnBlock(JSON.stringify({ layers: Array.from({ length: 25 }, (_, i) => `L${i}`) }));
  assert.equal(spec.layers.length, 19); // 18 real + the more-row
  assert.equal(spec.layers[18].kind, 'more');
  assert.match(spec.layers[18].name, /\+7 more/);
});

test('parseNnBlock: skips are validated — range, order, truncated-region and cap enforced', () => {
  const spec = parseNnBlock(JSON.stringify({
    layers: Array.from({ length: 25 }, (_, i) => `L${i}`),
    skips: [
      { from: 2, to: 5, label: 'ok' },
      { from: 5, to: 2 },                    // from >= to → dropped
      { from: -1, to: 3 },                   // negative → dropped
      { from: 0, to: 20 },                   // to in truncated region → dropped
      { from: 2, to: 5 },                    // duplicate range, still valid
      { from: 1, to: 2 }, { from: 1, to: 4 }, // first 8 entries now exhausted →
      { from: 2, to: 6 },                     // the cap must not be reachable from here on
      { from: 3, to: 7 }, { from: 4, to: 8 }, { from: 5, to: 9 },
    ],
  }));
  // 5 valid skips exist within the first 8 candidates (slice(0, 8) bound);
  // each surviving skip must reference the DISPLAYED region only.
  assert.equal(spec.skips.length, 5);
  assert.ok(spec.skips.every((s) => s.to < 18 && s.from >= 0 && s.from < s.to));
});

test('parseNnBlock: fcnn spec — neuron counts validated, labels optional', () => {
  const spec = parseNnBlock(JSON.stringify({ style: 'fcnn', layers: [3, 5, 5, 2], labels: ['in', 'h1', 'h2', 'out'] }));
  assert.equal(spec.style, 'fcnn');
  assert.deepEqual(spec.layers, [3, 5, 5, 2]);
  assert.deepEqual(spec.labels, ['in', 'h1', 'h2', 'out']);
  const noLabels = parseNnBlock(JSON.stringify({ style: 'fcnn', layers: [2, 3] }));
  assert.equal(noLabels.labels, null);
  assert.equal(parseNnBlock(JSON.stringify({ style: 'fcnn', layers: [2] })), null, 'needs ≥2 layers');
  assert.equal(parseNnBlock(JSON.stringify({ style: 'fcnn', layers: [2, 1.5] })), null, 'counts must be integers');
  // mismatched labels are TOLERATED by dropping the labels, not the figure
  const mismatched = parseNnBlock(JSON.stringify({ style: 'fcnn', layers: [2, 3], labels: ['only-one'] }));
  assert.equal(mismatched.style, 'fcnn');
  assert.equal(mismatched.labels, null, 'label count mismatch → labels dropped, figure kept');
});

test('parseNnBlock: malformed input returns null everywhere (block stays as code)', () => {
  assert.equal(parseNnBlock(''), null);
  assert.equal(parseNnBlock('not json'), null);
  assert.equal(parseNnBlock('[1,2,3]'), null, 'top-level array rejected');
  assert.equal(parseNnBlock('{"layers":[]}'), null, 'empty layers rejected');
  assert.equal(parseNnBlock('{"layers":[42]}'), null, 'numeric layers rejected in stack style');
  assert.equal(parseNnBlock('{"layers":[{}]}'), null, 'nameless layerless-object rejected');
});

// ── renderNn (jsdom) ─────────────────────────────────────────────────────────

function hostWithBlock(content) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-nn';
  code.textContent = content;
  pre.appendChild(code);
  host.appendChild(pre);
  return { host, pre };
}

test('renderNn: stack block swaps to an .nn-block with boxes, arrows and a toolbar', () => {
  const { host, pre } = hostWithBlock(JSON.stringify({
    layers: ['Input 4', 'Dense 8', 'Dense 3'],
    skips: [{ from: 0, to: 2, label: 'skip' }],
  }));
  renderNn(host);
  const wrapper = host.querySelector('.nn-block');
  assert.ok(wrapper, 'wrapper must replace the pre');
  assert.ok(!host.contains(pre), 'raw pre must be gone');
  const svg = wrapper.querySelector('svg.nn-svg');
  assert.ok(svg, 'figure svg must exist');
  const boxes = [...svg.querySelectorAll('rect')].filter((r) => r.getAttribute('fill') !== 'none');
  assert.equal(boxes.length, 3, 'one box per layer');
  assert.equal(svg.querySelectorAll('text').length >= 3, true, 'layer names rendered');
  assert.equal(svg.querySelectorAll('line[marker-end]').length, 2, 'arrows between rows');
  assert.equal(svg.querySelectorAll('path[stroke-dasharray]').length, 1, 'one skip arc');
  // toolbar: copy + SVG + PNG exports
  const btns = wrapper.querySelectorAll('.mermaid-toolbar .mermaid-btn');
  assert.equal(btns.length, 3);
  assert.equal(wrapper.querySelector('.mermaid-toolbar').textContent.includes('SVG'), true);
});

test('renderNn: parallel group renders side-by-side mini boxes inside a dashed container', () => {
  const { host } = hostWithBlock(JSON.stringify({
    layers: ['In', { name: 'Res', parallel: [{ name: 'Conv 3×3' }, { name: 'Conv 1×1' }] }, 'Out'],
  }));
  renderNn(host);
  const svg = host.querySelector('svg.nn-svg');
  const dashed = [...svg.querySelectorAll('rect')].filter((r) => r.getAttribute('stroke-dasharray') === '4 3');
  assert.equal(dashed.length, 1, 'one dashed group container');
  const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
  assert.deepEqual(texts.filter((t) => t.includes('Conv')), ['Conv 3×3', 'Conv 1×1']);
});

test('renderNn: fcnn block draws full mesh circles with column labels and count abbreviation', () => {
  const { host } = hostWithBlock(JSON.stringify({ style: 'fcnn', layers: [3, 14, 2], labels: ['in', 'h', 'out'] }));
  renderNn(host);
  const svg = host.querySelector('svg.nn-svg');
  assert.ok(svg);
  // 3 + 10 (14 abbreviated to 10) + 2 circles
  assert.equal(svg.querySelectorAll('circle').length, 15);
  // mesh: 3*10 + 10*2
  assert.equal(svg.querySelectorAll('line').length, 50);
  const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
  assert.deepEqual(texts.filter((t) => t === 'in' || t === 'out'), ['in', 'out']);
  assert.ok(texts.some((t) => t === '×14'), 'abbreviated column shows ×14');
});

test('renderNn: truncated stack shows the "+N more" pseudo-row as a dashed row', () => {
  const { host } = hostWithBlock(JSON.stringify({ layers: Array.from({ length: 25 }, (_, i) => `L${i}`) }));
  renderNn(host);
  const texts = [...host.querySelectorAll('svg.nn-svg text')].map((t) => t.textContent);
  assert.ok(texts.some((t) => t.includes('+7 more')), 'pseudo-row text present');
  assert.equal(host.querySelectorAll('svg.nn-svg text').length, 19);
});

test('renderNn: unparseable block is left as raw code (never swallowed)', () => {
  const { host, pre } = hostWithBlock('this is { not json');
  renderNn(host);
  assert.ok(host.contains(pre), 'raw pre must survive a parse failure');
  assert.equal(host.querySelector('.nn-block'), null);
});

test('renderNn: non-nn code blocks in the host are untouched', () => {
  const { host } = hostWithBlock('{"layers":["a"]}');
  host.querySelector('code').className = 'language-python';
  renderNn(host);
  assert.equal(host.querySelector('.nn-block'), null);
  assert.ok(host.querySelector('pre'), 'non-nn pre must survive untouched');
});
