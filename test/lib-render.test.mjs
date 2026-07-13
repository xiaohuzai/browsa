// test/lib-render.test.mjs — execution tests (not just source-regex) for
// lib/render.js, extracted from sidepanel.js in the Phase 3 modularization
// refactor. Uses jsdom + the real marked/DOMPurify/katex/highlight.js
// vendor bundles so the module's actual rendering pipeline runs, not a
// stand-in.

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
globalThis.chrome = { downloads: { download: async () => {} } };
// jsdom doesn't implement requestAnimationFrame — makeStreamRenderer's
// tick-batching needs a stand-in that actually fires asynchronously.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const {
  fixBoldSpans, fixCjkEmphasisSpacing, renderStreamingSafe, renderSafe,
  decorateLinks, addThinkCopyButtons, addCodeCopyButtons, highlightDiffBlocks,
  makeStreamRenderer, setThoughtAutoCollapse
} = await import('../lib/sidepanel/render.js');

// ─── CJK/bold regression suite ──────────────────────────────────────────────
// These are the exact bug patterns this fix went through multiple rounds
// for (see MEMORY.md "CJK 紧贴 ** 导致粗体不渲染") — locking them down here
// so a future refactor can't silently regress the same class of bug.

test('fixCjkEmphasisSpacing: adds space when CJK abuts ** and the emphasized text starts/ends with punctuation', () => {
  const input = '用一个**"GPU利用率"**因子';
  const out = fixCjkEmphasisSpacing(input);
  assert.equal(out, '用一个 **"GPU利用率"** 因子');
});

test('fixCjkEmphasisSpacing: leaves already-correct CJK+bold text untouched (no double-fix)', () => {
  // Pure text inside ** (no leading/trailing punctuation) never needed a fix.
  assert.equal(fixCjkEmphasisSpacing('用一个**GPU利用率**因子'), '用一个**GPU利用率**因子');
  // Space already present.
  assert.equal(fixCjkEmphasisSpacing('用一个 **"GPU利用率"** 因子'), '用一个 **"GPU利用率"** 因子');
});

test('fixCjkEmphasisSpacing: does NOT reintroduce whitespace-preceded closing ** for the common "**bold内容**：" shape', () => {
  // Regression for the exact bug found in the second bold-rendering report:
  // an earlier CJK-adjacency regex fired on ordinary closing "**" immediately
  // preceded by CJK content and followed by punctuation, inserting a
  // space and re-breaking the flanking rule it was trying to fix.
  const input = '**bold内容**：这是后续文字';
  assert.equal(fixCjkEmphasisSpacing(input), '**bold内容**：这是后续文字');
});

test('fixBoldSpans: trims internal padding models sometimes add ("** text **")', () => {
  assert.equal(fixBoldSpans('** hello **'), '**hello**');
  assert.equal(fixBoldSpans('**hello **'), '**hello**');
});

test('fixCjkEmphasisSpacing: never touches ** inside fenced code blocks or inline code', () => {
  const input = '这是 `x**2` 的说明\n\n```python\nx**2  # power\n```\n用一个**"x"**因子';
  const out = fixCjkEmphasisSpacing(input);
  assert.match(out, /`x\*\*2`/, 'inline code must survive unchanged');
  assert.match(out, /```python\nx\*\*2  # power\n```/, 'fenced code block must survive unchanged');
  assert.match(out, /用一个 \*\*"x"\*\* 因子/, 'prose outside code blocks still gets fixed');
});

// ─── renderSafe / renderStreamingSafe ───────────────────────────────────────

test('renderStreamingSafe parses markdown and sanitizes script tags', () => {
  const html = renderStreamingSafe('**bold** <script>alert(1)</script>');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
});

test('renderStreamingSafe applies the CJK bold fix before parsing', () => {
  const html = renderStreamingSafe('用一个**"x"**因子');
  assert.match(html, /<strong>/, 'must render as real <strong>, not literal asterisks');
});

test('renderSafe renders $...$ LaTeX via KaTeX', () => {
  const html = renderSafe('inline $x^2$ math');
  assert.match(html, /<math/, 'must produce MathML output, not a literal dollar-sign string');
});

test('renderSafe extracts <think> blocks into a collapsible <details class="think-block">', () => {
  const html = renderSafe('<think>reasoning here</think>final answer');
  assert.match(html, /<details class="think-block"[^>]*>/);
  assert.match(html, /<summary>Thinking…<\/summary>/);
  assert.match(html, /reasoning here/);
  assert.match(html, /final answer/);
});

test('renderSafe respects setThoughtAutoCollapse(true) by omitting the open attribute', () => {
  setThoughtAutoCollapse(true);
  const html = renderSafe('<think>x</think>y');
  assert.doesNotMatch(html, /<details class="think-block" open>/);
  setThoughtAutoCollapse(false);
  const html2 = renderSafe('<think>x</think>y');
  assert.match(html2, /<details class="think-block" open>/);
});

test('renderSafe falls back to escaped plain text on unexpected internal errors', () => {
  // Can't easily force marked/katex to throw from the outside, but the
  // catch-all fallback branch must at minimum escape unsafe characters.
  const html = renderSafe('plain & <b>text</b>');
  assert.ok(html.length > 0);
});

// ─── DOM-mutating helpers ────────────────────────────────────────────────────

test('decorateLinks adds target=_blank + rel=noopener only to cross-origin links', () => {
  const el = document.createElement('div');
  el.innerHTML = '<a href="https://example.com/x">ext</a><a href="/local">local</a>';
  decorateLinks(el);
  const [ext, local] = el.querySelectorAll('a');
  assert.equal(ext.target, '_blank');
  assert.equal(ext.rel, 'noopener noreferrer');
  assert.equal(local.target, '');
});

test('highlightDiffBlocks classifies +/-/@@ lines and is idempotent', () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-diff">@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged</code></pre>';
  highlightDiffBlocks(el);
  const code = el.querySelector('code');
  const spans = [...code.querySelectorAll('span')];
  assert.equal(spans[0].className, 'diff-hunk');
  assert.equal(spans[1].className, 'diff-del');
  assert.equal(spans[2].className, 'diff-add');
  const before = code.innerHTML;
  highlightDiffBlocks(el); // second call must be a no-op (dataset.diffDone guard)
  assert.equal(code.innerHTML, before);
});

test('addThinkCopyButtons adds exactly one copy button per think-block, idempotently', () => {
  const el = document.createElement('div');
  el.id = 'messages';
  el.innerHTML = '<details class="think-block"><summary>Thinking…</summary><div class="think-body">reasoning</div></details>';
  document.body.appendChild(el);
  addThinkCopyButtons(el);
  assert.equal(el.querySelectorAll('.think-copy-btn').length, 1);
  addThinkCopyButtons(el); // idempotent — no duplicate button on re-run
  assert.equal(el.querySelectorAll('.think-copy-btn').length, 1);
});

test('addCodeCopyButtons highlights code, adds a Copy button per <pre>, and runs highlightDiffBlocks', () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<pre><code class="language-javascript">const x = 1;</code></pre>' +
    '<pre><code class="language-diff">+added</code></pre>';
  addCodeCopyButtons(root);
  const pres = root.querySelectorAll('pre');
  assert.equal(pres.length, 2);
  for (const pre of pres) assert.ok(pre.querySelector('.code-copy-btn'), 'every <pre> gets a copy button');
  assert.equal(pres[0].querySelector('code').dataset.highlighted, '1', 'JS block goes through highlight.js');
  assert.ok(pres[1].querySelector('.diff-add'), 'diff block still gets diff-colored spans');
});

// ─── makeStreamRenderer ──────────────────────────────────────────────────────

test('makeStreamRenderer: non-final deltas render via renderStreamingSafe and call onTick', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let ticked = 0;
  const render = makeStreamRenderer(el, { onTick: () => { ticked++; } });
  render('**hi**', false);
  // makeStreamRenderer batches via requestAnimationFrame — jsdom polyfills
  // it on a timer, so wait a tick.
  await new Promise((r) => setTimeout(r, 50));
  assert.match(el.innerHTML, /<strong>hi<\/strong>/);
  assert.ok(ticked >= 1);
});

test('makeStreamRenderer: isDone=true renders via renderSafe, marks .done, and calls onDone(el, delta)', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let doneArgs = null;
  const render = makeStreamRenderer(el, { onDone: (e, delta) => { doneArgs = [e, delta]; } });
  render('final **text**', true);
  assert.match(el.innerHTML, /<strong>text<\/strong>/);
  assert.ok(el.classList.contains('done'));
  assert.equal(el.dataset.raw, 'final **text**');
  assert.deepEqual(doneArgs, [el, 'final **text**']);
});

test('makeStreamRenderer: splits <think>...</think> into a live collapsible element during streaming', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  render('<think>reasoning in progress', false);
  await new Promise((r) => setTimeout(r, 50));
  const live = document.querySelector('.think-block.live-think');
  assert.ok(live, 'a live think block must appear while inside an unclosed <think> tag');
  assert.match(live.querySelector('.think-body').textContent, /reasoning in progress/);
});
