// ```dot fence（Graphviz DOT，viz-js/WASM）——真实执行测试。viz 的 WASM 在
// Node 里可直接实例化，所以这里跑真渲染（断言真 SVG），不是结构桩测。
// 前置：DOMParser 必须先于 import render.js 全局化——viz.renderSVGElement
// 用它建 SVG 节点（真浏览器里天然存在）。
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
dom.window.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { renderDot, wantsChartVendors, FENCED_RENDERERS } = await import('../lib/sidepanel/render.js');

function makeDotEl(source) {
  const el = document.createElement('div');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-dot';
  code.textContent = source;
  pre.appendChild(code);
  el.appendChild(pre);
  document.body.appendChild(el);
  return el;
}

test('FENCED_RENDERERS carries dot, not nn', () => {
  assert.ok(FENCED_RENDERERS.includes('dot'));
  assert.ok(!FENCED_RENDERERS.includes('nn'));
  assert.ok(wantsChartVendors('look:\n```dot\ndigraph { a -> b }\n```'), 'the fence sniff must fire for ```dot');
  assert.ok(!wantsChartVendors('plain text, no fences'));
});

test('renderDot renders a real SVG via the vendored Graphviz WASM and swaps out the code block', async () => {
  const el = makeDotEl('digraph { rankdir=LR; a [shape=box]; a -> b [label="x"]; }');
  await renderDot(el);
  const svg = el.querySelector('.dot-diagram svg');
  assert.ok(svg, 'a real <svg> must be rendered');
  assert.equal(svg.tagName, 'svg');
  assert.ok(svg.querySelector('path'), 'the graph must contain drawn geometry');
  assert.ok(svg.getAttribute('viewBox'), 'viewBox present (mermaid zoom helpers depend on it)');
  assert.ok(el.querySelector('.dot-diagram .mermaid-toolbar'), 'the reusable mermaid toolbar must be attached');
  assert.equal(el.querySelector('pre'), null, 'the raw code block must be swapped out');
});

test('renderDot strips javascript: link targets Graphviz emits from href attributes', async () => {
  const el = makeDotEl('digraph { c [href="javascript:alert(1)"]; c -> d; }');
  await renderDot(el);
  const svg = el.querySelector('.dot-diagram svg');
  assert.ok(svg, 'the diagram must still render');
  // <a> 壳保留（图形节点在其中），但点击目标必须被剥掉——无 href 的 a 是惰性的
  for (const a of svg.querySelectorAll('a')) {
    assert.equal(a.getAttribute('href'), null);
    assert.equal(a.getAttribute('xlink:href'), null);
  }
  assert.ok(!svg.outerHTML.includes('javascript:'), 'no javascript: URL may survive');
});

test('invalid DOT keeps the code block and inserts an error note before it', async () => {
  const el = makeDotEl('digraph { a -> }');
  await renderDot(el);
  assert.ok(el.querySelector('pre code.language-dot'), 'the raw code block must stay for copy/re-ask');
  const err = el.querySelector('.dot-error');
  assert.ok(err, 'an error note must be inserted');
  assert.match(err.textContent, /DOT/, 'the note must name the fence type');
});

test('renderDot with no dot blocks is a no-op (does not load the vendor)', async () => {
  const el = document.createElement('div');
  el.innerHTML = '<pre><code class="language-js">const x = 1;</code></pre>';
  document.body.appendChild(el);
  await renderDot(el);
  assert.equal(el.querySelector('.dot-diagram'), null);
  assert.equal(el.querySelector('.dot-error'), null);
  el.remove();
});

// ─── DOT label math (2026-10-21 user report: formulas in digraph labels) ────
// Graphviz has no math mode; `n×d_k` used to print the underscore literally.
// Labels now turn `_x`/`^{…}` into SVG tspans, and paired $…$ / common LaTeX
// operators are mapped to their plain-text glyphs.
const { dotMathParts, applyDotMathText } = await import('../lib/sidepanel/render.js');

test('dotMathParts: sub/superscripts, braces, LaTeX glyphs and $…$ wrappers', () => {
  assert.deepEqual(dotMathParts('n×d_k'), ['n×d', { script: 'sub', text: 'k' }]);
  assert.deepEqual(dotMathParts('QK^{T}'), ['QK', { script: 'super', text: 'T' }]);
  assert.deepEqual(dotMathParts('$d_{ij}$'), ['d', { script: 'sub', text: 'ij' }]);
  assert.deepEqual(dotMathParts('\\sqrt{d_k}'), ['√d', { script: 'sub', text: 'k' }]);
  assert.deepEqual(dotMathParts('$\\frac{QK^T}{\\sqrt{d_k}}$'),
    ['(QK', { script: 'super', text: 'T' }, ')/(√d', { script: 'sub', text: 'k' }, ')']);
  assert.deepEqual(dotMathParts('\\alpha \\leq \\infty'), ['α ≤ ∞']);
  assert.equal(dotMathParts('plain tensor shape'), null, 'labels without scripts stay untouched');
});

test('renderDot renders sub/superscript labels as tspans instead of literal _ and ^', async () => {
  const el = makeDotEl('digraph { rankdir=LR; Q [label="Q\\nn×d_k"]; D [label="QK^{T}"]; Q -> D [label="softmax_行"]; }');
  await renderDot(el);
  const svg = el.querySelector('.dot-diagram svg');
  assert.ok(svg, 'the diagram must render');
  const labels = [...svg.querySelectorAll('g.node text, g.edge text')].map((t) => t.textContent);
  assert.ok(labels.includes('n×dk'), 'the underscore must be consumed by a tspan: ' + JSON.stringify(labels));
  assert.ok(labels.includes('QKT'), 'the caret/braces must be consumed: ' + JSON.stringify(labels));
  const subs = [...svg.querySelectorAll('g.node text tspan[baseline-shift="sub"], g.edge text tspan[baseline-shift="sub"]')];
  const sups = [...svg.querySelectorAll('g.node text tspan[baseline-shift="super"], g.edge text tspan[baseline-shift="super"]')];
  assert.equal(subs.length, 2, 'n×d_k and softmax_行 each contribute a subscript');
  assert.equal(sups.length, 1, 'QK^{T} contributes a superscript');
  assert.ok(!svg.outerHTML.includes('d_k'), 'no literal _k may survive in the SVG');
  assert.ok(!svg.outerHTML.includes('QK^{'), 'no literal braces may survive');
});

test('applyDotMathText leaves script-free labels (and their text nodes) alone', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'node');
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.textContent = 'Mask 可选，置 -∞';
  g.appendChild(t);
  svg.appendChild(g);
  applyDotMathText(svg);
  assert.equal(t.textContent, 'Mask 可选，置 -∞');
  assert.equal(t.querySelector('tspan'), null);
});

// ─── rethemeDotSvg (2026-09-30 field report: black-filled nodes + dark mode) ─
// viz-js emits default-black ink over a white canvas polygon; models love
// `style=filled, fillcolor=black` without fontcolor (black-on-black). The
// retheme: white canvas dropped both themes, dark-mode ink remap (default
// black only — model colors kept), and a contrast rescue flipping labels on
// dark-filled nodes to light ink in BOTH themes.

const { rethemeDotSvg } = await import('../lib/sidepanel/render.js');

function vizFixture() {
  const holder = document.createElement('div');
  // Mirrors viz-js output shape: g.graph > polygon(canvas); g.node > path(shape) + text; g.edge > path + polygon(arrowhead) + text
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">
    <g id="graph0" class="graph">
      <polygon fill="white" stroke="none"/>
      <g id="node1" class="node"><title>A</title><path fill="black" stroke="black"/><text stroke="none" fill="black">A</text></g>
      <g id="node2" class="node"><title>B</title><path fill="lightgrey" stroke="black"/><text stroke="none">B</text></g>
      <g id="node3" class="node"><title>C</title><path fill="#3B82F6" stroke="black"/><text stroke="none">C</text></g>
      <g id="edge1" class="edge"><title>A->B</title><path fill="none" stroke="black"/><polygon fill="black" stroke="black"/><text fill="black">label</text></g>
    </g>
  </svg>`;
  return holder.firstElementChild;
}

test('rethemeDotSvg light: white canvas dropped, black ink kept, dark-fill label flipped to light', () => {
  const svg = vizFixture();
  rethemeDotSvg(svg, false);
  assert.equal(svg.querySelector('g.graph > polygon').getAttribute('fill'), 'none', 'canvas dropped in light mode');
  assert.equal(svg.querySelector('#node2 text').getAttribute('fill'), null, 'normal-fill label keeps default black ink');
  assert.equal(svg.querySelector('#node1 text').getAttribute('fill'), '#F8F9FA', 'black-filled node label flipped light (contrast rescue)');
  assert.equal(svg.querySelector('#node3 text').getAttribute('fill'), null, 'mid-luminance model color untouched');
  assert.equal(svg.querySelector('#edge1 text').getAttribute('fill'), 'black', 'light-mode edge label untouched');
});

test('rethemeDotSvg dark: default black ink/strokes remapped, model colors kept, arrowhead remapped', () => {
  const svg = vizFixture();
  rethemeDotSvg(svg, true);
  assert.equal(svg.querySelector('g.graph > polygon').getAttribute('fill'), 'none', 'canvas dropped in dark mode');
  assert.equal(svg.querySelector('#node2 text').getAttribute('fill'), '#E1E1E6', 'default-black label remapped to light ink');
  assert.equal(svg.querySelector('#node3 text').getAttribute('fill'), '#E1E1E6', 'no fill attr = default black → remapped');
  assert.equal(svg.querySelector('#node2 path').getAttribute('stroke'), '#9A9AA5', 'black shape stroke remapped');
  assert.equal(svg.querySelector('#node3 path').getAttribute('stroke'), '#9A9AA5', 'stroke=black is DEFAULT ink → remapped (the fill #3B82F6 is what the model chose, and fills are kept)');
  assert.equal(svg.querySelector('#edge1 polygon').getAttribute('fill'), '#9A9AA5', 'black arrowhead remapped');
  assert.equal(svg.querySelector('#edge1 path').getAttribute('fill'), 'none', 'edge path fill=none untouched');
  assert.equal(svg.querySelector('#node1 text').getAttribute('fill'), '#E1E1E6', 'dark-filled node label flipped in dark mode too');
});

test('rethemeDotSvg: the 3-hex and named-color luminance paths do not crash', () => {
  const svg = vizFixture();
  svg.querySelector('#node2 path').setAttribute('fill', '#222');
  svg.querySelector('#node3 path').setAttribute('fill', 'darkslateblue');
  assert.doesNotThrow(() => rethemeDotSvg(svg, false));
});

// ─── rethemeDotSvg font normalization (2026-10-14 用户报告：图形文字跟正文一致) ─
// graphviz 把自家默认字体（Times 衬线）写死在每个 <text> 的 font-family 上；
// 只改写这个默认值到面板字体栈，模型自选 fontname 保留。字号不动——布局按它量的。
test('rethemeDotSvg rewrites the graphviz default Times font to the panel stack, keeps model fontnames', () => {
  const svg = vizFixture();
  const texts = svg.querySelectorAll('text');
  texts[0].setAttribute('font-family', 'Times,serif');      // graphviz 默认
  texts[1].setAttribute('font-family', 'Times New Roman,serif'); // 默认的别名形状
  texts[2].setAttribute('font-family', 'Arial');            // 模型自选 → 保留
  texts[3].setAttribute('font-family', '"Segoe UI"');       // 带引号自选 → 保留
  rethemeDotSvg(svg, false, 'PanelStack');
  const ffs = [...svg.querySelectorAll('text')].map((t) => t.getAttribute('font-family'));
  assert.deepEqual(ffs, ['PanelStack', 'PanelStack', 'Arial', '"Segoe UI"']);
});

test('rethemeDotSvg font rewrite falls back to the sidepanel.css body stack when no family passed', () => {
  const svg = vizFixture();
  svg.querySelector('#node1 text').setAttribute('font-family', 'Times,serif');
  rethemeDotSvg(svg, false); // jsdom computed family 为空 → 兜底字面量
  assert.match(svg.querySelector('#node1 text').getAttribute('font-family'), /sans-serif/);
});

test('rethemeDotSvg leaves text without a font-family attribute untouched', () => {
  const svg = vizFixture(); // fixture 的 text 本就无 font-family
  assert.doesNotThrow(() => rethemeDotSvg(svg, true));
  for (const t of svg.querySelectorAll('text')) {
    assert.equal(t.getAttribute('font-family'), null, 'no attribute in → no attribute out');
  }
});

// --- repair: bare-string label shorthand (2026-10-25 PMC flowchart) ---------
// Models keep emitting ID["label"] (and attrs inside edge statements, which
// Graphviz only allows at the END of an edge). The capability hint already
// forbids the shorthand, but compliance is probabilistic — renderDot gets a
// deterministic repair + one retry after a parse failure.

const { repairDotSource } = await import('../lib/sidepanel/render.js');

test('repairDotSource rewrites bare-string labels inside edge statements into declarations', () => {
  const src = 'digraph G {\n  A["x<br/>y"] -> B["z"]\n}';
  const fixed = repairDotSource(src);
  // attrs split out of the edge statement (Graphviz rejects attrs on the
  // edge SOURCE and mid-chain), label= added, <br/> becomes \n
  assert.ok(fixed.includes('A[label="x\\ny"];'), 'edge SOURCE attrs split out as a declaration');
  assert.ok(fixed.includes('A -> B[label="z"]'), 'edge TARGET keeps attrs in place with label= added');
  assert.ok(!fixed.includes('A["'), 'no bare-string shorthand remains');
  assert.ok(!fixed.includes('<br'), 'no literal <br/> remains');
});

test('repairDotSource extracts mid-chain attrs too', () => {
  const fixed = repairDotSource('digraph { A -> B[label="y"] -> C; }');
  assert.ok(fixed.includes('A -> B -> C'), 'chain is attr-free after repair');
  assert.ok(fixed.includes('B[label="y"];'), 'B attrs split out');
});

test('repairDotSource adds label= to plain node-statement shorthand', () => {
  const fixed = repairDotSource('digraph { A["hello"]; }');
  assert.equal(fixed, 'digraph { A[label="hello"]; }');
});

test('repairDotSource leaves valid DOT untouched', () => {
  for (const ok of [
    'digraph { a [shape=box]; a -> b [label="x"]; }',
    'digraph { A[label="x"]; A -> B[label="y"]; }',
    'digraph { node [shape=box]; a -> b }',
    'digraph { A[label=<b>html</b>]; }',
  ]) {
    assert.equal(repairDotSource(ok), ok, 'must not touch: ' + ok);
  }
});

test('repairDotSource is quote-aware (] and -> inside labels)', () => {
  const fixed = repairDotSource('digraph { A["a]b"] -> B["c->d"]; }');
  assert.ok(fixed.includes('A[label="a]b"];'), '] inside a quoted label must not end the attr list');
  assert.ok(fixed.includes('B[label="c->d"];'), '-> inside a quoted label must not read as an edge op');
  assert.ok(fixed.includes('A -> B['), 'the real edge survives with its legal trailing attrs');
});

test('renderDot repairs and renders the reported PMC-style DOT (real WASM render)', async () => {
  // exact shape from the user report: bare-string labels on both ends of
  // every edge, <br/> line breaks, Unicode superscripts, CJK text
  const el = makeDotEl(`digraph G {
  rankdir=LR;
  node [shape=box, style="filled", fillcolor="#eef3fb", fontcolor="#111", fontsize=11];
  A["ePCR 建库<br/>10⁸~10⁹ 变体"] -> B["酵母展示<br/>一细胞一克隆"]
  B -> C["MACS 粗筛"]
  C -> F["NGS 测序<br/>每轮一份快照"]
  L -> M["产出：0.18 nM"]
}`);
  await renderDot(el);
  const svg = el.querySelector('.dot-diagram svg');
  assert.ok(svg, 'repaired DOT must render into a real SVG');
  assert.equal(svg.querySelectorAll('g.node').length, 6, 'all 6 nodes drawn');
  assert.equal(svg.querySelectorAll('g.edge').length, 4, 'all 4 edges drawn');
  const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
  assert.ok(texts.includes('ePCR 建库'), 'multi-line label first line');
  assert.ok(texts.includes('10⁸~10⁹ 变体'), 'superscript label line');
  assert.ok(!texts.some((t) => t.includes('<br')), 'no literal <br/> text');
  assert.equal(el.querySelector('.dot-error'), null, 'no error card');
  assert.equal(el.querySelector('pre'), null, 'code block swapped out');
});

test('renderDot keeps the original error card for DOT repair cannot fix', async () => {
  const el = makeDotEl('digraph { A[label= }');
  await renderDot(el);
  assert.ok(el.querySelector('.dot-error'), 'unfixable DOT still shows the error');
  assert.ok(el.querySelector('pre'), 'source block kept for copying');
});
