// test/attach-page-images.test.mjs — ATTACH_PAGE 页面配图内联的接线测试：走真实
// background.js 的 jina 分支（无需 mock DOM 提取），验证带图 Markdown 入库后是
// [图N] 真交错的多模态 content 数组、失败图保留原文、全失败回退纯字符串 content。

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    _set(obj) { store = { ...store, ...obj }; },
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
    get: async () => ({ id: 1, url: 'https://example.com/post/a', title: 'Test', favIconUrl: '' }),
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
    executeScript: async () => [{ result: null }],
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

// 解码环境 stub（Node 无 createImageBitmap/OffscreenCanvas）
globalThis.createImageBitmap = async (blob) => ({ width: blob._w || 0, height: blob._h || 500, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { fillRect() {}, drawImage() {} }; }
  async convertToBlob() { return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }); }
};

const bg = await import('../background.js');
const { handle } = bg;

const JINA_MD = [
  '文章开头。',
  '![图表一](https://cdn.example.com/1.png)',
  '中间一段。',
  '![死链](https://cdn.example.com/dead.png)',
  '结尾。',
].join('\n');

test('jina attach with images: content becomes an interleaved array with [图N] anchors and the note', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://r.jina.ai/')) {
        return { ok: true, status: 200, text: async () => JINA_MD };
      }
      if (u === 'https://cdn.example.com/1.png') {
        return { ok: true, status: 200, blob: async () => ({ size: 1000, type: 'image/png', _w: 900, _h: 600 }) };
      }
      return { ok: false, status: 404 };
    };
    const res = await handle({
      type: 'ATTACH_PAGE', tabId: 7, mode: 'jina',
    }, { tab: { id: 7 } });
    assert.equal(res.ok, true);

    const { history } = await localArea.get('history');
    const entry = history[history.length - 1];
    assert.ok(Array.isArray(entry.content), '有配图 → content 是交错数组');
    // 锚点把正文切成 [text, image_url, text]：全部 text 部件拼起来做内容断言。
    const textAll = entry.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    assert.equal(entry.content.filter((b) => b.type === 'image_url').length, 1);
    assert.match(textAll, /\[图1\] 图表一/, '成功图原位替换为锚点行');
    assert.match(textAll, /!\[死链\]\(https:\/\/cdn\.example\.com\/dead\.png\)/, '失败图保留 Markdown');
    assert.match(textAll, /（文中 \[图N\] 标记按顺序对应随附的 1 张页面配图/, '对应关系说明随文入库');
    const imgPart = entry.content.find((b) => b.type === 'image_url');
    assert.match(imgPart.image_url.url, /^data:image\/jpeg;base64,/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('jina attach, all image downloads fail: plain string content (unchanged shape)', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://r.jina.ai/')) {
        return { ok: true, status: 200, text: async () => JINA_MD };
      }
      return { ok: false, status: 404 };
    };
    const res = await handle({
      type: 'ATTACH_PAGE', tabId: 8, mode: 'jina',
    }, { tab: { id: 8 } });
    assert.equal(res.ok, true);

    const { history } = await localArea.get('history');
    const entry = history[history.length - 1];
    assert.equal(typeof entry.content, 'string', '全失败 → 保持纯字符串 content');
    assert.doesNotMatch(entry.content, /\[图1\]/);
    assert.doesNotMatch(entry.content, /页面配图/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
