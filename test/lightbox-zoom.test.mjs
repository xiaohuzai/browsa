// test/lightbox-zoom.test.mjs — the cursor-anchored pan/zoom physics
// (lib/sidepanel/lightbox-zoom.js, 2026-10-17 motion pass). Pure math only:
// jsdom has no real pointer/wheel pipelining, so the DOM wiring is kept to a
// source pin on sidepanel.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ZOOM_SNAP_MAX,
  ZOOM_DEFAULT_JUMP,
  DRAG_DEADZONE_PX,
  clampScale,
  wheelNextScale,
  anchorTranslate,
  maxPan,
  clampPan,
  attachLightboxZoom,
} from '../lib/sidepanel/lightbox-zoom.js';

test('clampScale: floors at 1, caps at maxScale, tolerates maxScale < 1 input', () => {
  assert.equal(clampScale(0.5, 4), 1);
  assert.equal(clampScale(9, 4), 4);
  assert.equal(clampScale(2.5, 4), 2.5);
  assert.equal(clampScale(2, 0.5), 1); // maxScale floor
});

test('wheelNextScale: exponential response (CDS), zoom-in on negative deltaY', () => {
  assert.ok(Math.abs(wheelNextScale(1, -100, 8) - Math.exp(1)) < 1e-9);
  assert.ok(Math.abs(wheelNextScale(2, -100, 8) - 2 * Math.exp(1)) < 1e-9);
  assert.equal(wheelNextScale(2, 100, 8), 1); // zoom-out never dips below 1
  assert.equal(wheelNextScale(1, 100, 8), 1); // never below 1
  assert.equal(wheelNextScale(7, -500, 8), 8); // capped at maxScale
});

test('anchorTranslate: the point under the cursor stays visually fixed', () => {
  // visual position of an element-space point p is p + translate. Keep the
  // cursor point o fixed across a scale change:
  const o = 120, scale = 1, nextScale = 2;
  const { tx } = anchorTranslate({ offsetX: o, offsetY: 0, tx: 0, ty: 0, scale, nextScale });
  // invariant: the element-space point under the cursor ((o - tx)/scale) keeps
  // its VISUAL position after the zoom: p*next + tx' === o
  const p = (o - 0) / scale;
  assert.ok(Math.abs(p * nextScale + tx - o) < 1e-9);
  // works from a panned state too: tx=-40 at scale 2 → cursor over p=(120+40)/2=80
  const panned = anchorTranslate({ offsetX: o, offsetY: 0, tx: -40, ty: 0, scale: 2, nextScale: 4 });
  assert.ok(Math.abs(((o + 40) / 2) * 4 + panned.tx - o) < 1e-9);
});

test('maxPan: no slack at scale 1, taper below the snap threshold, raw formula at full zoom', () => {
  const fit = 400, vp = 400;
  assert.equal(maxPan(fit, 1, vp), 0);
  assert.equal(maxPan(fit, 1.04, vp), 0); // inside the snap band → locked
  // taper below 1: scale 1.5 → raw 100 × taper (1.5-1.05)/0.95 ≈ 47.4 (< raw)
  assert.ok(Math.abs(maxPan(fit, 1.5, vp) - 100 * (0.45 / 0.95)) < 1e-9);
  assert.ok(maxPan(fit, 1.5, vp) < maxPan(fit, 2, vp));
  // scale 2: raw = (400*2-400)/2 = 200, taper = min(1,(2-1.05)/0.95)=1
  assert.ok(Math.abs(maxPan(fit, 2, vp) - 200) < 1e-9);
});

test('clampPan: symmetric clamp per axis', () => {
  const c = clampPan({ tx: 999, ty: -999, fitW: 400, fitH: 300, scale: 2, viewportW: 400, viewportH: 300 });
  assert.ok(Math.abs(c.tx - 200) < 1e-9);
  assert.ok(Math.abs(c.ty + 150) < 1e-9);
});

test('attachLightboxZoom: jsdom-safe wiring and drag-click guard state', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<img id="i"><div id="d"></div>');
  const img = dom.window.document.getElementById('i');
  const surface = dom.window.document.getElementById('d');
  let zoom;
  assert.doesNotThrow(() => { zoom = attachLightboxZoom(img, surface, dom.window.document); });
  assert.equal(typeof zoom.consumeDraggedClick(), 'boolean');
  assert.equal(zoom.consumeDraggedClick(), false, 'no drag → click not swallowed');
});

test('source pins: sidepanel.js wires the zoom and swallows dragged clicks', async () => {
  const src = await readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ attachLightboxZoom \} from '\.\/lib\/sidepanel\/lightbox-zoom\.js';/);
  assert.match(src, /const zoom = attachLightboxZoom\(img, dlg\);/);
  assert.match(src, /if \(e\.target === dlg && !zoom\.consumeDraggedClick\(\)\) dismiss\(\)/,
    'drag must not close the lightbox via the backdrop click');
});

test('drag deadzone keeps the CDS 4px convention', () => {
  assert.equal(DRAG_DEADZONE_PX, 4);
  assert.equal(ZOOM_DEFAULT_JUMP, 1.25);
});
