// test/attach-asr-confirm-figures.test.mjs — ATTACH_ASR_CONFIRM 的关键帧截图
// 入库路径：figureImages（{url, caption}）→ Figures captions 段 + 多模态 content
// 数组（text 块在前、image_url 块按序跟随，镜像 ATTACH_PDF_CONFIRM）；无截图时
// 保持纯字符串 content + videoSrc 戳（可点击时间戳的载体）。harness 复制自
// test/attach-pdf-confirm.test.mjs（真实 background.js + chrome mock）。

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

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

const localArea = makeStorageArea();
const sessionArea = makeStorageArea();

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined,
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://www.bilibili.com/video/BV1test', title: 'T' }],
    get: async () => ({ id: 1, url: 'https://www.bilibili.com/video/BV1test', title: 'T', favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: { executeScript: async () => { throw new Error('not used by ASR confirm'); } },
  storage: { onChanged: { addListener: () => {} }, local: localArea, session: sessionArea },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
  declarativeNetRequest: { updateSessionRules: async () => {} },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

const bg = await import('../background.js');
const { handle } = bg;

function lastEntry() {
  const history = localArea._dump().history || [];
  return history[history.length - 1];
}

test('ATTACH_ASR_CONFIRM: keyframes become a caption-anchored multimodal entry with videoSrc', async () => {
  const res = await handle({
    type: 'ATTACH_ASR_CONFIRM',
    text: '视频元信息\n\n## 视听精读（视频解析）\n\n[00:05] [截屏] 图表一\n[01:20] 正文',
    metaUrl: 'https://www.bilibili.com/video/BV1test',
    metaTitle: '测试视频',
    platform: 'bilibili',
    tabId: 42,
    format: 'bilibili-video',
    figureImages: [
      { url: 'data:image/jpeg;base64,AAA', caption: '图表一' },
      { url: 'data:image/jpeg;base64,BBB', caption: null },
    ],
  }, {});
  assert.equal(res.ok, true);
  const entry = lastEntry();
  assert.ok(Array.isArray(entry.content), 'figures present -> multimodal content array');
  assert.equal(entry.content[0].type, 'text');
  assert.match(entry.content[0].text, /## 视听精读（视频解析）/);
  // Figures captions 段：模型把「截图 N」与按序 image_url 块一一对应
  assert.match(entry.content[0].text, /## Figures/);
  assert.match(entry.content[0].text, /1\. 图表一/);
  assert.match(entry.content[0].text, /2\. Keyframe 2/, '无 caption 回退到序号标签');
  const imgs = entry.content.filter((b) => b.type === 'image_url');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].image_url.url, 'data:image/jpeg;base64,AAA');
  assert.equal(imgs[1].image_url.url, 'data:image/jpeg;base64,BBB');
  // videoSrc 戳（可点击时间戳跳转的载体）不受多模态数组影响
  assert.deepEqual(entry.videoSrc, { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1test', tabId: 42 });
});

test('ATTACH_ASR_CONFIRM without keyframes keeps the plain-string content shape', async () => {
  const res = await handle({
    type: 'ATTACH_ASR_CONFIRM',
    // 段落标题（## 字幕（ASR））由 sidepanel 拼在 text 里，handler 原样存储
    text: 'B站元信息\n\n## 字幕（ASR）\n\n[00:00] 纯音频字幕',
    metaUrl: 'https://www.bilibili.com/video/BV1test',
    metaTitle: '测试视频',
    platform: 'bilibili',
    tabId: 7,
  }, {});
  assert.equal(res.ok, true);
  const entry = lastEntry();
  assert.equal(typeof entry.content, 'string', 'no figures -> plain-string content (history shape unchanged)');
  assert.match(entry.content, /## 字幕（ASR）/);
  assert.match(entry.content, /B站元信息/);
  assert.deepEqual(entry.videoSrc, { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1test', tabId: 7 });
});
