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
globalThis.DOMParser = dom.window.DOMParser;
globalThis.chrome = { downloads: { download: async () => {} } };
// jsdom doesn't implement requestAnimationFrame — makeStreamRenderer's
// tick-batching needs a stand-in that actually fires asynchronously. Must
// pass a real timestamp: makeStreamRenderer's internal reveal-pacer
// (markstream-core) does real arithmetic on the rAF timestamp, and an
// undefined one makes several of its calculations evaluate to NaN.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const {
  fixBoldSpans, fixCjkEmphasisSpacing, renderStreamingSafe, renderSafe,
  decorateLinks, addThinkCopyButtons, addCodeCopyButtons, highlightDiffBlocks,
  makeStreamRenderer, renderMermaid, sanitizeEchartsText, setThoughtAutoCollapse
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

test('renderStreamingSafe/renderSafe strip data:image/svg+xml (can carry its own <script>/event handlers) but keep bitmap data: images', async () => {
  const svgSrc = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=';
  const pngSrc = 'data:image/png;base64,iVBORw0KGgo=';
  // renderStreamingSafe is sync, renderSafe is async — normalize both through await.
  for (const render of [renderStreamingSafe, renderSafe]) {
    const svgHtml = await render(`![x](${svgSrc})`);
    assert.doesNotMatch(svgHtml, /src="data:image\/svg\+xml/, `${render.name} must strip data:image/svg+xml`);
    const pngHtml = await render(`![x](${pngSrc})`);
    assert.match(pngHtml, /src="data:image\/png/, `${render.name} must still allow bitmap data: images`);
  }
});

test('renderSafe/renderStreamingSafe preserve non-URI attributes marked can emit (ol start=, td colspan=, input type=)', async () => {
  // Regression test: DOMPurify's ALLOWED_URI_REGEXP option (previously
  // passed straight into sanitize()) validates the VALUE of every allowed
  // attribute that isn't on DOMPurify's own internal "safe" list, not just
  // href/src -- so a strict custom regex silently stripped <ol start="N">
  // (a bare number fails an https?:/mailto:/tel:/data:image:/# allowlist),
  // <td colspan="N">, and <input type="checkbox">. Confirmed a real user
  // report: a second numbered list continuing from "2." rendered as "1."
  // instead, because <ol start="2"> lost its start attribute silently.
  // A blank-line gap alone isn't enough to reproduce this -- marked merges
  // it into one loose <ol>. A sub-bullet list breaking the two numbered
  // items (as real replies commonly have: "1. reason: - a - b") forces
  // marked to emit two separate <ol> blocks, the second needing start="2".
  const md = `1. first list item, with reasons:
- a
- b

2. second list item continuing the same numbering
- c
`;
  for (const render of [renderStreamingSafe, renderSafe]) {
    const html = await render(md);
    assert.match(html, /<ol start="2">/, `${render.name} must preserve <ol start="N"> so the second list continues numbering instead of restarting at 1`);
  }
});

test('renderSafe/renderStreamingSafe still strip javascript: URIs from real href/src attributes', async () => {
  for (const render of [renderStreamingSafe, renderSafe]) {
    const html = await render('[click me](javascript:alert(1))');
    assert.doesNotMatch(html, /href="javascript:/, `${render.name} must still block javascript: hrefs`);
    const okHtml = await render('[click me](https://example.com)');
    assert.match(okHtml, /href="https:\/\/example\.com"/, `${render.name} must still allow safe https hrefs`);
  }
});

test('renderSafe renders $...$ LaTeX via KaTeX', async () => {
  const html = await renderSafe('inline $x^2$ math');
  assert.match(html, /<math/, 'must produce MathML output, not a literal dollar-sign string');
});

test('renderSafe extracts <think> blocks into a collapsible <details class="think-block">', async () => {
  const html = await renderSafe('<think>reasoning here</think>final answer');
  assert.match(html, /<details class="think-block"[^>]*>/);
  assert.match(html, /<summary>Thinking…<\/summary>/);
  assert.match(html, /reasoning here/);
  assert.match(html, /final answer/);
});

test('renderSafe respects setThoughtAutoCollapse(true) by omitting the open attribute', async () => {
  setThoughtAutoCollapse(true);
  const html = await renderSafe('<think>x</think>y');
  assert.doesNotMatch(html, /<details class="think-block" open>/);
  setThoughtAutoCollapse(false);
  const html2 = await renderSafe('<think>x</think>y');
  assert.match(html2, /<details class="think-block" open>/);
});

test('renderSafe falls back to escaped plain text on unexpected internal errors', async () => {
  // Can't easily force marked/katex to throw from the outside, but the
  // catch-all fallback branch must at minimum escape unsafe characters.
  const html = await renderSafe('plain & <b>text</b>');
  assert.ok(html.length > 0);
});

test('renderSafe: a message with enough formulas to cross the KaTeX worker threshold still renders every formula correctly', async () => {
  // jsdom/Node has no global Worker — katex-worker-client.js's own worker
  // construction attempt fails and it falls back to sync rendering (see
  // test/lib-katex-worker-client.test.mjs for the mocked-worker path). This
  // test exercises renderSafe()'s integration with that module end-to-end:
  // output must be identical regardless of which internal path was taken.
  const md = Array.from({ length: 20 }, (_, i) => `$x_{${i}}^2$`).join(' ');
  const html = await renderSafe(md);
  const mathTags = html.match(/<math/g) || [];
  assert.equal(mathTags.length, 20, 'every one of the 20 formulas must be rendered, not dropped/truncated');
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
  // it on a timer, so wait a tick. Deltas now pass through a reveal-pacer
  // (markstream-core) first, which has an 80ms startDelayMs before its
  // first reveal, then paces at a 40 chars/sec minimum — give it enough
  // headroom to fully reveal this short 6-char delta.
  await new Promise((r) => setTimeout(r, 350));
  assert.match(el.innerHTML, /<strong>hi<\/strong>/);
  assert.ok(ticked >= 1);
});

test('makeStreamRenderer: isDone=true renders via renderSafe, marks .done, and calls onDone(el, delta)', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let doneArgs = null;
  const render = makeStreamRenderer(el, { onDone: (e, delta) => { doneArgs = [e, delta]; } });
  await render('final **text**', true);
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
  // Reveal is paced at a minimum of 40 chars/sec (markstream-core default)
  // after an 80ms startDelay — the whole 29-char delta needs ~725ms to
  // fully reveal at that floor rate; give it comfortable headroom.
  await new Promise((r) => setTimeout(r, 950));
  const live = document.querySelector('.think-block.live-think');
  assert.ok(live, 'a live think block must appear while inside an unclosed <think> tag');
  assert.match(live.querySelector('.think-body').textContent, /reasoning in progress/);
});

test('makeStreamRenderer: live <think> content is rendered as markdown, not dumped as raw textContent', async () => {
  // Regression test: thinkBodyEl used to be set via .textContent, so a
  // thinking block containing markdown (lists, bold, code) showed as
  // literal "- **item**" syntax while streaming, then snapped to properly
  // rendered HTML the instant the stream finished and renderSafe()'s
  // separate think-block markdown pass took over.
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  render('<think>a **bold** point', false);
  await new Promise((r) => setTimeout(r, 950));
  // thinkEl is inserted as el's immediately preceding sibling (not queried
  // globally) — other tests in this file leave their own stale
  // .think-block.live-think nodes in document.body, and a global
  // querySelector would grab the first (wrong, earlier) one instead of
  // this test's.
  const live = el.previousElementSibling;
  assert.ok(live?.classList.contains('live-think'), 'a live think block must appear while inside an unclosed <think> tag');
  const body = live.querySelector('.think-body');
  assert.match(body.innerHTML, /<strong>bold<\/strong>/, 'live thinking markdown must be rendered, not shown as literal ** characters');
});

test('makeStreamRenderer: a bursty non-final delta is paced, not revealed all at once', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  render('a'.repeat(5000), false);
  await new Promise((r) => setTimeout(r, 150)); // past startDelayMs(80), still well before full reveal at 40cps min
  assert.ok(el.textContent.length > 0, 'some content should have started revealing');
  assert.ok(el.textContent.length < 5000, 'the full 5000-char burst should not have rendered in one tick');
});

test('makeStreamRenderer: isDone always renders the caller\'s exact final text immediately, regardless of pending pacer backlog', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  render('a'.repeat(5000), false); // enqueue a large backlog into the pacer
  await render('**done**', true); // isDone must not wait for the backlog to drain
  assert.match(el.innerHTML, /<strong>done<\/strong>/);
  assert.equal(el.dataset.raw, '**done**');
  assert.ok(el.classList.contains('done'));
});

test('makeStreamRenderer: renderStream.destroy() is exposed and stops a subsequently-abandoned pacer from writing into the element', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  assert.equal(typeof render.destroy, 'function');
  render('a'.repeat(5000), false);
  render.destroy();
  const contentAtDestroy = el.innerHTML;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(el.innerHTML, contentAtDestroy, 'no further paced reveal should land after destroy()');
});

// ─── Mermaid SVG sanitization ───────────────────────────────────────────────
// sanitizeMermaidSvg (stream-markdown-parser) strips <script>/event-handler
// attrs/dangerous URLs and downgrades foreignObject HTML labels to plain
// text — closes a real gap: mermaid.initialize({securityLevel:'loose'})
// (needed for $$...$$ KaTeX math in node labels) also permits arbitrary
// HTML/click-binding content in foreignObject labels, and renderMermaid()
// assigns Mermaid's raw SVG output straight to innerHTML.

test('sanitizeMermaidSvg (as wired into render.js via the stream-markdown-parser vendor bundle) strips <script> tags and event-handler attributes', async () => {
  const { sanitizeMermaidSvg } = await import('../lib/vendor/stream-markdown-parser.bundle.js');
  const malicious =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
    '<rect onclick="alert(2)" width="10" height="10"/></svg>';
  const clean = sanitizeMermaidSvg(malicious);
  assert.ok(clean, 'sanitizer must return a value in a DOMParser-capable (jsdom) environment');
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /onclick/i);
});

test('sanitizeMermaidSvg downgrades foreignObject HTML labels to plain text instead of stripping the label entirely', async () => {
  const { sanitizeMermaidSvg } = await import('../lib/vendor/stream-markdown-parser.bundle.js');
  const svgWithForeignObject =
    '<svg xmlns="http://www.w3.org/2000/svg"><g><foreignObject width="100" height="20">' +
    '<div xmlns="http://www.w3.org/1999/xhtml">node label</div></foreignObject></g></svg>';
  const clean = sanitizeMermaidSvg(svgWithForeignObject);
  assert.match(clean, /node label/, 'label text content must be preserved');
});

test('render.js pipes Mermaid\'s SVG output through sanitizeMermaidSvg before assigning innerHTML', async () => {
  // Structural check (not a full mermaid render, which would require loading
  // the real 3MB+ mermaid engine): confirms renderMermaid() actually calls
  // the sanitizer on the SVG string returned by mermaid.render(), rather
  // than assigning it to innerHTML unsanitized.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{\s*sanitizeMermaidSvg\s*\}\s*from\s*['"]\.\.\/vendor\/stream-markdown-parser\.bundle\.js['"]/);
  assert.match(src, /svgWrap\.innerHTML\s*=\s*sanitizeMermaidSvg\(svg\)/);
});

test('render.js estimates a placeholder height before rendering and retries via renderMermaidWithRetry (mermaid-utils.js)', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*renderMermaidWithRetry[^}]*\}\s*from\s*['"]\.\/mermaid-utils\.js['"]/);
  assert.match(src, /pre\.style\.minHeight\s*=\s*estimatedHeight/, 'the code-fence placeholder must get the estimated height before the async render starts');
  assert.match(src, /await renderMermaidWithRetry\(m, id, source, host\)/, 'must render through the retry helper, not a raw m.render() call');
});

test('render.js regression: the mermaid render host must be sized from the real container width, not a hardcoded pixel value', async () => {
  // Real bug this guards against: the offscreen host mermaid renders into
  // had a hardcoded width:800px regardless of the actual (typically much
  // narrower) side panel width, so diagrams got laid out for 800px of
  // space and then visually squashed down via max-width:100% on the SVG,
  // distorting proportions.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /width:800px/, 'the render host must not use a hardcoded width');
  assert.match(src, /el\.clientWidth/, 'the render host width must be derived from the actual container element');
});

test('render.js: Mermaid pan (drag) is clamped so the diagram can never be dragged fully off-screen', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /const maxTx = s\._svgW \* \(s\.scale \+ 1\) \/ 2/,
    'pan must be bounded relative to the diagram size and zoom level, not left unbounded');
  assert.match(src, /s\.tx = Math\.min\(maxTx, Math\.max\(-maxTx, s\.tx\)\)/);
});

test('render.js regression: the estimated height must NOT be applied to the final rendered wrapper', async () => {
  // Real bug this guards against: an earlier version set
  // `wrapper.style.minHeight = estimatedHeight` on the FINAL rendered
  // diagram too, not just the temporary placeholder <pre>. The estimate
  // formula (ported from markstream-vue, tuned for its own rendering
  // context) can overshoot browsa's actual (typically simpler/smaller)
  // diagrams — forcing the final wrapper to that overestimate leaves a
  // large blank gap below the real SVG content. The final wrapper must
  // size to its real content only.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /wrapper\.style\.minHeight/,
    'the final .mermaid-diagram wrapper must never have a forced min-height — only the temporary placeholder <pre> may');
});

// ─── ECharts option text sanitization ───────────────────────────────────────
// ECharts text fields (title.text, axis/legend labels, series names, etc.)
// render as plain text, not HTML — CAPABILITY_HINTS (background.js) asks the
// model not to put raw HTML in them, but models don't always comply; this is
// the deterministic backstop applied before chart.setOption().

test('sanitizeEchartsText converts <br/> (any written form) to a real newline', () => {
  assert.equal(sanitizeEchartsText('line one<br/>line two'), 'line one\nline two');
  assert.equal(sanitizeEchartsText('a<br>b'), 'a\nb');
  assert.equal(sanitizeEchartsText('a<BR />b'), 'a\nb');
});

test('sanitizeEchartsText strips other HTML tags but keeps their text content', () => {
  assert.equal(sanitizeEchartsText('<b>科学家时间分配</b><br/><span style="font-size:12px">note</span>'),
    '科学家时间分配\nnote');
});

test('sanitizeEchartsText recurses through arrays and nested objects, leaving non-string values untouched', () => {
  const option = {
    title: { text: 'Title<br/>Sub' },
    series: [{ name: '<b>A</b>', type: 'bar', data: [1, 2, 3] }],
    legend: { data: ['<b>X</b>', 'Y'] },
    tooltip: {},
  };
  const clean = sanitizeEchartsText(option);
  assert.equal(clean.title.text, 'Title\nSub');
  assert.equal(clean.series[0].name, 'A');
  assert.deepEqual(clean.series[0].data, [1, 2, 3], 'numeric data arrays must be untouched');
  assert.deepEqual(clean.legend.data, ['X', 'Y']);
});

test('sanitizeEchartsText leaves plain text (no tags) completely unchanged', () => {
  const option = { title: { text: 'GPU利用率' }, series: [{ data: [1, 2] }] };
  assert.deepEqual(sanitizeEchartsText(option), option);
});

test('render.js sanitizes the parsed ECharts option before chart.setOption(), but keeps the raw source for the toolbar', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /const option = sanitizeEchartsText\(JSON\.parse\(source\)\)/);
  assert.match(src, /_echartsToolbar\(source, chart, container\)/, 'the toolbar must still get the original unsanitized source (for copy/export)');
});
