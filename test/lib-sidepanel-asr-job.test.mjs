// test/lib-sidepanel-asr-job.test.mjs — the side-panel half of the offscreen
// ASR contract. It proves the panel starts a durable job instead of running
// the download pipeline itself, and that re-attaching an existing job only
// re-subscribes (no second ASR_JOB_START, no second download/upload).

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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const localData = {};
const sessionData = {};
let sent = [];
let confirmed = null;
let startCalls = 0;
let attachCtx = null;
let loseStartResponse = false;

function areaFor(data) {
  return {
    get: async (key) => {
      if (key == null) return { ...data };
      if (typeof key === 'string') return { [key]: data[key] };
      const out = {};
      for (const k of key) out[k] = data[k];
      return out;
    },
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (key) => {
      if (Array.isArray(key)) for (const k of key) delete data[k];
      else delete data[key];
    },
  };
}

function jobMap() {
  return localData.browsaAsrJobs || (localData.browsaAsrJobs = {});
}

function makeDoneJob(jobId = 'job-existing') {
  const job = {
    jobId,
    key: `key-${jobId}`,
    assetId: 'bili-BV1xx411c7mD-p1',
    tabId: 1,
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    title: '测试视频',
    durationSec: 5,
    provider: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-audio-3.1-asr-flash-filetrans',
    language: 'zh',
    hotwords: '',
    status: 'done',
    phase: 'done',
    resultText: '[00:00] 后台结果\n[00:04] 第二行',
    audioBytes: 1234,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  };
  jobMap()[job.key] = job;
  return job;
}

globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: (p) => p,
    getManifest: () => ({ permissions: ['offscreen'] }),
    connect: () => ({
      name: '', sent: [],
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: (msg, cb) => {
      sent.push(msg.type);
      if (msg.type === 'GET_CONFIG') { cb({ data: {} }); return; }
      if (msg.type === 'STREAM_PEEK') { cb({ ok: true, data: { inFlight: false } }); return; }
      if (msg.type === 'ATTACH_PAGE') {
        cb({ ok: true, data: { ok: true, ctx: attachCtx } });
        return;
      }
      if (msg.type === 'ASR_JOB_START') {
        startCalls++;
        // Store a done job immediately: waitForAsrJob's first poll sees the
        // result, so this test does not depend on the 1s poll interval.
        const job = makeDoneJob(msg.job.jobId);
        job.resultText = '[00:00] 后台结果\n[00:04] 第二行';
        if (loseStartResponse) {
          cb({ ok: false, error: 'message port closed' });
          return;
        }
        cb({ ok: true, data: { ok: true, jobId: msg.job.jobId } });
        return;
      }
      if (msg.type === 'ATTACH_ASR_CONFIRM') { confirmed = msg; cb({ ok: true }); return; }
      cb({ ok: true });
    },
    lastError: undefined,
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }],
    get: async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: { executeScript: async () => { throw new Error('ASR must NOT inject page scripts'); } },
  declarativeNetRequest: { updateSessionRules: async () => {} },
  cookies: { getAll: async () => [] },
  storage: {
    local: areaFor(localData),
    session: areaFor(sessionData),
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const attachBtn = document.getElementById('attach');

function baseCtx() {
  return {
    meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
    mode: 'asr-pending',
    asrPlatform: 'bilibili',
    audioUrl: 'https://bilivideo.com/audio/192.m4s',
    audioCandidates: [{ url: 'https://bilivideo.com/audio/192.m4s', label: 'audio' }],
    noTranscript: true,
    text: 'bilibili plain text fallback',
    videoDurationSec: 5,
    asr: {
      provider: 'qwen',
      apiKey: 'sk-test',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-audio-3.1-asr-flash-filetrans',
      videoModel: 'qwen3.8-omni-flash',
      language: 'zh',
      hotwords: '',
      timeoutMs: 150000,
      subtitleSource: 'original',
    },
  };
}

test('new attach starts one offscreen job and confirms its result', async () => {
  attachCtx = baseCtx();
  sent = [];
  confirmed = null;
  startCalls = 0;
  attachBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(startCalls, 1, 'exactly one ASR_JOB_START');
  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'));
  assert.ok(confirmed);
  assert.match(confirmed.text, /\[00:00\] 后台结果/);
  assert.match(confirmed.text, /bilibili plain text fallback/, 'video metadata is preserved');
});

test('re-attaching an existing done job reuses it without a second job start', async () => {
  const existing = makeDoneJob('job-existing');
  attachCtx = {
    ...baseCtx(),
    audioUrl: '',
    audioCandidates: [],
    asrJob: { jobId: existing.jobId, status: 'done', originContextId: '' },
  };
  sent = [];
  confirmed = null;
  startCalls = 0;
  attachBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(startCalls, 0, 're-attach must not start another job');
  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'));
  assert.match(confirmed.text, /\[00:00\] 后台结果/);
});

test('a lost ASR_JOB_START response still waits on the persisted job (no duplicate pipeline)', async () => {
  attachCtx = baseCtx();
  sent = [];
  confirmed = null;
  startCalls = 0;
  loseStartResponse = true;
  attachBtn.click();
  await new Promise((r) => setTimeout(r, 50));
  loseStartResponse = false;

  assert.equal(startCalls, 1, 'the start message was sent once');
  assert.ok(confirmed, 'the persisted job result must still be attached');
  assert.match(confirmed.text, /\[00:00\] 后台结果/);
  assert.match(confirmed.text, /bilibili plain text fallback/);
});
