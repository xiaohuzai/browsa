// lib/sidepanel/attach-orchestrator.js — the 📎 attach pipelines, extracted
// from sidepanel.js (Phase 4 of the sidepanel modularization refactor). Covers:
//   - onAttachPage: the 📎 entry point (reader/dom/full modes, screenshot crop,
//     PDF text+figure extraction, video/audio ASR routing)
//   - runVideoAnalysisPipeline: 视听精读（panel-only）
//   - the shared audio transcription pipeline now lives in lib/asr-audio-pipeline.js
//     (same implementation is used by the offscreen runner)
//   - showAsrModeCard: the 转写 / 视听精读 choice card
//
// sidepanel.js owns the mutable UI state (currentTabId, ctxRadios, nextHistoryIdx)
// and the progress/append helpers; they are INJECTED via initAttachOrchestrator()
// rather than imported, so the dependency stays one-way (no module → sidepanel.js
// cycle, same rule as every other lib/sidepanel/* module).

import { t as _t, tSub } from '../i18n.js';
import { ICONS } from './icons.js';
import { sendMessage, showToast, buildModeButton } from './ui-utils.js';
import { extractPdfContent } from './pdf-extractor.js';
import { extractOfficeContent } from './office-extractor.js';
import { readPlatformCookie, registerMediaHeaders, removeMediaHeaders, MEDIA_RULE_IDS } from './media-headers.js';
import { DEFERRED_HANDOFFS } from '../attach-modes.js';
import { fetchArxivMeta, formatArxivMeta, arxivIdFromUrl } from '../arxiv.js';
import { getAsrJob, findAsrJob } from '../asr-job-store.js';
import { getAgentSessionContextId, getActiveSessionId } from '../storage.js';
import {
  downloadAudioBytes, asrAdapterFor, formatAsrTranscript,
  transcriptEndSec, largestTranscriptGapSec, TRANSCRIPT_GAP_LIMIT_SEC, formatStampSec,
  pickVideoStream, estimateStreamBytes, parseKeyframeMarkers, extractKeyframes,
  SAFETY_KEYFRAME_CAP, videoAssetId, lookupCachedArkFiles, saveArkFileCacheEntry,
  isQwenFiletransModel, ASR_SUBTITLE_SOURCE,
} from '../handlers/attach-asr.js';
import {
  runAudioTranscribePipeline as runAudioTranscribePipelineShared,
  downloadAndTranscodeAudioBest as downloadAndTranscodeAudioBestShared,
  audioUploadArtifact,
} from '../asr-audio-pipeline.js';

// Injected by sidepanel.js's init(). The parameter is destructured explicitly
// so the module's real interface is visible here instead of living only in the
// caller's init call (architecture-review candidate #8 — the ownership model
// stays the AGENTS.md-sanctioned initX(deps) injection; only its invisibility
// was the problem). `getTabId`/`getCtxRadios` are getters (the underlying
// values change over the panel's lifetime); `bumpHistoryIdx` mutates
// sidepanel's history-index counter, which this module must keep in sync.
let deps = {};
export function initAttachOrchestrator(d) {
  deps = {
    getTabId: d.getTabId,
    getCtxRadios: d.getCtxRadios,
    bumpHistoryIdx: d.bumpHistoryIdx,
    inputEl: d.inputEl,
    messagesEl: d.messagesEl,
    attachBtn: d.attachBtn,
    appendAttachSystem: d.appendAttachSystem,
    appendError: d.appendError,
    appendScreenshot: d.appendScreenshot,
    clearAttachProgress: d.clearAttachProgress,
    compactArkErrorText: d.compactArkErrorText,
    refreshAsrStreams: d.refreshAsrStreams,
    refreshTranscriptSource: d.refreshTranscriptSource,
    showAttachProgress: d.showAttachProgress,
    showScreenshotCropUI: d.showScreenshotCropUI,
  };
}

// The shared audio pipeline is context-agnostic; the side panel supplies the
// DOM progress sink and the panel's ASR_FRESH_URLS helper. The offscreen
// runner supplies its own env (job store + SW message), so the protocol and
// completeness guards stay single-source.
function sidepanelAsrEnv() {
  return {
    progress: (event) => deps.showAttachProgress(event?.text || ''),
    refreshStreams: (platform, want) => deps.refreshAsrStreams(platform, want),
  };
}

const ASR_JOB_POLL_MS = 1000;

function canUseBackgroundAsr() {
  try {
    return !!chrome?.runtime?.getManifest?.().permissions?.includes('offscreen');
  } catch (_) {
    return false;
  }
}

/**
 * The background job payload is split by lifetime:
 *   - `job` metadata survives in the job store (no API key / cookies / URLs);
 *   - `ctx` + `asr` carry the signed media URLs and key only in
 *     chrome.storage.session, cleared once the offscreen runner picks it up.
 */
async function buildAsrJobPayload({ ctx, platform, wantDurSec }) {
  const pageUrl = ctx.meta?.url || '';
  // Keep a stable job identity even for video URL forms videoAssetId() does
  // not recognize (e.g. Bilibili ?aid= pages); otherwise re-attach could not
  // find the running job and would start a duplicate.
  const assetId = videoAssetId(platform, pageUrl)
    || (pageUrl ? `url:${pageUrl}` : '');
  const asr = ctx.asr || {};
  return {
    jobId: crypto.randomUUID(),
    assetId,
    tabId: deps.getTabId(),
    pageUrl,
    platform,
    title: ctx.meta?.title || '',
    durationSec: Number(wantDurSec) || 0,
    originContextId: await getAgentSessionContextId().catch(() => ''),
    originSessionId: await getActiveSessionId().catch(() => ''),
    asr: {
      provider: asr.provider,
      apiKey: asr.apiKey,
      baseUrl: asr.baseUrl,
      model: asr.model,
      videoModel: asr.videoModel || '',
      language: asr.language,
      hotwords: asr.hotwords || '',
      format: asr.format,
      timeoutMs: asr.timeoutMs,
      subtitleSource: asr.subtitleSource,
    },
    ctx: {
      mode: 'asr-pending',
      asrPlatform: platform,
      meta: ctx.meta || {},
      audioUrl: ctx.audioUrl || '',
      audioLabel: ctx.audioLabel || '',
      audioCodec: ctx.audioCodec || '',
      audioId: ctx.audioId || 0,
      audioCandidates: Array.isArray(ctx.audioCandidates) ? ctx.audioCandidates : [],
      videoDurationSec: Number(wantDurSec) || 0,
      noTranscript: ctx.noTranscript !== false,
      asrExpiredError: ctx.asrExpiredError || '',
    },
  };
}

/**
 * True when a job still belongs to the conversation that started it. A
 * background result must never be silently attached to whatever conversation
 * the user switched TO; the job store keeps it for an explicit re-attach.
 */
async function stillInOriginConversation(originContextId) {
  if (!originContextId) return true;
  const now = await getAgentSessionContextId().catch(() => '');
  return !now || now === originContextId;
}

async function waitForAsrJob(jobId, originContextId = '') {
  let lastText = '';
  let resumeSent = false;
  for (;;) {
    const job = await getAsrJob(jobId).catch(() => null);
    if (!job) throw new Error('ASR job disappeared');
    // Auto-started jobs are gated to their origin conversation. An explicit
    // re-attach passes originContextId='' and may attach wherever the user
    // chose to re-attach.
    if (!(await stillInOriginConversation(originContextId))) {
      showToast(_t('asrJobReadyOtherSession', '转录仍在后台进行/已完成；回到原会话或重新附加即可使用'), 'info');
      return null;
    }
    if (job.status === 'done') {
      if (!job.resultText) throw new Error('ASR job completed without a transcript');
      return job;
    }
    if (job.status === 'failed') throw new Error(job.error || 'ASR job failed');
    if (job.status === 'canceled') throw new Error('ASR job canceled');
    if (job.status === 'paused' && !resumeSent) {
      resumeSent = true;
      const resumed = await sendMessage({ type: 'ASR_JOB_RESUME', jobId }).catch(() => null);
      if (!resumed?.data?.ok) {
        showToast(_t('asrJobPaused', '后台转录暂停，可重新附加继续'), 'info');
        return null;
      }
    } else if (job.status === 'paused') {
      // One explicit resume attempt was already made and the runner paused
      // again (a side-effectful step failed). Keep the handle in the store;
      // do not spin or silently re-upload/re-submit.
      showToast(_t('asrJobPaused', '后台转录暂停，可重新附加继续'), 'info');
      return null;
    }
    const text = job.progressText || _t('asrJobWaiting', '后台转录中…');
    if (text !== lastText) {
      lastText = text;
      deps.showAttachProgress(text);
    }
    await new Promise((resolve) => setTimeout(resolve, ASR_JOB_POLL_MS));
  }
}

async function startBackgroundAsrJob({ ctx, platform, wantDurSec }) {
  const job = await buildAsrJobPayload({ ctx, platform, wantDurSec });
  const res = await sendMessage({ type: 'ASR_JOB_START', job }).catch(() => null);
  if (!res?.data?.ok) {
    // The response can be lost (panel teardown / SW restart) after the
    // background has already saved and started the job. Never fall back to a
    // second in-panel pipeline when the store proves the job exists.
    const found = await getAsrJob(job.jobId).catch(() => null)
      || (job.assetId ? await findAsrJob({
        assetId: job.assetId,
        provider: job.asr.provider,
        baseUrl: job.asr.baseUrl,
        model: job.asr.model,
        language: job.asr.language,
        hotwords: job.asr.hotwords,
        durationSec: job.durationSec,
      }).catch(() => null) : null);
    if (!found) return { started: false };
    if (found.status === 'failed' && found.error !== 'offscreen-unavailable') {
      throw new Error(found.error || 'ASR job failed');
    }
    if (found.status === 'canceled') throw new Error('ASR job canceled');
    if (found.status === 'failed') return { started: false };
    const finished = await waitForAsrJob(found.jobId, job.originContextId);
    return { started: true, job: finished, resumed: true };
  }
  // Background returns the winning jobId (it may have found an existing job
  // for the same video+config), so never assume our freshly generated id won.
  const jobId = res.data.jobId || job.jobId;
  const finished = await waitForAsrJob(jobId, job.originContextId);
  return { started: true, job: finished, resumed: !!res.data.resumed };
}

function asrJobFailureToast(error, { platform, ctx, analysisMode }) {
  const msg403 = /403/.test(error?.message || '');
  const fallbackLabel = (platform === 'youtube' && msg403)
    ? (ctx.noTranscript === false
      ? _t('asrFallbackOriginal', '已回退使用自带字幕（YouTube 限制了音频下载）')
      : _t('asrFallbackVideoInfoYt', '已回退为视频信息（YouTube 限制了音频下载）'))
    : platform === 'xiaoyuzhou'
      ? _t('asrFallbackEpisodeInfo', '已回退为节目信息')
      : _t('asrFallbackVideoInfo', '已回退为视频信息');
  const authHint = /API key format is incorrect|AuthenticationError/i.test(error?.message || '')
    ? _t('asrAuthHint', '——ASR 配置里的 API Key 像是 Agent Plan 专属 key，与方舟平台 key 不通用，请到 设置 → 多模态视频理解 换成平台 API Key（UUID 或 ark- 前缀）') : '';
  showToast(`${analysisMode === 'video' ? _t('asrModeVideo', '视频解析') : _t('asrModeTranscribe', 'ASR 转写')}${_t('failColon', '失败：')}${deps.compactArkErrorText(error?.message || _t('unknownError', '未知错误'))}${authHint}（${fallbackLabel}）`, 'error');
}

/**
 * "still working" pulse for the two long ASR pipelines (video analysis, audio
 * transcription): refresh the progress line once a second with the current stage and
 * how long the user has waited. Both pipelines carried their own copy of the timer
 * and the same two-line body, so the locale key and the 1s cadence had to be kept in
 * step by hand. `set(label)` re-labels the stage; `stop()` clears the timer.
 */
function startStagePulse(initialLabel) {
  const startedAt = Date.now();
  let stageLabel = initialLabel;
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    deps.showAttachProgress(tSub('progressStageWait', '$1中…（已等待 $2s）', stageLabel, secs));
  }, 1000);
  return {
    set(label) { stageLabel = label; },
    stop() { clearInterval(timer); },
  };
}

/**
 * The deferred ATTACH_*_CONFIRM handoffs (screenshot / PDF / office / ASR) all end
 * the same way, and the envelope discipline is the part that must not drift:
 * success is the handler's INNER `{ ok }` — the outer envelope's ok is only the
 * bridge layer, and misreading it bumps nextHistoryIdx and renders a 📎 chip for
 * context the model never received (2026-10-15 ghost-chip report; the four
 * branches had each re-implemented the check, and the screenshot one had also
 * forgotten the failure exit).
 *
 * One exit: send → check the inner ok → on success advance the history index and
 * let the caller paint its chips → on failure surface the localized message.
 */
async function confirmStore({ type, payload, onStored, failLabel }) {
  const res = await sendMessage({ type, ...payload }).catch(() => null);
  if (!res?.data?.ok) {
    deps.appendError(failLabel);
    return null;
  }
  deps.bumpHistoryIdx();
  onStored(res.data);
  return res.data;
}

// Typed attach failures → [locale key, English source copy]. The `code` travels
// from background.js, which owns the English message (used in logs and by any
// non-UI consumer); the panel is where the UI language is known, so the
// translation belongs here. An unmapped code falls through to the raw message.
const ATTACH_ERROR_KEYS = {
  'page-navigated': ['pageNavigatedDuringRead', 'The page navigated while it was being read — attach it again'],
};

export async function runVideoAnalysisPipeline({ ctx, platform, videoPick, wantDurSec }) {
  const { asr } = ctx;
  // 适配器分派：上传/轮询/缓存策略随 provider 走（方舟有预处理轮询与文件存活探测；
  // 百炼 oss:// 无轮询、无探测 API、48h 有效、绑定上传时的模型）。
  const adapter = asrAdapterFor(asr.provider);
  // 精读调用的模型（videoModel 留空回退转写模型——doubao-seed / qwen-omni 系列本身
  // 就是多模态）。上传与缓存都按这个模型作用域：百炼 oss:// 文件绑定上传时的模型
  // （换模型不能复用），方舟 file_id 不绑（该值只是缓存键的一部分）。
  const callModel = (asr.videoModel || '').trim() || asr.model;
  let pick = videoPick;
  const needAudio = pick.kind !== 'muxed'; // durl 合一流自带音轨
  // 上传文件复用缓存：同一视频在有效期内再解析直接用上次的 file_id / oss:// key，免
  // 重传（视频模式仍要下载视频 blob 供截屏；音频命中时连下载+转码一起跳过）。
  const pageUrl = ctx.meta?.url || '';
  const assetId = videoAssetId(platform, pageUrl);
  const fnameBase = assetId ? `browsa-${assetId}` : '';
  const cached = await lookupCachedArkFiles({
    baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl,
    need: 'video', durationSec: wantDurSec,
    provider: asr.provider, model: callModel, aliveFn: adapter.alive,
  }).catch(() => null) || { videoFileId: '', audioFileId: '' };
  // 视频流 403 自愈：与音频同款思路，仅一次——重拉 playurl（want:'all'）后重新
  // 选流（视频/音频换新 URL），再失败就明示报错走回退。
  let videoBlob = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const dlStart = Date.now();
    const dlTimer = setInterval(() => {
      const secs = Math.round((Date.now() - dlStart) / 1000);
      deps.showAttachProgress(tSub('progressDownloadVideoWait', '下载视频中…（已等待 $1s）', secs));
    }, 1000);
    let vdl;
    try {
      vdl = await downloadAudioBytes({
        audioUrl: pick.stream.url,
        ...(platform === 'youtube' ? { headers: { Range: 'bytes=0-' } } : {}),
        onProgress: (done, total) => {
          if (total) {
            deps.showAttachProgress(tSub('progressDownloadVideoPct', '下载视频中…（$1%）', Math.round((done / total) * 100)));
          } else {
            const secs = Math.round((Date.now() - dlStart) / 1000);
            deps.showAttachProgress(tSub('progressDownloadVideoMbWait', '下载视频中…（已下载 $1MB，已等待 $2s）', (done / 1024 / 1024).toFixed(1), secs));
          }
        },
      });
    } finally {
      clearInterval(dlTimer);
    }
    if (vdl?.ok && vdl.blob && vdl.blob.size > 0) {
      videoBlob = vdl.blob;
      break;
    }
    const err = tSub('errVideoDownloadFailed', '视频下载失败: $1', vdl?.error || 'no blob');
    console.warn('[ASR]', err);
    if (attempt === 0 && /403/.test(err)) {
      const fresh = await deps.refreshAsrStreams(platform, 'all');
      if (fresh) {
        const newPick = pickVideoStream({
          videoCandidates: fresh.filter((s2) => s2.type === 'video'),
          muxedStream: fresh.find((s2) => s2.type === 'muxed') || null,
          durationSec: wantDurSec,
        });
        if (newPick) {
          pick = newPick;
          // 音频候选同步换新 URL（downloadAndTranscodeAudioBest 从 ctx 读候选）。
          const freshAudio = fresh.filter((s2) => s2.type === 'audio' && s2.url);
          if (freshAudio.length) {
            ctx.audioCandidates = freshAudio.map((s2) => ({ url: s2.url, label: s2.label || '', codecs: s2.codecs || '', id: s2.id || 0 }));
            ctx.audioUrl = ctx.audioCandidates[0].url;
            ctx.audioLabel = ctx.audioCandidates[0].label || '';
            ctx.audioCodec = ctx.audioCandidates[0].codecs || '';
            ctx.audioId = ctx.audioCandidates[0].id || 0;
          }
          continue;
        }
      }
    }
    throw new Error(err);
  }
  // 独立音频流：下载 + 转码 16kHz mono WAV（候选循环/截断校验/403 自愈与音频管线同款）。
  // 缓存命中的音频文件直接复用，整段下载/转码/上传全部跳过。
  let audio = null;
  if (needAudio && cached.audioFileId) {
    console.log('[ASR] reusing cached audio fileId', cached.audioFileId);
    deps.showAttachProgress(_t('progressReuseAudio', '复用上次上传的音频文件，跳过下载与上传…'));
  } else if (needAudio) {
    deps.showAttachProgress(_t('progressDownloadAudio', '下载音频中…'));
    audio = await downloadAndTranscodeAudioBestShared({ ctx, platform, wantDurSec, want: 'all', env: sidepanelAsrEnv() });
  }
  // 上传（XHR 进度）：视频可达几百 MB，先视频后音频，进度各自独立展示。
  const uploadWithProgress = async (blob, filename, label) => {
    deps.showAttachProgress(tSub('progressUploadStart', '上传$1中…（0%）', label));
    const upStart = Date.now();
    const up = await adapter.upload({
      blob, filename, apiKey: asr.apiKey, baseUrl: asr.baseUrl, model: callModel,
      onProgress: (done, total) => {
        if (total) {
          deps.showAttachProgress(tSub('progressUploadPct', '上传$1中…（$2%）', label, Math.round((done / total) * 100)));
        } else {
          const secs = Math.round((Date.now() - upStart) / 1000);
          deps.showAttachProgress(tSub('progressUploadMbWait', '上传$1中…（已上传 $2MB，已等待 $3s）', label, (done / 1024 / 1024).toFixed(1), secs));
        }
      },
    });
    if (!up?.ok || !up.fileId) {
      throw new Error(tSub('errUploadFailed', '$1上传失败: $2', label, up?.error || 'no fileId'));
    }
    // "upload meta" 仅方舟有回显（content_type/bytes/status，08-16 误判排查的诊断
    // 证据）；百炼 OSS 直传成功时响应体为空 → {}，字段缺省属预期。
    const elapsed = Math.round((Date.now() - upStart) / 1000);
    const speed = elapsed > 0 ? ((up.bytes / 1024 / 1024) / elapsed).toFixed(1) : '?';
    console.log(`[ASR] uploaded ${label} fileId`, up.fileId, '| sent', up.bytes, `| ${elapsed}s (${speed}MB/s)`, '| upload meta:', JSON.stringify({ upBytes: up.upBytes, upContentType: up.upContentType, upStatus: up.upStatus }));
    return up;
  };
  let vup;
  if (cached.videoFileId) {
    console.log('[ASR] reusing cached video fileId', cached.videoFileId);
    deps.showAttachProgress(_t('progressReuseVideo', '复用上次上传的视频文件，跳过上传…'));
    vup = { fileId: cached.videoFileId };
  } else {
    vup = await uploadWithProgress(videoBlob, fnameBase ? `${fnameBase}-video.mp4` : 'video.mp4', _t('mediaLabelVideo', '视频'));
  }
  let aup = null;
  if (needAudio) {
    if (cached.audioFileId) {
      aup = { fileId: cached.audioFileId };
    } else {
      const art = audioUploadArtifact(audio, fnameBase, adapter);
      aup = await uploadWithProgress(art.blob, art.name, _t('mediaLabelAudio', '音频'));
    }
  }
  // 轮询 + 精读：两阶段都可能以分钟计，interval 每秒刷新阶段/已等待秒数。
  const pulse = startStagePulse(_t('stageRecognizing', '识别处理'));
  try {
    // 百炼（poll: null）没有服务端预处理阶段：上传成功即可调用，跳过轮询。
    if (adapter.poll) {
      const pv = await adapter.poll(asr.baseUrl, asr.apiKey, vup.fileId, { timeoutMs: asr.timeoutMs });
      console.log('[ASR] video poll result:', JSON.stringify(pv));
      if (!pv.ready) {
        throw new Error(tSub('errVideoFileProcessing', '视频文件处理失败: $1', pv.error || ''));
      }
      if (aup) {
        const pa = await adapter.poll(asr.baseUrl, asr.apiKey, aup.fileId, { timeoutMs: asr.timeoutMs });
        console.log('[ASR] audio poll result:', JSON.stringify(pa));
        if (!pa.ready) {
          throw new Error(tSub('errAudioFileProcessing', '音频文件处理失败: $1', pa.error || ''));
        }
      }
    }
    // 上传+处理都成功 → 落缓存（只记本次新上传的 id，复用的 id 保持原 expireAt；
    // 之后精读即使失败，文件本身仍可用，下次免传）。ttlSec/作用域随适配器：
    // 方舟 file_id 30 天；百炼 oss:// 48h 且绑定模型。
    await saveArkFileCacheEntry({
      baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl, durationSec: wantDurSec,
      videoFileId: cached.videoFileId ? '' : vup.fileId,
      audioFileId: (needAudio && !cached.audioFileId && aup) ? aup.fileId : '',
      provider: asr.provider, model: callModel, ttlSec: adapter.fileCacheTtlSec,
    });
    pulse.set(_t('stageVideoAnalysis', '视听精读'));
    // 说话人命名先验：标题 + 页面元信息块（B站合成文本开头带 UP主/简介/嘉宾名单，
    // 硅谷101 实测简介里直接列出「采访嘉宾/主持人」）。截 500 字控 token。
    const metaHint = [ctx.articleTitle || ctx.meta?.title || '', (ctx.text || '').slice(0, 500)]
      .filter(Boolean).join(' ').slice(0, 600);
    const res = await adapter.analyzeVideo({
      baseUrl: asr.baseUrl,
      apiKey: asr.apiKey,
      videoFileId: vup.fileId,
      audioFileId: aup ? aup.fileId : null,
      // 说话人命名先验（身份证据：画面姓名条/自我介绍/简介名单）
      metaHint,
      // 精读模型 = callModel（上传与缓存同用它，见管线头部的说明）。
      model: callModel,
      language: asr.language,
      durationSec: wantDurSec,
      // 墙钟预算随视频时长缩放（与音频转写同式）：视频预处理 + 帧推理更慢，
      // 保留 10 分钟下限、45 分钟上限防无限挂起；流式内部另有 60s 空闲超时。
      // 空闲超时给到 180s：视频预处理（服务端抽帧）可能让首 token 静默远超 60s
      //（音频 ASR 无此问题——预处理在上传阶段就完成了）。
      signal: AbortSignal.timeout(Math.max(10 * 60_000, Math.min(45 * 60_000, Math.round((wantDurSec || 0) * 1000 / 2)))),
      idleTimeoutMs: 180_000,
    });
    if (res.truncated) {
      console.warn('[ASR] video analysis truncated:', res.finishReason);
      throw new Error(tSub('errAnalysisTruncated', '精读输出被模型上限截断（$1）', res.finishReason || 'max_output_tokens'));
    }
    console.log('[ASR] video analysis usage:', JSON.stringify(res.usage || {}));
    const fmt = formatAsrTranscript(res.text);
    // 完整度兜底（与字幕 ASR 同阈值）：最后时间戳必须覆盖到视频 90% 以上，
    // 绝不允许静默存半截精读。transcriptEndSec 自识裸秒数（[624.0]）并保留小数
    // 精度——不能先归一化再解析（mm:ss 截断小数会把 4.6s 边界误判成不完整）。
    const endSec = transcriptEndSec(res.text);
    if (wantDurSec > 0 && endSec != null && endSec < wantDurSec * 0.9) {
      console.warn('[ASR] video analysis incomplete: last stamp', endSec, 's < 90% of', wantDurSec, 's video');
      throw new Error(tSub('errAnalysisIncompleteEnd', '精读不完整（最后时间戳 $1s / 视频 $2s）', endSec == null ? '?' : endSec.toFixed(0), wantDurSec));
    }
    // 空洞守卫：last stamp 过线不等于覆盖完整——81 分钟视频真实故障：0-16 分钟
    // 密集覆盖后直接跳到 49:27 和片尾，中间约 1 小时整段缺失，90% 守卫无感。
    const gap = largestTranscriptGapSec(res.text);
    if (gap && gap.gapSec > TRANSCRIPT_GAP_LIMIT_SEC) {
      console.warn('[ASR] video analysis incomplete: gap', JSON.stringify(gap));
      throw new Error(tSub('errAnalysisIncompleteGap', '精读不完整（时间轴存在 $1 分钟空窗：$2 → $3）', Math.round(gap.gapSec / 60), formatStampSec(gap.fromSec), formatStampSec(gap.toSec)));
    }
    const docTextLines = fmt.lines;
    // 截屏标记解析（抽帧用）要在 [截屏]→[图N] 改写之前——解析器认 [截屏] 行。
    // max 只是防病态输出的安全阀（SAFETY_KEYFRAME_CAP）；只对幸存标记编号，越界
    // 标记整行丢弃——编号与真图必须一一对齐（2026-08-30 真实 bug：模型输出 37 个
    // 标记、抽帧只取 24，但改写把 37 个全编了号，图 25 起的锚点没有真图）。
    const keyframes = parseKeyframeMarkers(
      docTextLines.filter((l) => l.includes('[截屏]')).join('\n'),
      { max: SAFETY_KEYFRAME_CAP },
    );
    const survivingMarkerLines = new Set(keyframes.map((k) => k.line));
    // 标记行改写为 [图N] 锚点（带时间戳与 caption）：入库时 interleaveImageParts
    // 按锚点位置真交错插入图片部件，模型回答引用 [图N] 时渲染端还原为缩略图。
    let figIdx = 0;
    const docText = docTextLines
      .filter((l) => !l.includes('[截屏]') || survivingMarkerLines.has(l))
      .map((l) => (survivingMarkerLines.has(l) ? l.replace('[截屏]', `[图${++figIdx}]`) : l))
      .join('\n');
    if (!docText) {
      throw new Error(_t('errAnalysisEmpty', '精读输出为空'));
    }
    // 关键帧截图：从已下载的视频 blob 抽帧（同源 canvas，无跨源污染），走 PDF
    // 插图同款管线入库（image_url 部件随 history 每轮发给多模态 provider）。
    // 抽帧任何失败都 fail-open 返回 []，绝不阻塞精读产物。
    let figures = [];
    if (videoBlob && keyframes.length) {
      deps.showAttachProgress(_t('progressKeyframes', '截取关键帧…'));
      figures = await extractKeyframes(videoBlob, keyframes);
      console.log(`[ASR] keyframes: ${keyframes.length} markers -> ${figures.length} frames`);
    }
    return { transcriptText: docText, audioBytes: audio ? audio.bytes : 0, videoBytes: videoBlob.size, figures };
  } finally {
    pulse.stop();
  }
}

// 模式选择卡（视频解析可用时替代自动音频转写）：列出两种解析方式的预估下载体积，
// 用户点选后开始对应管线。返回 Promise<'audio'|'video'|'abort'>。卡片插入消息流
// 末尾（与 attach 系统消息同区域）；卡片被会话切换等重渲染清掉时 resolve('abort')，
// 静默取消本次解析（attach 按钮由 onAttachPage 的 finally 恢复）。
function showAsrModeCard({ ctx, videoPick, durationSec }) {
  return new Promise((resolve) => {
    // 体积估不出来（playurl 元数据缺失）时整个省略「下载…」子句——「体积未知」
    // 是用户无法行动的噪音，只在有真实数字时才展示（2026-09-05 用户反馈）。
    const fmtMB = (b) => (b > 0 ? tSub('fmtDownloadAboutMb', '下载约 $1MB', (b / 1024 / 1024).toFixed(0)) : '');
    const joinSub = (parts) => parts.filter(Boolean).join(' · ');
    // 音频预估用候选列表的第一项（buildAsrPendingCtx 按码率升序排，[0] 是实际
    // 先试的最低码率流——下载体积最小的那条）。
    const audioCand = Array.isArray(ctx.audioCandidates) ? ctx.audioCandidates[0] : null;
    const audioEst = estimateStreamBytes(audioCand || { url: ctx.audioUrl, bandwidth: 0, size: 0 }, durationSec);
    const card = document.createElement('div');
    card.className = 'msg system asr-mode-card';
    const title = document.createElement('div');
    title.className = 'asr-mode-title';
    title.textContent = _t('asrModeCardTitle', '该视频无字幕。选择解析方式：');
    card.appendChild(title);
    const row = document.createElement('div');
    row.className = 'asr-mode-row';
    const mkBtn = (mode, main, sub) => buildModeButton(card, main, sub, {
      className: 'asr-mode-btn' + (mode === 'video' ? ' asr-mode-video' : ''),
      onPick: () => resolve(mode),
    });
    row.appendChild(mkBtn('audio', _t('asrModeBtnAudio', '音频转写（字幕）'), joinSub([fmtMB(audioEst), _t('asrModeSubFast', '快'), _t('asrModeSubLowToken', 'token 消耗少')])));
    if (videoPick) {
      const vSub = joinSub([videoPick.stream.label || '', fmtMB(videoPick.estBytes), _t('asrModeSubSlow', '慢'), _t('asrModeSubHighToken', 'token 消耗高')]);
      row.appendChild(mkBtn('video', _t('asrModeBtnVideo', '视频精读（画面＋语音）'), vSub));
    }
    card.appendChild(row);
    // 卡片在用户点选前被移除（会话切换/newSession 重渲染消息流）→ 静默取消，
    // 防止 attach 流程永久挂起（按钮卡死类 bug 的预防）。
    const obs = new MutationObserver(() => {
      if (!card.isConnected) {
        obs.disconnect();
        resolve('abort');
      }
    });
    obs.observe(deps.messagesEl, { childList: true });
    deps.messagesEl.appendChild(card);
    deps.messagesEl.scrollTop = deps.messagesEl.scrollHeight;
  });
}

// Deferred-handoff dispatch: confirm-message type → the branch function that
// runs the sidepanel half of the pipeline. asr-pending stays a separate check
// above (its gating needs ctx.asr, not just payload-field presence).
const DEFERRED_RUNNERS = {
  ATTACH_SCREENSHOT_CONFIRM: (ctx, title) => attachScreenshotMode(ctx, title),
  ATTACH_PDF_CONFIRM: (ctx) => attachPdfPending(ctx),
  ATTACH_OFFICE_CONFIRM: (ctx) => attachOfficePending(ctx),
};

export async function onAttachPage() {
  if (!deps.getTabId()) return;
  const mode = [...deps.getCtxRadios()].find((r) => r.checked)?.value || 'reader';
  const origAttachIcon = deps.attachBtn.innerHTML;
  const origTitle = deps.attachBtn.title;
  deps.attachBtn.disabled = true;
  deps.attachBtn.innerHTML = ICONS.retry;
  deps.attachBtn.classList.add('is-attaching');
  deps.attachBtn.title = _t('readingPage', '正在读取页面…');
  deps.showAttachProgress(_t('progressReadingPage', '正在读取页面…'));

  try {
    const res = await sendMessage({ type: 'ATTACH_PAGE', tabId: deps.getTabId(), mode, query: deps.inputEl.value || '' });
    if (!res?.ok || !res.data?.ok) {
      const [key, en] = ATTACH_ERROR_KEYS[res?.data?.code] || [];
      deps.appendError(
        (key ? _t(key, en) : '')
        || res?.data?.error || res?.error || _t('readPageFailed', 'Failed to read page')
      );
      return;
    }
    const ctx = res.data?.ctx;
    const title = ctx?.articleTitle || ctx?.meta?.title || _t('pageFallback', '页面');

    // Deferred-storage mode branches — screenshot crop, pdf.js text, docling
    // office conversion, ASR pipelines. Each stores history via its
    // ATTACH_*_CONFIRM message (definitions below); a throw (e.g. the ASR
    // expired-playurl abort) still lands in this function's catch/finally.
    // The (mode, field, confirm) triples come from lib/attach-modes.js — the
    // same table background.js's ATTACH_PAGE early-returns read — so a new
    // deferred mode is one table row instead of two hand-synced if-chains.
    const handoff = DEFERRED_HANDOFFS.find((h) => (ctx?.mode === h.mode || mode === h.mode) && ctx?.[h.field]);
    if (handoff) {
      const runner = DEFERRED_RUNNERS[handoff.confirm];
      if (runner) { await runner(ctx, title); return; }
    }
    // A resumed job has no fresh media URL (the page may have been re-opened
    // after the signed playurl expired); `asrJob` is the resume handle.
    if (ctx?.mode === 'asr-pending' && (ctx?.audioUrl || ctx?.asrJob) && ctx?.asr) { await attachAsrPending(ctx); return; }

    deps.bumpHistoryIdx(); // page context stored in ATTACH_PAGE handler
    deps.refreshTranscriptSource(); // 视频页上下文带 videoSrc，抽屉按钮可能该亮出来
    const charCount = ctx?.truncated?.textLength ?? (ctx?.text?.length || 0);
    const charLabel = charCount > 0 ? tSub('chipChars', '，$1 字符', charCount.toLocaleString()) : _t('chipEmptyContent', '，内容为空');
    // For auto mode, show which sub-mode was actually used
    const modeLabel = mode === 'auto' ? `auto/${ctx?.autoMode || 'reader'}` : mode;
    // Video without subtitles + ASR not enabled: tell the user the
    // current behavior (plain video-info attach, no transcription) and how
    // to opt into automatic subtitle transcription. Mode-specific label so the
    // hint reads naturally for B站 vs YouTube.
    const noTranscriptHint = ctx.noTranscriptHint
      ? _t('noTranscriptHint', '⚠️ 该视频/音频无字幕：已保持现状（仅保存页面信息）。如需自动转写为字幕，请到 设置 → 多模态视频理解 启用后重新附加。')
      : undefined;
    deps.appendAttachSystem(tSub('chipAttached', '📎 已附加："$1"（$2）', title, modeLabel + charLabel), null, ctx?.text || '', undefined, noTranscriptHint, res?.data?.attachId);
  } catch (e) {
    deps.appendError(tSub('pageAttachFailed', 'Page attach failed: $1', e.message));
  } finally {
    deps.attachBtn.disabled = false;
    deps.attachBtn.innerHTML = origAttachIcon;
    deps.attachBtn.classList.remove('is-attaching');
    deps.attachBtn.title = origTitle;
    deps.clearAttachProgress();
  }
}

    // Screenshot mode: show crop UI before storing. User can select a region
    // or use the full image. Storing to history happens only on confirm.
async function attachScreenshotMode(ctx, title) {
  deps.showScreenshotCropUI({
    imageDataUrl: ctx.imageDataUrl,
    metaUrl: ctx.meta?.url || '',
    metaTitle: title,
  }, async (finalDataUrl) => {
    // Confirmed (full or cropped image) — await so nextHistoryIdx only
    // increments if the storage write actually succeeded (confirmStore's rule).
    // 只在存储确实成功时挂确认 chip + 预览：此前无条件 appendScreenshot +
    // appendAttachSystem，CONFIRM 失败（空 imageDataUrl / storeAttachment 抛
    // → 内层 ok:false）时会渲染一个幽灵「📎 已附加截图」——模型上下文里其实
    // 什么都没有，reload 后气泡消失，且 attachId undefined 让「撤销」也失效。
    // PDF/office/ASR 三个兄弟分支都有失败出口，唯独截图漏了；现在四条分支共用
    // confirmStore 的那一个。
    await confirmStore({
      type: 'ATTACH_SCREENSHOT_CONFIRM',
      payload: { imageDataUrl: finalDataUrl, metaUrl: ctx.meta?.url || '', metaTitle: title },
      failLabel: _t('screenshotAttachFailed', 'Screenshot attach failed'),
      onStored: (stored) => {
        const screenshotEl = deps.appendScreenshot(finalDataUrl);
        deps.appendAttachSystem(
          tSub('chipAttachedScreenshot', '📎 已附加截图："$1"', title),
          screenshotEl, undefined, undefined, undefined, stored.attachId,
        );
      },
    });
  });
  return; // crop UI takes over; nothing else to do here
}

// Release the losing deadline on both success and failure. Keeping it alive
// after extraction settles wastes a timer and holds Node's test process open.
async function withExtractionTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

    // PDF bytes ready: run pdf.js text extraction here (sidepanel has a real
    // `window` that pdf.js needs; background.js service worker does not).
    // Any failure falls back to the same URL placeholder text as before --
    // never a stuck/broken state. History storage happens via ATTACH_PDF_CONFIRM.
async function attachPdfPending(ctx) {
  deps.attachBtn.title = _t('progressParsingPdf', '解析 PDF 中…');
  deps.showAttachProgress(_t('progressParsingPdf', '解析 PDF 中…'));
  const attachT0 = performance.now();
  // arXiv enrichment runs alongside extraction: authors/categories/dates
  // for the context header. Best-effort + 6s timeout — never delays the
  // attach by more than that, and a miss just means no header block.
  const pdfUrl = ctx.meta?.url || '';
  const arxivMetaPromise = fetchArxivMeta(pdfUrl).catch(() => null);
  let pdfText, pdfNumPages, pdfOcrPages, pdfFigureImages = [], pdfExtra = {};
  try {
    // PDF behaves like a blog attach (2026-10-21 final decision): figures are
    // extracted and ride along as image parts, cited with [图N]. Wrong
    // auto-crops are a detection-quality problem to improve forward, not a
    // reason to drop the citation contract.
    const pdfResult = await withExtractionTimeout(
      extractPdfContent(ctx.pdfBase64, { extractFigures: true }),
      150_000, 'pdf extraction timeout'
    );
    pdfText = pdfResult.text;
    pdfNumPages = pdfResult.numPages;
    pdfOcrPages = pdfResult.pagesNeedingOcr;
    pdfFigureImages = Array.isArray(pdfResult.figureImages) ? pdfResult.figureImages : [];
    pdfExtra = {
      docTitle: pdfResult.docTitle || '',
      layout: pdfResult.layout || null,
      hasEncodingIssues: !!pdfResult.hasEncodingIssues,
      scanned: !!pdfResult.scanned
    };
  } catch (e) {
    console.warn('browsa: pdf extraction failed, using placeholder', e.message);
    pdfText = `[PDF file — agent should fetch and read directly]\nURL: ${ctx.meta?.url || ''}\nTitle: ${ctx.meta?.title || ''}`;
  }
  const arxivMeta = await arxivMetaPromise;
  const arxivHeader = arxivMeta ? formatArxivMeta(arxivMeta, arxivIdFromUrl(pdfUrl)?.version) : '';
  console.log(`browsa[pdf]: attach pipeline (extract+arxiv) took ${Math.round(performance.now() - attachT0)}ms`);
  // handler 在 text 为空时返回内层 { ok:false, error:'no text' }——外层
  // res.ok 只是桥接层标志，误当成功会虚增 nextHistoryIdx（索引错位）；这条
  // 信封纪律现在由 confirmStore 统一执行。
  await confirmStore({
    type: 'ATTACH_PDF_CONFIRM',
    payload: {
      text: pdfText,
      metaUrl: ctx.meta?.url || '',
      metaTitle: ctx.meta?.title || '',
      numPages: pdfNumPages,
      figureImages: pdfFigureImages,
      arxivHeader,
      paper: !!arxivMeta,
    },
    failLabel: _t('pdfAttachFailed', 'PDF attach failed'),
    onStored: (stored) => {
      const title = ctx.meta?.title || 'PDF';
      const charLabel = pdfText?.length > 0 ? tSub('chipChars', '，$1 字符', pdfText.length.toLocaleString()) : '';
      const pagesLabel = pdfNumPages ? tSub('chipPdfPages', '，$1 页', pdfNumPages) : '';
      const ocrLabel = pdfOcrPages?.length > 0 ? tSub('chipPdfOcrPages', '，$1 页可能需要 OCR', pdfOcrPages.length) : '';
      const figLabel = pdfFigureImages.length > 0 ? tSub('chipPdfFigures', '，$1 figure$2', pdfFigureImages.length, pdfFigureImages.length > 1 ? 's' : '') : '';
      const encLabel = pdfExtra.hasEncodingIssues ? _t('chipPdfEncoding', '，文本可能存在编码问题') : '';
      const scanLabel = pdfExtra.scanned ? _t('chipPdfScanned', '，扫描件已附页图') : '';
      const tblLabel = pdfExtra.layout?.pagesWithTables?.length ? tSub('chipPdfTables', '，$1 页含表格', pdfExtra.layout.pagesWithTables.length) : '';
      // Visible confirmation that the arXiv metadata fetch landed — the
      // inspect dialog only shows the pre-header body text.
      const arxivLabel = arxivMeta ? `，arXiv:${arxivIdFromUrl(pdfUrl)?.id || '✓'}` : '';
      // background 回传 contextText = 模型实际收到的完整上下文（头部含
      // arXiv 元数据块 + 正文含 ## Figures 段）；回退旧响应时降级用 pdfText。
      const inspectCtx = stored.contextText || pdfText;
      deps.appendAttachSystem(
        tSub('chipAttachedPdf', '📎 已附加 PDF："$1"（pdf-text$2）', title, `${arxivLabel}${pagesLabel}${charLabel}${ocrLabel}${figLabel}${encLabel}${scanLabel}${tblLabel}`),
        null, inspectCtx, pdfFigureImages, undefined, stored.attachId
      );
    },
  });
}

    // Office-document bytes ready (docx/pptx/xlsx/odt/rtf/epub/…): run the
    // docling.rs-wasm conversion here in the sidepanel (fully local, in a
    // Worker — see office-extractor.js). Any failure/timeout falls back to
    // the same URL placeholder shape as the PDF path — never a stuck state.
    // History storage happens via ATTACH_OFFICE_CONFIRM. The docling Worker
    // starts lazily on this first attach (13.4MB wasm — deliberately NOT
    // pre-warmed at panel init; see office-extractor.js).
async function attachOfficePending(ctx) {
  deps.attachBtn.title = _t('progressParsingDoc', 'Parsing document…');
  deps.showAttachProgress(_t('progressParsingDoc', 'Parsing document…'));
  let officeText = '';
  let officeExt = '';
  try {
    const officeResult = await withExtractionTimeout(
      extractOfficeContent(ctx.officeBase64, ctx.filename || 'document'),
      90_000, 'office conversion timeout'
    );
    officeText = officeResult.text;
    officeExt = officeResult.ext;
  } catch (e) {
    console.warn('browsa: office conversion failed, using placeholder', e.message);
    officeText = `[Document — agent should fetch and read directly]\nURL: ${ctx.meta?.url || ''}\nTitle: ${ctx.meta?.title || ''}`;
  }
  // Same envelope discipline as the PDF branch (success is the INNER ok; the
  // case returns {ok:false} when text is empty) — enforced by confirmStore.
  await confirmStore({
    type: 'ATTACH_OFFICE_CONFIRM',
    payload: {
      text: officeText,
      metaUrl: ctx.meta?.url || '',
      metaTitle: ctx.meta?.title || '',
      ext: officeExt,
    },
    failLabel: _t('officeAttachFailed', 'Document attach failed'),
    onStored: (stored) => {
        const oTitle = ctx.meta?.title || ctx.filename || 'Document';
        const isPlaceholder = officeText.startsWith('[Document');
        const charLabel = isPlaceholder ? '' : tSub('chipChars', '，$1 字符', officeText.length.toLocaleString());
        const fmtLabel = officeExt ? `${officeExt}-text` : 'office-text';
        deps.appendAttachSystem(
          tSub('chipAttachedDoc', '📎 已附加文档："$1"（$2）', oTitle, fmtLabel + charLabel),
          null, stored.contextText || officeText, undefined, undefined, stored.attachId
        );
    },
  });
}

    // Bilibili no-subtitle video + ASR enabled: run the ASR pipeline here.
    // The download+transcode+upload run in this extension context (sidepanel),
    // NOT page-world — the 火山方舟 Files API upload is a cross-origin request
    // that page-world JS cannot make (Ark sends no CORS headers; only an
    // extension context with host_permissions is exempt — a real failure mode
    // found in the field: the original MAIN-world-injected downloadAndUpload
    // returned "Failed to fetch" on the upload). B站 m4s download also works
    // here (host_permissions exempt it from CORS), and a session DNR rule
    // injects the bilibili.com Referer the CDN checks (the registerMediaHeaders
    // rule below) — set right before the fetch, removed right after. The
    // m4s is an MP4 container 方舟 misclassifies as video (file status failed:
    // Invalid video_url), so the bytes are transcoded to 16kHz mono WAV via Web
    // Audio API (Chrome decodes fMP4 natively) before upload — verified
    // end-to-end 2026-08-16. The bytes never cross extension messaging (a
    // ~44MB audio would base64 to ~59MB, hitting the 64MB limit). Poll +
    // transcribe then run here (sidepanel has a window, unlike the SW). Any
    // failure falls back to storing the plain bilibili text (existing behavior).
// The ASR / 视听精读 dispatch with its DNR header rule: register the
// platform's Referer/Origin/Cookie rule, run the chosen pipeline, report a
// failure as a toast (never silently), and always remove the rule. Extracted
// from attachAsrPending (2026-10-17) — it returns the pipeline's output and
// keeps the ctx/text assembly in the caller.
async function runAsrPipelineWithDnr({ ctx, platform, platformLabel, analysisMode, videoPick, wantDurSec }) {
  const out = { transcriptText: '', audioBytes: 0, videoBytes: 0, figures: [] };
  // Deterministic per-platform rule id (see media-headers.js) — a random id
  // could only be cleaned by this call's own finally, so a torn-down panel
  // left a cookie-injecting rule alive for the rest of the browser session.
  // null = this platform registers no rule; the finally must NOT remove the
  // Bilibili id in that case (a finishing xiaoyuzhou attach used to strip an
  // in-flight Bilibili attach's rule).
  const dnrRuleId = platform === 'youtube' ? MEDIA_RULE_IDS.youtube
    : platform === 'bilibili' ? MEDIA_RULE_IDS.bilibili
      : null;
  try {
    // Register the session DNR rule injecting the platform CDN's required
    // headers (Referer/Origin/Cookie) onto the media downloads — shared by the
    // audio and video pipelines (the helper holds the per-header history).
    // 小宇宙的 OSS 直链公开可读、不校验 Referer/Cookie——不注册规则（注册了
    // urlFilter 也匹配不上，但跳过更省一次 chrome.cookies 全量读取）。
    const needsDnr = dnrRuleId !== null;
    if (needsDnr) {
      await registerMediaHeaders(dnrRuleId, platform, ctx.biliCookie || await readPlatformCookie(platform));
    }
    if (analysisMode === 'video') {
      // —— 视频精读管线（v1，当前暂时只支持 B 站；durl 合一流走单文件，否则视频＋音频双文件）——
      const r = await runVideoAnalysisPipeline({ ctx, platform, videoPick, wantDurSec });
      out.transcriptText = r.transcriptText;
      out.audioBytes = r.audioBytes;
      out.videoBytes = r.videoBytes;
      out.figures = r.figures || [];
    } else {
      // —— 音频转写管线（原行为：下载最佳音频流 → WAV → 上传 → 轮询 → 转写）——
      const r = await runAudioTranscribePipelineShared({ ctx, platform, wantDurSec, env: sidepanelAsrEnv() });
      out.transcriptText = r.transcriptText;
      out.audioBytes = r.audioBytes;
    }
  } catch (e) {
    console.warn(`[ASR] pipeline failed, falling back to plain ${platformLabel} text:`, e?.message);
    console.warn('[ASR] stack:', e?.stack);
    // 明确告知失败（而不是静默 fallback）——长等待后用户需要知道是失败而非卡死。
    // YouTube 特判：googlevideo 的 PO token 反爬让扩展上下文无法下载音频（403）——
    // 这不是配置/网络问题，是 YouTube 侧限制（cat-catch 也一样下不了）。有自带字幕
    // 的 YouTube 视频会回退用自带字幕（其实足够），只有无字幕的才真是视频信息。
    const msg403 = /403/.test(e?.message || '');
    const fallbackLabel = (platform === 'youtube' && msg403)
      ? (ctx.noTranscript === false
        ? _t('asrFallbackOriginal', '已回退使用自带字幕（YouTube 限制了音频下载）')
        : _t('asrFallbackVideoInfoYt', '已回退为视频信息（YouTube 限制了音频下载）'))
      : platform === 'xiaoyuzhou'
        ? _t('asrFallbackEpisodeInfo', '已回退为节目信息')
        : _t('asrFallbackVideoInfo', '已回退为视频信息');
    // 401 + "API key format is incorrect" = key 类型不对（不是密码错）：Agent
    // Plan 专属 key 与标准方舟平台 key 官方明确不通用，而 ASR/视频解析走标准
    // 端点的 Files API。给出可操作的提示，别让用户去猜。
    const authHint = /API key format is incorrect|AuthenticationError/i.test(e?.message || '')
      ? _t('asrAuthHint', '——ASR 配置里的 API Key 像是 Agent Plan 专属 key，与方舟平台 key 不通用，请到 设置 → 多模态视频理解 换成平台 API Key（UUID 或 ark- 前缀）') : '';
    showToast(`${analysisMode === 'video' ? _t('asrModeVideo', '视频解析') : _t('asrModeTranscribe', 'ASR 转写')}${_t('failColon', '失败：')}${deps.compactArkErrorText(e?.message || _t('unknownError', '未知错误'))}${authHint}（${fallbackLabel}）`, 'error');
  } finally {
    // Remove the Referer-injection rule now that the download is done.
    // (A download that never started, a throw, or a success all land here.)
    // Only remove a rule this call actually registered — see dnrRuleId above.
    if (dnrRuleId !== null) await removeMediaHeaders(dnrRuleId);
  }
  return out;
}

async function attachAsrPending(ctx) {
  const { asr } = ctx;
  // 播放地址全部过期且自动刷新失败（deadline 签名的 m4s URL，过期后 CDN 一律
  // 403，referer/cookie 再对也没用）——再试也是白等三轮 403，直接明示原因并
  // 走回退（用户刷新视频页后重新 attach 即可，刷新 = 重新拉 playurl = 新签名）。
  // 平台显示名（错误/toast/确认标签共用）——必须在 asrExpiredError 的
  // throw 之前声明，否则那条错误自己先炸成 ReferenceError（TDZ）。
  const platform = ctx.asrPlatform || 'bilibili';
  const platformLabel = platform === 'youtube' ? 'YouTube'
    : platform === 'xiaoyuzhou' ? _t('platformXiaoyuzhou', '小宇宙')
    : _t('platformBilibili', 'B站');
  if (ctx.asrExpiredError) {
    console.warn('[ASR] expired playurl, auto-refresh failed:', ctx.asrExpiredError);
    throw new Error(tSub('errPlayurlExpired', '$1播放地址已过期且自动刷新失败（$2）——请刷新视频页面后重新附加', platformLabel, ctx.asrExpiredError));
  }
  const wantDurSec = (ctx.videoDurationSec && ctx.videoDurationSec > 0) ? ctx.videoDurationSec : 0;
  // 视频解析模式（v1，当前暂时只支持 B 站）：有 video/muxed 流候选时弹模式选择卡，由用户在
  // 「音频转写（字幕）」与「视频精读（画面＋语音）」之间选；没有候选（YouTube
  // 的流捕获是 audio-only）维持旧行为直接跑音频。pickVideoStream 已在方舟
  // 512MB 上传预算内选好流（全部超预算 → null → 不出卡），预估体积在卡上展示。
  let analysisMode = 'audio';
  let transcriptText = '';
  let audioBytes = 0;
  let videoBytes = 0;
  let figures = [];
  let fromExistingJob = false;

  if (ctx.asrJob) {
    // Re-attach after a close/reopen: the offscreen runner owns the job. We
    // only re-subscribe to its progress/result — never start a second job,
    // re-download, or re-upload.
    fromExistingJob = ctx.asrJob.status === 'done';
    deps.attachBtn.title = _t('btnTitleTranscribing', '转写音频中…');
    deps.showAttachProgress(ctx.asrJob.progressText || _t('asrJobWaiting', '后台转录中…'));
    let job = null;
    try {
      job = await waitForAsrJob(ctx.asrJob.jobId, '');
    } catch (e) {
      asrJobFailureToast(e, { platform, ctx, analysisMode: 'audio' });
    }
    if (!job) return;
    transcriptText = job.resultText;
    audioBytes = job.audioBytes || 0;
  } else {
    const videoPick = pickVideoStream({
      videoCandidates: ctx.videoCandidates,
      muxedStream: ctx.muxedStream,
      durationSec: wantDurSec,
    });
    // 精读模型（videoModel 留空回退转写模型）若是录音转写系（filetrans/fun-asr/
    // paraformer——纯音频、无画面理解）→ 不出视频选项，直接走音频转写；否则用户
    // 选了视频才在精读调用上撞错。
    const analysisModel = ((ctx.asr?.videoModel || '').trim() || ctx.asr?.model || '');
    const effectiveVideoPick = isQwenFiletransModel(analysisModel) ? null : videoPick;
    if (effectiveVideoPick) {
      deps.attachBtn.title = _t('btnTitlePickMode', '选择解析方式…');
      analysisMode = await showAsrModeCard({ ctx, videoPick: effectiveVideoPick, durationSec: wantDurSec });
      if (analysisMode === 'abort') return; // 卡片被会话切换等清掉 → 静默取消（finally 恢复按钮）
    } else {
      if (videoPick && videoPick !== effectiveVideoPick) {
        console.warn('[ASR] video analysis unavailable: transcription model is filetrans-family (audio-only). Set 视频模型 ID to an Omni model (e.g. qwen3.8-omni-flash) to enable 视频精读.');
      }
      deps.attachBtn.title = _t('btnTitleTranscribing', '转写音频中…');
      deps.showAttachProgress(_t('progressDownloadTranscribe', '下载并转写音频中…'));
    }

    if (analysisMode === 'video') {
      // 视频精读 remains panel-only for now: it needs the downloaded video
      // blob for keyframe extraction and has no resumable provider task.
      const pipeline = await runAsrPipelineWithDnr({
        ctx, platform, platformLabel, analysisMode, videoPick, wantDurSec,
      });
      transcriptText = pipeline.transcriptText;
      audioBytes = pipeline.audioBytes;
      videoBytes = pipeline.videoBytes;
      figures = pipeline.figures;
    } else {
      let started = null;
      let jobFailure = null;
      if (canUseBackgroundAsr()) {
        try {
          started = await startBackgroundAsrJob({ ctx, platform, wantDurSec });
        } catch (e) {
          jobFailure = e;
        }
      }
      if (jobFailure) {
        // The job already created a remote upload/task (or may have); do not
        // immediately re-run the side-effectful pipeline. Fall back to the
        // page info and let the user re-attach to retry deliberately.
        asrJobFailureToast(jobFailure, { platform, ctx, analysisMode });
      } else if (started?.started) {
        if (!started.job) return; // origin conversation changed; keep the result in the job store
        fromExistingJob = !!started.resumed;
        transcriptText = started.job.resultText;
        audioBytes = started.job.audioBytes || 0;
      } else {
        if (canUseBackgroundAsr()) {
          showToast(_t('asrBackgroundUnavailable', '后台任务启动失败，改为面板内转写（关闭侧栏会中断）'), 'info');
        }
        // Fallback for tests/older Chromium: the shared pipeline in the
        // side-panel context. This path still aborts if the panel closes.
        const pipeline = await runAsrPipelineWithDnr({
          ctx, platform, platformLabel, analysisMode, videoPick, wantDurSec,
        });
        transcriptText = pipeline.transcriptText;
        audioBytes = pipeline.audioBytes;
        videoBytes = pipeline.videoBytes;
        figures = pipeline.figures;
      }
    }
  }
  // Store the transcript (or fall back to the plain bilibili text).
  // ASR 字幕作为【增量】追加在视频元信息之后（像有字幕的视频 attach 一样保留
  // UP主/标题/播放量等元信息），而不是用字幕整体替换 ctx.text。
  // 例外：当用户选了「优先 ASR 解析字幕」（asr.subtitleSource === 'asr'）且该视频
  // 原本就有字幕（ctx.noTranscript === false）时，ASR 字幕应【替换】低质量的
  // 原字幕 —— 从 ctx.text 里剥掉原来的 `## 字幕` 块再追加 `## 字幕（ASR）`，
  // 避免同一份内容两份字幕同时喂给模型。仅在 ASR 成功时执行剥除（ctx.text
  // 本身保持原样），失败回退时原字幕原样保留。
  let confirmText = ctx.text || '';
  if (transcriptText) {
    // 两种产物的段落标题不同：字幕（音频转写）/ 视听精读（视频解析）。
    const sectionHeader = analysisMode === 'video' ? '## 视听精读（视频解析）' : '## 字幕（ASR）';
    if (analysisMode === 'video') {
      // 视频精读的触发条件包含「有原字幕但设置了优先 ASR」（subtitleSource=asr）
      // ——此时 ctx.text 带着 B站 AI 字幕的 ## 字幕 块，而精读把语音重新转写了
      // 一遍，不剥掉的话两份语音内容全量进上下文（2026-08-29 用户实测重复）。
      // 精读是字幕的升级替代品（语音＋画面），原字幕块一律剥掉。
      confirmText = (ctx.text || '')
        .replace(/\n\n## 字幕\n\n[\s\S]*$/, '')
        .replace(/\s+$/, '') + '\n\n' + sectionHeader + '\n\n' + transcriptText;
    } else {
      const preferAsr = ctx.asr?.subtitleSource === ASR_SUBTITLE_SOURCE.ASR;
      const hadOriginalTranscript = ctx.noTranscript === false;
      const baseText = (hadOriginalTranscript && preferAsr)
        ? (ctx.text || '').replace(/\n\n## 字幕\n\n[\s\S]*$/, '').replace(/\s+$/, '')
        : (ctx.text || '');
      confirmText = baseText + '\n\n' + sectionHeader + '\n\n' + transcriptText;
    }
  }
  await confirmStore({
    type: 'ATTACH_ASR_CONFIRM',
    payload: {
      text: confirmText,
      metaUrl: ctx.meta?.url || '',
      metaTitle: ctx.meta?.title || '',
      platform,
      tabId: deps.getTabId(),
      // 视频精读的 format 标签区分产物（ATTACH_ASR_CONFIRM 缺省仍是 -asr）。
      ...(analysisMode === 'video' ? { format: platform + '-video' } : {}),
      // 关键帧截图（视频精读）：{url, caption} 列表，镜像 PDF 的 figureImages。
      ...(analysisMode === 'video' && figures.length ? { figureImages: figures } : {}),
    },
    failLabel: _t('asrAttachFailed', 'ASR attach failed'),
    onStored: (stored) => {
      deps.refreshTranscriptSource(); // 字幕进历史了，抽屉按钮可能该亮出来
      const title = ctx.meta?.title || tSub('chipVideoTitleFallback', '$1视频', platformLabel);
      const lineCount = transcriptText ? transcriptText.split('\n').length : 0;
      const isVideoMode = analysisMode === 'video';
      const kindLabel = isVideoMode ? _t('kindAnalysis', '视听精读') : _t('kindCaptions', '字幕');
      const bytesLabel = [
        videoBytes > 0 ? tSub('chipMbVideo', '，$1MB 视频', (videoBytes / 1024 / 1024).toFixed(1)) : '',
        audioBytes > 0 ? tSub('chipMbAudio', '，$1MB 音频', (audioBytes / 1024 / 1024).toFixed(1)) : '',
      ].join('');
      // 解析失败时的回退标签要区分：有原字幕的视频保留原字幕，无字幕的视频才是纯视频信息。
      const subLabel = transcriptText
        ? (isVideoMode ? tSub('chipLinesAnalysis', '，$1 行精读', lineCount) : tSub('chipLinesCaptions', '，$1 行字幕', lineCount))
          + (figures.length ? tSub('chipFigures', '，$1 张截图', figures.length) : '')
        : (ctx.noTranscript === false
          ? _t('chipParseFailedKeptOriginal', '（解析失败，已保留原字幕）')
          : platform === 'xiaoyuzhou'
            ? _t('chipNoCaptionsEpisodeInfo', '（转写失败，已用节目信息代替）')
            : _t('chipNoCaptionsVideoInfo', '（无字幕，已用视频信息代替）'));
      // 平台+种类合成一个参数（仅当两侧都是拉丁字符才插空格：B站+字幕→"B站字幕"、
      // YouTube+字幕→"YouTube字幕"、Bilibili+captions→"Bilibili captions"）——
      // 消息模板里不能出现相邻的数字占位符（Chrome 清单校验器会把紧邻的
      // 数字占位符对当成未声明占位符而拒载整个扩展）。
      const platformKind = /[A-Za-z0-9]$/.test(platformLabel) && /^[A-Za-z0-9]/.test(kindLabel)
        ? `${platformLabel} ${kindLabel}`
        : `${platformLabel}${kindLabel}`;
      const reuseLabel = fromExistingJob && transcriptText
        ? _t('asrJobReused', '，复用上次转录结果')
        : '';
      const asrTail = (isVideoMode ? _t('asrModeVideo', '视频解析') : 'ASR') + bytesLabel + subLabel + reuseLabel;
      deps.appendAttachSystem(tSub('chipAttachedAsr', '📎 已附加 $1："$2"（$3）', platformKind, title, asrTail), null, confirmText, figures, undefined, stored.attachId);
    },
  });
}

// onAttachPage dispatches to the four branch functions above inside its
// try block; the shared finally restores the attach button state.
