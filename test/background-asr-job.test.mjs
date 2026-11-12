// test/background-asr-job.test.mjs — background owns the offscreen lifecycle
// and the secret boundary: the local job record must never contain the API
// key, while the session payload (read by the runner) may.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const localData = {
  asr: {
    provider: 'qwen', apiKey: 'sk-secret',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-audio-3.1-asr-flash-filetrans',
    language: 'zh', hotwords: '', timeoutMs: 150000, subtitleSource: 'original',
  },
};
const sessionData = {};
const sent = [];
let offscreenCreated = null;
let offscreenClosed = false;
let alarmCreated = null;
let alarmCleared = false;

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

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: async (msg) => { sent.push(msg); return { ok: true }; },
    getURL: (p) => p,
    getManifest: () => ({ permissions: ['offscreen'] }),
    lastError: undefined,
  },
  tabs: {
    query: async () => [],
    get: async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }),
    create: async () => ({}),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: { executeScript: async () => [{ result: { streams: [], videoDurationSec: 0 } }] },
  alarms: {
    create: (name, opts) => { alarmCreated = { name, opts }; },
    clear: () => { alarmCleared = true; },
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: () => {}, update: async () => {}, removeAll: async () => {},
    onClicked: { addListener: () => {} },
  },
  cookies: { getAll: async () => [] },
  declarativeNetRequest: {
    getSessionRules: async () => [],
    updateSessionRules: async () => {},
  },
  storage: {
    local: areaFor(localData),
    session: areaFor(sessionData),
    onChanged: { addListener: () => {} },
  },
  offscreen: {
    hasDocument: async () => false,
    createDocument: async (opts) => { offscreenCreated = opts; },
    closeDocument: async () => { offscreenClosed = true; },
  },
  action: { setBadgeText: () => {} },
};

const bg = await import('../background.js');
const { handle } = bg;

function jobPayload(id = 'job-1') {
  return {
    jobId: id,
    assetId: 'bili-BV1xx411c7mD-p1',
    tabId: 1,
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
    title: '测试视频',
    durationSec: 5,
    originContextId: 'ctx-origin',
    originSessionId: '',
    asr: localData.asr,
    ctx: {
      mode: 'asr-pending',
      asrPlatform: 'bilibili',
      meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
      audioUrl: 'https://cdn/signed',
      audioCandidates: [{ url: 'https://cdn/signed' }],
      videoDurationSec: 5,
    },
  };
}

test('ASR_JOB_START: creates the offscreen runner, stores a secret-free record, and forwards the job', async () => {
  const res = await handle({ type: 'ASR_JOB_START', job: jobPayload('job-1') }, {});
  assert.equal(res.ok, true);
  assert.equal(res.jobId, 'job-1');
  assert.equal(offscreenCreated?.url, 'offscreen.html');
  assert.deepEqual(offscreenCreated.reasons, ['BLOBS']);
  assert.equal(alarmCreated?.name, 'browsa-asr-watchdog');

  const record = Object.values(localData.browsaAsrJobs || {}).find((j) => j.jobId === 'job-1');
  assert.ok(record, 'job record created');
  assert.equal(record.apiKey, undefined, 'API key must never reach local storage');
  assert.equal(record.provider, 'qwen');
  assert.equal(record.status, 'queued');

  const payload = sessionData['browsaAsrJobPayload.job-1'];
  assert.equal(payload.asr.apiKey, 'sk-secret', 'session payload is the only place the key lives');
  const forwarded = sent.find((m) => m.type === 'ASR_JOB_START' && m.target === 'offscreen');
  assert.equal(forwarded?.jobId, 'job-1');
});

test('ASR_JOB_START is idempotent for the same video+config (no second upload/task)', async () => {
  const payload = jobPayload('job-idem');
  payload.assetId = 'bili-BV1xx411c7mD-p2';
  const first = await handle({ type: 'ASR_JOB_START', job: payload }, {});
  assert.equal(first.ok, true);
  const countAfterFirst = Object.keys(localData.browsaAsrJobs || {}).length;
  const second = await handle({ type: 'ASR_JOB_START', job: { ...payload, jobId: 'job-idem-2' } }, {});
  assert.equal(second.ok, true);
  assert.equal(second.resumed, true, 'the second start must resume the existing job');
  assert.equal(second.jobId, first.jobId, 'the winning jobId is returned');
  assert.equal(Object.keys(localData.browsaAsrJobs || {}).length, countAfterFirst, 'no second record');
});

test('ASR_JOB_CONTEXT: a submitted Qwen task needs no tab/media URL', async () => {
  localData.browsaAsrJobs = {
    'key-task': {
      jobId: 'job-task', key: 'key-task', assetId: 'asset',
      platform: 'bilibili', pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      provider: 'qwen', baseUrl: localData.asr.baseUrl,
      model: localData.asr.model, language: 'zh', hotwords: '',
      taskId: 'task-123', status: 'running', phase: 'polling',
      expiresAt: Date.now() + 60000,
    },
  };
  const res = await handle({ type: 'ASR_JOB_CONTEXT', jobId: 'job-task' }, {});
  assert.equal(res.ok, true);
  assert.equal(res.taskOnly, true);
  assert.equal(res.asr.apiKey, 'sk-secret');
});

test('ASR_JOB_CONTEXT: an uploaded file checkpoint needs no tab either', async () => {
  localData.browsaAsrJobs = {
    'key-file': {
      jobId: 'job-file', key: 'key-file', assetId: 'asset',
      platform: 'bilibili', pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      title: '测试视频', durationSec: 5,
      provider: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2-1-lite-260915', language: 'zh', hotwords: '',
      fileId: 'file-abc', status: 'paused', phase: 'paused',
      expiresAt: Date.now() + 60000,
    },
  };
  const res = await handle({ type: 'ASR_JOB_CONTEXT', jobId: 'job-file' }, {});
  assert.equal(res.ok, true);
  assert.equal(res.ctx?.audioUrl, undefined);
  assert.equal(res.ctx?.meta?.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(res.asr.model, 'doubao-seed-2-1-lite-260915');
});

test('ASR_JOB_CANCEL marks the record canceled and clears the ephemeral payload', async () => {
  localData.browsaAsrJobs = {
    'key-cancel': {
      jobId: 'job-cancel', key: 'key-cancel', assetId: 'asset',
      platform: 'bilibili', provider: 'qwen', status: 'running', phase: 'downloading',
      expiresAt: Date.now() + 60000,
    },
  };
  sessionData['browsaAsrJobPayload.job-cancel'] = { asr: { apiKey: 'sk-secret' } };
  const res = await handle({ type: 'ASR_JOB_CANCEL', jobId: 'job-cancel' }, {});
  assert.equal(res.ok, true);
  const record = Object.values(localData.browsaAsrJobs).find((j) => j.jobId === 'job-cancel');
  assert.equal(record.status, 'canceled');
  assert.equal(sessionData['browsaAsrJobPayload.job-cancel'], undefined);
});

test('ASR_RUNNER_IDLE closes the offscreen document only when no active job remains', async () => {
  localData.browsaAsrJobs = {
    'key-done': {
      jobId: 'job-done', key: 'key-done', status: 'done', phase: 'done',
      expiresAt: Date.now() + 60000,
    },
  };
  offscreenClosed = false;
  const res = await handle({ type: 'ASR_RUNNER_IDLE' }, {});
  assert.equal(res.ok, true);
  assert.equal(offscreenClosed, true);
  assert.equal(alarmCleared, true);
});
