// test/lib-rdkit-render.test.mjs — REAL execution tests for the vendored
// RDKit MinimalLib WASM (lib/vendor/RDKit_minimal.*), following the
// lib-pdf-inspector-wasm precedent: plain WebAssembly runs directly in Node,
// so the vendor's actual chemistry behavior is execution-tested, not just its
// API shape. These pin the exact assumptions render.js's renderSmiles is
// built on:
//   - get_mol returns a Mol for valid SMILES and NULL for chemically
//     impossible input (the anti-hallucination validator),
//   - get_svg returns an inline <svg> with a viewBox and a white background
//     rect + black ink in style attributes (what rethemeRdkitSvg rewrites),
//   - get_descriptors carries the property-line keys (exactmw/CrippenClogP/
//     tpsa/NumHBD/NumHBA),
//   - get_rxn draws reaction SMILES (the '>' routing target).
// No jsdom here on purpose: the emscripten glue picks its environment from
// globals, and node-mode wasm loading (fs read) must not be skewed by a fake
// window before init.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const initRDKitModule = (await import('../lib/vendor/RDKit_minimal.js')).default;
const rdk = await initRDKitModule();

test('RDKit wasm initializes and reports its version', () => {
  assert.ok(rdk.version(), 'version string present');
  assert.match(rdk.version(), /^\d{4}\./, 'RDKit calendar-versioned (e.g. 2026.03)');
});

test('get_mol: valid SMILES parses; canonical form and InChIKey come back', () => {
  const mol = rdk.get_mol('CC(=O)OC1=CC=CC=C1C(=O)O'); // aspirin, scrambled input order
  assert.ok(mol, 'aspirin parses');
  assert.equal(mol.get_smiles(), 'CC(=O)Oc1ccccc1C(=O)O', 'canonical SMILES is order-independent');
  const inchikey = rdk.get_inchikey_for_inchi(mol.get_inchi());
  assert.equal(inchikey, 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N', 'aspirin InChIKey');
  mol.delete();
});

test('get_mol: chemically impossible SMILES returns NULL (the validator)', () => {
  assert.equal(rdk.get_mol('CC(C)(C)(C)O'), null, 'pentavalent carbon is rejected');
  assert.equal(rdk.get_mol('not a smiles at all'), null, 'garbage is rejected');
});

test('get_descriptors: the property-line keys exist with sane aspirin values', () => {
  const mol = rdk.get_mol('CC(=O)OC1=CC=CC=C1C(=O)O');
  const desc = JSON.parse(mol.get_descriptors());
  assert.ok(Math.abs(desc.amw - 180.159) < 0.01, 'amw (average MW) ≈ 180.16 — the caption value');
  assert.ok(Math.abs(desc.exactmw - 180.042) < 0.01, 'exactmw (monoisotopic) ≈ 180.04');
  assert.ok(Math.abs(desc.CrippenClogP - 1.31) < 0.1, 'CrippenClogP ≈ 1.31');
  assert.ok(Math.abs(desc.tpsa - 63.6) < 0.1, 'tpsa ≈ 63.6');
  assert.equal(desc.NumHBD, 1, 'one H-bond donor');
  assert.equal(desc.NumHBA, 3, 'three H-bond acceptors (RDKit count)');
  mol.delete();
});

test('get_svg: inline SVG with viewBox, white bg rect and black ink (retheme inputs)', () => {
  const mol = rdk.get_mol('CC(=O)OC1=CC=CC=C1C(=O)O');
  const svg = mol.get_svg(320, 230);
  mol.delete();
  assert.ok(svg.includes("<svg version='1.1'"), 'svg element present');
  assert.ok(svg.includes("viewBox='0 0 320 230'"), 'viewBox matches the requested size (CSS-scalable)');
  assert.ok(svg.includes('fill:#FFFFFF'), 'white background rect (rethemeRdkitSvg drops it)');
  assert.ok(svg.includes('#000000'), 'black ink (rethemeRdkitSvg lightens it in dark mode)');
});

test('get_rxn: reaction SMILES render too (the ">" routing target)', () => {
  const rxn = rdk.get_rxn('CC(=O)O.CCO>>CCOC(=O)CC.O'); // acid + alcohol → ester + water
  assert.ok(rxn, 'the esterification parses as a reaction');
  const svg = rxn.get_svg(420, 200);
  assert.ok(svg.includes("<svg version='1.1'"), 'reaction svg present');
  assert.ok(svg.length > 2000, 'reaction drawing has real content (multiple species + arrow)');
  rxn.delete();
});
