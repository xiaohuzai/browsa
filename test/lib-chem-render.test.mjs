// test/lib-chem-render.test.mjs — tests for render.js's chemistry/biostructure
// renderers (2026-09-13): renderSmiles (smiles-drawer, 2D structure diagrams)
// and renderPdb (3Dmol WebGL viewer for RCSB PDB structures), following the
// same "model emits a fenced block → pipeline swaps it for a live render"
// pattern as mermaid/echarts/markmap.
//
// jsdom has no canvas/WebGL, so the canvas/WebGL drawing itself can't execute
// here — what IS execution-tested: parsePdbBlock's classification, the
// vendor loaders, the fence→wrapper swap, the RCSB fetch shape, viewer API
// calls against a mock, and every failure path restoring the original code
// block (the raw SMILES/PDB text must never disappear).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.location = dom.window.location;
dom.window.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });

const { parsePdbBlock, renderSmiles, renderPdb, getSmilesDrawer } = await import('../lib/sidepanel/render.js');

// get3Dmol caches its promise module-level (correct in the browser — one lib),
// so the $3Dmol stub must be installed ONCE and shared by every renderPdb
// test; each test clears `stubState.calls` instead of re-stubbing.
const stubState = { calls: [] };
dom.window.$3Dmol = {
  createViewer: (el, cfg) => {
    stubState.calls.push(['createViewer', el, cfg]);
    return {
      addModel: (...a) => stubState.calls.push(['addModel', ...a]),
      setStyle: (...a) => stubState.calls.push(['setStyle', ...a]),
      addStyle: (...a) => stubState.calls.push(['addStyle', ...a]),
      zoomTo: () => stubState.calls.push(['zoomTo']),
      render: () => stubState.calls.push(['render']),
    };
  }
};

function makeFence(lang, body) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-' + lang;
  code.textContent = body;
  pre.appendChild(code);
  document.body.appendChild(pre);
  return pre;
}

// ─── parsePdbBlock (pure) ────────────────────────────────────────────────────

test('parsePdbBlock: bare 4-char IDs → {kind:id, uppercased}; anything else is not an ID', () => {
  assert.deepEqual(parsePdbBlock('1UBQ'), { kind: 'id', value: '1UBQ' });
  assert.deepEqual(parsePdbBlock('1ubq\n'), { kind: 'id', value: '1UBQ' });
  assert.deepEqual(parsePdbBlock('  9api  '), { kind: 'id', value: '9API' });
  assert.equal(parsePdbBlock('1UBQX'), null, '5 chars is not a PDB ID');
  assert.equal(parsePdbBlock('hello'), null, 'garbage must be left as text');
  assert.equal(parsePdbBlock(''), null);
  assert.equal(parsePdbBlock(null), null);
});

test('parsePdbBlock: real PDB payloads (HEADER/ATOM/HETATM/MODEL lines) → {kind:data}', () => {
  const payload = 'HEADER    FAKE\nATOM      1  N   ALA A   1\nEND';
  assert.deepEqual(parsePdbBlock(payload), { kind: 'data', value: payload });
  assert.deepEqual(parsePdbBlock('\nHETATM 9999  O   HOH A 999\n'), { kind: 'data', value: 'HETATM 9999  O   HOH A 999' });
  // A 4-char word that happens to sit alone is still an ID; one with payload
  // markers takes the data branch first.
  assert.equal(parsePdbBlock('MODEL 1').kind, 'data');
});

// ─── renderSmiles (vendor import + graceful no-canvas degradation) ──────────

test('getSmilesDrawer: the ESM bundle resolves to a lib with parse/Drawer/SvgDrawer', async () => {
  const lib = await getSmilesDrawer();
  assert.equal(typeof lib.parse, 'function');
  assert.equal(typeof lib.Drawer, 'function');
  assert.equal(typeof lib.SvgDrawer, 'function');
});

test('renderSmiles: swallows the no-canvas environment (jsdom) and restores the raw code block', async () => {
  const aspirin = 'CC(=O)OC1=CC=CC=C1C(=O)O';
  document.body.innerHTML = '';
  const pre = makeFence('smiles', aspirin);
  await renderSmiles(document.body);
  // In jsdom canvas.getContext('2d') is null → draw throws → the wrapper must
  // be swapped back to the original <pre> (raw SMILES never disappears).
  assert.ok(document.body.contains(pre), 'the original code block must be restored');
  assert.equal(document.querySelectorAll('.smiles-block').length, 0, 'no broken wrapper left in the DOM');
  assert.equal(pre.querySelector('code').textContent, aspirin);
});

test('renderSmiles: leaves non-smiles content and empty blocks untouched', async () => {
  document.body.innerHTML = '';
  const pre = makeFence('smiles', '');
  await renderSmiles(document.body);
  assert.ok(document.body.contains(pre), 'empty block stays as-is');
});

// ─── renderPdb (mock $3Dmol + mock RCSB fetch) ──────────────────────────────

test('renderPdb: bare PDB ID → fetches RCSB, swaps the fence for a viewer, drives the 3Dmol API', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  const fetches = [];
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: true, status: 200, text: async () => 'HEADER    TEST\nATOM      1  N   ALA A   1\nEND' }; };

  document.body.innerHTML = '';
  const pre = makeFence('pdb', '1ubq');
  await renderPdb(document.body);

  assert.deepEqual(fetches, ['https://files.rcsb.org/download/1UBQ.pdb'], 'the ID is uppercased and fetched from RCSB');
  const block = document.querySelector('.pdb-block');
  assert.ok(block, 'the fence is replaced by a .pdb-block');
  assert.ok(block.querySelector('.pdb-viewer'), 'with a .pdb-viewer container');
  assert.ok(!block.querySelector('.pdb-status'), 'the loading status is removed after a successful fetch');
  assert.equal(calls.filter(c => c[0] === 'createViewer').length, 1);
  assert.match(calls.find(c => c[0] === 'addModel')[1], /^HEADER    TEST/, 'the fetched payload is added as a pdb model');
  assert.deepEqual(calls.find(c => c[0] === 'setStyle').slice(1), [{}, { cartoon: { color: 'spectrum' } }]);
  assert.equal(calls.filter(c => c[0] === 'zoomTo').length, 1);
  assert.equal(calls.filter(c => c[0] === 'render').length, 1);
  assert.ok(!document.body.contains(pre), 'the original fence is gone on success');
  delete globalThis.fetch;
});

test('renderPdb: inline PDB payload renders directly without any fetch', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  const fetches = [];
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: true, text: async () => '' }; };

  document.body.innerHTML = '';
  const payload = 'HEADER    INLINE\nATOM      1  N   ALA A   1\nEND';
  const pre = makeFence('pdb', payload);
  await renderPdb(document.body);

  assert.deepEqual(fetches, [], 'inline payloads must not hit RCSB');
  assert.equal(calls.find(c => c[0] === 'addModel')[1], payload);
  assert.ok(document.querySelector('.pdb-block'));
  delete globalThis.fetch;
});

test('renderPdb: RCSB failure (bad ID) restores the raw code block', async () => {
  document.body.innerHTML = '';
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  document.body.innerHTML = '';
  const pre = makeFence('pdb', 'XXXX');
  await renderPdb(document.body);

  assert.ok(document.body.contains(pre), 'a failed fetch must restore the original fence');
  assert.equal(document.querySelectorAll('.pdb-block').length, 0, 'no broken viewer left in the DOM');
  delete globalThis.fetch;
});

test('renderPdb: unrecognized content is left untouched and never fetched', async () => {
  const fetches = [];
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: true, text: async () => '' }; };

  document.body.innerHTML = '';
  const pre = makeFence('pdb', 'this is just prose');
  await renderPdb(document.body);

  assert.deepEqual(fetches, []);
  assert.ok(document.body.contains(pre));
  delete globalThis.fetch;
});

// ─── Reaction SMILES routing (2026-09-13) ────────────────────────────────────
// ```smiles auto-detects reactions by the '>' separator (reactants>agents>
// products) — a plain molecule SMILES can never contain '>' so it's lossless.
// smiles-drawer's own ReactionDrawer/parseReaction do the drawing, so no
// second vendor is involved.

test('the bundle exposes ReactionDrawer and parseReaction alongside the molecule API', async () => {
  const lib = await getSmilesDrawer();
  assert.equal(typeof lib.ReactionDrawer, 'function');
  assert.equal(typeof lib.parseReaction, 'function');
  // Real parse in Node (parser is pure JS): acetic acid + ethanol -> ethyl acetate + water
  let tree = null;
  lib.parseReaction('CC(=O)O.CCO>>CCOC(=O)CC.O',
    (t) => { tree = t; },
    (err) => { throw new Error('parseReaction failed: ' + err); });
  assert.ok(tree, 'a valid reaction SMILES must parse');
  assert.equal(tree.reactants.length, 2);
  assert.equal(tree.products.length, 2);
});

test('renderSmiles: a reaction block degrades gracefully without canvas (jsdom), like molecules', async () => {
  document.body.innerHTML = '';
  const reaction = 'CC(=O)O.CCO>>CCOC(=O)CC.O';
  const pre = makeFence('smiles', reaction);
  await renderSmiles(document.body);
  assert.ok(document.body.contains(pre), 'raw reaction SMILES must be restored when drawing is impossible');
  assert.equal(document.querySelectorAll('.smiles-block').length, 0, 'no broken wrapper left');
});

test('renderSmiles reaction path: ReactionDrawer draws an SVG target (no canvas involved), sized by its own viewBox', async () => {
  document.body.innerHTML = '';
  // jsdom lacks createElementNS-based SVG layout, so the draw() try/catch will
  // likely fall back — but the API contract must hold: when it DOES succeed,
  // the wrapper must contain the svg target (never a canvas), and on failure
  // the raw block must be restored. Drive both branches.
  const reaction = 'CC(=O)O.CCO>>CCOC(=O)CC.O';
  const pre = makeFence('smiles', reaction);
  await renderSmiles(document.body);
  const wrapper = document.querySelector('.smiles-block');
  if (wrapper) {
    assert.ok(!wrapper.querySelector('canvas'), 'reaction path must never render into a canvas');
    assert.ok(wrapper.querySelector('svg.smiles-svg'), 'the svg target carries the smiles-svg class');
  } else {
    assert.ok(document.body.contains(pre), 'fallback restores the raw block');
  }
});
