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
//   [上传]    FormData POST 到 /api/v3/files → 返回 file_id。
//   [轮询+转写] 轮询 GET /api/v3/files/{id} 直到非 processing，再 POST /api/v3/responses 带
//              input_audio.file_id + ASR 指令 → 带 [mm:ss] 的字幕文本。
//
// 函数分两类：
//   * sidepanel/extension-context 函数：普通 async，可 import 本模块其它函数，跑在带
//     host_permissions 的扩展上下文（免 CORS）。
//   * 纯函数（encodePcmToWav 等）：无浏览器依赖，Node 可直接测试。

/** 默认方舟配置（与 storage.js 的 asr DEFAULTS 保持同步）。 */
export const ASR_DEFAULTS = {
  enabled: false,
  apiKey: '',                                    // ark.cn-beijing.volces.com 的 Bearer key
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-2-0-lite-260428',          // 已开通的音频理解/ASR 模型 ID
  language: 'zh',                                // 识别语种
  format: 'audio/x-m4a',                         // 上传 MIME（B站 m4s 是 fMP4；08-16 起转码后实际传 WAV）
  timeoutMs: 150_000,                            // 轮询总预算
};

/** ASR 转码目标：16kHz 单声道（语音识别标准，文件小，方舟支持）。 */
export const TRANSCODE_SAMPLE_RATE = 16000;
export const TRANSCODE_CHANNELS = 1;

/**
 * 把方舟 Base URL 规整到标准版端点（纯函数）。
 *
 * 2026-08-15 实机发现：用户配置里填了 https://ark.cn-beijing.volces.com/api/plan/v3 —— 那是火山
 * 方舟 Agent Plan（给 Claude Code / Hermes 等 Coding Agent 用的 OpenAI 兼容接口）的专属 Base URL，
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
export async function downloadAudioBytes({ audioUrl, onProgress } = {}) {
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
    const resp = await fetch(audioUrl, {
      headers: { Referer: 'https://www.bilibili.com', Range: 'bytes=0-' }
    });
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
 * @returns {Promise<{ text: string, raw: string }>}
 */
export async function transcribeAudio({ baseUrl: rawBaseUrl, apiKey, fileId, model, language = 'zh', signal, idleTimeoutMs = 60_000 }) {
  const baseUrl = normalizeArkBaseUrl(rawBaseUrl);
  const langHint = language ? `音频语种为 ${language}。` : '';
  const body = {
    model,
    instructions:
      'Transcribe the audio verbatim in its original language. ' + langHint +
      'Output ONLY transcript lines, each starting with its [mm:ss] timecode ' +
      '(use [h:mm:ss] over an hour). ' +
      'PUNCTUATION IS MANDATORY: add punctuation （，。！？） so every sentence is complete and readable; ' +
      'break long continuous speech into separate sentences at semantic boundaries — ' +
      'never output long run-on unpunctuated text. ' +
      'Put ONE sentence per line. ' +
      'If MULTIPLE distinct speakers are present, add a speaker label after the timecode ' +
      '(e.g. "[00:12] [说话人1] 你好"); if single speaker (monologue), do NOT add labels. ' +
      'Preserve wording and order — no summary, no preamble, no markdown fences, no numbering.',
    input: [{
      role: 'user',
      content: [
        { type: 'input_audio', file_id: fileId },
        { type: 'input_text', text: '请逐字转写这段音频的语音内容：每句一行、每行行首加 [mm:ss] 时间戳，必须补全中文标点（，。！？），即使原音频没有明显停顿也要按语义断句，不要输出一整段没有标点的长句；多位说话人时在时间戳后标注 [说话人1]/[说话人2]。' }
      ]
    }],
    stream: true,
  };

  // 流式转写：长音频（如 2 小时）用 stream:false 同步等待会超时（用户实测
  // “transcribe fetch failed: signal timed out”，Ark 官方也建议长音频用流式
  // 避免客户端超时）。这里解析 SSE，从 response.output_text.delta 累积文本；
  // 每收到一个 chunk 重置“空闲超时”，长转写不会因中途长时间无数据而误超时。
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
    return { text: String(text || '').trim(), raw: JSON.stringify(data) };
  }

  // SSE 解析：累积 response.output_text.delta（Responses 流式）或
  // choices[0].delta.content（chat 兼容）。
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
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
      }
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 尾部未以 \n\n 结束的残留事件
    if (buffer.trim()) {
      const delta = extractSseDelta(buffer);
      if (delta !== null) full += delta;
    }
  } catch (e) {
    cleanup();
    throw new Error('transcribe stream failed: ' + e.message);
  }
  cleanup();
  return { text: String(full || '').trim(), raw: full };
}

/**
 * 从一段 SSE 事件块提取文本增量；无法解析或非文本事件返回 null。
 * 兼容两类流式：Responses API（response.output_text.delta / output_text.done
 * 的 text 字段）与 chat completions（choices[0].delta.content）。
 */
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
 * 把 ASR 原始文本整理成干净的 [mm:ss] 字幕行列表。
 * 模型输出的可能不完美（可能漏 [mm:ss] 前缀、可能带多余说明），这里做防御性规整：
 * 保留含时间戳的行；无时间戳的纯文本行也保留（回退给模型内容），但丢掉明显是
 * 开场白/结尾说明的行（"以下是转录…"/"以上是…"等）。
 *
 * @param {string} rawText
 * @returns {{ lines: string[], usedTimestamps: number }}
 */
export function formatAsrTranscript(rawText) {
  if (!rawText) return { lines: [], usedTimestamps: 0 };
  const lines = String(rawText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const TS_RE = /\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/;
  const out = [];
  let usedTimestamps = 0;
  for (const line of lines) {
    if (isMetaLine(line)) continue;      // 开场白/结尾说明
    const clean = line.replace(/^[-*>]\s*/, '').trim();  // 去掉可能的列表前缀
    if (!clean) continue;
    if (TS_RE.test(clean)) usedTimestamps++;
    out.push(clean);
  }
  return { lines: out, usedTimestamps };
}

/** 是否明显是模型夹带的说明行（不是字幕内容）。 */
function isMetaLine(line) {
  return /^(以下是|以上是|转录|转写|识别|字幕|开始|结束|时间戳|注[:：])/.test(line);
}
