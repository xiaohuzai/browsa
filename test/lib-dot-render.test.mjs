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
