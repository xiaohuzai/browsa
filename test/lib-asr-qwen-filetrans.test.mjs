// test/lib-asr-qwen-filetrans.test.mjs — 百炼录音文件转写（filetrans 异步任务 API）：
// 模型分发（filetrans/fun-asr/paraformer 走任务管线，omni 走 chat）、提交请求形态
// （oss:// + X-DashScope-Async + 分族 input 形状 + diarization/language_hints）、
// 轮询终态、结果 JSON → [mm:ss] [说话人N] 行的确定性映射、失败响亮抛错、
// 纯音频模型在精读路径的兜底报错与模式卡门控。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isQwenFiletransModel, filetransResultToLines, qwenTranscribeAudio, qwenAnalyzeVideo,
  pingQwenAsr, parseAsrHotwords,
} from '../lib/handlers/attach-asr.js';

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

test('isQwenFiletransModel: filetrans 后缀 / fun-asr / paraformer 前缀命中，omni 系不命中', () => {
  assert.equal(isQwenFiletransModel('qwen-audio-3.1-asr-flash-filetrans'), true);
  assert.equal(isQwenFiletransModel('qwen-audio-3.0-asr-flash-filetrans'), true);
  assert.equal(isQwenFiletransModel('qwen3-asr-flash-filetrans'), true);
  assert.equal(isQwenFiletransModel('fun-asr'), true);
  assert.equal(isQwenFiletransModel('Fun-ASR-2025'), true, '大小写不敏感');
  assert.equal(isQwenFiletransModel('paraformer-v2'), true);
  assert.equal(isQwenFiletransModel('qwen3.8-omni-flash'), false, 'Omni 系走 chat 路径');
  assert.equal(isQwenFiletransModel(''), false);
  assert.equal(isQwenFiletransModel(undefined), false);
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

  const legacy = filetransResultToLines({ transcripts: [{ sentences: [
    { begin_time: 1000, text: 'A。', speaker: 'x' },
  ] }] });
  assert.equal(legacy, '[00:01] A。', 'speaker 别名也认');

  const none = filetransResultToLines({ transcripts: [{ sentences: [
    { begin_time: 1000, text: '无说话人字段。' },
  ] }] });
  assert.equal(none, '[00:01] 无说话人字段。', '解析不出说话人 → 无标签');
});

// 模拟完整任务流：submit → 轮询（statusSeq 逐个吐状态）→ 拉 transcription_url JSON。
function mockFiletransFlow({ statusSeq = ['PENDING', 'SUCCEEDED'], taskOutput = null, resultJson = null } = {}) {
  const calls = [];
  let pollIdx = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/services/audio/asr/transcription')) {
      return { ok: true, json: async () => ({ output: { task_id: 'task-1', task_status: 'PENDING' } }) };
    }
    if (u.includes('/tasks/')) {
      const status = statusSeq[Math.min(pollIdx++, statusSeq.length - 1)];
      const out = { task_id: 'task-1', task_status: status };
      if (status === 'SUCCEEDED' || status === 'FAILED') {
        Object.assign(out, taskOutput || (status === 'SUCCEEDED' ? { results: [{ transcription_url: 'https://oss.example.com/result.json' }] } : {}));
      }
      return { ok: true, json: async () => ({ output: out }) };
    }
    if (u === 'https://oss.example.com/result.json') {
      return { ok: true, json: async () => (resultJson ?? {
        transcripts: [{ sentences: [
          { begin_time: 1000, end_time: 4000, text: '原生时间戳。', speaker_id: '0' },
          { begin_time: 5000, end_time: 9000, text: '原生分离。', speaker_id: '1' },
        ] },
        ] }),
      };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return calls;
}

test('qwenTranscribeAudio(filetrans 模型): 走任务 API——X-DashScope-Async + resolve 头 + file_urls 数组 + diarization', async () => {
  const calls = mockFiletransFlow();
  const res = await qwenTranscribeAudio({
    baseUrl: BASE, apiKey: 'sk-test', fileId: 'oss://dashscope-instant/x/audio.wav',
    model: 'qwen-audio-3.1-asr-flash-filetrans', language: 'zh', idleTimeoutMs: 1000, pollIntervalMs: 1,
  });
  assert.equal(calls.length, 4, 'submit + 2×poll + result fetch');
  const submit = calls[0];
  assert.equal(submit.url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription');
  assert.equal(submit.init.headers['X-DashScope-Async'], 'enable');
  assert.equal(submit.init.headers['X-DashScope-OssResourceResolve'], 'enable', 'oss:// 临时引用需要解析头');
  const body = JSON.parse(submit.init.body);
  assert.equal(body.model, 'qwen-audio-3.1-asr-flash-filetrans');
  assert.deepEqual(body.input.file_urls, ['oss://dashscope-instant/x/audio.wav'], 'Qwen-Audio 族用 file_urls 数组');
  assert.equal(body.parameters.diarization_enabled, true, '原生说话人分离');
  assert.deepEqual(body.parameters.language_hints, ['zh'], '语种 hint 透传');
  // 结果 → browsa 行格式（原生毫秒时间戳 + 说话人编号），下游守卫零改动可消费
  assert.match(res.text, /^\[00:01\] \[说话人1\] 原生时间戳。\n\[00:05\] \[说话人2\] 原生分离。$/);
  assert.equal(res.truncated, undefined, 'ASR 无 token 上限概念');
  delete globalThis.fetch;
});

test('qwenTranscribeAudio(qwen3-asr-flash-filetrans): input.file_url 单对象（按模型族分形状）', async () => {
  const calls = mockFiletransFlow();
  await qwenTranscribeAudio({
    baseUrl: BASE, apiKey: 'k', fileId: 'oss://x/a.wav',
    model: 'qwen3-asr-flash-filetrans', language: 'auto', idleTimeoutMs: 1000, pollIntervalMs: 1,
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.input.file_url, 'oss://x/a.wav');
  assert.equal(body.input.file_urls, undefined);
  assert.equal(body.parameters.language_hints, undefined, 'auto 不传语种');
  delete globalThis.fetch;
});

test('qwenTranscribeAudio(filetrans): 任务 FAILED 响亮抛错（带 code/message），不静默回退', async () => {
  mockFiletransFlow({
    statusSeq: ['RUNNING', 'FAILED'],
    taskOutput: { code: 'InvalidFile', message: 'audio decode failed' },
  });
  await assert.rejects(
    () => qwenTranscribeAudio({
      baseUrl: BASE, apiKey: 'k', fileId: 'oss://x/a.wav',
      model: 'qwen-audio-3.1-asr-flash-filetrans', idleTimeoutMs: 1000, pollIntervalMs: 1,
    }),
    /转写任务失败 \(FAILED\).*InvalidFile.*audio decode failed/,
  );
  delete globalThis.fetch;
});

test('qwenTranscribeAudio(omni 模型): 不受影响仍走 chat/completions（回归守卫）', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/chat\/completions$/);
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"[00:00] 你好"}}]}\n\ndata: [DONE]\n\n')); c.close(); } }) };
  };
  const res = await qwenTranscribeAudio({
    baseUrl: BASE, apiKey: 'k', fileId: 'oss://x/a.wav',
    model: 'qwen3.8-omni-flash', idleTimeoutMs: 1000,
  });
  assert.match(res.text, /\[00:00\] 你好/);
  delete globalThis.fetch;
});

test('qwenAnalyzeVideo(filetrans 模型): 兜底报错指向「视频模型填 Omni」（编排层门控的最后防线）', async () => {
  await assert.rejects(
    () => qwenAnalyzeVideo({
      baseUrl: BASE, apiKey: 'k', videoFileId: 'oss://x/v.mp4', audioFileId: null,
      model: 'qwen-audio-3.1-asr-flash-filetrans',
    }),
    /只支持音频转写.*qwen3\.8-omni-flash/,
  );
});

test('pingQwenAsr(filetrans 模型): 上传策略通过即成功，跳过 chat 探针（1 跳）', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen-audio-3.1-asr-flash-filetrans');
    return { ok: true, json: async () => ({ data: { policy: 'p', upload_host: 'https://oss.example.com' } }) };
  };
  const r = await pingQwenAsr({ baseUrl: BASE, apiKey: 'k', model: 'qwen-audio-3.1-asr-flash-filetrans' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'filetrans 模型不吃 chat——只探上传策略');
  delete globalThis.fetch;
});

// ─── 即时热词（improve-asr-accuracy 官方页的 parameters.vocabulary）────────────

test('parseAsrHotwords: 多分隔符 + 去重 + 按官方约束过滤超限词', () => {
  assert.deepEqual(parseAsrHotwords('英博博士， OpenViking、browsa\n张三；李四，英博博士'),
    ['英博博士', 'OpenViking', 'browsa', '张三', '李四'], '逗号/顿号/分号/换行全认，去空壳去重');
  assert.deepEqual(parseAsrHotwords(''), []);
  assert.deepEqual(parseAsrHotwords(null), []);
  // 官方约束：非 ASCII 词 ≤15 字符
  const long15 = '一二三四五六七八九十甲乙丙丁戊';
  const long16 = long15 + '己';
  assert.deepEqual(parseAsrHotwords(`${long15}, ${long16}`), [long15], '16+ 字符的非 ASCII 词丢弃（防整次提交被拒）');
  // 纯 ASCII 按空格切分 ≤7 片段
  assert.deepEqual(parseAsrHotwords('a b c d e f g'), ['a b c d e f g'], '7 片段恰好保留');
  assert.deepEqual(parseAsrHotwords('a b c d e f g h'), [], '8 片段丢弃');
});

test('qwenTranscribeAudio(filetrans): 热词进 parameters.vocabulary（weight=4 推荐档）；未填则字段缺省', async () => {
  let bodies = [];
  globalThis.fetch = (async (url, init) => {
    const u = String(url);
    if (u.endsWith('/services/audio/asr/transcription')) {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ output: { task_id: 't', task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://oss.example.com/result.json' }] } }) };
    }
    if (u.includes('/tasks/')) {
      return { ok: true, json: async () => ({ output: { task_id: 't', task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://oss.example.com/result.json' }] } }) };
    }
    if (u === 'https://oss.example.com/result.json') {
      return { ok: true, json: async () => ({ transcripts: [{ sentences: [{ begin_time: 1000, text: '好。' }] }] }) };
    }
    throw new Error('unexpected: ' + u);
  });
  await qwenTranscribeAudio({
    baseUrl: BASE, apiKey: 'k', fileId: 'oss://x/a.wav',
    model: 'qwen-audio-3.1-asr-flash-filetrans', language: 'zh',
    hotwords: parseAsrHotwords('英博博士, OpenViking'), idleTimeoutMs: 1000, pollIntervalMs: 1,
  });
  assert.deepEqual(bodies[0].parameters.vocabulary, { '英博博士': 4, OpenViking: 4 }, 'weight=4 官方推荐档');
  // 即时热词文档仅收录 Qwen-Audio-3.x-ASR-Flash 系列——fun-asr 不发（未文档化参数有被拒风险）
  bodies = [];
  await qwenTranscribeAudio({
    baseUrl: BASE, apiKey: 'k', fileId: 'oss://x/a.wav',
    model: 'fun-asr', language: 'zh',
    hotwords: parseAsrHotwords('英博博士'), idleTimeoutMs: 1000, pollIntervalMs: 1,
  });
  assert.equal(bodies[0].parameters.vocabulary, undefined, 'fun-asr 不发即时热词');
  bodies = [];
  await qwenTranscribeAudio({
    baseUrl: BASE, apiKey: 'k', fileId: 'oss://x/a.wav',
    model: 'qwen-audio-3.1-asr-flash-filetrans', language: 'zh',
    idleTimeoutMs: 1000, pollIntervalMs: 1,
  });
  assert.equal(bodies[0].parameters.vocabulary, undefined, '未填热词不发字段');
  delete globalThis.fetch;
});
