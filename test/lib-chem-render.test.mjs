// test/lib-chem-render.test.mjs — tests for render.js's chemistry/biostructure
// renderers: renderSmiles (smiles-drawer, 2D structure diagrams) and renderPdb
// (Mol* WebGL viewer for RCSB PDB / AlphaFold DB structures), following the
// same "model emits a fenced block → pipeline swaps it for a live render"
// pattern as mermaid/echarts/markmap.
//
// jsdom has no canvas/WebGL, so the canvas/WebGL drawing itself can't execute
// here — what IS execution-tested: parsePdbBlock's classification, the
// vendor loaders, the fence→wrapper swap, the RCSB/AlphaFold fetch shapes,
// the builder/preset calls against a mock (incl. WHICH preset id runs for
// AlphaFold vs plain structures), and every failure path restoring the
// original code block (the raw SMILES/PDB text must never disappear).

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

const { parsePdbBlock, renderSmiles, renderPdb, getSmilesDrawer, getMolstar, disposeMolstarViewers } = await import('../lib/sidepanel/render.js');

// getMolstar caches its promise module-level (correct in the browser — one
// lib), so the molstar stub must be installed ONCE and shared by every
// renderPdb test; each test clears `stubState.calls` instead of re-stubbing.
// The stub mirrors the exact surface renderPdb touches:
// Viewer.create(el, opts) → viewer.plugin.builders.{data.rawData,
// structure.parseTrajectory, structure.hierarchy.applyPreset} + dispose().
const stubState = { calls: [], failPreset: false };
dom.window.molstar = {
  Viewer: {
    create: async (el, opts) => {
      stubState.calls.push(['create', el, opts]);
      if (stubState.failCreate) throw new Error('webgl unavailable');
      const viewer = {
        disposed: false,
        dispose() { viewer.disposed = true; stubState.calls.push(['dispose']); },
        plugin: {
          builders: {
            data: { rawData: async ({ data, label }) => { stubState.calls.push(['rawData', data, label]); return 'data-cell'; } },
            structure: {
              parseTrajectory: async (cell, fmt) => { stubState.calls.push(['parseTrajectory', fmt]); return 'traj-cell'; },
              hierarchy: {
                applyPreset: async (traj, preset, params) => {
                  if (stubState.failPreset) throw new Error('preset boom');
                  stubState.calls.push(['applyPreset', preset, params]);
                }
              }
            }
          }
        }
      };
      stubState.lastViewer = viewer;
      return viewer;
    }
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

// ─── renderPdb (mock molstar + mock RCSB fetch) ─────────────────────────────

test('getMolstar: resolves the lib exposing Viewer.create', async () => {
  const lib = await getMolstar();
  assert.equal(typeof lib.Viewer.create, 'function');
});

test('renderPdb: bare PDB ID → fetches RCSB, swaps the fence for a viewer, drives the Mol* builders', async () => {
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
  assert.equal(calls.filter((c) => c[0] === 'create').length, 1);
  const cfg = calls.find((c) => c[0] === 'create')[2];
  assert.equal(cfg.layoutShowSequence, true, 'the sequence strip (RCSB feel) is on');
  assert.equal(cfg.layoutShowControls, true, 'controls stay on — their gating also owns the top sequence strip');
  assert.equal(cfg.layoutShowLeftPanel, false, 'the left panel is off');
  assert.equal(cfg.viewportBackgroundColor, 'white', 'light-mode background (matchMedia stub: not dark)');
  assert.equal(cfg.pdbProvider, 'rcsb');
  assert.equal(calls.find((c) => c[0] === 'rawData')[1], 'HEADER    TEST\nATOM      1  N   ALA A   1\nEND', 'the fetched payload feeds rawData');
  assert.equal(calls.find((c) => c[0] === 'parseTrajectory')[1], 'pdb');
  assert.equal(calls.find((c) => c[0] === 'applyPreset')[1], 'default', 'the default trajectory-hierarchy preset drives model/structure/representation in one call');
  assert.equal(calls.find((c) => c[0] === 'applyPreset')[2]?.representationPreset, 'preset-structure-representation-auto', 'plain structures use the standard auto representation preset');
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
  assert.equal(calls.find((c) => c[0] === 'rawData')[1], payload);
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

test('renderPdb: a preset failure after Viewer.create restores the block AND disposes the viewer', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  stubState.failPreset = true;
  globalThis.fetch = async () => ({ ok: true, text: async () => 'ATOM      1  N   ALA A   1\n' });

  const pre = makeFence('pdb', '1UBQ');
  await renderPdb(document.body);

  assert.ok(document.body.contains(pre), 'a failed preset must restore the original fence');
  assert.equal(document.querySelectorAll('.pdb-block').length, 0, 'no broken viewer left in the DOM');
  assert.ok(stubState.lastViewer.disposed, 'the created viewer is disposed (WebGL context freed)');
  stubState.failPreset = false;
  delete globalThis.fetch;
});

test('disposeMolstarViewers: disposes every live viewer from prior renders', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  globalThis.fetch = async () => ({ ok: true, text: async () => 'ATOM      1  N   ALA A   1\n' });

  makeFence('pdb', '1UBQ');
  await renderPdb(document.body);
  const before = stubState.lastViewer.disposed;
  disposeMolstarViewers();
  assert.equal(before, false, 'the viewer was live after a successful render');
  assert.ok(stubState.lastViewer.disposed, 'disposeMolstarViewers disposed it');
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

// ─── AlphaFold predicted models (2026-09-18) ────────────────────────────────
// ```pdb also accepts an AlphaFold DB model ID (AF-{UniProt accession}-F{n})
// or a bare UniProt accession. The current model file URL can ONLY come from
// the DB's API — model versions advance (P00533 is at v6; a hardcoded v4
// file URL 404s), so the render fetches the API first, then the file it
// names. Since the Mol* swap (2026-09-29) pLDDT coloring (the PDB B-factor
// column) is molstar's OWN plddt-confidence preset — the palette lives in
// the vendor, byte-identical to AlphaFold DB's four bands; our compact
// legend strip stays as the visible key.

test('parsePdbBlock: AlphaFold model IDs and bare UniProt accessions → {kind:alphafold}', () => {
  assert.deepEqual(parsePdbBlock('AF-P00533-F1'), { kind: 'alphafold', value: 'AF-P00533-F1' });
  assert.deepEqual(parsePdbBlock('af-p00533-f1\n'), { kind: 'alphafold', value: 'AF-P00533-F1' }, 'case is normalized');
  assert.deepEqual(parsePdbBlock('AF-P00533-F1-model_v4'), { kind: 'alphafold', value: 'AF-P00533-F1' }, 'the filename version suffix is stripped');
  assert.deepEqual(parsePdbBlock('AF-Q818B4-F2'), { kind: 'alphafold', value: 'AF-Q818B4-F2' }, 'multi-model entries keep their F number');
  assert.deepEqual(parsePdbBlock('P00533'), { kind: 'alphafold', value: 'AF-P00533-F1' }, 'a bare accession defaults to F1');
  assert.equal(parsePdbBlock('AF-123456-F1'), null, 'the accession must match the UniProt grammar');
  assert.equal(parsePdbBlock('AF-P00533'), null, 'missing the -F<n> part is not a model ID');
  assert.equal(parsePdbBlock('AF-P0053-F1'), null, 'accessions are 6+ chars');
  // No regression on the pre-existing branches.
  assert.deepEqual(parsePdbBlock('1UBQ'), { kind: 'id', value: '1UBQ' });
  assert.equal(parsePdbBlock('HEADER    X\nATOM      1  N   ALA A   1\n').kind, 'data');
});

test('renderPdb: AlphaFold ID → API resolves the CURRENT file, pLDDT preset + legend', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  const pdbText = 'HEADER    AF\nATOM      1  N   ALA A   1      1.04  97.31\nEND';
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://www.alphafold.ebi.ac.uk/api/prediction/P00533') {
      return { ok: true, json: async () => [{ modelEntityId: 'AF-P00533-F1', pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb' }] };
    }
    return { ok: true, text: async () => pdbText };
  };

  const pre = makeFence('pdb', 'AF-P00533-F1');
  await renderPdb(document.body);

  const block = document.querySelector('.pdb-block');
  assert.ok(block, 'the fence is replaced by a viewer block');
  assert.equal(calls.find((c) => c[0] === 'applyPreset')[2]?.representationPreset, 'preset-structure-representation-ma-quality-assessment-plddt',
    'AlphaFold models use molstar\'s built-in pLDDT-confidence preset');
  assert.equal(calls.find((c) => c[0] === 'rawData')[1], pdbText, 'the API-resolved file is the loaded model');
  const legend = block.querySelector('.pdb-legend');
  assert.ok(legend, 'the four-band confidence legend is shown');
  assert.equal(legend.querySelectorAll('.pdb-legend-chip').length, 4);
  assert.ok(!document.body.contains(pre), 'the original fence is gone on success');
  delete globalThis.fetch;
});

test('renderPdb: AlphaFold API failure (unknown accession) restores the raw code block', async () => {
  document.body.innerHTML = '';
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  const pre = makeFence('pdb', 'AF-P99999-F1');
  await renderPdb(document.body);

  assert.ok(document.body.contains(pre), 'a failed API call must restore the original fence');
  assert.equal(document.querySelectorAll('.pdb-block').length, 0, 'no broken viewer left in the DOM');
  delete globalThis.fetch;
});

test('renderPdb: when the requested F model is absent, the first entry is used', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/prediction/')) {
      return {
        ok: true,
        json: async () => [{ modelEntityId: 'AF-Q9Y2I8-F1', pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-Q9Y2I8-F1-model_v4.pdb' }],
      };
    }
    return { ok: true, text: async () => 'ATOM      1  N   ALA A   1\n' };
  };

  makeFence('pdb', 'AF-Q9Y2I8-F3');
  await renderPdb(document.body);

  assert.ok(document.querySelector('.pdb-block'), 'degrades to F1 instead of dying on a missing F3');
  assert.equal(calls.filter((c) => c[0] === 'create').length, 1);
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
