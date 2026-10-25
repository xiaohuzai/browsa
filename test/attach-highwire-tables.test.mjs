// test/attach-highwire-tables.test.mjs — HighWire 表格适配接线测试（2026-10-25）。
//
// biorxiv/medrxiv（HighWire 平台）把表格预渲染成 GIF 藏在 XHR expansion 端点后：
// 主 DOM 只有 [data-table-url] 占位 + caption，reader 正文里表格数据缺失
// （2026-10-24 PMC 完整性审计的姊妹发现）。适配三层：
//   ① extractInPageWorld 计数占位（highwireTableCount，同步零成本）；
//   ② background ATTACH_PAGE 见 >0 回页面 fetchHighwireTablesInPageWorld
//      （同源 fetch expansion，提取表格图 URL + caption alt）；
//   ③ 注入 ![Table N: 标题](url) 进 ctx.text → 既有 inlineImages 分支转 [图N]
//      vision 附件，alt 留在锚点行供模型文本面阅读。
// 本文件钉两端：page world 函数的真 DOM 单元（jsdom 只 stub 网络）+ handle()
// 级落库接线（注入文本 + [图N] 字节随条目）+ 两条 fail-open 地板。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeStorageArea } from './helpers/chrome-mock.mjs';

const { fetchHighwireTablesInPageWorld } = await import('../lib/page-extractor.js');

const BIORXIV_URL = 'https://www.biorxiv.org/content/10.64898/2026.01.11.698911v1.full';
const T1_GIF = 'https://www.biorxiv.org/content/biorxiv/early/2026/01/12/2026.01.11.698911/T1.medium.gif';

// 主 DOM 形态（真实 biorxiv 页面结构：#T1 块内 caption + data-table-url 占位）。
function pageHtml(nTables = 1) {
  let blocks = '';
  for (let i = 1; i <= nTables; i++) {
    blocks += `<div id="T${i}" class="table pos-float">`
      + '<div class="table-inline table-callout-links"><ul class="callout-links">'
      + `<li class="view-inline first"><a href="" class="table-expand-inline" data-table-url="/highwire/markup/51694${i}0/expansion?postprocessors=highwire_tables&amp;table-expand-inline=1">View inline</a></li>`
      + '</ul></div>'
      + `<div class="table-caption"><span class="table-label">Table ${i}:</span> `
      + `<span class="caption-title">Summary performance for campaign ${i}.</span>`
      + '<p id="p-19" class="first-child">Summary evaluation metrics for the trained models.</p></div>'
      + '</div>';
  }
  return `<!doctype html><html><body><article>${blocks}<p>Body text.</p></article></body></html>`;
}

// HighWire expansion 端点的真实响应形态：HTML 片段，表格以预渲染 GIF 呈现
// （img.fragment-table，noscript 里带孪生）。
function expansionHtml(n) {
  return `<html><body><div class="highwire-markup-wrapper">`
    + `<span class="fragment-container"><img class="highwire-fragment fragment-table" `
    + `alt="Table ${n}:" src="https://www.biorxiv.org/content/biorxiv/early/2026/01/12/2026.01.11.698911/T${n}.medium.gif" width="440" height="375"/>`
    + `<noscript><img class="highwire-fragment fragment-table" alt="Table ${n}:" src="https://www.biorxiv.org/content/biorxiv/early/2026/01/12/2026.01.11.698911/T${n}.medium.gif"/></noscript>`
    + '</span></div></body></html>';
}

async function withBiorxivDom(url, fetchImpl, fn) {
  const dom = new JSDOM(url ? pageHtml() : pageHtml(), { url: url || BIORXIV_URL });
  const prev = {
    window: globalThis.window, document: globalThis.document,
    fetch: globalThis.fetch, DOMParser: globalThis.DOMParser, location: globalThis.location,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.location = dom.window.location;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally {
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    globalThis.fetch = prev.fetch;
    globalThis.DOMParser = prev.DOMParser;
    globalThis.location = prev.location;
  }
}

test('fetchHighwireTablesInPageWorld: extracts table image + caption alt from expansion fragments', async () => {
  const calls = [];
  const out = await withBiorxivDom(BIORXIV_URL, async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return { ok: true, text: async () => expansionHtml(1) };
  }, () => fetchHighwireTablesInPageWorld());
  assert.equal(out.length, 1);
  assert.equal(out[0].tableId, 'T1');
  assert.equal(out[0].alt, 'Table 1: Summary performance for campaign 1.',
    'alt = table-label + caption-title（随 [图N] 锚点行进模型输入）');
  assert.equal(out[0].imageUrl, T1_GIF);
  assert.match(calls[0].url, /\/highwire\/markup\/5169410\/expansion\?postprocessors=highwire_tables/,
    'fetch 走 data-table-url 指向的 expansion 端点（相对 URL 绝对化）');
  assert.equal(calls[0].opts.credentials, 'include', '同源请求带页面 cookie');
});

test('fetchHighwireTablesInPageWorld: fragment without an image is skipped; GIF-less HTML table too', async () => {
  const out = await withBiorxivDom(BIORXIV_URL, async (url) => {
    if (String(url).includes('5169410')) return { ok: true, text: async () => '<html><body><p>no image here</p></body></html>' };
    return { ok: true, text: async () => expansionHtml(1) };
  }, () => fetchHighwireTablesInPageWorld());
  assert.equal(out.length, 0, '无图的 expansion 片段不产出表格行');
});

test('fetchHighwireTablesInPageWorld: expansion fragment with a lazy 1x1-gif placeholder yields its data-src image', async () => {
  // 真实 expansion 响应的形态（2026-10-24 实测）：表格图自己也懒加载——
  // src 是 1x1 data:gif 占位，真图在 data-src。真页面字节验证过此路径。
  const lazy = `<html><body><div class="highwire-markup-wrapper">`
    + `<span class="fragment-container"><img class="highwire-fragment fragment-table" alt="Table 1:" `
    + `src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" `
    + `data-src="https://www.biorxiv.org/content/biorxiv/early/2026/01/12/2026.01.11.698911/T1.medium.gif" width="440" height="375"/></span>`
    + '</div></body></html>';
  const out = await withBiorxivDom(BIORXIV_URL, async () => ({ ok: true, text: async () => lazy }),
    () => fetchHighwireTablesInPageWorld());
  assert.equal(out.length, 1);
  assert.equal(out[0].imageUrl, T1_GIF, 'data-src 懒加载占位必须被还原成真图 URL');
  assert.equal(out[0].alt, 'Table 1: Summary performance for campaign 1.');
});

test('fetchHighwireTablesInPageWorld: no placeholder → no fetch at all', async () => {
  let fetches = 0;
  const dom = new JSDOM('<!doctype html><html><body><p>plain page</p></body></html>', { url: 'https://example.com/' });
  const prev = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, DOMParser: globalThis.DOMParser, location: globalThis.location };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.location = dom.window.location;
  globalThis.fetch = async () => { fetches++; return { ok: false }; };
  try {
    const out = await fetchHighwireTablesInPageWorld();
    assert.equal(out.length, 0);
    assert.equal(fetches, 0, '普通站点零 fetch');
  } finally {
    globalThis.window = prev.window; globalThis.document = prev.document;
    globalThis.fetch = prev.fetch; globalThis.DOMParser = prev.DOMParser; globalThis.location = prev.location;
  }
});

// ── handle() 级落库接线 ──────────────────────────────────────────────────────
// 真 background.js handle() ATTACH_PAGE（reader 模式）：extractActiveTab 的结果
// 走 scriptQueue，fetchHighwireTablesInPageWorld 的 executeScript 调用按函数名
// 特判返回；表格图下载由全局 fetch stub 承接，断言注入文本 + [图N] 字节随条目。

const TABS = new Map();
function addTab(id, url) { TABS.set(id, { url, title: 'T' }); return id; }

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  deepExtractEnabled: false,
  providers: {
    compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' },
  },
});
const sessionArea = makeStorageArea();

let scriptQueue = [];
let hwTablesResult = null;
let hwScriptCalls = 0;

const chromeMock = {
  runtime: {
    id: 'testextensionid',
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: BIORXIV_URL, title: 'T' }],
    get: async (tabId) => ({ id: tabId, ...(TABS.get(tabId) || { url: BIORXIV_URL, title: 'T' }), favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts) => {
      if (opts.files) return [{ result: null }];
      const fn = String(opts.func);
      if (/contentType/.test(fn)) return [{ result: false }];
      // ⚠ 必须按函数定义前缀匹配：String(opts.func) 是整个函数源码，
      // extractInPageWorld 的注释里也引用了 fetchHighwireTablesInPageWorld
      // 这个名字（计数说明），宽松 regex 会把提取调用截胡。
      if (fn.trimStart().startsWith('async function fetchHighwireTablesInPageWorld')) {
        hwScriptCalls++;
        if (hwTablesResult === 'throw') throw new Error('executeScript exploded');
        return [{ result: hwTablesResult }];
      }
      // 提取调用同样按前缀特判（reader 模式的 readability 探针/cleanup/深度
      // 抽取探针都走无 files 的 executeScript，队列顺序不可依赖）。
      if (fn.trimStart().startsWith('function extractInPageWorld')) {
        return [{ result: scriptQueue.length ? scriptQueue.shift() : null }];
      }
      return [{ result: null }];
    },
  },
  storage: {
    local: localArea,
    session: sessionArea,
    onChanged: { addListener: () => {} },
  },
  downloads: { download: async () => ({}) },
  contextMenus: {
    create: () => ({}),
    onClicked: { addListener: () => {} },
    update: () => {},
    removeAll: (cb) => cb && cb(),
  },
  alarms: { create: () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
  declarativeNetRequest: {
    updateSessionRules: async () => {},
    getSessionRules: async () => [],
  },
};

const prevChrome = globalThis.chrome;
globalThis.chrome = chromeMock;
const bg = await import('../background.js');
const { handle } = bg;

async function lastEntry() {
  const { history } = await localArea.get('history');
  return history[history.length - 1];
}

function installFigureEnv() {
  const prev = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  globalThis.createImageBitmap = async () => ({ width: 440, height: 375, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect() {}, drawImage() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0x42, 0x44])], { type: 'image/jpeg' }); }
  };
  globalThis.fetch = async (url) => (/biorxiv\.org\/.*\.gif/.test(String(url))
    ? { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' }) }
    : { ok: false });
  return () => {
    globalThis.fetch = prev.fetch;
    globalThis.createImageBitmap = prev.createImageBitmap;
    globalThis.OffscreenCanvas = prev.OffscreenCanvas;
  };
}

function readerExtractResult() {
  return {
    text: 'Article body about nanobody affinity maturation. Results are summarized in Table 1.',
    format: 'markdown',
    rawTextLength: 92,
    wasCapped: false,
    articleTitle: 'Machine learning enables efficient and effective affinity maturation of nanobodies',
    imageCount: 0,
    highwireTableCount: 1,
    selection: '',
    limitHint: null
  };
}

test('ATTACH_PAGE reader: HighWire table image is appended and rides the [图N] pipeline into storage', async () => {
  const restore = installFigureEnv();
  hwTablesResult = [{ tableId: 'T1', alt: 'Table 1: Summary performance for campaign 1.', imageUrl: T1_GIF }];
  hwScriptCalls = 0;
  scriptQueue = [readerExtractResult()];
  try {
    const tabId = addTab(31, BIORXIV_URL);
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'reader' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, `链条终点不得报错: ${res.error || ''}`);
    assert.equal(hwScriptCalls, 1, '有占位时必须回页面跑一次表格提取');
    assert.match(res.ctx.text, /## Tables\n\nThe tables below are rendered by the site itself as images/,
      '注入节必须带平台形态说明');
    // 返回时 inlineImages 分支已把 markdown 图转成 [图N] 锚点（alt 保留）。
    assert.match(res.ctx.text, /\[图1\] Table 1: Summary performance for campaign 1\./,
      '表格图转成 [图N] 锚点行，alt 携带 caption');
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content), '表格图片字节必须随条目入库（vision 附件）');
    assert.match(entry.content[0].text, /\[图\d+\] Table 1: Summary performance for campaign 1\./,
      'alt 文本留在 [图N] 锚点行，模型文本面可读');
  } finally {
    restore();
  }
});

test('ATTACH_PAGE reader: no placeholder → no extra executeScript, text untouched', async () => {
  const restore = installFigureEnv();
  hwTablesResult = [];
  hwScriptCalls = 0;
  const extract = readerExtractResult();
  extract.highwireTableCount = 0;
  scriptQueue = [extract];
  try {
    const tabId = addTab(32, BIORXIV_URL);
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'reader' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    assert.equal(hwScriptCalls, 0, '普通站点零额外 executeScript');
    assert.ok(!res.ctx.text.includes('## Tables'), '不得注入');
  } finally {
    restore();
  }
});

test('ATTACH_PAGE reader: table probe failing is fail-open (caption-only text is the floor)', async () => {
  const restore = installFigureEnv();
  hwTablesResult = 'throw';
  hwScriptCalls = 0;
  scriptQueue = [readerExtractResult()];
  try {
    const tabId = addTab(33, BIORXIV_URL);
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'reader' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, '表格提取失败不得阻塞附加');
    assert.ok(!res.ctx.text.includes('## Tables'), '失败时不注入');
    assert.ok(res.ctx.text.includes('Article body'), '原提取文本保持');
  } finally {
    restore();
  }
});
