// test/lib-asr-qwen-filetrans.test.mjs — 千问录音文件转写（filetrans 异步任务 API）：
// 模型分发（filetrans/fun-asr 走任务管线，omni 走 chat）、提交请求形态（oss:// 临时
// URL + X-DashScope-Async + 参数）、轮询终态、结果 JSON → [mm:ss] 行的确定性映射
// （句级毫秒时间戳 + 说话人防御性解析）、失败响亮抛错。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isQwenFiletransModel, filetransResultToLines, transcribeAudioQwen,
} from '../lib/handlers/attach-asr-qwen.js';

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

test('isQwenFiletransModel: filetrans 后缀 / fun-asr 前缀命中，omni 系不命中', () => {
  assert.equal(isQwenFiletransModel('qwen-audio-3.0-asr-flash-filetrans'), true);
  assert.equal(isQwenFiletransModel('qwen3-asr-flash-filetrans'), true);
  assert.equal(isQwenFiletransModel('fun-asr'), true);
  assert.equal(isQwenFiletransModel('Fun-ASR-2025'), true, '大小写不敏感');
  assert.equal(isQwenFiletransModel('qwen3.5-omni-flash'), false, 'Omni 系走 chat 路径');
  assert.equal(isQwenFiletransModel(''), false);
});

test('filetransResultToLines: 毫秒时间戳 → [mm:ss]（超一小时 h:mm:ss）、按开始时间排序、跳过空句', () => {
  const lines = filetransResultToLines({
    transcripts: [{
      channel_id: 0,
      sentences: [
        { begin_time: 6500, end_time: 9000, text: '大家好。' },
        { begin_time: 3700000, end_time: 3703000, text: '一小时后的内容。' },
        { begin_time: 500, end_time: 5000, text: '  开场白。 ' },
        { begin_time: 10000, end_time: 11000, text: '   ' },
      ],
    }],
  });
  assert.deepEqual(lines.split('\n'), [
    '[00:00] 开场白。',
    '[00:06] 大家好。',
    '[1:01:40] 一小时后的内容。',
  ]);
});

test('filetransResultToLines: 说话人字段防御性解析，>1 人时全行标注 [说话人N]（按首现顺序编号）', () => {
  const multi = filetransResultToLines({
    transcripts: [{
      sentences: [
        { begin_time: 1000, text: '欢迎。', speaker_id: '1' },
        { begin_time: 2000, text: '谢谢。', speaker_id: '0' },
        { begin_time: 3000, text: '开始吧。', speaker_id: '1' },
      ],
    }],
  });
  assert.deepEqual(multi.split('\n'), [
    '[00:01] [说话人1] 欢迎。',
    '[00:02] [说话人2] 谢谢。',
    '[00:03] [说话人1] 开始吧。',
  ], '原始编号重排为 1-based 首现顺序');

  const alt = filetransResultToLines({ transcripts: [{ sentences: [
    { begin_time: 1000, text: 'A。', spk_id: 3 },
    { begin_time: 2000, text: 'B。', spk_id: 3 },
  ] }] });
  assert.equal(alt, '[00:01] A。\n[00:02] B。', '单一说话人不标注（协议：单人不标）');

  const none = filetransResultToLines({ transcripts: [{ sentences: [
    { begin_time: 1000, text: '无说话人字段。' },
  ] }] });
  assert.equal(none, '[00:01] 无说话人字段。', '解析不出说话人 → 无标签');
});

function mockFiletransFlow({ statusSeq = ['PENDING', 'SUCCEEDED'], submitStatus = 200, submitBody = null, taskOutput = null } = {}) {
  const calls = [];
  let pollIdx = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/services/audio/asr/transcription')) {
      if (submitStatus !== 200) {
        return { ok: false, status: submitStatus, text: async () => submitBody || '{"code":"InvalidApiKey"}' };
      }
      return { ok: true, status: 200, json: async () => ({ request_id: 'r1', output: { task_id: 'task-1', task_status: 'PENDING' } }) };
    }
    if (u.includes('/tasks/task-1')) {
      const status = statusSeq[Math.min(pollIdx, statusSeq.length - 1)];
      pollIdx++;
      if (status === 'SUCCEEDED') {
        return { ok: true, status: 200, json: async () => ({ request_id: 'r2', output: taskOutput || {
          task_id: 'task-1', task_status: 'SUCCEEDED',
          result: { transcription_url: 'https://result.oss.aliyuncs.com/signed/transcript.json' },
          usage: { seconds: 42 },
        } }) };
      }
      if (status === 'FAILED') {
        return { ok: true, status: 200, json: async () => ({ output: { task_id: 'task-1', task_status: 'FAILED', code: 'InvalidFile', message: 'audio decode failed' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ output: { task_id: 'task-1', task_status: status } }) };
    }
    if (u.startsWith('https://result.oss.aliyuncs.com/signed/transcript.json')) {
      return { ok: true, status: 200, json: async () => ({ transcripts: [{ channel_id: 0, sentences: [
        { begin_time: 1000, end_time: 4000, text: '你好。', speaker_id: '0' },
        { begin_time: 5000, end_time: 8000, text: '请讲。', speaker_id: '1' },
      ] }] }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('transcribeAudioQwen 分发：filetrans 模型走任务管线（提交形态 + 轮询 + 结果映射）', async () => {
  const { calls, restore } = mockFiletransFlow();
  try {
    const out = await transcribeAudioQwen({
      baseUrl: BASE, apiKey: 'sk-q', fileId: 'oss://dir/audio.wav',
      model: 'qwen-audio-3.0-asr-flash-filetrans', language: 'zh', pollIntervalMs: 1,
    });
    assert.equal(out.text, '[00:01] [说话人1] 你好。\n[00:05] [说话人2] 请讲。');
    assert.equal(out.truncated, undefined, 'ASR 无 token 上限概念');
    assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds: 42 });

    // 提交请求形态
    const submit = calls[0];
    assert.equal(submit.url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription');
    assert.equal(submit.init.headers.Authorization, 'Bearer sk-q');
    assert.equal(submit.init.headers['X-DashScope-Async'], 'enable');
    assert.equal(submit.init.headers['X-DashScope-OssResourceResolve'], 'enable', 'oss:// 临时引用依赖解析头');
    const body = JSON.parse(submit.init.body);
    assert.equal(body.model, 'qwen-audio-3.0-asr-flash-filetrans');
    assert.equal(body.input.file_url, 'oss://dir/audio.wav', 'filetrans 输入是文件 URL（RESTful 支持 oss://）');
    assert.deepEqual(body.parameters, { enable_itn: true, enable_words: true, language: 'zh' },
      '语种明确时随参数下发；未发说话人参数（该模型未文档化，靠结果解析）');
    // 轮询与结果拉取
    assert.ok(calls.some((c) => c.url.endsWith('/tasks/task-1')), '轮询任务状态');
    const resultCall = calls.find((c) => c.url.startsWith('https://result.oss.aliyuncs.com'));
    assert.ok(resultCall, '拉取 transcription_url');
    assert.equal(resultCall.init?.headers?.Authorization, undefined, '签名结果 URL 免鉴权');
  } finally {
    restore();
  }
});

test('filetrans 参数分支：language=auto 不传语种；fun-asr 追加 diarization_enabled', async () => {
  const { calls, restore } = mockFiletransFlow();
  try {
    await transcribeAudioQwen({
      baseUrl: BASE, apiKey: 'sk', fileId: 'oss://a.wav',
      model: 'fun-asr', language: 'auto', pollIntervalMs: 1,
    });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.parameters, { enable_itn: true, enable_words: true, diarization_enabled: true },
      '说话人分离参数仅对文档化支持的 fun-asr 发');
    assert.equal(body.parameters.language, undefined, 'auto → 不指定语种（官方要求）');
  } finally {
    restore();
  }
});

test('filetrans 失败路径：提交非 200 / 任务 FAILED / 缺 task_id 都响亮抛错', async () => {
  {
    const { restore } = mockFiletransFlow({ submitStatus: 401, submitBody: '{"code":"InvalidApiKey","message":"bad key"}' });
    try {
      await assert.rejects(
        () => transcribeAudioQwen({ baseUrl: BASE, apiKey: 'sk', fileId: 'oss://a.wav', model: 'fun-asr', language: 'zh', pollIntervalMs: 1 }),
        /filetrans submit HTTP 401.*InvalidApiKey/s,
      );
    } finally { restore(); }
  }
  {
    const { restore } = mockFiletransFlow({ statusSeq: ['FAILED'] });
    try {
      await assert.rejects(
        () => transcribeAudioQwen({ baseUrl: BASE, apiKey: 'sk', fileId: 'oss://a.wav', model: 'fun-asr', language: 'zh', pollIntervalMs: 1 }),
        /转写任务失败 \(FAILED\).*InvalidFile.*audio decode failed/s,
      );
    } finally { restore(); }
  }
  {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output: { task_status: 'PENDING' } }) });
      await assert.rejects(
        () => transcribeAudioQwen({ baseUrl: BASE, apiKey: 'sk', fileId: 'oss://a.wav', model: 'fun-asr', language: 'zh', pollIntervalMs: 1 }),
        /无 task_id/,
      );
    } finally { globalThis.fetch = real; }
  }
});

test('filetrans 轮询超时（外层 signal 到期）→ 可读的超时报错', async () => {
  const { restore } = mockFiletransFlow({ statusSeq: ['RUNNING'] });
  try {
    await assert.rejects(
      () => transcribeAudioQwen({
        baseUrl: BASE, apiKey: 'sk', fileId: 'oss://a.wav', model: 'fun-asr', language: 'zh',
        pollIntervalMs: 50, signal: AbortSignal.timeout(80),
      }),
      /超时预算用尽/,
    );
  } finally { restore(); }
});
