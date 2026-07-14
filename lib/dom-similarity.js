// lib/dom-similarity.js -- pure string/descriptor similarity utilities.
// No DOM dependency, so this is the tested source of truth for the scoring
// algorithm used by page-extractor.js's MAIN-world injected
// _relocateXhsAnchorsInPageWorld (XHS adaptive selector relocation). That
// function can't import this module (chrome.scripting.executeScript only
// serializes the function itself), so it inlines a copy of scoreDescriptors
// -- keep both in sync if the algorithm changes.

// Zero-width chars: U+200B, U+200C, U+200D, U+2060, U+FEFF
const ZERO_WIDTH_RE = new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g");
// C0 control chars (U+0000-U+001F) except \t (U+0009) and \n (U+000A), plus C1 (U+007F-U+009F)
const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g");

/** Collapse whitespace and strip zero-width/control characters (keeps \n and \t). */
export function cleanText(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bigrams(str) {
  const s = String(str).toLowerCase();
  if (s.length < 2) return new Set(s ? [s] : []);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** Normalized 0-1 similarity between two strings via Dice-coefficient bigram overlap. */
export function stringRatio(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  if (sa === sb) return 1;
  if (!sa || !sb) return 0;
  const ga = bigrams(sa);
  const gb = bigrams(sb);
  if (ga.size === 0 || gb.size === 0) return sa === sb ? 1 : 0;
  let overlap = 0;
  for (const g of ga) if (gb.has(g)) overlap++;
  return (2 * overlap) / (ga.size + gb.size);
}

/**
 * Weighted similarity score (0-1) between two element descriptors:
 * { tag, classes: string[], id, attrs: {}, text, depth, parentTag }
 * Ported concept from Scrapling's adaptive-relocation scorer (parser.py),
 * not its code -- reimplemented from scratch for JS.
 */
export function scoreDescriptors(a, b) {
  if (!a || !b) return 0;
  if ((a.tag || '').toLowerCase() !== (b.tag || '').toLowerCase()) return 0;

  const classRatio = stringRatio((a.classes || []).join(' '), (b.classes || []).join(' '));
  const idRatio = stringRatio(a.id || '', b.id || '');
  const textRatio = stringRatio(a.text || '', b.text || '');
  const attrsRatio = stringRatio(
    JSON.stringify(a.attrs || {}),
    JSON.stringify(b.attrs || {})
  );
  const parentRatio = (a.parentTag || '').toLowerCase() === (b.parentTag || '').toLowerCase() ? 1 : 0;
  const depthRatio = Number.isFinite(a.depth) && Number.isFinite(b.depth)
    ? 1 / (1 + Math.abs(a.depth - b.depth))
    : 0.5;

  return (
    classRatio * 0.3 +
    idRatio * 0.2 +
    textRatio * 0.25 +
    attrsRatio * 0.1 +
    parentRatio * 0.1 +
    depthRatio * 0.05
  );
}
