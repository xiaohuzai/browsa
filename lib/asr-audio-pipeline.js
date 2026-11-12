// lib/asr-audio-pipeline.js — the side-effectful half of audio ASR:
// download → transcode → upload → poll → transcribe → completeness guards.
//
// Extracted from lib/sidepanel/attach-orchestrator.js (2026-11-11) so the
// exact same pipeline can run in the side panel (video analysis / fallback)
// and in the offscreen ASR runner (survives side-panel close). Do not fork
// this logic into offscreen.js: provider protocol, truncation guards, and
// upload/caching semantics must stay single-source.
//
// `env` is the execution seam:
//   progress({ phase, text, doneBytes?, totalBytes? })
//   refreshStreams(platform, want) -> fresh streams or null
//   onTaskSubmitted(taskId, meta)  (optional; Qwen filetrans)
//   onStatus(status)               (optional; provider task poll)
//   onUploaded(fileId)             (optional; persist the upload checkpoint)
//   signal                          (optional external abort)
//   pollBudgetMs                   (optional override for the transcribe budget)

import { t as _t, tSub } from './i18n.js';
import {
  downloadAudioBytes, transcodeAudioBlob, asrAdapterFor, formatAsrTranscript,
  transcriptEndSec, largestTranscriptGapSec, TRANSCRIPT_GAP_LIMIT_SEC, formatStampSec,
  videoAssetId, lookupCachedArkFiles, saveArkFileCacheEntry, parseAsrHotwords,
  extFromMime, mp4DurationSec,
} from './handlers/attach-asr.js';

function progress(env, event) {
  try { env?.progress?.(event); } catch (_) { /* progress must never break a job */ }
}

function refreshStreams(env, platform, want) {
  return env?.refreshStreams
    ? env.refreshStreams(platform, want)
    : Promise.resolve(null);
}

/**
 * "still working" pulse for the long poll/transcribe phase. The side panel
 * turns the event into showAttachProgress; the offscreen runner persists it.
 */
function startStagePulse(initialLabel, env, initialPhase = 'polling') {
  const startedAt = Date.now();
  let stageLabel = initialLabel;
  let phase = initialPhase;
  const tick = () => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    progress(env, {
      phase,
      text: tSub('progressStageWait', '$1中…（已等待 $2s）', stageLabel, secs),
    });
  };
  tick();
  const timer = setInterval(tick, 1000);
  return {
    set(label, nextPhase = 'transcribing') {
      stageLabel = label;
      phase = nextPhase;
      tick();
    },
    stop() { clearInterval(timer); },
  };
}

// 音频上传产物随适配器：方舟必须 WAV（上传内容会被方舟按内容预处理分类，fMP4 纯音频
// 被判成视频 → failed，08-16 实机教训）；百炼 OSS 是纯存储、任务解码时才碰内容——
// 直传原始字节（16kHz WAV 是源流的 ~4 倍体积，2026-10-07 用户实测上传慢的主因）。
// 原始扩展名从 CDN content-type 推（缺失按 .m4a 兜底：B 站 m4s / YouTube m4a 都是
// MP4 容器 AAC）；oss:// key 以文件名结尾，百炼据此解码。
export function audioUploadArtifact(transcodeResult, fnameBase, adapter) {
  const useOriginal = adapter.audioUploadFormat === 'original';
  const ext = useOriginal ? (transcodeResult.originalExt || 'm4a') : 'wav';
  const blob = useOriginal ? transcodeResult.originalBlob : transcodeResult.wavBlob;
  return { blob, name: fnameBase ? `${fnameBase}-audio.${ext}` : `audio.${ext}` };
}

/**
 * 下载最佳音频流并转码成 16kHz mono WAV（候选循环 + 截断换流 + 403 自愈），音频
 * 转写与视频精读两条管线共用。want 透传给 403 自愈的 ASR_FRESH_URLS：'audio'
 * 只刷音频流（纯 ASR 行为）；'all' 连 video/muxed 一起刷新——本函数自己仍只消费
 * 音频条目，视频条目由调用方（视频管线）重新选流。
 * 返回 { wavBlob, wavBytes, sampleRate, bytes, usedLabel }；全部候选失败时抛错。
 */
export async function downloadAndTranscodeAudioBest({ ctx, platform, wantDurSec, want = 'audio', env }) {
  // 上传形态随适配器（original = 百炼原始字节直传 → 校验走 mvhd，不解码）
  const adapter = asrAdapterFor(ctx.asr?.provider);
  const candidates = (() => {
    const seen = new Set();
    const out = [];
    const push = (u, label, meta) => { if (u && !seen.has(u)) { seen.add(u); out.push({ url: u, label: label || '', ...(meta || {}) }); } };
    push(ctx.audioUrl, ctx.audioLabel, { codecs: ctx.audioCodec || '', id: ctx.audioId || 0 });
    for (const c of (Array.isArray(ctx.audioCandidates) ? ctx.audioCandidates : [])) {
      push(c.url, c.label, { codecs: c.codecs || '', id: c.id || 0 });
    }
    return out;
  })();
  let trans = null;
  let audioBytes = 0;
  let usedLabel = '';
  let lastErr = '';
  let urlsRefreshed = false;   // 403 自愈：整个 attach 只重新签名一次
  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci];
    const isLast = ci === candidates.length - 1;
    const dlStart = Date.now();
    const dlTimer = setInterval(() => {
      const secs = Math.round((Date.now() - dlStart) / 1000);
      progress(env, { phase: 'downloading', text: tSub('progressDownloadAudioWait', '下载音频中…（已等待 $1s）', secs) });
    }, 1000);
    let dl;
    try {
      dl = await downloadAudioBytes({
        audioUrl: cand.url,
        signal: env?.signal,
        ...(platform === 'bilibili' ? {} : { headers: { Range: 'bytes=0-' } }),
        onProgress: (done, total) => {
          if (total) {
            progress(env, {
              phase: 'downloading',
              text: tSub('progressDownloadAudioPct', '下载音频中…（$1%）', Math.round((done / total) * 100)),
              doneBytes: done, totalBytes: total,
            });
          } else {
            const secs = Math.round((Date.now() - dlStart) / 1000);
            progress(env, {
              phase: 'downloading',
              text: tSub('progressDownloadAudioMbWait', '下载音频中…（已下载 $1MB，已等待 $2s）', (done / 1024 / 1024).toFixed(1), secs),
              doneBytes: done, totalBytes: null,
            });
          }
        },
      });
    } finally {
      clearInterval(dlTimer);
    }
    if (!dl?.ok || !dl.blob) {
      lastErr = 'ASR download failed: ' + (dl?.error || 'no blob');
      const cookieDiag = ctx.biliCookie ? `cookie:${ctx.biliCookie.length}chars` : 'cookie:EMPTY';
      console.warn('[ASR]', lastErr, `[${cookieDiag}]`);
      if (!urlsRefreshed && /403/.test(lastErr) && (platform === 'youtube' || platform === 'bilibili')) {
        urlsRefreshed = true;
        const fresh = await refreshStreams(env, platform, want);
        if (fresh) {
          console.log(`[ASR] ${platform} streams refreshed -> ${fresh.length} streams, retrying download`);
          candidates.length = 0;
          for (const s of fresh) {
            if (s.type && s.type !== 'audio') continue;
            candidates.push({ url: s.url, label: s.label || '', codecs: s.codecs || '', id: s.id || 0 });
          }
          ci = -1;
          continue;
        }
      }
      if (isLast) throw new Error(lastErr);
      continue;
    }
    const dlBytes = dl.bytes || 0;
    console.log('[ASR] downloaded m4s', dlBytes, 'bytes; url host:', (() => { try { return new URL(cand.url).host; } catch { return '?'; } })(), '| codec:', cand.codecs || '?', '| id:', cand.id || 0, '| label:', cand.label || '');
    if (adapter.audioUploadFormat === 'original') {
      let mvhdSec = 0;
      try { mvhdSec = mp4DurationSec(await dl.blob.arrayBuffer()); } catch (e) {
        console.warn('[ASR] mvhd duration parse failed — truncated-audio gate skipped:', e && e.message);
      }
      const short = wantDurSec > 0 && mvhdSec > 0 && mvhdSec < wantDurSec * 0.9;
      console.log('[ASR] mvhd duration', mvhdSec > 0 ? mvhdSec.toFixed(0) + 's' : 'unknown', 'vs video', wantDurSec, 's', short ? '→ TRUNCATED' : '');
      if (short) {
        if (candidates.length > 1) {
          console.warn('[ASR] stream too short (' + mvhdSec.toFixed(0) + 's < 90% of ' + wantDurSec + 's) — trying next candidate');
          continue;
        }
        throw new Error('ASR audio stream is truncated (' + mvhdSec.toFixed(0) + 's vs video ' + wantDurSec + 's)');
      }
      trans = { ok: true, originalBlob: dl.blob };
      audioBytes = dlBytes;
      usedLabel = cand.label;
      break;
    }
    progress(env, { phase: 'transcoding', text: _t('progressTranscodeAudio', '转码音频中…（转为 WAV）') });
    const trStart = Date.now();
    const trTimer = setInterval(() => {
      const secs = Math.round((Date.now() - trStart) / 1000);
      progress(env, { phase: 'transcoding', text: tSub('progressTranscodeAudioWait', '转码音频中…（已等待 $1s）', secs) });
    }, 1000);
    let tr;
    try {
      tr = await transcodeAudioBlob(dl.blob);
    } finally {
      clearInterval(trTimer);
    }
    if (!tr?.ok || !tr.wavBlob) {
      lastErr = 'ASR transcode failed: ' + (tr?.error || 'no wav');
      console.warn('[ASR]', lastErr, ci < candidates.length - 1 ? '— trying next candidate' : '');
      if (isLast) throw new Error(lastErr);
      continue;
    }
    const wavDur = tr.wavBytes / ((tr.sampleRate || 16000) * 2);
    const isShort = wantDurSec > 0 && wavDur < wantDurSec * 0.9;
    console.log('[ASR] transcoded -> WAV', tr.wavBytes, 'bytes, sampleRate', tr.sampleRate, '| wav dur ~', wavDur.toFixed(0), 's vs video', wantDurSec, 's', isShort ? '→ TRUNCATED' : '');
    if (isShort) {
      if (candidates.length > 1) {
        console.warn('[ASR] stream too short (' + wavDur.toFixed(0) + 's < 90% of ' + wantDurSec + 's) — trying next candidate');
        continue;
      }
      throw new Error('ASR audio stream is truncated (' + wavDur.toFixed(0) + 's vs video ' + wantDurSec + 's)');
    }
    trans = tr;
    audioBytes = dlBytes;
    usedLabel = cand.label;
    trans.originalBlob = dl.blob;
    break;
  }
  if (!trans?.ok || (!trans.wavBlob && !trans.originalBlob)) {
    throw new Error(lastErr || 'ASR transcode failed: no usable audio stream');
  }
  if (usedLabel) console.log('[ASR] using audio stream:', usedLabel);
  return {
    wavBlob: trans.wavBlob, wavBytes: trans.wavBytes, sampleRate: trans.sampleRate,
    originalBlob: trans.originalBlob || null,
    originalExt: trans.originalBlob ? (extFromMime(trans.originalBlob.type) || 'm4a') : '',
    bytes: audioBytes, usedLabel,
  };
}

/**
 * 音频转写管线：下载并转码最佳音频流 → 上传 → 轮询 → 流式转写 → 截断/完整度
 * 校验。返回 { transcriptText, audioBytes, fileId }。
 */
export async function runAudioTranscribePipeline({ ctx, platform, wantDurSec, env }) {
  const { asr } = ctx;
  const adapter = asrAdapterFor(asr.provider);
  const pageUrl = ctx.meta?.url || '';
  const assetId = videoAssetId(platform, pageUrl);
  const fnameBase = assetId ? `browsa-${assetId}` : '';
  const cached = await lookupCachedArkFiles({
    baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl,
    need: 'audio', durationSec: wantDurSec,
    provider: asr.provider, model: asr.model, aliveFn: adapter.alive,
  }).catch(() => null) || { videoFileId: '', audioFileId: '' };
  // A job-store checkpoint can be newer than browsaArkFileCache: the upload
  // succeeded, but the process died before saveArkFileCacheEntry() ran.
  // Reusing that file id avoids a second upload (and, for Ark, still lets the
  // poll below wait for preprocessing).
  const providedFileId = String(env?.fileId || '').trim();
  const cachedFileId = cached.audioFileId || providedFileId;
  let best = null;
  if (cachedFileId) {
    console.log('[ASR] reusing cached audio fileId', cachedFileId);
    progress(env, { phase: 'uploading', text: _t('progressReuseAudio', '复用上次上传的音频文件，跳过下载与上传…') });
  } else {
    best = await downloadAndTranscodeAudioBest({ ctx, platform, wantDurSec, want: 'audio', env });
  }
  let up;
  if (cachedFileId) {
    up = { fileId: cachedFileId };
  } else {
    progress(env, { phase: 'uploading', text: _t('progressUploadAudio', '上传音频中…（0%）') });
    const upArtifact = audioUploadArtifact(best, fnameBase, adapter);
    const upStart = Date.now();
    up = await adapter.upload({
      blob: upArtifact.blob,
      filename: upArtifact.name,
      apiKey: asr.apiKey,
      baseUrl: asr.baseUrl,
      model: asr.model,
      signal: env?.signal,
      onProgress: (done, total) => {
        if (total) {
          progress(env, {
            phase: 'uploading',
            text: tSub('progressUploadAudioPct', '上传音频中…（$1%）', Math.round((done / total) * 100)),
            doneBytes: done, totalBytes: total,
          });
        } else {
          const secs = Math.round((Date.now() - upStart) / 1000);
          progress(env, {
            phase: 'uploading',
            text: tSub('progressUploadAudioMbWait', '上传音频中…（已上传 $1MB，已等待 $2s）', (done / 1024 / 1024).toFixed(1), secs),
            doneBytes: done, totalBytes: null,
          });
        }
      },
    });
    if (!up?.ok || !up.fileId) {
      throw new Error('ASR upload failed: ' + (up?.error || 'no fileId'));
    }
    const elapsed = Math.round((Date.now() - upStart) / 1000);
    const speed = elapsed > 0 ? ((up.bytes / 1024 / 1024) / elapsed).toFixed(1) : '?';
    console.log('[ASR] uploaded fileId', up.fileId, '| sent', up.bytes, `| ${elapsed}s (${speed}MB/s)`, '| upload meta:', JSON.stringify({ upBytes: up.upBytes, upContentType: up.upContentType, upStatus: up.upStatus }));
  }
  // Persist the upload handle before the first side-effectful follow-up
  // (task submit / streaming transcribe). If the runner dies right after
  // this point, the next attempt can reuse the file instead of re-uploading.
  try { await env?.onUploaded?.(up.fileId); } catch (_) { /* telemetry */ }
  const pulse = startStagePulse(_t('stageRecognizing', '识别处理'), env, 'polling');
  try {
    if (adapter.poll) {
      const poll = await adapter.poll(asr.baseUrl, asr.apiKey, up.fileId, {
        timeoutMs: asr.timeoutMs,
        signal: env?.signal,
      });
      console.log('[ASR] poll result:', JSON.stringify(poll));
      if (!poll.ready) {
        throw new Error('ASR file processing failed: ' + (poll.error || ''));
      }
    }
    await saveArkFileCacheEntry({
      baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl, durationSec: wantDurSec,
      audioFileId: cached.audioFileId ? '' : up.fileId,
      provider: asr.provider, model: asr.model, ttlSec: adapter.fileCacheTtlSec,
    });
    pulse.set(_t('stageTranscribing', '转写'), 'transcribing');
    const budget = Number(env?.pollBudgetMs) > 0
      ? Number(env.pollBudgetMs)
      : Math.max(10 * 60_000, Math.min(45 * 60_000, Math.round((wantDurSec || 0) * 1000 / 2)));
    const tr = await adapter.transcribeAudio({
      baseUrl: asr.baseUrl,
      apiKey: asr.apiKey,
      fileId: up.fileId,
      model: asr.model,
      language: asr.language,
      durationSec: wantDurSec,
      hotwords: parseAsrHotwords(asr.hotwords),
      signal: env?.signal || AbortSignal.timeout(budget),
      onTaskSubmitted: env?.onTaskSubmitted,
      onStatus: env?.onStatus,
    });
    if (tr.truncated) {
      console.warn('[ASR] model output truncated:', tr.finishReason);
      throw new Error(tSub('errAsrTruncated', 'ASR 转写被模型输出上限截断（$1）', tr.finishReason || 'max_output_tokens'));
    }
    const fmt = formatAsrTranscript(tr.text);
    console.log('[ASR] transcribe usage:', JSON.stringify(tr.usage || {}));
    const endSec = transcriptEndSec(tr.text);
    const incomplete = !!(wantDurSec > 0 && endSec != null && endSec < wantDurSec * 0.9);
    if (incomplete) {
      console.warn('[ASR] transcript incomplete: last stamp', endSec, 's < 90% of', wantDurSec, 's video');
      throw new Error('ASR transcript is incomplete (' + (endSec == null ? '?' : endSec.toFixed(0)) + 's of ' + wantDurSec + 's video)');
    }
    const gap = largestTranscriptGapSec(tr.text);
    if (gap && gap.gapSec > TRANSCRIPT_GAP_LIMIT_SEC) {
      console.warn('[ASR] transcript incomplete: gap', JSON.stringify(gap));
      throw new Error(tSub('errAsrIncompleteGap', 'ASR transcript is incomplete (时间轴 $1 分钟空窗：$2 → $3)', Math.round(gap.gapSec / 60), formatStampSec(gap.fromSec), formatStampSec(gap.toSec)));
    }
    if (endSec != null) {
      console.log(`[ASR] transcript complete: last stamp ${endSec.toFixed(1)}s (${(wantDurSec > 0 ? ((endSec / wantDurSec) * 100).toFixed(0) : '?')}% of ${wantDurSec}s video)`);
    }
    const finalText = fmt.lines.join('\n');
    if (!finalText) {
      throw new Error('ASR returned empty transcript');
    }
    return { transcriptText: finalText, audioBytes: best ? best.bytes : 0, fileId: up.fileId, usage: tr.usage || null };
  } finally {
    pulse.stop();
  }
}
