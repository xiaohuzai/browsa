// lib/handlers/attach-asr-media.js — media capture and transcoding for the
// ASR / 视听精读 pipelines: download the platform's audio, transcode to the
// 16kHz mono WAV the speech API expects, upload to Ark's Files API, plus the
// small mp4/mime helpers the orchestrator needs.
//
// Extracted from lib/handlers/attach-asr.js (2026-10-17). attach-asr.js
// re-exports every symbol here, so the public import surface is unchanged.
//
// Everything runs in the extension context (sidepanel / service worker), NOT
// injected into the page: the Ark upload is a cross-origin POST with no CORS
// headers on the provider side, and the platform CDN headers come from a DNR
// session rule the caller registers first.

import { normalizeArkBaseUrl, arkExpireAtSec } from './ark-endpoints.js';

const TRANSCODE_SAMPLE_RATE = 16000;
const TRANSCODE_CHANNELS = 1;

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
          const raw = xhr.responseText || '';
          let upData = null;
          try { upData = JSON.parse(raw || '{}'); } catch (_) {
            // Non-JSON body (gateway HTML error page, plain-text rejection):
            // keep the beginning of it so the surfaced error is diagnosable
            // instead of the meaningless `{}`.
            upData = raw ? { raw: raw.slice(0, 300) } : null;
          }
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

/**
 * 从 MP4 容器的 mvhd box 读总时长（秒，纯函数，Node 可直接测试）。
 * 原始字节直传路径的截断校验用：decodeAudioData 对几小时的普通 MP4 会整体解码进
 * 内存（149MB m4a → 数 GB float32，Chrome 直接拒——2026-10-07 小宇宙真机实测），
 * 而校验只需要元数据。顶层 box 游走找 moov → moov 内找 mvhd → 按 version 读
 * timescale/duration（v0 全 u32；v1 的时间戳是 u64）。解析不出（moov 在尾部且
 * 下载被截断、非 MP4 容器）返回 0，调用方决定是否放行。
 */
export function mp4DurationSec(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);
    const type4 = (off) => String.fromCharCode(
      view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    // 顶层 box 游走找 moov
    let off = 0;
    let moov = -1;
    while (off + 8 <= view.byteLength) {
      const size = view.getUint32(off);
      if (size < 8) break;
      if (type4(off + 4) === 'moov') { moov = off; break; }
      off += size;
    }
    if (moov === -1) return 0;
    // moov 内找 mvhd
    const moovEnd = moov + view.getUint32(moov);
    let p = moov + 8;
    while (p + 12 <= moovEnd) {
      const size = view.getUint32(p);
      if (size < 8) break;
      if (type4(p + 4) === 'mvhd') {
        const version = view.getUint8(p + 8);
        let timescale, duration;
        if (version === 1) {
          timescale = view.getUint32(p + 28);
          duration = view.getUint32(p + 32) * 4294967296 + view.getUint32(p + 36);
        } else {
          timescale = view.getUint32(p + 20);
          duration = view.getUint32(p + 24);
        }
        return timescale > 0 ? duration / timescale : 0;
      }
      p += size;
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

/** 从 MIME 推断扩展名（'' 时调用方回退）。 */
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
