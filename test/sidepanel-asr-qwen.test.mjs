// test/sidepanel-asr-qwen.test.mjs — 千问供应商端到端（真实 sidepanel.js + jsdom）：
// 视频精读 = getPolicy（视频绑视觉模型、音频绑 Omni 转写模型）→ OSS POST →
// chat/completions 两段（Omni 转写 + 视觉注解）→ 合并入库；音频转写 = 单上传 +
// 单段 Omni 转写。结构与 test/lib-sidepanel-asr-video.test.mjs 同款。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/sidepanel.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.location = dom.window.location;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// decodeAudioData mock：4s 音频（与视频等长，完整性校验放行）
globalThis.OfflineAudioContext = class {
  constructor(channels, frames, sampleRate) {
    this.channels = channels; this.frames = frames; this.sampleRate = sampleRate;
  }
  async decodeAudioData() {
    const srcRate = 48000;
    const seconds = 4;
    const length = srcRate * seconds;
    return {
      sampleRate: srcRate, length, numberOfChannels: 1,
      getChannelData: () => new Float32Array(length),
    };
  }
  async close() {}
};

const MB = 1024 * 1024;
let sent = [];
let confirmed = null;
let downloads = [];
let policies = [];      // { model }
let ossUploads = [];    // { fieldOrder, key, filename }
let chatBodies = [];    // 两段 chat/completions 请求体
let dnrRules = 0;
let dnrRemoved = 0;

const TRANSCRIPT_TEXT = '[00:01] [说话人1] 欢迎收看本期节目。\n[00:03] [说话人2] 谢谢主持人。\n[00:04] [说话人2] 我们开始吧。';
const VISUAL_TEXT = [
  '[改名] [说话人2] → [说话人：小林]',
  '[00:00] 画面：节目片头 logo',
  '[00:02] 画面：本期主题字幕「AI 投资」',
  '[00:02] [截屏] 本期主题',
].join('\n');

const sse = (items) => items
  .map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`)
  .join('');

const DELTA = (content) => ({ choices: [{ delta: { content }, finish_reason: null }] });
const SSE_OK = (text) => sse([DELTA(text), { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);

function sseResponse(text) {
  const enc = new TextEncoder();
  const chunk = enc.encode(text);
  let sentFlag = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sentFlag
          ? { done: true, value: undefined }
          : ((sentFlag = true), { done: false, value: chunk })),
      }),
    },
    text: async () => text,
  };
}

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('bilivideo.com/video/301.m4s')) {
    downloads.push({ url: u });
    return { ok: true, blob: async () => new Blob([new Uint8Array(200 * 1024)], { type: 'video/mp4' }) };
  }
  if (u.includes('bilivideo.com/audio/192.m4s')) {
    downloads.push({ url: u });
    return { ok: true, blob: async () => new Blob([new Uint8Array(1100 * 1024)]) };
  }
  if (u.includes('/uploads?action=getPolicy')) {
    policies.push({ model: new URL(u).searchParams.get('model') });
    return {
      ok: true, status: 200,
      json: async () => ({
        request_id: 'r1',
        data: {
          policy: 'POLICY', signature: 'SIG',
          upload_dir: 'dashscope-instant/uploads/abc',
          upload_host: 'https://dashscope-file.oss-cn-beijing.aliyuncs.com',
          oss_access_key_id: 'OSS-AK',
          x_oss_object_acl: 'private',
          x_oss_forbid_overwrite: 'true',
        },
      }),
    };
  }
  if (u.startsWith('https://dashscope-file.oss-cn-beijing.aliyuncs.com')) {
    const fd = init?.body;
    ossUploads.push({
      fieldOrder: [...fd.keys()],
      key: fd.get('key'),
      filename: fd.get('file')?.name || '',
    });
    return { ok: true, status: 200, text: async () => '' };
  }
  if (u.endsWith('/chat/completions')) {
    chatBodies.push(JSON.parse(init.body));
    return sseResponse(SSE_OK(chatBodies.length === 1 ? TRANSCRIPT_TEXT : VISUAL_TEXT));
  }
  throw new Error('unexpected fetch: ' + u);
};

const attachCtx = {
  meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
  mode: 'asr-pending',
  audioUrl: 'https://bilivideo.com/audio/192.m4s',
  audioCandidates: [{ url: 'https://bilivideo.com/audio/192.m4s', label: '192 kbps', bandwidth: 192000, size: 96 * 1024, duration: 4, codecs: 'mp4a.40.2', id: 30216 }],
  videoCandidates: [
    { url: 'https://bilivideo.com/video/301.m4s', label: '1920x1080', bandwidth: 2000000, size: 100 * MB, duration: 4, height: 1080, id: 80 },
  ],
  videoDurationSec: 4,
  biliCookie: 'buvid3=test-buvid; b_nut=12345',
  noTranscript: true,
  text: 'bilibili plain text fallback',
  asr: {
    provider: 'qwen',
    apiKey: 'sk-qwen-test',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.5-omni-flash',
    videoModel: 'qwen3.8-flash',
    language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000, subtitleSource: 'original',
  },
};

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }],
    get: async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: { executeScript: async () => { throw new Error('must not use executeScript'); } },
  declarativeNetRequest: {
    updateSessionRules: async (opts) => {
      if (opts.addRules?.length) dnrRules++;
      if (opts.removeRuleIds?.length) dnrRemoved += opts.removeRuleIds.length;
    },
  },
  runtime: {
    id: 'test-extension-id',
    connect: () => ({ name: '', sent: [], onMessage: { addListener: () => {}, removeListener: () => {} }, onDisconnect: { addListener: () => {} }, postMessage: () => {}, disconnect: () => {} }),
    sendMessage: (msg, cb) => {
      sent.push(msg.type);
      if (msg.type === 'GET_CONFIG') { cb({ data: {} }); return; }
      if (msg.type === 'STREAM_PEEK') { cb({ inFlight: false }); return; }
      if (msg.type === 'ATTACH_PAGE') {
        cb({ ok: true, data: { ok: true, ctx: attachCtx } });
        return;
      }
      if (msg.type === 'ATTACH_ASR_CONFIRM') { confirmed = msg; cb({ ok: true, data: { ok: true } }); return; }
      cb({ ok: true });
    },
    lastError: undefined,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
    session: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const attachBtn = document.getElementById('attach');
const messagesEl = document.getElementById('messages');

function resetState() {
  sent = []; confirmed = null; downloads = []; policies = []; ossUploads = []; chatBodies = [];
  dnrRules = 0; dnrRemoved = 0;
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('qwen video mode: 双上传按模型绑定（视频→视觉系 / 音频→Omni）、两段精读合并入库', async () => {
  resetState();
  attachBtn.click();
  await waitFor(() => document.querySelector('.asr-mode-card'));
  document.querySelectorAll('.asr-mode-btn')[1].click(); // 视频精读
  await waitFor(() => confirmed && ossUploads.length === 2, 9000);

  // 上传：getPolicy 分别绑定消费方模型；OSS 表单 file 最后；oss:// key 带语义文件名
  assert.deepEqual(policies.map((p) => p.model), ['qwen3.8-flash', 'qwen3.5-omni-flash'],
    '先视频（绑视觉模型）后音频（绑 Omni 转写模型）');
  assert.deepEqual(ossUploads[0].fieldOrder, ['OSSAccessKeyId', 'Signature', 'policy', 'key', 'x-oss-object-acl', 'x-oss-forbid-overwrite', 'success_action_status', 'file']);
  assert.match(ossUploads[0].key, /^dashscope-instant\/uploads\/abc\/browsa-bili-BV1xx411c7mD-p1-video\.mp4$/);
  assert.match(ossUploads[1].key, /audio\.wav$/);

  // 两段 chat/completions：①Omni 读音频 ②视觉系看画面（带解析头）
  assert.equal(chatBodies.length, 2);
  assert.equal(chatBodies[0].model, 'qwen3.5-omni-flash');
  assert.equal(chatBodies[0].messages[1].content[0].type, 'input_audio');
  assert.equal(chatBodies[1].model, 'qwen3.8-flash');
  assert.equal(chatBodies[1].messages[1].content[0].video_url.url, 'oss://dashscope-instant/uploads/abc/browsa-bili-BV1xx411c7mD-p1-video.mp4');
  assert.equal(chatBodies[1].messages[1].content[0].video_url.fps, 2, '4 秒短视频 → fps 上限 2');
  assert.match(chatBodies[1].messages[1].content[1].text, /bilibili plain text fallback/, '元信息（命名先验）随视觉任务下发');

  // 入库：转写主干 + 画面行 + 改名 + [图N] 锚点；无残留截屏标记、无视觉通道复述
  assert.match(confirmed.text, /## 视听精读（视频解析）/);
  assert.match(confirmed.text, /\[00:01\] \[说话人1\] 欢迎收看本期节目。/);
  assert.match(confirmed.text, /\[00:00\] 画面：节目片头 logo/);
  assert.match(confirmed.text, /\[00:03\] \[说话人：小林\] 谢谢主持人。/, '视觉通道的改名指令应用到转写行');
  assert.match(confirmed.text, /\[00:02\] \[图1\] 本期主题/);
  assert.doesNotMatch(confirmed.text, /\[截屏\]/);
  assert.doesNotMatch(confirmed.text, /\[改名\]/);
  assert.equal(confirmed.format, 'bilibili-video');
  assert.ok(dnrRules >= 1 && dnrRemoved >= 1, 'DNR rule registered and removed');
  await waitFor(() => !attachBtn.disabled);
});

test('qwen audio mode: 单上传（绑 Omni）+ 单段转写，产出字幕段', async () => {
  resetState();
  attachBtn.click();
  await waitFor(() => document.querySelector('.asr-mode-card'));
  document.querySelectorAll('.asr-mode-btn')[0].click(); // 音频转写
  await waitFor(() => confirmed && ossUploads.length === 1, 9000);

  assert.deepEqual(downloads.map((d) => d.url.includes('/video/') ? 'video' : 'audio'), ['audio']);
  assert.deepEqual(policies.map((p) => p.model), ['qwen3.5-omni-flash'], '音频文件绑转写模型');
  assert.equal(chatBodies.length, 1);
  assert.equal(chatBodies[0].model, 'qwen3.5-omni-flash');
  assert.equal(chatBodies[0].messages[1].content[0].input_audio.format, 'wav');
  assert.match(confirmed.text, /## 字幕（ASR）/);
  assert.match(confirmed.text, /\[00:01\] \[说话人1\] 欢迎收看本期节目。/);
  assert.equal(confirmed.format, undefined);
  await waitFor(() => !attachBtn.disabled);
});
