// test/lib-chem-render.test.mjs — tests for render.js's chemistry/biostructure
// renderers: renderSmiles (RDKit, 2D structure/reaction diagrams + descriptors)
// and renderPdb (Mol* WebGL viewer for RCSB PDB / AlphaFold DB structures),
// following the same "model emits a fenced block → pipeline swaps it for a
// live render" pattern as mermaid/echarts/markmap.
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

// jsdom has no ResizeObserver — renderPdb now creates one per viewer (drag
// resize → molstar requestResize). This recorder lets tests fire the callback
// and assert the wiring.
const roRecord = [];
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.observed = []; roRecord.push(this); }
  observe(el) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
  unobserve() {}
  fire() { this.cb(); }
};

const { parsePdbBlock, renderSmiles, renderPdb, getRDKit, rethemeRdkitSvg, getMolstar, disposeMolstarViewers, disposeRenderInstancesIn } = await import('../lib/sidepanel/render.js');

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
          canvas3d: { requestResize: () => stubState.calls.push(['requestResize']) },
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

// ─── renderSmiles (mock RDKit) ───────────────────────────────────────────────

// getRDKit caches its promise module-level — the initRDKitModule stub must be
// installed ONCE before any renderSmiles test; the factory returns the stub
// module whose surface mirrors exactly what renderSmiles touches:
// get_mol/get_rxn (null = chemically invalid) → get_svg/get_descriptors/delete.
const stubSvg = `<?xml version='1.0'?><svg version='1.1' width='300px' height='220px' viewBox='0 0 300 220'><rect style='opacity:1.0;fill:#FFFFFF;stroke:none'/><path style='fill:none;stroke:#000000'/></svg>`;
const stubDescriptors = JSON.stringify({ amw: 180.159, CrippenClogP: 1.31, tpsa: 63.6, NumHBD: 1, NumHBA: 4 });
const stubMol = {
  is_valid: () => true,
  get_svg: (w, h) => stubSvg.replace('300px', w + 'px').replace(/viewBox='([^']*)'/, `viewBox='0 0 ${w} ${h}'`),
  get_descriptors: () => stubDescriptors,
  delete() {},
};
const stubRxn = { get_svg: (w, h) => stubSvg, delete() {} };
dom.window.initRDKitModule = () => Promise.resolve({
  get_mol: (smi) => (String(smi).startsWith('BAD') ? null : stubMol),
  get_rxn: (smi) => (String(smi).startsWith('BAD') ? null : stubRxn),
});

test('getRDKit: resolves a module exposing get_mol/get_rxn', async () => {
  const rdk = await getRDKit();
  assert.equal(typeof rdk.get_mol, 'function');
  assert.equal(typeof rdk.get_rxn, 'function');
});

test('renderSmiles: valid molecule → RDKit SVG with rethemed background, property caption, toolbar', async () => {
  const aspirin = 'CC(=O)OC1=CC=CC=C1C(=O)O';
  document.body.innerHTML = '';
  const pre = makeFence('smiles', aspirin);
  await renderSmiles(document.body);

  const block = document.querySelector('.smiles-block');
  assert.ok(block, 'the fence is replaced by a .smiles-block');
  const svg = block.querySelector('svg.smiles-svg');
  assert.ok(svg, 'the drawing is an inline svg');
  assert.ok(!svg.outerHTML.includes('?xml'), 'the xml prolog is stripped for innerHTML');
  assert.ok(svg.outerHTML.includes("fill:none"), 'the white background rect is dropped (bubble bg shows through)');
  assert.ok(!block.querySelector('.smiles-caption') === false, 'molecules get a caption');
  const caption = block.querySelector('.smiles-caption');
  assert.equal(caption.querySelectorAll('.smiles-caption-chip').length, 4);
  assert.ok(caption.textContent.includes('MW') && caption.textContent.includes('180.16'), 'MW chip carries the descriptor value');
  assert.ok(caption.textContent.includes('HBD/HBA') && caption.textContent.includes('1/4'), 'HBD/HBA chip');
  assert.ok(block.querySelector('.mermaid-toolbar'), 'copy/export toolbar present');
  assert.ok(!document.body.contains(pre), 'the original fence is gone on success');
});

test('renderSmiles: chemically invalid SMILES → explicit error note, raw block kept', async () => {
  document.body.innerHTML = '';
  const bad = 'BAD(C)(C)(C)O';
  const pre = makeFence('smiles', bad);
  await renderSmiles(document.body);
  await renderSmiles(document.body); // DONE + 历史升级会各跑一次

  assert.equal(document.querySelectorAll('.smiles-block').length, 0, 'no viewer block');
  assert.equal(document.querySelectorAll('.smiles-error').length, 1, 'the note is inserted exactly once across double renders');
  const note = document.querySelector('.smiles-error');
  assert.ok(note, 'the invalid-structure note is shown');
  assert.ok(note.textContent.length > 0);
  assert.ok(document.body.contains(pre), 'the raw source stays readable');
  assert.equal(pre.querySelector('code').textContent, bad);
});

test('rethemeRdkitSvg: transparent bg both themes, light ink in dark, prolog stripped', () => {
  const raw = `<?xml version='1.0'?><svg version='1.1' viewBox='0 0 300 220'><rect style='opacity:1.0;fill:#FFFFFF;stroke:none'/><path style='fill:none;stroke:#000000'/><text style='fill:#000000'>O</text></svg>`;
  const light = rethemeRdkitSvg(raw, false);
  assert.ok(!light.includes('?xml'), 'the xml prolog is stripped for innerHTML');
  assert.ok(light.startsWith('<svg'), 'starts at the svg element');
  assert.ok(light.includes('fill:none'), 'the white background rect is dropped');
  assert.ok(light.includes('#000000'), 'ink stays black in light mode');
  const dark = rethemeRdkitSvg(raw, true);
  assert.ok(!dark.includes('#000000'), 'black ink is rewritten in dark mode');
  assert.ok(dark.includes('#E1E1E6'), 'dark ink is the light gray');
  assert.ok(dark.includes('fill:none'), 'background stays dropped in dark mode');
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

test('renderPdb: viewer container resize fires molstar requestResize (drag-resize wiring)', async () => {
  document.body.innerHTML = '';
  const calls = stubState.calls; calls.length = 0;
  globalThis.fetch = async () => ({ ok: true, text: async () => 'ATOM      1  N   ALA A   1\n' });

  makeFence('pdb', '1UBQ');
  await renderPdb(document.body);
  delete globalThis.fetch;

  const observers = roRecord.filter((ro) => ro.observed.some((el) => el.classList.contains('pdb-viewer')));
  assert.ok(observers.length >= 1, 'a ResizeObserver must watch the .pdb-viewer container');
  calls.length = 0;
  observers[observers.length - 1].fire();
  assert.ok(calls.some((c) => c[0] === 'requestResize'), 'container resize must drive canvas3d.requestResize (molstar ignores its own container)');
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
// Since the RDKit swap (2026-09-29) reactions draw via get_rxn → Reaction.
// get_svg; reactions carry no descriptors, so no caption.

test('renderSmiles: reaction fence routes to get_rxn and renders WITHOUT a property caption', async () => {
  document.body.innerHTML = '';
  const reaction = 'CC(=O)O.CCO>>CCOC(=O)CC.O';
  const pre = makeFence('smiles', reaction);
  await renderSmiles(document.body);

  const wrapper = document.querySelector('.smiles-block');
  assert.ok(wrapper, 'a valid reaction renders');
  assert.ok(wrapper.querySelector('svg.smiles-svg'), 'the reaction drawing is an inline svg');
  assert.ok(!wrapper.querySelector('canvas'), 'never a canvas');
  assert.ok(!wrapper.querySelector('.smiles-caption'), 'reactions carry no descriptor caption');
  assert.ok(!document.body.contains(pre), 'the original fence is gone on success');
});

test('renderSmiles: chemically invalid reaction → error note, raw block kept', async () => {
  document.body.innerHTML = '';
  const pre = makeFence('smiles', 'BAD>>WORSE');
  await renderSmiles(document.body);
  assert.equal(document.querySelectorAll('.smiles-block').length, 0, 'no viewer block');
  assert.ok(document.querySelector('.smiles-error'), 'the invalid-structure note is shown');
  assert.ok(document.body.contains(pre), 'the raw source stays readable');
});

test('disposeRenderInstancesIn: deleting a bubble frees its Mol* viewer without touching the sibling (批C 定向 dispose)', async () => {
  // 单删/多选/重生成/追问卡关闭都是裸 el.remove()——此前 dispose 只挂在
  // renderHistory 的全局清扫上，删掉一个 ```pdb 气泡会留下一个持续 rAF 渲染
  // 的离屏 WebGL context（浏览器上限 ~16 个）。
  document.body.innerHTML = '';
  stubState.calls.length = 0;
  globalThis.fetch = async () => ({ ok: true, text: async () => 'ATOM      1  N   ALA A   1\n' });

  const bubbleA = document.createElement('div'); bubbleA.className = 'msg assistant';
  const bubbleB = document.createElement('div'); bubbleB.className = 'msg assistant';
  document.body.append(bubbleA, bubbleB);
  bubbleA.appendChild(makeFence('pdb', '1UBQ'));
  await renderPdb(document.body);
  const viewerA = stubState.lastViewer;
  bubbleB.appendChild(makeFence('pdb', '1UBQ'));
  await renderPdb(document.body);
  const viewerB = stubState.lastViewer;
  assert.notEqual(viewerA, viewerB, 'two renders create two distinct viewers');

  disposeRenderInstancesIn(bubbleA);
  bubbleA.remove();
  assert.ok(viewerA.disposed, "bubble A's viewer is freed the moment its bubble is deleted");
  assert.equal(viewerB.disposed, false, "the sibling bubble's viewer keeps running");

  // 幂等 + 空作用域安全
  disposeRenderInstancesIn(bubbleA);
  disposeRenderInstancesIn(null);
  delete globalThis.fetch;
});
