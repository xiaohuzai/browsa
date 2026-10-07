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
  decorateLinks, addThinkCopyButtons, addCodeCopyButtons, highlightDiffBlocks, extractCodeText,
  makeStreamRenderer, renderMermaid, sanitizeEchartsText, setThoughtAutoCollapse,
  stripThinkSegments, linkifyTimestamps, decorateFigureRefs, figuresBeforeEntry,
  wantsChartVendors, FENCED_RENDERERS, renderUserContent, renderMathInPlainText
} = await import('../lib/sidepanel/render.js');

test('wantsChartVendors detects every FENCED_RENDERERS language fence, nothing else', () => {
  const fence = '```';
  for (const lang of FENCED_RENDERERS) {
    assert.equal(wantsChartVendors(`intro\n\n${fence}${lang}\nx\n${fence}\n`), true, lang);
  }
  assert.equal(wantsChartVendors('```js\nconst a = 1;\n```'), false, 'plain code fence must not trigger the ~7MB warm-up');
  assert.equal(wantsChartVendors('```javascript\nx\n```'), false);
  assert.equal(wantsChartVendors('```mermaidxyz\nx\n```'), false, 'word boundary must not match language prefixes');
  assert.equal(wantsChartVendors('no fences at all'), false);
  assert.equal(wantsChartVendors(undefined), false);
});

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

test('fixBoldSpans: \\\\p{S} symbols ($, ×) count as punctuation and ASCII letters/digits count as neighbors (2026-09-30 ∗∗、∗∗ report)', () => {
  // The report shape: 从**$8K**、**$20K** — plain \\p{P} missed $ (\\p{Sc}) and
  // the CJK-only neighbor test missed ASCII, so the opener stayed unparseable.
  assert.equal(fixBoldSpans('从**$8K**涨到**$20K**'), '从 **$8K**涨到 **$20K**');
  assert.equal(fixBoldSpans('MRR**$8K**'), 'MRR **$8K**');
  assert.equal(fixBoldSpans('**2.5×**涨到**6×**'), '**2.5×** 涨到**6×**');
  // Plain-text inners still get no pad, whatever the neighbor alphabet is.
  assert.equal(fixBoldSpans('MRR**增长**了'), 'MRR**增长**了');
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

test('renderSafe: bare-dollar bold spans survive intact (2026-09-30 ∗∗、∗∗ report — the $s must not pair into a formula)', async () => {
  // Model output: 中位 MRR 从**$8K**、**$20K**. The two bare $ used to pair
  // across the ** and 、, KaTeX rendered the *s as ∗ (U+2217) math glyphs and
  // the bubble showed "8K∗∗、∗∗8K**、**20K". Pandoc's digit-after-closer rule
  // rejects the pairing; fixBoldSpans then makes both bolds parse.
  const html = await renderSafe('中位 MRR 从**$8K**、**$20K**');
  assert.doesNotMatch(html, /katex-error/);
  assert.ok(!html.includes('∗'), 'no math-mode asterisk glyphs (U+2217) may appear');
  assert.doesNotMatch(html, /\*\*/, 'no literal ** may remain');
  assert.equal((html.match(/<strong>/g) || []).length, 2, 'both spans render as bold');
  assert.ok(html.includes('$8K') && html.includes('$20K'));
});

test('renderSafe: "$5 and $10" money prose never becomes math (Pandoc tightness + digit rules)', async () => {
  // "5 and " has a space before the closer → rejected; "$10" would also trip
  // the digit-after-closer rule. Either way both $s stay literal text.
  const html = await renderSafe('花了 $5 and $10 买材料');
  assert.doesNotMatch(html, /<math/);
  assert.doesNotMatch(html, /katex-error/);
  assert.ok(html.includes('$5 and $10'));
});

test('renderSafe: spaced formula "$ x^2 $" renders literal (Pandoc tight-opening rule)', async () => {
  // Deliberate contract change (2026-09-30): loose inline $ delimiters are no
  // longer math — Pandoc and every prose-heavy pipeline reject them because
  // they collide with dollar amounts. Tight $...$ is unaffected.
  const html = await renderSafe('loose $ x^2 $ stays text');
  assert.doesNotMatch(html, /<math/);
  assert.ok(html.includes('$ x^2 $'));
});

test('renderSafe: $…$ inside fenced/inline code is verbatim data, never extracted (2026-10-01 fence guard)', async () => {
  // LaTeX tutorials deliberately put raw LaTeX inside a fence so it does NOT
  // render; the old extraction swallowed it into a placeholder the moment the
  // final renderSafe ran (streaming looked fine, DONE "broke" the bubble).
  const html = await renderSafe('```latex\nThe formula $E = mc^2$ is famous.\n```');
  assert.doesNotMatch(html, /<math/, 'fence content must not become KaTeX');
  assert.ok(html.includes('$E = mc^2$'), 'fence body stays verbatim');
  const html2 = await renderSafe('看 `x=$foo$bar` 与 $y^2$ 真公式');
  assert.ok(html2.includes('x=$foo$bar'), 'inline code untouched');
  assert.match(html2, /<math/, 'prose math still renders');
});

test('renderSafe: two fences each holding $$ never pair across the fence (echo $$ shell docs)', async () => {
  // The block-math regex's [\s\S]*? used to pair the two $$ across the fences
  // and everything in between became ONE giant invalid formula.
  const html = await renderSafe('```bash\necho $$\n```\n\nbetween\n\n```bash\necho $$\n```');
  assert.doesNotMatch(html, /<math/);
  assert.equal((html.match(/echo \$\$/g) || []).length, 2, 'both fences keep their $$ verbatim');
});

test('sanitizeMarkmapNodeHtml strips script/iframe/event handlers, keeps benign formatting + anchors', async () => {
  // markmap-lib parses with html:true and markmap-view lands node HTML in the
  // extension page DOM via d3 innerHTML — before 2026-10-01 it was the only
  // SVG renderer with NO sanitization (mermaid has sanitizeMermaidSvg).
  const { sanitizeMarkmapNodeHtml } = await import('../lib/sidepanel/render.js');
  const out = sanitizeMarkmapNodeHtml(
    '<p><strong>hi</strong><script>alert(1)</script>' +
    '<a href="https://evil.example">x</a>' +
    '<img src="https://example.com/i.png">' +
    '<iframe src="https://evil.example"></iframe>' +
    '<b onclick="alert(1)">y</b></p>'
  );
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /<iframe/);
  assert.doesNotMatch(out, /onclick/);
  assert.match(out, /<strong>hi<\/strong>/);
  assert.match(out, /href="https:\/\/evil\.example"/, 'benign anchors survive — decorateLinks adds target/rel separately');
  assert.match(out, /<img/);
});

test('initMermaidTheme re-initializes on OS theme hot-switch (per-render parity with the other renderers)', async () => {
  // The theme used to be snapshotted into mermaid.initialize ONCE at first
  // module load — after an OS dark/light hot-switch, NEW diagrams kept the
  // stale theme (echarts/markmap/dot/rdkit all re-read matchMedia per render).
  const { initMermaidTheme } = await import('../lib/sidepanel/render.js');
  const calls = [];
  const fake = { initialize: (cfg) => calls.push(cfg.theme) };
  const orig = window.matchMedia;
  try {
    window.matchMedia = () => ({ matches: true });
    initMermaidTheme(fake);            // dark
    window.matchMedia = () => ({ matches: false });
    initMermaidTheme(fake);            // hot-switch → light
    initMermaidTheme(fake);            // same theme → no-op
  } finally {
    window.matchMedia = orig;
  }
  assert.deepEqual(calls, ['dark', 'default'], 're-init only on theme change');
});

test('renderSafe: symbol-punctuation bold adjacent to CJK still parses (**2.5×**涨到)', async () => {
  const html = await renderSafe('硬科技占比从**2.5×**涨到**6×**');
  assert.doesNotMatch(html, /\*\*/, 'no literal ** may remain');
  assert.equal((html.match(/<strong>/g) || []).length, 2);
});

test('renderSafe: markdown-escaped dollars (\\$) are literal currency, never math delimiters (2026-09-30 MRR table report)', async () => {
  // Verbatim shape from the field report: \$8K and \$20K share one table row,
  // so their two $ used to pair into the invalid formula "8K | \" — KaTeX
  // throwOnError:false echoed it as a red .katex-error and the leftover \
  // + 20K rendered around it ("\8K | \20K").
  const md = [
    '| 指标 | 过去 | 现在 | 变化 |',
    '|---|---|---|---|',
    '| 批次结束时中位 MRR | \\$8K | \\$20K | $2.5\\times$ |',
    '| 从 0 到七位数年收入 | 约 18 个月 | 约 3 个月（批次内） | 约 $6\\times$ 更快 |',
  ].join('\n');
  const html = await renderSafe(md);
  assert.doesNotMatch(html, /katex-error/, 'escaped dollars must not pair into a broken formula');
  assert.ok(html.includes('$8K'), `literal $8K must survive, got: ${html}`);
  assert.ok(html.includes('$20K'), 'literal $20K must survive');
  assert.match(html, /<math/, 'the real $2.5\\times$ formula must still render as math');
  assert.match(html, /<math/, 'the $6\\times$ formula must still render as math');
});

test('renderSafe: \\\\ before a real delimiter is an escaped backslash, the $ after it still opens math', async () => {
  const html = await renderSafe('\\\\$x^2$');
  assert.doesNotMatch(html, /katex-error/);
  assert.match(html, /<math/);
});

test('renderSafe: \\\\ inside $...$ (matrix row separator) stays part of the formula', async () => {
  const html = await renderSafe('$\\begin{matrix}1\\\\2\\end{matrix}$');
  assert.doesNotMatch(html, /katex-error/, 'the \\\\ guard must not split a formula containing \\\\');
  assert.match(html, /<math/);
});

test('renderSafe extracts <think> blocks into a collapsible <details class="think-block">', async () => {
  const html = await renderSafe('<think>reasoning here</think>final answer');
  assert.match(html, /<details class="think-block"[^>]*>/);
  // Done-state label (the live "Thinking…" element only exists mid-stream —
  // a permanent progress label on finished messages reads as still-in-flight).
  assert.match(html, /<summary>Thought process<\/summary>/);
  assert.match(html, /reasoning here/);
  assert.match(html, /final answer/);
});

test('renderSafe drops whitespace-only think blocks instead of rendering an empty collapsible', async () => {
  const html = await renderSafe('你好！<think>\n</think>');
  assert.doesNotMatch(html, /think-block/, 'an empty think must not leave an empty "thinking" shell');
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /你好！/);
});

test('renderSafe respects setThoughtAutoCollapse(true) by omitting the open attribute', async () => {
  setThoughtAutoCollapse(true);
  const html = await renderSafe('<think>x</think>y');
  assert.doesNotMatch(html, /<details class="think-block" open>/);
  setThoughtAutoCollapse(false);
  const html2 = await renderSafe('<think>x</think>y');
  assert.match(html2, /<details class="think-block" open>/);
});

test('thinking blocks DEFAULT to collapsed (fresh module, no setThoughtAutoCollapse call)', async () => {
  // 用户反馈展开不好看 → 默认折叠。sidepanel 以 !== false 传入：storage 里显式
  // 存过 false（取消勾选）才展开；从未设置（undefined）折叠。fresh import 绕过
  // 本文件其他测试对模块状态的修改。
  const fresh = await import('../lib/sidepanel/render.js?default-think-collapse');
  const html = await fresh.renderSafe('<think>x</think>y');
  assert.doesNotMatch(html, /<details class="think-block" open>/);
  assert.match(html, /<details class="think-block">/);
});

test('stripThinkSegments removes think blocks (incl. unclosed tail) and keeps the body', () => {
  // 消息 copy 只复制正文：thinking 内容不进剪贴板（它有自己的 Copy thinking 按钮）。
  assert.equal(stripThinkSegments('<think>内部推理</think>你好'), '你好');
  assert.equal(stripThinkSegments('<thinking>abc</thinking>\n\n正文一'), '正文一');
  assert.equal(stripThinkSegments('<antml:thinking>x</antml:thinking>body'), 'body');
  // 多个 think 段、夹在正文中间
  assert.equal(stripThinkSegments('A<think>x</think>B<thinking>y</thinking>C'), 'ABC');
  // 未闭合（流式中断）→ 尾部全是 think，丢弃
  assert.equal(stripThinkSegments('正文<think>没写完'), '正文');
  assert.equal(stripThinkSegments('<think>只有思考'), '');
  // 无 think 原样返回
  assert.equal(stripThinkSegments('普通消息'), '普通消息');
  assert.equal(stripThinkSegments(''), '');
  assert.equal(stripThinkSegments(null), '');
});

test('renderSafe: a echoed math/think placeholder does not downgrade the whole message', async () => {
  // A literal BROWSAMATHnEND in the reply (model quoting our internals) used
  // to destructure undefined in the replace callback → outer catch → the
  // ENTIRE message rendered as escaped plain text. It must degrade to
  // nothing while the real math still renders.
  const html = await renderSafe('real $x^2$ math then BROWSAMATH9END trailing');
  assert.match(html, /<math/, 'the real formula must still render via KaTeX');
  assert.ok(!html.includes('BROWSAMATH9END'), 'the bogus placeholder must be swallowed');
  const html2 = await renderSafe('answer <div data-think="7"></div> done');
  assert.match(html2, /answer/, 'bogus think placeholder must not crash the render');
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

test('highlightDiffBlocks: hljs diff grammar tokenizes +/-/@@ lines, idempotent', () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-diff">@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged</code></pre>';
  highlightDiffBlocks(el);
  const code = el.querySelector('code');
  const addition = code.querySelector('.hljs-addition');
  const deletion = code.querySelector('.hljs-deletion');
  const meta = code.querySelector('.hljs-meta');
  assert.ok(addition && addition.textContent === '+new line', '+ line rides the hljs-addition token');
  assert.ok(deletion && deletion.textContent === '-old line', '- line rides the hljs-deletion token');
  assert.ok(meta && meta.textContent === '@@ -1,2 +1,2 @@', 'hunk header rides the hljs-meta token');
  assert.ok(code.textContent.includes(' unchanged'), 'plain lines stay verbatim');
  const before = code.innerHTML;
  highlightDiffBlocks(el); // second call must be a no-op (dataset.diffDone guard)
  assert.equal(code.innerHTML, before);
});

test('highlightDiffBlocks: language-patch alias goes through the same grammar', () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-patch">+added</code></pre>';
  highlightDiffBlocks(el);
  assert.ok(el.querySelector('.hljs-addition'), 'patch alias shares the diff grammar');
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
  assert.ok(pres[1].querySelector('.hljs-addition'), 'diff block goes through the hljs diff grammar');
});

test('extractCodeText: the copy fallback must NOT carry the button\'s own Copy label', () => {
  // 无语言标注的围栏块：marked 渲染出 <pre><code>（code 无 language-* 类），
  // 旧实现走 pre.textContent 兜底，把 pre 里的按钮文本「复制」一起带进剪贴板。
  const root = document.createElement('div');
  root.innerHTML = '<pre><code>plain fenced block, no language tag</code></pre>';
  const pre = root.querySelector('pre');
  addCodeCopyButtons(root); // 按钮已 appendChild 进 pre（真实时序）
  const code = pre.querySelector('code[class*="language-"]'); // null —— 旧 bug 触发条件
  assert.equal(code, null);
  const text = extractCodeText(pre, code);
  assert.ok(text.startsWith('plain fenced block'), 'code text is preserved');
  assert.ok(!text.includes('复制') && !text.includes('Copy'), 'button label must not leak into the clipboard text');
  assert.ok(text.endsWith('no language tag'), 'trailing button label not appended');
});

test('extractCodeText: language-tagged blocks read the code element directly', () => {
  const root = document.createElement('div');
  root.innerHTML = '<pre><code class="language-python">print(1)</code></pre>';
  const pre = root.querySelector('pre');
  addCodeCopyButtons(root);
  const code = pre.querySelector('code[class*="language-"]');
  assert.equal(extractCodeText(pre, code), 'print(1)');
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
  // The 388KB stream-markdown-parser bundle is lazy-imported on the first
  // mermaid render (getSanitizeMermaidSvg) instead of at module top level —
  // sanitizeMermaidSvg is its ONLY use and mermaid itself is already lazy.
  assert.match(src, /sanitizeModule\s*=\s*import\(\s*['"]\.\.\/vendor\/stream-markdown-parser\.bundle\.js['"]\s*\)/);
  assert.match(src, /const\s+sanitizeMermaidSvg\s*=\s*await\s+getSanitizeMermaidSvg\(\)/);
  assert.match(src, /svgWrap\.innerHTML\s*=\s*sanitizeMermaidSvg\(svg\)/);
});

test('render.js estimates a placeholder height before rendering and retries via renderMermaidWithRetry (mermaid-utils.js)', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*renderMermaidWithRetry[^}]*\}\s*from\s*['"]\.\/mermaid-utils\.js['"]/);
  assert.match(src, /pre\.style\.minHeight\s*=\s*estimatedHeight/, 'the code-fence placeholder must get the estimated height before the async render starts');
  assert.match(src, /await renderMermaidWithRetry\(m, id, source, (?:host|ownHost)\)/, 'must render through the retry helper, not a raw m.render() call');
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

// ─── 宽表格滚动包裹（2026-09-30 批B）────────────────────────────────────────
// marked 层的 table renderer 把 <table> 包进 .table-scroll——`pre`/块级公式
// 早有 overflow-x 容器而表格没有，6+ 列对比表在侧栏宽度下会拖着整个消息区
// 横向滚动。包在 marked 层 = 流式 commit 与最终渲染两条路都覆盖。

test('renderSafe wraps markdown tables in a .table-scroll container', async () => {
  const html = await renderSafe('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<div class="table-scroll"><table/, 'the table must sit inside the scroll wrapper');
});

test('renderStreamingSafe wraps tables too (streaming commits get the same containment)', () => {
  const html = renderStreamingSafe('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<div class="table-scroll"><table/);
});

// ─── 暗色主题与导出统一（2026-09-30 批B，源码 pin）─────────────────────────────

test('renderEcharts inits with the built-in dark theme and a transparent canvas by default', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /echartsModule\.init\(container, isDark \? 'dark' : undefined\)/,
    'dark mode must use echarts\' built-in dark theme — default-theme #333 text is ~2:1 on the dark wrapper');
  assert.match(src, /!\('backgroundColor' in option\)\) option\.backgroundColor = 'transparent'/,
    'the canvas stays transparent (wrapper --bg-2 shows through) unless the model picked its own bg');
  assert.match(src, /_diagramErrorCard\('ECharts', source, e\)/,
    'a failed chart keeps its raw JSON via the shared error card (was: source destroyed, unstyled message)');
});

test('renderMarkmap activates the vendor markmap-dark palette in dark mode', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /wrapper\.classList\.add\('markmap-dark'\)/,
    'the vendor ships a .markmap-dark override set — without the class, node text is #333-on-dark (~1.7:1)');
});

test('one ↓ = one themed-backdrop PNG across every SVG renderer; the SVG export path is gone', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /_mermaidExportSvg/, 'the SVG-download helper must be fully removed');
  assert.doesNotMatch(src, /mermaidExportSvg'/, 'no toolbar may reference the dead i18n key');
  const mermaidTb = src.match(/function _mermaidToolbar\([^)]*\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(mermaidTb, /_exportSvgWrapAsPng\(svgWrap, 'diagram\.png'\)/);
  const pngHelper = src.match(/async function _exportSvgWrapAsPng\([^)]*\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(pngHelper, /_rasterizeSvg\(svgEl, \{ bg: dark \? '#16181d' : '#ffffff' \}\)/,
    'exports bake the CURRENT theme backdrop (same constants as the smiles export)');
  assert.doesNotMatch(src, /text: 'SVG'/, 'smiles\' extra SVG button is gone — six renderers, one export contract');
});

test('render.js sanitizes the parsed ECharts option before chart.setOption(), but keeps the raw source for the toolbar', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/render.js', import.meta.url), 'utf8');
  assert.match(src, /const option = sanitizeEchartsText\(JSON\.parse\(source\)\)/);
  assert.match(src, /_echartsToolbar\(source, chart, container\)/, 'the toolbar must still get the original unsanitized source (for copy/export)');
});

// ─── linkifyTimestamps: [mm:ss] -> clickable seek markers ────────────────────
// These exercise the video-note timestamp linker (TreeWalker over text nodes).
// Must wrap bracketed timestamps, support hour form, strip BiliNote's
// *Content- prefix, and leave non-timestamp text + timestamps inside <a> alone.
// 门控（2026-09-26）：链接化只在带 videoSrc 盖章的 .msg 气泡里发生——胶囊的唯一
// 动作是 seek，落点全靠盖章；无视频上下文的气泡里一律保持纯文本（误报剪枝）。
function tsMsg(html) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.dataset.videoSrc = JSON.stringify({ platform: 'youtube', url: 'https://youtu.be/x', tabId: 7 });
  el.innerHTML = html;
  return el;
}

test('linkifyTimestamps: wraps [mm:ss] into a span.browsa-ts with data-s seconds', () => {
  const el = tsMsg('<p>see [01:23] for details</p>');
  linkifyTimestamps(el);
  const ts = el.querySelector('.browsa-ts');
  assert.ok(ts, 'a timestamp span was created');
  assert.equal(ts.dataset.s, String(1 * 60 + 23));
  assert.equal(ts.textContent, '[01:23]');
});

test('linkifyTimestamps: supports [h:mm:ss] hour form', () => {
  const el = tsMsg('<p>chapter [1:02:03]</p>');
  linkifyTimestamps(el);
  const ts = el.querySelector('.browsa-ts');
  assert.ok(ts);
  assert.equal(ts.dataset.s, String(1 * 3600 + 2 * 60 + 3));
  assert.equal(ts.textContent, '[1:02:03]');
});

test('linkifyTimestamps: wraps native 3-digit total-minute stamps [105:30]', () => {
  const el = tsMsg('<p>quote from a long video [105:30] here</p>');
  linkifyTimestamps(el);
  const ts = el.querySelector('.browsa-ts');
  assert.ok(ts, '3-digit total-minute stamps must be clickable too');
  assert.equal(ts.dataset.s, String(105 * 60 + 30));
});

test('linkifyTimestamps: strips BiliNote *Content- prefix in display but keeps the time', () => {
  const el = tsMsg('<p>Intro *Content-[00:10]</p>');
  linkifyTimestamps(el);
  const ts = el.querySelector('.browsa-ts');
  assert.ok(ts);
  assert.equal(ts.textContent, '[00:10]');
  assert.equal(ts.dataset.s, '10');
  assert.ok(!/Content/.test(el.textContent), 'no leftover *Content- artifact');
});

test('linkifyTimestamps: leaves bare mm:ss (no brackets) and non-timestamps untouched', () => {
  const el = tsMsg('<p>ratio 12:00 and version 1.2:3 and [not-a-time]</p>');
  linkifyTimestamps(el);
  assert.equal(el.querySelectorAll('.browsa-ts').length, 0, 'no false-positive links');
});

test('linkifyTimestamps: skips timestamps already inside an &lt;a&gt;', () => {
  const el = tsMsg('<p><a href="x">[00:05]</a> and [00:10]</p>');
  linkifyTimestamps(el);
  const spans = el.querySelectorAll('.browsa-ts');
  assert.equal(spans.length, 1, 'only the non-link timestamp is wrapped');
  assert.equal(spans[0].dataset.s, '10');
});

test('linkifyTimestamps: wraps multiple timestamps in one text node, preserving surrounding text', () => {
  const el = tsMsg('<p>[00:01] first [00:02] second</p>');
  linkifyTimestamps(el);
  const spans = el.querySelectorAll('.browsa-ts');
  assert.equal(spans.length, 2);
  assert.equal(spans[0].dataset.s, '1');
  assert.equal(spans[1].dataset.s, '2');
  // surrounding words survive
  assert.match(el.textContent, /first/);
  assert.match(el.textContent, /second/);
});

// ─── 序列切片误判防线（2026-09-26 用户报告）──────────────────────────────────
// 模型讨论数组时会写 [0:23] / [26:49] 这类 Python 切片区间，形状与 [mm:ss] 全同。
// 两道防线：代码块内一律不链（fence 里是逐字数据，不是跳转入口）；正文里贴着
// 标识符的 `[` 不链（name[0:23] 是切片，真实时间戳几乎总有空格/行首隔离）。

test('linkifyTimestamps: never touches timestamps inside a code fence (pre/code) — slice rows stay plain', () => {
  const el = tsMsg('<pre><code>[0:23]  msa     0 0 0\n[26:49] profile 0 0 .33\n</code></pre><p>at [01:10] seek here</p>');
  linkifyTimestamps(el);
  assert.equal(el.querySelector('pre').querySelectorAll('.browsa-ts').length, 0,
    'code-fence content is verbatim data (slice intervals), not seek affordances');
  const ts = el.querySelector('p .browsa-ts');
  assert.ok(ts, 'prose timestamps outside the fence still linkify');
  assert.equal(ts.dataset.s, '70');
  assert.match(el.querySelector('pre').textContent, /\[0:23\]/, 'fence text preserved verbatim');
});

test('linkifyTimestamps: never touches inline code like msa_feat[0:23]', () => {
  const el = tsMsg('<p>take <code>msa_feat[0:23]</code> then <code>arr[0:2][0:23]</code></p>');
  linkifyTimestamps(el);
  assert.equal(el.querySelectorAll('.browsa-ts').length, 0, 'inline-code slices must stay plain');
});

test('linkifyTimestamps: prose slice glued to a name (name[0:23]) is not a timestamp', () => {
  const el = tsMsg('<p>取 msa_feat[0:23] 的行，再看 x.arr[26:49]。</p>');
  linkifyTimestamps(el);
  assert.equal(el.querySelectorAll('.browsa-ts').length, 0,
    'a [ preceded by an identifier char is slice indexing, not a stamp');
});

test('linkifyTimestamps: standalone [mm:ss] after whitespace/line start still links (guard must not over-block)', () => {
  const el = tsMsg('<p>见 [0:23] 处的跳变；下一行：</p><p><strong>Intro</strong>[0:45]</p>');
  linkifyTimestamps(el);
  const spans = el.querySelectorAll('.browsa-ts');
  assert.equal(spans.length, 2, 'space-preceded and node-initial stamps still linkify');
  assert.equal(spans[0].dataset.s, '23');
  assert.equal(spans[1].dataset.s, '45');
});

test('linkifyTimestamps: videoSrc gate — no stamped .msg means nothing links, even real stamps', () => {
  // 误报剪枝：无视频上下文时胶囊是样式说谎（点击 seekVideo(null) 弹「视频源已失效」），
  // 所以独立切片 [26:49] 和真时间戳 [01:10] 一律保持纯文本。
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = '<p>行 [26:49] 是 profile，视频见 [01:10]。</p>';
  linkifyTimestamps(el);
  assert.equal(el.querySelectorAll('.browsa-ts').length, 0, 'unstamped bubble never linkifies');
  // 不是 .msg 壳（追问卡的气泡）同理：
  const card = document.createElement('div');
  card.className = 'detail-thread-msg';
  card.innerHTML = '<p>quoted [01:10] from selection</p>';
  linkifyTimestamps(card);
  assert.equal(card.querySelectorAll('.browsa-ts').length, 0, 'non-.msg roots never linkify');
});

test('linkifyTimestamps: seconds > 59 can only be a slice → never links (zero-false-positive prune)', () => {
  const el = tsMsg('<p>行 [0:80] 到 [26:99]；但 [00:59] 是时间戳。</p>');
  linkifyTimestamps(el);
  const spans = el.querySelectorAll('.browsa-ts');
  assert.equal(spans.length, 1, 'only [00:59] linkifies — real stamps never carry seconds > 59');
  assert.equal(spans[0].dataset.s, '59');
});

test('linkifyTimestamps: is idempotent — re-running does not nest spans', () => {
  const el = tsMsg('<p>see [01:23] here</p>');
  linkifyTimestamps(el);
  linkifyTimestamps(el);
  assert.equal(el.querySelectorAll('.browsa-ts').length, 1);
  assert.equal(el.querySelectorAll('.browsa-ts .browsa-ts').length, 0, 'existing pills must be skipped, not double-wrapped');
});

test('figuresBeforeEntry: nearest preceding user entry with image parts wins', () => {
  const list = [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'old' } }] },
    { role: 'assistant', content: 'x' },
    { role: 'user', content: 'plain text turn' },
    { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'image_url', image_url: { url: 'new1' } }, { type: 'image_url', image_url: { url: 'new2' } }] },
    { role: 'assistant', content: 'y' },
  ];
  assert.deepEqual(figuresBeforeEntry(list, 4), ['new1', 'new2']);
  assert.deepEqual(figuresBeforeEntry(list, 2), ['old'], 'idx=2 的最近带图条目是 index 0');
  assert.deepEqual(figuresBeforeEntry(list, 0), []);
  assert.deepEqual(figuresBeforeEntry(list, 99), ['new1', 'new2'], '越界 idx 从末尾往前找');
});

test('decorateFigureRefs: [图N] text tokens become inline thumbnails; out-of-range stays text', () => {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.innerHTML = '<p>看 [图1] 这张图，对比 [图2]；[图9] 不存在。</p>';
  document.body.appendChild(el);
  decorateFigureRefs(el, ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']);
  const imgs = el.querySelectorAll('img.inline-fig');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].src, 'data:image/jpeg;base64,AAA');
  assert.equal(imgs[1].alt, '图2');
  assert.match(el.textContent, /\[图9\] 不存在/, '越界引用按纯文本保留');
  // 空 figures → 原样不动
  const el2 = document.createElement('div');
  el2.textContent = '引用 [图1]';
  decorateFigureRefs(el2, []);
  assert.equal(el2.querySelectorAll('img').length, 0);
  assert.match(el2.textContent, /\[图1\]/);
});

// ─── renderUserContent: 用户气泡代码受限渲染（2026-09-26）─────────────────────
// 只认 ``` 围栏（未闭合 → 代码到末尾）与行内 `code`，其余文字逐字原样——刻意
// 不做全量 Markdown（用户输入的 # 注释、URL 下划线等常无 Markdown 意图）。

function userSpan() {
  return document.createElement('span');
}

test('renderUserContent: fenced block with lang → pre.user-code > code.language-*, verbatim text', () => {
  const el = userSpan();
  renderUserContent(el, '帮我看看：\n```python\ndef f(x):\n    return x[0:23]\n```\n谢谢');
  const pre = el.querySelector('pre.user-code');
  assert.ok(pre, 'a user-code pre is created');
  const code = pre.querySelector('code.language-python');
  assert.ok(code, 'language class carries the fence tag');
  assert.equal(code.textContent, 'def f(x):\n    return x[0:23]', 'code text verbatim, no trailing newline');
  const first = el.firstChild;
  assert.equal(first.nodeType, Node.TEXT_NODE, 'non-code text stays a verbatim text node');
  assert.match(first.textContent, /^帮我看看：$/);
});

test('renderUserContent: unclosed fence → code to the end (streaming-partial semantics)', () => {
  const el = userSpan();
  renderUserContent(el, '看这个：\n```\nx = 1\ny = 2');
  const pre = el.querySelector('pre.user-code');
  assert.ok(pre, 'unclosed fence still renders as a code block');
  assert.equal(pre.querySelector('code').textContent, 'x = 1\ny = 2');
  assert.equal(pre.querySelector('code').className, '', 'no lang tag → no language class');
});

test('renderUserContent: inline code renders as code; lone backtick stays literal', () => {
  const el = userSpan();
  renderUserContent(el, 'take `x[0]` and a " ` " char');
  assert.equal(el.querySelectorAll('code').length, 1);
  assert.equal(el.querySelector('code').textContent, 'x[0]');
  assert.match(el.textContent, /a " ` " char/, 'unpaired backtick survives verbatim');
});

test('renderUserContent: markdown-LOOKING non-code text is never interpreted', () => {
  const el = userSpan();
  const raw = '# 注释不是标题 <script>alert(1)</script> a_b_c *em*';
  renderUserContent(el, raw);
  assert.equal(el.children.length, 0, 'no elements at all — everything is text nodes');
  assert.equal(el.textContent, raw, 'byte-for-byte verbatim');
});

test('renderUserContent: multiple fences keep document order with text segments between', () => {
  const el = userSpan();
  renderUserContent(el, 'A\n```js\nlet a=1;\n```\nB\n```cpp\nint b;\n```\nC');
  assert.deepEqual([...el.children].map((n) => n.nodeName), ['PRE', 'PRE']);
  assert.match(el.childNodes[0].textContent, /^A$/);
  assert.match(el.childNodes[2].textContent, /^B$/);
  assert.match(el.childNodes[4].textContent, /^C$/);
  assert.match(el.children[0].querySelector('code').className, /language-js/);
  assert.match(el.children[1].querySelector('code').className, /language-cpp/);
});

test('addCodeCopyButtons autoDetect: bare no-lang fence highlights via highlightAuto; plain prose stays plain', () => {
  // 阈值 >5 是保守线（预存）：太短/特征太弱的片段宁可保持纯等宽也不误报——
  // 探针实测：两行 python relevance=5（不亮），中文散文 relevance=0（不亮）。
  const el = document.createElement('div');
  el.innerHTML = '<pre class="user-code"><code>names = ["alice", "bob"]\nfor n in names:\n    print(f"hello {n}")\n    if len(n) > 3:\n        print("long")</code></pre>'
    + '<pre class="user-code"><code>这只是一段没有代码特征的中文说明文字而已</code></pre>';
  addCodeCopyButtons(el, { autoDetect: true });
  const pres = el.querySelectorAll('pre');
  assert.equal(pres[0].querySelector('code').dataset.highlighted, '1', 'python detected and highlighted');
  assert.equal(pres[0].querySelectorAll('.hljs-keyword').length > 0, true, 'token spans present');
  assert.equal(pres[1].querySelector('code').dataset.highlighted, undefined, 'low-relevance prose not highlighted');
  for (const pre of pres) {
    assert.ok(pre.querySelector('.code-copy-btn'), 'copy button present on both');
    assert.equal(pre.style.position, 'relative');
  }
  // 默认（助手路径）保持原行为：no-lang 围栏不做自动检测
  const el2 = document.createElement('div');
  el2.innerHTML = '<pre><code>names = ["alice", "bob"]\nfor n in names:\n    print(f"hello {n}")</code></pre>';
  addCodeCopyButtons(el2);
  assert.equal(el2.querySelector('code').dataset.highlighted, undefined, 'default: no auto-detect');
});

test('sidepanel.js appendUser routes backtick-bearing input through renderUserContent (source pin)', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  assert.match(src, /if \(text\.includes\('`'\)\) \{\s*\n\s*\/\/ 用户代码受限渲染[\s\S]*?renderUserContent\(span, text\)/,
    'appendUser must route backtick-bearing text through renderUserContent');
  assert.match(src, /span\.querySelector\('pre'\)\) addCodeCopyButtons\(el, \{ autoDetect: true \}\)/,
    'user bubbles must enable autoDetect for bare fences');
});

// ─── renderMathInPlainText：追问卡引用块的公式补渲染（2026-09-26）─────────────
// 引用文本（selectionTextWithMath 产物）里的 $…$ / $$…$$ → KaTeX，其余文字
// 保持逐字文本节点。刻意不走 renderSafe（全量 Markdown 会把引用里的普通文本
// ——标题井号、下划线、星号——再解释一遍）。

test('renderMathInPlainText: paired $…$ / $$…$$ render to KaTeX; prose verbatim', async () => {
  const el = document.createElement('div');
  el.textContent = '前文 $a^2+b^2$ 中 $$c_1$$ 后文';
  await renderMathInPlainText(el);
  const kats = el.querySelectorAll('.katex');
  assert.equal(kats.length, 2, 'both formulas rendered');
  assert.match(el.querySelector('.qtex-inline .katex annotation')?.textContent || '', /a\^2\+b\^2/,
    'inline formula keeps its LaTeX in the annotation (copy/再提取 still work)');
  assert.ok(el.querySelector('.math-block .katex'), 'display formula lands in a .math-block holder');
  assert.match(el.textContent, /前文 /);
  assert.match(el.textContent, / 后文/);
  assert.equal(el.textContent.includes('$'), false, 'delimiters consumed by the render');
});

test('renderMathInPlainText: lone $ and $-free text stay byte-identical (no false math)', async () => {
  const el = document.createElement('div');
  el.textContent = '价格 $5 即可，# 不是标题';
  const before = el.textContent;
  await renderMathInPlainText(el);
  assert.equal(el.childElementCount, 0, 'no elements created');
  assert.equal(el.textContent, before);
});

test('renderMathInPlainText: null/empty el is a no-op', async () => {
  await renderMathInPlainText(null);
  const el = document.createElement('div');
  await renderMathInPlainText(el);
  assert.equal(el.childElementCount, 0);
});

test('detail-thread.js routes quote through selectionTextWithMath + renderMathInPlainText (source pin)', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/sidepanel/detail-thread.js', import.meta.url), 'utf8');
  assert.match(src, /selectionTextWithMath\(sel\) \?\? sel\.toString\(\)/,
    'quote text must be formula-aware (MathML fragments are unusable)');
  assert.match(src, /renderMathInPlainText\(quoteEl\)/,
    'the quote block must render $…$/$$…$$ as KaTeX');
});

// ── 图形文本贴合 + timeline CJK 断行（2026-10-07） ──────────────────────────
// 根因：两条图管线都在布局期用内建字体表估宽，CJK 全宽字符被系统性低估
// （viz-js ~0.86em/字 vs 实际 1.0em/字）；mermaid timeline 盒宽硬编码 150px
// 且换行只认 \s+|<br>，CJK 长句完全无法换行。修法：dot/mermaid 落地后按
// 浏览器真实度量撑形状（fitSvgShapesToText）；timeline 渲染前给不可断串插
// <br>（timelineBreakLongRuns）。

const {
  timelineBreakLongRuns, fitSvgShapesToText
} = await import('../lib/sidepanel/render.js');

test('timelineBreakLongRuns: title 不动、短段不动、超限 CJK 串按 ~10 全宽字插 <br>', () => {
  const src = [
    'timeline',
    '    title 电到电器：应用出现的时间差',
    '    1892 : 电灯泡照亮曼哈顿约一平房大小的区域',
    '    1930 : 电视机',
  ].join('\n');
  const out = timelineBreakLongRuns(src);
  const lines = out.split('\n');
  assert.equal(lines[1], '    title 电到电器：应用出现的时间差', 'title 不动');
  assert.equal(lines[3], '    1930 : 电视机', '短 event 不动');
  assert.ok(lines[2].includes('电灯泡照亮曼哈顿约一<br>'), JSON.stringify(lines[2]));
  assert.ok(!lines[2].includes('曼哈顿约一平房大小的区域'), '长串被切开');
});

test('timelineBreakLongRuns: 多事件行逐段处理、既有 <br> 是断点、幂等', () => {
  const src = 'timeline\n    1910 : 电网覆盖美国主要城市 : 建成全世界第一条由电驱动的铁路\n    1925 : 第三个离不开的家用电器走进厨房，彻底改变了家务的结构与节奏';
  const once = timelineBreakLongRuns(src);
  assert.ok(once.includes('电网覆盖美国主要城市 : 建成全世界第一条由电<br>'), '第二段独立断行，第一段短串不动\n' + JSON.stringify(once));
  assert.ok(!once.split('\n')[1].includes(': <br>'), '不断出悬空断点');
  assert.equal(timelineBreakLongRuns(once), once, '幂等');
});

test('timelineBreakLongRuns: 非 timeline 原样返回；前导注释行后仍可识别', () => {
  const flow = 'flowchart TD\n    A[电网覆盖美国主要城市] --> B';
  assert.equal(timelineBreakLongRuns(flow), flow);
  assert.equal(timelineBreakLongRuns(''), '');
  const commented = '%% 注释\ntimeline\n    1892 : 电灯泡照亮曼哈顿约一平房大小的区域';
  assert.ok(timelineBreakLongRuns(commented).includes('<br>'), '注释行不是 anchor 障碍');
  void 0;
});

// ── fitSvgShapesToText：jsdom + getBBox/getCTM 桩 ──────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
function fitMakeSvg(markup) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.innerHTML = markup;
  document.body.appendChild(svg);
  svg.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  return svg;
}
const fitStubBox = (el, x, y, w, h) => { el.getBBox = () => ({ x, y, width: w, height: h }); };
const fitStubCtm = (el, e = 0, f = 0, a = 1) => { el.getCTM = () => ({ a, b: 0, c: 0, d: a, e, f }); };

test('fitSvgShapesToText: mermaid 式嵌套 translate 标签——rect 撑到包住文本，只动形状', () => {
  const svg = fitMakeSvg('<g class="node"><rect x="100" y="50" width="80" height="40"/><g transform="translate(140,70)"><text>标签</text></g></g>');
  const rect = svg.querySelector('rect');
  const text = svg.querySelector('text');
  fitStubBox(text, -60, -10, 120, 20); fitStubCtm(text, 140, 70); // 根坐标 [80..200]×[60..80]
  fitStubBox(rect, 100, 50, 80, 40); fitStubCtm(rect, 0, 0);      // 根坐标 [100..180]×[50..90]
  fitSvgShapesToText(svg);
  // 需要 120+8=128 宽（pad 4×2）：x=100-24=76, width=128；高 40 已够不动
  assert.equal(rect.getAttribute('x'), '76');
  assert.equal(rect.getAttribute('width'), '128');
  assert.equal(rect.getAttribute('y'), '50');
  assert.equal(rect.getAttribute('height'), '40');
  svg.remove();
});

test('fitSvgShapesToText: 已容纳则不动；graphviz 无变换 polygon 绕中心缩放；ellipse 涨 rx/ry', () => {
  const svg = fitMakeSvg(
    '<g class="node a"><polygon points="100,50 180,50 180,90 100,90"/><text x="140" y="74">fits</text></g>'
    + '<g class="node b"><polygon points="300,50 380,50 380,90 300,90"/><text x="340" y="74">超宽文本节点标签文字</text></g>'
    + '<g class="node c"><ellipse cx="520" cy="70" rx="40" ry="20"/><text x="520" y="74">超出椭圆的中文标签文本</text></g>');
  const [p1, p2] = svg.querySelectorAll('polygon');
  const [t1, t2] = svg.querySelectorAll('text');
  const ell = svg.querySelector('ellipse');
  const t3 = svg.querySelectorAll('text')[2];
  fitStubBox(t1, 125, 64, 30, 14); fitStubCtm(t1, 0, 0);
  fitStubBox(p1, 100, 50, 80, 40); fitStubCtm(p1, 0, 0);
  fitStubBox(t2, 270, 64, 140, 14); fitStubCtm(t2, 0, 0);
  fitStubBox(p2, 300, 50, 80, 40); fitStubCtm(p2, 0, 0);
  fitStubBox(ell, 480, 50, 80, 40); fitStubCtm(ell, 0, 0);
  fitStubBox(t3, 480, 64, 120, 14); fitStubCtm(t3, 0, 0);
  fitSvgShapesToText(svg);
  assert.equal(p1.getAttribute('points'), '100,50 180,50 180,90 100,90', '已容纳：polygon 不动');
  // p2: 需要 140+8=148，dw=68，fx=1.85，中心 (340,70)：(300,50)→(266,50)... 只验 x 端点与宽
  const pts = p2.getAttribute('points').split(' ').map((s) => s.split(',').map(Number));
  const xs = pts.map((p) => p[0]);
  const w2 = Math.max(...xs) - Math.min(...xs);
  assert.ok(Math.abs(w2 - 148) < 0.01, 'polygon 宽 = 文本+pad，实得 ' + w2);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 340) < 0.01, '绕原中心缩放');
  assert.ok(Math.abs(pts[0][1] - 50) < 0.01, '高度不动');
  const rx = parseFloat(ell.getAttribute('rx'));
  assert.ok(Math.abs(rx - (40 + 24)) < 0.01, 'ellipse rx 涨到包住文本（dw=(120+8)-80=48 → rx 40+24=64），实得 ' + rx);
  svg.remove();
});

test('fitSvgShapesToText: 集群（嵌套含形状）跳过、双形状边跳过、增幅 2× 封顶、旋转矩阵放弃', () => {
  const svg = fitMakeSvg(
    '<g class="cluster"><rect id="cr" x="0" y="0" width="400" height="200"/><g class="node"><rect id="nr" x="10" y="10" width="60" height="30"/><text>集群内节点文本超出很多很多</text></g></g>'
    + '<g class="edge"><path d="M0 0 L10 10"/><polygon points="0,0 5,5"/><text>edge label</text></g>'
    + '<g class="node cap"><rect id="cap" x="0" y="0" width="50" height="20"/><text>文本远远远远远远远远远远远远远远远远远远远远超出框</text></g>'
    + '<g class="node rot"><rect id="rot" x="0" y="0" width="50" height="20"/><text>旋转文本</text></g>');
  const cr = svg.querySelector('#cr'), nr = svg.querySelector('#nr');
  const clusterText = svg.querySelectorAll('text')[0];
  const edgePoly = svg.querySelector('.edge polygon');
  const cap = svg.querySelector('#cap'), capText = svg.querySelectorAll('text')[2];
  const rot = svg.querySelector('#rot'), rotText = svg.querySelectorAll('text')[3];
  fitStubBox(cr, 0, 0, 400, 200); fitStubCtm(cr, 0, 0);
  fitStubBox(nr, 10, 10, 60, 30); fitStubCtm(nr, 0, 0);
  fitStubBox(clusterText, 0, 0, 380, 20); fitStubCtm(clusterText, 0, 0);
  fitStubBox(cap, 0, 0, 50, 20); fitStubCtm(cap, 0, 0);
  fitStubBox(capText, -80, 2, 200, 16); fitStubCtm(capText, 0, 0);
  fitStubBox(rot, 0, 0, 50, 20); fitStubCtm(rot, 0, 0);
  fitStubBox(rotText, -10, 2, 80, 16);
  rotText.getCTM = () => ({ a: 0.8, b: 0.6, c: -0.6, d: 0.8, e: 0, f: 0 }); // 旋转
  fitSvgShapesToText(svg);
  assert.equal(cr.getAttribute('width'), '400', '集群 rect 不动');
  // 节点文本桩 380 宽：需要 380+8-60=328 > 封顶 2×60=120 → 涨满封顶
  assert.equal(nr.getAttribute('width'), '180', '集群内叶子节点正常贴合且受封顶');
  assert.ok(edgePoly.getAttribute('points').startsWith('0,0'), '边箭头不动');
  assert.equal(cap.getAttribute('width'), '150', '增幅封顶 2× 原宽（50→150）');
  assert.equal(rot.getAttribute('width'), '50', '旋转矩阵放弃');
  svg.remove();
});

test('fitSvgShapesToText: 无 getBBox 环境（纯 jsdom）静默跳过，不抛错', () => {
  const svg = fitMakeSvg('<g><rect x="0" y="0" width="10" height="10"/><text>hi</text></g>');
  assert.doesNotThrow(() => fitSvgShapesToText(svg));
  assert.equal(svg.querySelector('rect').getAttribute('width'), '10');
  svg.remove();
});
