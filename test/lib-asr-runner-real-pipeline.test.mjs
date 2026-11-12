// test/lib-asr-runner-real-pipeline.test.mjs — integration seam between the
// offscreen runner, the real shared audio pipeline, the real Qwen filetrans
// adapter, and the durable job store. Only network I/O is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const localData = {};
const sessionData = {};

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
    remove: async (key) => { delete data[key]; },
  };
}

globalThis.chrome = {
  storage: {
    local: areaFor(localData),
    session: areaFor(sessionData),
  },
};

const { saveAsrJob, getAsrJob, getAsrJobPayload } = await import('../lib/asr-job-store.js');
const { createAsrRunner } = await import('../lib/asr-runner.js');

const PAGE = 'https://www.bilibili.com/video/BV1xx411c7mD';
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('runner + real pipeline + Qwen task: fileId checkpoint resumes without download/upload', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/services/audio/asr/transcription')) {
      return { ok: true, json: async () => ({ output: { task_id: 'task-int' } }) };
    }
    if (u.includes('/tasks/task-int')) {
      return { ok: true, json: async () => ({ output: {
        task_id: 'task-int', task_status: 'SUCCEEDED',
        results: [{ transcription_url: 'https://oss.example.com/int.json' }],
      } }) };
    }
    if (u === 'https://oss.example.com/int.json') {
      return { ok: true, json: async () => ({ transcripts: [{ sentences: [
        { begin_time: 2000, text: '集成恢复。' },
      ] }] }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const asr = {
    provider: 'qwen', apiKey: 'sk-test', baseUrl: BASE,
    model: 'qwen-audio-3.1-asr-flash-filetrans', language: 'zh',
    hotwords: '', timeoutMs: 150000, subtitleSource: 'original',
  };
  const job = {
    jobId: 'int-1', key: 'key-int-1', assetId: 'bili-BV1xx411c7mD-p1',
    tabId: null, pageUrl: PAGE, platform: 'bilibili', title: '测试视频',
    durationSec: 0, provider: 'qwen', baseUrl: BASE,
    model: asr.model, language: 'zh', hotwords: '',
    fileId: 'oss://existing/audio.wav', status: 'running', phase: 'resuming',
  };
  await saveAsrJob(job);

  let idle = 0;
  const runner = createAsrRunner({
    idleMs: 20,
    onIdle: async () => { idle++; },
    reconstruct: async () => ({
      ok: true,
      asr,
      ctx: {
        mode: 'asr-pending', asrPlatform: 'bilibili',
        meta: { url: PAGE, title: '测试视频' }, videoDurationSec: 0,
      },
    }),
  });
  await runner.enqueue('int-1');
  const done = await waitFor(async () => {
    const j = await getAsrJob('int-1');
    return j?.status === 'done' ? j : null;
  });

  assert.equal(done.resultText, '[00:02] 集成恢复。');
  assert.equal(done.taskId, 'task-int');
  assert.equal(done.fileId, 'oss://existing/audio.wav');
  assert.equal(await getAsrJobPayload('int-1'), null);
  assert.ok(!calls.some((c) => c.url.includes('bilivideo')), 'no media download');
  assert.ok(!calls.some((c) => c.url.includes('/api/v1/uploads')), 'no re-upload');
  await waitFor(async () => idle > 0);
  delete globalThis.fetch;
});
