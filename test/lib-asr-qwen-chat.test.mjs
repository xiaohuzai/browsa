// test/lib-asr-qwen-chat.test.mjs — 千问 chat/completions 流式底层（mock fetch）：
// SSE 解析（delta.content 累积、[DONE]、usage 尾块、reasoning_content 忽略、
// finish_reason=length 截断）、请求形态（oss:// 解析头 / stream_options / max_tokens）、
// 400 预算超限自动降档重试、非流式兜底、音频转写请求体结构。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streamQwenChat, transcribeAudioQwen } from '../lib/handlers/attach-asr-qwen.js';

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const sse = (items) => items
  .map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`)
  .join('');

function sseResponse(text, { status = 200, contentType = 'text/event-stream' } = {}) {
  const enc = new TextEncoder();
  const chunk = enc.encode(text);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => (sent
          ? { done: true, value: undefined }
          : ((sent = true), { done: false, value: chunk })),
      }),
    },
    text: async () => text,
    json: async () => { throw new Error('not json'); },
  };
}

const DELTA = (content, finish = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });

test('streamQwenChat: 请求形态（兼容端点 + oss:// 解析头 + stream_options + max_tokens）', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return sseResponse(sse([
        DELTA('你好。', 'stop'),
        { choices: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        '[DONE]',
      ]));
    };
    const out = await streamQwenChat({
      baseUrl: BASE, apiKey: 'sk',
      body: { model: 'm', messages: [], stream: true, stream_options: { include_usage: true }, max_tokens: 65536 },
    });
    assert.equal(calls[0].url, BASE + '/chat/completions', '兼容端点 /chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk');
    assert.equal(calls[0].init.headers['X-DashScope-OssResourceResolve'], 'enable', 'oss:// 引用必须带解析头');
    assert.equal(out.text, '你好。');
    assert.equal(out.truncated, undefined);
    assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamQwenChat: 跨 chunk 累积、reasoning_content 忽略、finish_reason=length → truncated', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => sseResponse(sse([
      { choices: [{ delta: { reasoning_content: '思考过程' }, finish_reason: null }] },
      DELTA('[00:01] 你'),
      DELTA('好。'),
      DELTA('[00:02] 第二', 'length'),
      '[DONE]',
    ]));
    const out = await streamQwenChat({
      baseUrl: BASE, apiKey: 'sk', body: { model: 'm', messages: [], stream: true },
    });
    assert.equal(out.text, '[00:01] 你好。[00:02] 第二', '只累积正文，思维链不进产物');
    assert.equal(out.truncated, true, '输出被上限截断必须如实上报');
    assert.equal(out.finishReason, 'length');
    assert.equal(out.usage, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamQwenChat: 非 OK 且报错指向 max_tokens → 按真实上限降档重试一次', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: 'max_tokens is too large: 65536. This model supports at most 16384 max_tokens' } }),
        };
      }
      return sseResponse(sse([DELTA('ok', 'stop'), '[DONE]']));
    };
    const out = await streamQwenChat({
      baseUrl: BASE, apiKey: 'sk',
      body: { model: 'm', messages: [], stream: true, max_tokens: 65536 },
    });
    assert.equal(out.text, 'ok');
    assert.equal(calls[1].max_tokens, 16384, '第二次请求用解析出的真实上限');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamQwenChat: 与预算无关的 HTTP 错误原样抛出（不盲目重试）', async () => {
  const realFetch = globalThis.fetch;
  try {
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      return {
        ok: false, status: 401,
        text: async () => JSON.stringify({ error: { message: 'InvalidApiKey' } }),
      };
    };
    await assert.rejects(
      () => streamQwenChat({ baseUrl: BASE, apiKey: 'sk', body: { model: 'm', messages: [], stream: true, max_tokens: 65536 } }),
      /HTTP 401.*InvalidApiKey/s,
    );
    assert.equal(n, 1, '只请求一次');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streamQwenChat: 网关忽略 stream:true 时的非流式 JSON 兜底', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      body: null,
      json: async () => ({
        choices: [{ message: { content: '[00:01] 你好。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      }),
    });
    const out = await streamQwenChat({ baseUrl: BASE, apiKey: 'sk', body: { model: 'm', messages: [], stream: true } });
    assert.equal(out.text, '[00:01] 你好。');
    assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 6, total_tokens: 11 }, 'usage 字段名归一');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('transcribeAudioQwen: system 双语指令 + input_audio(oss://) + text 任务 + 放开的 max_tokens', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse(sse([DELTA('[00:01] 你好。', 'stop'), '[DONE]']));
    };
    const out = await transcribeAudioQwen({
      baseUrl: BASE, apiKey: 'sk', fileId: 'oss://dir/a.wav',
      model: 'qwen3.5-omni-flash', language: 'zh',
    });
    assert.equal(out.text, '[00:01] 你好。');
    assert.equal(bodies.length, 1);
    const b = bodies[0];
    assert.equal(b.model, 'qwen3.5-omni-flash');
    assert.equal(b.stream, true);
    assert.deepEqual(b.stream_options, { include_usage: true });
    assert.equal(b.max_tokens, 65536, '长音频输出远大于默认上限，必须放开');
    assert.equal(b.messages[0].role, 'system');
    assert.match(b.messages[0].content, /Transcribe the audio verbatim/);
    assert.match(b.messages[0].content, /\[mm:ss\]/);
    assert.match(b.messages[0].content, /\[说话人N\]/);
    assert.doesNotMatch(b.messages[0].content, /AD READS/, '纯音频转写不压缩广告（全量逐字）');
    const content = b.messages[1].content;
    assert.deepEqual(content.map((c) => c.type), ['input_audio', 'text']);
    assert.deepEqual(content[0].input_audio, { data: 'oss://dir/a.wav', format: 'wav' });
    assert.match(content[1].text, /逐字转写/);
    assert.match(content[1].text, /禁止裸秒数/);

    // 精读用的转写 pass：追加广告压缩规则
    bodies.length = 0;
    await transcribeAudioQwen({
      baseUrl: BASE, apiKey: 'sk', fileId: 'oss://dir/a.wav',
      model: 'm', language: 'zh', forVideoAnalysis: true, durationSec: 600,
    });
    assert.match(bodies[0].messages[0].content, /AD READS/, '精读两段式里的转写 pass 压缩广告');
    assert.match(bodies[0].messages[1].content[1].text, /广告口播/);
    assert.match(bodies[0].messages[1].content[1].text, /约 10 分钟/, '时长 hint 随 durationSec 下发');
  } finally {
    globalThis.fetch = realFetch;
  }
});
