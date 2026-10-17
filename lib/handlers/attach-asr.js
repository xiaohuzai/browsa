// lib/handlers/attach-asr.js — ASR/视听精读多供应商门面 + 火山方舟适配器。
//
// 本文件是 ASR 域的 facade：ASR_PROVIDERS 注册表、asrAdapterFor 分发、上传文件
// 复用缓存、转码与字幕后处理都住这里；各供应商协议适配器分文件存放——
//   * 火山方舟（本文件后半）：Files API 上传 → Responses API，transcribeAudio/analyzeVideo。
//   * 阿里云百炼（./attach-asr-qwen.js）：omni chat + filetrans 异步任务，uploadBlobToQwen 等。
//   * 共享流式底层与提示词（./asr-shared.js）：两家共用同一产物契约，防漂移。
// 以下为方舟适配器的原始背景（08-06→08-16 的完整来龙去脉）：
//
// 背景（完整来龙去脉见 OpenViking memory "火山ASR适配器开发完成" / "browsa_asr_error_diagnosis"）：
//   * 08-06 第一版走的是 openspeech auc 的「URL 直传」submit/query，代码做完但实测即败：
//     B站 CDN 的签名 m4s URL 绑定用户会话 IP（uipk/upsig），火山 auc 服务器从它自己 IP
//     fetch 不到 → 返回空 {} → fail-open。URL 直传这条路根上断了。
//   * 08-07 定位到根因就是这个 IP 绑定。08-08 推演出替代路线：浏览器（用户 IP 匹配）自己
//     fetch 音频 bytes → 上传到方舟 Files API（≤512MB，multipart）→ 方舟读自己存储做 ASR，
//     彻底绕开 IP 绑定。当时唯一缺的「怎么在扩展里拿到 bytes 还不撑爆 messaging」在
//     PR #56 音频下载功能落地后补齐（page-world fetch + blob 已有先例）。
//
// 08-16 实机定位到第二层问题（文件状态 failed）：B站 m4s 是 MP4 容器（fMP4，ftyp=iso5，
// 纯音频无视频轨）。方舟 Files API 按【文件内容】把它识别成“视频”，走视频预处理路径，
// 但 m4s 没有视频流 → InvalidArgumentError("Invalid video_url.") → 文件状态 failed →
// Responses API 转写时拒绝。改文件名/MIME/加 preprocess_configs 参数都无效（按内容判定）。
// 已实测：16kHz mono WAV 上传 → active → 转写成功（全链路 OK）。所以下载后必须先转码成
// 方舟支持且不会被误判为视频的纯音频格式（WAV）。转码用 Web Audio API decodeAudioData
// （Chrome 原生支持 fMP4/AAC 解码）→ 重采样 16kHz mono → PCM WAV。
//
// 本模块就是 08-08 推演的那条路（+ 08-16 转码层）：
//   [下载]    sidepanel 扩展上下文（非页面世界）：fetch(m4s, 带 Referer[经 DNR 注入] + 用户 IP)。
//   [转码]    Web Audio API decodeAudioData → 16kHz mono PCM → WAV（方舟支持，且不会被误判为视频）。
//   [上传]    FormData POST 到 /api/v3/files（expire_at=30 天上限）→ 返回 file_id。
//              file_id 存 chrome.storage.local（browsaArkFileCache），同一视频 30 天内
//              再解析直接复用，免重传（Files API 官方用法：File ID 支持多次请求重复使用；
//              复用前 GET /files/{id} 校验仍在）。
//   [轮询+转写] 轮询 GET /api/v3/files/{id} 直到非 processing，再 POST /api/v3/responses 带
//              input_audio.file_id + ASR 指令 → 带 [mm:ss] 的字幕文本。
//
// 函数分两类：
//   * sidepanel/extension-context 函数：普通 async，可 import 本模块其它函数，跑在带
//     host_permissions 的扩展上下文（免 CORS）。
//   * 纯函数（encodePcmToWav 等）：无浏览器依赖，Node 可直接测试。

/**
 * 字幕来源偏好（options 下拉框的两个选项）。
 *  - 'original'：优先视频自带字幕 —— 有字幕就不动，只有无字幕时才用 ASR 补齐。
 *  - 'asr'：优先 ASR 解析字幕 —— 始终用 ASR 转写，并用 ASR 结果【替换】原字幕
 *    （适合原字幕质量不高、错字/漏句/翻译生硬的视频）。
 */
import {
  streamResponsesText,
  buildTranscribeInstructions, buildTranscribeTaskText,
  buildVideoAnalysisInstructions, buildVideoAnalysisTaskText,
} from './asr-shared.js';
import {
  uploadBlobToQwen, qwenTranscribeAudio, qwenAnalyzeVideo, pingQwenAsr, QWEN_DEFAULT_BASE_URL,
} from './attach-asr-qwen.js';

export const ASR_SUBTITLE_SOURCE = {
  ORIGINAL: 'original',
  ASR: 'asr',
};

// 两家供应商的官方默认端点（各适配器的 normalize* 以此兜底空值）。

/**
 * 默认 ASR 配置（与 storage.js 的 asr DEFAULTS 保持同步）。
 * 2026-10-07 用户定调：默认供应商翻为阿里云百炼（qwen）。⚠ 老配置兼容见
 * attach-asr-pending.js 的 provider 推断——provider 字段引入前的方舟用户存有
 * ark 的 baseUrl/model 但没有 provider，不能被默认翻转静默切走。
 */
export const ASR_DEFAULTS = {
  enabled: false,
  provider: 'qwen',                              // 服务商（ASR_PROVIDERS 注册表）；决定走哪条协议适配器
  apiKey: '',                                    // 所选供应商的 Bearer key（百炼 sk- / 方舟 UUID 或 ark-）
  baseUrl: QWEN_DEFAULT_BASE_URL,
  model: 'qwen-audio-3.1-asr-flash-filetrans',   // 音频转写模型 ID（百炼专用 ASR；方舟用户存配置时覆盖回 doubao 系）
  videoModel: 'qwen3.8-omni-flash',              // 音视频精读模型 ID（omni 全模态；方舟用户存配置时覆盖留空回退 model）
  language: 'zh',                                // 识别语种（'auto' = 自动检测）
  hotwords: '',                                  // 热词（逗号/换行分隔，可选）——百炼 filetrans 系即时热词，提升专有名词准确率
  format: 'audio/x-m4a',                         // 上传 MIME（B站 m4s 是 fMP4；08-16 起转码后实际传 WAV）
  timeoutMs: 150_000,                            // 轮询总预算
  subtitleSource: ASR_SUBTITLE_SOURCE.ORIGINAL,  // 字幕来源偏好（见上方常量）
};

/** ASR 转码目标：16kHz 单声道（语音识别标准，文件小，方舟支持）。 */
const TRANSCODE_SAMPLE_RATE = 16000;
const TRANSCODE_CHANNELS = 1;

/** 上传后等待文件处理的轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 2000;

// ─── Ark Files 复用缓存 ────────────────────────────────────────────────────────
// Files API 官方定位就是「File ID 支持在多次请求中重复使用，避免重复上传」。这里把
// 上传成功的 file_id 按「baseUrl + key 指纹 + 视频资产标识」存 chrome.storage.local，
// 同一视频 30 天内再解析时直接复用，免掉最慢最容易失败的上传段（音频模式连下载+转码
// 一起免掉）。任何一环不可用（storage 缺失 / entry 损坏 / 文件过期 404）都 fail-open
// 回退完整上传流程，绝不因缓存引入新故障。

const ARK_FILE_CACHE_STORE_KEY = 'browsaArkFileCache';

/** 上传时随 FormData 发的 expire_at（Ark 允许 [now+1d, now+30d]，取 30 天上限）。 */
/**
 * 从页面 URL 提取视频资产标识（缓存 key 的一部分）：B站取 BV 号 + 分P 号（cid 拿不到
 * 时 p 是最小的分P判别位），YouTube 取 v 参数，小宇宙取节目 eid。解析不出返回 ''
 *（调用方回退旧行为）。
 */
export function videoAssetId(platform, pageUrl) {
  try {
    const u = new URL(pageUrl || '');
    if (platform === 'youtube') {
      const v = u.searchParams.get('v');
      return v ? 'yt-' + v : '';
    }
    if (platform === 'xiaoyuzhou') {
      // 节目页 URL 形如 /episode/<24位十六进制 eid>。资产 ID 进入方舟文件缓存
      // 的 cache key——绝不能用空串，否则所有节目共享一个缓存键，B 节目会复用
      // A 节目已上传的音频 fileId。
      const m = /\/episode\/([A-Za-z0-9]+)/.exec(u.pathname || '');
      return m ? 'xy-' + m[1] : '';
    }
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname || '');
    if (!m) return '';
    return `bili-${m[1]}-p${u.searchParams.get('p') || '1'}`;
  } catch (_) {
    return '';
  }
}

// 小宇宙音频直链校验：官方媒体域 + 自家 CDN（media.xyzcdn.net——2026-10-07 真机
// 实测 enclosure/og:audio 都指向它，此前只认 xiaoyuzhoufm/aliyuncs 是闭门造车）
// 或其阿里云 OSS 音频宿主（audioclip.oss-cn-shanghai.aliyuncs.com），https only。
// enclosureUrl / og:audio 都是页面可控字段——没有这份白名单，等于把任意 URL 交给
// 下载管线。
export function isXiaoyuzhouMediaUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = (u.hostname || '').toLowerCase();
    return host === 'xiaoyuzhoufm.com' || host.endsWith('.xiaoyuzhoufm.com')
      || host === 'xyzcdn.net' || host.endsWith('.xyzcdn.net')
      || host.endsWith('.aliyuncs.com');
  } catch (_) {
    return false;
  }
}

/**
 * 缓存 key：规整后的 baseUrl + apiKey 指纹 + 资产标识（file_id 不跨账号/网关通用）。
 * provider/model 作用域：ark 条目保持原始 key（已存缓存不作废；方舟 file_id 本就跨
 * 模型通用）；其它供应商追加 `|provider:model`——百炼 oss:// 文件【绑定上传时指定的
 * 模型】（官方文档：不同模型无法共享文件），转写/精读换了模型就不能复用旧文件。
 */
export function arkFileCacheKey(baseUrl, apiKey, assetId, provider = 'ark', model = '') {
  const fp = apiKey ? `${apiKey.length}:${apiKey.slice(-4)}` : 'nokey';
  const base = `${normalizeArkBaseUrl(baseUrl)}|${fp}|${assetId}`;
  return provider === 'ark'
    ? base
    : `${base}|${provider}${model ? ':' + model : ''}`;
}

/** GET /files/{id} 探测文件是否仍存在（复用前的兜底校验；过期/删除 → 404）。 */
export async function arkFileAlive({ baseUrl, apiKey, fileId }) {
  if (!fileId) return false;
  const b = normalizeArkBaseUrl(baseUrl);
  try {
    const res = await fetch(`${b}/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: 'Bearer ' + apiKey },
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function arkCacheStorageArea(storageArea) {
  return storageArea
    || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    || null;
}

/**
 * 查缓存。返回 { videoFileId, audioFileId }（只含校验存活且未过期的字段；调用方按
 * 字段独立决定跳过哪些步骤），无可用条目返回 null。need: 'video' | 'audio' 仅决定
 * 必查哪个字段，另一字段命中也照常返回（音频模式先跑过、视频模式可复用其音频）。
 * aliveFn：文件存活探测（方舟 GET /files/{id}）。传 null = 跳过存活探测（百炼的
 * oss:// 文件没有任何查询 API，官方明示「无法被查询、修改或下载」，只做过期检查；
 * 过期文件在模型调用时报错，由调用方兜底）。缺省 = 方舟探测。
 * provider/model：缓存 key 作用域（见 arkFileCacheKey）。
 */
export async function lookupCachedArkFiles({
  baseUrl, apiKey, platform, pageUrl, need = 'video', durationSec = 0, storageArea, aliveFn,
  provider = 'ark', model = '',
} = {}) {
  const assetId = videoAssetId(platform, pageUrl);
  if (!assetId) return null;
  const area = arkCacheStorageArea(storageArea);
  if (!area) return null;
  const alive = aliveFn === undefined ? arkFileAlive : aliveFn;
  let entry = null;
  try {
    entry = (await area.get(ARK_FILE_CACHE_STORE_KEY))?.[ARK_FILE_CACHE_STORE_KEY]?.[arkFileCacheKey(baseUrl, apiKey, assetId, provider, model)] || null;
  } catch (_) {
    return null;
  }
  if (!entry) return null;
  // 时长对不上（UP主换源/串号）→ 整条作废。
  if (durationSec > 0 && entry.durationSec > 0
    && Math.abs(entry.durationSec - durationSec) > Math.max(5, durationSec * 0.1)) {
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh = (fileId, expireAt) => !!fileId && (expireAt || 0) > nowSec + 60;
  const out = { videoFileId: '', audioFileId: '' };
  if (fresh(entry.videoFileId, entry.videoExpireAt)
    && (!alive || await alive({ baseUrl, apiKey, fileId: entry.videoFileId }))) {
    out.videoFileId = entry.videoFileId;
  }
  if (fresh(entry.audioFileId, entry.audioExpireAt)
    && (!alive || await alive({ baseUrl, apiKey, fileId: entry.audioFileId }))) {
    out.audioFileId = entry.audioFileId;
  }
  if (need === 'video' ? !out.videoFileId : !out.audioFileId) return null;
  return out;
}

/**
 * 写缓存（上传 + 轮询成功后调用）。video/audio 字段按本次实际上传的合并——视频模式
 * 只传视频时保留旧的音频字段，反之亦然（两次不同模式各自积累）。存储不可用静默放弃。
 * ttlSec：条目有效期（方舟 file_id 30 天；百炼 oss:// 文件 48 小时自动清理——传
 * adapter.fileCacheTtlSec）。provider/model：缓存 key 作用域（见 arkFileCacheKey）。
 */
export async function saveArkFileCacheEntry({
  baseUrl, apiKey, platform, pageUrl, videoFileId = '', audioFileId = '', durationSec = 0, storageArea,
  ttlSec = 30 * 86400, provider = 'ark', model = '',
} = {}) {
  const assetId = videoAssetId(platform, pageUrl);
  if (!assetId || (!videoFileId && !audioFileId)) return;
  const area = arkCacheStorageArea(storageArea);
  if (!area) return;
  const key = arkFileCacheKey(baseUrl, apiKey, assetId, provider, model);
  let map = {};
  try {
    map = (await area.get(ARK_FILE_CACHE_STORE_KEY))?.[ARK_FILE_CACHE_STORE_KEY] || {};
  } catch (_) { /* 读失败按空 map 处理，写失败下方 catch */ }
  const prev = map[key] || {};
  const exp = Math.floor(Date.now() / 1000) + (ttlSec > 0 ? ttlSec : 30 * 86400);
  map[key] = {
    videoFileId: videoFileId || prev.videoFileId || '',
    videoExpireAt: videoFileId ? exp : (prev.videoExpireAt || 0),
    audioFileId: audioFileId || prev.audioFileId || '',
    audioExpireAt: audioFileId ? exp : (prev.audioExpireAt || 0),
    durationSec: durationSec || prev.durationSec || 0,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  try {
    await area.set({ [ARK_FILE_CACHE_STORE_KEY]: map });
  } catch (_) { /* 缓存写失败不影响主流程 */ }
}

/**
 * 轮询文件处理状态直到 ready 或超时（sidepanel / extension context）。
 * 返回 { status, ready:boolean, error? }。
 */
export async function pollFileStatus(baseUrl, apiKey, fileId, { timeoutMs = ASR_DEFAULTS.timeoutMs, intervalMs = POLL_INTERVAL_MS, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  const b = normalizeArkBaseUrl(baseUrl);
  while (Date.now() < deadline) {
    const res = await fetch(`${b}/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal,
    }).catch((e) => { throw new Error('poll fetch failed: ' + e.message); });
    if (!res.ok) {
      throw new Error(`poll HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => null);
    lastStatus = data?.status || '';
    const errMsg = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || '';
    // 明确失败态：failed/error/invalid 直接判定为不可转写，返回 ready:false + 具体错误。
    // 之前把除 processing 外的所有状态（含 failed）都当 ready，导致 transcribe 才
    // 报“file is in invalid state: failed”，绕过了这里应有的明确失败信号。
    if (lastStatus === 'failed' || lastStatus === 'error' || lastStatus === 'invalid') {
      return { status: lastStatus, ready: false, error: `Ark 文件处理失败 (${lastStatus}): ${errMsg || '(无错误详情)'}` };
    }
    // processing 期间继续等；其余（completed/ready/available/active）视为就绪。
    if (lastStatus && lastStatus !== 'processing') {
      return { status: lastStatus, ready: true };
    }
    await sleep(intervalMs, signal);
  }
  return { status: lastStatus, ready: false, error: `timeout after ${timeoutMs}ms (last status: ${lastStatus || 'none'})` };
}

/** 可中断的 sleep。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason || new Error('aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 用 Responses API 对已上传的音频做 ASR 转写（sidepanel / extension context）。
 * 指令模板刻意要求「每句一行 [mm:ss] 文本」—— 与 browsa 的 linkifyTimestamps 的
 * 正则 /(?:\*Content-)?\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/g 对齐，让转写结果能被渲染成
 * 可点击跳转的 [mm:ss]。
 *
 * @param {Object} opts { baseUrl, apiKey, fileId, model, language }
 * @param {Object} opts { baseUrl, apiKey, fileId, model, language, signal, idleTimeoutMs }
 * @returns {Promise<{ text: string, raw: string, truncated?: boolean, finishReason?: string }>}
 *   返回的 `truncated` 在模型输出被输出 token 上限截断时为 true（见 body 里的
 *   max_output_tokens 说明），调用方必须据此拒绝把半截字幕当完整结果存下来。
 */
export async function transcribeAudio({ baseUrl: rawBaseUrl, apiKey, fileId, model, language = 'zh', durationSec = 0, signal, idleTimeoutMs = 60_000 }) {
  const baseUrl = normalizeArkBaseUrl(rawBaseUrl);
  const body = {
    model,
    instructions: buildTranscribeInstructions(language, durationSec),
    input: [{
      role: 'user',
      content: [
        { type: 'input_audio', file_id: fileId },
        { type: 'input_text', text: buildTranscribeTaskText(durationSec) }
      ]
    }],
    stream: true,
    // 逐字转写一整段长音频（50+ 分钟）的输出远大于默认输出上限——不显式放开的话
    // 模型会在默认 max_output_tokens 处停止，字幕无声地停在中间（真实 bug：52:48 的
    // 视频只出到 33 分钟的字幕）。OpenAI 兼容的 /responses 会把这个值夹到模型自己的
    // 上限（超出也只是夹，不会 400）；配合下方 response.completed 的 finish_reason
    // 检测，万一还是被截断也会明确抛给调用方，而不是静默存半截字幕。
    max_output_tokens: 65536,
  };

  // 流式转写底层见 streamResponsesText（analyzeVideo 视听精读共用同一实现）。
  return streamResponsesText({ baseUrl, apiKey, body, signal, idleTimeoutMs });
}

/**
 * 纯函数：把行内所有时间戳归一化为「单个起始时刻」形态（formatAsrTranscript 的输入侧兕底——
 * 即使模型实际输出不遵守 prompt 的区间/小数禁令，这里也会强制规整）：
 *   [mm:ss.mmm]            → [mm:ss]（秒向下取整）
 *   [mm:ss.mmm-mm:ss.mmm]  → [mm:ss]（取区间起点）
 *   [mm:ss, mm:ss]         → [mm:ss]（逗号/连字符/空白分隔的区间同样取起点——
 *                            模型漂移真实案例 2026-08-24：`[44:44, 49:59]`）
 *   [1:02:03.500-1:05:00]  → [1:02:03]
 *   [mm:ss] / [h:mm:ss]    → 原样保留
 * 输出统一为 [mm:ss] 或 [h:mm:ss]（分秒补零，小时不补）；
 * 括号内不是时间形态的令牌（如 [说话人1]）不受影响。
 */
export function normalizeAsrTimestamps(text) {
  if (!text) return '';
  // 分隔符类 [-,\s]：兼容 -、逗号、裸空白分隔的区间；(*) 可重复（容忍“三个时间戳”的更怪输出），
  // 归一化始终取第一个（起始时刻）。
  const TOKEN_RE = /\[(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d{1,3})?(?:(?:\s*[-,]\s*|\s+)(?:(?:\d+):)?\d{1,2}:\d{2}(?:\.\d{1,3})?)*\]/g;
  const toSec = (h, m, s) => (h ? parseInt(h, 10) : 0) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
  const fmt = (totalSec) => {
    const h = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return (h > 0 ? `${h}:` : '') + `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };
  let out = String(text).replace(TOKEN_RE, (whole, h, m, s) => `[${fmt(toSec(h, m, s))}]`);
  // 裸秒数兜底（2026-08-30 真实故障：视频精读输出 [0.0] / [624.0] / [1009.0]——
  // 模型掉了 mm:ss 格式纪律，退化成原生 ASR 的秒级时间轴）。只认【行首】的纯
  // 数字（可带一位小数）括号，避免误伤句中的引用/年份类括号；>12h 视为非时间
  // 戳（如 [2025] 这类年份行首出现时按原文保留的概率极低，接受换算）。
  out = out.replace(/^\[(\d{1,5})(?:\.\d{1,3})?\]/gm, (whole, sec) => {
    const total = Math.round(parseFloat(sec));
    if (total > 43200) return whole;
    return `[${fmt(total)}]`;
  });
  return out;
}

/**
 * 把 ASR 原始文本整理成干净的 [mm:ss] 字幕行列表。
 * 模型输出的可能不完美（可能漏 [mm:ss] 前缀、可能带多余说明），这里做防御性规整：
 * 保留含时间戳的行；无时间戳的纯文本行也保留（回退给模型内容），但丢掉明显是
 * 开场白/结尾说明的行（"以下是转录…"/"以上是…"等）。
 * 时间戳统一归一化为单一起始时刻 [mm:ss]（见 normalizeAsrTimestamps），保证下游
 * 点击跳转（linkifyTimestamps 只认单格式）对每一行都可用。
 *
 * @param {string} rawText
 * @returns {{ lines: string[], usedTimestamps: number }}
 */
export function formatAsrTranscript(rawText) {
  if (!rawText) return { lines: [], usedTimestamps: 0 };
  const lines = String(rawText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const TS_RE = /\[(?:\d+:)?\d{1,2}:\d{2}\]/;
  const out = [];
  let usedTimestamps = 0;
  for (const line of lines) {
    if (isMetaLine(line)) continue;      // 开场白/结尾说明
    let clean = line.replace(/^[-*>]\s*/, '').trim();  // 去掉可能的列表前缀
    if (!clean) continue;
    clean = normalizeAsrTimestamps(clean);  // 区间/小数 → 单一起始时刻
    if (TS_RE.test(clean)) usedTimestamps++;
    out.push(clean);
  }
  return { lines: out, usedTimestamps };
}

/** 是否明显是模型夹带的说明行（不是字幕内容）。 */
function isMetaLine(line) {
  return /^(以下是|以上是|转录|转写|识别|字幕|开始|结束|时间戳|注[:：])/.test(line);
}

/**
 * 纯函数：从 ASR 字幕文本提取「转写最后覆盖到的时刻」（秒）。
 * 兼容模型可能输出的两种时间戳形态：
 *   [mm:ss]              单时间戳（行首）
 *   [mm:ss.mmm-mm:ss.mmm]  起止区间（B站 AI 字幕式区间，doubao 音频理解模型会输出）
 * 也兼容超过一小时的 [h:mm:ss]。对每行取时间戳的“结束时刻”（区间取右端，单时间戳
 * 取该时刻本身），返回全部行里的最大值。没有可识别时间戳时返回 null。
 *
 * 用于完整度校验：若返回值明显小于视频总时长，说明转写没跑完（输出被截断），
 * 调用方应拒绝存半截字幕。
 *
 * @param {string} rawText
 * @returns {number|null}
 */
export const VIDEO_MAX_UPLOAD_BYTES = 480 * 1024 * 1024;

/**
 * 视频时长兜底（纯函数，Node 可直接测试）：优先页面 SSR 的 duration（秒）；
 * 缺失时用 DASH 流自带的 duration（playurl 每条流都带，单位秒，取最大值——各流
 * 应近似相等，取最大对截断校验最严格）。2026-08-28 实测：81 分钟视频
 * __playinfo__ 缺 duration → videoDurationSec=0，选流退化成“时长未知→最低画质”、
 * 卡片体积显示“未知”、完整度校验失效。
 */
export function resolveVideoDurationSec(ssrDurationSec, streams = []) {
  if (ssrDurationSec && ssrDurationSec > 0) return ssrDurationSec;
  let max = 0;
  for (const s of streams) {
    const d = s?.duration || 0;
    if (d > max) max = d;
  }
  return max > 0 ? Math.round(max) : 0;
}

/**
 * 估算流的下载体积（字节）。优先 playurl 给的 size（字节）；缺失时用
 * bandwidth（bits/s）× duration（s）÷ 8 推算。都不可知返回 0（表示未知）。
 * 纯函数，Node 可直接测试。
 */
export function estimateStreamBytes(stream, durationSec) {
  if (!stream) return 0;
  if (stream.size && stream.size > 0) return stream.size;
  const bw = stream.bandwidth || 0;
  const dur = durationSec || stream.duration || 0;
  if (bw > 0 && dur > 0) return Math.round((bw * dur) / 8);
  return 0;
}

/**
 * 视频解析选流（纯函数，Node 可直接测试）：
 *  1. 有 durl 合一流（音画合一）且体积在预算内（或体积未知）→ 首选：单文件上传、
 *     原生音轨，模型对音画同步的理解最稳。
 *  2. 否则在 video-only 流里按码率从高到低取第一个体积落在预算内的——用户选视频
 *     解析就是要看清画面，预算内给最好的画质。
 *  3. 时长未知无法估算体积时，选最低码率流（下载失败/超限风险最小），estBytes=0
 *     表示体积未知（UI 不显示预估）。
 * 返回 null 表示没有可用视频流（或全部超预算）→ UI 禁用视频选项并说明原因。
 */
export function pickVideoStream({ videoCandidates, muxedStream, durationSec, maxBytes = VIDEO_MAX_UPLOAD_BYTES } = {}) {
  const fits = (est) => est > 0 && est <= maxBytes;
  if (muxedStream && muxedStream.url) {
    const est = estimateStreamBytes(muxedStream, durationSec);
    if (est === 0 || fits(est)) return { kind: 'muxed', stream: muxedStream, estBytes: est };
  }
  const vids = (videoCandidates || []).filter((s) => s.url)
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  if (!vids.length) return null;
  if (!durationSec) {
    const low = vids[vids.length - 1];
    return { kind: 'video', stream: low, estBytes: 0 };
  }
  for (const s of vids) {
    const est = estimateStreamBytes(s, durationSec);
    if (fits(est)) return { kind: 'video', stream: s, estBytes: est };
  }
  return null;
}

/**
 * 截屏数量的客户端安全阀（防病态输出 / 存储与抽帧耗时兜底），不是质量指标——
 * prompt 已明确「有多少值得截的就标多少」（2026-08-30 用户定调：图由内容决定，
 * 不设预算）。10 秒最小间隔把理论天花板压在 6 张/分钟；本阀只拦截极端情况，
 * 正常密集图表视频（每小时几十处）远够用。抽帧失败 fail-open 不受影响。
 */
export const SAFETY_KEYFRAME_CAP = 24;

/**
 * 从精读文档解析关键帧标记行（纯函数，Node 可直接测试）：`[mm:ss] [截屏] 短标题`
 * （也兼容 [h:mm:ss]）。按时间排序后强制执行上限 max 与相邻最小间隔 minGapSec——
 * prompt 有禁令但模型会违规，客户端兜底（2026-08 的 [mm:ss] 区间漂移同款教训）。
 * 时间解析不出或描述为空的行跳过。每个幸存标记带 `line`（原始行文本），供
 * sidepanel 只对幸存者做 [截屏]→[图N] 改写——2026-08-30 真实 bug：模型输出 37 个
 * 标记、安全阀只留 24，但改写按全部计数编号，图 25 起的锚点没有真图。
 */
export function parseKeyframeMarkers(docText, { max = 6, minGapSec = 8 } = {}) {
  const RE = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]\s*\[截屏\]\s*(.+?)\s*$/;
  const marks = [];
  for (const line of String(docText || '').split(/\r?\n/)) {
    const m = RE.exec(line);
    if (!m || !m[4]) continue;
    marks.push({
      sec: (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10),
      caption: m[4],
      line,
    });
  }
  marks.sort((a, b) => a.sec - b.sec);
  const out = [];
  for (const mk of marks) {
    if (out.length >= max) break;
    if (out.length && mk.sec - out[out.length - 1].sec < minGapSec) continue;
    out.push(mk);
  }
  return out;
}

/**
 * 从已下载的视频 blob 抽取关键帧（sidepanel / extension context，依赖 <video> 解码）。
 * blob 走扩展上下文的同源对象 URL，canvas 不会被跨源污染（页面播放器截图会被
 * CDN 无 CORS 头污染，这条路绕开了）。任何失败（解码不支持、metadata 超时、单帧
 * seek 失败）都 fail-open：单帧跳过、整体返回 []，绝不阻塞精读产物。
 * @param {Blob} blob 视频字节（runVideoAnalysisPipeline 已下载的 videoBlob）
 * @param {{sec:number, caption:string}[]} markers parseKeyframeMarkers 的输出
 * @returns {Promise<Array<{url:string, caption:string}>>} JPEG dataURL 列表
 */
export async function extractKeyframes(blob, markers, { maxWidth = 640, quality = 0.62, loadTimeoutMs = 4000, seekTimeoutMs = 3000 } = {}) {
  try {
    if (!blob || !Array.isArray(markers) || markers.length === 0) return [];
    if (typeof document === 'undefined' || !globalThis.URL?.createObjectURL) return [];
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    const cleanup = () => {
      try { video.pause && video.pause(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
      try { video.removeAttribute('src'); } catch (_) {}
    };
    try {
      // 等 loadedmetadata：拿到真实时长并确认这份字节真的可解码。超时/报错 → 整批放弃。
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('metadata timeout')), loadTimeoutMs);
        video.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(t); reject(new Error('video decode error')); }, { once: true });
      });
      const dur = video.duration || 0;
      const canvas = document.createElement('canvas');
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return [];
      const frames = [];
      for (const mk of markers) {
        try {
          const ts = dur > 0
            ? Math.min(Math.max(mk.sec + 0.1, 0.05), Math.max(dur - 0.1, 0.05))
            : Math.max(mk.sec, 0.05);
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('seek timeout')), seekTimeoutMs);
            const onSeeked = () => { clearTimeout(t); video.removeEventListener('error', onError); resolve(); };
            const onError = () => { clearTimeout(t); video.removeEventListener('seeked', onSeeked); reject(new Error('seek error')); };
            video.addEventListener('seeked', onSeeked, { once: true });
            video.addEventListener('error', onError, { once: true });
            video.currentTime = ts;
          });
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 360;
          canvas.width = Math.min(maxWidth, vw);
          canvas.height = Math.max(2, Math.round(canvas.width * vh / vw));
          ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push({ url: canvas.toDataURL('image/jpeg', quality), caption: mk.caption });
        } catch (_) { /* 单帧失败跳过，不拖垮整批 */ }
      }
      return frames;
    } finally {
      cleanup();
    }
  } catch (_) {
    return [];
  }
}

/**
 * 视听精读：对已上传的视频文件（+ 可选的独立音频文件）发起 Responses API 流式
 * 请求，产出带 [mm:ss] 的精读文档（sidepanel / extension context）。
 * audioFileId 为空 = durl 合一流路径（音轨在视频文件里，只传 input_video）。
 * 超时/截断语义与 transcribeAudio 完全一致（共用 streamResponsesText）。
 */
export async function analyzeVideo({ baseUrl: rawBaseUrl, apiKey, videoFileId, audioFileId, model, language = 'zh', durationSec = 0, metaHint = '', signal, idleTimeoutMs = 60_000 }) {
  const baseUrl = normalizeArkBaseUrl(rawBaseUrl);
  if (!videoFileId) throw new Error('no videoFileId');
  const content = [{ type: 'input_video', file_id: videoFileId }];
  if (audioFileId) content.push({ type: 'input_audio', file_id: audioFileId });
  content.push({ type: 'input_text', text: buildVideoAnalysisTaskText(durationSec, language, metaHint) });
  const body = {
    model,
    instructions: buildVideoAnalysisInstructions(language, durationSec),
    input: [{ role: 'user', content }],
    stream: true,
    // 精读文档覆盖整段视频（语音转写 + 画面转写），输出远大于默认上限——与 ASR
    // 相同的 max_output_tokens 放开逻辑（Responses 会夹到模型上限，配合流式
    // finish_reason 检测兜底截断）。
    max_output_tokens: 65536,
  };
  return streamResponsesText({ baseUrl, apiKey, body, signal, idleTimeoutMs });
}

// ─── 连通性测试（options ASR 卡的「测试连接」按钮）────────────────────────────
// 各家一个轻探针，证明 key / 端点 / 模型三者可用（不含音频，token 花费可忽略）。
// qwen 特意探两跳：① getPolicy（生产上传链路的第一段，200 = 该模型被上传策略
// 接受——这正是上线探针项①）；② chat/completions 沿用【生产同款 max_tokens】——
// 若 400 且点名 max_tokens，即生产转写会踩的坑（上线探针项②），测试按钮替用户
// 提前撞出来。方舟 Responses API 无上传策略一类的轻探针，直接最小补全。

export async function pingArkAsr({ baseUrl, apiKey, model } = {}) {
  const b = normalizeArkBaseUrl(baseUrl);
  if (!apiKey) return { ok: false, error: 'no apiKey' };
  const t0 = Date.now();
  try {
    const res = await fetch(`${b}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: OK' }] }],
        max_output_tokens: 16,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return { ok: false, error: `HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 200)}` };
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ─── 服务商适配器注册表 ────────────────────────────────────────────────────────
// 协议适配（transcribeAudio/analyzeVideo，签名对全部供应商统一：入参
// { baseUrl, apiKey, fileId..., model, language, signal, idleTimeoutMs }，出参
// { text, truncated?, finishReason? }）+ 管线分派钩子（编排层据此走各自的
// 上传/轮询/缓存策略，方舟为缺省）：
//   upload          blob→fileId 的上传（入参 { blob, filename, apiKey, baseUrl, model,
//                   onProgress }；model 供绑定模型的上传策略使用，方舟忽略）
//   poll            上传后的服务端预处理轮询（方舟有；百炼无服务端预处理 → null）
//   alive           缓存复用前的文件存活探测（方舟 GET /files/{id}；百炼无查询 API → null）
//   fileCacheTtlSec 上传文件的有效期（方舟 30 天；百炼 oss:// 48 小时自动清理）
//   ping            连通性测试（options「测试连接」按钮；证明 key/端点/模型可用）
// 新供应商 = 在 ASR_PROVIDERS 注册表加元数据 + 这里注册一个适配器，sidepanel 经
// asrAdapterFor(asr.provider) 分发，UI 与管线零改动。未知 id 回退 ark（老配置无
// provider 字段时同样成立）。
const ASR_ADAPTERS = {
  ark: {
    transcribeAudio, analyzeVideo,
    upload: uploadBlobToArk, poll: pollFileStatus, alive: arkFileAlive,
    fileCacheTtlSec: 30 * 86400,
    ping: pingArkAsr,
  },
  qwen: {
    transcribeAudio: qwenTranscribeAudio, analyzeVideo: qwenAnalyzeVideo,
    upload: uploadBlobToQwen, poll: null, alive: null,
    fileCacheTtlSec: 48 * 3600,
    ping: pingQwenAsr,
    // 音频直传原始字节（m4s/m4a/mp3，~1/4 体积）：OSS 纯存储无内容分类，任务解码
    // 接受 aac/mp3/wav 等主流容器——16kHz WAV 转码仅为截断校验保留，不再上传。
    audioUploadFormat: 'original',
  },
};

// 兼容再导出：调用方与测试统一从 attach-asr.js 取全供应商符号（facade 不变）。
export {
  uploadBlobToQwen, qwenTranscribeAudio, qwenAnalyzeVideo, pingQwenAsr, QWEN_DEFAULT_BASE_URL,
  normalizeQwenBaseUrl, qwenApiV1, qwenUploadsEndpoint, isQwenFiletransModel, filetransResultToLines, parseAsrHotwords,
} from './attach-asr-qwen.js';
export {
  buildTranscribeInstructions, buildTranscribeTaskText,
  buildVideoAnalysisInstructions, buildVideoAnalysisTaskText,
  coverageHintEn, coverageHintZh, formatStampSec,
  transcriptEndSec, TRANSCRIPT_GAP_LIMIT_SEC, largestTranscriptGapSec,
} from './asr-shared.js';
import { ARK_DEFAULT_BASE_URL, normalizeArkBaseUrl, arkExpireAtSec } from './ark-endpoints.js';
import { uploadBlobToArk } from './attach-asr-media.js';

export function asrAdapterFor(providerId) {
  return ASR_ADAPTERS[providerId] || ASR_ADAPTERS.ark;
}

// ─── Moved modules (2026-10-17 split) ────────────────────────────────────────
// The media/transcode half lives in attach-asr-media.js and the Ark base-URL
// contract in ark-endpoints.js. Re-exported here so every existing importer
// (attach-orchestrator, options.js, attach-asr-pending, background) keeps its
// import specifier — the split is internal.
export { ARK_DEFAULT_BASE_URL, normalizeArkBaseUrl, arkExpireAtSec } from './ark-endpoints.js';
export {
  downloadAudioBytes, encodePcmToWav, splitMp4Fragments, transcodeAudioBlob,
  resampleToMono, uploadBlobToArk, downloadAndUploadAudio, mp4DurationSec, extFromMime,
} from './attach-asr-media.js';
