// test/attach-site-images.test.mjs — 站点图片落库接线测试（字节图 + 知乎配图两条管线）。
//
// 2026-10-11 用户报告「小红书图文笔记只有文字」暴露的断线：v0.20.0 把 MAIN world
// 取到的字节随 CHAT 消息的 pageContext 进请求；v0.21.0 请求组装搬进 history 重建后
// 这根线死了——每次附加提取到的字节在落库时被丢，而 buildMessages 里自称 XHS 图片
// 通道的 pageContext 分支是死代码。#223 重做提取侧时也没接回发送侧。
//
// 本文件是这条链的**落库半段**地板：五条站点路径（XHS XHR 快路径 / XHS
// INITIAL_STATE 慢路径 / X active fallback / Reddit active fallback / 知乎专栏）
// 全部走真实 background.js 的 handle()，钉「图片必须随 attach 条目入库」（字节图
// 是 [text, ...image_url] 无锚形状，知乎配图是 [text, image_url, text] 锚点交错
// 形状）。**请求半段**（带图条目必须到达每家 provider 的请求体）钉在
// test/chat-rebuild-channels.test.mjs 的 "attach-entry images reach the wire" 节
// ——两文件以同一条目形状对接，任一侧漂移都会红。全失败回退纯字符串形状也在此
// 钉住。
//
// ⚠ 2026-10-15 教训（知乎配图回归）：本文件早期的桩是**手工造好的提取结果**——
// 提取侧把图片剥掉时这些测试照样绿（XHS/X/Reddit 的桩喂原始提取形状、真合成器在
// background 里跑，所以那三家桩层足够；知乎断在更上游的 content script 转换器）。
// 「知乎链路」一节由此而生：真实 content script 函数（jsdom 驱动，只 stub 网络）
// 产出喂真实 ATTACH_PAGE——站点能力的链条必须有这种只 stub 网络的链路级测试，
// 桩喂手工结果的落库测试钉不住提取侧能力丢失。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

const D1 = 'data:image/jpeg;base64,AAAA';
const D2 = 'data:image/jpeg;base64,BBBB';

// 每测试自登记 tab（url/title），tabs.get 按请求的 id 返回——xhsXhrCache 按
// tabId 隔离，快路径种过的 tab 不能再走慢路径测试。
const TABS = new Map();
function addTab(id, url, title = 'T') { TABS.set(id, { url, title }); return id; }

function makeStorageArea(initial = {}) {
  let store = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { store = { ...store, ...obj }; },
    async remove(key) { delete store[key]; },
    _dump() { return store; },
  };
}

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  providers: {
    compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' },
  },
});
const sessionArea = makeStorageArea();

// 每测试预置的 executeScript 返回值队列（files 注入调用不消费队列）。
let scriptQueue = [];

// DNR session 规则 spy（zhihu Referer 门测试用；每测试手动清零）。
const dnrCalls = [];

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
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async (tabId) => ({ id: tabId, ...(TABS.get(tabId) || { url: 'https://example.com', title: 'Test' }), favIconUrl: '' }),
  },
  sidePanel: {
    setOptions: () => {},
    setPanelBehavior: async () => {},
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts) => {
      if (opts.files) return [{ result: null }];
      // isPdfDocument 的 contentType 探针对无 .pdf 后缀的 URL 也会跑，必须否定——
      // 否则它会消费脚本队列，把整条提取带进 pdf-url 占位（首版测试的翻车点）。
      if (/contentType/.test(String(opts.func))) return [{ result: false }];
      return [{ result: scriptQueue.length ? scriptQueue.shift() : null }];
    },
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: localArea,
    session: sessionArea,
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} },
  },
  declarativeNetRequest: {
    updateSessionRules: async (opts) => { dnrCalls.push(opts); },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

const bg = await import('../background.js');
const { handle } = bg;

const NOTE_ID = 'abc123def4567890abcd1234';
const XHS_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=AbCdEf&xsec_source=pc_feed`;

async function lastEntry() {
  const { history } = await localArea.get('history');
  return history[history.length - 1];
}

function assertImageEntry(entry, titleRe, urls) {
  assert.ok(Array.isArray(entry.content), '有字节 → content 是多模态数组');
  assert.equal(entry.content.length, urls.length + 1);
  const textPart = entry.content[0];
  assert.equal(textPart.type, 'text');
  assert.match(textPart.text, /^\[Page context attached by browsa\]/);
  assert.match(textPart.text, titleRe);
  urls.forEach((u, i) => {
    assert.deepEqual(entry.content[i + 1], { type: 'image_url', image_url: { url: u } });
  });
}

// ── XHS XHR 快路径（拦截器命中）──────────────────────────────────────────────

test('XHS fast-path attach: MAIN-world image bytes ride the entry as [text, ...image_url] parts', async () => {
  const tabId = addTab(9, XHS_URL, 'XHS note');
  await handle({
    type: 'XHS_XHR_NOTE',
    note: {
      noteId: NOTE_ID,
      title: '苏州两日行程',
      desc: '这份攻略包含了完整的路线图和预算表，都在图片里。',
      author: '旅人小张',
      imageCount: 2,
      imageUrls: ['https://sns-webpic-qc.xhscdn.com/a!nd_dft', 'https://sns-webpic-qc.xhscdn.com/b!nd_dft'],
      tagList: ['苏州'],
      likedCount: 100,
      commentCount: 5,
      rawAt: Date.now(),
    },
  }, { tab: { id: tabId } });
  scriptQueue = [[D1, D2]]; // _fetchXhsImagesInPageWorld 的取图结果
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true, `快路径附加不得报错（meta 缺失曾让它在落库时硬崩）: ${res.error || ''}`);
  assert.deepEqual(res.ctx.imageBase64List, [D1, D2], 'ctx 带回提取到的字节');

  assertImageEntry(await lastEntry(), /苏州两日行程/, [D1, D2]);
});

test('XHS fast-path attach, all image fetches fail: plain string content (shape unchanged)', async () => {
  const tabId = addTab(10, XHS_URL, 'XHS note');
  await handle({
    type: 'XHS_XHR_NOTE',
    note: { noteId: NOTE_ID, title: '苏州两日行程', desc: '这份攻略包含了完整的路线图和预算表，都在图片里。', imageCount: 2, imageUrls: ['https://sns-webpic-qc.xhscdn.com/a'], rawAt: Date.now() },
  }, { tab: { id: tabId } });
  scriptQueue = [[]];
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);

  const entry = await lastEntry();
  assert.equal(typeof entry.content, 'string', '全失败 → 保持纯字符串 content');
  assert.match(entry.content, /苏州两日行程/);
});

// ── XHS INITIAL_STATE 慢路径（拦截器没捕到 → 页内轮询 + 提取）───────────────

test('XHS initial-state path attach: extractor image bytes ride the entry too', async () => {
  const tabId = addTab(11, XHS_URL, 'XHS note');
  scriptQueue = [
    { ready: true, via: 'initial-state', waited: 5 }, // 轮询探针
    { // extractXiaohongshuInPageWorld 的返回
      text: '# 苏州两日行程\n\n这份攻略包含了完整的路线图和预算表，都在图片里。\n\n👍 100  ·  💬 5  ·  🖼 2 图',
      articleTitle: '苏州两日行程',
      articleByline: '旅人小张',
      imageCount: 2,
      imageBase64List: [D1, D2],
      rawTextLength: 60,
      wasCapped: false,
      xhsSubSource: 'initial-state',
    },
  ];
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ctx.imageBase64List, [D1, D2]);

  assertImageEntry(await lastEntry(), /苏州两日行程/, [D1, D2]);
});

// ── X active fallback（tryXActiveFallback）──────────────────────────────────

test('X active-fallback attach: tweet photo bytes ride the entry', async () => {
  const tabId = addTab(12, 'https://x.com/someone/status/123456', 'Tweet');
  scriptQueue = [{
    text: '这条推文的配图里有完整的数据表。',
    author: 'Alice', screenName: 'alice',
    likes: 10, retweets: 2, repliesCount: 1, quotes: 0,
    photos: ['https://pbs.twimg.com/media/a.jpg'],
    imageBase64List: [D1],
  }];
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ctx.imageBase64List, [D1]);

  const entry = await lastEntry();
  assertImageEntry(entry, /\*\*配图\*\*: 1 张（图片数据已随消息附上）/, [D1]);
});

// ── Reddit active fallback（tryRedditActiveFallback）────────────────────────

test('Reddit active-fallback attach: gallery bytes ride the entry', async () => {
  const tabId = addTab(13, 'https://www.reddit.com/r/xyz/comments/abc/title/', 'Reddit');
  scriptQueue = [{
    post: { title: 'Gallery post', subreddit: 'xyz', author: 'u1', score: 5, numComments: 1, selftext: '正文内容，描述这些图。' },
    comments: [],
    imageBase64List: [D2],
  }];
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ctx.imageBase64List, [D2]);

  const entry = await lastEntry();
  assertImageEntry(entry, /Gallery post/, [D2]);
});

// ── 上限政策：按字节预算，不按张数（2026-10-11 用户报告 15 图只到 5）─────────

test('XHS 15-image note: every fetched byte rides the entry (budget, not count, is the cap)', async () => {
  const NOTE2 = 'bcdef1234567890abcdef12';
  const url2 = `https://www.xiaohongshu.com/explore/${NOTE2}?xsec_token=XyZ&xsec_source=pc_feed`;
  const tabId = addTab(14, url2, 'XHS 15img');
  const urls = Array.from({ length: 15 }, (_, i) => `https://sns-webpic-qc.xhscdn.com/img${i}`);
  const bytes = Array.from({ length: 15 }, (_, i) => `data:image/jpeg;base64,IMG${String(i).padStart(2, '0')}`);
  await handle({
    type: 'XHS_XHR_NOTE',
    note: { noteId: NOTE2, title: '十五图笔记', desc: '内容都在图里。', imageCount: 15, imageUrls: urls, rawAt: Date.now() },
  }, { tab: { id: tabId } });
  scriptQueue = [bytes];
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.imageBase64List.length, 15, '取回多少就存多少——不得再有张数硬裁');

  const entry = await lastEntry();
  const imgParts = entry.content.filter((p) => p?.type === 'image_url');
  assert.equal(imgParts.length, 15);
  assert.deepEqual(imgParts.map((p) => p.image_url.url), bytes, '顺序保持笔记图序');
});

// ── 知乎专栏（tryZhihuActiveFallback → [图N] 配图管线 + zhimg Referer 门）─────
//
// 2026-10-15 用户报告「知乎推文图片 attach 不上去」：#223 的知乎全文 fallback
// 用 htmlToText 把 API HTML 剥成纯文本，图片 URL 一步丢失，而合成模式 'zhihu'
// 不在 ATTACH_MODE_CAPS 里、没有任何配图通道。修复后知乎正文带保序
// ![alt](url) markdown（zhihu-content-script 的 htmlToArticleText），走与
// reader/auto 同一条 inlinePageImages 管线；zhimg.com 对「不像浏览器且无站内
// Referer」的请求 403（真扩展 SW 靠浏览器特征可过，启发式收紧即静默降级），
// 下载前经 DNR session 规则显式注入站内 Referer。
//
// mode 一律传 'dom'（与 X/XHS/Reddit 用例同法）：reader/auto 会先跑
// ensureReadabilityInjected，其注入探针会消费脚本队列。站点 fast path 拥有
// 提取权（dom 请求也得到 ctx.mode='zhihu'），caps 行 zhihu 照样生效。

// 装上取图三件套 stub（Node 无 createImageBitmap/OffscreenCanvas；fetch 按 URL
// 放行）。convertToBlob 返回固定字节 0x42,0x44 → dataURL 恒为 ...QkQ=，断言确定。
// 2026-10-15 起知乎/掘金/极客时间/雪球四家配图测试共用（原图床 + 通用占位域）。
function installFigureEnv({ failDownloads = false } = {}) {
  const prev = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  globalThis.createImageBitmap = async () => ({ width: 640, height: 400, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect() {}, drawImage() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0x42, 0x44])], { type: 'image/jpeg' }); }
  };
  globalThis.fetch = async (url) => (!failDownloads && /zhimg\.com|byteimg\.com|geekbang\.org|imedao\.com|example\.com/.test(String(url))
    ? { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) }
    : { ok: false });
  return () => {
    globalThis.fetch = prev.fetch;
    globalThis.createImageBitmap = prev.createImageBitmap;
    globalThis.OffscreenCanvas = prev.OffscreenCanvas;
  };
}

const ZHIHU_FIGURE_TEXT = '正文开头。\n\n![配图](https://picx.zhimg.com/v2-abc_r.jpg?source=1)\n\n正文结尾。';

test('zhihu attach: figures become [图N] anchors + image parts; zhimg Referer gate registered then removed', async () => {
  const tabId = addTab(20, 'https://zhuanlan.zhihu.com/p/123456', '知乎专栏文章');
  scriptQueue = [{
    type: 'article', id: '123456', title: '知乎专栏文章', text: ZHIHU_FIGURE_TEXT,
    author: '作者', voteupCount: 5, commentCount: 1, rawAt: Date.now(),
  }];
  const restore = installFigureEnv();
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, `知乎附加不得报错: ${res.error || ''}`);
    assert.equal(res.ctx.mode, 'zhihu', '站点 fast path 拥有提取权——dom 请求也得到合成的 zhihu 模式');

    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content), '配图成功 → content 是多模态数组');
    assert.equal(entry.content.length, 3, '锚点在文中 → [text, image_url, text] 交错形状');
    assert.deepEqual(
      entry.content[1],
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QkQ=' } },
      '图片字节随条目入库'
    );
    const fullText = entry.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    assert.match(fullText, /\[图1\] 配图/, '原位 [图N] 锚点带 alt');
    assert.ok(!fullText.includes('zhimg.com'), '锚点替换后图片 URL 不残留');
    assert.match(fullText, /随附的 1 张页面配图/, '文末张数说明行');

    assert.equal(dnrCalls.length, 2, `DNR 恰好 register+remove 两次，实际: ${JSON.stringify(dnrCalls)}`);
    assert.equal(dnrCalls[0].addRules[0].condition.urlFilter, 'zhimg');
    assert.equal(dnrCalls[0].addRules[0].action.requestHeaders[0].header, 'referer');
    assert.equal(dnrCalls[0].addRules[0].action.requestHeaders[0].value, 'https://www.zhihu.com/');
    assert.deepEqual(dnrCalls[0].addRules[0].condition.initiatorDomains, ['testextensionid'],
      '规则只作用于扩展自己发起的请求');
    assert.deepEqual(dnrCalls[1].removeRuleIds, [9000001], 'finally 移除规则');
  } finally {
    restore();
  }
});

test('zhihu attach, non-gated figure host: figure still rides, DNR untouched', async () => {
  const tabId = addTab(21, 'https://zhuanlan.zhihu.com/p/123456', '知乎专栏文章');
  scriptQueue = [{
    type: 'article', id: '123456', title: '知乎专栏文章',
    text: 'a\n\n![](https://cdn.example.com/pic.jpg)\n\nb', rawAt: Date.now(),
  }];
  const restore = installFigureEnv();
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content));
    assert.deepEqual(entry.content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QkQ=' } });
    assert.equal(dnrCalls.length, 0, '非门禁图床不碰 DNR');
  } finally {
    restore();
  }
});

test('zhihu attach, figure downloads all fail: fail-open keeps ![alt](url) text, DNR still cleaned up', async () => {
  const tabId = addTab(22, 'https://zhuanlan.zhihu.com/p/123456', '知乎专栏文章');
  scriptQueue = [{
    type: 'article', id: '123456', title: '知乎专栏文章', text: ZHIHU_FIGURE_TEXT, rawAt: Date.now(),
  }];
  const restore = installFigureEnv({ failDownloads: true });
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    const entry = await lastEntry();
    assert.equal(typeof entry.content, 'string', '全失败 → 保持纯字符串 content（管线 fail-open）');
    assert.ok(entry.content.includes('![配图](https://picx.zhimg.com/v2-abc_r.jpg?source=1)'),
      'URL 保留在正文里，模型仍看得到');
    assert.equal(dnrCalls.length, 2, '下载失败也不泄漏 DNR 规则：register+remove 都发生');
    assert.deepEqual(dnrCalls[1].removeRuleIds, [9000001]);
  } finally {
    restore();
  }
});

// ── 知乎链路地板（真实提取函数 → 真实合成 → 真实落库，只 stub 网络）──────────
//
// 上面的知乎用例喂的是手工提取结果，钉不住「提取侧把图剥掉」这个本回归的真实
// 形状。本节从 content script 的真函数开始：jsdom 驱动 activeZhihuFetch /
// extractZhihuArticle（fetch 返回真实形状的知乎 API JSON），其产出再喂真实
// ATTACH_PAGE——API HTML 到入库图片字节一线贯穿。

const zhihuCs = require(fileURLToPath(new URL('../lib/content-scripts/zhihu-content-script.js', import.meta.url)));

// 真实形状的知乎专栏 API content HTML：noscript 孪生 + 80px src + data-actualsrc。
const ZHIHU_API_HTML = '<p>正文开头。</p>'
  + '<figure data-size="normal">'
  + '<noscript><img src="https://picx.zhimg.com/v2-real_r.jpg?source=1"></noscript>'
  + '<img width="720" src="https://picx.zhimg.com/v2-real_720w.jpg?source=1" '
  + 'data-actualsrc="https://picx.zhimg.com/v2-real_r.jpg?source=1" data-original="https://picx.zhimg.com/v2-real_r.jpg?source=1">'
  + '<figcaption>图注</figcaption></figure>'
  + '<p>正文结尾。</p>';

// zhuanlan /api/articles/{id} 的计数字段是 camelCase（v4 answers API 才是 snake_case）。
async function withZhihuPageDom(url, apiJson, fn) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  const prev = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.fetch = async (fetchUrl) => (/zhuanlan\.zhihu\.com\/api\/articles\//.test(String(fetchUrl))
    ? { ok: true, json: async () => apiJson }
    : { ok: false });
  // return await（不是 return）：finally 必须等 fn 落定再恢复全局——否则
  // activeZhihuFetch 还在 await fetch 时 document/fetch 已被还原。
  try { return await fn(); } finally {
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    globalThis.fetch = prev.fetch;
  }
}

test('zhihu chain: activeZhihuFetch (real converter) → synthesizer → storage carries the figure', async () => {
  // 第 1 段：真实提取函数。jsdom location 指向用户报告的那篇专栏形状的 URL。
  const extracted = await withZhihuPageDom(
    'https://zhuanlan.zhihu.com/p/1883676507878168327',
    { id: 1883676507878168327, title: '知乎专栏文章', content: ZHIHU_API_HTML, author: { name: '作者' }, voteupCount: 5, commentsCount: 1 },
    () => zhihuCs.activeZhihuFetch(),
  );
  assert.ok(extracted, 'activeZhihuFetch 必须出结果');
  assert.equal(extracted.type, 'article');
  assert.equal((extracted.text.match(/!\[/g) || []).length, 1, 'noscript 孪生不重复');
  assert.match(extracted.text, /!\[\]\(https:\/\/picx\.zhimg\.com\/v2-real_r\.jpg\?source=1\)/,
    '真实转换器把 API HTML 的图保留成 markdown（data-actualsrc 优先）');
  assert.ok(extracted.text.includes('正文开头。') && extracted.text.includes('正文结尾。'), '正文文字不丢');

  // 第 2 段：提取结果（生产里由 executeScript 带回）喂真实 ATTACH_PAGE——合成、
  // caps、Referer 门、取图、落库全链真实。
  const tabId = addTab(30, 'https://zhuanlan.zhihu.com/p/1883676507878168327', '知乎专栏文章');
  scriptQueue = [extracted];
  const restoreEnv = installFigureEnv();
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, `链条终点不得报错: ${res.error || ''}`);
    assert.equal(res.ctx.mode, 'zhihu');
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content), '图片字节必须随条目入库——提取侧重新剥图时本测试红');
    assert.equal(entry.content.length, 3);
    assert.deepEqual(entry.content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QkQ=' } });
    assert.match(entry.content[0].text, /\[图1\]/);
    assert.equal(dnrCalls.length, 2, 'zhimg Referer 门照常挂/撤');
  } finally {
    restoreEnv();
  }
});

test('zhihu chain: the passive interceptor path binds the image-preserving converter (lockstep)', async () => {
  // 生产行为先于源码 pin：真实数据 + 真实转换器配对（文章 + 回答两条路）。
  await withZhihuPageDom('https://zhuanlan.zhihu.com/p/1', {}, async () => {
    const article = zhihuCs.extractZhihuArticle(
      { id: 1, title: 'T', content: ZHIHU_API_HTML, author: { name: 'A' } }, zhihuCs.htmlToArticleText);
    assert.match(article.text, /!\[\]\(https:\/\/picx\.zhimg\.com\/v2-real_r\.jpg\?source=1\)/,
      '被动拦截的文章路径同样保图');
    const answers = zhihuCs.extractZhihuAnswers(
      { data: [{ id: 9, content: '<p>答</p><img src="https://pic1.zhimg.com/v2-ans_r.jpg">', author: { name: 'U' }, voteup_count: 1, question: { id: 500, title: 'Q' } }] },
      zhihuCs.htmlToArticleText);
    assert.match(answers.answers[0].text, /!\[\]\(https:\/\/pic1\.zhimg\.com\/v2-ans_r\.jpg\)/,
      '回答正文里的图同样保图');
  });
  // 源码 lockstep pin：extractZhihuArticle/Answers 的 toText 是注入参数，上面的
  // 行为测试钉不住生产绑定本身——拦截器装配处必须绑图片保留转换器（退回纯文本
  // 剥离正是本回归的形状；源码 pin 用仓库惯例的正则锁行）。
  const fs = require('node:fs');
  const csSrc = fs.readFileSync(
    fileURLToPath(new URL('../lib/content-scripts/zhihu-content-script.js', import.meta.url)), 'utf8');
  assert.match(csSrc, /const toText = htmlToArticleText;/,
    'installZhihuInterceptor 的 toText 闭包必须绑 htmlToArticleText');
});

// ── 掘金 / 极客时间 / 雪球（2026-10-15 姊妹批：同一条 [图N] 管线接通）─────────
//
// 三家都是被动拦截路径：真实推送消息（sender.tab.id 落缓存）→ SITE_CACHES →
// synthesizeSiteCache（域门）→ ATTACH_PAGE 落库。掘金极客时间雪球图床实测均无
// Referer 门 → dnrCalls 恒 0。

test('juejin attach: markContent markdown figures ride the entry, byteimg needs no DNR gate', async () => {
  const tabId = addTab(31, 'https://juejin.cn/post/7496397558359162934', '掘金文章');
  await handle({
    type: 'JUEJIN_ARTICLE',
    article: {
      title: '掘金文章', author: '作者', articleId: '7496397558359162934',
      markContent: '正文。\n\n![image.png](https://p6-xtjj-sign.byteimg.com/tos-cn-i-xxx/a~tplv.awebp?rk3s=x&x-expires=1&x-signature=y)\n\n完。',
      rawAt: Date.now(),
    },
  }, { tab: { id: tabId } });
  const restoreEnv = installFigureEnv();
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, res.error || '');
    assert.equal(res.ctx.mode, 'juejin');
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content), '掘金配图必须随条目入库');
    assert.deepEqual(entry.content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QkQ=' } });
    assert.match(entry.content[0].text, /\[图1\]/);
    assert.ok(!entry.content[0].text.includes('byteimg.com'), '锚点替换后签名 URL 不残留');
    assert.equal(dnrCalls.length, 0, 'byteimg 签名即鉴权，不碰 DNR');
  } finally { restoreEnv(); }
});

test('geektime chain: real maybeExtractGeektime (real converter) → push → cache → storage carries the figure', async () => {
  // 第 1 段：真实提取函数（jsdom 只供 DOM；geektime 图是协议相对 URL）。
  const geekCs = require(fileURLToPath(new URL('../lib/content-scripts/geektime-content-script.js', import.meta.url)));
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const prevDoc = globalThis.document;
  globalThis.document = dom.window.document;
  let extracted;
  try {
    extracted = geekCs.maybeExtractGeektime('https://time.geekbang.org/serv/v1/article', {
      code: 0,
      data: { article_info: { article_id: 100, article_title: '极客时间文章', article_summary: '摘要',
        article_content: '<p>正文。</p><img src="//static001.geekbang.org/resource/image/51/5d/abc.jpg"><p>完。</p>',
        author_name: '作者' } },
    }, geekCs.htmlToArticleText);
  } finally { globalThis.document = prevDoc; }
  assert.ok(extracted, 'maybeExtractGeektime 必须出结果');
  assert.match(extracted.text, /!\[\]\(\/\/static001\.geekbang\.org\/resource\/image\/51\/5d\/abc\.jpg\)/,
    '真实转换器保留课程配图（协议相对 URL 原样）');

  // 第 2 段：提取结果走真实推送 → 缓存 → ATTACH_PAGE（协议相对按页面 base 绝对化）。
  const tabId = addTab(32, 'https://time.geekbang.org/column/article/100', '极客时间文章');
  await handle({ type: 'GEEKTIME_ARTICLE', article: extracted }, { tab: { id: tabId } });
  const seenUrls = [];
  const restoreEnv = installFigureEnv();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seenUrls.push(String(url)); return prevFetch(url); };
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, res.error || '');
    assert.equal(res.ctx.mode, 'geektime');
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content), '极客时间配图必须随条目入库');
    assert.deepEqual(entry.content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QkQ=' } });
    assert.ok(seenUrls.some((u) => u === 'https://static001.geekbang.org/resource/image/51/5d/abc.jpg'),
      '协议相对 URL 按 baseUrl 绝对化后下载');
    assert.equal(dnrCalls.length, 0, 'geekbang 图床无门，不碰 DNR');
  } finally { globalThis.fetch = prevFetch; restoreEnv(); }
});

test('xueqiu chain: real extractXueqiuPost → push → cache → storage carries the pics', async () => {
  // 第 1 段：真实提取函数（纯正则，无需 DOM）。
  const xqCs = require(fileURLToPath(new URL('../lib/content-scripts/xueqiu-content-script.js', import.meta.url)));
  const post = xqCs.extractXueqiuPost({
    status: {
      id: 223456, title: '', user: { screen_name: '雪球用户' }, like_count: 9, reply_count: 1,
      text: '<p>看好逻辑不变。</p><img src=\"//xqimg.imedao.com/inline0.png\">',
      image_info_list: [{ filename: '17pic1.png' }, { filename: '17pic2.jpg' }],
    },
  });
  assert.ok(post, 'extractXueqiuPost 必须出结果');
  assert.match(post.text, /!\[\]\(\/\/xqimg\.imedao\.com\/inline0\.png\)/);
  assert.match(post.text, /!\[\]\(https:\/\/xqimg\.imedao\.com\/17pic1\.png\)/);
  assert.match(post.text, /!\[\]\(https:\/\/xqimg\.imedao\.com\/17pic2\.jpg\)/);

  // 第 2 段：真实推送 → 缓存 → ATTACH_PAGE（3 张图全部入库）。
  const tabId = addTab(33, 'https://xueqiu.com/1234567890/2234567890', '雪球帖子');
  await handle({ type: 'XUEQIU_DATA', data: post }, { tab: { id: tabId } });
  const restoreEnv = installFigureEnv();
  dnrCalls.length = 0;
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true, res.error || '');
    assert.equal(res.ctx.mode, 'xueqiu');
    const entry = await lastEntry();
    assert.ok(Array.isArray(entry.content));
    const imgParts = entry.content.filter((p) => p?.type === 'image_url');
    assert.equal(imgParts.length, 3, '内联 1 张 + image_info_list 2 张全入库');
    assert.equal(dnrCalls.length, 0, 'xqimg 无门（未实测到真图，fail-open 兜底），不碰 DNR');
  } finally { restoreEnv(); }
});

// ── X syndication 兜底（2026-10-16 登录墙报告）─────────────────────────────
// 用户实测：X 推文页本地提取为空时，auto 曾静默落到 r.jina.ai——匿名服务端
// 抓取只拿得到 X 的登录墙（Log in/Sign up 全是噪声），图片也丢。修复：
// tryXActiveFallback 在页内路径拿不到时改走免鉴权的 syndication 端点（X 自家
// embed 数据源，全文/作者/计数/mediaDetails 原图 URL）；explicit jina 模式在
// 推文 URL 上同样先走本站路径。本节三条接线：级联兜底、jina 抢占、404
// fail-open。token 公式用字面量钉死（react-tweet 同款 (id/1e15)*π 六进制去
// 零——真实端点校验它，测试改坏公式即红）。照片 bytes 在 Node 无 canvas 环境
// fail-open 为空 → photos 保持 [图N] URL 行（与页内路径 URL-only 同形状），
// 字节随行本身由上方「X active-fallback」用例钉住。

const SYND_URL = 'https://cdn.syndication.twimg.com/tweet-result?id=123456&token=52255123252515451&lang=zh';
const SYND_PAYLOAD = (() => {
  const text = '太傻逼了，实在看不下去了。\n\n这就是我为什么说北大清华50%的教授都是大傻逼的根本原因。 https://t.co/3acKIMMgsK';
  return {
    __typename: 'Tweet',
    id_str: '123456',
    text,
    display_text_range: [0, 44],
    favorite_count: 165,
    conversation_count: 23,
    lang: 'zh',
    created_at: '2026-10-15T22:44:23.000Z',
    user: { name: 'lidang 立党', screen_name: 'lidangzzz' },
    mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/HUtL-cUWQAAXT-W.jpg' }],
  };
})();

function stubXFetch({ syndStatus = 200, jinaText = null } = {}) {
  const prev = { fetch: globalThis.fetch };
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url) === SYND_URL) {
      if (syndStatus !== 200) return { ok: false, status: syndStatus };
      return { ok: true, status: 200, json: async () => SYND_PAYLOAD };
    }
    if (/pbs\.twimg\.com\/media/.test(String(url))) {
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)], { type: 'image/jpeg' }) };
    }
    if (/r\.jina\.ai/.test(String(url))) {
      if (jinaText == null) throw new Error('r.jina.ai must not be reached in this test');
      return { ok: true, status: 200, text: async () => jinaText };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  return { fetched, restore: () => { globalThis.fetch = prev.fetch; } };
}

test('X syndication fallback: dead page state still yields the clean tweet (auto/dom cascade)', async () => {
  const tabId = addTab(21, 'https://x.com/lidangzzz/status/123456', 'Tweet');
  scriptQueue = [null]; // activeXFetch 拿不到（登出页 state 缺失 / DOM 未渲染）
  const stub = stubXFetch();
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'dom' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    assert.equal(res.ctx.mode, 'twitter', 'the syndication synthesizer owns this ctx');
    const entry = await lastEntry();
    const text = typeof entry.content === 'string' ? entry.content : entry.content[0].text;
    assert.match(text, /太傻逼了，实在看不下去了/, 'the authoritative tweet text must ride');
    assert.match(text, /lidang 立党 @lidangzzz/);
    assert.match(text, /\[图1\] https:\/\/pbs\.twimg\.com\/media\/HUtL-cUWQAAXT-W\.jpg\?name=large/,
      'photo rides as an [图N] URL line when bytes fail open (Node has no canvas)');
    assert.ok(!text.includes('t.co/3acKIMMgsK'), 'the trailing t.co link must be trimmed');
    assert.ok(stub.fetched.includes(SYND_URL), 'the syndication URL (incl. pinned token) must be requested');
  } finally { stub.restore(); }
});

test('X syndication fallback: explicit jina mode on a tweet URL prefers the site path, never reaches r.jina.ai', async () => {
  const tabId = addTab(22, 'https://x.com/lidangzzz/status/123456', 'Tweet');
  scriptQueue = [null];
  const stub = stubXFetch();
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    assert.equal(res.ctx.mode, 'twitter', 'site path wins over the jina proxy for tweet URLs');
    const entry = await lastEntry();
    const text = typeof entry.content === 'string' ? entry.content : entry.content[0].text;
    assert.match(text, /太傻逼了，实在看不下去了/);
    assert.ok(stub.fetched.every((u) => !/r\.jina\.ai/.test(u)),
      'the login-wall proxy must never fire when the site path succeeded');
  } finally { stub.restore(); }
});

test('X syndication fallback: endpoint 404 fails open into jina (preemption must not strand the user)', async () => {
  const tabId = addTab(23, 'https://x.com/lidangzzz/status/123456', 'Tweet');
  scriptQueue = [null];
  const WALL = '# 登录墙占位文本\n\nLog in — Sign up';
  const stub = stubXFetch({ syndStatus: 404, jinaText: WALL });
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'jina' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    assert.equal(res.ctx.mode, 'jina', 'with the site path empty, jina still serves');
    const entry = await lastEntry();
    const text = typeof entry.content === 'string' ? entry.content : entry.content[0].text;
    assert.match(text, /登录墙占位文本/);
  } finally { stub.restore(); }
});

test('X syndication fallback: a SHORT tweet in auto mode must NOT fall through to jina (<200 chars is legitimate)', async () => {
  // 用户抓到的残余 bug：短推文经 syndication 合成后 ~150 字符，auto 的
  // 「<200 视为提取失败」回退曾把它误判、拿更长的 jina 登录墙顶掉权威数据。
  // siteSynthesized 标记（makeSynthResult）让 auto 回退跳过站点产物。
  const tabId = addTab(24, 'https://x.com/lidangzzz/status/123456', 'Tweet');
  scriptQueue = [null];
  const stub = stubXFetch(); // r.jina.ai 在此 stub 里被触及即 throw
  try {
    const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
    assert.equal(res.ok, true);
    assert.equal(res.ctx.mode, 'twitter');
    assert.ok((res.ctx.text || '').length < 200, 'this synthesized tweet is genuinely short');
    assert.match(res.ctx.text, /太傻逼了，实在看不下去了/);
    assert.ok(stub.fetched.every((u) => !/r\.jina\.ai/.test(u)),
      'a site-synthesized short result must never trigger the auto jina fallback');
  } finally { stub.restore(); }
});
