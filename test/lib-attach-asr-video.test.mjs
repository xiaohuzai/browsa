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
  SAFETY_KEYFRAME_CAP,
} from '../lib/handlers/attach-asr.js';

const MB = 1024 * 1024;

test('SAFETY_KEYFRAME_CAP: client-side guard only, generous enough for chart-dense videos', () => {
  assert.equal(SAFETY_KEYFRAME_CAP, 24);
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
  // 全片覆盖硬约束（youtube-digest lateThreshold 思路，2026-09-04）：给具体的
  // 90% 时刻锚点而非只有模糊措辞；时长未知时不出现锚点。
  assert.match(task, /不得早于 \[09:00\]/);
  assert.doesNotMatch(buildVideoAnalysisTaskText(0, 'zh'), /不得早于/);
  const insDur = buildVideoAnalysisInstructions('zh', 600);
  assert.match(insDur, /COVERAGE REQUIREMENT/);
  assert.match(insDur, /\[09:00\]/);
  assert.doesNotMatch(buildVideoAnalysisInstructions('zh'), /COVERAGE REQUIREMENT/, '时长未知不给覆盖锚点');
  // 截屏协议（2026-08-30 用户定调：内容/音频是主体，图只截关键的）：只截论证
  // 依赖的画面，软性密度参考（15-20 分钟 ≈ 6-10），禁截装饰性画面与重复画面；
  // 客户端只留安全阀。
  assert.match(ins, /\[截屏\]/);
  assert.match(task, /\[截屏\]/);
  assert.doesNotMatch(ins, /up to \d+/, 'EN prompt 无硬性数字上限');
  assert.doesNotMatch(task, /上限 \d+ 个/, '中文 prompt 无硬性数字上限');
  assert.match(ins, /KEY visuals ONLY/);
  assert.match(ins, /never capture the same visual twice/);
  assert.match(task, /只截【关键】画面/);
  assert.match(task, /通常 6-10 处即可/);
  assert.match(task, /同一画面只截一次/);
  assert.match(task, /不要截：标题卡/);
  // 广告段压缩 + 说话人身份括注（2026-08-29 用户实测：小Lin说视频广告逐字照录、
  // 特朗普插播只标 [说话人2] 而主叙述不标）。
  assert.match(task, /（广告：品牌\+核心卖点）/);
  assert.match(buildVideoAnalysisInstructions('zh'), /AD READS/);
  assert.match(task, /（特朗普）/);
  assert.match(buildVideoAnalysisInstructions('zh'), /FIRST line/);
  // 2026-08-30 用户定调：播客/访谈类，视频解析的价值首在分辨说话人——
  // 画面锚定（镜头对着谁就是谁）+ 身份括注在长间隔后重复 + 抢话归属规则。
  assert.match(ins, /DIARIZE WITH THE VISUAL CHANNEL/);
  assert.match(ins, /stronger than acoustic similarity/);
  assert.match(ins, /never flip-flop a speaker's number mid-video/);
  assert.match(ins, /AGAIN at their first line after every absence/);
  assert.match(task, /用画面辅助分辨说话人/);
  assert.match(task, /强于听声音相似度/);
  assert.match(task, /再次括注/);
  assert.match(task, /抢话/);
  // 命名标签：有身份证据时用 [说话人:名字]，未知才回退 [说话人N]
  assert.match(task, /标签优先用真实名字/);
  assert.match(task, /\[说话人:英博博士\]/);
  assert.match(ins, /LABEL WITH REAL NAMES/);
  assert.match(ins, /at most 8 characters/);
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
  // 每个幸存标记携带原始行文本（sidepanel 只对幸存者做 [截屏]→[图N] 改写）
  assert.ok(out.every((m) => /\[截屏\]/.test(m.line)));
  assert.ok(out.every((m) => m.line.includes(m.caption)));
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

test('analyzeVideo: metaHint 进入任务文本（说话人命名先验）', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ id: 'resp_1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[00:00] hi' }] }] }),
    };
  };
  try {
    await analyzeVideo({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k', videoFileId: 'fv', audioFileId: 'fa', model: 'm', durationSec: 60, metaHint: '硅谷101：mRNA癌症疫苗（UP主：硅谷101）' });
    const taskText = calls[0].body.input[0].content.find((c) => c.type === 'input_text').text;
    assert.match(taskText, /视频元信息（用于识别说话人姓名与职务/);
    assert.match(taskText, /UP主：硅谷101/, '先验文本完整下发');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('analyzeVideo: 无 metaHint 时不出现元信息段', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id: 'resp_1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[00:00] hi' }] }] }) };
  };
  try {
    await analyzeVideo({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k', videoFileId: 'fv', audioFileId: null, model: 'm', durationSec: 60 });
    const taskText = calls[0].body.input[0].content.find((c) => c.type === 'input_text').text;
    assert.doesNotMatch(taskText, /视频元信息/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
