// test/lib-asr-qwen.test.mjs — 阿里云百炼（qwen3.8-omni-flash）适配器单元测试。
// 覆盖：注册表元数据、适配器注册表形状（upload/poll/alive/TTL 钩子）、
// uploadBlobToQwen 的 getPolicy→OSS 两步流（字段顺序/file-last/oss:// key）、
// qwenTranscribeAudio / qwenAnalyzeVideo 的 chat completions 请求形状
// （input_audio.data=URL + format、video_url.url、resolve 头、提示词契约）、
// 上传文件缓存的 provider:model 作用域与 48h TTL。全部走 mock fetch/小 blob。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASR_PROVIDERS, getAsrProvider,
} from '../lib/asr-providers.js';
import {
  asrAdapterFor, uploadBlobToArk, pollFileStatus, arkFileAlive, uploadBlobToQwen,
  qwenTranscribeAudio, qwenAnalyzeVideo, normalizeQwenBaseUrl, qwenUploadsEndpoint,
  arkFileCacheKey, lookupCachedArkFiles, saveArkFileCacheEntry,
  pingQwenAsr, pingArkAsr,
} from '../lib/handlers/attach-asr.js';

const QWEN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// ─── 注册表与适配器分发 ───────────────────────────────────────────────────────

test('注册表：qwen 元数据齐全（官方百炼主体，UI 下拉/占位符/提示/文档链接全靠它驱动）', () => {
  const q = ASR_PROVIDERS.qwen;
  assert.ok(q, 'qwen 必须在注册表');
  assert.equal(q.id, 'qwen');
  assert.ok(q.label);
  assert.equal(q.defaultBaseUrl, QWEN_BASE);
  assert.equal(q.defaultModel, 'qwen-audio-3.1-asr-flash-filetrans', '音频转写默认 = 专用 ASR');
  assert.equal(q.defaultVideoModel, 'qwen3.8-omni-flash', '音视频精读默认 = omni 全模态');
  assert.ok(q.apiKeyPlaceholder);
  assert.match(q.baseUrlTip, /api\/v1\/uploads/, '提示必须交代临时文件上传端点');
  assert.match(q.docUrl, /^https:\/\/docs\.bailian\.console\.aliyun\.com/);
  assert.ok(q.docLabel);
  assert.equal(getAsrProvider('qwen'), q);
});

test('适配器注册表：qwen 协议函数 + upload/poll/alive/TTL 钩子（编排层据此分派）', () => {
  const q = asrAdapterFor('qwen');
  assert.equal(q.transcribeAudio, qwenTranscribeAudio);
  assert.equal(q.analyzeVideo, qwenAnalyzeVideo);
  assert.equal(q.upload, uploadBlobToQwen);
  assert.equal(q.poll, null, '百炼无服务端预处理 → 不轮询');
  assert.equal(q.alive, null, '百炼 oss:// 无查询 API → 缓存复用只查过期');
  assert.equal(q.fileCacheTtlSec, 48 * 3600, 'oss:// 临时文件 48h 自动清理');
  assert.equal(asrAdapterFor('nope'), asrAdapterFor('ark'), '未知 id 回退 ark');

  const ark = asrAdapterFor('ark');
  assert.equal(ark.upload, uploadBlobToArk);
  assert.equal(ark.poll, pollFileStatus);
  assert.equal(ark.alive, arkFileAlive);
  assert.equal(ark.fileCacheTtlSec, 30 * 86400);
});

// ─── uploadBlobToQwen：getPolicy → OSS multipart → oss:// key ────────────────

function fakeBlob(size = 1024) {
  return new Blob([new Uint8Array(size)]);
}

test('normalizeQwenBaseUrl / qwenUploadsEndpoint：端点规整与 uploads 同域推导', () => {
  assert.equal(normalizeQwenBaseUrl(QWEN_BASE + '/'), QWEN_BASE);
  assert.equal(normalizeQwenBaseUrl(''), QWEN_BASE);
  assert.equal(normalizeQwenBaseUrl(undefined), QWEN_BASE);
  assert.equal(qwenUploadsEndpoint(QWEN_BASE), 'https://dashscope.aliyuncs.com/api/v1/uploads');
  assert.equal(qwenUploadsEndpoint(QWEN_BASE + '/'), 'https://dashscope.aliyuncs.com/api/v1/uploads');
});

test('uploadBlobToQwen: getPolicy（model 绑定）→ OSS multipart（file 最后）→ oss:// key', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash');
      assert.equal(init.headers.Authorization, 'Bearer sk-test');
      return {
        ok: true,
        json: async () => ({
          request_id: 'r1',
          data: {
            policy: 'POLICY-B64', signature: 'SIG', upload_dir: 'dashscope-instant/x/2026-10-06',
            upload_host: 'https://dashscope-file.oss-cn-beijing.aliyuncs.com',
            oss_access_key_id: 'AK', x_oss_object_acl: 'private', x_oss_forbid_overwrite: true,
            max_file_size_mb: 100,
          },
        }),
      };
    }
    // OSS POST：文档规定的字段顺序，file 必须是最后一个表单域
    const fd = init.body;
    assert.ok(fd instanceof globalThis.FormData, 'OSS 上传必须是 multipart FormData');
    assert.deepEqual([...fd.keys()], [
      'OSSAccessKeyId', 'Signature', 'policy', 'key',
      'x-oss-object-acl', 'x-oss-forbid-overwrite', 'success_action_status', 'file',
    ], '字段顺序照文档，file 最后');
    assert.equal(fd.get('OSSAccessKeyId'), 'AK');
    assert.equal(fd.get('policy'), 'POLICY-B64');
    assert.equal(fd.get('key'), 'dashscope-instant/x/2026-10-06/audio.wav');
    assert.equal(fd.get('x-oss-object-acl'), 'private');
    assert.equal(fd.get('x-oss-forbid-overwrite'), 'true');
    assert.equal(fd.get('success_action_status'), '200');
    assert.equal(fd.get('file').name, 'audio.wav');
    return { ok: true, status: 200, text: async () => '' };
  };
  const res = await uploadBlobToQwen({
    blob: fakeBlob(2048), filename: 'audio.wav', apiKey: 'sk-test',
    baseUrl: QWEN_BASE, model: 'qwen3.8-omni-flash',
  });
  assert.equal(res.ok, true);
  assert.equal(res.fileId, 'oss://dashscope-instant/x/2026-10-06/audio.wav', '模型调用用的就是 oss:// key');
  assert.equal(res.bytes, 2048);
  assert.equal(calls.length, 2);
  delete globalThis.fetch;
});

test('uploadBlobToQwen: 失败路径（getPolicy 错误 / 超上限 / 缺 model / OSS 非 2xx）', async () => {
  // getPolicy 4xx：错误信息透出（含 dashscope 的 code/message JSON）
  globalThis.fetch = async () => ({
    ok: false, status: 403,
    json: async () => ({ code: 'AccessDenied', message: 'Policy expired' }),
  });
  let res = await uploadBlobToQwen({ blob: fakeBlob(), apiKey: 'k', baseUrl: QWEN_BASE, model: 'm' });
  assert.equal(res.ok, false);
  assert.match(res.error, /getPolicy HTTP 403/);
  assert.match(res.error, /Policy expired/);
  delete globalThis.fetch;

  // blob 超 max_file_size_mb：拿到策略后、上传前就拒绝（不白发几百 MB）
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ data: { policy: 'p', signature: 's', upload_dir: 'd', upload_host: 'https://oss.example.com', max_file_size_mb: 1 } }),
  });
  res = await uploadBlobToQwen({ blob: fakeBlob(2 * 1024 * 1024), apiKey: 'k', baseUrl: QWEN_BASE, model: 'm' });
  assert.equal(res.ok, false);
  assert.match(res.error, /上传上限 1MB/);
  delete globalThis.fetch;

  // 缺 model：上传策略按模型签发，必须显式拒绝而不是猜
  res = await uploadBlobToQwen({ blob: fakeBlob(), apiKey: 'k', baseUrl: QWEN_BASE });
  assert.equal(res.ok, false);
  assert.match(res.error, /no model/);

  // OSS 非 2xx
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/v1/uploads')) {
      return { ok: true, json: async () => ({ data: { policy: 'p', signature: 's', upload_dir: 'd', upload_host: 'https://oss.example.com' } }) };
    }
    return { ok: false, status: 400, text: async () => 'MalformedPOSTRequest' };
  };
  res = await uploadBlobToQwen({ blob: fakeBlob(), apiKey: 'k', baseUrl: QWEN_BASE, model: 'm' });
  assert.equal(res.ok, false);
  assert.match(res.error, /OSS upload HTTP 400/);
  delete globalThis.fetch;
});

// ─── qwenTranscribeAudio / qwenAnalyzeVideo：chat completions 请求形状 ────────

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

const CHAT_DELTA_1 = 'data: {"choices":[{"delta":{"content":"[00:00] 你好"}}]}\n\n';
const CHAT_DELTA_2 = 'data: {"choices":[{"delta":{"content":"，世界。"}}]}\n\ndata: [DONE]\n\n';
const OSS_KEY = 'oss://dashscope-instant/x/audio.wav';

test('qwenTranscribeAudio: POST /chat/completions 带 resolve 头；音频走 input_audio.data=URL+format', async () => {
  let url, init, body;
  globalThis.fetch = async (u, i) => {
    url = String(u); init = i;
    body = JSON.parse(i.body);
    return { ok: true, body: sseBody(CHAT_DELTA_1, CHAT_DELTA_2) };
  };
  const res = await qwenTranscribeAudio({
    baseUrl: QWEN_BASE, apiKey: 'sk-test', fileId: OSS_KEY,
    model: 'qwen3.8-omni-flash', language: 'zh', idleTimeoutMs: 1000,
  });
  assert.equal(res.text, '[00:00] 你好，世界。', 'chat 形态的 choices[].delta.content 增量被累积');
  assert.equal(url, QWEN_BASE + '/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.equal(init.headers['X-DashScope-OssResourceResolve'], 'enable', '缺失该头 oss:// 链接无法解析（官方明示）');
  assert.equal(body.stream, true, '长音频必须流式（同步等待会超时）');
  assert.equal(body.model, 'qwen3.8-omni-flash');
  assert.equal(body.max_tokens, 65536, '转写输出必须放开上限（52:48 视频只出 33 分钟字幕的教训）');
  // 格式纪律在 system 消息（音视频输入只允许出现在 user 消息）
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /\[mm:ss\]/);
  assert.match(body.messages[0].content, /ONE sentence per line/);
  assert.match(body.messages[0].content, /说话人/);
  assert.match(body.messages[0].content, /音频语种为 zh/);
  // user 消息：音频 part 用官方 chat 形态（data 持 URL，与 Responses API 的 audio_url 不同）
  const parts = body.messages[1].content;
  assert.equal(parts[0].type, 'input_audio');
  assert.equal(parts[0].input_audio.data, OSS_KEY);
  assert.equal(parts[0].input_audio.format, 'wav', '管线固定转码 16kHz mono WAV');
  assert.match(parts[1].text, /请逐字转写/);
  assert.match(parts[1].text, /\[01:02\]/, '裸秒数禁令在任务文本里');
  // qwen3.8-omni 默认 reasoning_effort='xhigh'（官方文档）——逐字转写是感知任务，显式关掉
  assert.equal(body.reasoning_effort, 'none');
  // 逐字纪律加锋（qwen-omni 文档：preserve original wording, don't translate or correct）
  assert.match(body.messages[0].content, /NEVER translate and never "correct"/);
  delete globalThis.fetch;
});

test('qwenTranscribeAudio: 老 omni 型号不发 reasoning_effort（未知参数可能被拒）', async () => {
  let body;
  globalThis.fetch = async (u, i) => {
    body = JSON.parse(i.body);
    return { ok: true, body: sseBody(CHAT_DELTA_1, CHAT_DELTA_2) };
  };
  await qwenTranscribeAudio({
    baseUrl: QWEN_BASE, apiKey: 'k', fileId: OSS_KEY,
    model: 'qwen-omni-turbo', idleTimeoutMs: 1000,
  });
  assert.equal(body.reasoning_effort, undefined, '仅 qwen3.8/3.5-omni 文档收录该参数');
  delete globalThis.fetch;
});

test('qwenTranscribeAudio: durationSec 注入 90% 覆盖锚点；language auto 不注入具体语种', async () => {
  let body;
  globalThis.fetch = async (u, i) => {
    body = JSON.parse(i.body);
    return { ok: true, body: sseBody(CHAT_DELTA_1, CHAT_DELTA_2) };
  };
  await qwenTranscribeAudio({
    baseUrl: QWEN_BASE, apiKey: 'k', fileId: OSS_KEY, model: 'm',
    language: 'auto', durationSec: 600, idleTimeoutMs: 1000,
  });
  assert.match(body.messages[0].content, /COVERAGE REQUIREMENT/);
  assert.match(body.messages[0].content, /\[09:00\]/, '600s 的 90% 锚点');
  assert.match(body.messages[1].content.find((p) => p.type === 'text').text, /不得早于 \[09:00\]/);
  assert.doesNotMatch(body.messages[0].content, /音频语种为/, 'auto 不给具体语种');
  assert.match(body.messages[0].content, /自动检测/);
  delete globalThis.fetch;
});

test('qwenTranscribeAudio: finish_reason=length → truncated:true（调用方拒绝半截字幕）', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    body: sseBody(CHAT_DELTA_1, 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'),
  });
  const res = await qwenTranscribeAudio({
    baseUrl: QWEN_BASE, apiKey: 'k', fileId: OSS_KEY, model: 'm', idleTimeoutMs: 1000,
  });
  assert.equal(res.truncated, true);
  assert.equal(res.finishReason, 'length');
  delete globalThis.fetch;
});

test('qwenAnalyzeVideo: video_url + 可选 input_audio + 画面/语音提示词，同一 resolve 头', async () => {
  let body;
  globalThis.fetch = async (u, i) => {
    body = JSON.parse(i.body);
    return { ok: true, body: sseBody(CHAT_DELTA_1, CHAT_DELTA_2) };
  };
  const VKEY = 'oss://dashscope-instant/x/video.mp4';
  await qwenAnalyzeVideo({
    baseUrl: QWEN_BASE, apiKey: 'k', videoFileId: VKEY, audioFileId: OSS_KEY,
    model: 'm', language: 'zh', durationSec: 0, metaHint: '标题', idleTimeoutMs: 1000,
  });
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /AUDIOVISUAL READING/);
  assert.match(body.messages[0].content, /\[截屏\]/, '关键帧标记纪律在 system');
  assert.match(body.messages[0].content, /fewer unconfirmable details than to hallucinate/,
    '「画面」行反幻觉纪律（qwen-omni 文档 AV prompt 同款规则）');
  assert.match(body.messages[1].content[2].text, /绝不猜测或脑补/, '中文任务文本同步');
  const parts = body.messages[1].content;
  assert.equal(parts[0].type, 'video_url');
  assert.equal(parts[0].video_url.url, VKEY);
  assert.equal(parts[1].type, 'input_audio');
  assert.equal(parts[1].input_audio.data, OSS_KEY);
  assert.match(parts[2].text, /视听精读/);
  assert.match(parts[2].text, /视频元信息/, 'metaHint 进任务文本');

  // durl 合一流路径：无独立音频 → 只有 video_url + text
  await qwenAnalyzeVideo({
    baseUrl: QWEN_BASE, apiKey: 'k', videoFileId: VKEY, audioFileId: null,
    model: 'm', idleTimeoutMs: 1000,
  });
  const parts2 = body.messages[1].content;
  assert.equal(parts2.length, 2, '无音频时只传 video_url + text');
  assert.equal(parts2[0].type, 'video_url');
  assert.equal(parts2[1].type, 'text');
  delete globalThis.fetch;
});

test('qwenAnalyzeVideo: 缺 videoFileId 直接抛错（编排层保证非空，防御性契约）', async () => {
  await assert.rejects(
    () => qwenAnalyzeVideo({ baseUrl: QWEN_BASE, apiKey: 'k', videoFileId: '', model: 'm' }),
    /no videoFileId/,
  );
});

// ─── 上传文件缓存：provider:model 作用域 + 48h TTL ────────────────────────────

function makeStorage() {
  const store = {};
  return {
    area: {
      get: async (k) => (k in store ? { [k]: store[k] } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = v; },
    },
    store,
  };
}

test('arkFileCacheKey: ark 条目保持原始 key（已存缓存不作废）；qwen 条目追加 provider:model', () => {
  const base = arkFileCacheKey(QWEN_BASE, 'sk-test', 'bili-BV1-p1');
  assert.equal(base, arkFileCacheKey(QWEN_BASE, 'sk-test', 'bili-BV1-p1', 'ark'));
  assert.doesNotMatch(base, /qwen/);
  const scoped = arkFileCacheKey(QWEN_BASE, 'sk-test', 'bili-BV1-p1', 'qwen', 'qwen3.8-omni-flash');
  assert.match(scoped, /\|qwen:qwen3\.8-omni-flash$/, 'oss:// 绑模型：换模型不能复用旧文件');
  assert.notEqual(base, scoped);
  // 无 model 的 qwen 条目与有 model 的分开（防御：不该出现，但 key 不碰撞）
  assert.notEqual(scoped, arkFileCacheKey(QWEN_BASE, 'sk-test', 'bili-BV1-p1', 'qwen'));
});

test('saveArkFileCacheEntry + lookupCachedArkFiles: qwen 条目 48h 过期、跳过存活探测、模型作用域隔离', async () => {
  const { area, store } = makeStorage();
  const common = { baseUrl: QWEN_BASE, apiKey: 'sk-test', platform: 'bilibili', pageUrl: 'https://www.bilibili.com/video/BV1abc', storageArea: area };
  await saveArkFileCacheEntry({
    ...common, audioFileId: OSS_KEY, durationSec: 600,
    provider: 'qwen', model: 'qwen3.8-omni-flash', ttlSec: 48 * 3600,
  });
  const raw = Object.values(store)[0];
  const entry = raw[arkFileCacheKey(QWEN_BASE, 'sk-test', 'bili-BV1abc-p1', 'qwen', 'qwen3.8-omni-flash')];
  assert.ok(entry, '条目以 provider:model 作用域的 key 落盘');
  const age = entry.audioExpireAt - Math.floor(Date.now() / 1000);
  assert.ok(age > 47 * 3600 && age <= 48 * 3600, `TTL = 48h（实测 ${Math.round(age / 3600)}h）`);

  // 命中：同 provider+model；aliveFn:null = 跳过方舟的 GET /files/{id} 探测
  //（百炼没有查询 API——若误走 alive 探测会对 dashscope 发无意义请求）
  const hit = await lookupCachedArkFiles({
    ...common, need: 'audio', durationSec: 600,
    provider: 'qwen', model: 'qwen3.8-omni-flash', aliveFn: null,
  });
  assert.equal(hit?.audioFileId, OSS_KEY);

  // 换模型 → 不命中（oss:// 绑模型）
  const miss = await lookupCachedArkFiles({
    ...common, need: 'audio', durationSec: 600,
    provider: 'qwen', model: 'qwen3.5-omni', aliveFn: null,
  });
  assert.equal(miss, null);

  // ark 条目与 qwen 条目互不串（同一视频资产、不同作用域 key）
  await saveArkFileCacheEntry({ ...common, audioFileId: 'file-ark-1', durationSec: 600 });
  const arkHit = await lookupCachedArkFiles({ ...common, need: 'audio', durationSec: 600, aliveFn: async () => true });
  assert.equal(arkHit?.audioFileId, 'file-ark-1', 'ark 默认路径行为不变');
});

// ─── ping 探针（options「测试连接」按钮）───────────────────────────────────────

test('适配器注册表带 ping 钩子（ark=Responses 最小补全；qwen=上传策略+chat 两跳）', () => {
  assert.equal(asrAdapterFor('ark').ping, pingArkAsr);
  assert.equal(asrAdapterFor('qwen').ping, pingQwenAsr);
});

test('pingQwenAsr: 两跳——getPolicy（上传策略按模型签发）→ chat/completions（生产同款 max_tokens）', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash');
      assert.equal(init.headers.Authorization, 'Bearer sk-test');
      return { ok: true, json: async () => ({ data: { policy: 'p', upload_host: 'https://oss.example.com' } }) };
    }
    const body = JSON.parse(init.body);
    assert.equal(url, QWEN_BASE + '/chat/completions');
    assert.equal(body.model, 'qwen3.8-omni-flash');
    assert.equal(body.max_tokens, 65536, '探针沿用生产 max_tokens——若 400 点名 max_tokens 即生产会踩的坑');
    assert.equal(init.headers['X-DashScope-OssResourceResolve'], undefined, '纯文本探针不涉及 oss://，无需解析头');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
  };
  const r = await pingQwenAsr({ baseUrl: QWEN_BASE, apiKey: 'sk-test', model: 'qwen3.8-omni-flash' });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.ms));
  assert.equal(calls.length, 2);
  delete globalThis.fetch;
});

test('pingQwenAsr: 上传策略一跳失败即报「上传策略」前缀（工作区端点不支持上传时在这里现形）', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ code: 'NotFound', message: 'no uploads' }) });
  const r = await pingQwenAsr({ baseUrl: QWEN_BASE, apiKey: 'k', model: 'm' });
  assert.equal(r.ok, false);
  assert.match(r.error, /上传策略 HTTP 404/);
  assert.match(r.error, /no uploads/);
  delete globalThis.fetch;
});

test('pingArkAsr: POST {base}/responses 最小补全（input_text + max_output_tokens 16）', async () => {
  let url, init;
  globalThis.fetch = async (u, i) => {
    url = String(u); init = i;
    return { ok: true, json: async () => ({ id: 'resp-1', output: [] }) };
  };
  const r = await pingArkAsr({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k', model: 'doubao-seed-2-1-lite-260915' });
  assert.equal(r.ok, true);
  assert.match(url, /\/responses$/);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'doubao-seed-2-1-lite-260915');
  assert.equal(body.max_output_tokens, 16);
  assert.equal(body.input[0].content[0].type, 'input_text');
  delete globalThis.fetch;
});

test('pingArkAsr / pingQwenAsr: HTTP 错误透出状态码与响应体摘要；无 Key 拒发', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'InvalidApiKey' } }) });
  let r = await pingArkAsr({ baseUrl: 'b', apiKey: 'k', model: 'm' });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 401/);
  assert.match(r.error, /InvalidApiKey/);
  delete globalThis.fetch;

  r = await pingQwenAsr({ baseUrl: QWEN_BASE, apiKey: '', model: 'm' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no apiKey/);
  r = await pingArkAsr({ baseUrl: 'b', apiKey: '', model: 'm' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no apiKey/);
});
