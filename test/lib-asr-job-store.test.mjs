// test/lib-asr-job-store.test.mjs — durable job records for the offscreen ASR
// runner. The store is the resume hand-off between offscreen, the service
// worker, and a reopened side panel, so its identity/TTL/secret-boundary rules
// are pinned directly.

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
    remove: async (key) => {
      if (Array.isArray(key)) for (const k of key) delete data[k];
      else delete data[key];
    },
  };
}

globalThis.chrome = {
  storage: {
    local: areaFor(localData),
    session: areaFor(sessionData),
  },
};

const {
  asrJobKey, saveAsrJob, getAsrJob, findAsrJob, patchAsrJob, clearAsrJob,
  createAsrJobIfAbsent,
  listActiveAsrJobs, hasActiveAsrJobs, saveAsrJobPayload, getAsrJobPayload,
  clearAsrJobPayload, ASR_JOB_LIMITS,
} = await import('../lib/asr-job-store.js');

function makeJob(over = {}) {
  const base = {
    jobId: 'job-1',
    assetId: 'bili-BV1xx411c7mD-p1',
    provider: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
    model: 'qwen-audio-3.1-asr-flash-filetrans',
    language: 'zh',
    hotwords: 'browsa',
    durationSec: 300,
    platform: 'bilibili',
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    tabId: 7,
    title: '测试视频',
    status: 'queued',
    phase: 'queued',
    ...over,
  };
  return { ...base, key: asrJobKey(base) };
}

test('asrJobKey: stable identity, trailing slash normalized, API key is not part of it', () => {
  assert.equal(
    asrJobKey({ assetId: 'a', provider: 'qwen', baseUrl: 'https://x/v1/', model: 'm', language: 'zh', hotwords: 'k' }),
    asrJobKey({ assetId: 'a', provider: 'qwen', baseUrl: 'https://x/v1', model: 'm', language: 'zh', hotwords: 'k' }),
  );
  assert.notEqual(
    asrJobKey({ assetId: 'a', provider: 'qwen', baseUrl: 'https://x/v1', model: 'm', language: 'zh', hotwords: 'k' }),
    asrJobKey({ assetId: 'a', provider: 'qwen', baseUrl: 'https://x/v1', model: 'm2', language: 'zh', hotwords: 'k' }),
  );
});

test('save/get/find: duration mismatch rejects reuse; key mismatch rejects reuse', async () => {
  const job = makeJob();
  await saveAsrJob(job);
  const got = await getAsrJob('job-1');
  assert.equal(got.assetId, job.assetId);
  assert.equal(got.key, job.key);

  assert.equal((await findAsrJob({ ...job, durationSec: 300 }))?.jobId, 'job-1');
  assert.equal(await findAsrJob({ ...job, durationSec: 1000 }), null, 'a re-cut video must not reuse a transcript');
  assert.equal(await findAsrJob({ ...job, model: 'other-model' }), null, 'model change is a different job');
});

test('records never contain the API key / cookie / signed media URL', async () => {
  const job = makeJob({ apiKey: 'sk-secret', biliCookie: 'SESSDATA=secret', audioUrl: 'https://cdn/signed' });
  await saveAsrJob(job);
  const stored = localData.browsaAsrJobs[job.key];
  assert.equal(stored.apiKey, undefined, 'the store must allowlist fields, never persist a caller-spread secret');
  assert.equal(stored.biliCookie, undefined);
  assert.equal(stored.audioUrl, undefined);
});

test('patch: terminal status gets the longer TTL; active jobs stay active', async () => {
  const job = makeJob({ jobId: 'job-2', assetId: 'asset-2' });
  await saveAsrJob(job);
  const before = Date.now();
  const done = await patchAsrJob('job-2', { status: 'done', phase: 'done', resultText: '[00:01] hi' });
  assert.equal(done.status, 'done');
  assert.ok(done.expiresAt >= before + ASR_JOB_LIMITS.DONE_TTL_MS - 1000);

  const active = await patchAsrJob('job-2', { status: 'running', phase: 'uploading', progressText: '上传中' });
  assert.ok(active.expiresAt <= before + ASR_JOB_LIMITS.ACTIVE_TTL_MS + 1000);
});

test('listActive/hasActive: terminal jobs are not resumed', async () => {
  const active = makeJob({ jobId: 'job-3', assetId: 'asset-3', status: 'running', phase: 'downloading' });
  const done = makeJob({ jobId: 'job-4', assetId: 'asset-4', status: 'done', phase: 'done' });
  const failed = makeJob({ jobId: 'job-5', assetId: 'asset-5', status: 'failed', phase: 'failed' });
  await saveAsrJob(active);
  await saveAsrJob(done);
  await saveAsrJob(failed);
  const activeJobs = await listActiveAsrJobs();
  assert.ok(activeJobs.some((j) => j.jobId === 'job-3'));
  assert.ok(!activeJobs.some((j) => j.jobId === 'job-4'));
  assert.ok(!activeJobs.some((j) => j.jobId === 'job-5'));
  assert.equal(await hasActiveAsrJobs(), true);
});

test('payload: API key/media URLs live in session storage, not local', async () => {
  const payload = {
    asr: { provider: 'qwen', apiKey: 'sk-secret', baseUrl: 'https://x', model: 'm' },
    ctx: { audioUrl: 'https://cdn/signed', audioCandidates: [{ url: 'https://cdn/signed' }] },
  };
  await saveAsrJobPayload('job-6', payload);
  assert.equal(localData['browsaAsrJobPayload.job-6'], undefined);
  assert.equal(sessionData['browsaAsrJobPayload.job-6'].asr.apiKey, 'sk-secret');
  assert.equal((await getAsrJobPayload('job-6')).ctx.audioUrl, 'https://cdn/signed');
  await clearAsrJobPayload('job-6');
  assert.equal(await getAsrJobPayload('job-6'), null);
});

test('expired records are pruned on read', async () => {
  const expired = makeJob({ jobId: 'job-7', assetId: 'asset-7', status: 'running', expiresAt: Date.now() - 1 });
  await saveAsrJob(expired);
  // save recomputes expiry for the status; force an expired record directly.
  localData.browsaAsrJobs[expired.key].expiresAt = Date.now() - 1;
  assert.equal(await getAsrJob('job-7'), null);
  assert.ok(!(await listActiveAsrJobs()).some((j) => j.jobId === 'job-7'));
});

test('clearAsrJob removes only the requested record', async () => {
  const a = makeJob({ jobId: 'job-8', assetId: 'asset-8' });
  const b = makeJob({ jobId: 'job-9', assetId: 'asset-9' });
  await saveAsrJob(a);
  await saveAsrJob(b);
  assert.equal(await clearAsrJob('job-8'), true);
  assert.equal(await getAsrJob('job-8'), null);
  assert.ok(await getAsrJob('job-9'));
});

test('createAsrJobIfAbsent is atomic: concurrent creators agree on one job', async () => {
  const a = makeJob({ jobId: 'job-10', assetId: 'asset-10' });
  const b = makeJob({ jobId: 'job-11', assetId: 'asset-10' });
  const [ra, rb] = await Promise.all([
    createAsrJobIfAbsent(a),
    createAsrJobIfAbsent(b),
  ]);
  assert.equal([ra.created, rb.created].filter(Boolean).length, 1, 'exactly one creator wins');
  assert.equal(ra.job.jobId, rb.job.jobId, 'both callers see the same winning job');

  const failed = { ...a, jobId: 'job-12', status: 'failed', phase: 'failed' };
  await saveAsrJob(failed);
  const replaced = await createAsrJobIfAbsent({ ...a, jobId: 'job-13' });
  assert.equal(replaced.created, true, 'a failed record is replaceable');
  assert.equal(replaced.job.jobId, 'job-13');
});
