// lib/handlers/attach-asr-qwen.js — 阿里云百炼（DashScope）适配器。
//
// 从 attach-asr.js 拆出（2026-10-07 多供应商化整理；8-31 首版即此文件名，git
// 历史 b555380→de8ee2f）。覆盖两条协议族：
//   * Omni 系（qwen3.8/3.5-omni-*）：临时 OSS 上传 → OpenAI 兼容 chat/completions
//     流式（prompt 时间戳纪律，转写路径 reasoning_effort:'none'）+ 视听精读。
//   * 录音文件转写系（*-filetrans / fun-asr / paraformer）：异步任务 API——
//     原生毫秒时间戳 + 原生说话人分离，12h/2GB 上限，长音频主力。
// 流式解析与提示词来自 ./asr-shared.js（两家共用同一产物契约）；方舟适配器、
// 上传文件缓存与注册表在 attach-asr.js。

import {
  streamResponsesText,
  buildTranscribeInstructions, buildTranscribeTaskText,
  buildVideoAnalysisInstructions, buildVideoAnalysisTaskText,
} from './asr-shared.js';

// 官方默认端点（normalizeQwenBaseUrl 的空值兜底；attach-asr.js 经此处引用）。
export const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// ─── 阿里云百炼（DashScope）适配器：qwen3.8-omni-flash ──────────────────────────
// 官方文档研读（2026-10-06，docs.bailian.console.aliyun.com）：
//   * 输入限制（qwen3.8-omni-flash）：音频 公网URL ≤2GB/≤3h、base64 编码后 <10MB；
//     视频 URL ≤2GB/≤2h。base64 装不下长音频（16kHz mono WAV ≈32KB/s，10MB≈5 分钟），
//     公网 URL 对签名+IP 绑定的 CDN（googlevideo/B站，Referer/Cookie 由 DNR 注入）
//     必 403——与方舟 URL 直传 08-06 失败是同一根因。长音频唯一通路 = 「临时文件上传」：
//     getPolicy → OSS multipart → oss:// key（≤1GB、48 小时自动清理），
//     调用时传 oss:// 链接 + 请求头 X-DashScope-OssResourceResolve: enable（缺失则
//     请求失败，官方明示；OpenAI SDK 不支持该 header，browsa 手写 fetch 正好可加）。
//   * 请求形状（OpenAI 兼容 /chat/completions；与 Responses API 的 audio_url 结构不同）：
//       音频 {"type":"input_audio","input_audio":{"data":"<url>","format":"wav"}}
//       视频 {"type":"video_url","video_url":{"url":"..."}}
//     音视频输入只允许出现在 user 消息（system 只放文本纪律）。
//   * 与方舟 Files API 的三点行为差异（编排层/缓存据此分派，见 ASR_ADAPTERS）：
//       1. 无服务端预处理阶段 → 不需要 pollFileStatus 轮询（poll: null）；
//       2. oss:// 文件【绑定上传时指定的 model】且仅 48h → 文件缓存按 provider:model
//          作用域、TTL 48h（方舟 file_id 跨模型通用、30 天）；
//       3. 无文件存活探测 API（官方：文件无法查询/修改/下载）→ 缓存复用只查过期
//          （alive: null），过期文件在模型调用时报错、由管线的完整度守卫兜底。
//   * 时间戳：无原生 API 参数，靠 prompt（官方文档自带时间戳转写范例）——与方舟同构，
//     buildTranscribeInstructions/TaskText/buildVideoAnalysis* 与方舟共用同一份。
//   * 上传凭证（getPolicy）300s 过期、限流 100 QPS/主账号+模型；file 必须是 multipart
//     最后一个表单域；success_action_status=200，成功时无响应体。
//   * 上线前探针项（AGENTS.md 在档）：getPolicy 对 omni 模型的支持、max_tokens 65536
//     是否被兼容模式夹取（理论夹取；若 400 再回落模型真实上限）。

const QWEN_OSS_RESOLVE_HEADER = 'X-DashScope-OssResourceResolve';

/**
 * 规整百炼 Base URL（纯函数）：OpenAI 兼容模式端点，去尾斜杠；空值回默认。
 * （方舟的 api/plan 变体是方舟特有问题，百炼端点没有对应变体，不做改写。）
 */
export function normalizeQwenBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  return b || QWEN_DEFAULT_BASE_URL;
}

/** 百炼 API v1 根（同域）：临时文件上传 /tasks /asr transcription 都挂在 origin/api/v1 下。 */
export function qwenApiV1(baseUrl) {
  return new URL(normalizeQwenBaseUrl(baseUrl)).origin + '/api/v1';
}

/** 百炼临时文件上传 API 入口：同域 /api/v1/uploads（不在 compatible-mode 路径下）。 */
export function qwenUploadsEndpoint(baseUrl) {
  return `${qwenApiV1(baseUrl)}/uploads`;
}

/**
 * 百炼临时 OSS 上传（sidepanel/extension-context）：getPolicy 拿上传策略 →
 * multipart POST 到 OSS → 返回 "oss://dir/filename" 形态的 fileId（模型调用时
 * 配合 QWEN_OSS_RESOLVE_HEADER 使用）。model 必填且必须与后续调用的模型一致
 * （官方：文件与模型绑定，不同模型无法共享文件）。
 * @returns {Promise<{ok:true, fileId:string, bytes:number} | {ok:false, error:string}>}
 */
export async function uploadBlobToQwen({ blob, filename, apiKey, baseUrl, model, onProgress } = {}) {
  if (!blob) return { ok: false, error: 'no blob' };
  if (!apiKey) return { ok: false, error: 'no apiKey' };
  if (!model) return { ok: false, error: 'no model: 百炼上传策略按模型签发，必须与调用的模型一致' };
  try {
    // 第一步：getPolicy（Bearer key；凭证 300s 过期 → 拿到立刻传，不做任何间歇）。
    const ep = qwenUploadsEndpoint(baseUrl);
    const policyRes = await fetch(`${ep}?action=getPolicy&model=${encodeURIComponent(model)}`, {
      headers: { Authorization: 'Bearer ' + apiKey },
    });
    const policyJson = await policyRes.json().catch(() => null);
    const p = policyJson?.data || null;
    if (!policyRes.ok || !p?.policy || !p?.upload_host) {
      return { ok: false, error: 'getPolicy HTTP ' + policyRes.status + ': ' + JSON.stringify(policyJson || {}).slice(0, 300) };
    }
    const name = filename || 'audio.wav';
    if (p.max_file_size_mb && blob.size > p.max_file_size_mb * 1024 * 1024) {
      return { ok: false, error: `文件 ${(blob.size / 1024 / 1024).toFixed(0)}MB 超过该模型的上传上限 ${p.max_file_size_mb}MB` };
    }
    // 第二步：OSS multipart POST。字段顺序照官方文档：OSSAccessKeyId / Signature /
    // policy / key / x-oss-object-acl / x-oss-forbid-overwrite / success_action_status，
    // file 必须是最后一个表单域（FormData 按插入序发送）。与方舟同款 XHR 进度：
    // fetch 没有 upload 进度回调（无 onProgress 的测试/调用走 fetch 路径）。
    const buildFd = () => {
      const fd = new FormData();
      fd.append('OSSAccessKeyId', p.oss_access_key_id || '');
      fd.append('Signature', p.signature || '');
      fd.append('policy', p.policy || '');
      fd.append('key', `${p.upload_dir}/${name}`);
      if (p.x_oss_object_acl) fd.append('x-oss-object-acl', p.x_oss_object_acl);
      if (p.x_oss_forbid_overwrite) fd.append('x-oss-forbid-overwrite', String(p.x_oss_forbid_overwrite));
      fd.append('success_action_status', '200');
      fd.append('file', blob, name);
      return fd;
    };
    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      const result = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', p.upload_host);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          // success_action_status=200：成功时响应体为空，只看状态码。
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: 'OSS upload HTTP ' + xhr.status + ': ' + String(xhr.responseText || '').slice(0, 300) });
          }
        };
        xhr.onerror = () => resolve({ ok: false, error: 'OSS upload network error' });
        xhr.onabort = () => resolve({ ok: false, error: 'OSS upload aborted' });
        xhr.send(buildFd());
      });
      if (!result.ok) return result;
      onProgress(blob.size, blob.size);
      return { ok: true, fileId: `oss://${p.upload_dir}/${name}`, bytes: blob.size };
    }
    const ossRes = await fetch(p.upload_host, { method: 'POST', body: buildFd() });
    if (!ossRes.ok) {
      const errText = await ossRes.text().catch(() => '');
      return { ok: false, error: 'OSS upload HTTP ' + ossRes.status + ': ' + errText.slice(0, 300) };
    }
    // 第三步：模型调用用 "oss://" + key（见 qwenTranscribeAudio / qwenAnalyzeVideo）。
    return { ok: true, fileId: `oss://${p.upload_dir}/${name}`, bytes: blob.size };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 百炼适配器：对已上传的 oss:// 音频做 ASR 转写（OpenAI 兼容 /chat/completions 流式）。
 * 提示词与方舟适配器逐字同一套（buildTranscribeInstructions / buildTranscribeTaskText）。
 * fileId 形如 "oss://dashscope-instant/..."；请求头必须带
 * X-DashScope-OssResourceResolve: enable，否则 oss:// 链接无法解析。
 * format 固定 'wav'：两条管线的上传都经 transcodeAudioBlob 转成 16kHz mono WAV
 * （文件名 *.wav，与之一致）。
 * 超时/截断语义与 transcribeAudio 完全一致（共用 streamResponsesText）。
 */
export async function qwenTranscribeAudio({ baseUrl: rawBaseUrl, apiKey, fileId, model, language = 'zh', durationSec = 0, signal, idleTimeoutMs = 60_000, pollIntervalMs = 4000, hotwords }) {
  const baseUrl = normalizeQwenBaseUrl(rawBaseUrl);
  // 录音文件转写系（*-filetrans / fun-asr / paraformer）走异步任务 API：句级毫秒
  // 时间戳原生产出（不靠 prompt 纪律）、原生说话人分离、官方上限 12h/2GB、价格低
  // 一个量级——长音频/播客转写主力。Omni chat 路径保留：手填 omni 系模型时的
  // prompt 转写（带画面理解行为，见 qwenAnalyzeVideo）。
  if (isQwenFiletransModel(model)) {
    return transcribeQwenFiletrans({ baseUrl, apiKey, fileId, model, language, signal, pollIntervalMs, hotwords });
  }
  const body = {
    model,
    stream: true,
    // 与方舟同款逻辑：逐字转写长音频的输出远大于默认上限，必须显式放开（真实 bug：
    // 52:48 视频只出 33 分钟字幕）。兼容模式按文档语义对超出模型上限的值夹取；
    // 若实测 400 再回落模型真实上限（上线探针项，见上方块注释）。
    max_tokens: 65536,
    messages: [
      { role: 'system', content: buildTranscribeInstructions(language, durationSec) },
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: fileId, format: 'wav' } },
          { type: 'text', text: buildTranscribeTaskText(durationSec) },
        ],
      },
    ],
  };
  // qwen3.8/3.5-omni 默认 reasoning_effort='xhigh'（官方文档）：逐字转写是感知任务，
  // 深度推理不提升转写质量，只烧思考 token + 拖慢首字——显式关掉。仅对文档收录该
  // 参数的模型发送（老 omni 型号可能拒收未知参数，保持原样不发送）。精读路径保持
  // 默认档不动：推理对说话人归属与关键帧取舍或有帮助，且用户已验证默认档的精读质量。
  if (/^qwen3\.[85]-omni/.test(String(model).trim().toLowerCase())) {
    body.reasoning_effort = 'none';
  }
  return streamResponsesText({
    baseUrl, apiKey, body, signal, idleTimeoutMs,
    path: '/chat/completions',
    headers: { [QWEN_OSS_RESOLVE_HEADER]: 'enable' },
  });
}

/**
 * 百炼适配器：视听精读。对已上传的 oss:// 视频（+ 可选独立音频）发起
 * /chat/completions 流式请求，产出带 [mm:ss] 的精读文档。提示词与方舟
 * analyzeVideo 逐字同一套（buildVideoAnalysisInstructions / buildVideoAnalysisTaskText）。
 * audioFileId 为空 = durl 合一流路径（音轨在视频文件里，只传 video_url）。
 * 超时/截断语义与 transcribeAudio 完全一致（共用 streamResponsesText）。
 */
export async function qwenAnalyzeVideo({ baseUrl: rawBaseUrl, apiKey, videoFileId, audioFileId, model, language = 'zh', durationSec = 0, metaHint = '', signal, idleTimeoutMs = 60_000 }) {
  const baseUrl = normalizeQwenBaseUrl(rawBaseUrl);
  if (!videoFileId) throw new Error('no videoFileId');
  // 录音转写系是纯音频模型——兜底报错（正常情况下编排层已在模式卡就不出视频选项，
  // 见 attach-orchestrator 的 isQwenFiletransModel 门控）。
  if (isQwenFiletransModel(model)) {
    throw new Error('该模型只支持音频转写：视频精读请在「视频模型 ID」填一个 Omni 系模型（如 qwen3.8-omni-flash），或直接用音频转写');
  }
  // 音视频输入只允许出现在 user 消息（官方文档）；格式纪律放 system。
  const content = [{ type: 'video_url', video_url: { url: videoFileId } }];
  if (audioFileId) content.push({ type: 'input_audio', input_audio: { data: audioFileId, format: 'wav' } });
  content.push({ type: 'text', text: buildVideoAnalysisTaskText(durationSec, language, metaHint) });
  const body = {
    model,
    stream: true,
    max_tokens: 65536, // 与 qwenTranscribeAudio 同款放开逻辑
    messages: [
      { role: 'system', content: buildVideoAnalysisInstructions(language, durationSec) },
      { role: 'user', content },
    ],
  };
  return streamResponsesText({
    baseUrl, apiKey, body, signal, idleTimeoutMs,
    path: '/chat/completions',
    headers: { [QWEN_OSS_RESOLVE_HEADER]: 'enable' },
  });
}
export async function pingQwenAsr({ baseUrl, apiKey, model } = {}) {
  const b = normalizeQwenBaseUrl(baseUrl);
  if (!apiKey) return { ok: false, error: 'no apiKey' };
  try {
    // 第一跳：上传策略。getPolicy 按 model 签发——Base URL 填工作区专属
    // maas.aliyuncs.com 端点时，这一跳同时回答「该主机是否支持上传 API」。
    const t0 = Date.now();
    const policyRes = await fetch(`${qwenUploadsEndpoint(b)}?action=getPolicy&model=${encodeURIComponent(model || '')}`, {
      headers: { Authorization: 'Bearer ' + apiKey },
    });
    if (!policyRes.ok) {
      const j = await policyRes.json().catch(() => null);
      return { ok: false, error: `上传策略 HTTP ${policyRes.status}: ${JSON.stringify(j || {}).slice(0, 200)}` };
    }
    // 录音转写系（filetrans/fun-asr/paraformer）不吃 chat/completions——跳过第二跳，
    // 上传策略通过即视为可用（转写任务真正验证靠实际转写；任务 API 的失败在
    // transcribeQwenFiletrans 里响亮抛出）。
    if (isQwenFiletransModel(model)) {
      return { ok: true, ms: Date.now() - t0 };
    }
    // 第二跳：模型调用（生产同款 max_tokens 语义，见块注释）。
    const res = await fetch(`${b}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 65536 }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      return { ok: false, error: `模型调用 HTTP ${res.status}: ${JSON.stringify(j || {}).slice(0, 200)}` };
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
// ─── 录音文件转写（filetrans 异步任务 API）─────────────────────────────────────
// 百炼专用 ASR 系（qwen-audio-3.x-asr-flash-filetrans / qwen3-asr-flash-filetrans /
// fun-asr / paraformer）与 Omni 系走完全不同的协议，2026-10-07 移植自 08-31 被撤下的
// attach-asr-qwen.js（那次死于 OSS 上传网络不稳，任务 API 本身未及验证；字段形状按
// 2026-10 官方文档重新核对）：
//   POST {origin}/api/v1/services/audio/asr/transcription（X-DashScope-Async: enable
//         + X-DashScope-OssResourceResolve: enable——官方 RESTful 明确接受 oss:// 临时
//         URL，不要求公网地址）
//     → {output:{task_id}} → 轮询 GET {origin}/api/v1/tasks/{task_id} 到 SUCCEEDED
//     → GET output 的 transcription_url（签名 OSS JSON，24h 有效，免鉴权）
//     → {transcripts:[{sentences:[{begin_time,end_time,text,speaker_id?}]}]}
// 对 browsa 的意义：句级毫秒时间戳【原生产出】（不靠 prompt 纪律）、原生说话人分离、
// 官方上限 12h/2GB（Omni 音频只有 3h）——长音频/播客转写主力；纯音频，做不了精读。
// 提交 body 按模型族分形状（官方文档 2026-10）：Qwen-Audio-3.x-Filetrans/Fun-ASR/
// Paraformer 用 input.file_urls 数组、结果在 output.results[]；qwen3-asr-flash-filetrans
// 用 input.file_url 单对象、结果嵌在 output_result.output.result。两侧都防御性解析。

/** 是否走录音文件转写异步任务 API（filetrans 离线专用系 + fun-asr 系）。 */
export function isQwenFiletransModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return /-filetrans$/.test(m) || m.startsWith('fun-asr') || m.startsWith('paraformer');
}

function msToStamp(ms) {
  const total = Math.floor((Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 热词输入解析（纯函数，Node 可直接测试）：逗号/顿号/分号/换行分隔 → 去空壳、去重、
 * 按官方约束过滤（非 ASCII 词 ≤15 字符；纯 ASCII 按空格切分 ≤7 片段）。仅供百炼
 * filetrans 系的 parameters.vocabulary 使用（官方"即时热词"，Qwen-Audio-3.x-ASR-
 * Flash-Filetrans 系列文档化支持；omni chat 无此参数，不发送）。
 */
export function parseAsrHotwords(raw) {
  const out = [];
  const seen = new Set();
  for (const piece of String(raw || '').split(/[,，、;；\n\r]+/)) {
    const term = piece.trim();
    if (!term || seen.has(term)) continue;
    const asciiFragments = term.split(/\s+/).length;
    const nonAsciiLen = [...term].filter((ch) => ch.charCodeAt(0) > 127).length;
    // 官方约束：非 ASCII 总字符 ≤15；纯 ASCII 按空格切分 ≤7 片段。超限词丢弃
    //（防一个超长词让整次提交被拒），不做静默截断。
    if (nonAsciiLen > 15) continue;
    if (/^[\x00-\x7F]+$/.test(term) && asciiFragments > 7) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * filetrans 结果 JSON → browsa 字幕行（纯函数，Node 可直接测试）。句级 begin_time
 * 毫秒精确；说话人字段防御性解析（speaker_id / spk_id / speaker——不同模型的字段名
 * 文档不全，按常见形态接，真实响应到手后收敛）。有说话人 → 按全片首次出现顺序编号
 * [说话人N]（多人时全行标注）；解析不出/只有一人 → 无标签（与单人音频不标的协议一致）。
 */
export function filetransResultToLines(result) {
  const transcripts = Array.isArray(result?.transcripts) ? result.transcripts : [];
  const sentences = [];
  for (const t of transcripts) {
    for (const sen of (Array.isArray(t?.sentences) ? t.sentences : [])) {
      const text = String(sen?.text || '').trim();
      if (!text) continue;
      const speaker = sen?.speaker_id ?? sen?.spk_id ?? sen?.speaker;
      sentences.push({
        beginMs: Number(sen?.begin_time) || 0,
        text,
        speaker: speaker == null ? null : String(speaker),
      });
    }
  }
  sentences.sort((a, b) => a.beginMs - b.beginMs);
  const speakerNum = new Map();
  for (const sen of sentences) {
    if (sen.speaker != null && !speakerNum.has(sen.speaker)) {
      speakerNum.set(sen.speaker, speakerNum.size + 1);
    }
  }
  return sentences.map((sen) => {
    const label = sen.speaker != null && speakerNum.size > 1 ? ` [说话人${speakerNum.get(sen.speaker)}]` : '';
    return `[${msToStamp(sen.beginMs)}]${label} ${sen.text}`;
  }).join('\n');
}

/** 轮询转写任务到终态（SUCCEEDED 返回 output；FAILED/UNKNOWN/CANCELED 抛错）。 */
async function qwenTaskPoll({ apiV1, apiKey, taskId, signal, intervalMs }) {
  for (;;) {
    const res = await fetch(`${apiV1}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal,
    }).catch((e) => { throw new Error(`qwen task query failed: ${e.message}`); });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`qwen task query HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json().catch(() => null);
    const out = data?.output || data || {};
    const status = String(out.task_status || '').toUpperCase();
    if (status === 'SUCCEEDED') return out;
    if (status === 'FAILED' || status === 'UNKNOWN' || status === 'CANCELED') {
      throw new Error(`qwen 转写任务失败 (${status}): ${out.code || ''} ${out.message || ''}`.trim());
    }
    // PENDING/RUNNING → 等下一轮；超时预算由外层 AbortSignal.timeout 兜底
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    });
  }
}

/**
 * filetrans 转写：提交 → 轮询 → 拉结果 → 确定性映射。出参与 Omni chat 路径同构
 * （{ text, usage? }，永不 truncated——ASR 没有 token 上限概念）。失败全部响亮
 * 抛错（任务级失败带 code+message），不做静默回退——提交失败说明模型 ID 或文件
 * 引用有问题，回退只会掩盖配置错误。
 */
async function transcribeQwenFiletrans({ baseUrl, apiKey, fileId, model, language, signal, hotwords, pollIntervalMs = 4000 }) {
  const apiV1 = qwenApiV1(baseUrl);
  // 说话人分离：官方文档对整个异步族（Filetrans/Fun-ASR/Paraformer）文档化为
  // diarization_enabled，结果每句带 speaker_id；WAV 转码产物本就是单声道，满足
  // 分离的前提。language=auto 时不传 language_hints，让模型自检（官方要求语种
  // 不确定时不要指定）。
  const parameters = { diarization_enabled: true };
  if (language && language !== 'auto') parameters.language_hints = [language];
  // 即时热词（官方"提升语音识别准确率"页）：专有名词 → 词表匹配偏置，weight 取
  // 推荐值 4（50 是超级热词档，最多 50 个且有近音误识别风险，不默认用）。文档仅
  // 收录 Qwen-Audio-3.x-ASR-Flash 系列支持——fun-asr/paraformer/qwen3-asr 走本
  // 路径时不发（未文档化参数有被拒风险）。仅在用户填了词时发送。
  if (hotwords?.length && /^qwen-audio-/.test(String(model).trim().toLowerCase())) {
    parameters.vocabulary = Object.fromEntries(hotwords.map((t) => [t, 4]));
  }
  // qwen3-asr-flash-filetrans 用单数 file_url，其余（Qwen-Audio-3.x-Filetrans 等）
  // 用 file_urls 数组——按 2026-10 官方文档分形状，别混。
  const input = /^qwen3-asr-flash-filetrans/.test(String(model).trim().toLowerCase())
    ? { file_url: fileId }
    : { file_urls: [fileId] };
  const submit = await fetch(`${apiV1}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify({ model, input, parameters }),
    signal,
  }).catch((e) => { throw new Error(`qwen filetrans submit failed: ${e.message}`); });
  if (!submit.ok) {
    const text = await submit.text().catch(() => '');
    throw new Error(`qwen filetrans submit HTTP ${submit.status}: ${text.slice(0, 300)}`);
  }
  const subData = await submit.json().catch(() => null);
  const taskId = subData?.output?.task_id;
  if (!taskId) {
    throw new Error(`qwen filetrans submit 无 task_id: ${JSON.stringify(subData || {}).slice(0, 300)}`);
  }
  console.log('[ASR] qwen filetrans task submitted:', taskId, '| model:', model);
  let out;
  try {
    out = await qwenTaskPoll({ apiV1, apiKey, taskId, signal, intervalMs: pollIntervalMs });
  } catch (e) {
    if (signal?.aborted) {
      throw new Error('qwen 转写任务轮询中止：超时预算用尽（长音频转写通常需要数倍于实时的时间，重试即可）');
    }
    throw e;
  }
  const url = out?.result?.transcription_url
    || out?.results?.[0]?.transcription_url
    || out?.output_result?.output?.result?.transcription_url
    || '';
  if (!url) {
    throw new Error(`qwen filetrans 任务成功但无 transcription_url: ${JSON.stringify(out).slice(0, 300)}`);
  }
  // transcription_url 是带签名的 OSS JSON 地址（24 小时有效），无需鉴权直接 GET
  const res = await fetch(url, { signal }).catch((e) => { throw new Error(`qwen filetrans result fetch failed: ${e.message}`); });
  if (!res.ok) throw new Error(`qwen filetrans result HTTP ${res.status}`);
  const result = await res.json().catch(() => null);
  const text = filetransResultToLines(result);
  const usageSecs = Number(out?.usage?.seconds) || Number(out?.usage?.duration) || 0;
  console.log(`[ASR] qwen filetrans: ${text ? text.split('\n').length : 0} lines, usage=${JSON.stringify(out?.usage || {})}`);
  return {
    text,
    raw: JSON.stringify(result),
    ...(usageSecs > 0 ? { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds: usageSecs } } : {}),
  };
}
