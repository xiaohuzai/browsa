// lib/sidepanel/pdf-extractor.js — client-side PDF text extraction via
// pdf.js, run here (not background.js) because pdf.js's getDocument() needs
// a real `window` (its worker-init code touches window.location) which the
// service worker doesn't have but this extension page does — same reasoning
// already established for lib/sidepanel/katex-worker-client.js's Worker.
//
// Ported idea from auditing firecrawl's PDF text extraction (server-side
// pdf-parse there); this is the from-scratch client-side equivalent, run
// entirely inside the extension with no backend.

import { findSafeTruncationPoint } from '../markdown-chunker.js';

let pdfLib = null;

async function getPdfLib() {
  if (pdfLib) return pdfLib;
  const mod = await import('../vendor/pdf.bundle.js');
  mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdf.worker.bundle.js');
  pdfLib = mod;
  return pdfLib;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const DEFAULT_MAX_CHARS = 500_000;
const DEFAULT_MAX_PAGES = 300;

/**
 * Extract text from a base64-encoded PDF. Returns
 * {text, numPages, pagesRead, wasCapped, outline}. Throws on any pdf.js
 * failure (corrupt/encrypted/unsupported PDF) — callers must catch and fall back to
 * the placeholder text; this function makes no attempt to degrade gracefully
 * itself, since sidepanel.js's caller already has an established fallback.
 */
export async function extractPdfText(base64, { maxChars = DEFAULT_MAX_CHARS, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const lib = await getPdfLib();
  const doc = await lib.getDocument({ data: base64ToUint8Array(base64) }).promise;
  const numPages = doc.numPages;
  const pagesRead = Math.min(numPages, maxPages);
  const parts = [];
  let total = 0;
  for (let i = 1; i <= pagesRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(reconstructPageText(content.items));
    total += parts[parts.length - 1].length;
    if (total > maxChars) break;
  }
  let text = parts.join('\n\n');
  const wasCapped = text.length > maxChars || pagesRead < numPages;
  if (text.length > maxChars) {
    const safeCut = findSafeTruncationPoint(text, maxChars);
    text = text.slice(0, safeCut) + `\n\n[... truncated at ${maxChars} chars ...]`;
  }
  // Outline comes free from the doc already open here (the wasm path opens
  // its own). Pages beyond maxPages were never read, but outline entries are
  // titles + refs — cheap and still correct; only the body text was capped.
  let outline = [];
  try {
    const raw = await doc.getOutline();
    if (Array.isArray(raw) && raw.length) outline = await flattenOutline(doc, raw);
  } catch (_) { /* outline is best-effort */ }
  return { text, numPages, pagesRead, wasCapped, outline };
}

// --- layout-aware page text (the pdf.js fallback path) ---
//
// getTextContent() yields text runs in the PDF's internal content-stream
// order, which is NOT reading order — a two-column paper's left and right
// columns interleave line by line, so the old `items.map(str).join(' ')`
// produced "motivation... ←left col line 1→ ...results ←right col line 1→"
// scrambled text. reconstructPageText rebuilds reading order from each
// run's transform: cluster runs into lines by baseline (y), split a line
// into columns on wide horizontal gaps, then emit top-to-bottom, each
// column left-to-right, all in page coordinates (y grows DOWNWARD in
// viewport space, which is what page.getTextContent()'s already-flipped
// transforms give us — no manual flip needed).

// Baselines within this fraction of a run's font size belong to the same
// line (subscripts/superscripts ride ±30% of the size).
const LINE_TOLERANCE = 0.3;
// A horizontal gap larger than this fraction of the page width starts a new
// column (LaTeX two-column gutters are ~0.2–0.25 of the text width; single
// spaces never exceed ~0.05).
const COLUMN_GAP = 0.12;

/**
 * Rebuild one page's reading order from pdf.js text items. Exported pure
 * (items in, text out — no pdf.js object needed) for unit testing.
 */
export function reconstructPageText(items) {
  const runs = [];
  let pageWidth = 0;
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string') continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 1;
    // width: use pdf.js's precomputed run width when present (it accounts
    // for the string's advance), else estimate from string length.
    const w = it.width != null ? it.width : it.str.length * size * 0.5;
    pageWidth = Math.max(pageWidth, t[4] + w);
    if (!it.str.trim()) continue;
    runs.push({ str: it.str, x: t[4], y: t[5], size, w, hasEOL: !!it.hasEOL });
  }
  if (!runs.length) return '';
  // Cluster into lines by baseline: sort top-to-bottom, sweep, and group
  // runs whose baseline sits within tolerance of the current line's.
  runs.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const r of runs) {
    const tol = Math.max(r.size, 1) * LINE_TOLERANCE;
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - r.y) <= tol) {
      line.runs.push(r);
      line.y = (line.y * (line.runs.length - 1) + r.y) / line.runs.length; // running mean baseline
    } else {
      lines.push({ y: r.y, runs: [r] });
    }
  }
  // Within each line: reading order is left-to-right (stable on the earlier
  // sort). Then split into column groups on wide gaps.
  const pieces = [];
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    let buf = '';
    let prev = null;
    let pieceStartX = null;
    let lastPieceEnd = null;
    for (const r of line.runs) {
      if (prev != null) {
        const gap = r.x - lastPieceEnd;
        if (gap > pageWidth * COLUMN_GAP) {
          pieces.push({ x: pieceStartX, y: line.y, text: buf.trimEnd() });
          buf = '';
          pieceStartX = r.x;
        } else if (gap > r.size * 0.25 && !/\s$/.test(buf)) {
          buf += ' ';
        }
      } else {
        pieceStartX = r.x;
      }
      buf += r.str;
      lastPieceEnd = r.x + r.w;
      prev = r;
    }
    if (buf.trim()) pieces.push({ x: pieceStartX, y: line.y, text: buf.trimEnd() });
  }
  // Emit column groups top-to-bottom: sort by (column band = x bucket,
  // then y). Bucket x into bands so a column's lines share one band even
  // when their start x wobbles by a few points.
  const bands = [];
  for (const p of pieces) {
    const band = bands.find((b) => Math.abs(b.x - p.x) <= pageWidth * COLUMN_GAP);
    if (band) { band.items.push(p); band.x = Math.min(band.x, p.x); }
    else bands.push({ x: p.x, items: [p] });
  }
  bands.sort((a, b) => a.x - b.x);
  return bands
    .map((b) => b.items.sort((a, b2) => b2.y - a.y).map((p) => p.text).join('\n'))
    .filter((s) => s.trim())
    .join('\n\n');
}

// A wasm result is only "usable" if it actually contains readable text —
// pdf-inspector's own pdfType classification is the signal plain pdf.js
// text-join has no equivalent of: a page genuinely classified 'Scanned' (no
// text layer at all) would otherwise silently send near-empty content to the
// model instead of falling through to a more useful fallback. Empirically
// (see test/lib-pdf-inspector-wasm.test.mjs), `pagesNeedingOcr` fires as a
// conservative low-confidence signal even on short-but-legitimately-extracted
// pages — it is NOT a reliable "extraction failed" signal on its own, so the
// gate deliberately does not key off it, only off the definitive pdfType and
// a genuinely-empty markdown result.
function isUsableWasmResult(result) {
  if (!result || typeof result.markdown !== 'string') return false;
  if (result.markdown.trim().length === 0) return false;
  if (result.pdfType === 'Scanned') return false;
  return true;
}

function isEmptyText(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Page markers + outline (document structure)
//
// The wasm engine can stamp `<!-- Page N -->` comments between pages
// (ProcessOptions.includePageMarkers); normalized here into visible
// `[Page N]` lines so the model can cite page positions and the auto-
// summarizer can preserve them. The pdf.js fallback path (extractPdfText)
// stamps the same marker itself. extractPdfOutline walks the PDF's bookmark
// tree via pdf.js's doc.getOutline() — the one structural source neither
// extraction path reads — and prepends it as a Contents section.

/** wasm comments → visible markers; dedupes consecutive repeats at a cap. */
export function normalizePageMarkers(markdown) {
  let s = String(markdown || '');
  if (!s) return s;
  s = s.replace(/<!--\s*Page\s+(\d+)\s*-->/gi, '\n[Page $1]\n');
  // Collapse runs of identical consecutive markers to one ([Page 4] blank
  // [Page 4] → [Page 4]) — a page boundary emitted twice (observed from the
  // engine on page-size changes) would otherwise read as two empty pages.
  let prev;
  while (prev !== s) {
    prev = s;
    s = s.replace(/(\[Page \d+\])(?:\s*\n\s*\1)+/g, '$1');
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const OUTLINE_TIMEOUT_MS = 15_000;
const OUTLINE_MAX_ENTRIES = 120;
const OUTLINE_MAX_TITLE = 120;

/**
 * Flatten pdf.js's nested outline destination arrays into [{title, page,
 * level}]. Each outline item's `dest` is either a string (named destination,
 * resolved via doc.getDestination) or an array whose [0] is the destination
 * page's ref — resolved via doc.getPageIndex. Items without a resolvable
 * destination are still kept (page null): titles alone carry structure.
 * pdf.js calls are injected via the `doc` param so the flattening logic
 * stays testable.
 */
export async function flattenOutline(doc, items, level = 1) {
  const out = [];
  for (const it of (items || [])) {
    if (!it || !it.title) continue;
    if (out.length >= OUTLINE_MAX_ENTRIES) break;
    let page = null;
    try {
      let dest = it.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0]) {
        const idx = await doc.getPageIndex(dest[0]);
        page = idx + 1; // 1-indexed, matching [Page N] markers
      }
    } catch (_) { /* unresolvable destination — keep the title, page stays null */ }
    out.push({ title: String(it.title).slice(0, OUTLINE_MAX_TITLE), page, level });
    if (Array.isArray(it.items) && it.items.length && out.length < OUTLINE_MAX_ENTRIES) {
      out.push(...await flattenOutline(doc, it.items, level + 1));
    }
  }
  return out;
}

/**
 * Open the PDF (fresh buffer — pdf.js detaches the one it's given; the wasm
 * path may have consumed the caller's) and walk its bookmark tree. Returns
 * [] on any failure (no outline, encrypted, corrupt). A single top-level
 * entry is not a TOC (most likely a lone "Cover"/"Contents" node) — callers
 * gate on >= 3 entries.
 */
async function extractPdfOutline(base64) {
  try {
    const lib = await getPdfLib();
    const doc = await lib.getDocument({ data: base64ToUint8Array(base64) }).promise;
    const outline = await doc.getOutline();
    if (!Array.isArray(outline) || !outline.length) return [];
    return await flattenOutline(doc, outline);
  } catch (_) {
    return [];
  }
}

/** Render the flattened outline as the markdown Contents block. Pure. */
export function formatOutlineMarkdown(outline) {
  if (!Array.isArray(outline) || !outline.length) return '';
  const lines = outline.map((o) => {
    const indent = '  '.repeat(Math.max(0, (o.level || 1) - 1));
    const page = o.page ? ` — p.${o.page}` : '';
    return `${indent}- ${o.title}${page}`;
  });
  return '## Contents\n(Document bookmarks — sections with their page numbers)\n' + lines.join('\n');
}

// ---------------------------------------------------------------------------
// Figure preservation (vision-capable providers)
//
// Both extraction paths above are text-only: wasm emits markdown with no
// figures, and pdf.js's getTextContent() joins text items only - raster
// images and vector diagrams are silently dropped. For a PDF where figures
// carry meaning (a textbook, a paper with plots), this loses information the
// model cannot recover from text alone. When the caller opts in
// (opts.extractFigures), we detect figure-bearing pages via pdf.js operator
// lists, then CROP the actual figure regions (via the operatorList's image
// transforms + a tracked CTM stack - not whole-page renders) and pair each
// with its detected caption. Each figure is returned as {url, caption, page}
// so the caller (background.js ATTACH_PDF_CONFIRM) can list the captions in
// the body text as a positional anchor the model matches to the prose's
// "Figure N" reference - giving figure<->text correspondence without page
// markers, which the page-boundary-less wasm markdown can't provide. Vector-
// only figure pages (flowcharts/diagrams) and full-page figures fall back to
// a whole-page render. Everything here is best-effort: any failure/timeout
// yields [] and the text result is returned untouched.
//
// The CTM/bbox/caption math is split into pure exported helpers
// (extractFigureBboxes/mergeBoxes/findCaptions) so it is unit-testable without
// pdf.js - only the orchestrating extractPdfFigures (which needs a real
// browser to load pdf.js + render to canvas) is untested in CI, same as the
// content/fallback paths.
const FIGURE_MAX_IMAGES = 30;       // cap rendered figures (token/payload budget) - covers most figures in a textbook/paper; each is a ~1K-token image resent every chat turn
const FIGURE_MAX_SCAN_PAGES = 200;  // scan up to N pages for figures (covers most books/papers; beyond this later figures are dropped to bound scan cost)
const FIGURE_VEC_OP_THRESHOLD = 40; // vector-paint ops to count a page as a diagram
const FIGURE_TEXT_THRESHOLD = 40;   // disambiguation line: a vector page with >= this many text ops needs a caption to count as a figure (else it's a table/pseudocode box)
const FIGURE_RENDER_WIDTH = 1000;   // target render width in px (scale = min(2, width/pageWidth))
const FIGURE_MAX_PER_PAGE = 2;      // up to 2 figures per page so multi-figure pages (e.g. a page with Figure 3.3 AND 3.4) keep both
const FIGURE_MAX_LONG_EDGE = 1568;  // downscale a figure's longest edge to this (vision token cost)
const FIGURE_TIMEOUT_MS = 90_000;   // hard cap on the whole figure pass (scanning up to 200 pages + rendering up to 30)

/**
 * Pure detector: classify a page's pdf.js operator fn list into figure
 * signals. Counts raster image ops, vector paint ops, and text-showing ops,
 * then decides figure-bearing. Exported for unit testing (needs no pdf.js).
 *
 * A page is figure-bearing if it has any raster image op, OR enough vector
 * paint ops (>= FIGURE_VEC_OP_THRESHOLD) alongside little text
 * (< FIGURE_TEXT_THRESHOLD) - the signature of a diagram/chart rather than a
 * page of body text. `signal` ranks pages by figure density (image ops
 * weighted 3x vector ops) so the top-N render budget goes to the most
 * figure-dense pages.
 */
export function classifyPageOps(fnArray, OPS) {
  let imageOps = 0;
  let vecOps = 0;
  let textOps = 0;
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject ||
        fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      imageOps++;
    } else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText) {
      textOps++;
    } else if (fn === OPS.constructPath || fn === OPS.stroke || fn === OPS.closeStroke ||
               fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke ||
               fn === OPS.eoFillStroke || fn === OPS.closeFillStroke ||
               fn === OPS.closeEOFillStroke || fn === OPS.endPath) {
      vecOps++;
    }
  }
  const isFigure = imageOps > 0 || (vecOps >= FIGURE_VEC_OP_THRESHOLD && textOps < FIGURE_TEXT_THRESHOLD);
  const signal = imageOps * 3 + vecOps;
  return { imageOps, vecOps, textOps, isFigure, signal };
}

// --- CTM / bbox geometry (pure, unit-testable) ---
//
// pdf.js's operatorList exposes the raw content-stream operators with
// resources resolved but WITHOUT the page's default matrix (MediaBox/CropBox
// + /Rotate) baked in - that matrix is applied separately at render time via
// the Viewport.transform. So the transform (cm) ops tracked here accumulate a
// CTM in "default user space" (PDF coords, origin bottom-left, pre-rotation),
// and the Viewport.transform later maps that to device pixels. Crucially,
// getTextContent() item positions live in the SAME default user space, so
// figure bboxes and caption positions match directly with no viewport
// conversion - the viewport only enters when cropping a rendered page to
// canvas pixels.
//
// An image XObject is always painted in the unit square [0,1]x[0,1]; the
// preceding cm maps that square to the image's placement. So an image's
// default-user-space bbox = (accumulated CTM) x (unit square corners).

function multiplyMatrix(m1, m2) {
  // m1 x m2, each [a,b,c,d,e,f] = | a c e | b d f | 0 0 1 |
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function unitSquareBbox(ctm) {
  const p00 = applyMatrix(ctm, 0, 0);
  const p10 = applyMatrix(ctm, 1, 0);
  const p01 = applyMatrix(ctm, 0, 1);
  const p11 = applyMatrix(ctm, 1, 1);
  const xs = [p00[0], p10[0], p01[0], p11[0]];
  const ys = [p00[1], p10[1], p01[1], p11[1]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Walk a page's pdf.js operator list tracking the graphics-state CTM stack
 * (transform premultiplies; save/restore push/pop) and return the default-
 * user-space bounding box of every raster image placement. Vector-only paths
 * (constructPath/stroke/fill) are NOT bbox'd here - they are far harder to
 * bound, and a vector-only figure page falls back to a whole-page render in
 * extractPdfFigures instead. paintImageXObjectRepeat carries its own transform
 * in args[3] (not via the cm stack), so its bbox is approximate (one tile).
 * Pure - exported for unit testing without pdf.js.
 */
export function extractFigureBboxes(fnArray, argsArray, OPS) {
  const boxes = [];
  let stack = [[1, 0, 0, 1, 0, 0]]; // identity CTM in default user space
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k];
    if (fn === OPS.transform) {
      // pdf.js's `transform` op follows the canvas post-multiply convention
      // (CTM' = CTM × args), NOT PDF's text-book prepend (args × CTM). A
      // translate applied before a scale must reach the final CTM UNSCALED so
      // the image lands at its on-page position; pre-multiplying scaled the
      // translate, throwing every bbox ~25x off-page -> degenerate (zero-area)
      // crops -> every figure fell back to a whole-page render. Real bug found
      // by dumping pdf.js's operator list for a LaTeX book page whose three
      // transforms (translate(36,315) -> scale(0.14) -> scale(1472,542)) should
      // place the unit square at (36,315)-size-209x77 but pre-multiply put it
      // at (7536,24330).
      stack[stack.length - 1] = multiplyMatrix(stack[stack.length - 1], args);
    } else if (fn === OPS.save) {
      stack.push(stack[stack.length - 1].slice());
    } else if (fn === OPS.restore) {
      if (stack.length > 1) stack.pop();
    } else if (
      fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintInlineImageXObject
    ) {
      const box = unitSquareBbox(stack[stack.length - 1]);
      // paintImageXObject's args[0] is the image XObject's objId (a name).
      // Two paints with the same objId are the SAME image painted at two
      // positions (a repeated logo/watermark/decoration, or the same figure
      // referenced twice) - tagged here so dedupeBoxesByName can drop the
      // duplicate before it wastes a figure slot. paintImageMaskXObject /
      // paintInlineImageXObject carry no resolvable name, so left untagged.
      if (fn === OPS.paintImageXObject && args && args[0] != null) box.name = args[0];
      boxes.push(box);
    } else if (fn === OPS.paintImageXObjectRepeat) {
      // args: [objId, repeatWidth, repeatHeight, mapTransform]
      const map = Array.isArray(args) ? args[3] : null;
      if (Array.isArray(map) && map.length >= 6) {
        const box = unitSquareBbox(map);
        if (args && args[0] != null) box.name = args[0];
        boxes.push(box);
      }
    }
  }
  return boxes;
}

/**
 * Drop boxes that reference the same named image XObject more than once on a
 * page. A repeated logo/watermark/decoration - or the same figure painted at
 * two positions - arrives as multiple bboxes sharing one `name` (the
 * paintImageXObject objId) at different positions; without this dedup each
 * would be cropped separately, yielding identical thumbnails (a real bug seen
 * on a LaTeX book: a page's same diagram painted twice produced two identical
 * figures that wasted 2 of the 6-figure budget). Keeps the LARGEST-area box
 * per name (the real figure placement, not a tiny repeat) and preserves the
 * first-occurrence order of the survivors. Boxes without a `name`
 * (mask/inline images, or pre-existing callers that don't tag names) are kept
 * untouched. Runs BEFORE mergeBoxes and the per-page cap so a duplicate never
 * wastes a figure slot that a different figure could have used. Pure -
 * exported for unit testing without pdf.js.
 */
export function dedupeBoxesByName(boxes) {
  if (!boxes.length) return [];
  const seen = new Map(); // name -> { ref, area }
  const out = [];
  for (const b of boxes || []) {
    if (b.name == null) { out.push(b); continue; }
    const curArea = (b.x1 - b.x0) * (b.y1 - b.y0);
    const prev = seen.get(b.name);
    if (!prev) {
      seen.set(b.name, { ref: b, area: curArea });
      out.push(b);
    } else if (curArea > prev.area) {
      // Larger placement wins - replace the earlier survivor in place.
      const idx = out.indexOf(prev.ref);
      if (idx >= 0) out[idx] = b;
      prev.ref = b;
      prev.area = curArea;
    }
  }
  return out;
}

/**
 * Merge boxes that overlap or sit within `gap` units of each other. A figure
 * built from several subpanel images (a/b/c) arrives as separate placements
 * and should be cropped as one region. Iterates to a fixpoint so transitive
 * merges (A near B near C) collapse. Pure - exported for unit testing.
 */
export function mergeBoxes(boxes, gap = 0) {
  if (!boxes.length) return [];
  const merged = boxes.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        const near = (a.x0 - gap) <= b.x1 && (b.x0 - gap) <= a.x1 &&
                     (a.y0 - gap) <= b.y1 && (b.y0 - gap) <= a.y1;
        if (near) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return merged;
}

/**
 * Pair each figure bbox with its nearest caption text item. Captions are text
 * runs starting with "Figure N" / "Fig. N" / "Table N" / Chinese "图 N" /
 * "表 N"; the caption is the anchor that lets the model place a figure
 * relative to body text that references "Figure N" - without needing page
 * markers in the (page-boundary-less) wasm markdown. Nearest by Euclidean
 * distance in default user space, gated by maxDist (a caption far from every
 * figure is ignored rather than mis-paired). textItems are pdf.js
 * getTextContent() items ({str, transform:[a,b,c,d,e,f]}). Pure - exported
 * for unit testing.
 */
export function findCaptions(textItems, figureBboxes, opts = {}) {
  const maxDist = opts.maxDist != null ? opts.maxDist : Infinity;
  const capRe = opts.captionRe || /^(figure|fig\.?|table|图|表)\s*\d+/i;
  // Collect caption-candidate text runs (those starting with "Figure N"/"图N"/etc.).
  const captions = [];
  for (const it of textItems || []) {
    if (!it || !it.str) continue;
    const s = it.str.trim();
    if (!s || !capRe.test(s)) continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    captions.push({ str: s, x: t[4], y: t[5] });
  }
  return figureBboxes.map((box) => {
    let best = null, bestDist = Infinity;
    for (const cap of captions) {
      // Point-to-rectangle distance (0 when inside), NOT distance to the bbox
      // center: captions are left-aligned at the page margin / the figure's
      // left edge, not centered under the figure, so a center metric over-
      // penalizes the horizontal offset and rejects perfectly good captions
      // (e.g. "Figure 1.1" sitting just below a figure's left edge measured
      // 119u to-center vs 19u to-edge on a real fixture). dx/dy are the clamped
      // separations from the point to the nearest rectangle edge.
      const dx = Math.max(box.x0 - cap.x, 0, cap.x - box.x1);
      const dy = Math.max(box.y0 - cap.y, 0, cap.y - box.y1);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist && d <= maxDist) { bestDist = d; best = cap.str; }
    }
    return best;
  });
}

// --- render helpers (need a real DOM/canvas - not unit-tested) ---

// Map a default-user-space bbox to device (canvas-pixel) coords via the
// viewport transform. Transforms all four corners and takes the axis-aligned
// min/max so a rotated page still yields a correct crop rectangle.
function userBoxToDevice(box, transform) {
  const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]];
  const ps = corners.map(([x, y]) => applyMatrix(transform, x, y));
  const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function clampPad(dBox, pad, cw, ch) {
  const x0 = Math.max(0, Math.floor(dBox.x0 - pad));
  const y0 = Math.max(0, Math.floor(dBox.y0 - pad));
  const x1 = Math.min(cw, Math.ceil(dBox.x1 + pad));
  const y1 = Math.min(ch, Math.ceil(dBox.y1 + pad));
  return { x0, y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

// JPEG-encode a canvas, downscaling so the longest edge stays within the cap.
// Vision-model token cost scales with resolution and figures are resent every
// turn from history, so a tight cap compounds across the whole session.
function cappedJpeg(srcCanvas, w, h) {
  const longEdge = Math.max(w, h);
  if (longEdge <= FIGURE_MAX_LONG_EDGE) return srcCanvas.toDataURL('image/jpeg', 0.7);
  const s = FIGURE_MAX_LONG_EDGE / longEdge;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(srcCanvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function cropCanvasToJpeg(srcCanvas, crop) {
  const c = document.createElement('canvas');
  c.width = crop.w; c.height = crop.h;
  const cx = c.getContext('2d');
  cx.fillStyle = '#ffffff'; // PDFs have no background; avoid black-on-black JPEGs
  cx.fillRect(0, 0, crop.w, crop.h);
  cx.drawImage(srcCanvas, crop.x0, crop.y0, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return cappedJpeg(c, crop.w, crop.h);
}

/**
 * Detect figure-bearing pages, then for each: render the page ONCE and crop
 * the actual figure regions (via operatorList bboxes) rather than the whole
 * page - tighter images, less token waste. Each figure is paired with its
 * detected caption (the positional anchor). Vector-only figure pages (no
 * raster images - a flowchart/diagram) and full-page figures fall back to a
 * whole-page render. Returns [{url, caption, page}] (caption may be null).
 * Best-effort: unreadable pages are skipped and any thrown error propagates to
 * extractPdfContent's catch (which yields []). Creates a fresh byte buffer
 * (pdf.js detaches the buffer it's given; the wasm path may have consumed it).
 */
async function extractPdfFigures(base64) {
  const lib = await getPdfLib();
  const bytes = base64ToUint8Array(base64);
  const doc = await lib.getDocument({ data: bytes }).promise;
  const numPages = doc.numPages;
  const scanPages = Math.min(numPages, FIGURE_MAX_SCAN_PAGES);
  if (numPages > FIGURE_MAX_SCAN_PAGES) {
    console.log(`browsa[pdf-figures]: ${numPages} pages; scanning first ${FIGURE_MAX_SCAN_PAGES} for figures, rest dropped`);
  }
  const OPS = lib.OPS;

  // Pass 1: detect figure-bearing pages (one getOperatorList per page, no render).
  // A page qualifies via classifyPageOps's gate (raster image ops, OR a low-text
  // vector page - the classic diagram signature). The ONE case that gate misses
  // is a high-text vector page (vecOps>=40 AND textOps>=40): a matplotlib-style
  // chart whose many axis/legend labels push textOps over the threshold, so the
  // gate reads it as "body text with rules" and rejects it. Such a page is a real
  // figure IFF it carries a "Figure N" caption - so we confirm with getTextContent
  // ONLY on those ambiguous pages (not every page, to bound cost). This also
  // drops high-text vector pages WITHOUT a caption (tables, ruled pseudocode
  // boxes) that a naive vecOps-only gate would falsely admit.
  const CAPTION_RE = /^(figure|fig\.?|table|图|表)\s*\d+/i;
  const candidates = [];
  for (let i = 1; i <= scanPages; i++) {
    try {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      const c = classifyPageOps(ops.fnArray, OPS);
      let isFig = c.isFigure;
      if (!isFig && c.vecOps >= FIGURE_VEC_OP_THRESHOLD && c.textOps >= FIGURE_TEXT_THRESHOLD) {
        try {
          const tc = await page.getTextContent();
          isFig = (tc.items || []).some((it) => it && it.str && CAPTION_RE.test(it.str.trim()));
        } catch (_) { /* unreadable text layer -> treat as not-a-figure */ }
      }
      if (isFig) candidates.push({ pageNum: i });
    } catch (_) {
      // skip an unreadable page rather than aborting the whole pass
    }
  }
  // Select in DOCUMENT order (page-ascending), not density/signal order. The old
  // signal-desc ranking (signal = imageOps*3 + vecOps) let vector charts
  // (signal 50-200) dominate raster figures (signal 3-6), so under a tight budget
  // EVERY raster figure was cut in favor of vector pages. With a budget meant to
  // cover most of a document's figures, reading-order selection is both fairer
  // across figure types and what a reader expects; the budget, not density,
  // decides what gets dropped (the latest-chapter figures, predictably).
  candidates.sort((a, b) => a.pageNum - b.pageNum);
  console.log(`browsa[pdf-figures]: ${candidates.length} figure-bearing page(s) of ${scanPages} scanned:`, candidates.map(c => `p${c.pageNum}`).join(', ') || '(none)');

  // Pass 2: extract figures from candidate pages in document order (page-
  // ascending), capping both per-page (FIGURE_MAX_PER_PAGE, keeps e.g. Figure
  // 3.3 AND 3.4 on one page) and total (FIGURE_MAX_IMAGES, token/payload
  // budget). The budget, not density, decides what's dropped (latest chapters).
  const figures = [];
  for (const cand of candidates) {
    if (figures.length >= FIGURE_MAX_IMAGES) break;
    try {
      const page = await doc.getPage(cand.pageNum);
      const pageFigs = await extractFiguresFromPage(page, OPS);
      for (const f of pageFigs) {
        if (figures.length >= FIGURE_MAX_IMAGES) break;
        figures.push(f);
      }
    } catch (e) {
      console.warn(`browsa[pdf-figures]: page ${cand.pageNum} figure extraction failed:`, e?.message || e);
    }
  }
  // Safety-net content dedupe: drop figures whose cropped JPEG data URL is
  // byte-identical to an earlier one. Name-based dedupe (dedupeBoxesByName)
  // already handles the common case - same XObject painted twice - but the
  // same image embedded as two DIFFERENT XObjects (same pixels, different
  // objId) slips past name-based and is caught here. toDataURL is
  // deterministic, so pixel-identical crops produce identical URLs. Keeps the
  // first occurrence (from the earlier page, candidates being page-sorted).
  // Multiple whole-page fallbacks on one page also collapse to one here (same
  // render -> same URL).
  const seenUrl = new Set();
  const unique = [];
  for (const f of figures) {
    if (seenUrl.has(f.url)) continue;
    seenUrl.add(f.url);
    unique.push(f);
  }
  // Present figures in document reading order (page-ascending). Selection is
  // already page-ascending, so this is a no-op on the page key, but it still
  // enforces within-page reading order across the per-page cap and dedupe, and
  // guarantees the figures section + image_url blocks follow the body's order -
  // what caption-anchoring needs, especially for the "Figure on page N" fallback
  // labels. Array.sort is stable in Chrome 114+, so figures from the same page
  // retain their within-page reading order (set by extractFiguresFromPage).
  unique.sort((a, b) => (a.page || 0) - (b.page || 0));
  console.log(`browsa[pdf-figures]: extracted ${unique.length} figure(s) (${figures.length - unique.length} duplicate(s) dropped):`, unique.map((f, i) => `#${i + 1} p${f.page || '?'} "${(f.caption || '').slice(0, 40) || '(no caption)'}"`).join(', ') || '(none)');
  return unique;
}

// Extract (and render) the figures on a single page. Renders the page exactly
// once and slices figure regions out of that single render, so multiple
// figures on one page share the render cost. See extractPdfFigures for caps.
async function extractFiguresFromPage(page, OPS) {
  const view = page.view || [0, 0, 1, 1]; // [x0,y0,x1,y1] in default user space
  const userW = view[2] - view[0], userH = view[3] - view[1];
  const pageArea = Math.max(1, userW * userH);

  const opList = await page.getOperatorList();
  let boxes = extractFigureBboxes(opList.fnArray, opList.argsArray, OPS);
  // Drop same-image duplicates (same XObject painted at multiple positions)
  // before merge + cap, so a duplicate never wastes a figure slot.
  boxes = dedupeBoxesByName(boxes);
  boxes = mergeBoxes(boxes, userW * 0.03);
  // Reading order: top-to-bottom (default user space y grows upward, so
  // descending y), then left-to-right. Caps figures per page for diversity.
  boxes.sort((a, b) => ((b.y0 + b.y1) - (a.y0 + a.y1)) || ((a.x0 + a.x1) - (b.x0 + b.x1)));

  // Render the page once at a readable scale (reused for every crop below and
  // for the whole-page fallbacks).
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(2, FIGURE_RENDER_WIDTH / Math.max(1, vp1.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // PDFs have no background; avoid black-on-black JPEGs
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const pageNum = page.pageNumber;
  const wholePageUrl = () => cappedJpeg(canvas, canvas.width, canvas.height);

  // Vector-only figure page (diagram/flowchart/table): no raster bboxes to
  // crop — the whole page IS the figure. Still pair the page's own caption
  // ("Figure N: …" / "Table N: …") against the full-page box: vector-drawn
  // figures (TikZ diagrams, matplotlib charts, ruled tables) otherwise lost
  // their caption entirely and the model could only anchor them as a weak
  // "Figure on page N". findCaptions returns the first caption-starting text
  // run on the page (all runs sit inside the page box, distance 0).
  if (!boxes.length) {
    let cap = null;
    try {
      const tc = await page.getTextContent();
      const pageBox = { x0: view[0], y0: view[1], x1: view[2], y1: view[3] };
      cap = findCaptions(tc.items, [pageBox], { maxDist: Infinity })[0] || null;
    } catch (_) { /* caption is optional on the fallback path */ }
    return [{ url: wholePageUrl(), caption: cap, page: pageNum }];
  }

  // Captions live in default user space (same coords as `boxes`).
  let captions;
  try {
    const tc = await page.getTextContent();
    captions = findCaptions(tc.items, boxes, { maxDist: userH * 0.15 });
  } catch (_) {
    captions = boxes.map(() => null);
  }

  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    if (out.length >= FIGURE_MAX_PER_PAGE) break;
    const box = boxes[i];
    const area = (box.x1 - box.x0) * (box.y1 - box.y0);
    if (area < pageArea * 0.02) continue; // decorative, skip
    const cap = captions[i] || null;
    if (area >= pageArea * 0.6) { // full-page figure - whole-page render
      out.push({ url: wholePageUrl(), caption: cap, page: pageNum });
      continue;
    }
    const crop = clampPad(userBoxToDevice(box, viewport.transform), 10, canvas.width, canvas.height);
    if (crop.w < 20 || crop.h < 20) { // bbox likely wrong - fall back to whole page
      out.push({ url: wholePageUrl(), caption: cap, page: pageNum });
      continue;
    }
    out.push({ url: cropCanvasToJpeg(canvas, crop), caption: cap, page: pageNum });
  }
  // Page classified as figure-bearing but every box was decorative/skipped -
  // don't lose the page entirely; render it whole as a last resort.
  if (!out.length) out.push({ url: wholePageUrl(), caption: null, page: pageNum });
  return out;
}

/**
 * Race a best-effort pass against a timeout. The timer MUST be cleared when
 * the race settles — a lingering setTimeout keeps Node's test runner alive
 * long after the work finished (real issue hit by the figure pass before).
 */
async function raceWithTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Primary PDF extraction path: pdf-inspector-wasm (full layout/table/heading
 * reconstruction, running in a Worker — see pdf-inspector-worker-client.js),
 * falling back to the plain-text pdf.js join (extractPdfText above) when the
 * worker is unavailable/times out or its result fails the usability check.
 * Never throws — the pdf.js fallback path is awaited directly, and only its
 * own failure propagates (matching extractPdfText's existing throw contract,
 * so sidepanel.js's caller needs no new catch logic).
 */
export async function extractPdfContent(base64, opts = {}) {
  const { maxChars = DEFAULT_MAX_CHARS } = opts;
  const bytes = base64ToUint8Array(base64);
  const t0 = performance.now();

  // Three INDEPENDENT passes over the bytes — wasm text, outline, figures
  // each open their own pdf.js doc / worker call from a fresh byte copy.
  // Running them concurrently (rather than sequentially) cuts wall-clock to
  // the slowest single pass: outline used to serialize AFTER the wasm result
  // and figures after that, roughly summing the attach wait. Each pass is
  // individually fail-open — a failure can never corrupt the text result.
  const outlinePromise = (opts.extractOutline !== false)
    ? raceWithTimeout(extractPdfOutline(base64), OUTLINE_TIMEOUT_MS, null).catch(() => null)
    : Promise.resolve(null);
  const figuresPromise = opts.extractFigures
    ? raceWithTimeout((opts._extractFigures || extractPdfFigures)(base64, opts), FIGURE_TIMEOUT_MS, [])
        .catch((e) => {
          console.warn('browsa: pdf figure extraction failed, continuing text-only', e?.message || e);
          return [];
        })
    : Promise.resolve([]);

  let result;
  try {
    const { processPdfViaWorker } = await import('./pdf-inspector-worker-client.js');
    // includePageMarkers stamps `<!-- Page N -->` between pages; they are
    // normalized to visible `[Page N]` lines below. Without them the markdown
    // is a page-boundary-less stream: the model can't cite "page 12" and the
    // Figures section can only offer weak "Figure on page N" hints. The
    // markers also let the auto-summarizer preserve page positions through
    // compression and let paper prompts cite section→page mappings.
    const response = await processPdfViaWorker(bytes, { profile: 'fidelity', includePageMarkers: true });
    if (response?.ok && isUsableWasmResult(response.result)) {
      const r = response.result;
      let text = normalizePageMarkers(r.markdown);
      const wasCapped = text.length > maxChars;
      if (wasCapped) {
        const safeCut = findSafeTruncationPoint(text, maxChars);
        text = text.slice(0, safeCut) + `\n\n[... truncated at ${maxChars} chars ...]`;
      }
      result = {
        text,
        numPages: r.pageCount,
        pagesRead: r.pageCount,
        wasCapped,
        viaWasm: true,
        pdfType: r.pdfType,
        confidence: r.confidence,
        pagesNeedingOcr: r.pagesNeedingOcr || [],
        // Document Info metadata + layout signals the engine already computed
        // but the plain-text path had no use for: the embedded title (better
        // than a filename-ish tab title for papers), which pages carry
        // tables/multi-column layout, and whether glyphs came out garbled.
        // All optional — surfaced via the attach system message and the paper
        // analysis prompt, never injected into the body text.
        docTitle: typeof r.title === 'string' ? r.title.trim() : '',
        layout: {
          pagesWithTables: Array.isArray(r.layout?.pagesWithTables) ? r.layout.pagesWithTables : [],
          pagesWithColumns: Array.isArray(r.layout?.pagesWithColumns) ? r.layout.pagesWithColumns : []
        },
        hasEncodingIssues: !!r.hasEncodingIssues
      };
    }
  } catch (e) {
    console.warn('browsa: pdf-inspector-wasm extraction failed, falling back to pdf.js', e);
  }

  if (!result) {
    const legacy = await extractPdfText(base64, opts);
    // pdf.js doesn't throw on a page with no text layer -- it just joins an
    // empty string per page. Unlike a Mixed-type document (some real pages,
    // some scanned; partial text is still strictly useful and must NOT be
    // rejected here), a wholly-scanned PDF's legacy text comes back entirely
    // empty with no exception to trigger sidepanel.js's existing placeholder
    // fallback. Throwing here closes that gap using the same throw-based
    // contract extractPdfText's own docstring already establishes.
    if (isEmptyText(legacy.text)) {
      throw new Error('pdf.js extraction produced no text (likely a scanned/image-only PDF)');
    }
    result = { ...legacy, viaWasm: false };
  }

  // Bookmarks/outline → a Contents section prepended to the body. The wasm
  // markdown has heading structure but no page mapping; the PDF outline has
  // both (title + destination page). A document with fewer than 3 outline
  // entries gains nothing from a TOC.
  const outline = await outlinePromise;
  if (Array.isArray(outline) && outline.length >= 3) result.outline = outline;
  if (Array.isArray(result.outline) && result.outline.length >= 3) {
    result.text = formatOutlineMarkdown(result.outline) + '\n\n' + result.text;
  }

  // Figures: awaited (not serialized) — the pass started concurrently above.
  result.figureImages = await figuresPromise;
  console.log(`browsa[pdf]: extract done in ${Math.round(performance.now() - t0)}ms ` +
    `(viaWasm=${result.viaWasm}, ${result.numPages}p, outline=${result.outline?.length || 0}, figures=${result.figureImages?.length || 0})`);
  return result;
}
