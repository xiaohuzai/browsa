// test/lib-stream-incremental.test.mjs — pins the blockwise incremental
// streaming render (render.js's findStreamingBlockBoundary +
// createStreamingTarget wired into makeStreamRenderer). The old path
// re-parsed the ENTIRE accumulated text every reveal frame (O(n²) over a
// stream); these tests prove the replacement commits completed blocks once,
// re-parses only the open tail per frame, and still ends DONE with the same
// final renderSafe output.
//
// FEEDING CONTRACT (mirrors production): renderStream(delta) receives the
// NEW SUFFIX per call — sidepanel.js passes m.delta, never the accumulated
// text. Feeding cumulative strings here would concatenate them into
// fullAccum exactly like production would.

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
globalThis.DOMParser = dom.window.DOMParser;
// jsdom doesn't implement requestAnimationFrame — makeStreamRenderer's
// tick-batching needs one that actually fires asynchronously with a real
// timestamp (markstream-core does timestamp arithmetic).
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { findStreamingBlockBoundary, makeStreamRenderer, renderStreamingSafe } =
  await import('../lib/sidepanel/render.js');
const marked = (await import('../lib/vendor/marked.bundle.js')).default;

// The pacer reveals at its own cadence (~30fps commits, catch-up capped by
// maxCharsPerSecond) — tests wait on visible conditions instead of counting
// timers. Timeout is generous: in this environment the effective reveal rate
// is ~150 chars/s.
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeoutMs = 15000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await tick(15);
  }
};

test('findStreamingBlockBoundary: commits at blank lines between paragraphs', () => {
  const text = 'first para\n\nsecond para\n\nthird para partial';
  // Everything through the blank line after "second para" is commitable.
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), 'first para\n\nsecond para\n');
  assert.ok(b < text.length, 'partial paragraph stays in the tail');
});

test('findStreamingBlockBoundary: never splits inside an unclosed fence', () => {
  const text = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
  const b = findStreamingBlockBoundary(text, 0);
  // "intro" is complete; everything from the blank run before the fence
  // opener is tail (the tail starts with the boundary's newline).
  assert.equal(text.slice(0, b), 'intro\n');
  assert.ok(text.slice(b).trimStart().startsWith('```js'));
});

test('findStreamingBlockBoundary: resumes committing after a fence closes', () => {
  const text = '```js\ncode()\n```\n\nafter the fence\n\nmore';
  const b = findStreamingBlockBoundary(text, 0);
  assert.ok(text.slice(0, b).includes('after the fence'), 'block after the closed fence commits');
  assert.ok(text.slice(b).includes('more'), 'trailing partial paragraph stays in the tail');
});

test('findStreamingBlockBoundary: blank line between two list items is NOT a split point (loose list)', () => {
  const text = '- item one\n\n- item two\n\nplain paragraph';
  const b = findStreamingBlockBoundary(text, 0);
  // The blank line between the items is rejected (loose-list continuation),
  // so the whole list commits as one chunk right before the paragraph.
  assert.equal(text.slice(0, b), '- item one\n\n- item two\n');
});

test('findStreamingBlockBoundary: list followed by a paragraph does split (after the list)', () => {
  const text = '- a\n- b\n\npara';
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), '- a\n- b\n');
});

test('findStreamingBlockBoundary: no boundary without blank lines or content', () => {
  assert.equal(findStreamingBlockBoundary('no blank lines at all', 0), 0);
  // A leading blank run may commit (the chunk parses to nothing visible) but
  // never beyond it.
  assert.ok(findStreamingBlockBoundary('\n\npara', 0) <= 2);
});

test('findStreamingBlockBoundary: trailing blank run at EOF is commitable', () => {
  const text = 'para one\n\npara two\n\n';
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), 'para one\n\npara two\n');
});

test('incremental streaming: mid-stream DOM matches a whole-text parse, and total parse volume is O(text), not O(text × ticks)', async () => {
  // 8 paragraphs streamed in ~100 suffix deltas. The old whole-text-per-frame
  // path re-parses the accumulated document every reveal frame; the
  // incremental path parses each completed block once + a small tail.
  const paras = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} with **bold ${i}** and some filler text to give it length.`);
  const full = paras.join('\n\n');

  let parseCalls = 0, parsedChars = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { parseCalls++; parsedChars += s.length; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    // Feed suffix deltas (production shape), waiting past the pacer's start
    // delay so reveal frames actually run. Split AFTER each space so the
    // whitespace stays attached to the preceding token (suffixes must lose
    // no characters).
    const tokens = full.split(/(?<= )/);
    let fed = 0;
    for (const t of tokens) {
      render(t, false);
      fed += t.length;
      if (fed > 40) { await tick(); fed = 0; } // batch a few deltas per pacer frame
    }
    // Wait for the LAST paragraph (an early one matches too soon).
    await until(() => el.textContent.replace(/\s+/g, ' ').includes('Paragraph 7 with bold 7 and some filler text to give it length.'), 30000);

    const midText = el.textContent.replace(/\s+/g, ' ').trim();
    const expectText = renderStreamingSafe(full).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(midText, expectText, 'mid-stream visible text must equal a whole-text streaming parse');
    assert.equal(el.querySelectorAll('p').length, 8, 'all 8 paragraphs present as separate blocks');
    // The invariant: total parsed chars stays on the order of the document,
    // not document × frames. 8 paragraphs ≈ 560 chars; the old path at
    // ~30fps for this stream would parse tens of KB.
    assert.ok(parsedChars < 560 + 400 * 120,
      `total parsed chars ${parsedChars} must be ~O(document), not O(document × frames)`);
    assert.ok(parseCalls < 300, `parse calls ${parseCalls} must be per-block+per-tail, never whole-document`);

    // DONE carries the full final text (production: the DONE chunk's `full`),
    // replacing the incremental DOM with the definitive renderSafe output.
    render(full, true);
    await tick();
    assert.equal(el.dataset.raw, full, 'DONE stamps the raw markdown');
    assert.ok(el.classList.contains('done'), 'DONE marks the bubble done');
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('incremental streaming: a committed prefix is never re-parsed when later text grows', async () => {
  // Stream paragraph 1 fully, let it commit, then stream a LONG second
  // paragraph: paragraph 1 must never be re-parsed again.
  const p1 = 'First paragraph is already complete.';
  const p2 = 'Second paragraph streams in slowly. ' + 'more words here '.repeat(20);
  const full = `${p1}\n\n${p2}`;

  let p1Parses = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { if (s.includes('already complete')) p1Parses++; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    render(p1, false);
    await until(() => el.textContent.includes('already complete'));
    render('\n\n', false);
    await tick(); await tick(); // the blank line lets the boundary commit p1
    const p1ParsesAtCommit = p1Parses;
    assert.ok(p1ParsesAtCommit >= 1, 'paragraph 1 got parsed (as tail, then as commit chunk)');

    // Stream p2 in suffix chunks.
    const tokens = p2.match(/\S+\s*/g) || [];
    for (const t of tokens) {
      render(t, false);
      await tick(10);
    }
    await until(() => el.textContent.includes('more words here more words here'), 20000);
    assert.equal(p1Parses, p1ParsesAtCommit,
      'committed paragraph 1 must never be re-parsed while paragraph 2 streams');
    assert.ok(!el.textContent.includes('already complete. already complete.'), 'no duplicated content');
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('incremental streaming: live think block renders, freezes after close, and DONE replaces everything', async () => {
  let thinkParses = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { if (s.includes('Reasoning about')) thinkParses++; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    const thinkText = 'Reasoning about the problem. ' + 'step; '.repeat(30);
    render(`<thinking>`, false);
    // Stream the think body in suffix chunks so reveal catches up.
    const chunks = thinkText.match(/\S+\s*/g) || [];
    for (const c of chunks) { render(c, false); await tick(5); }
    await until(() => document.querySelector('.live-think .think-body')?.textContent.includes('Reasoning'), 20000);
    assert.ok(document.querySelector('.live-think .think-body'), 'live think block appeared');

    // Close the think tag, let the reveal pass it, then stream the answer:
    // from the moment the answer text is visible, the think text is frozen
    // and must never be re-parsed (the freeze short-circuit skips all work).
    render(`</thinking>\n\nFinal answer`, false);
    // Sample the freeze point only after the reveal has fully passed the
    // close tag: the last think chars visible AND the answer showing.
    const thinkBodyEl = () => document.querySelector('.live-think .think-body');
    await until(() => el.textContent.includes('Final answer')
      && (thinkBodyEl()?.textContent.length || 0) >= thinkText.length - 1, 30000);
    const thinkParsesFrozen = thinkParses;
    for (let i = 0; i < 6; i++) {
      render(` word ${i}`, false);
      await tick(30);
    }
    assert.equal(thinkParses, thinkParsesFrozen,
      'frozen think text must not be re-parsed while the answer streams');

    // DONE carries the FULL final text (production shape), replacing the
    // incremental DOM with the definitive renderSafe output.
    const finalText = `<thinking>${thinkText}</thinking>\n\nFinal answer word 0 word 1 word 2 word 3 word 4 word 5 done.`;
    render(finalText, true);
    await tick();
    assert.equal(document.querySelector('.live-think'), null, 'DONE removes the live think block');
    assert.ok(el.textContent.includes('Final answer'), 'DONE renders the final answer');
    assert.equal(el.dataset.raw, finalText, 'DONE stamps the raw markdown');
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('incremental streaming: destroy() mid-stream leaves the revealed text in place', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  render('partial text without done', false);
  await until(() => el.textContent.includes('partial text'));
  render.destroy();
  assert.ok(el.textContent.includes('partial text'), 'destroy does not wipe already-revealed text (caller re-renders)');
  el.remove();
});
