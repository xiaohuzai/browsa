// test/attach-arxiv-html.test.mjs — arXiv /html/ 全文重定向接线测试（2026-10-25）。
//
// arxiv.org/abs/<id> 只有摘要；官方 HTML5 全文（/html/<id>，LaTeXML，~97% 新
// TeX 提交）有真 HTML 表格 + LaTeX 公式 + 图。abs 页 attach 会丢掉全文。
// 三层：arxivAbsIdFromUrl（URL 门）→ fetchArxivHtmlInPageWorld（页面内 fetch
// /html/ + LaTeXML 适配：annotation LaTeX→$/$$、eqn 布局表折叠、rowspan/colspan
// 展平、相对图 URL 绝对化）→ extractActiveTab 接线（成功用 /html/ 结果、失败
// fail-open 落回 abs 页 cascade）。
//
// ⚠ executeScript mock 按函数定义前缀匹配——String(opts.func) 是整个函数源码，
// 宽松 regex 会撞上别的函数注释里引用的名字（attach-highwire-tables 的教训）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeStorageArea } from './helpers/chrome-mock.mjs';

const { arxivAbsIdFromUrl, fetchArxivHtmlInPageWorld } = await import('../lib/page-extractor.js');

const ABS_URL = 'https://arxiv.org/abs/2501.12948v1';
const HTML_URL = 'https://arxiv.org/html/2501.12948v1';

// 精简 laTeXML 页面 fixture：导航壳 + inline/block 公式（annotation LaTeX）+
// eqn 布局表 + 带 rowspan/colspan 的数据表 + 相对路径图。
function laTeXMLFixture() {
  return `<!doctype html><html><head><title>DeepSeek-R1 Test Paper</title></head><body>
  <header class="ltx_page_header"><nav>SKIP-NAV</nav></header>
  <main class="ltx_page_content">
    <h1 class="ltx_title">DeepSeek-R1 Test Paper</h1>
    <p class="ltx_p">Intro text with inline math <math alttext="o_{i}"><annotation encoding="application/x-tex">o_{i}</annotation></math> and more prose to fill length.</p>
    <table class="ltx_equation ltx_eqn_table"><tbody><tr>
      <td class="ltx_eqn_cell ltx_eqn_center_padleft"></td>
      <td class="ltx_eqn_cell ltx_align_center"><math display="block"><annotation encoding="application/x-tex">\\frac{1}{G}\\sum r</annotation></math></td>
      <td class="ltx_eqn_cell ltx_eqn_eqno"><span class="ltx_tag">(1)</span></td>
    </tr></tbody></table>
    <figure class="ltx_figure">
      <img src="2501.12948v1/figures/plot.png" alt="Figure 1: benchmark plot">
      <figcaption>Figure 1: benchmark plot</figcaption>
    </figure>
    <section><h2>Results</h2>
    <p>Results body text that is long enough to survive the readability threshold and mention the table.</p>
    <table class="ltx_tabular" id="S2.E1">
      <thead><tr><th rowspan="2" class="ltx_th">Model</th><th colspan="2" class="ltx_th">AIME 2024</th></tr>
      <tr><th class="ltx_th">Maj@k</th><th class="ltx_th">Pass@k</th></tr></thead>
      <tbody>
        <tr><td class="ltx_td">DeepSeek-R1</td><td class="ltx_td">79.8</td><td class="ltx_td">71.2</td></tr>
        <tr><td class="ltx_td">GPT-4o</td><td class="ltx_td">9.3</td><td class="ltx_td">11.9</td></tr>
      </tbody>
    </table>
    </section>
  </main></body></html>`;
}

async function withArxivDom(url, fetchImpl, fn) {
  const dom = new JSDOM(laTeXMLFixture(), { url: url || ABS_URL });
  const prev = {
    window: globalThis.window, document: globalThis.document,
    fetch: globalThis.fetch, DOMParser: globalThis.DOMParser, location: globalThis.location,
    Readability: globalThis.Readability, TurndownService: globalThis.TurndownService, TurndownPluginGfm: globalThis.TurndownPluginGfm,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.location = dom.window.location;
  globalThis.fetch = fetchImpl;
  // vendor globals (page world would have them from ensureReadabilityInjected);
  // JSDOM with outside-only scripts: window.eval runs them in the window realm
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ctx = dom.window;
  // JSDOM window.eval 的 var 不挂 window——显式捕获（构造器留在 jsdom realm）
  for (const [file, name] of [
    ['lib/vendor/Readability.iife.js', 'Readability'],
    ['lib/vendor/Turndown.iife.js', 'TurndownService'],
    ['lib/vendor/TurndownPluginGfm.iife.js', 'TurndownPluginGfm'],
  ]) {
    ctx.eval(fs.readFileSync(join(ROOT, file), 'utf8') + `\n;window.__cap = ${name};`);
    globalThis[name] = ctx.__cap;
  }
  try { return await fn(); } finally {
    globalThis.window = prev.window; globalThis.document = prev.document;
    globalThis.fetch = prev.fetch; globalThis.DOMParser = prev.DOMParser; globalThis.location = prev.location;
    globalThis.Readability = prev.Readability; globalThis.TurndownService = prev.TurndownService; globalThis.TurndownPluginGfm = prev.TurndownPluginGfm;
  }
}

function dirname(p) { return p.replace(/[/\\][^/\\]*$/, ''); }

test('arxivAbsIdFromUrl: extracts new/old/versioned ids, rejects non-abs URLs', () => {
  assert.equal(arxivAbsIdFromUrl('https://arxiv.org/abs/2501.12948v1'), '2501.12948v1');
  assert.equal(arxivAbsIdFromUrl('https://arxiv.org/abs/2501.12948'), '2501.12948');
  assert.equal(arxivAbsIdFromUrl('https://arxiv.org/abs/cs/0112017'), 'cs/0112017');
  assert.equal(arxivAbsIdFromUrl('https://arxiv.org/html/2501.12948v1'), null);
  assert.equal(arxivAbsIdFromUrl('https://example.com/abs/1234'), null);
  assert.equal(arxivAbsIdFromUrl(''), null);
});

test('fetchArxivHtmlInPageWorld: math→$, eqn tables collapse, spans expand, figure URLs absolutized', async () => {
  const fetched = [];
  const out = await withArxivDom(ABS_URL, async (url) => {
    fetched.push(String(url));
    return { ok: true, text: async () => laTeXMLFixture() };
  }, () => fetchArxivHtmlInPageWorld(ABS_URL));
  assert.equal(out.error, undefined, `should not error: ${out.error || ''}`);
  assert.ok(out.text.length > 300, 'markdown produced');
  assert.ok(out.text.includes('$$\\frac{1}{G}\\sum r$$'), 'display math becomes $$ LaTeX $$ from the annotation');
  assert.ok(out.text.includes('$o_{i}$'), 'inline math becomes $ LaTeX $');
  assert.ok(!out.text.includes('<math'), 'no MathML remnants');
  assert.ok(!out.text.includes('ltx_eqn'), 'equation layout tables must not become markdown tables');
  assert.ok(out.text.includes('(1)'), 'equation tag survives as text');
  // rowspan/colspan expansion: Model spans 2 rows, "AIME 2024" spans 2 cols
  assert.match(out.text, /\| Model \| AIME 2024 \| AIME 2024 \|/, 'rowspan/colspan expanded into a uniform grid');
  assert.match(out.text, /\| Model \| Maj@k \| Pass@k \|/, 'row-header repeated on the sub-header row');
  assert.match(out.text, /\| DeepSeek-R1 \| 79\.8 \| 71\.2 \|/, 'data rows intact');
  // figure src absolutized against the /html/ URL
  assert.match(out.text, /!\[[^\]]*\]\(https:\/\/arxiv\.org\/html\/2501\.12948v1\/figures\/plot\.png\)/,
    'relative figure src must be absolutized');
  assert.ok(fetched[0] === HTML_URL, 'fetches /html/<id> for the abs page');
  assert.equal(out.articleTitle, 'DeepSeek-R1 Test Paper');
});

test('fetchArxivHtmlInPageWorld: 6+ external links get citation markers + References, image links untouched', async () => {
  const linkHtml = laTeXMLFixture().replace('</main>',
    '<p>See: ' + Array.from({ length: 6 }, (_, i) => `<a href="https://outside.example/page${i}">ref ${i}</a>`).join(' and ') + '.</p>'
    + '<figure class="ltx_figure"><img src="2501.12948v1/figures/plot2.png" alt="Figure 2:"></figure></main>');
  const out = await withArxivDom(ABS_URL, async () => ({ ok: true, text: async () => linkHtml }),
    () => fetchArxivHtmlInPageWorld(ABS_URL));
  assert.equal(out.error, undefined, `should not error: ${out.error || ''}`);
  assert.match(out.text, /ref 0⟨1⟩/, 'external links numbered');
  assert.match(out.text, /## References\n\[1\] https:\/\/outside\.example\/page0/, 'References footer appended');
  assert.match(out.text, /!\[[^\]]*\]\(https:\/\/arxiv\.org\/html\/[^)]*plot2\.png\)/,
    'figure markdown must keep its real URL (nested-image exclusion)');
});

test('fetchArxivHtmlInPageWorld: 404 and error pages fail closed to the caller', async () => {
  const notFound = await withArxivDom(ABS_URL, async () => ({ ok: false, status: 404 }),
    () => fetchArxivHtmlInPageWorld(ABS_URL));
  assert.match(notFound.error, /no html version/, '404 must surface as a typed error');
  const junk = await withArxivDom(ABS_URL, async () => ({ ok: true, text: async () => '<html><body><p>maintenance</p></body></html>' }),
    () => fetchArxivHtmlInPageWorld(ABS_URL));
  assert.match(junk.error, /error page/, 'content-less page must be rejected');
});

// ── extractActiveTab 接线：arxiv URL 用 /html/ 结果，404 落回 abs cascade ────
const TABS = new Map();
function addTab(id, url) { TABS.set(id, { url, title: 'T' }); return id; }

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  deepExtractEnabled: false,
  providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
});
const sessionArea = makeStorageArea();
let scriptQueue = [];
let arxivResult = null;
let arxivCalls = 0;

const chromeMock = {
  runtime: { id: 'testextensionid', onMessage: { addListener: () => {} }, onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} }, sendMessage: () => {}, connect: () => null, getURL: (p) => p, lastError: undefined },
  tabs: { onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: ABS_URL, title: 'T' }],
    get: async (tabId) => ({ id: tabId, ...(TABS.get(tabId) || { url: ABS_URL, title: 'T' }), favIconUrl: '' }) },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: { onHistoryStateUpdated: { addListener: () => {} }, onCommitted: { addListener: () => {} }, onBeforeNavigate: { addListener: () => {} } },
  scripting: { executeScript: async (opts) => {
    if (opts.files) return [{ result: null }];
    const fn = String(opts.func);
    if (/contentType/.test(fn)) return [{ result: false }];
    if (fn.trimStart().startsWith('async function fetchArxivHtmlInPageWorld')) {
      arxivCalls++;
      if (arxivResult === 'throw') throw new Error('executeScript exploded');
      return [{ result: arxivResult }];
    }
    if (fn.trimStart().startsWith('function extractInPageWorld')) {
      return [{ result: scriptQueue.length ? scriptQueue.shift() : null }];
    }
    return [{ result: null }];
  } },
  storage: { onChanged: { addListener: () => {} }, local: localArea, session: sessionArea },
  alarms: { create: () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => ({}), onClicked: { addListener: () => {} }, update: () => {}, removeAll: (cb) => cb && cb() },
  declarativeNetRequest: { updateSessionRules: async () => {}, getSessionRules: async () => [] },
  downloads: { download: async () => ({}) },
};

const prevChrome = globalThis.chrome;
globalThis.chrome = chromeMock;
globalThis.fetch = async (url) => (/biorxiv\.org|arxiv\.org\/.*\.(png|gif|jpg)/.test(String(url))
  ? { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }
  : { ok: false });
globalThis.createImageBitmap = async () => ({ width: 640, height: 400, close() {} });
globalThis.OffscreenCanvas = class { constructor() {} getContext() { return { fillRect() {}, drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array([0x42, 0x44])], { type: 'image/jpeg' }); } };

const bg = await import('../background.js');
const { handle } = bg;

async function lastEntry() {
  const { history } = await localArea.get('history');
  return history[history.length - 1];
}

test('ATTACH_PAGE on an arxiv abs URL: /html/ full text wins and rides the normal reader pipeline', async () => {
  arxivResult = {
    text: '# DeepSeek-R1 Test Paper\n\n' + 'Intro prose paragraph that carries real length for the adoption threshold check. '.repeat(8)
      + '\n\nResults in the table below.\n\n| Model | AIME | Pass |\n| --- | --- | --- |\n| R1 | 79.8 | 71.2 |\n\n![Figure 1: benchmark plot](https://arxiv.org/html/2501.12948v1/figures/plot.png)',
    articleTitle: 'DeepSeek-R1 Test Paper'
  };
  arxivCalls = 0;
  scriptQueue = [];
  try {
    const tabId = addTab(41, ABS_URL);
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, `链条终点不得报错: ${res.error || ''}`);
    assert.equal(arxivCalls, 1, 'arxiv abs URL 必须尝试 /html/ 全文');
    assert.equal(res.ctx.mode, 'reader', 'ctx.mode=reader → caps inlineImages/siteInstructions 生效');
    assert.equal(res.ctx.arxivHtml, true, '来源标记');
    assert.match(res.ctx.text, /Model \| AIME/, 'markdown 表格保住');
    // 表格图随 [图N] 管线入库（alt 进锚点行）
    assert.match(res.ctx.text, /\[图\d+\] Figure 1: benchmark plot/, 'arxiv 图转 [图N] 锚点');
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content), '图片字节随条目入库（vision 附件）');
  } finally {
    // restore
  }
});

test('ATTACH_PAGE: /html/ 404 falls back to the plain abs cascade (fail-open)', async () => {
  arxivResult = { error: 'no html version (status 404)' };
  arxivCalls = 0;
  scriptQueue = [{
    text: 'Abstract-only fallback text from the abs page cascade. '.repeat(20),
    format: 'markdown', rawTextLength: 1000, wasCapped: false, articleTitle: 'Abs Page', highwireTableCount: 0, selection: '', limitHint: null
  }];
  try {
    const tabId = addTab(42, ABS_URL);
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, `链条终点不得报错: ${res.error || ''}`);
    assert.equal(arxivCalls, 1, '仍然先试过 /html/');
    assert.ok(!res.ctx.arxivHtml, '回退路径不带 arxivHtml 标记');
    assert.match(res.ctx.text, /Abstract-only fallback/, '落到常规 abs cascade');
  } finally {
    // restore
  }
});
