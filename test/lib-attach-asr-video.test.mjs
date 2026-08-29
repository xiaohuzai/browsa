// test/lib-attach-asr-video.test.mjs — 视频解析（视听精读）的纯函数与 API 形状：
// estimateStreamBytes / pickVideoStream 选流策略（durl 合一流优先、512MB 预算、
// 画质优先、时长未知兜底）、buildVideoAnalysisInstructions/TaskText 的格式纪律、
// analyzeVideo 的 Responses 请求体（input_video + input_audio 组合、durl 单文件路径）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VIDEO_MAX_UPLOAD_BYTES,
  estimateStreamBytes,
  pickVideoStream,
  buildVideoAnalysisInstructions,
  buildVideoAnalysisTaskText,
  analyzeVideo,
  resolveVideoDurationSec,
  parseKeyframeMarkers,
  keyframeCapFor,
} from '../lib/handlers/attach-asr.js';

const MB = 1024 * 1024;

test('keyframeCapFor scales with duration, clamped to [4,12], 6 when unknown', () => {
  assert.equal(keyframeCapFor(0), 6);
  assert.equal(keyframeCapFor(undefined), 6);
  assert.equal(keyframeCapFor(300), 4, '5 分钟 → ceil(2.5)=3 → 下限 4');
  assert.equal(keyframeCapFor(1015), 9, '17 分钟 → ceil(8.46)=9（小Lin说档位，2026-08-30 用户反馈 6 张太少）');
  assert.equal(keyframeCapFor(1440), 12, '24 分钟 → ceil(12)=12 → 上限 12');
  assert.equal(keyframeCapFor(5400), 12, '90 分钟仍封顶 12');
});

test('estimateStreamBytes prefers the API size, falls back to bandwidth×duration/8, else 0', () => {
  assert.equal(estimateStreamBytes({ size: 123 }, 600), 123);
  assert.equal(estimateStreamBytes({ bandwidth: 2_000_000, size: 0 }, 600), Math.round(2_000_000 * 600 / 8));
  assert.equal(estimateStreamBytes({ bandwidth: 2_000_000, size: 0, duration: 300 }, 0), Math.round(2_000_000 * 300 / 8));
  assert.equal(estimateStreamBytes({ bandwidth: 0 }, 600), 0);
  assert.equal(estimateStreamBytes(null, 600), 0);
});

test('pickVideoStream prefers a muxed (durl) stream that fits the budget', () => {
  const pick = pickVideoStream({
    videoCandidates: [{ url: 'v-hi', bandwidth: 2_000_000, size: 100 * MB }],
    muxedStream: { url: 'muxed', size: 200 * MB },
    durationSec: 600,
  });
  assert.equal(pick.kind, 'muxed');
  assert.equal(pick.stream.url, 'muxed');
});

test('pickVideoStream skips an over-budget muxed stream and picks the best video that fits', () => {
  const vids = [
    { url: 'v-1080', bandwidth: 2_000_000, size: 900 * MB },  // 超 512MB 预算
    { url: 'v-720', bandwidth: 1_200_000, size: 400 * MB },   // 预算内、画质次高
    { url: 'v-480', bandwidth: 600_000, size: 150 * MB },
  ];
  const pick = pickVideoStream({ videoCandidates: vids, muxedStream: { url: 'muxed', size: 600 * MB }, durationSec: 600 });
  assert.equal(pick.kind, 'video');
  assert.equal(pick.stream.url, 'v-720', 'quality-first within budget (1080p excluded, 720p wins over 480p)');
  assert.equal(pick.estBytes, 400 * MB);
});

test('pickVideoStream returns null when nothing fits and picks the lowest bitrate when duration is unknown', () => {
  assert.equal(pickVideoStream({
    videoCandidates: [{ url: 'v-big', bandwidth: 9_000_000, size: 2_000_000_000 }],
    durationSec: 600,
  }), null);
  assert.equal(pickVideoStream({ videoCandidates: [], durationSec: 600 }), null);
  const unknown = pickVideoStream({
    videoCandidates: [
      { url: 'v-hi', bandwidth: 2_000_000, size: 0 },
      { url: 'v-low', bandwidth: 300_000, size: 0 },
    ],
    durationSec: 0,
  });
  assert.equal(unknown.kind, 'video');
  assert.equal(unknown.stream.url, 'v-low', 'unknown duration → lowest-risk stream');
  assert.equal(unknown.estBytes, 0);
});

test('video analysis prompt carries the same timestamp/speaker discipline as ASR', () => {
  const ins = buildVideoAnalysisInstructions('zh');
  assert.match(ins, /\[mm:ss\]/);
  assert.match(ins, /NEVER output duration ranges/);
  assert.match(ins, /\[说话人N\]/);
  assert.match(ins, /The audio language is zh/);
  assert.match(buildVideoAnalysisInstructions('auto'), /auto-detect/);
  const task = buildVideoAnalysisTaskText(600, 'zh');
  assert.match(task, /视听精读/);
  assert.match(task, /画面：/);
  assert.match(task, /约 10 分钟/);
  assert.doesNotMatch(buildVideoAnalysisTaskText(0, 'zh'), /约 \d+ 分钟/);
  // 截屏标记协议（上限随时长伸缩 + 间隔 + 独立成行；上限是预算不是指标）
  assert.match(ins, /\[截屏\]/);
  assert.match(task, /\[截屏\]/);
  // instructions 不带时长 → 回退 6；带时长 → 与 keyframeCapFor 同源。
  assert.match(ins, /up to 6/);
  assert.match(buildVideoAnalysisInstructions('zh', 1015), /up to 9/);
  assert.match(buildVideoAnalysisTaskText(600, 'zh'), /上限 5 个/);
  assert.match(buildVideoAnalysisTaskText(0, 'zh'), /上限 6 个/);
  assert.match(task, /尽量用满/, '上限是预算不是指标——prompt 鼓励图表密集视频用满额度');
  // 广告段压缩 + 说话人身份括注（2026-08-29 用户实测：小Lin说视频广告逐字照录、
  // 特朗普插播只标 [说话人2] 而主叙述不标）。
  assert.match(task, /（广告：品牌\+核心卖点）/);
  assert.match(buildVideoAnalysisInstructions('zh', 600), /AD READS/);
  assert.match(task, /（特朗普）/);
  assert.match(buildVideoAnalysisInstructions('zh', 600), /FIRST line/);
});

test('parseKeyframeMarkers parses [mm:ss]/[h:mm:ss] markers, enforces cap and min gap', () => {
  const doc = [
    '[00:00] 大家好',
    '[00:05] [截屏] 图表一',
    '[00:10] [截屏] 图表二',        // 与上一条间隔 5s < 8s → 丢弃
    '[00:30] 画面：普通行（无标记）',
    '[02:05] [截屏] 代码演示',
    '[1:02:03] [截屏] 片尾总结',
    '[00:03] [截屏] 排序后最早',     // 乱序输入 → 排序后 3s，与 00:05 冲突 → 丢弃
  ].join('\n');
  const out = parseKeyframeMarkers(doc);
  // 排序后 3s 先入选；5s/10s 与它间隔 < 8s 被滤；125s、3723s 保留。
  assert.deepEqual(out.map((m) => m.sec), [3, 125, 3723], 'sorted, gap-filtered');
  assert.deepEqual(out.map((m) => m.caption), ['排序后最早', '代码演示', '片尾总结']);
  // 上限 6
  const many = Array.from({ length: 10 }, (_, i) => `[${i}:00:00] [截屏] 图${i}`).join('\n');
  assert.equal(parseKeyframeMarkers(many).length, 6);
  assert.deepEqual(parseKeyframeMarkers('没有标记的文档'), []);
  assert.deepEqual(parseKeyframeMarkers(''), []);
});

test('analyzeVideo sends input_video(+input_audio+input_text) with the video model and reports the transcript', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        id: 'resp_1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[00:00] 大家好\n[00:04] 画面：示例代码' }] }],
      }),
    };
  };
  try {
    const res = await analyzeVideo({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'k', videoFileId: 'file-v', audioFileId: 'file-a',
      model: 'doubao-seed-2-0-lite-260428', language: 'zh', durationSec: 600,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
    const content = calls[0].body.input[0].content;
    assert.deepEqual(content.map((c) => c.type), ['input_video', 'input_audio', 'input_text']);
    assert.equal(content[0].file_id, 'file-v');
    assert.equal(content[1].file_id, 'file-a');
    assert.equal(calls[0].body.model, 'doubao-seed-2-0-lite-260428');
    assert.equal(calls[0].body.max_output_tokens, 65536);
    assert.equal(calls[0].body.stream, true);
    assert.match(res.text, /\[00:04\] 画面：示例代码/);
    assert.equal(res.truncated, undefined);

    // durl 合一流路径：无独立音频 → 只有 input_video + input_text
    calls.length = 0;
    await analyzeVideo({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k', videoFileId: 'file-m', audioFileId: null, model: 'mm' });
    assert.deepEqual(calls[0].body.input[0].content.map((c) => c.type), ['input_video', 'input_text']);
    assert.equal(calls[0].body.model, 'mm');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('VIDEO_MAX_UPLOAD_BYTES stays under the Ark 512MB hard cap', () => {
  assert.ok(VIDEO_MAX_UPLOAD_BYTES <= 512 * MB);
  assert.ok(VIDEO_MAX_UPLOAD_BYTES > 400 * MB);
});

test('resolveVideoDurationSec prefers SSR duration, falls back to DASH stream metadata', () => {
  // SSR 有值 → 直接用
  assert.equal(resolveVideoDurationSec(600, [{ duration: 999 }]), 600);
  // SSR 缺失（2026-08-28 实测 81 分钟视频 videoDurationSec=0）→ 取流元数据最大值
  assert.equal(resolveVideoDurationSec(0, [
    { type: 'audio', duration: 4874.2 },
    { type: 'video', duration: 4873.8 },
  ]), 4874);
  // 音频/视频任意一条带 duration 都够
  assert.equal(resolveVideoDurationSec(undefined, [{ type: 'video', duration: 300 }]), 300);
  // 全部缺失 → 0（维持“未知”语义，不编造）
  assert.equal(resolveVideoDurationSec(0, [{ type: 'audio', duration: 0 }]), 0);
  assert.equal(resolveVideoDurationSec(0, []), 0);
});
