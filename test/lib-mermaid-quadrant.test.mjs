// test/lib-mermaid-quadrant.test.mjs — real Mermaid render for the one diagram
// type that silently disappeared: quadrantChart.
//
// Mermaid 12.2's default theme computes
//   quadrantPointFill = ... darken(quadrant1Fill)
// with no `amount`, producing hsl(240, 100%, NaN%) on every data point.
// sanitizeMermaidSvg (stream-markdown-parser) rejects any SVG with a NaN
// attribute, so the whole chart was discarded. render.js pins
// themeVariables.quadrantPointFill to a valid color; this test renders the
// real bundle and verifies both halves: no NaN, sanitizer accepts.

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
// jsdom lacks constructable stylesheets and SVG text measurement; Mermaid's
// renderer uses both. Minimal stubs are enough for the SVG structure.
globalThis.CSSStyleSheet = class {
  constructor() { this.cssRules = []; }
  replaceSync(css) { this._css = String(css); }
  insertRule(rule) { this.cssRules.push(rule); return 0; }
  deleteRule() {}
};
Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true, configurable: true });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 100, height: 20 }; };
dom.window.SVGElement.prototype.getComputedTextLength = function () { return 100; };

const { default: mermaid } = await import('../lib/vendor/mermaid.bundle.js');
const { sanitizeMermaidSvg } = await import('../lib/vendor/stream-markdown-parser.bundle.js');

test('quadrantChart renders without NaN and survives sanitizeMermaidSvg (Mermaid 12.2 theme bug)', async () => {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    themeVariables: { quadrantPointFill: '#9370DB' },
  });
  const src = `quadrantChart
    title 英伟达三十年战役：时间 x 结果
    x-axis 早期 2000 --> 后期 2023
    y-axis 失败 --> 胜利
    quadrant-1 后期胜利
    quadrant-2 早期胜利
    quadrant-3 早期失利
    quadrant-4 后期失利
    GeForce256定义GPU: [0.15, 0.75]
    微软XBOX仲裁: [0.2, 0.2]
    GeForceFX翻车: [0.25, 0.12]
    对Intel专利战: [0.4, 0.7]
    CUDA十年豪赌: [0.45, 0.35]
    显卡门事件: [0.5, 0.2]
    AlexNet转折: [0.55, 0.8]
    手机芯片Tegra: [0.65, 0.15]
    自动驾驶DrivePX2: [0.7, 0.3]
    挖矿周期红利: [0.78, 0.6]
    2022三重打击: [0.85, 0.1]
    ChatGPT万亿市值: [0.92, 0.95]`;
  const { svg } = await mermaid.render('quadrant-regression', src);
  assert.doesNotMatch(svg, /\bNaN\b/, 'default quadrantPointFill must not leak NaN into attributes');
  const clean = sanitizeMermaidSvg(svg);
  assert.ok(clean, 'sanitizeMermaidSvg must accept the rendered quadrant chart');
  assert.match(clean, /<circle\b/);
  assert.match(clean, /ChatGPT万亿市值/);
});
