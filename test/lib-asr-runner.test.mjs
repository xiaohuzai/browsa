// test/lib-asr-runner.test.mjs — the offscreen ASR runner's resume/queue
// contract. The pipeline itself is injected so the test observes the exact
// side-effect boundaries: upload checkpoint, task submit, pause vs fail, and
// DNR ownership.

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
  saveAsrJob, getAsrJob, saveAsrJobPayload, getAsrJobPayload,
} = await import('../lib/asr-job-store.js');
const { createAsrRunner } = await import('../lib/asr-runner.js');

async function waitFor(fn, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function baseJob(id, over = {}) {
  return {
    jobId: id,
    key: `key-${id}`,
    assetId: `asset-${id}`,
    platform: 'bilibili',
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    title: '测试视频',
    durationSec: 5,
    provider: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-audio-3.1-asr-flash-filetrans',
    language: 'zh',
    hotwords: '',
    status: 'queued',
    phase: 'queued',
    ...over,
  };
}

function makeRunner(over = {}) {
  const calls = {
    dnrAdded: [], dnrRemoved: [], pipelines: 0, tasks: 0, idle: 0,
  };
  const runner = createAsrRunner({
    idleMs: 20,
    readPlatformCookie: async () => 'SESSDATA=x',
    registerMediaHeaders: async (ruleId, platform, cookie) => {
      calls.dnrAdded.push({ ruleId, platform, cookie });
    },
    removeMediaHeaders: async (ruleId) => { calls.dnrRemoved.push(ruleId); },
    refreshStreams: async () => null,
    reconstruct: async () => ({ ok: false, error: 'no-context' }),
    onIdle: async () => { calls.idle++; },
    runAudioTranscribePipeline: async ({ env }) => {
      calls.pipelines++;
      env.progress({ phase: 'downloading', text: '下载中' });
      await env.onUploaded?.('file-1');
      await env.onTaskSubmitted?.('task-1');
      env.onStatus?.('RUNNING');
      return { transcriptText: '[00:00] hi', audioBytes: 11, fileId: 'file-1' };
    },
    resumeQwenFiletransTask: async ({ onStatus }) => {
      calls.tasks++;
      onStatus?.('RUNNING');
      return { text: '[00:00] resumed', taskId: 'task-1' };
    },
    ...over,
  });
  return { runner, calls };
}

test('queue: one job at a time; upload/task checkpoints and done result persist', async () => {
  const job = baseJob('j1');
  await saveAsrJob(job);
  await saveAsrJobPayload('j1', {
    asr: { provider: 'qwen', apiKey: 'k', baseUrl: job.baseUrl, model: job.model, language: 'zh' },
    ctx: { audioUrl: 'https://cdn/a', audioCandidates: [{ url: 'https://cdn/a' }] },
  });
  const { runner, calls } = makeRunner();
  await runner.enqueue('j1');
  const done = await waitFor(async () => {
    const j = await getAsrJob('j1');
    return j?.status === 'done' ? j : null;
  });
  assert.equal(done.resultText, '[00:00] hi');
  assert.equal(done.fileId, 'file-1');
  assert.equal(done.taskId, 'task-1');
  assert.equal(calls.dnrAdded.length, 1);
  assert.equal(calls.dnrAdded[0].ruleId, 9_000_005);
  assert.equal(calls.dnrRemoved[0], 9_000_005);
  assert.equal(await getAsrJobPayload('j1'), null, 'ephemeral key/url payload is cleared after completion');
  await waitFor(async () => calls.idle > 0);
});

test('task-only resume: a submitted Qwen task polls without DNR/download/upload', async () => {
  const job = baseJob('j2', { taskId: 'task-9', status: 'running', phase: 'polling' });
  await saveAsrJob(job);
  const { runner, calls } = makeRunner({
    reconstruct: async () => ({
      ok: true, taskOnly: true,
      asr: { provider: 'qwen', apiKey: 'k', baseUrl: job.baseUrl, model: job.model, language: 'zh' },
    }),
  });
  await runner.enqueue('j2');
  const done = await waitFor(async () => {
    const j = await getAsrJob('j2');
    return j?.status === 'done' ? j : null;
  });
  assert.equal(done.resultText, '[00:00] resumed');
  assert.equal(calls.tasks, 1);
  assert.equal(calls.pipelines, 0, 'task-only resume must not run the download pipeline');
  assert.equal(calls.dnrAdded.length, 0, 'polling a cloud task must not inject media headers');
});

test('side-effectful failure: upload checkpoint pauses the job instead of failing/retrying', async () => {
  const job = baseJob('j3');
  await saveAsrJob(job);
  await saveAsrJobPayload('j3', {
    asr: { provider: 'qwen', apiKey: 'k', baseUrl: job.baseUrl, model: job.model, language: 'zh' },
    ctx: { audioUrl: 'https://cdn/a' },
  });
  let uploads = 0;
  const { runner } = makeRunner({
    runAudioTranscribePipeline: async ({ env }) => {
      uploads++;
      await env.onUploaded?.('file-3');
      throw new Error('ASR upload failed: network reset');
    },
  });
  await runner.enqueue('j3');
  const paused = await waitFor(async () => {
    const j = await getAsrJob('j3');
    return j?.status === 'paused' ? j : null;
  });
  assert.equal(paused.fileId, 'file-3', 'the successful upload handle is kept for resume');
  assert.match(paused.error, /upload failed/);
  assert.equal(uploads, 1, 'must not blindly re-upload');
  assert.equal(await getAsrJobPayload('j3'), null);
});

test('pre-upload failure with no task/file handle is terminal', async () => {
  const job = baseJob('j4');
  await saveAsrJob(job);
  await saveAsrJobPayload('j4', {
    asr: { provider: 'qwen', apiKey: 'k', baseUrl: job.baseUrl, model: job.model, language: 'zh' },
    ctx: { audioUrl: 'https://cdn/a' },
  });
  const { runner } = makeRunner({
    runAudioTranscribePipeline: async () => { throw new Error('ASR download failed: 403'); },
  });
  await runner.enqueue('j4');
  const failed = await waitFor(async () => {
    const j = await getAsrJob('j4');
    return j?.status === 'failed' ? j : null;
  });
  assert.match(failed.error, /403/);
});

test('a succeeded Qwen task with an empty transcript is terminal, not endlessly resumed', async () => {
  const job = baseJob('j4b', { taskId: 'task-empty', status: 'running', phase: 'polling' });
  await saveAsrJob(job);
  const { runner } = makeRunner({
    reconstruct: async () => ({
      ok: true, taskOnly: true,
      asr: { provider: 'qwen', apiKey: 'k', baseUrl: job.baseUrl, model: job.model, language: 'zh' },
    }),
    resumeQwenFiletransTask: async () => ({ text: '', taskId: 'task-empty' }),
  });
  await runner.enqueue('j4b');
  const failed = await waitFor(async () => {
    const j = await getAsrJob('j4b');
    return j?.status === 'failed' ? j : null;
  });
  assert.match(failed.error, /empty transcript/);
  assert.equal(failed.taskId, 'task-empty', 'the handle is kept for diagnostics');
});

test('cancel aborts the active job and marks it canceled', async () => {
  const job = baseJob('j5');
  await saveAsrJob(job);
  await saveAsrJobPayload('j5', {
    asr: { provider: 'qwen', apiKey: 'k', baseUrl: job.baseUrl, model: job.model, language: 'zh' },
    ctx: { audioUrl: 'https://cdn/a' },
  });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const { runner } = makeRunner({
    runAudioTranscribePipeline: async ({ env }) => new Promise((_, reject) => {
      entered();
      if (env.signal.aborted) return reject(new Error('aborted'));
      env.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await runner.enqueue('j5');
  await enteredPromise;
  await runner.cancel('j5');
  const canceled = await waitFor(async () => {
    const j = await getAsrJob('j5');
    return j?.status === 'canceled' ? j : null;
  });
  assert.equal(canceled.status, 'canceled');
});

test('resumeActiveJobs only picks queued/running, never paused/done', async () => {
  await saveAsrJob(baseJob('j6', { status: 'running' }));
  await saveAsrJob(baseJob('j7', { status: 'paused' }));
  await saveAsrJob(baseJob('j8', { status: 'done' }));
  const seen = [];
  const { runner } = makeRunner({
    runAudioTranscribePipeline: async ({ ctx }) => {
      seen.push(ctx.meta?.url || ctx.audioUrl || '?');
      return { transcriptText: '[00:00] x', audioBytes: 0 };
    },
    reconstruct: async () => ({ ok: false, error: 'no-context' }),
  });
  // Prevent the queued job from failing before we can observe it by giving it
  // a minimal payload/context.
  await saveAsrJobPayload('j6', {
    asr: { provider: 'qwen', apiKey: 'k', baseUrl: 'https://x', model: 'm', language: 'zh' },
    ctx: { audioUrl: 'https://cdn/a' },
  });
  await runner.resumeActiveJobs();
  await waitFor(async () => seen.length > 0);
  assert.equal(seen.length, 1, 'paused/done jobs must not be auto-resumed');
});
