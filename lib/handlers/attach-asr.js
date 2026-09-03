// lib/handlers/attach-asr.js
//
// 火山方舟（Volcengine Ark）录音文件识别 ASR 适配器。
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
export const ASR_SUBTITLE_SOURCE = {
  ORIGINAL: 'original',
  ASR: 'asr',
};

/** 默认方舟配置（与 storage.js 的 asr DEFAULTS 保持同步）。 */
export const ASR_DEFAULTS = {
  enabled: false,
  provider: 'ark',                               // 服务商（ASR_PROVIDERS 注册表）；决定走哪条协议适配器
  apiKey: '',                                    // ark.cn-beijing.volces.com 的 Bearer key
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-2-0-lite-260428',          // 已开通的音频理解/ASR 模型 ID
  videoModel: '',                                // 视频解析（视听精读）模型 ID；空 = 回退用 model（doubao-seed 系列多模态）
  language: 'zh',                                // 识别语种（'auto' = 自动检测）
  format: 'audio/x-m4a',                         // 上传 MIME（B站 m4s 是 fMP4；08-16 起转码后实际传 WAV）
  timeoutMs: 150_000,                            // 轮询总预算
  subtitleSource: ASR_SUBTITLE_SOURCE.ORIGINAL,  // 字幕来源偏好（见上方常量）
};

/** ASR 转码目标：16kHz 单声道（语音识别标准，文件小，方舟支持）。 */
const TRANSCODE_SAMPLE_RATE = 16000;
const TRANSCODE_CHANNELS = 1;

/**
 * 把方舟 Base URL 规整到标准版端点（纯函数）。
 *
 * 2026-08-15 实机发现：用户配置里填了 https://ark.cn-beijing.volces.com/api/plan/v3 —— 那是火山
 * 方舟 Agent Plan（给 Hermes 等 Coding Agent 用的 OpenAI 兼容接口）的专属 Base URL，
 * 它没有 Files API（上传 /files 返回 404）。Files API 上传端点只在标准版 …/api/v3 上。
 * 这里把 api/plan 版自动回退到 api/v3，让已存了 plan 版配置的用户无需手动改就能恢复；新保存的
 * 配置由 options.js saveAsr 的校验拦截（见 options.html 的 Base URL 提示）。
 */
export function normalizeArkBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim();
  if (!b) return ASR_DEFAULTS.baseUrl;
  // 兼容 …/api/plan/v3、…/api/plan、…/api/plan/v3/ 等变体
  return b.replace(/\/api\/plan(?:\/v\d+)?\/?$/, '/api/v3');
}

/** 上传后等待文件处理的轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 2000;

/**
 * sidepanel/extension-context：下载 B站音频 bytes（带 Referer[经 DNR 注入] + Range）。
 * 跑在带 host_permissions 的扩展上下文（免 CORS）。
 * ※ 2026-08-15 实机修复：此前此函数经 chrome.scripting.executeScript 注入 MAIN world 执行，
 *   其上传方舟的跨域 fetch 被页面 CORS 拦截（方舟无 CORS 头），实机报 “Failed to fetch”。
 *   现改为 sidepanel 直接调用；B站 CDN 的 Referer 由调用方（sidepanel）先注册一条 session
 *   DNR 规则注入，不再依赖函数内显式 Referer 头（显式头保留作无害兜底）。
 *
 * @param {Object} opts  { audioUrl, onProgress }
 *   onProgress(done, total) — called with bytes read so far + total bytes when a
 *   total is knowable (Content-Length / Content-Range); total is null when not.
 * @returns {Promise<{ok:true, blob:Blob, bytes:number} | {ok:false, error:string}>}
 */
export async function downloadAudioBytes({ audioUrl, onProgress, headers } = {}) {
  if (!audioUrl) return { ok: false, error: 'no audioUrl' };
  try {
    // Range: bytes=0- —— 部分 CDN 路径对无 Range 的 .m4s 请求回 403（见 DOWNLOAD_MEDIA
    // 回退路径的同一注释）。Referer 是 B站 CDN 校验的必要头（由 sidepanel 注册的 DNR
    // 规则注入，因为扩展上下文的原生 Referer 是 chrome-extension://...）。
    // ※ 不要在这里加 credentials:'include'：跨源（chrome-extension:// →
    // bilivideo.cn）扩展 fetch 加 credentials:'include' 会触发 CORS 预检，而 B站
    // CDN 只回 Access-Control-Allow-Origin:*（无 Allow-Credentials）→ 预检失败/
    // 请求被 abort（net::ERR_ABORTED 403）——DOWNLOAD_MEDIA 的 page-world 路径
    // 2026-08-14 已踩过同一坑并移除。且 credentials 也带不上 B站 cookie
    // （SameSite=Lax 跨站不带）。cookie 改由调用方（sidepanel）在 DNR 规则里
    // 注入（对齐 cat-catch：跨源带 SameSite cookie 的唯一可靠方式）。
    // YouTube 平台不传 headers → 走纯 fetch（pot 已烧进 URL 查询串，googlevideo
    // 返回 Access-Control-Allow-Origin:*，扩展上下文可直接拉，无需 Referer/cookie）。
    const reqHeaders = headers || { Referer: 'https://www.bilibili.com', Range: 'bytes=0-' };
    const resp = await fetch(audioUrl, { headers: reqHeaders });
    if (!resp.ok) return { ok: false, error: 'download HTTP ' + resp.status };
    // Total size: our Range request yields 206 + Content-Range "bytes 0-(n-1)/total";
    // a server that ignores Range returns 200 + Content-Length. null when unknowable
    // (chunked) → caller falls back to elapsed-time display.
    let total = null;
    const hdrs = resp.headers && typeof resp.headers.get === 'function' ? resp.headers : null;
    const cr = hdrs && hdrs.get('content-range');
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) total = parseInt(m[1], 10);
    }
    if (total == null) {
      const cl = hdrs && parseInt(hdrs.get('content-length') || '', 10);
      if (Number.isFinite(cl) && cl > 0) total = cl;
    }
    // Streaming read → real percentage when a stream + total are both available.
    // Fall back to resp.blob() when there's no readable body (Node test mocks).
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const chunks = [];
      let done = 0;
      let lastPct = -1;
      for (;;) {
        const { value, done: rd } = await reader.read();
        if (rd) break;
        if (value) {
          chunks.push(value);
          done += value.byteLength;
        }
        // Throttle onProgress to whole-percent steps (a 32MB file yields ~500
        // 64KB chunks — no need to repaint the label for every one).
        if (onProgress) {
          if (total) {
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(done, total); }
          } else {
            onProgress(done, null);
          }
        }
      }
      const blob = new Blob(chunks, { type: (hdrs && hdrs.get('content-type')) || '' });
      if (!blob.size) return { ok: false, error: 'downloaded audio is empty' };
      return { ok: true, blob, bytes: blob.size };
    }
    const blob = await resp.blob();
    if (!blob.size) return { ok: false, error: 'downloaded audio is empty' };
    return { ok: true, blob, bytes: blob.size };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 纯函数：把 PCM 采样（Float32Array，-1..1）编码成 16-bit PCM WAV 文件 bytes（ArrayBuffer）。
 * 无浏览器依赖，Node 可直接测试。WAV header: RIFF + fmt (PCM, 16-bit) + data。
 *
 * @param {Float32Array|ArrayLike<number>} samples 交错声道样本（float -1..1）
 * @param {Object} opts { sampleRate, channels }
 * @returns {ArrayBuffer}
 */
export function encodePcmToWav(samples, { sampleRate = 16000, channels = 1 } = {}) {
  const n = samples.length;
  const dataSize = n * 2; // 16-bit
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // fmt chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (!Number.isFinite(s)) s = 0;
    if (s > 1) s = 1; else if (s < -1) s = -1;
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * sidepanel/extension-context：用 Web Audio API 把任意音频 blob（含 B站 m4s/fMP4）解码并
 * 转码成 16kHz 单声道 16-bit PCM WAV。Chrome 原生支持 fMP4/AAC 解码（decodeAudioData）。
 * 方舟 Files API 按文件内容把 MP4 容器识别成“视频”导致 failed（Invalid video_url），
 * 而 WAV 是纯音频（active，实测可转写）——所以必须转码。
 * 依赖 AudioContext/OfflineAudioContext（sidepanel 有 window；Node 测试需 mock）。
 *
 * @param {Blob} blob 原始音频 bytes（m4s/mp4/aac/...）
 * @param {Object} opts { targetSampleRate, channels }
 * @returns {Promise<{ok:true, wavBlob:Blob, wavBytes:number, sampleRate:number} | {ok:false, error:string}>}
 */

/**
 * 纯函数：解析 fMP4（fragmented MP4）顶层 box，拆出 init 段（ftyp+moov）和
 * 每个媒体分片（moof+mdat）。decodeAudioData 需要整段解码到内存，100+ 分钟
 * 音频解码后 PCM 可达 2GB+（超过解码器/数组限制 → “Unable to decode audio
 * data”），分片解码（每片只有几秒）是唯一不依赖外部解码器的出路。B站 DASH
 * 音频正是 fMP4（每个 moof+mdat 一个分片，独立可解码）。
 *
 * 非分片（普通 MP4，单个大 mdat）或不可解析时返回 null（调用方退回整文件解码）。
 *
 * @param {ArrayBuffer} arrayBuffer 原始 m4s bytes
 * @returns {{init:Blob, fragments:Blob[]} | null}
 */
export function splitMp4Fragments(arrayBuffer) {
  try {
    const dv = new DataView(arrayBuffer);
    const initParts = [];
    const fragments = [];
    const seenTypes = []; // 诊断：解析失败时报告前几个 box type
    let offset = 0;
    let sawMoof = false;
    let inFrag = false;
    let fragParts = [];
    while (offset + 8 <= dv.byteLength) {
      let size = dv.getUint32(offset);
      let headerSize = 8;
      if (size === 1) {
        // 64 位扩展尺寸（罕见：>4GB 的 box）。真实 B站 m4s 不会这么大，但碰到时
        // 至少要正确跳过，而不是把 8 误当 size 导致错乱。
        if (offset + 16 > dv.byteLength) break;
        const hi = dv.getUint32(offset + 8);
        const lo = dv.getUint32(offset + 12);
        size = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = dv.byteLength - offset; // 到文件末尾
      }
      if (size < 8 || offset + size > dv.byteLength) break; // 损坏/截断 → 放弃解析
      const type = String.fromCharCode(
        dv.getUint8(offset + 4), dv.getUint8(offset + 5),
        dv.getUint8(offset + 6), dv.getUint8(offset + 7));
      if (seenTypes.length < 12) seenTypes.push(type);
      const bytes = arrayBuffer.slice(offset, offset + size);
      if (type === 'moof') {
        sawMoof = true;
        if (!inFrag) { inFrag = true; fragParts = []; }
        fragParts.push(bytes);
      } else if (type === 'mdat') {
        if (inFrag) { fragParts.push(bytes); fragments.push(new Blob(fragParts)); fragParts = []; inFrag = false; }
        // 首个 moof 之前的 mdat（非分片旧格式）→ 分片解析不适用
      } else if (!sawMoof) {
        initParts.push(bytes); // ftyp/moov/free/... 属于 init 段
      }
      // 分片之间的 styp/sidx/free 等忽略
      offset += size;
    }
    if (!sawMoof || fragments.length === 0) {
      // 诊断：不是（或没认出是）fMP4。返回 null 并附带原因，供上层日志。
      const err = new Error('not a fragmented mp4 (boxes: ' + (seenTypes.join(',') || 'none') + ')');
      err.meta = { initParts: initParts.length, sawMoof, fragments: fragments.length, seenTypes: seenTypes.slice() };
      return err;
    }
    return { init: new Blob(initParts), fragments };
  } catch (e) {
    const err = new Error('splitMp4Fragments threw: ' + String((e && e.message) || e));
    err.meta = { threw: true };
    return err;
  }
}

/**
 * 分片解码：对 fMP4 的每个分片单独 decodeAudioData（init 段 + 该分片），每片
 * 立即降采样/混音到 16k mono 后拼接到累积缓冲——峰值内存 ≈ 最终 16k mono
 * （100min ≈ 192MB），而不是整文件解码的 2GB+。用与整文件解码相同的 ctx。
 *
 * @param {AudioContext} ctx 已构造的解码上下文
 * @param {{init:Blob, fragments:Blob[]}} frag splitMp4Fragments 的返回值
 * @param {number} targetRate 目标采样率（16k）
 * @returns {Promise<Float32Array>} 16k mono 样本
 */
async function decodeFragmentsToMono(ctx, frag, targetRate) {
  const initBuf = await frag.init.arrayBuffer();
  const accum = [];
  let total = 0;
  for (const f of frag.fragments) {
    const unit = await new Blob([initBuf, f]).arrayBuffer();
    let d;
    try {
      d = await ctx.decodeAudioData(unit);
    } catch (e) {
      throw new Error('fragment decode failed: ' + String((e && e.message) || e));
    }
    const mono = resampleToMono(d, targetRate);
    accum.push(mono);
    total += mono.length;
  }
  const out = new Float32Array(total);
  let p = 0;
  for (const m of accum) { out.set(m, p); p += m.length; }
  return out;
}
export async function transcodeAudioBlob(blob, { targetSampleRate = TRANSCODE_SAMPLE_RATE, channels = TRANSCODE_CHANNELS } = {}) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    // 超长/超大音频直接 fail-open：decodeAudioData 会整体解码到内存（float32），
    // 47min@48k stereo ≈ 389MB 峰值已偏高；200MB+ 的原始 bytes 解码峰值会更高，
    // 提前放弃，让调用方 fall back 到纯文本（不引入 OOM/卡死风险）。
    if (arrayBuffer.byteLength > 200 * 1024 * 1024) {
      return { ok: false, error: 'audio too large to transcode (' + Math.round(arrayBuffer.byteLength / 1024 / 1024) + 'MB)' };
    }
    // 解码：优先真实 AudioContext（decodeAudioData 最成熟可靠），无真实上下文
    // （headless 等）时才回退 OfflineAudioContext。解码后立即 close 释放资源。
    // 注意构造签名不同：AudioContext 只接受一个 AudioContextOptions 对象（无参即
    // 默认），OfflineAudioContext 才是 (channels, length, sampleRate) 三参——
    // 之前统一用 new DecodeCtx(2,1,48000) 在 AudioContext 存在时抛
    // “Failed to construct 'AudioContext': not of type AudioContextOptions”。
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    const OAC = globalThis.OfflineAudioContext;
    const decodeCtx = AC ? new AC() : (OAC ? new OAC(2, 1, 48000) : null);
    if (!decodeCtx) return { ok: false, error: 'no Web Audio decode support' };
    let out; // Float32Array @targetRate mono
    try {
      // 先解析分片——decodeAudioData 会 detach 传入的 ArrayBuffer（真实 bug：
      // 整文件解码失败后再拿同一个 buffer 去 splitMp4Fragments 会抛
      // "Cannot perform DataView constructor on a detached ArrayBuffer"，
      // 导致分片解码从未真正跑起来）。所以分片解析必须在任何 decode 之前。
      const frag = splitMp4Fragments(arrayBuffer);
      if (frag && !(frag instanceof Error)) {
        // 是 fMP4 → 直接分片解码。绕开整文件 decodeAudioData 对超长/重度分片
        // 文件的失败（100min fMP4 上千个 moof/mdat 分片，Edge 解析整文件
        // 分片索引失败 → "Unable to decode audio data"）。每片几秒、独立可解。
        out = await decodeFragmentsToMono(decodeCtx, frag, targetSampleRate);
      } else {
        // 非分片（单 mdat 的普通 MP4）→ 整文件解码。buffer 被 detach 没关系，
        // 这里已经不需要它了。
        try {
          const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
          out = resampleToMono(decoded, targetSampleRate);
        } catch (wholeErr) {
          // 附带解析诊断（box types）方便定位真实结构
          const diag = frag instanceof Error ? ' [' + frag.message + ']' : '';
          const err = new Error(String((wholeErr && wholeErr.message) || wholeErr) + diag);
          err.meta = frag instanceof Error ? frag.meta : undefined;
          throw err;
        }
      }
    } finally {
      try { decodeCtx.close && (await decodeCtx.close()); } catch (_) {}
    }
    const wav = encodePcmToWav(out, { sampleRate: targetSampleRate, channels });
    const wavBlob = new Blob([wav], { type: 'audio/wav' });
    return { ok: true, wavBlob, wavBytes: wavBlob.size, sampleRate: targetSampleRate };
  } catch (e) {
    return { ok: false, error: 'transcode failed: ' + String((e && e.message) || e) };
  }
}

/**
 * 纯函数：把 AudioBuffer 降采样到目标采样率并混音为单声道（float -1..1）。
 * 线性插值重采样（对 48k→16k 这类整数倍或任意比都成立）。多声道先平均混音，
 * 再插值（每个输出样本对同一时刻的通道均值插值，等价于先混音后重采样）。
 * 无浏览器依赖，Node 可直接测试。
 *
 * @param {{sampleRate:number, length:number, getChannelData:(c:number)=>Float32Array}} buf
 * @param {number} targetSampleRate
 * @returns {Float32Array}
 */
export function resampleToMono(buf, targetSampleRate) {
  const srcRate = buf.sampleRate;
  const srcLen = buf.length;
  const channels = buf.numberOfChannels || 1;
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(buf.getChannelData(c));
  const outLen = Math.max(1, Math.ceil(srcLen * targetSampleRate / srcRate));
  const out = new Float32Array(outLen);
  if (channels === 1 && srcRate === targetSampleRate) {
    // 常见捷径：已经是 16k mono，直接拷贝
    out.set(chans[0].subarray(0, Math.min(srcLen, outLen)));
    return out;
  }
  for (let i = 0; i < outLen; i++) {
    const pos = i * srcRate / targetSampleRate;
    const i0 = Math.min(Math.floor(pos), srcLen - 1);
    const i1 = Math.min(i0 + 1, srcLen - 1);
    const frac = pos - i0;
    let s0 = 0, s1 = 0;
    for (let c = 0; c < channels; c++) { s0 += chans[c][i0]; s1 += chans[c][i1]; }
    s0 /= channels; s1 /= channels;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

/**
 * sidepanel/extension-context：把 bytes/Blob 上传到方舟 Files API（multipart）。
 * 跑在带 host_permissions 的扩展上下文（免 CORS）。
 *
 * @param {Object} opts  { blob, filename, mime, apiKey, baseUrl }
 * @returns {Promise<{ok:true, fileId:string, bytes:number} | {ok:false, error:string}>}
 */
export async function uploadBlobToArk({ blob, filename, mime, apiKey, baseUrl: rawBaseUrl, onProgress } = {}) {
  if (!blob) return { ok: false, error: 'no blob' };
  if (!apiKey) return { ok: false, error: 'no apiKey' };
  const baseUrl = normalizeArkBaseUrl(rawBaseUrl);
  try {
    // When the caller wants progress, use XMLHttpRequest: fetch has no upload
    // progress callback, but XHR's upload.onprogress gives a real percentage.
    // Without onProgress (tests / legacy callers) keep the plain fetch path.
    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      const fd = new FormData();
      fd.append('purpose', 'user_data');
      fd.append('expire_at', String(arkExpireAtSec()));
      const name = filename || 'audio.wav';
      fd.append('file', blob, name);
      const result = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', baseUrl + '/files');
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          let upData = null;
          try { upData = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
          if (xhr.status >= 200 && xhr.status < 300 && upData?.id) {
            resolve({ ok: true, fileId: upData.id, bytes: blob.size, upBytes: upData.bytes, upContentType: upData.content_type || upData.contentType || '', upStatus: upData.status || '' });
          } else {
            resolve({ ok: false, error: 'upload HTTP ' + xhr.status + ': ' + JSON.stringify(upData || {}).slice(0, 300) });
          }
        };
        xhr.onerror = () => resolve({ ok: false, error: 'upload network error' });
        xhr.onabort = () => resolve({ ok: false, error: 'upload aborted' });
        xhr.send(fd);
      });
      if (result.ok) onProgress(blob.size, blob.size);
      return result;
    }
    const fd = new FormData();
    fd.append('purpose', 'user_data');
    fd.append('expire_at', String(arkExpireAtSec()));
    const name = filename || 'audio.wav';
    fd.append('file', blob, name);
    const upRes = await fetch(baseUrl + '/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: fd
    });
    const upData = await upRes.json().catch(() => null);
    if (!upRes.ok || !upData?.id) {
      return {
        ok: false,
        error: 'upload HTTP ' + upRes.status + ': ' + JSON.stringify(upData || {}).slice(0, 300)
      };
    }
    // 透出 Ark 识别出的元数据（content_type / bytes / status）—— 排查“上传的是
    // WAV 还是仍被识别成视频/m4s”的决定性证据。Ark 可能不返回这些字段，缺省即可。
    return {
      ok: true,
      fileId: upData.id,
      bytes: blob.size,
      upBytes: upData.bytes,
      upContentType: upData.content_type || upData.contentType || '',
      upStatus: upData.status || '',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * sidepanel/extension-context：下载音频 bytes 并直传方舟 Files API（不转码，兼容旧调用）。
 * 08-16 起 sidepanel 改用 downloadAudioBytes → transcodeAudioBlob → uploadBlobToArk 流程；
 * 此函数保留给旧调用/测试。
 * @param {Object} opts  { audioUrl, apiKey, baseUrl, format, filename }
 * @returns {Promise<{ok:true, fileId:string, bytes:number} | {ok:false, error:string}>}
 */
export async function downloadAndUploadAudio(opts) {
  const { audioUrl, apiKey, baseUrl, format, filename } = opts || {};
  const dl = await downloadAudioBytes({ audioUrl });
  if (!dl.ok) return dl;
  const fm = String(format || '').split(';')[0].toLowerCase();
  let ext = '';
  if (fm.includes('mpeg')) ext = 'mp3';
  else if (fm.includes('aac')) ext = 'aac';
  else if (fm.includes('webm')) ext = 'webm';
  else if (fm.includes('ogg')) ext = 'ogg';
  else if (fm.includes('wav')) ext = 'wav';
  else if (fm.includes('m4a') || fm.includes('mp4')) ext = 'm4a';
  const name = filename || ('audio.' + (ext || 'm4a'));
  return uploadBlobToArk({ blob: dl.blob, filename: name, apiKey, baseUrl });
}

/** 从 MIME 推断扩展名（'' 时调用方回退）。与 media-downloader.js 的 extFromMime 语义一致。 */
export function extFromMime(mime) {
  if (!mime) return '';
  const m = String(mime).split(';')[0].toLowerCase();
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('aac')) return 'aac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  return '';
}

// ─── Ark Files 复用缓存 ────────────────────────────────────────────────────────
// Files API 官方定位就是「File ID 支持在多次请求中重复使用，避免重复上传」。这里把
// 上传成功的 file_id 按「baseUrl + key 指纹 + 视频资产标识」存 chrome.storage.local，
// 同一视频 30 天内再解析时直接复用，免掉最慢最容易失败的上传段（音频模式连下载+转码
// 一起免掉）。任何一环不可用（storage 缺失 / entry 损坏 / 文件过期 404）都 fail-open
// 回退完整上传流程，绝不因缓存引入新故障。

const ARK_FILE_CACHE_STORE_KEY = 'browsaArkFileCache';

/** 上传时随 FormData 发的 expire_at（Ark 允许 [now+1d, now+30d]，取 30 天上限）。 */
export function arkExpireAtSec(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000) + 30 * 86400;
}

/**
 * 从页面 URL 提取视频资产标识（缓存 key 的一部分）：B站取 BV 号 + 分P 号（cid 拿不到
 * 时 p 是最小的分P判别位），YouTube 取 v 参数。解析不出返回 ''（调用方回退旧行为）。
 */
export function videoAssetId(platform, pageUrl) {
  try {
    const u = new URL(pageUrl || '');
    if (platform === 'youtube') {
      const v = u.searchParams.get('v');
      return v ? 'yt-' + v : '';
    }
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname || '');
    if (!m) return '';
    return `bili-${m[1]}-p${u.searchParams.get('p') || '1'}`;
  } catch (_) {
    return '';
  }
}

/** 缓存 key：规整后的 baseUrl + apiKey 指纹 + 资产标识（file_id 不跨账号/网关通用）。 */
export function arkFileCacheKey(baseUrl, apiKey, assetId) {
  const fp = apiKey ? `${apiKey.length}:${apiKey.slice(-4)}` : 'nokey';
  return `${normalizeArkBaseUrl(baseUrl)}|${fp}|${assetId}`;
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
 */
export async function lookupCachedArkFiles({
  baseUrl, apiKey, platform, pageUrl, need = 'video', durationSec = 0, storageArea, aliveFn = arkFileAlive,
} = {}) {
  const assetId = videoAssetId(platform, pageUrl);
  if (!assetId) return null;
  const area = arkCacheStorageArea(storageArea);
  if (!area) return null;
  let entry = null;
  try {
    entry = (await area.get(ARK_FILE_CACHE_STORE_KEY))?.[ARK_FILE_CACHE_STORE_KEY]?.[arkFileCacheKey(baseUrl, apiKey, assetId)] || null;
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
    && await aliveFn({ baseUrl, apiKey, fileId: entry.videoFileId })) {
    out.videoFileId = entry.videoFileId;
  }
  if (fresh(entry.audioFileId, entry.audioExpireAt)
    && await aliveFn({ baseUrl, apiKey, fileId: entry.audioFileId })) {
    out.audioFileId = entry.audioFileId;
  }
  if (need === 'video' ? !out.videoFileId : !out.audioFileId) return null;
  return out;
}

/**
 * 写缓存（上传 + 轮询成功后调用）。video/audio 字段按本次实际上传的合并——视频模式
 * 只传视频时保留旧的音频字段，反之亦然（两次不同模式各自积累）。存储不可用静默放弃。
 */
export async function saveArkFileCacheEntry({
  baseUrl, apiKey, platform, pageUrl, videoFileId = '', audioFileId = '', durationSec = 0, storageArea,
} = {}) {
  const assetId = videoAssetId(platform, pageUrl);
  if (!assetId || (!videoFileId && !audioFileId)) return;
  const area = arkCacheStorageArea(storageArea);
  if (!area) return;
  const key = arkFileCacheKey(baseUrl, apiKey, assetId);
  let map = {};
  try {
    map = (await area.get(ARK_FILE_CACHE_STORE_KEY))?.[ARK_FILE_CACHE_STORE_KEY] || {};
  } catch (_) { /* 读失败按空 map 处理，写失败下方 catch */ }
  const prev = map[key] || {};
  const exp = arkExpireAtSec();
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
export async function transcribeAudio({ baseUrl: rawBaseUrl, apiKey, fileId, model, language = 'zh', signal, idleTimeoutMs = 60_000 }) {
  const baseUrl = normalizeArkBaseUrl(rawBaseUrl);
  // 'auto'（或空）＝让模型自己检测语种，不给具体的语种 hint。
  const langHint = language && language !== 'auto'
    ? `音频语种为 ${language}。`
    : '音频语种未知，请自动检测。';
  const body = {
    model,
    instructions:
      'Transcribe the audio verbatim in its original language. ' + langHint +
      'Output ONLY transcript lines, each starting with EXACTLY one bracket containing the single start ' +
      'timecode "[mm:ss]" (use "[h:mm:ss]" over an hour) followed by the text — e.g. "[00:12] 你好". ' +
      'NEVER output duration ranges like "[00:00-00:12]" and never add decimals like "[00:12.5]" — ' +
      'one plain start timestamp per line, nothing else inside the brackets. ' +
      'PUNCTUATION IS MANDATORY: add punctuation （，。！？） so every sentence is complete and readable; ' +
      'break long continuous speech into separate sentences at semantic boundaries — ' +
      'never output long run-on unpunctuated text. ' +
      'Put ONE sentence per line. ' +
      'SPEAKER LABELS (deterministic rules): count EVERY distinct human voice as a speaker — the host/narrator, ' +
      'an embedded or quoted recording (a played interview, speech or phone call), a voiceover, or a different person ' +
      'even when the language switches. If the ENTIRE audio has only ONE such voice, output NO labels at all. ' +
      'Otherwise label EVERY line EXACTLY: each line starts with ' +
      '"[mm:ss] [说话人N] text" (the label sits right after the timecode, with NO exception — this includes ' +
      'the main narrator/host, whose lines must also carry their own label). ' +
      'Numbers start at 1 for the first voice that appears and are assigned in order of first appearance ' +
      'across the ENTIRE audio; the same voice must keep the same number everywhere. ' +
      'Never merge two people into one number and never split one person into two. ' +
      'When a speaker\'s identity is evident from the content (a self-introduction, how others address them), append the name in parentheses at the end ' +
      'of that speaker\'s FIRST line — and AGAIN at their first line after every absence of about two minutes or longer, so long transcripts stay readable. ' +
      'LABEL WITH REAL NAMES when the identity is confirmed — evidence hierarchy: on-screen name card > self-introduction > how others address them > the video\'s title/description metadata. Use "[说话人:英博博士]" form: the most common appellation, IDENTICAL everywhere for the same person, at most 8 characters. Fall back to "[说话人N]" ONLY when the identity is genuinely unknown; both forms may coexist (numbered speakers keep the numbering rules above). ' +
    'Overlapping speech (crosstalk): attribute the line to the dominant voice; split into two separately-labelled lines only when both voices carry distinct, content-worthy statements. ' +
      'Preserve wording and order — no summary, no preamble, no markdown fences, no numbering.',
    input: [{
      role: 'user',
      content: [
        { type: 'input_audio', file_id: fileId },
        { type: 'input_text', text: '请逐字转写这段音频的语音内容：每句一行、每行行首加一个单一起始时刻时间戳 [mm:ss]（超过一小时用 [h:mm:ss]），时间戳永远是「分:秒」——禁止裸秒数（如 [62.0] 或 [62]），必须换算成 [01:02]；不要输出区间（如 [00:00-00:12]）也不要小数（如 [00:12.5]），括号内只放这一个起始时间；必须补全中文标点（，。！？），即使原音频没有明显停顿也要按语义断句，不要输出一整段没有标点的长句；行粒度：一行 = 一句完整的话或紧连的 1-3 个短句，不要把连续的碎片段各占一行；说话人标签规则：每一个独立人声都算一个说话人——主讲人/旁白、插播的采访或演讲录音、画外音、电话音、换了语言的其他人都算。只有一个人说话全程才不标；否则每一行都必须在时间戳后标注 [说话人N]（主讲人也不例外，无例外），编号从 1 开始按全片首次出现的声音顺序分配，同一个声音全片用同一个号，不能把两个人合并成一个号，也不能把一个人拆成两个号；说话人身份能从内容确认时（自我介绍、相互称呼），在该说话人第一行末尾括注姓名，并在消失约两分钟以上再次出现的第一行再次括注；两人同时说话（抢话）归给主导者，只有各自都有独立信息量时才拆成两行分别标注。' }
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
 * Responses API 流式请求共用底层（transcribeAudio 音频转写 / analyzeVideo 视听
 * 精读共用）。发送 body 到 {baseUrl}/responses 并解析 SSE：从
 * response.output_text.delta 累积文本（兼容 chat 兼容流的 choices[0].delta.content），
 * 每收到一个 chunk 重置“空闲超时”——长请求不会因中途长时间无数据而误超时
 * （stream:false 同步等待会超时：用户实测 “transcribe fetch failed: signal timed
 * out”，Ark 官方也建议长音频用流式）。
 * 返回 { text, raw, truncated?, finishReason? }：truncated 在输出被 token 上限
 * 截断时为 true，调用方必须据此拒绝把半截产物当完整结果存下来（真实 bug：
 * 52:48 视频只出 33 分钟字幕）。
 */
async function streamResponsesText({ baseUrl, apiKey, body, signal, idleTimeoutMs = 60_000 }) {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onOuterAbort);
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), idleTimeoutMs);
  };
  armIdle();
  let res;
  try {
    res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    cleanup();
    // 错误路径同样要拆掉 idle 定时器（否则挂起的定时器空转到触发，测试进程也会
    // 被这个活句柄拖住不退出）。
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 连接阶段被中止（墙钟超时/空闲超时都会表现为 fetch reject）——说清楚是哪一种，
    // 别把 Chrome 的 "BodyStreamBuffer was aborted" 直接甩给用户。
    if (signal?.aborted) {
      throw new Error('流式请求被中止：超时预算用尽——请重试，或先用较短的视频');
    }
    if (ac.signal.aborted) {
      throw new Error(`流式请求被中止：${Math.round(idleTimeoutMs / 1000)} 秒内未连上服务端（连接空闲超时）`);
    }
    throw new Error('transcribe fetch failed: ' + e.message);
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!res.ok) {
    cleanup();
    const data = await res.json().catch(() => null);
    throw new Error(`transcribe HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 300)}`);
  }

  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) {
    // 非流式响应兜底（某些网关可能忽略 stream:true）——回到同步解析。
    cleanup();
    const data = await res.json().catch(() => null);
    let text = '';
    for (const item of (data?.output || [])) {
      if (item?.type !== 'message') continue;
      for (const c of (item?.content || [])) {
        if (c?.type === 'output_text' && c?.text) text += (text ? '\n' : '') + c.text;
      }
    }
    if (!text) text = data?.output_text || data?.text || '';
    const truncated = !!(data?.status === 'incomplete' || data?.incomplete_details?.reason === 'max_output_tokens'
      || (Array.isArray(data?.output) && data.output.some((o) => o?.finish_reason === 'length')));
    console.log(`[ASR] transcribe: non-stream JSON fallback chars=${String(text || '').length} truncated=${truncated}`);
    return {
      text: String(text || '').trim(),
      raw: JSON.stringify(data),
      usage: extractUsageFromPayload(data),
      ...(truncated ? { truncated: true, finishReason: 'max_output_tokens' } : {}),
    };
  }

  // SSE 解析：累积 response.output_text.delta（Responses 流式）或
  // choices[0].delta.content（chat 兼容）。同时跟踪输出是否被 token 上限截断
  // （response.completed / finish_reason），被截断时返回 truncated:true，调用方
  // 不得把半截字幕当完整结果存下来（真实 bug：52:48 视频只出 33 分钟字幕）。
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason = '';
  let lastUsage = null;
  // 进入读取循环前重新武装空闲超时：post-fetch 清掉了连接阶段的定时器，而下面的
  // armIdle() 只在【收到数据】时触发——若服务端长时间不出首 token（视频精读的
  // 服务端抽帧预处理正是这种情形），没有定时器就只剩墙钟兜底，空闲保护形同虚设。
  armIdle();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // 有数据 -> 重置空闲超时
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const delta = extractSseDelta(eventBlock);
        if (delta !== null) full += delta;
        finishReason = finishReason || extractFinishReason(eventBlock);
        lastUsage = extractUsageFromPayload(ssePayload(eventBlock)) || lastUsage;
      }
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 尾部未以 \n\n 结束的残留事件
    if (buffer.trim()) {
      const delta = extractSseDelta(buffer);
      if (delta !== null) full += delta;
      finishReason = finishReason || extractFinishReason(buffer);
      lastUsage = extractUsageFromPayload(ssePayload(buffer)) || lastUsage;
    }
  } catch (e) {
    cleanup();
    // 错误路径同样要拆掉 idle 定时器（否则挂起的定时器空转到触发，测试进程也会
    // 被这个活句柄拖住不退出）。
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 被中止时 Chrome 抛的是 "BodyStreamBuffer was aborted"——用户完全看不懂。
    // 区分两种中止源，给出可操作的报错（墙钟优先判：墙钟触发时 ac 也被连带 abort）。
    if (signal?.aborted) {
      throw new Error('流式请求被中止：超时预算用尽，视频过长未能在预算内完成——请重试，或先用较短的视频');
    }
    if (ac.signal.aborted) {
      throw new Error(`流式请求被中止：${Math.round(idleTimeoutMs / 1000)} 秒内未收到服务端任何数据（空闲超时，可能服务端预处理尚未完成）`);
    }
    throw new Error('transcribe stream failed: ' + e.message);
  }
  cleanup();
  const truncated = finishReason === 'length' || finishReason === 'max_output_tokens' || finishReason === 'incomplete';
  // 正向排障日志：流是【服务端正常结束】还是被我们中断（异常会走 catch 抛错），
  // 输出字符数、finish_reason。下次复现半截字幕时，这一行能直接区分：
  //  - truncated=true + finishReason=length/incomplete → 模型输出被上限夹住
  //  - truncated=false + chars 明显偏少 → 服务端中途自己停了/其它原因
  //  - catch 抛出的 'transcribe stream failed' → 超时/中断（客户端侧）
  console.log(`[ASR] transcribe: SSE stream ended (server closed cleanly) chars=${String(full || '').length} truncated=${truncated} finishReason=${finishReason || 'none'} usage=${JSON.stringify(lastUsage || {})}`);
  return {
    text: String(full || '').trim(),
    raw: full,
    usage: lastUsage,
    ...(truncated ? { truncated: true, finishReason } : {}),
  };
}

/**
 * 从一段 SSE 事件块提取文本增量；无法解析或非文本事件返回 null。
 * 兼容两类流式：Responses API（response.output_text.delta / output_text.done
 * 的 text 字段）与 chat completions（choices[0].delta.content）。
 */
/** 取事件块里最后一个 data: JSON 负载（解析失败返回 null）。 */
function ssePayload(eventBlock) {
  let data = null;
  for (const line of String(eventBlock || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { data = JSON.parse(payload); } catch (_) { /* 下一行 */ }
  }
  return data;
}

/**
 * 从负载里取 token 用量（诊断用）。Responses 形态：response.completed 事件带
 * response.usage {input_tokens, output_tokens}；chat 兼容形态：流末尾的 usage
 * 对象（prompt_tokens/completion_tokens）。只透传数字字段。
 */
function extractUsageFromPayload(data) {
  const u = data?.usage || data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const k of ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']) {
    if (typeof u[k] === 'number') out[k] = u[k];
  }
  return Object.keys(out).length ? out : null;
}

function extractSseDelta(eventBlock) {
  for (const line of eventBlock.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      // Responses 流式：只从 response.output_text.delta 累加增量。
      // output_text.done 携带的是完整文本快照（delta 已累加过），不能再用，
      // 否则会重复（真实用例：delta=“你好” + done=“你好” → “你好你好”）。
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') return obj.delta;
      // chat 兼容：choices[0].delta.content
      const c = obj.choices?.[0]?.delta?.content;
      if (typeof c === 'string') return c;
      return null;
    } catch { return null; }
  }
  return null;
}

/**
 * 从一段 SSE 事件块提取“输出被截断”信号；无截断信号返回 ''。
 * 兼容：Responses API 的 response.completed（status/incomplete_details.reason）与
 * chat completions 的 choices[0].finish_reason。
 */
function extractFinishReason(eventBlock) {
  for (const line of eventBlock.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.type === 'response.completed') {
        const r = obj.response || {};
        if (r.status === 'incomplete') return 'incomplete';
        if (r.incomplete_details?.reason === 'max_output_tokens') return 'max_output_tokens';
      }
      const fr = obj.choices?.[0]?.finish_reason;
      if (fr === 'length') return 'length';
      return '';
    } catch { return ''; }
  }
  return '';
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
/**
 * 解析转写文本的时间轴为覆盖区间列表 [[startSec,endSec], ...]（未排序）。
 * 区间令牌 [a-b] 取 [a,b]；单时间戳与行首裸秒数取 [t,t]。
 * transcriptEndSec / largestTranscriptGapSec 共用本函数。
 */
function parseTranscriptTimeline(rawText) {
  if (!rawText) return [];
  // 形态：[mm:ss] | [mm:ss.mmm] | [h:mm:ss] | [mm:ss.mmm-mm:ss.mmm] | [h:mm:ss.mmm-h:mm:ss.mmm] |
  //       [mm:ss, mm:ss]（逗号/空白分隔——模型漂移真实案例 2026-08-24），(*) 可重复。
  const TS_RE = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:(?:\s*[-,]\s*|\s+)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)*\]/g;
  // 裸秒数兜底：只认【行首】纯数字（可带小数，保留小数精度——不能复用归一化的
  // 截断版，边界 90% 校验会误判）。>12h 视为非时间戳。
  const BARE_RE = /^\[(\d{1,5})(?:\.(\d{1,3}))?\]/;
  const toSec = (h, m, s, frac) => {
    const mm = parseInt(m, 10);
    const ss = parseInt(s, 10);
    const hh = h ? parseInt(h, 10) : 0;
    const f = frac ? parseFloat('0.' + frac) : 0;
    return hh * 3600 + mm * 60 + ss + f;
  };
  const intervals = [];
  for (const line of String(rawText).split(/\r?\n/)) {
    TS_RE.lastIndex = 0;
    let m;
    let matched = false;
    while ((m = TS_RE.exec(line)) !== null) {
      matched = true;
      const hasRange = m[5] != null || m[6] != null || m[7] != null || m[8] != null;
      const a = toSec(m[1], m[2], m[3], m[4]);
      // 注意不能只判 m[5]（右端小时）：普通分钟级区间 [33:17.22-33:25.45] 的
      // 右端小时是空的。
      intervals.push(hasRange ? [a, toSec(m[5], m[6], m[7], m[8])] : [a, a]);
      if (m.index === TS_RE.lastIndex) TS_RE.lastIndex++; // 防止零宽匹配死循环
    }
    // 本行没有任何 mm:ss 令牌才尝试裸秒数（混合文档：语音行裸秒、标记行 mm:ss）。
    if (!matched) {
      const bare = BARE_RE.exec(line);
      if (bare) {
        const total = parseFloat(bare[1] + (bare[2] ? '.' + bare[2] : ''));
        if (total <= 43200) intervals.push([total, total]);
      }
    }
  }
  return intervals;
}

export function transcriptEndSec(rawText) {
  const intervals = parseTranscriptTimeline(rawText);
  let maxEnd = null;
  for (const [, b] of intervals) {
    if (maxEnd == null || b > maxEnd) maxEnd = b;
  }
  return maxEnd;
}

/** 空窗判定阈值（秒）：相邻时间戳间隔超过它视为产物有整段缺失。 */
export const TRANSCRIPT_GAP_LIMIT_SEC = 300;

/** 秒 → [mm:ss]/[h:mm:ss] 形态（报错文案用）。 */
export function formatStampSec(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (h > 0 ? `${h}:` : '') + `${mm}:${ss}`;
}

/**
 * 找转写时间轴上最大的相邻空窗。2026-08-30 真实故障：81 分钟视频的精读只覆盖
 * 0-16 分钟 + 49:27 前后 + 片尾——「最后一个时间戳 ≥ 90% 时长」的守卫对中间
 * 空洞完全无感（last stamp 过线 → 静默存了缺 1 小时的产物）。
 * 覆盖区间先合并（区间的内部跨度不是空窗——[00:00-05:00] 自身 5 分钟是覆盖），
 * 再取合并后相邻区间的最大间隔。返回 { fromSec, toSec, gapSec } 或 null。
 */
export function largestTranscriptGapSec(rawText) {
  const intervals = parseTranscriptTimeline(rawText).slice().sort((a, b) => a[0] - b[0]);
  let worst = null;
  let curEnd = null;
  for (const [a, b] of intervals) {
    if (curEnd == null || a > curEnd) {
      // 与已合并覆盖区之间出现空隙
      if (curEnd != null) {
        const gapSec = a - curEnd;
        if (!worst || gapSec > worst.gapSec) worst = { fromSec: curEnd, toSec: a, gapSec };
      }
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b; // 重叠/相接 → 延伸覆盖
    }
  }
  return worst;
}

// ===================== 视频解析（视听精读） =====================
//
// 音频 ASR 之上的高级模式：B站 DASH 的视频流（无声）与音频流分别下载、分别上传
// 到方舟 Files API，然后用 Responses API 在【同一个请求】里以 input_video +
// input_audio 两个 content part 引用（两条输入共享同一条时间线，都从 0:00 开始），
// 让多模态模型融合画面与语音，产出带 [mm:ss] 时间戳的「视听精读」文档。下游与
// 字幕 ASR 完全同构（同一抽屉/搜索/记一笔/主 LLM 总结），唯一区别是产物的生产者。
// ※ input_video + input_audio 组合是设计推演路线，尚待实机验证：页面带 durl 合一
//   流（音画合一）时走单文件（input_video only，原生音轨最稳）；否则走双文件组合，
//   若方舟拒绝该组合，错误原样抛给调用方，用户退回音频模式即可。
// ※ 纯音频 m4s 会被方舟按内容判成视频（ASR 的真实教训）；反过来视频流被判成视频
//   正是我们要的，音频流转码成 WAV 后按内容判成音频，两条上传互不干扰。

/** 方舟 Files API 上传硬上限 512MB，选流预算留出余量。 */
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
 * 精读 instructions（英文格式纪律——时间戳/说话人/标点规则与 transcribeAudio
 * 同一套，保证产物能被 formatAsrTranscript / transcriptEndSec / 字幕抽屉直接消费）。
 * 纯函数，Node 可直接测试。
 */
export function buildVideoAnalysisInstructions(language = 'zh') {
  const langHint = language && language !== 'auto'
    ? `The audio language is ${language}; write the document in that language.`
    : 'The audio language is unknown; auto-detect it and write the document in the same language.';
  return 'You are producing a timestamped AUDIOVISUAL READING document (视听精读) for a video. ' +
    'The video track and the audio track arrive as TWO separate inputs sharing the SAME timeline (both start at 0:00); fuse them — ' +
    'the audio carries speech, the video carries on-screen text, slides, code, terminal output, charts, UI demonstrations and scene changes. ' +
    'Output ONLY document lines, each starting with EXACTLY one bracket containing the single start timecode "[mm:ss]" ' +
    '(use "[h:mm:ss]" over an hour) followed by the content — e.g. "[00:12] 你好". ' +
    'Timecodes are always MINUTES:SECONDS — raw seconds like "[62.0]" or "[62]" are FORBIDDEN, convert them to "[01:02]". ' +
    'NEVER output duration ranges like "[00:00-00:12]" and never add decimals like "[00:12.5]" — ' +
    'one plain start timestamp per line, nothing else inside the brackets. ' +
    'For each segment: (1) faithfully transcribe or tightly condense the SPOKEN content — technical terms, names and numbers must be exact; ' +
    '(2) when the visuals carry information beyond the speech (on-screen text, slide titles, code, terminal output, diagrams, demonstrated actions), ' +
    'transcribe or describe it in a 「画面：」 line right after the speech line it belongs to; ' +
    '(3) a purely visual segment with no speech gets its own line starting with 「画面：」. ' +
    'AD READS: when a segment is clearly a paid placement (a sponsored pitch interrupting the content), do NOT transcribe it verbatim — ' +
    'compress it into ONE line "[mm:ss] （广告：品牌+核心卖点）" and never place a keyframe marker inside it; ' +
    'content that merely discusses a product as part of the topic is NOT an ad. ' +
    'KEYFRAME SCREENSHOT MARKERS — KEY visuals ONLY: the transcript already carries the content; a marker is ONLY for a visual the argument DEPENDS on seeing ' +
    '(a data chart or figure being discussed, a slide or on-screen text with real information, code or terminal output, a key piece of evidence such as a document or note). ' +
    'A 15-20 minute video typically warrants around 6-10; scale with length. ' +
    'Do NOT capture title cards, section transitions, ending/thank-you cards, decorative cartoons, memes, or scene filler — and never capture the same visual twice (once, at its clearest appearance). ' +
    'Each marker is ONE line of its own immediately AFTER that 「画面：」 line: "[mm:ss] [截屏] 短标题" — the same timestamp as that moment, followed by a short noun-phrase title. ' +
    'At least 10 seconds apart; markers are additional lines, never replacements. ' +
    'Markers are additional lines, never replacements. ' +
    'PUNCTUATION IS MANDATORY: complete, readable sentences. ' +
    'LINE GRANULARITY: one line = one complete sentence or a tight run of 1-3 short sentences — typically 5-20 seconds of speech. ' +
    'Do NOT emit one line per short ASR/breath segment: consecutive fragments of the same sentence MUST be merged into a single line ' +
    'that starts at that sentence\'s first timestamp. ' +
    'SPEAKER LABELS (deterministic rules): count EVERY distinct human voice as a speaker — the host/narrator, an embedded or quoted recording ' +
    '(a played interview, speech or phone call), a voiceover, or a different person even when the language switches. ' +
    'If the ENTIRE audio has only ONE such voice, output NO labels at all. ' +
    'Otherwise label EVERY line EXACTLY: each line starts with ' +
    '"[mm:ss] [说话人N] text" (the label sits right after the timecode, with NO exception — this includes ' +
    'the main narrator/host, whose lines must also carry their own label). ' +
    'Numbers start at 1 for the first voice that appears and are assigned in order of first appearance ' +
    'across the ENTIRE video; the same voice must keep the same number everywhere. ' +
    'Never merge two people into one number and never split one person into two. ' +
    'DIARIZE WITH THE VISUAL CHANNEL (this is a video — use it): in interviews and podcasts the camera usually frames whoever is speaking, ' +
    'so the on-screen active speaker is the STRONGEST attribution signal — stronger than acoustic similarity. As each voice appears, bind its number ' +
    'to the on-screen identity: a lower-third name card, a self-introduction, or an unmistakable public figure. When two voices sound alike, ' +
    'disambiguate with the visual evidence and conversational context; never flip-flop a speaker\'s number mid-video. ' +
    'When a speaker\'s identity is evident from the video (a name card, an on-screen caption, a self-introduction, an unmistakable public figure), ' +
    'append the name in parentheses at the end of that speaker\'s FIRST line — e.g. "……（特朗普）" — and AGAIN at their first line after every absence ' +
    'of about two minutes or longer, so long documents stay readable. ' +
    'LABEL WITH REAL NAMES when the identity is confirmed — evidence hierarchy: on-screen name card > self-introduction > how others address them > the video\'s title/description metadata. Use "[说话人:英博博士]" form: the most common appellation, IDENTICAL everywhere for the same person, at most 8 characters. Fall back to "[说话人N]" ONLY when the identity is genuinely unknown; both forms may coexist (numbered speakers keep the numbering rules above). ' +
    'Overlapping speech (crosstalk): attribute the line to the dominant voice; split into two separately-labelled lines only when both voices carry distinct, content-worthy statements. ' +
    'Preserve chronological order and cover the video from start to finish INCLUDING the ending. ' +
    'No summary, no preamble, no markdown fences, no numbering. ' + langHint;
}

/**
 * 精读任务的中文 input_text（与 instructions 的英文格式纪律互补，跟
 * transcribeAudio 的双语结构一致）。durationSec > 0 时附带总时长 hint，
 * 帮模型把时间戳铺满全片（完整性校验 transcriptEndSec 依赖这一点）。
 */
export function buildVideoAnalysisTaskText(durationSec = 0, language = 'zh', metaHint = '') {
  const durHint = durationSec > 0 ? `视频总长约 ${Math.round(durationSec / 60)} 分钟，请把时间戳均匀铺满全片、一直标到结尾。` : '';
  const meta = metaHint ? `视频元信息（用于识别说话人姓名与职务，仅供参考，不要原样写进正文）：${metaHint}。` : '';
  return '请结合画面与声音，逐段产出这份视频的「视听精读」文档：语音内容忠实转写（术语、人名、数字必须准确）；' +
    '画面里超出语音的独立信息（屏幕文字、幻灯片标题、代码、终端输出、图表、演示操作）用「画面：」单独成行转写或描述；' +
    '纯画面无语音的段落也单独一行以「画面：」开头。' +
    '广告口播：遇到明显的商单/广告口播段落，不要逐字转写，压缩成一行 `[mm:ss] （广告：品牌+核心卖点）`，并且不要在广告段内输出截图标记；只是客观介绍产品的不算广告。' +
    '关键帧截图标记——只截【关键】画面：转写已承载内容，只有当论证依赖看到该画面时才标记（正在讲解的数据图表、有独立信息的幻灯片或屏幕文字、代码或终端输出、文件便签等关键证据）。' +
    '15-20 分钟的视频通常 6-10 处即可，更长视频相应增加。' +
    '不要截：标题卡、章节转场、片尾致谢卡、装饰性卡通或表情包、与讲解无关的空镜——同一画面只截一次，选它最清晰的那次出现。' +
    '紧随「画面：」行单独加一行 `[mm:ss] [截屏] 短标题`（时间与该画面一致，标题用简短名词短语）；彼此至少间隔 10 秒。' +
    '每行行首加一个单一起始时刻时间戳 [mm:ss]（超过一小时用 [h:mm:ss]），括号内只放这一个起始时间，不要区间也不要小数；' +
    '时间戳永远是「分:秒」——禁止裸秒数（如 [62.0] 或 [62]），必须换算成 [01:02]。' +
    '必须补全标点。行粒度：一行 = 一句完整的话或紧连的 1-3 个短句（通常对应 5-20 秒语音）；' +
    '不要把连续的碎片段各占一行——同一句话的连续片段必须合并成一行，时间戳用这句话开头的时刻。说话人标签规则：每一个独立人声都算一个说话人——主讲人/旁白、插播的采访或演讲录音、画外音、电话音、换了语言的其他人都算；' +
    '只有一个人说话全程才不标，否则每一行都在时间戳后标注 [说话人N]（主讲人也不例外），' +
    '编号按全片首次出现的顺序从 1 开始分配，同一个声音全片用同一个号，不能合并也不能拆分。' +
    '用画面辅助分辨说话人（这是视频）：访谈/播客类镜头通常正对着正在说话的人——画面中的当前发言者是最强的归属信号，强于听声音相似度；' +
    '每个声音一出现就把编号绑定到画面身份（姓名条、自我介绍、公众人物），两个声音听感相似时用画面与上下文消歧，绝不在中途调换编号。' +
    '标签优先用真实名字：当能从画面姓名条、自我介绍、他人称呼或视频简介确认身份时，用 `[说话人:英博博士]` 形态（取最常用的称呼，全片同一人必须同一写法，最长 8 字）；身份确实未知才用 `[说话人N]`，两种形态可混用。' +
    '说话人身份能从画面确认时（姓名条、字幕条、自我介绍、公众人物），在该说话人第一行末尾括注姓名或职务（如「……（特朗普）」「……（艾博生物CEO）」），' +
    '并在该说话人消失约两分钟以上再次出现的第一行再次括注——长文档才不会读着读着忘了谁是谁；' +
    '两人同时说话（抢话）归给主导者，只有各自都有独立信息量时才拆成两行分别标注。' + durHint + meta +
    '从开头覆盖到结尾，不要总结、不要开场白、不要代码块围栏。';
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
    instructions: buildVideoAnalysisInstructions(language),
    input: [{ role: 'user', content }],
    stream: true,
    // 精读文档覆盖整段视频（语音转写 + 画面转写），输出远大于默认上限——与 ASR
    // 相同的 max_output_tokens 放开逻辑（Responses 会夹到模型上限，配合流式
    // finish_reason 检测兜底截断）。
    max_output_tokens: 65536,
  };
  return streamResponsesText({ baseUrl, apiKey, body, signal, idleTimeoutMs });
}

// ─── 服务商适配器注册表 ────────────────────────────────────────────────────────
// transcribeAudio / analyzeVideo（本文件）即火山方舟适配器——签名对全部供应商
// 统一：入参 { baseUrl, apiKey, fileId..., model, language, signal, idleTimeoutMs }，
// 出参 { text, truncated?, finishReason? }。新供应商（百炼/GLM…）= 在 ASR_PROVIDERS
// 注册表加元数据 + 这里注册一个同签名适配器，sidepanel 经 asrAdapterFor(asr.provider)
// 分发，UI 与管线零改动。未知 id 回退 ark（老配置无 provider 字段时同样成立）。
const ASR_ADAPTERS = {
  ark: { transcribeAudio, analyzeVideo },
};

export function asrAdapterFor(providerId) {
  return ASR_ADAPTERS[providerId] || ASR_ADAPTERS.ark;
}
