// test/lib-asr-qwen-analyze.test.mjs — 千问两段式视频精读（mock fetch）：
// ①Omni 转写独立音频 ②视觉系看画面（fps 随时长自适应）③mergeQwenPasses 按时间轴
// 合并——转写行原样保留、视觉行只插入不改写、改名指令全量应用、违规复述行丢弃。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeVideoQwen, mergeQwenPasses, qwenVideoFps,
} from '../lib/handlers/attach-asr-qwen.js';

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const sse = (items) => items
  .map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`)
  .join('');

function sseResponse(text) {
  const enc = new TextEncoder();
  const chunk = enc.encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
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

const DELTA = (content, finish = 'stop') => ({ choices: [{ delta: { content }, finish_reason: finish }] });

const TRANSCRIPT = '[00:01] [说话人1] 欢迎收看本期节目。\n[00:03] [说话人2] 谢谢主持人。\n[00:04] [说话人2] 我们开始吧。';
const VISUAL = [
  '[改名] [说话人2] → [说话人：小林]',
  '[00:00] 画面：节目片头 logo',
  '[00:02] 画面：本期主题字幕「AI 投资」',
  '[00:02] [截屏] 本期主题',
  '[00:03] [说话人2] 谢谢主持人。', // 违规复述转写 → 必须被丢弃
].join('\n');

function mockTwoPass({ transcript = TRANSCRIPT, visual = VISUAL, visualFinish = 'stop' } = {}) {
  const bodies = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const isPass1 = bodies.length === 0; // 按请求顺序分流（不依赖模型名，两段用自定义名也可测）
    bodies.push(body);
    if (isPass1) {
      return sseResponse(sse([DELTA(transcript), { choices: [], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }, '[DONE]']));
    }
    return sseResponse(sse([
      DELTA(visual, visualFinish),
      { choices: [], usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230 } },
      '[DONE]',
    ]));
  };
  fn.bodies = bodies;
  return fn;
}

async function runWithFetch(fn, args) {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = fn;
    return await analyzeVideoQwen({ baseUrl: BASE, apiKey: 'sk', ...args });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('analyzeVideoQwen: 两段请求形态（Omni 读音频 / 视觉系读画面+fps+转写上下文+元信息）', async () => {
  const fn = mockTwoPass();
  await runWithFetch(fn, {
    videoFileId: 'oss://dir/video.mp4',
    audioFileId: 'oss://dir/audio.wav',
    transcribeModel: 'qwen3.5-omni-flash',
    model: 'qwen3.8-flash',
    language: 'zh',
    durationSec: 4,
    metaHint: '硅谷101 采访嘉宾名单',
  });
  assert.equal(fn.bodies.length, 2);
  const [tr, vis] = fn.bodies;
  assert.equal(tr.model, 'qwen3.5-omni-flash', '第一段：转写模型读音频');
  assert.equal(tr.messages[1].content[0].input_audio.data, 'oss://dir/audio.wav');
  assert.equal(vis.model, 'qwen3.8-flash', '第二段：视觉模型看画面');
  const vContent = vis.messages[1].content;
  assert.deepEqual(vContent.map((c) => c.type), ['video_url', 'text']);
  assert.equal(vContent[0].video_url.url, 'oss://dir/video.mp4');
  assert.equal(vContent[0].video_url.fps, qwenVideoFps(4), 'fps 随时长自适应');
  assert.match(vContent[1].text, /语音转写文本/, '转写作为视觉 pass 的上下文下发');
  assert.match(vContent[1].text, /硅谷101 采访嘉宾名单/, '元信息（说话人命名先验）随任务下发');
  assert.match(vis.messages[0].content, /do NOT transcribe/);
});

test('analyzeVideoQwen: 合并语义——转写主干原样保留、画面行插入、改名全量应用、复述丢弃', async () => {
  const fn = mockTwoPass();
  const out = await runWithFetch(fn, {
    videoFileId: 'oss://dir/video.mp4',
    audioFileId: 'oss://dir/audio.wav',
    transcribeModel: 'qwen3.5-omni-flash',
    model: 'qwen3.8-flash',
    durationSec: 4,
  });
  assert.equal(out.truncated, undefined);
  assert.deepEqual(out.usage, { input_tokens: 300, output_tokens: 80, total_tokens: 380 }, '两段 usage 求和');
  const lines = out.text.split('\n');
  assert.deepEqual(lines, [
    '[00:00] 画面：节目片头 logo',
    '[00:01] [说话人1] 欢迎收看本期节目。',
    '[00:02] 画面：本期主题字幕「AI 投资」',
    '[00:02] [截屏] 本期主题',
    '[00:03] [说话人：小林] 谢谢主持人。',
    '[00:04] [说话人：小林] 我们开始吧。',
  ], '画面行落在所属语音行之后（与方舟单请求精读的行序约定一致）；[截屏] 紧随其画面行');
});

test('analyzeVideoQwen: 任一段截断 → 整体 truncated（调用方拒绝半截产物）', async () => {
  const fn = mockTwoPass({ visualFinish: 'length' });
  const out = await runWithFetch(fn, {
    videoFileId: 'oss://v', audioFileId: 'oss://a', transcribeModel: 'tr', model: 'vis', durationSec: 4,
  });
  assert.equal(out.truncated, true);
  assert.equal(out.finishReason, 'length');

  const fn2 = mockTwoPass({ transcript: '' });
  await assert.rejects(
    () => runWithFetch(fn2, {
      videoFileId: 'oss://v', audioFileId: 'oss://a', transcribeModel: 'tr', model: 'vis', durationSec: 4,
    }),
    /转写返回为空/,
    '转写 pass 空产出要响亮失败，不能静默只留画面注解',
  );
});

test('analyzeVideoQwen: 缺独立音频流直接拒绝（视觉模型听不到视频里的声音）', async () => {
  await assert.rejects(
    () => runWithFetch(mockTwoPass(), {
      videoFileId: 'oss://v', audioFileId: null, transcribeModel: 'tr', model: 'vis', durationSec: 4,
    }),
    /独立音频/,
  );
});

test('mergeQwenPasses（纯函数）：末尾视觉行、无时间戳转写行、空产物边界', () => {
  assert.equal(
    mergeQwenPasses('[00:10] A\n[00:20] B', '[00:30] 画面：片尾信息'),
    '[00:10] A\n[00:20] B\n[00:30] 画面：片尾信息',
    '超过最后一行的视觉行追加在末尾',
  );
  assert.equal(
    mergeQwenPasses('[00:10] A\n无时间戳的行\n[00:20] B', '[00:15] 画面：中段'),
    '[00:10] A\n无时间戳的行\n[00:15] 画面：中段\n[00:20] B',
    '无时间戳行挂在前一行时间上，插入语义不漂移',
  );
  assert.equal(
    mergeQwenPasses('', '[00:01] 画面：开场'),
    '[00:01] 画面：开场',
    '空转写（理论不该出现）不丢视觉行，交给下游完整性守卫报错',
  );
  assert.equal(mergeQwenPasses('[00:01] A', ''), '[00:01] A', '空视觉产物 → 纯转写主干');
  assert.equal(
    mergeQwenPasses(
      '[00:10] [说话人3] C',
      '[改名] [说话人3] → [说话人：艾博博士]\n[00:12] [截屏] 证据图',
    ),
    '[00:10] [说话人：艾博博士] C\n[00:12] [截屏] 证据图',
    '改名应用于编号标签（全量替换）；截屏标记无前置画面行也保留（下游安全阀兜底）',
  );
});
