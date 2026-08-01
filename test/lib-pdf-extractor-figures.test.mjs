// test/lib-pdf-extractor-figures.test.mjs - tests for PDF figure preservation
// in lib/sidepanel/pdf-extractor.js. Two layers:
//
// 1. classifyPageOps() - the pure figure-detection heuristic - is exercised
//    directly with synthetic pdf.js operator fn arrays (no pdf.js needed).
// 2. extractPdfContent()'s opt-in figure wiring ({extractFigures:true}) is
//    exercised with an injected _extractFigures test seam, so the real
//    extractPdfFigures (which needs a real browser to load pdf.js + render to
//    canvas - the same "pdf.js can't run in bare Node" constraint the
//    content/fallback tests already live with) is never invoked here.
//
// Kept in its own file so the worker-client singleton starts fresh per file
// (see the note in test/lib-pdf-extractor-content.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } };

function installFakeWorker(result) {
  class FakeWorker {
    constructor() { this._listeners = { message: [], error: [] }; }
    addEventListener(type, fn) { this._listeners[type].push(fn); }
    postMessage() {
      for (const fn of this._listeners.message) fn({ data: { ok: true, result } });
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
}

async function freshModule() {
  return import('../lib/sidepanel/pdf-extractor.js?t=' + Math.random() + Math.random());
}

const SAMPLE_BASE64 = btoa('not a real pdf, only byte-length matters to the fake worker');

// A fake pdf.js OPS table: only the numeric codes classifyPageOps/extractFigureBboxes
// inspect matter, and they just need to be self-consistent with the fnArray entries.
const OPS = {
  paintImageXObject: 85, paintImageMaskXObject: 86, paintInlineImageXObject: 87, paintImageXObjectRepeat: 88,
  showText: 12, showSpacedText: 13, nextLineShowText: 14,
  constructPath: 1, stroke: 2, closeStroke: 3, fill: 4, eoFill: 5, fillStroke: 6,
  eoFillStroke: 7, closeFillStroke: 8, closeEOFillStroke: 9, endPath: 10,
  transform: 100, save: 101, restore: 102
};

test('classifyPageOps: raster image ops make a page figure-bearing (signal weighted 3x)', async () => {
  const { classifyPageOps } = await freshModule();
  const c = classifyPageOps([OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.showText], OPS);
  assert.equal(c.imageOps, 2);
  assert.equal(c.textOps, 1);
  assert.equal(c.vecOps, 0);
  assert.equal(c.isFigure, true);
  assert.equal(c.signal, 6, 'image ops weighted 3x: 2*3 + 0 = 6');
});

test('classifyPageOps: vector-heavy low-text page is a diagram (figure)', async () => {
  const { classifyPageOps } = await freshModule();
  const fns = [];
  for (let i = 0; i < 50; i++) { fns.push(OPS.constructPath); fns.push(OPS.stroke); fns.push(OPS.fill); }
  const c = classifyPageOps(fns, OPS);
  assert.equal(c.vecOps, 150);
  assert.equal(c.textOps, 0);
  assert.equal(c.imageOps, 0);
  assert.equal(c.isFigure, true, 'vecOps>=40 and textOps<40 -> figure');
  assert.equal(c.signal, 150);
});

test('classifyPageOps: text-only page is not figure', async () => {
  const { classifyPageOps } = await freshModule();
  const fns = [];
  for (let i = 0; i < 60; i++) fns.push(OPS.showText);
  const c = classifyPageOps(fns, OPS);
  assert.equal(c.textOps, 60);
  assert.equal(c.vecOps, 0);
  assert.equal(c.imageOps, 0);
  assert.equal(c.isFigure, false);
  assert.equal(c.signal, 0);
});

test('classifyPageOps: vector + heavy text (body text with rules) is NOT figure', async () => {
  const { classifyPageOps } = await freshModule();
  const fns = [];
  for (let i = 0; i < 50; i++) fns.push(OPS.stroke);   // 50 vec ops >= threshold
  for (let i = 0; i < 50; i++) fns.push(OPS.showText);  // 50 text ops >= threshold
  const c = classifyPageOps(fns, OPS);
  assert.equal(c.isFigure, false, 'vecOps>=40 BUT textOps>=40 -> body text, not a figure');
});

test('classifyPageOps: below-threshold vector with no images is not figure', async () => {
  const { classifyPageOps } = await freshModule();
  const c = classifyPageOps([OPS.stroke, OPS.stroke, OPS.fill], OPS); // 3 vec ops
  assert.equal(c.isFigure, false, 'vecOps<40 and no images -> not figure');
});

test('classifyPageOps: empty fnArray is not figure', async () => {
  const { classifyPageOps } = await freshModule();
  const c = classifyPageOps([], OPS);
  assert.equal(c.isFigure, false);
  assert.equal(c.signal, 0);
});

// --- extractFigureBboxes: CTM-stack image-bbox extraction (pure) ---

test('extractFigureBboxes: transform + paintImageXObject -> unit-square bbox in user space', async () => {
  const { extractFigureBboxes } = await freshModule();
  // transform [100,0,0,100,50,200] maps the unit square to (50,200)-(150,300)
  const fnArray = [OPS.transform, OPS.paintImageXObject];
  const argsArray = [[100, 0, 0, 100, 50, 200], ['imgId', 10, 10]];
  const boxes = extractFigureBboxes(fnArray, argsArray, OPS);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], { x0: 50, y0: 200, x1: 150, y1: 300, name: 'imgId' });
});

test('extractFigureBboxes: save/restore isolates nested transforms (canvas post-multiply)', async () => {
  const { extractFigureBboxes } = await freshModule();
  // pdf.js `transform` follows canvas post-multiply: CTM' = CTM × args, so a
  // translate composed after a scale is itself SCALED by it. outer scale-2,
  // then (inside a save) translate-(10,20): the translate lands at (20,40),
  // NOT (10,20) - this is the convention that places images at their on-page
  // position. After restore, img2 uses the outer scale-2 CTM -> (0,0)-(2,2).
  const fnArray = [
    OPS.transform, OPS.save, OPS.transform, OPS.paintImageXObject,
    OPS.restore, OPS.paintImageXObject
  ];
  const argsArray = [
    [2, 0, 0, 2, 0, 0], [],
    [1, 0, 0, 1, 10, 20], ['img1', 1, 1],
    [], ['img2', 1, 1]
  ];
  const boxes = extractFigureBboxes(fnArray, argsArray, OPS);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x0: 20, y0: 40, x1: 22, y1: 42, name: 'img1' }, 'img1: translate(10,20) scaled by outer scale-2 -> (20,40)');
  assert.deepEqual(boxes[1], { x0: 0, y0: 0, x1: 2, y1: 2, name: 'img2' }, 'img2 uses the restored outer scale-2 CTM');
});

test('extractFigureBboxes: paintImageXObjectRepeat uses its own map transform (args[3])', async () => {
  const { extractFigureBboxes } = await freshModule();
  const fnArray = [OPS.paintImageXObjectRepeat];
  const argsArray = [['imgId', 3, 2, [50, 0, 0, 50, 10, 20]]];
  const boxes = extractFigureBboxes(fnArray, argsArray, OPS);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], { x0: 10, y0: 20, x1: 60, y1: 70, name: 'imgId' });
});

test('extractFigureBboxes: paintImageMaskXObject / paintInlineImageXObject carry no name (no dedup signal)', async () => {
  const { extractFigureBboxes } = await freshModule();
  const fnArray = [
    OPS.transform, OPS.paintImageMaskXObject,
    OPS.paintInlineImageXObject
  ];
  const argsArray = [
    [10, 0, 0, 10, 5, 5],
    [{}],   // mask: arg[0] is the image object, not a name
    [{ width: 1, height: 1, data: [] }]  // inline: arg[0] is the image data
  ];
  const boxes = extractFigureBboxes(fnArray, argsArray, OPS);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].name, undefined, 'mask image has no resolvable name');
  assert.equal(boxes[1].name, undefined, 'inline image has no resolvable name');
});

// --- dedupeBoxesByName (pure) ---

test('dedupeBoxesByName: same-name boxes collapse to one (the largest)', async () => {
  const { dedupeBoxesByName } = await freshModule();
  // The same XObject painted at two positions: a small repeat + the real figure.
  const boxes = [
    { x0: 0, y0: 0, x1: 10, y1: 10, name: 'logo' },      // area 100 (tiny repeat)
    { x0: 50, y0: 50, x1: 250, y1: 250, name: 'logo' }   // area 40000 (the real one)
  ];
  const out = dedupeBoxesByName(boxes);
  assert.equal(out.length, 1, 'duplicate dropped');
  assert.deepEqual(out[0], { x0: 50, y0: 50, x1: 250, y1: 250, name: 'logo' }, 'largest kept');
});

test('dedupeBoxesByName: different names all kept; unnamed boxes untouched', async () => {
  const { dedupeBoxesByName } = await freshModule();
  const boxes = [
    { x0: 0, y0: 0, x1: 10, y1: 10, name: 'a' },
    { x0: 0, y0: 0, x1: 10, y1: 10, name: 'b' },
    { x0: 0, y0: 0, x1: 10, y1: 10 },                     // no name -> always kept
    { x0: 0, y0: 0, x1: 10, y1: 10 }                      // no name -> always kept
  ];
  const out = dedupeBoxesByName(boxes);
  assert.equal(out.length, 4, 'different names + unnamed all survive');
});

test('dedupeBoxesByName: three same-name -> one (largest), order preserved for survivors', async () => {
  const { dedupeBoxesByName } = await freshModule();
  const boxes = [
    { x0: 0, y0: 0, x1: 5, y1: 5, name: 'x' },          // area 25
    { x0: 0, y0: 0, x1: 100, y1: 100, name: 'y' },      // area 10000 (different name, survives)
    { x0: 0, y0: 0, x1: 20, y1: 20, name: 'x' },        // area 400 (same as first 'x', larger)
    { x0: 0, y0: 0, x1: 8, y1: 8, name: 'x' }           // area 64 (same as 'x', smaller than 400)
  ];
  const out = dedupeBoxesByName(boxes);
  assert.equal(out.length, 2, 'three x-name boxes -> one, y survives');
  assert.equal(out[0].name, 'x');
  assert.equal(out[0].x1, 20, 'largest x (area 400) wins');
  assert.equal(out[1].name, 'y');
});

test('dedupeBoxesByName: empty -> empty', async () => {
  const { dedupeBoxesByName } = await freshModule();
  assert.deepEqual(dedupeBoxesByName([]), []);
});

test('extractFigureBboxes: no image ops -> empty', async () => {
  const { extractFigureBboxes } = await freshModule();
  const fnArray = [OPS.transform, OPS.showText, OPS.stroke];
  const argsArray = [[1, 0, 0, 1, 5, 5], ['hi'], []];
  const boxes = extractFigureBboxes(fnArray, argsArray, OPS);
  assert.deepEqual(boxes, []);
});

// --- mergeBoxes (pure) ---

test('mergeBoxes: overlapping boxes merge into their union', async () => {
  const { mergeBoxes } = await freshModule();
  const boxes = [{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 8, y0: 8, x1: 20, y1: 20 }];
  const merged = mergeBoxes(boxes, 0);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { x0: 0, y0: 0, x1: 20, y1: 20 });
});

test('mergeBoxes: boxes within gap merge; far boxes stay separate', async () => {
  const { mergeBoxes } = await freshModule();
  const boxes = [
    { x0: 0, y0: 0, x1: 10, y1: 10 },      // within 5 of the second (gap 12-10=2)
    { x0: 12, y0: 12, x1: 20, y1: 20 },
    { x0: 100, y0: 100, x1: 110, y1: 110 } // far from both
  ];
  const merged = mergeBoxes(boxes, 5);
  assert.equal(merged.length, 2, 'first two merge, third stays separate');
});

test('mergeBoxes: empty input -> empty', async () => {
  const { mergeBoxes } = await freshModule();
  assert.deepEqual(mergeBoxes([], 0), []);
});

// --- findCaptions (pure) ---

test('findCaptions: pairs each figure with its nearest caption run', async () => {
  const { findCaptions } = await freshModule();
  const textItems = [
    { str: 'Figure 3: BEV encoder', transform: [1, 0, 0, 1, 100, 50] },
    { str: 'some body text', transform: [1, 0, 0, 1, 200, 200] },
    { str: 'Figure 7: results', transform: [1, 0, 0, 1, 400, 300] }
  ];
  const figureBboxes = [{ x0: 90, y0: 60, x1: 150, y1: 120 }]; // center (120,90)
  const caps = findCaptions(textItems, figureBboxes, { maxDist: 1000 });
  assert.equal(caps.length, 1);
  assert.equal(caps[0], 'Figure 3: BEV encoder', 'nearest caption wins');
});

test('findCaptions: caption beyond maxDist -> null', async () => {
  const { findCaptions } = await freshModule();
  const textItems = [{ str: 'Figure 3: far', transform: [1, 0, 0, 1, 1000, 1000] }];
  const figureBboxes = [{ x0: 90, y0: 60, x1: 150, y1: 120 }];
  const caps = findCaptions(textItems, figureBboxes, { maxDist: 50 });
  assert.equal(caps[0], null);
});

test('findCaptions: no matching caption text -> null', async () => {
  const { findCaptions } = await freshModule();
  const textItems = [{ str: 'just body', transform: [1, 0, 0, 1, 100, 90] }];
  const figureBboxes = [{ x0: 90, y0: 60, x1: 150, y1: 120 }];
  const caps = findCaptions(textItems, figureBboxes);
  assert.equal(caps[0], null);
});

test('findCaptions: regex matches Figure/Fig/Table and Chinese 图/表', async () => {
  const { findCaptions } = await freshModule();
  const textItems = [
    { str: 'Fig. 2: small', transform: [1, 0, 0, 1, 0, 0] },
    { str: 'Table 1: data', transform: [1, 0, 0, 1, 100, 0] },
    { str: '图 3 结果', transform: [1, 0, 0, 1, 200, 0] },
    { str: '表 4 参数', transform: [1, 0, 0, 1, 300, 0] }
  ];
  // four figures each centered directly above their caption (caption at y=0,
  // figure center at y=30 -> distance 30, well within maxDist 100)
  const figureBboxes = [
    { x0: -10, y0: 20, x1: 10, y1: 40 },
    { x0: 90, y0: 20, x1: 110, y1: 40 },
    { x0: 190, y0: 20, x1: 210, y1: 40 },
    { x0: 290, y0: 20, x1: 310, y1: 40 }
  ];
  const caps = findCaptions(textItems, figureBboxes, { maxDist: 100 });
  assert.deepEqual(caps, ['Fig. 2: small', 'Table 1: data', '图 3 结果', '表 4 参数']);
});

test('findCaptions: caption below the figure LEFT EDGE pairs (point-to-rect, not center)', async () => {
  // Real book.pdf page-15 fixture: figure bbox [36,315->245,393], caption
  // "Figure 1.1" at (36, 296.7) - left-aligned at the margin, sitting just
  // below the figure's LEFT edge. Distance to the bbox CENTER is ~119u (would
  // be rejected at maxDist 74), but distance to the nearest EDGE is ~18.7u
  // (correctly accepted). A center metric silently drops this caption; the
  // point-to-rect metric is what makes caption anchoring actually work.
  const { findCaptions } = await freshModule();
  const textItems = [
    { str: 'Figure 1.1: The RL interaction loop', transform: [1, 0, 0, 1, 36, 296.7] }
  ];
  const figureBboxes = [{ x0: 36, y0: 315.4, x1: 245.5, y1: 392.6 }];
  const caps = findCaptions(textItems, figureBboxes, { maxDist: 74.2 });
  assert.equal(caps[0], 'Figure 1.1: The RL interaction loop', 'left-edge caption must pair via edge distance');
});

test('extractPdfContent: extractFigures:true wires the injected figure renderer into figureImages', async () => {
  installFakeWorker({ markdown: '# Doc\n\nbody', pageCount: 2, pdfType: 'TextBased', confidence: 0.9, pagesNeedingOcr: [] });
  const { extractPdfContent } = await freshModule();
  // The real extractPdfFigures returns {url, caption, page} objects (caption
  // may be null); the wiring just passes whatever the renderer returns through.
  const figures = [
    { url: 'data:image/jpeg;base64,AAA', caption: 'Figure 1: a diagram', page: 3 },
    { url: 'data:image/jpeg;base64,BBB', caption: null, page: 7 }
  ];
  const res = await extractPdfContent(SAMPLE_BASE64, { extractFigures: true, _extractFigures: async () => figures });
  assert.equal(res.viaWasm, true, 'text result still comes from the wasm path');
  assert.match(res.text, /Doc/);
  assert.deepEqual(res.figureImages, figures);
});

test('extractPdfContent: figureImages defaults to [] when extractFigures is not requested', async () => {
  installFakeWorker({ markdown: '# Doc\n\nbody', pageCount: 2, pdfType: 'TextBased', confidence: 0.9, pagesNeedingOcr: [] });
  const { extractPdfContent } = await freshModule();
  const res = await extractPdfContent(SAMPLE_BASE64);
  assert.deepEqual(res.figureImages, []);
});

test('extractPdfContent: a throwing figure renderer yields [] but keeps the text result', async () => {
  installFakeWorker({ markdown: '# Doc\n\nbody', pageCount: 2, pdfType: 'TextBased', confidence: 0.9, pagesNeedingOcr: [] });
  const { extractPdfContent } = await freshModule();
  const res = await extractPdfContent(SAMPLE_BASE64, {
    extractFigures: true,
    _extractFigures: async () => { throw new Error('render boom'); }
  });
  assert.equal(res.viaWasm, true);
  assert.match(res.text, /Doc/);
  assert.deepEqual(res.figureImages, [], 'figure failure must not corrupt the text result');
});
