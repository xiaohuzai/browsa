// test/lib-attach-asr-job-lookup.test.mjs — buildAsrPendingCtx must find a
// durable ASR job before probing the page. After a close/reopen the signed
// playurl is often expired; returning null here would strand a running cloud
// task or a finished transcript behind a fresh download.

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
  storage: { local: areaFor(localData), session: areaFor(sessionData) },
  scripting: { executeScript: async () => [{ result: { streams: [], videoDurationSec: 0 } }] },
};

const { asrJobKey, saveAsrJob } = await import('../lib/asr-job-store.js');
const { buildAsrPendingCtx } = await import('../lib/handlers/attach-asr-pending.js');

const PAGE = 'https://www.bilibili.com/video/BV1xx411c7mD';
const ASR = {
  provider: 'qwen',
  apiKey: 'sk-test',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-audio-3.1-asr-flash-filetrans',
  videoModel: 'qwen3.8-omni-flash',
  language: 'zh',
  hotwords: '',
  timeoutMs: 150000,
  subtitleSource: 'original',
};

function pageCtx(over = {}) {
  return {
    mode: 'bilibili',
    meta: { url: PAGE, title: '测试视频' },
    text: 'video info',
    noTranscript: true,
    ...over,
  };
}

async function seedJob(over = {}) {
  const base = {
    assetId: 'bili-BV1xx411c7mD-p1',
    provider: ASR.provider,
    baseUrl: ASR.baseUrl,
    model: ASR.model,
    language: ASR.language,
    hotwords: ASR.hotwords,
    durationSec: 5,
  };
  const job = {
    jobId: 'job-1',
    key: asrJobKey(base),
    assetId: base.assetId,
    platform: 'bilibili',
    pageUrl: PAGE,
    title: '测试视频',
    durationSec: 5,
    provider: ASR.provider,
    baseUrl: ASR.baseUrl,
    model: ASR.model,
    language: ASR.language,
    hotwords: ASR.hotwords,
    status: 'running',
    phase: 'uploading',
    progressText: '上传音频中…',
    originContextId: 'ctx-origin',
    ...over,
  };
  await saveAsrJob(job);
  return job;
}

test('job hit returns a resume ctx without requiring a fresh playurl', async () => {
  await seedJob();
  const ctx = await buildAsrPendingCtx(1, pageCtx(), { asr: ASR });
  assert.ok(ctx, 'must return a ctx even without media streams');
  assert.equal(ctx.mode, 'asr-pending');
  assert.equal(ctx.asrJob.jobId, 'job-1');
  assert.equal(ctx.asrJob.status, 'running');
  assert.equal(ctx.asrJob.originContextId, 'ctx-origin');
  assert.equal(ctx.audioUrl, undefined, 'a resumed job needs no signed media URL');
  assert.equal(ctx.asrExpiredError, '', 'stale playurl errors must not abort a resumed job');
  assert.equal(ctx.text, 'video info', 'the page context for the final attach is preserved');
});

test('done job is returned for result reuse', async () => {
  await seedJob({ jobId: 'job-2', status: 'done', phase: 'done', resultText: '[00:00] hi' });
  const ctx = await buildAsrPendingCtx(1, pageCtx(), { asr: ASR });
  assert.equal(ctx.asrJob.jobId, 'job-2');
  assert.equal(ctx.asrJob.status, 'done');
});

test('duration mismatch does not reuse the transcript', async () => {
  await seedJob({ jobId: 'job-3', durationSec: 600 });
  const ctx = await buildAsrPendingCtx(1, pageCtx({ videoDurationSec: 30 }), { asr: ASR });
  assert.equal(ctx, null, 'a 10-minute transcript must not be attached to a 30s video');
});

test('skipJobLookup forces the normal stream probe (used for reconstruction)', async () => {
  await seedJob({ jobId: 'job-4' });
  const ctx = await buildAsrPendingCtx(1, pageCtx(), { asr: ASR }, { skipJobLookup: true });
  assert.equal(ctx, null, 'no streams from the mocked page → normal null fallback, not the job ctx');
});
