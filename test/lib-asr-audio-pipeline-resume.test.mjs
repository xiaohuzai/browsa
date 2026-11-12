// test/lib-asr-audio-pipeline-resume.test.mjs — the shared audio pipeline's
// upload checkpoint. A job-store fileId (upload succeeded, cache write did
// not) must skip both download and upload and go straight to the provider.

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
    onChanged: { addListener: () => {} },
  },
};

const { runAudioTranscribePipeline } = await import('../lib/asr-audio-pipeline.js');

test('env.fileId skips download+upload and resumes the provider task from the uploaded file', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/services/audio/asr/transcription')) {
      return { ok: true, json: async () => ({ output: { task_id: 'task-resume' } }) };
    }
    if (u.includes('/tasks/task-resume')) {
      return { ok: true, json: async () => ({ output: {
        task_id: 'task-resume', task_status: 'SUCCEEDED',
        results: [{ transcription_url: 'https://oss.example.com/result.json' }],
      } }) };
    }
    if (u === 'https://oss.example.com/result.json') {
      return { ok: true, json: async () => ({ transcripts: [{ sentences: [
        { begin_time: 1000, text: '断点续跑。' },
      ] }] }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const ctx = {
    meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
    asr: {
      provider: 'qwen',
      apiKey: 'sk-test',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-audio-3.1-asr-flash-filetrans',
      language: 'zh',
      hotwords: '',
      timeoutMs: 150000,
      subtitleSource: 'original',
    },
  };
  const res = await runAudioTranscribePipeline({
    ctx,
    platform: 'bilibili',
    wantDurSec: 0,
    env: {
      fileId: 'oss://existing/audio.wav',
      progress: () => {},
      refreshStreams: async () => null,
    },
  });

  assert.equal(res.transcriptText, '[00:01] 断点续跑。');
  assert.equal(calls.length, 3, 'submit + task poll + result fetch');
  assert.ok(!calls.some((c) => c.url.includes('bilivideo')), 'must not re-download media');
  assert.ok(!calls.some((c) => c.url.includes('/api/v1/uploads')), 'must not re-upload media');
  const submit = JSON.parse(calls[0].init.body);
  assert.deepEqual(submit.input.file_urls, ['oss://existing/audio.wav']);
  delete globalThis.fetch;
});
