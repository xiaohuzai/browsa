// test/attach-site-images.test.mjs — 站点字节图（ctx.imageBase64List）落库接线测试。
//
// 2026-10-11 用户报告「小红书图文笔记只有文字」暴露的断线：v0.20.0 把 MAIN world
// 取到的字节随 CHAT 消息的 pageContext 进请求；v0.21.0 请求组装搬进 history 重建后
// 这根线死了——每次附加提取到的字节在落库时被丢，而 buildMessages 里自称 XHS 图片
// 通道的 pageContext 分支是死代码。#223 重做提取侧时也没接回发送侧。
//
// 本文件是这条链的**落库半段**地板：四条站点路径（XHS XHR 快路径 / XHS
// INITIAL_STATE 慢路径 / X active fallback / Reddit active fallback）全部走真实
// background.js 的 handle()，钉「字节必须随 attach 条目入库为 [text, ...image_url]
// 多模态 content」（interleaveImageParts 无锚点兜底形状）。**请求半段**（带图条目
// 必须到达每家 provider 的请求体）钉在 test/chat-rebuild-channels.test.mjs 的
// "attach-entry images reach the wire" 节——两文件以同一条目形状对接，任一侧漂移
// 都会红。全失败回退纯字符串形状也在此钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

const chromeMock = {
  runtime: {
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
