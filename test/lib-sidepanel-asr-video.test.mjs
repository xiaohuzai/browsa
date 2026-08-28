// test/lib-sidepanel-asr-video.test.mjs — 视频解析（视听精读）端到端：真实
// sidepanel.js + jsdom，模拟 asr-pending ctx 带 videoCandidates（B站 DASH 分离流）。
// 验证：模式选择卡出现（音频/视频两个选项 + 预估体积）→ 点「视频精读」→ 视频/音频
// 双下载、双上传（video.mp4 + audio.wav，purpose=user_data）、双轮询、/responses
// 带 input_video+input_audio 组合 → ATTACH_ASR_CONFIRM 带「视听精读（视频解析）」
// 段与 format=bilibili-video。另覆盖：点「音频转写」走单文件旧管线；卡片被清掉
//（会话切换）时静默取消（按钮恢复、无上传、无入库）。

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

// decodeAudioData mock: 4s @48k → resample 后 WAV 时长 4s（≥ 90% of videoDurationSec 4s，
// 截断校验放行）。
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
let downloads = [];   // { url }
let uploads = [];     // { name, size, purpose }
let polledIds = [];
let responsesBodies = [];
let dnrRules = 0;
let dnrRemoved = 0;

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
  if (u.endsWith('/files')) {
    const f = init?.body?.get?.('file');
    uploads.push({ name: (f && f.name) || '', size: (f && f.size) || 0, purpose: init?.body?.get?.('purpose') || '' });
    const id = uploads.length === 1 ? 'file-vid' : 'file-aud';
    return { ok: true, json: async () => ({ id, bytes: (f && f.size) || 0 }) };
  }
  if (u.endsWith('/files/file-vid') || u.endsWith('/files/file-aud')) {
    polledIds.push(u.slice(u.lastIndexOf('/') + 1));
    return { ok: true, json: async () => ({ status: 'completed' }) };
  }
  if (u.endsWith('/responses')) {
    responsesBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        id: 'resp_1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
          text: '[00:00] 大家好\n[00:01] 画面：标题卡片\n[00:01] [截屏] 标题卡片画面\n[00:04] 欢迎收看' }] }],
      }),
    };
  }
  throw new Error('unexpected fetch: ' + u);
};

const attachCtx = {
  meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
  mode: 'asr-pending',
  audioUrl: 'https://bilivideo.com/audio/192.m4s',
  audioCandidates: [{ url: 'https://bilivideo.com/audio/192.m4s', label: '192 kbps', bandwidth: 192000, size: 96 * 1024, duration: 4, codecs: 'mp4a.40.2', id: 30216 }],
  videoCandidates: [
    { url: 'https://bilivideo.com/video/big.m4s', label: '3840x2160', bandwidth: 9000000, size: 900 * MB, duration: 4, height: 2160, id: 120 },
    { url: 'https://bilivideo.com/video/301.m4s', label: '1920x1080', bandwidth: 2000000, size: 100 * MB, duration: 4, height: 1080, id: 80 },
  ],
  videoDurationSec: 4,
  biliCookie: 'buvid3=test-buvid; b_nut=12345',
  noTranscript: true,
  text: 'bilibili plain text fallback',
  asr: { apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000, subtitleSource: 'original' },
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
      if (opts.addRules?.length) { dnrRules++; assert.equal(opts.addRules[0].condition.urlFilter, 'bilivideo'); }
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
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
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
  sent = []; confirmed = null; downloads = []; uploads = []; polledIds = []; responsesBodies = [];
  dnrRules = 0; dnrRemoved = 0;
  // 恢复 ctx 基线（个别测试会改 noTranscript/text）
  attachCtx.noTranscript = true;
  attachCtx.text = 'bilibili plain text fallback';
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('video mode: card shows both options, picking 视频精读 runs dual download/upload and stores the 精读 doc', async () => {
  attachBtn.click();
  // 模式卡出现，两个选项带预估体积；超预算的 4K 流已被排除（选 1080p）
  await waitFor(() => document.querySelector('.asr-mode-card'));
  const card = document.querySelector('.asr-mode-card');
  const btns = card.querySelectorAll('.asr-mode-btn');
  assert.equal(btns.length, 2);
  assert.match(btns[0].textContent, /音频转写（字幕）/);
  assert.match(btns[0].textContent, /快/);
  assert.match(btns[1].textContent, /视频精读（画面＋语音）/);
  assert.match(btns[1].textContent, /1920x1080/, '预算内最高画质（900MB 的 4K 流被排除）');
  assert.match(btns[1].textContent, /约 100MB/);

  btns[1].click(); // 视频精读
  await waitFor(() => confirmed && uploads.length === 2, 9000);

  // 双下载（视频流 + 音频流）、双上传（video.mp4 + audio.wav，purpose=user_data）
  assert.deepEqual(downloads.map((d) => d.url.includes('/video/') ? 'video' : 'audio').sort(), ['audio', 'video']);
  assert.equal(uploads[0].name, 'video.mp4');
  assert.equal(uploads[0].purpose, 'user_data');
  assert.equal(uploads[1].name, 'audio.wav');
  assert.deepEqual(polledIds.sort(), ['file-aud', 'file-vid']);

  // /responses 单请求组合 input_video + input_audio，模型回退用转写模型
  assert.equal(responsesBodies.length, 1);
  const parts = responsesBodies[0].input[0].content.map((c) => c.type);
  assert.deepEqual(parts, ['input_video', 'input_audio', 'input_text']);
  assert.equal(responsesBodies[0].input[0].content[0].file_id, 'file-vid');
  assert.equal(responsesBodies[0].input[0].content[1].file_id, 'file-aud');
  assert.equal(responsesBodies[0].model, 'm', 'videoModel 留空回退转写模型');

  // 入库：精读段标题 + format 标签 + 元信息保留；卡片已移除
  assert.match(confirmed.text, /## 视听精读（视频解析）/);
  assert.match(confirmed.text, /\[00:01\] 画面：标题卡片/);
  assert.match(confirmed.text, /bilibili plain text fallback/);
  assert.equal(confirmed.format, 'bilibili-video');
  assert.equal(confirmed.platform, 'bilibili');
  // 截屏标记行保留在产物里；jsdom 没有 URL.createObjectURL → 抽帧 fail-open 返回
  // [] → confirm 不带 figureImages（真实浏览器里抽帧成功才走多模态入库）。
  assert.match(confirmed.text, /\[00:01\] \[截屏\] 标题卡片画面/);
  assert.equal(confirmed.figureImages, undefined);
  assert.ok(dnrRules >= 1 && dnrRemoved >= 1, 'DNR rule registered and removed');
  assert.ok(!document.querySelector('.asr-mode-card'), 'card removed after choice');
  await waitFor(() => !attachBtn.disabled);
});

test('video mode on a subtitled video strips the original ## 字幕 block', async () => {
  // 触发条件包含「有字幕但设置了优先 ASR」——精读把语音重新转写一遍，原字幕块不剥
  // 的话两份语音全量进上下文（2026-08-29 用户实测重复）。
  resetState();
  // 在 ctx 里塞一份 B站 AI 字幕（buildAsrPendingCtx 对有字幕视频的形态）
  attachCtx.noTranscript = false;
  attachCtx.text = 'bilibili plain text fallback\n\n## 字幕\n\n[00:00] 原字幕第一句\n[00:01] 原字幕第二句';
  attachBtn.click();
  await waitFor(() => document.querySelector('.asr-mode-card'), 3000, 'mode card');
  document.querySelectorAll('.asr-mode-btn')[1].click();
  // confirm 等待放宽：jsdom 下抽帧 fail-open 也要走完 4s metadata 超时才返回 []
  await waitFor(() => confirmed, 9000, 'ATTACH_ASR_CONFIRM');
  assert.match(confirmed.text, /## 视听精读（视频解析）/);
  assert.match(confirmed.text, /bilibili plain text fallback/, '视频元信息保留');
  assert.doesNotMatch(confirmed.text, /原字幕第一句/, '原字幕块必须被剥掉（精读已覆盖语音内容）');
  assert.doesNotMatch(confirmed.text, /## 字幕（ASR）/, '视频模式不产生音频字幕段');
});

test('audio mode: picking 音频转写 runs the legacy single-file pipeline', async () => {
  resetState();
  attachBtn.click();
  await waitFor(() => document.querySelector('.asr-mode-card'));
  document.querySelectorAll('.asr-mode-btn')[0].click();
  await waitFor(() => confirmed && uploads.length === 1);
  assert.deepEqual(downloads.map((d) => d.url.includes('/video/') ? 'video' : 'audio'), ['audio']);
  assert.equal(uploads[0].name, 'audio.wav');
  assert.deepEqual(responsesBodies[0].input[0].content.map((c) => c.type), ['input_audio', 'input_text']);
  assert.match(confirmed.text, /## 字幕（ASR）/);
  assert.equal(confirmed.format, undefined);
});

test('card removed without a choice (session switch) aborts silently', async () => {
  resetState();
  attachBtn.click();
  await waitFor(() => document.querySelector('.asr-mode-card'));
  messagesEl.innerHTML = ''; // 模拟会话切换重渲染
  await waitFor(() => !attachBtn.disabled);
  assert.equal(uploads.length, 0, 'no upload after abort');
  assert.equal(confirmed, null, 'no confirm after abort');
  assert.ok(!sent.includes('ATTACH_ASR_CONFIRM'));
});
