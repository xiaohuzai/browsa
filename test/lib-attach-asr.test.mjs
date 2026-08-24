// test/lib-attach-asr.test.mjs — pure unit tests for lib/handlers/attach-asr.js
// (the 火山方舟 Ark ASR client). Covers the MAIN-world injectable
// downloadAndUploadAudio (self-contained, only fetch/FormData/Blob), the
// sidepanel-side pollFileStatus / transcribeAudio, and the pure
// formatAsrTranscript output-normalizer. No chrome/storage mocks needed —
// the module has no chrome/DOM dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadAndUploadAudio, downloadAudioBytes, uploadBlobToArk, transcodeAudioBlob, encodePcmToWav, resampleToMono,
  pollFileStatus, transcribeAudio, formatAsrTranscript, normalizeAsrTimestamps, transcriptEndSec,
  ASR_DEFAULTS, ASR_SUBTITLE_SOURCE, extFromMime, normalizeArkBaseUrl, splitMp4Fragments
} from '../lib/handlers/attach-asr.js';

// ---- downloadAndUploadAudio (MAIN-world injectable) ----

// Real Blob (Node 18+ global) so FormData.append accepts it, like a browser.
function fakeBlob(size = 42 * 1024 * 1024) {
  return new Blob([new Uint8Array(size)]);
}

test('downloadAndUploadAudio: downloads m4s (with Referer+Range) and uploads via Files API multipart', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    // First call: the m4s download. Second: the Ark /files upload.
    if (calls.length === 1) {
      assert.match(url, /^https:\/\/bilivideo\.com\/audio/);
      assert.equal(init.headers.Referer, 'https://www.bilibili.com');
      assert.equal(init.headers.Range, 'bytes=0-');
      // Cookie is injected via DNR by the caller (sidepanel), NOT via
      // credentials:'include' — a cross-origin extension fetch with
      // credentials:'include' trips CORS preflight (B站 CDN sends only
      // Access-Control-Allow-Origin:*, no Allow-Credentials) -> ERR_ABORTED
      // 403, and it can't carry SameSite cookies cross-site anyway.
      assert.equal(init.credentials, undefined, 'must NOT use credentials:include (CORS preflight ERR_ABORTED + SameSite cookie)');
      return { ok: true, blob: async () => fakeBlob(44 * 1024 * 1024) };  // ~44MB like a real audio
    }
    // Upload call
    assert.match(url, /\/files$/);
    assert.match(init.headers.Authorization, /^Bearer /);
    assert.ok(init.body instanceof globalThis.FormData, 'upload must be multipart FormData');
    return {
      ok: true,
      json: async () => ({ id: 'file-abc123', object: 'file', bytes: 44 * 1024 * 1024 })
    };
  };
  const res = await downloadAndUploadAudio({
    audioUrl: 'https://bilivideo.com/audio/123.m4s',
    apiKey: 'ark-test-key',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    format: 'audio/x-m4a',
  });
  assert.equal(res.ok, true);
  assert.equal(res.fileId, 'file-abc123');
  assert.equal(res.bytes, 44 * 1024 * 1024);
  delete globalThis.fetch;
});

test('downloadAndUploadAudio: an Agent Plan (api/plan) baseUrl is rewritten to standard api/v3 before the upload (2026-08-15 404 fix)', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return { ok: true, blob: async () => fakeBlob(100) };
    return { ok: true, json: async () => ({ id: 'file-plan' }) };
  };
  const res = await downloadAndUploadAudio({
    audioUrl: 'https://bilivideo.com/audio/x.m4s',
    apiKey: 'k',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',  // user's misconfigured value
    format: 'audio/x-m4a',
  });
  assert.equal(res.ok, true);
  assert.equal(res.fileId, 'file-plan');
  assert.equal(urls[1], 'https://ark.cn-beijing.volces.com/api/v3/files', 'must upload to the standard endpoint, not api/plan/v3');
  delete globalThis.fetch;
});

test('downloadAndUploadAudio: download HTTP failure returns {ok:false}', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  const res = await downloadAndUploadAudio({
    audioUrl: 'https://bilivideo.com/audio/123.m4s',
    apiKey: 'k',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    format: 'audio/x-m4a',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /403/);
  delete globalThis.fetch;
});

test('downloadAndUploadAudio: missing audioUrl/apiKey short-circuits', async () => {
  assert.equal((await downloadAndUploadAudio({ apiKey: 'k' })).ok, false);
  assert.equal((await downloadAndUploadAudio({ audioUrl: 'u' })).ok, false);
});

test('downloadAndUploadAudio: upload HTTP failure returns {ok:false} with response snippet', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) return { ok: true, blob: async () => fakeBlob(100) };
    return { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) };
  };
  const res = await downloadAndUploadAudio({ audioUrl: 'u', apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', format: 'audio/x-m4a' });
  assert.equal(res.ok, false);
  assert.match(res.error, /401/);
  delete globalThis.fetch;
});

// ---- pollFileStatus ----

test('pollFileStatus: returns ready when status leaves processing', async () => {
  globalThis.fetch = async (url) => {
    assert.match(url, /\/files\/file-1$/);
    return { ok: true, json: async () => ({ status: 'completed' }) };
  };
  const res = await pollFileStatus('https://ark.cn-beijing.volces.com/api/v3', 'k', 'file-1', { timeoutMs: 1000 });
  assert.equal(res.ready, true);
  assert.equal(res.status, 'completed');
  delete globalThis.fetch;
});

test('pollFileStatus: keeps polling while processing, then times out gracefully', async () => {
  let polls = 0;
  globalThis.fetch = async () => {
    polls++;
    return { ok: true, json: async () => ({ status: 'processing' }) };
  };
  const res = await pollFileStatus('https://ark.cn-beijing.volces.com/api/v3', 'k', 'file-1', { timeoutMs: 50, intervalMs: 10 });
  assert.equal(res.ready, false);
  assert.ok(polls >= 2, 'should have polled at least twice');
  assert.match(res.error, /timeout/);
  delete globalThis.fetch;
});

test('pollFileStatus: HTTP error throws', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => pollFileStatus('https://ark.cn-beijing.volces.com/api/v3', 'k', 'file-x', { timeoutMs: 100 }));
  delete globalThis.fetch;
});

test('pollFileStatus: failed status returns ready:false with Ark error detail (not ready)', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: 'failed',
      error: { message: 'InvalidArgumentError("Invalid video_url.")' }
    })
  });
  const res = await pollFileStatus('https://ark.cn-beijing.volces.com/api/v3', 'k', 'file-1', { timeoutMs: 1000 });
  assert.equal(res.ready, false);
  assert.equal(res.status, 'failed');
  assert.match(res.error, /failed/);
  assert.match(res.error, /Invalid video_url/);
  delete globalThis.fetch;
});

test('pollFileStatus: error status returns ready:false', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ status: 'error', error: { message: 'boom' } })
  });
  const res = await pollFileStatus('https://ark.cn-beijing.volces.com/api/v3', 'k', 'file-1', { timeoutMs: 1000 });
  assert.equal(res.ready, false);
  assert.equal(res.status, 'error');
  assert.match(res.error, /boom/);
  delete globalThis.fetch;
});

// ---- transcribeAudio ----

// 构造一个流式 SSE 响应体（ReadableStream），chunks 是分块内容。
function sseBody(...chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return stream;
}

const SSE_DELTA_1 = 'data: {"type":"response.output_text.delta","delta":"[00:00] 你好"}\n\n';
const SSE_DELTA_2 = 'data: {"type":"response.output_text.delta","delta":"，世界。"}\n\ndata: {"type":"response.output_text.done","text":"[00:00] 你好，世界。"}\n\n';

function makeSseResponse(...chunks) {
  return { ok: true, body: sseBody(...chunks) };
}

test('transcribeAudio: POSTs stream:true with input_audio.file_id and accumulates SSE deltas', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /\/responses$/);
    body = JSON.parse(init.body);
    assert.equal(body.stream, true, 'long-audio transcription must stream (avoid client timeout)');
    assert.match(init.headers.Authorization, /^Bearer /);
    assert.equal(body.input[0].content[0].type, 'input_audio');
    assert.equal(body.input[0].content[0].file_id, 'file-abc');
    assert.match(body.instructions, /\[mm:ss\]/);
    // ASR 输出质量要求（分句 / 标点 / speaker 分离）必须留在指令里。
    assert.match(body.instructions, /ONE sentence per line/);
    assert.match(body.instructions, /punctuation/);
    assert.match(body.instructions, /speaker label|说话人/);
    return makeSseResponse(SSE_DELTA_1, SSE_DELTA_2);
  };
  const res = await transcribeAudio({
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'k',
    fileId: 'file-abc',
    model: 'doubao-seed-2-0-lite-260428',
    language: 'zh',
    idleTimeoutMs: 1000,
  });
  assert.equal(res.text, '[00:00] 你好，世界。');
  assert.ok(body.instructions.includes('zh'), 'language hint should be in instructions');
  delete globalThis.fetch;
});

test('transcribeAudio: language "auto" omits the concrete hint and asks the model to auto-detect', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /\/responses$/);
    body = JSON.parse(init.body);
    return makeSseResponse(SSE_DELTA_1, SSE_DELTA_2);
  };
  const res = await transcribeAudio({
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'k',
    fileId: 'file-abc',
    model: 'doubao-seed-2-0-lite-260428',
    language: 'auto',
    idleTimeoutMs: 1000,
  });
  assert.equal(res.text, '[00:00] 你好，世界。');
  assert.doesNotMatch(body.instructions, /音频语种为/, 'auto must NOT inject a concrete language hint');
  assert.match(body.instructions, /自动检测/, 'auto must tell the model to detect the language itself');
  delete globalThis.fetch;
});

test('transcribeAudio: empty language also falls back to auto-detect (no concrete hint)', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /\/responses$/);
    body = JSON.parse(init.body);
    return makeSseResponse(SSE_DELTA_1, SSE_DELTA_2);
  };
  const res = await transcribeAudio({
    baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', language: '', idleTimeoutMs: 1000,
  });
  assert.equal(res.text, '[00:00] 你好，世界。');
  assert.doesNotMatch(body.instructions, /音频语种为/, 'empty language must not inject a concrete hint');
  assert.match(body.instructions, /自动检测/);
  delete globalThis.fetch;
});

test('transcribeAudio: falls back to non-stream JSON response when body has no reader', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    body: null,
    json: async () => ({
      id: 'resp_1',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[00:00] 你好\n[00:05] 世界' }] }]
    })
  });
  const res = await transcribeAudio({
    baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', idleTimeoutMs: 1000,
  });
  assert.equal(res.text, '[00:00] 你好\n[00:05] 世界');
  delete globalThis.fetch;
});

test('transcribeAudio: HTTP error throws with response snippet', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) });
  await assert.rejects(
    () => transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm' }),
    /429/
  );
  delete globalThis.fetch;
});

test('transcribeAudio: network failure surfaces as transcribe fetch failed', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(
    () => transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm' }),
    /transcribe fetch failed/
  );
  delete globalThis.fetch;
});

test('transcribeAudio: sets a high max_output_tokens so long verbatim transcripts are not cut at the default output cap', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return makeSseResponse(SSE_DELTA_1, SSE_DELTA_2);
  };
  await transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', idleTimeoutMs: 1000 });
  assert.ok(body.max_output_tokens > 0, 'must request a high output token budget for long-audio transcription');
  delete globalThis.fetch;
});

test('transcribeAudio: returns truncated:true when the stream ends with response.completed status incomplete (max_output_tokens)', async () => {
  const SSE_CUT = 'data: {"type":"response.completed","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}';
  globalThis.fetch = async () => makeSseResponse(SSE_DELTA_1, SSE_CUT + '\n\n');
  const res = await transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', idleTimeoutMs: 1000 });
  assert.equal(res.text, '[00:00] 你好');
  assert.equal(res.truncated, true, 'incomplete response.completed must flag the transcript as truncated');
  assert.equal(res.finishReason, 'incomplete');
  delete globalThis.fetch;
});

test('transcribeAudio: returns truncated:true when chat-compat finish_reason is length', async () => {
  const SSE_LEN = 'data: {"choices":[{"finish_reason":"length"}]}';
  globalThis.fetch = async () => makeSseResponse(SSE_DELTA_1, SSE_LEN + '\n\n');
  const res = await transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', idleTimeoutMs: 1000 });
  assert.equal(res.truncated, true);
  assert.equal(res.finishReason, 'length');
  delete globalThis.fetch;
});

test('transcribeAudio: non-stream fallback flags truncated when response status is incomplete', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    body: null,
    json: async () => ({ id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[00:00] 你好' }] }] })
  });
  const res = await transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', idleTimeoutMs: 1000 });
  assert.equal(res.text, '[00:00] 你好');
  assert.equal(res.truncated, true, 'non-stream incomplete status must be surfaced');
  delete globalThis.fetch;
});

test('transcribeAudio: clean completion carries no truncated flag', async () => {
  globalThis.fetch = async () => makeSseResponse(SSE_DELTA_1, SSE_DELTA_2);
  const res = await transcribeAudio({ baseUrl: 'b', apiKey: 'k', fileId: 'f', model: 'm', idleTimeoutMs: 1000 });
  assert.equal(res.truncated, undefined, 'complete output must not be flagged as truncated');
  delete globalThis.fetch;
});

// ---- transcriptEndSec ----

test('transcriptEndSec: parses the last end timestamp of a range-format transcript (the doubao AI-subtitle style)', () => {
  // The exact recurrence shape: a 52:48 video whose transcript stops at 33:25.
  const raw = ['[00:00.00-00:07.12] 第一句', '[33:17.22-33:25.45] 中途被截断的半句'].join('\n');
  assert.equal(transcriptEndSec(raw), 33 * 60 + 25.45);
});

test('transcriptEndSec: single [mm:ss] stamps use the stamp itself as the coverage point', () => {
  assert.equal(transcriptEndSec('[00:00] 你好\n[05:30] 世界'), 5 * 60 + 30);
});

test('transcriptEndSec: handles [h:mm:ss] (over an hour) and fractional precision', () => {
  assert.equal(transcriptEndSec('[1:02:03.500] 超过一小时'), 3600 + 2 * 60 + 3.5);
  assert.equal(transcriptEndSec('[00:01.250-01:02:03.500] 长区间'), 3600 + 2 * 60 + 3.5);
});

test('transcriptEndSec: returns null when no timestamp is recognizable', () => {
  assert.equal(transcriptEndSec(''), null);
  assert.equal(transcriptEndSec('纯文本没有时间戳'), null);
  assert.equal(transcriptEndSec(null), null);
});

test('transcriptEndSec: comma-separated ranges take the LAST timestamp as the coverage point (model drift 2026-08-24)', () => {
  // 真实案例：行尾是 "[44:44, 49:59]" ——若不认逗号区间，完整性校验会误判覆盖只到 44:44
  // （< 90%），把一份其实完整的字幕误拒；修后覆盖点到 49:59。
  assert.equal(transcriptEndSec('[00:00] 开头\n[44:44, 49:59] 结尾'), 49 * 60 + 59);
  assert.equal(transcriptEndSec('[00:00, 01:02:03.500] 跨界区间'), 3600 + 2 * 60 + 3.5);
  assert.equal(transcriptEndSec('[10:00, 11:00, 12:00] 多段时间戳'), 12 * 60);
  // 单时间戳行不受影响（回归）
  assert.equal(transcriptEndSec('[00:00] 你好\n[05:30] 世界'), 5 * 60 + 30);
});

// ---- formatAsrTranscript ----

test('formatAsrTranscript: keeps timestamped lines, drops meta lines', () => {
  const raw = [
    '以下是这段音频的转录文本：',
    '[00:00] 大家好',
    '[00:03] 欢迎收看',
    '',
    '以上是全部内容。',
  ].join('\n');
  const { lines, usedTimestamps } = formatAsrTranscript(raw);
  assert.deepEqual(lines, ['[00:00] 大家好', '[00:03] 欢迎收看']);
  assert.equal(usedTimestamps, 2);
});

test('formatAsrTranscript: strips list prefixes, keeps bare text lines as fallback', () => {
  const raw = ['- [01:00] 第一句', '> [01:02] 第二句', '没有时间戳的行也保留'].join('\n');
  const { lines } = formatAsrTranscript(raw);
  assert.deepEqual(lines, ['[01:00] 第一句', '[01:02] 第二句', '没有时间戳的行也保留']);
});

test('formatAsrTranscript: empty input -> empty result', () => {
  assert.deepEqual(formatAsrTranscript(''), { lines: [], usedTimestamps: 0 });
  assert.deepEqual(formatAsrTranscript(null), { lines: [], usedTimestamps: 0 });
});

test('normalizeAsrTimestamps: range/fraction timestamps become a single start [mm:ss] (click-to-seek compatible)', () => {
  // B站 AI 字幕式区间 + 小数（doubao 模型自发输出）→ 单起始格式
  assert.equal(normalizeAsrTimestamps('[00:00.00-00:12.77] 一点六五万亿美元'), '[00:00] 一点六五万亿美元');
  assert.equal(normalizeAsrTimestamps('[09:44.53-10:28.25] [说话人1] 他们Oracle也也有投资'), '[09:44] [说话人1] 他们Oracle也也有投资');
  // 单时间戳带小数 → 秒向下取整
  assert.equal(normalizeAsrTimestamps('[05:51.06] 认购倍数的这个问题'), '[05:51] 认购倍数的这个问题');
  // 跨小时的区间取起点，保留 h:mm:ss
  assert.equal(normalizeAsrTimestamps('[1:02:03.500-1:05:00.000] 超过一小时'), '[1:02:03] 超过一小时');
  // 无小数的普通单/小时格式原样保留
  assert.equal(normalizeAsrTimestamps('[00:12] 你好'), '[00:12] 你好');
  assert.equal(normalizeAsrTimestamps('[1:02:03] 超过一小时'), '[1:02:03] 超过一小时');
  // 非时间令牌不受影响
  assert.equal(normalizeAsrTimestamps('[说话人1] 你好'), '[说话人1] 你好');
  assert.equal(normalizeAsrTimestamps(''), '');
  // 逗号区间（模型漂移真实案例 2026-08-24）：同样归一化为起始时刻
  assert.equal(normalizeAsrTimestamps('[44:44, 49:59] 赞成观点'), '[44:44] 赞成观点');
  assert.equal(normalizeAsrTimestamps('[10:00, 11:00, 12:00] 多段时间戳'), '[10:00] 多段时间戳');
  assert.equal(normalizeAsrTimestamps('[1:02:03, 1:05:00] 超过一小时'), '[1:02:03] 超过一小时');
  assert.equal(normalizeAsrTimestamps('[44:44 - 49:59] 空格连字符'), '[44:44] 空格连字符');
  assert.equal(normalizeAsrTimestamps(null), '');
});

test('formatAsrTranscript: range-format input is normalized to single stamps and still counted', () => {
  const raw = [
    '[00:00.00-00:12.77] 第一句',
    '- [05:51.06-06:11.72] [说话人2] 第二句',
    '没有时间戳的纯文本行',
  ].join('\n');
  const { lines, usedTimestamps } = formatAsrTranscript(raw);
  assert.equal(usedTimestamps, 2);
  assert.equal(lines[0], '[00:00] 第一句');
  assert.equal(lines[1], '[05:51] [说话人2] 第二句');
  assert.equal(lines[2], '没有时间戳的纯文本行');
});

test('formatAsrTranscript: keeps speaker-labelled + punctuated sentence lines', () => {
  // 新 prompt 的典型输出：每句一行、带标点、可带 [说话人N] 前缀。时间戳仍在行首。
  const raw = [
    '[00:00] 各位朋友大家好，我是小野。',
    '[00:12] [说话人1] 今天我们来聊聊这本书。',
    '[00:20] [Speaker 2] Hello, everyone!',
    '[01:00] 这句话没有speaker前缀。',
  ].join('\n');
  const { lines, usedTimestamps } = formatAsrTranscript(raw);
  assert.deepEqual(lines, [
    '[00:00] 各位朋友大家好，我是小野。',
    '[00:12] [说话人1] 今天我们来聊聊这本书。',
    '[00:20] [Speaker 2] Hello, everyone!',
    '[01:00] 这句话没有speaker前缀。',
  ]);
  assert.equal(usedTimestamps, 4);
});

// ---- ASR_DEFAULTS + extFromMime ----

test('ASR_DEFAULTS: baseUrl is the Ark /api/v3 endpoint (NOT openspeech)', () => {
  assert.equal(ASR_DEFAULTS.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(ASR_DEFAULTS.model, 'doubao-seed-2-0-lite-260428');
  assert.equal(ASR_DEFAULTS.language, 'zh');
  assert.equal(ASR_DEFAULTS.subtitleSource, 'original', 'subtitle source must default to prefer the video\'s own subtitles');
  assert.equal(ASR_SUBTITLE_SOURCE.ORIGINAL, 'original');
  assert.equal(ASR_SUBTITLE_SOURCE.ASR, 'asr');
});

test('normalizeArkBaseUrl: rewrites the Agent Plan (api/plan) endpoint back to standard api/v3', () => {
  // The 2026-08-15 real-world 404: user had configured the Agent Plan base URL
  // (api/plan/v3), which has no Files API (upload 404s). Must rewrite to api/v3.
  assert.equal(
    normalizeArkBaseUrl('https://ark.cn-beijing.volces.com/api/plan/v3'),
    'https://ark.cn-beijing.volces.com/api/v3'
  );
  assert.equal(
    normalizeArkBaseUrl('https://ark.cn-beijing.volces.com/api/plan'),
    'https://ark.cn-beijing.volces.com/api/v3'
  );
  assert.equal(
    normalizeArkBaseUrl('https://ark.cn-beijing.volces.com/api/plan/v3/'),
    'https://ark.cn-beijing.volces.com/api/v3'
  );
  // Standard endpoint is left untouched.
  assert.equal(
    normalizeArkBaseUrl('https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3'
  );
  assert.equal(
    normalizeArkBaseUrl('https://ark-cn-beijing.volces.com/api/v3/'),
    'https://ark-cn-beijing.volces.com/api/v3/'
  );
  // Empty -> default.
  assert.equal(normalizeArkBaseUrl(''), 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(normalizeArkBaseUrl(undefined), 'https://ark.cn-beijing.volces.com/api/v3');
});

test('extFromMime: maps supported audio MIME types to extensions', () => {
  assert.equal(extFromMime('audio/x-m4a'), 'm4a');
  assert.equal(extFromMime('audio/mp4'), 'm4a');
  assert.equal(extFromMime('audio/mpeg'), 'mp3');
  assert.equal(extFromMime('audio/wav'), 'wav');
  assert.equal(extFromMime('audio/aac'), 'aac');
  assert.equal(extFromMime(''), '');
  assert.equal(extFromMime('video/mp4; codecs="avc1"'), 'm4a');
});

// ---- encodePcmToWav (pure, no browser deps) ----

test('encodePcmToWav: produces a valid 16-bit PCM WAV header (RIFF/WAVE/fmt/data)', () => {
  // 1s of silence at 16kHz mono
  const samples = new Float32Array(16000);
  const buf = encodePcmToWav(samples, { sampleRate: 16000, channels: 1 });
  const view = new DataView(buf);
  // Header is 44 bytes + 16000*2 data = 32044
  assert.equal(buf.byteLength, 44 + 16000 * 2);
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF');
  assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), 'WAVE');
  assert.equal(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15)), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM format');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000, 'sample rate');
  assert.equal(view.getUint32(28, true), 16000 * 1 * 2, 'byte rate');
  assert.equal(view.getUint16(32, true), 2, 'block align');
  assert.equal(view.getUint16(34, true), 16, '16-bit');
  assert.equal(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39)), 'data');
  assert.equal(view.getUint32(40, true), 16000 * 2, 'data chunk size');
});

test('encodePcmToWav: clamps samples to [-1,1] and writes correct PCM values', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const buf = encodePcmToWav(samples, { sampleRate: 16000, channels: 1 });
  const view = new DataView(buf);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), Math.trunc(0.5 * 0x7fff)); // setInt16 truncates toward zero
  assert.equal(view.getInt16(48, true), Math.trunc(-0.5 * 0x8000));
  assert.equal(view.getInt16(50, true), 0x7fff);   // 1 -> max
  assert.equal(view.getInt16(52, true), -0x8000);  // -1 -> min
  assert.equal(view.getInt16(54, true), 0x7fff);   // 2 -> clamped to 1
  assert.equal(view.getInt16(56, true), -0x8000);  // -2 -> clamped to -1
});

// ---- downloadAudioBytes / uploadBlobToArk (extension-context fetch) ----

test('downloadAudioBytes: fetches the m4s with Referer+Range headers, returns a blob', async () => {
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = url; seen.init = init;
    return { ok: true, blob: async () => new Blob([new Uint8Array(100)]) };
  };
  const res = await downloadAudioBytes({ audioUrl: 'https://upos-sz.bilivideo.com/audio/192.m4s' });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 100);
  assert.ok(res.blob instanceof Blob);
  assert.equal(seen.url, 'https://upos-sz.bilivideo.com/audio/192.m4s');
  assert.equal(seen.init.headers.Referer, 'https://www.bilibili.com');
  assert.equal(seen.init.headers.Range, 'bytes=0-');
});

test('downloadAudioBytes: missing audioUrl / HTTP failure return {ok:false}', async () => {
  assert.equal((await downloadAudioBytes({})).ok, false);
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  assert.equal((await downloadAudioBytes({ audioUrl: 'u' })).error, 'download HTTP 403');
});

test('downloadAudioBytes: streams the body and reports real percentages via onProgress', async () => {
  // 206 + Content-Range with a readable stream → onProgress sees done/total.
  const enc = new TextEncoder();
  const bytes = [enc.encode('0123456789'), enc.encode('abcdefghij'), enc.encode('klmnopqrst')];
  const total = bytes.reduce((n, b) => n + b.byteLength, 0); // 30
  const body = new ReadableStream({
    start(controller) { for (const b of bytes) controller.enqueue(b); controller.close(); },
  });
  const headers = { get: (k) => (k === 'content-range' ? `bytes 0-${total - 1}/${total}` : null) };
  globalThis.fetch = async () => ({ ok: true, body, headers });
  const seen = [];
  const res = await downloadAudioBytes({ audioUrl: 'https://upos-sz.bilivideo.com/audio/192.m4s', onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, total);
  assert.ok(res.blob instanceof Blob);
  assert.equal(seen.length, 3, 'one onProgress per percent step (10%, 20%, 100%)');
  assert.equal(seen[0][0], 10); assert.equal(seen[0][1], total);
  assert.equal(seen[1][0], 20); assert.equal(seen[1][1], total);
  assert.equal(seen[2][0], total); assert.equal(seen[2][1], total); // final 100%
});

test('downloadAudioBytes: streams with NO content-length/report → onProgress gets null total', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) { controller.enqueue(enc.encode('hello')); controller.close(); },
  });
  globalThis.fetch = async () => ({ ok: true, body, headers: { get: () => null } });
  const seen = [];
  const res = await downloadAudioBytes({ audioUrl: 'https://upos-sz.bilivideo.com/audio/192.m4s', onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 5);
  assert.ok(seen.length >= 1, 'onProgress called with bytes as it arrives');
  assert.equal(seen[0][1], null, 'no total → null so caller falls back to elapsed-time');
});

test('uploadBlobToArk: POSTs the blob as multipart with purpose=user_data and returns fileId', async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ id: 'file-xyz', object: 'file' }) };
  };
  const blob = new Blob([new Uint8Array(10)], { type: 'audio/wav' });
  const res = await uploadBlobToArk({ blob, filename: 'audio.wav', apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' });
  assert.equal(res.ok, true);
  assert.equal(res.fileId, 'file-xyz');
  assert.equal(res.bytes, 10);
  assert.equal(captured.url, 'https://ark.cn-beijing.volces.com/api/v3/files');
  assert.equal(captured.init.headers.Authorization, 'Bearer k');
  const fd = captured.init.body;
  assert.ok(fd instanceof FormData);
  assert.equal(fd.get('purpose'), 'user_data');
  const f = fd.get('file');
  assert.equal(f.name, 'audio.wav');
  assert.equal(f.size, 10);
});

test('uploadBlobToArk: surfaces Ark-detected content_type/bytes/status for diagnostics', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      id: 'file-meta',
      bytes: 32044,
      content_type: 'audio/wav',
      status: 'uploaded'
    })
  });
  const blob = new Blob([new Uint8Array(32044)], { type: 'audio/wav' });
  const res = await uploadBlobToArk({ blob, filename: 'audio.wav', apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' });
  assert.equal(res.ok, true);
  assert.equal(res.fileId, 'file-meta');
  assert.equal(res.upBytes, 32044);
  assert.equal(res.upContentType, 'audio/wav');
  assert.equal(res.upStatus, 'uploaded');
  delete globalThis.fetch;
});

test('uploadBlobToArk: no blob/apiKey and upload failure return {ok:false}', async () => {
  assert.equal((await uploadBlobToArk({ apiKey: 'k' })).ok, false);
  assert.equal((await uploadBlobToArk({ blob: new Blob() })).ok, false);
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'no files' } }) });
  const res = await uploadBlobToArk({ blob: new Blob([new Uint8Array(2)]), apiKey: 'k' });
  assert.equal(res.ok, false);
  assert.match(res.error, /upload HTTP 404/);
});

// ---- transcodeAudioBlob (Web Audio API; mocked in Node) ----

// Minimal mocks for both real AudioContext and OfflineAudioContext: each does
// decodeAudioData (returns a 48kHz stereo 2s buffer) + close. The transcode
// prefers real AudioContext, falls back to OfflineAudioContext.
globalThis.AudioContext = class {
  constructor() {}
  async decodeAudioData() {
    return {
      sampleRate: 48000, length: 48000 * 2, numberOfChannels: 2,
      getChannelData: () => new Float32Array(48000 * 2),
    };
  }
  async close() {}
};
globalThis.OfflineAudioContext = class {
  constructor(channels, frames, sampleRate) {
    this.channels = channels; this.frames = frames; this.sampleRate = sampleRate;
  }
  async decodeAudioData() {
    return {
      sampleRate: 48000, length: 48000 * 2, numberOfChannels: 2,
      getChannelData: () => new Float32Array(48000 * 2),
    };
  }
  async close() {}
  createBufferSource() { return { connect: () => {}, start: () => {}, buffer: null }; }
  destination = {};
  async startRendering() { return { getChannelData: () => new Float32Array(this.frames) }; }
};

test('transcodeAudioBlob: decodes an audio blob to 16kHz mono WAV', async () => {
  const blob = new Blob([new Uint8Array(1024)], { type: 'video/mp4' }); // m4s-like
  const res = await transcodeAudioBlob(blob);
  assert.equal(res.ok, true);
  assert.equal(res.sampleRate, 16000);
  assert.equal(res.wavBlob.type, 'audio/wav');
  // 2s @ 48k -> 2s @ 16k = 32000 frames -> 44 + 64000 bytes
  assert.equal(res.wavBytes, 44 + 32000 * 2);
});

test('transcodeAudioBlob: returns {ok:false} when no Web Audio decode support', async () => {
  const saved = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext };
  globalThis.AudioContext = undefined;
  globalThis.OfflineAudioContext = undefined;
  const res = await transcodeAudioBlob(new Blob([new Uint8Array(8)]));
  assert.equal(res.ok, false);
  assert.match(res.error, /no Web Audio decode support/);
  globalThis.AudioContext = saved.AudioContext;
  globalThis.OfflineAudioContext = saved.OfflineAudioContext;
});

test('transcodeAudioBlob: constructs AudioContext with NO args (AudioContextOptions bug regression)', async () => {
  // Regression: new DecodeCtx(2,1,48000) on a real AudioContext throws
  // "Failed to construct 'AudioContext': not of type AudioContextOptions".
  // Real AudioContext must be constructed with zero args; OfflineAudioContext
  // with (channels, length, sampleRate). Track which constructor got called.
  const saved = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext };
  let acArgs = null, oacArgs = null;
  globalThis.AudioContext = class {
    constructor(...args) { acArgs = args; }
    async decodeAudioData() {
      return {
        sampleRate: 48000, length: 48000, numberOfChannels: 1,
        getChannelData: () => new Float32Array(48000),
      };
    }
    async close() {}
  };
  const res = await transcodeAudioBlob(new Blob([new Uint8Array(64)]));
  assert.equal(res.ok, true);
  assert.deepEqual(acArgs, [], 'AudioContext must be constructed with zero args');
  assert.equal(oacArgs, null, 'OfflineAudioContext must not be used when AudioContext exists');
  globalThis.AudioContext = saved.AudioContext;
  globalThis.OfflineAudioContext = saved.OfflineAudioContext;
});

test('transcodeAudioBlob: falls back to OfflineAudioContext with (ch, len, rate) when no AudioContext', async () => {
  const saved = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext };
  let oacArgs = null;
  globalThis.AudioContext = undefined;
  globalThis.OfflineAudioContext = class {
    constructor(...args) { oacArgs = args; }
    async decodeAudioData() {
      return {
        sampleRate: 48000, length: 48000, numberOfChannels: 1,
        getChannelData: () => new Float32Array(48000),
      };
    }
    async close() {}
  };
  const res = await transcodeAudioBlob(new Blob([new Uint8Array(64)]));
  assert.equal(res.ok, true);
  assert.deepEqual(oacArgs, [2, 1, 48000], 'OfflineAudioContext takes (channels, length, sampleRate)');
  globalThis.AudioContext = saved.AudioContext;
  globalThis.OfflineAudioContext = saved.OfflineAudioContext;
});

// ---- resampleToMono (pure resample + downmix) ----

test('resampleToMono: integer downsampling 48k->16k keeps the signal (1/3 rate)', () => {
  // 48kHz sawtooth-ish signal; after 3x downsample the length is 1/3.
  const srcRate = 48000, len = 48000 * 3; // 3s
  const src = new Float32Array(len);
  for (let i = 0; i < len; i++) src[i] = Math.sin(i / 100);
  const buf = { sampleRate: srcRate, length: len, numberOfChannels: 1, getChannelData: () => src };
  const out = resampleToMono(buf, 16000);
  assert.equal(out.length, Math.ceil(len * 16000 / 48000)); // 48000 samples = 3s @ 16k
  // Linear interpolation at exactly-3x points samples the same input values.
  assert.ok(Math.abs(out[0] - src[0]) < 1e-4);
  assert.ok(Math.abs(out[4800] - src[14400]) < 1e-2);
});

test('resampleToMono: stereo averages both channels before interpolating', () => {
  const srcRate = 16000, len = 16000; // 1s
  const L = new Float32Array(len).fill(0.5);
  const R = new Float32Array(len).fill(-0.5);
  const buf = { sampleRate: srcRate, length: len, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? L : R) };
  const out = resampleToMono(buf, 16000);
  // Mono average of 0.5 and -0.5 is 0 (at 1:1 rate, direct copy path would need channels===1;
  // here channels===2 so it interpolates but samples land exactly on integers -> 0).
  assert.equal(out.length, 16000);
  assert.ok(out.every((v) => Math.abs(v) < 1e-4), 'stereo L+R averages to ~0');
});

test('resampleToMono: 16k mono passthrough copies the buffer', () => {
  const src = new Float32Array(100).fill(0.25);
  const buf = { sampleRate: 16000, length: 100, numberOfChannels: 1, getChannelData: () => src };
  const out = resampleToMono(buf, 16000);
  assert.equal(out.length, 100);
  assert.ok(out.every((v) => v === 0.25), 'passthrough keeps values');
});

test('resampleToMono: arbitrary-rate upsampling interpolates', () => {
  const src = new Float32Array([0, 1]);
  const buf = { sampleRate: 2, length: 2, numberOfChannels: 1, getChannelData: () => src };
  const out = resampleToMono(buf, 4);
  assert.equal(out.length, 4);
  // positions: 0, 0.5, 1, 1.5 -> 0, 0.5, 1, 1.0 (clamped)
  assert.ok(Math.abs(out[0] - 0) < 1e-4);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(out[2] - 1) < 1e-4);
  assert.ok(Math.abs(out[3] - 1) < 1e-4);
});

// ---- splitMp4Fragments (pure fMP4 box parser) ----

// Build a synthetic MP4 box: [size(4)][type(4)][payload]. size includes the 8-byte header.
function mp4Box(type, payload) {
  const size = 8 + payload.byteLength;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) dv.setUint8(4 + i, type.charCodeAt(i));
  new Uint8Array(buf, 8).set(new Uint8Array(payload));
  return new Uint8Array(buf);
}

test('splitMp4Fragments: extracts init (ftyp+moov) and each moof+mdat fragment', () => {
  const ftyp = mp4Box('ftyp', new Uint8Array([0, 0, 0, 1, 'i', 's', 'o', '5'].map(c => typeof c === 'string' ? c.charCodeAt(0) : c)));
  const moov = mp4Box('moov', new Uint8Array(32).fill(1));
  const moof1 = mp4Box('moof', new Uint8Array(16).fill(2));
  const mdat1 = mp4Box('mdat', new Uint8Array(64).fill(3));
  const moof2 = mp4Box('moof', new Uint8Array(16).fill(4));
  const mdat2 = mp4Box('mdat', new Uint8Array(64).fill(5));
  const file = new Uint8Array([...ftyp, ...moov, ...moof1, ...mdat1, ...moof2, ...mdat2]);
  const res = splitMp4Fragments(file.buffer);
  assert.ok(res, 'must parse a fragmented MP4');
  assert.equal(res.fragments.length, 2, 'two moof+mdat pairs -> two fragments');
  // init must contain ftyp (8+8=16) + moov (8+32=40) = 56 bytes
  assert.equal(res.init.size, 16 + 40);
  // each fragment = moof (8+16=24) + mdat (8+64=72) = 96
  assert.equal(res.fragments[0].size, 24 + 72);
  assert.equal(res.fragments[1].size, 24 + 72);
});

test('splitMp4Fragments: returns an Error (not fragmented) for a single-mdat file', () => {
  const ftyp = mp4Box('ftyp', new Uint8Array(8));
  const moov = mp4Box('moov', new Uint8Array(32));
  const mdat = mp4Box('mdat', new Uint8Array(128));
  const file = new Uint8Array([...ftyp, ...moov, ...mdat]);
  const res = splitMp4Fragments(file.buffer);
  assert.ok(res instanceof Error, 'no moof -> Error, not a valid fragment parse');
  assert.match(res.message, /not a fragmented mp4/);
  assert.match(res.message, /ftyp,moov,mdat/);
});

test('splitMp4Fragments: returns an Error for empty/garbage input', () => {
  assert.ok(splitMp4Fragments(new ArrayBuffer(0)) instanceof Error);
  assert.ok(splitMp4Fragments(new Uint8Array([1, 2, 3, 4, 5, 6, 7]).buffer) instanceof Error);
});

test('splitMp4Fragments: handles size==0 (extends to end) and size==1 (64-bit extended) boxes', () => {
  // Build: ftyp + moov + moof + a mdat whose size field is 0 (extends to end).
  const ftyp = mp4Box('ftyp', new Uint8Array(8));
  const moov = mp4Box('moov', new Uint8Array(32));
  const moof = mp4Box('moof', new Uint8Array(16));
  const mdatPayload = new Uint8Array(64).fill(9);
  const mdat = new Uint8Array(8 + mdatPayload.byteLength);
  new DataView(mdat.buffer).setUint32(0, 0); // size==0 → 到文件末尾
  mdat.set(new Uint8Array([0x6d, 0x64, 0x61, 0x74]), 4); // 'mdat'
  mdat.set(mdatPayload, 8);
  const file = new Uint8Array([...ftyp, ...moov, ...moof, ...mdat]);
  const res = splitMp4Fragments(file.buffer);
  assert.ok(res && !(res instanceof Error), 'size==0 mdat must still parse');
  assert.equal(res.fragments.length, 1);
});

test('transcodeAudioBlob: a fragmented fMP4 decodes straight via per-fragment decode (never whole-file)', async () => {
  // Build a synthetic fMP4 (init + 2 fragments). The decode mock would throw on
  // the whole file (>200 bytes, like the real 100min Edge bug) — but the new
  // flow NEVER calls decodeAudioData on the whole file for a fragmented input,
  // so it must succeed via per-fragment decode. This also guards the detached-
  // ArrayBuffer regression (splitMp4Fragments runs before any decode).
  const ftyp = mp4Box('ftyp', new Uint8Array(8));
  const moov = mp4Box('moov', new Uint8Array(32));
  const moof1 = mp4Box('moof', new Uint8Array(16));
  const mdat1 = mp4Box('mdat', new Uint8Array(64));
  const moof2 = mp4Box('moof', new Uint8Array(16));
  const mdat2 = mp4Box('mdat', new Uint8Array(64));
  const file = new Uint8Array([...ftyp, ...moov, ...moof1, ...mdat1, ...moof2, ...mdat2]);

  const saved = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext };
  const decodedSizes = [];
  globalThis.OfflineAudioContext = class {
    constructor(ch, frames, rate) { this.channels = ch; this.frames = frames; this.sampleRate = rate; }
    async decodeAudioData(buf) {
      decodedSizes.push(buf.byteLength);
      if (buf.byteLength > 200) throw new Error('Unable to decode audio data');
      return { sampleRate: 48000, length: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(48000) };
    }
    async close() {}
    destination = {};
    async startRendering() { return { getChannelData: () => new Float32Array(this.frames) }; }
  };
  globalThis.AudioContext = undefined; // force OfflineAudioContext path
  const res = await transcodeAudioBlob(new Blob([file], { type: 'video/mp4' }));
  assert.equal(res.ok, true, 'must succeed via per-fragment decode: ' + (res.error || ''));
  // whole file is 248 bytes — it must NEVER be passed to decodeAudioData
  assert.ok(decodedSizes.every((s) => s <= 200), 'whole-file buffer must not reach decodeAudioData: ' + decodedSizes.join(','));
  assert.equal(decodedSizes.length, 2, 'one decode per fragment (init+fragment unit), no whole-file attempt');
  // 2 fragments x 1s @48k -> 2s @16k = 32000 frames -> 44 + 64000 bytes
  assert.equal(res.wavBytes, 44 + 32000 * 2);
  globalThis.AudioContext = saved.AudioContext;
  globalThis.OfflineAudioContext = saved.OfflineAudioContext;
});

test('transcodeAudioBlob: fragmented input whose per-fragment decode fails reports the fragment error', async () => {
  const ftyp = mp4Box('ftyp', new Uint8Array(8));
  const moov = mp4Box('moov', new Uint8Array(32));
  const moof1 = mp4Box('moof', new Uint8Array(16));
  const mdat1 = mp4Box('mdat', new Uint8Array(64));
  const file = new Uint8Array([...ftyp, ...moov, ...moof1, ...mdat1]);

  const saved = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext };
  globalThis.OfflineAudioContext = class {
    constructor(ch, frames, rate) { this.channels = ch; this.frames = frames; this.sampleRate = rate; }
    async decodeAudioData() { throw new Error('Unable to decode audio data'); }
    async close() {}
    destination = {};
  };
  globalThis.AudioContext = undefined;
  const res = await transcodeAudioBlob(new Blob([file], { type: 'video/mp4' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /fragment decode failed/);
  globalThis.AudioContext = saved.AudioContext;
  globalThis.OfflineAudioContext = saved.OfflineAudioContext;
});

test('transcodeAudioBlob: non-fragmented (single mdat) file uses whole-file decode; failure includes parse diagnostic', async () => {
  const ftyp = mp4Box('ftyp', new Uint8Array(8));
  const moov = mp4Box('moov', new Uint8Array(32));
  const mdat = mp4Box('mdat', new Uint8Array(64));
  const file = new Uint8Array([...ftyp, ...moov, ...mdat]);

  const saved = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext };
  let wholeDecodeCount = 0;
  globalThis.OfflineAudioContext = class {
    constructor(ch, frames, rate) { this.channels = ch; this.frames = frames; this.sampleRate = rate; }
    async decodeAudioData(buf) {
      wholeDecodeCount++;
      // Non-fragmented file has no moof; the whole file is the only decodable unit.
      return { sampleRate: 48000, length: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(48000) };
    }
    async close() {}
    destination = {};
    async startRendering() { return { getChannelData: () => new Float32Array(this.frames) }; }
  };
  globalThis.AudioContext = undefined;
  const okRes = await transcodeAudioBlob(new Blob([file], { type: 'video/mp4' }));
  assert.equal(okRes.ok, true, 'non-fragmented decodes via whole-file path');
  assert.equal(wholeDecodeCount, 1, 'whole-file decode used exactly once');

  // Same file, but whole-file decode now fails → error must carry the parse diagnostic
  globalThis.OfflineAudioContext = class {
    constructor(ch, frames, rate) { this.channels = ch; this.frames = frames; this.sampleRate = rate; }
    async decodeAudioData() { throw new Error('Unable to decode audio data'); }
    async close() {}
    destination = {};
  };
  const failRes = await transcodeAudioBlob(new Blob([file], { type: 'video/mp4' }));
  assert.equal(failRes.ok, false);
  assert.match(failRes.error, /Unable to decode audio data/);
  assert.match(failRes.error, /not a fragmented mp4 \(boxes: ftyp,moov,mdat\)/);
  globalThis.AudioContext = saved.AudioContext;
  globalThis.OfflineAudioContext = saved.OfflineAudioContext;
});
