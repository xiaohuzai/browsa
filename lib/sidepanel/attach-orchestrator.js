// lib/sidepanel/attach-orchestrator.js — the 📎 attach pipelines, extracted
// from sidepanel.js (Phase 4 of the sidepanel modularization refactor). Covers:
//   - onAttachPage: the 📎 entry point (reader/dom/full modes, screenshot crop,
//     PDF text+figure extraction, video/audio ASR routing)
//   - runVideoAnalysisPipeline / runAudioTranscribePipeline: 视听精读 / 字幕转写
//   - downloadAndTranscodeAudioBest: stream download + transcode + Ark upload
//   - showAsrModeCard: the 转写 / 视听精读 choice card
//
// sidepanel.js owns the mutable UI state (currentTabId, ctxRadios, nextHistoryIdx)
// and the progress/append helpers; they are INJECTED via initAttachOrchestrator()
// rather than imported, so the dependency stays one-way (no module → sidepanel.js
// cycle, same rule as every other lib/sidepanel/* module).

import { t as _t, tSub } from '../i18n.js';
import { ICONS } from './icons.js';
import { sendMessage, showToast } from './ui-utils.js';
import { extractPdfContent } from './pdf-extractor.js';
import { readPlatformCookie, registerMediaHeaders } from './media-headers.js';
import { fetchArxivMeta, formatArxivMeta, arxivIdFromUrl } from '../arxiv.js';
import {
  downloadAudioBytes, transcodeAudioBlob, uploadBlobToArk, pollFileStatus, asrAdapterFor, formatAsrTranscript,
  transcriptEndSec, largestTranscriptGapSec, TRANSCRIPT_GAP_LIMIT_SEC, formatStampSec,
  pickVideoStream, estimateStreamBytes, parseKeyframeMarkers, extractKeyframes,
  SAFETY_KEYFRAME_CAP, videoAssetId, lookupCachedArkFiles, saveArkFileCacheEntry,
  ASR_SUBTITLE_SOURCE,
} from '../handlers/attach-asr.js';

// Injected by sidepanel.js's init(). `getTabId`/`getCtxRadios` are getters (the
// underlying values change over the panel's lifetime); `bumpHistoryIdx` mutates
// sidepanel's history-index counter, which this module must keep in sync.
let deps = {};
export function initAttachOrchestrator(d) { deps = d; }

export async function runVideoAnalysisPipeline({ ctx, platform, videoPick, wantDurSec }) {
  const { asr } = ctx;
  let pick = videoPick;
  const needAudio = pick.kind !== 'muxed'; // durl 合一流自带音轨
  // Ark Files 复用缓存：同一视频 30 天内再解析直接用上次的 file_id，免重传
  // （视频模式仍要下载视频 blob 供截屏；音频命中时连下载+转码一起跳过）。
  const pageUrl = ctx.meta?.url || '';
  const assetId = videoAssetId(platform, pageUrl);
  const fnameBase = assetId ? `browsa-${assetId}` : '';
  const cached = await lookupCachedArkFiles({
    baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl,
    need: 'video', durationSec: wantDurSec,
  }).catch(() => null) || { videoFileId: '', audioFileId: '' };
  // 视频流 403 自愈：与音频同款思路，仅一次——重拉 playurl（want:'all'）后重新
  // 选流（视频/音频换新 URL），再失败就明示报错走回退。
  let videoBlob = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const dlStart = Date.now();
    const dlTimer = setInterval(() => {
      const secs = Math.round((Date.now() - dlStart) / 1000);
      deps.showAttachProgress(`下载视频中…（已等待 ${secs}s）`);
    }, 1000);
    let vdl;
    try {
      vdl = await downloadAudioBytes({
        audioUrl: pick.stream.url,
        ...(platform === 'youtube' ? { headers: { Range: 'bytes=0-' } } : {}),
        onProgress: (done, total) => {
          if (total) {
            deps.showAttachProgress(`下载视频中…（${Math.round((done / total) * 100)}%）`);
          } else {
            const secs = Math.round((Date.now() - dlStart) / 1000);
            deps.showAttachProgress(`下载视频中…（已下载 ${(done / 1024 / 1024).toFixed(1)}MB，已等待 ${secs}s）`);
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
    const err = '视频下载失败: ' + (vdl?.error || 'no blob');
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
    deps.showAttachProgress(_t('progressReuseAudio', '复用上次上传的音频文件（30 天内有效），跳过下载与上传…'));
  } else if (needAudio) {
    deps.showAttachProgress(_t('progressDownloadAudio', '下载音频中…'));
    audio = await downloadAndTranscodeAudioBest({ ctx, platform, wantDurSec, want: 'all' });
  }
  // 上传（XHR 进度）：视频可达几百 MB，先视频后音频，进度各自独立展示。
  const uploadWithProgress = async (blob, filename, label) => {
    deps.showAttachProgress(`上传${label}中…（0%）`);
    const upStart = Date.now();
    const up = await uploadBlobToArk({
      blob, filename, apiKey: asr.apiKey, baseUrl: asr.baseUrl,
      onProgress: (done, total) => {
        if (total) {
          deps.showAttachProgress(`上传${label}中…（${Math.round((done / total) * 100)}%）`);
        } else {
          const secs = Math.round((Date.now() - upStart) / 1000);
          deps.showAttachProgress(`上传${label}中…（已上传 ${(done / 1024 / 1024).toFixed(1)}MB，已等待 ${secs}s）`);
        }
      },
    });
    if (!up?.ok || !up.fileId) {
      throw new Error(`${label}上传失败: ` + (up?.error || 'no fileId'));
    }
    console.log(`[ASR] uploaded ${label} fileId`, up.fileId, '| sent', up.bytes, '| Ark meta:', JSON.stringify({ upBytes: up.upBytes, upContentType: up.upContentType, upStatus: up.upStatus }));
    return up;
  };
  let vup;
  if (cached.videoFileId) {
    console.log('[ASR] reusing cached video fileId', cached.videoFileId);
    deps.showAttachProgress(_t('progressReuseVideo', '复用上次上传的视频文件（30 天内有效），跳过上传…'));
    vup = { fileId: cached.videoFileId };
  } else {
    vup = await uploadWithProgress(videoBlob, fnameBase ? `${fnameBase}-video.mp4` : 'video.mp4', '视频');
  }
  let aup = null;
  if (needAudio) {
    aup = cached.audioFileId
      ? { fileId: cached.audioFileId }
      : await uploadWithProgress(audio.wavBlob, fnameBase ? `${fnameBase}-audio.wav` : 'audio.wav', '音频');
  }
  // 轮询 + 精读：两阶段都可能以分钟计，interval 每秒刷新阶段/已等待秒数。
  const waitStart = Date.now();
  let stageLabel = '识别处理';
  const waitTimer = setInterval(() => {
    const secs = Math.round((Date.now() - waitStart) / 1000);
    deps.showAttachProgress(`${stageLabel}中…（已等待 ${secs}s）`);
  }, 1000);
  try {
    const pv = await pollFileStatus(asr.baseUrl, asr.apiKey, vup.fileId, { timeoutMs: asr.timeoutMs });
    console.log('[ASR] video poll result:', JSON.stringify(pv));
    if (!pv.ready) {
      throw new Error('视频文件处理失败: ' + (pv.error || ''));
    }
    if (aup) {
      const pa = await pollFileStatus(asr.baseUrl, asr.apiKey, aup.fileId, { timeoutMs: asr.timeoutMs });
      console.log('[ASR] audio poll result:', JSON.stringify(pa));
      if (!pa.ready) {
        throw new Error('音频文件处理失败: ' + (pa.error || ''));
      }
    }
    // 上传+处理都成功 → 落缓存（只记本次新上传的 id，复用的 id 保持原 expireAt；
    // 之后精读即使失败，文件本身仍可用，下次免传）。
    await saveArkFileCacheEntry({
      baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl, durationSec: wantDurSec,
      videoFileId: cached.videoFileId ? '' : vup.fileId,
      audioFileId: (needAudio && !cached.audioFileId && aup) ? aup.fileId : '',
    });
    stageLabel = '视听精读';
    // 说话人命名先验：标题 + 页面元信息块（B站合成文本开头带 UP主/简介/嘉宾名单，
    // 硅谷101 实测简介里直接列出「采访嘉宾/主持人」）。截 500 字控 token。
    const metaHint = [ctx.articleTitle || ctx.meta?.title || '', (ctx.text || '').slice(0, 500)]
      .filter(Boolean).join(' ').slice(0, 600);
    const res = await asrAdapterFor(asr.provider).analyzeVideo({
      baseUrl: asr.baseUrl,
      apiKey: asr.apiKey,
      videoFileId: vup.fileId,
      audioFileId: aup ? aup.fileId : null,
      // 说话人命名先验（身份证据：画面姓名条/自我介绍/简介名单）
      metaHint,
      // 精读用视频模型（options 可配 videoModel，留空回退转写模型——doubao-seed
      // 系列本身就是多模态）。
      model: (asr.videoModel || '').trim() || asr.model,
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
      throw new Error(`精读输出被模型上限截断（${res.finishReason || 'max_output_tokens'}）`);
    }
    console.log('[ASR] video analysis usage:', JSON.stringify(res.usage || {}));
    const fmt = formatAsrTranscript(res.text);
    // 完整度兜底（与字幕 ASR 同阈值）：最后时间戳必须覆盖到视频 90% 以上，
    // 绝不允许静默存半截精读。transcriptEndSec 自识裸秒数（[624.0]）并保留小数
    // 精度——不能先归一化再解析（mm:ss 截断小数会把 4.6s 边界误判成不完整）。
    const endSec = transcriptEndSec(res.text);
    if (wantDurSec > 0 && endSec != null && endSec < wantDurSec * 0.9) {
      console.warn('[ASR] video analysis incomplete: last stamp', endSec, 's < 90% of', wantDurSec, 's video');
      throw new Error('精读不完整（最后时间戳 ' + (endSec == null ? '?' : endSec.toFixed(0)) + 's / 视频 ' + wantDurSec + 's）');
    }
    // 空洞守卫：last stamp 过线不等于覆盖完整——81 分钟视频真实故障：0-16 分钟
    // 密集覆盖后直接跳到 49:27 和片尾，中间约 1 小时整段缺失，90% 守卫无感。
    const gap = largestTranscriptGapSec(res.text);
    if (gap && gap.gapSec > TRANSCRIPT_GAP_LIMIT_SEC) {
      console.warn('[ASR] video analysis incomplete: gap', JSON.stringify(gap));
      throw new Error(`精读不完整（时间轴存在 ${Math.round(gap.gapSec / 60)} 分钟空窗：${formatStampSec(gap.fromSec)} → ${formatStampSec(gap.toSec)}）`);
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
      throw new Error('精读输出为空');
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
    clearInterval(waitTimer);
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
    const fmtMB = (b) => (b > 0 ? `下载约 ${(b / 1024 / 1024).toFixed(0)}MB` : '');
    const joinSub = (parts) => parts.filter(Boolean).join(' · ');
    // 音频预估用候选列表的第一项（buildAsrPendingCtx 按码率升序排，[0] 是实际
    // 先试的最低码率流——下载体积最小的那条）。
    const audioCand = Array.isArray(ctx.audioCandidates) ? ctx.audioCandidates[0] : null;
    const audioEst = estimateStreamBytes(audioCand || { url: ctx.audioUrl, bandwidth: 0, size: 0 }, durationSec);
    const card = document.createElement('div');
    card.className = 'msg system asr-mode-card';
    const title = document.createElement('div');
    title.className = 'asr-mode-title';
    title.textContent = '该视频无字幕。选择解析方式：';
    card.appendChild(title);
    const row = document.createElement('div');
    row.className = 'asr-mode-row';
    const mkBtn = (mode, main, sub) => {
      const b = document.createElement('button');
      b.className = 'asr-mode-btn' + (mode === 'video' ? ' asr-mode-video' : '');
      b.type = 'button';
      const m1 = document.createElement('span');
      m1.className = 'asr-mode-main';
      m1.textContent = main;
      const m2 = document.createElement('span');
      m2.className = 'asr-mode-sub';
      m2.textContent = sub;
      b.appendChild(m1);
      b.appendChild(m2);
      b.addEventListener('click', () => { card.remove(); resolve(mode); });
      return b;
    };
    row.appendChild(mkBtn('audio', '音频转写（字幕）', joinSub([fmtMB(audioEst), '快', 'token 消耗少'])));
    if (videoPick) {
      const vSub = joinSub([videoPick.stream.label || '', fmtMB(videoPick.estBytes), '慢', 'token 消耗高']);
      row.appendChild(mkBtn('video', '视频精读（画面＋语音）', vSub));
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

// 下载最佳音频流并转码成 16kHz mono WAV（候选循环 + 截断换流 + 403 自愈），音频
// 转写与视频精读两条管线共用。want 透传给 403 自愈的 ASR_FRESH_URLS：'audio'
// 只刷音频流（纯 ASR 行为）；'all' 连 video/muxed 一起刷新——本函数自己仍只消费
// 音频条目，视频条目由调用方（视频管线）重新选流。
// 返回 { wavBlob, wavBytes, sampleRate, bytes, usedLabel }；全部候选失败时抛错。
export async function downloadAndTranscodeAudioBest({ ctx, platform, wantDurSec, want = 'audio' }) {
  // 1. Download the audio bytes (extension context, DNR-injected Referer /
  // Origin / Cookie — both platforms). Download can be slow (CDN node
  // assignment) — show a real percentage
  // from the streamed bytes when a total is knowable, else elapsed time.
  // Truncation guard: 一个真实 bug 中最低码率流只给了 ~20min（视频 100+min），
  // 转码后按实际 WAV 时长与视频总长比对，明显偏短则换下一候选流重试。
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
  // 下载失败/转码失败/截断都换下一候选流重试——不同码率流可能是不同编码
  // （最低码率常用 HE-AAC，decodeAudioData 可能解不了——真实 bug：transcode
  // "Unable to decode audio data"），或不同 CDN 节点（坏文件/坏节点）。
  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci];
    const isLast = ci === candidates.length - 1;
    const dlStart = Date.now();
    const dlTimer = setInterval(() => {
      const secs = Math.round((Date.now() - dlStart) / 1000);
      deps.showAttachProgress(`下载音频中…（已等待 ${secs}s）`);
    }, 1000);
    let dl;
    try {
      // DNR rule above injects the platform's Referer/Origin/Cookie at the
      // network layer for BOTH platforms. The fetch-level headers only carry
      // Range (helps CDNs accept the request): bilibili's downloadAudioBytes
      // default adds a bilibili Referer (redundant with DNR but harmless);
      // youtube must NOT send that bilibili Referer, so pass Range only.
      dl = await downloadAudioBytes({
        audioUrl: cand.url,
        ...(platform === 'youtube' ? { headers: { Range: 'bytes=0-' } } : {}),
        onProgress: (done, total) => {
          if (total) {
            deps.showAttachProgress(`下载音频中…（${Math.round((done / total) * 100)}%）`);
          } else {
            const secs = Math.round((Date.now() - dlStart) / 1000);
            deps.showAttachProgress(`下载音频中…（已下载 ${(done / 1024 / 1024).toFixed(1)}MB，已等待 ${secs}s）`);
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
      // 播放地址过期的自愈重试：403（deadline 签名 URL 过期，CDN 无论 referer/
      // cookie 都无条件 403）时自动在页内重拉一次 playurl 换全新签名 URL，
      // 成功则替换候选列表从头重试——用户无需刷新页面。仅此一次；再失败才走
      // 现有兜底（明示报错 + 回退原字幕）。
      if (!urlsRefreshed && /403/.test(lastErr)) {
        urlsRefreshed = true;
        const fresh = await deps.refreshAsrStreams(platform, want);
        if (fresh) {
          console.log(`[ASR] ${platform} streams refreshed -> ${fresh.length} streams, retrying download`);
          candidates.length = 0;
          for (const s of fresh) {
            // want:'all'（视频管线自愈）时 fresh 含 video/muxed 条目——本函数
            // 只消费音频条目，视频条目由调用方（视频管线）重新选流。
            if (s.type && s.type !== 'audio') continue;
            candidates.push({ url: s.url, label: s.label || '', codecs: s.codecs || '', id: s.id || 0 });
          }
          ci = -1;          // for 循环随后 ci++ 从 0 重跑（全新 URL）
          continue;
        }
      }
      if (isLast) throw new Error(lastErr);
      continue;
    }
    const dlBytes = dl.bytes || 0;
    console.log('[ASR] downloaded m4s', dlBytes, 'bytes; url host:', (() => { try { return new URL(cand.url).host; } catch { return '?'; } })(), '| codec:', cand.codecs || '?', '| id:', cand.id || 0, '| label:', cand.label || '');
    // Transcode: decodeAudioData is an opaque black box (no sub-progress),
    // and resample+encode is fast — so show elapsed time, not a fake %.
    deps.showAttachProgress(_t('progressTranscodeAudio', '转码音频中…（转为 WAV）'));
    const trStart = Date.now();
    const trTimer = setInterval(() => {
      const secs = Math.round((Date.now() - trStart) / 1000);
      deps.showAttachProgress(`转码音频中…（已等待 ${secs}s）`);
    }, 1000);
    let tr;
    try {
      // 2. Transcode to 16kHz mono WAV — B站 m4s is an MP4 container that 方舟
      // misclassifies as video (failed: Invalid video_url); WAV is pure audio
      // (active, verified end-to-end 2026-08-16). Web Audio API decodes fMP4.
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
    // Truncation check: uncompressed 16-bit PCM WAV (1 channel) → bytes =
    // sec * sampleRate * 2 (2 bytes/sample, 16-bit). wavDur ≈ audio seconds.
    // 阈值对齐 buildAsrPendingCtx 的元数据校验（< 90% 视为截断流）：之前 50% 的
    // 门槛放过了 62.5%（52:48 视频只出 33 分钟字幕）这类半截流——只有明显截断
    // 才换流/失败，正常音轨（≥90%）不受影响。
    const wavDur = tr.wavBytes / ((tr.sampleRate || 16000) * 2);
    const isShort = wantDurSec > 0 && wavDur < wantDurSec * 0.9;
    console.log('[ASR] transcoded -> WAV', tr.wavBytes, 'bytes, sampleRate', tr.sampleRate, '| wav dur ~', wavDur.toFixed(0), 's vs video', wantDurSec, 's', isShort ? '→ TRUNCATED' : '');
    if (isShort) {
      if (candidates.length > 1) {
        console.warn('[ASR] stream too short (' + wavDur.toFixed(0) + 's < 90% of ' + wantDurSec + 's) — trying next candidate');
        continue;
      }
      // 唯一候选也截断：静默附加部分字幕正是用户报告的 bug，必须失败回退
      // （纯文本 + 明确 toast），而不是继续把 ~20min 当 100min 用。
      throw new Error('ASR audio stream is truncated (' + wavDur.toFixed(0) + 's vs video ' + wantDurSec + 's)');
    }
    trans = tr;
    audioBytes = dlBytes;
    usedLabel = cand.label;
    break;
  }
  if (!trans?.ok || !trans.wavBlob) {
    throw new Error(lastErr || 'ASR transcode failed: no usable audio stream');
  }
  if (usedLabel) console.log('[ASR] using audio stream:', usedLabel);
  return { wavBlob: trans.wavBlob, wavBytes: trans.wavBytes, sampleRate: trans.sampleRate, bytes: audioBytes, usedLabel };
}

// 音频转写管线（原 sidepanel 内联行为提取为函数）：下载并转码最佳音频流 → 上传
// WAV → 轮询 → Responses 流式转写 → 截断/完整度校验。返回 { transcriptText, audioBytes }。
export async function runAudioTranscribePipeline({ ctx, platform, wantDurSec }) {
  const { asr } = ctx;
  // Ark Files 复用缓存：音频文件 30 天内命中则整段「下载→转码→上传」全部跳过。
  const pageUrl = ctx.meta?.url || '';
  const assetId = videoAssetId(platform, pageUrl);
  const fnameBase = assetId ? `browsa-${assetId}` : '';
  const cached = await lookupCachedArkFiles({
    baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl,
    need: 'audio', durationSec: wantDurSec,
  }).catch(() => null) || { videoFileId: '', audioFileId: '' };
  let best = null;
  if (cached.audioFileId) {
    console.log('[ASR] reusing cached audio fileId', cached.audioFileId);
    deps.showAttachProgress(_t('progressReuseAudio', '复用上次上传的音频文件（30 天内有效），跳过下载与上传…'));
  } else {
    best = await downloadAndTranscodeAudioBest({ ctx, platform, wantDurSec, want: 'audio' });
  }
  // 4. 上传 → 转写。单次调用整段音频（流式）：火山文档只限制上传文件大小
  // ≤512MB，没有“单次输出必须切分”的要求；切分方案的说话人编号不连续/边界
  // 重复问题无法根治，已按决策移除，改为直传 + 日志 + 完整度兜底，复现时
  // 靠日志正向定位。
  // XHR upload.onprogress gives a real percentage (fetch has none).
  let up;
  if (cached.audioFileId) {
    up = { fileId: cached.audioFileId };
  } else {
    deps.showAttachProgress(_t('progressUploadAudio', '上传音频中…（0%）'));
    const upStart = Date.now();
    up = await uploadBlobToArk({
      blob: best.wavBlob,
      filename: fnameBase ? `${fnameBase}-audio.wav` : 'audio.wav',
      apiKey: asr.apiKey,
      baseUrl: asr.baseUrl,
      onProgress: (done, total) => {
        if (total) {
          deps.showAttachProgress(`上传音频中…（${Math.round((done / total) * 100)}%）`);
        } else {
          const secs = Math.round((Date.now() - upStart) / 1000);
          deps.showAttachProgress(`上传音频中…（已上传 ${(done / 1024 / 1024).toFixed(1)}MB，已等待 ${secs}s）`);
        }
      },
    });
    if (!up?.ok || !up.fileId) {
      throw new Error('ASR upload failed: ' + (up?.error || 'no fileId'));
    }
    console.log('[ASR] uploaded fileId', up.fileId, '| sent', up.bytes, '| Ark meta:', JSON.stringify({ upBytes: up.upBytes, upContentType: up.upContentType, upStatus: up.upStatus }));
  }
  // 实时等待反馈：poll + transcribe 都可能耗时较长（长音频处理 + 流式转写），
  // 用一个 interval 每秒刷新当前阶段/已等待秒数，让用户知道仍在处理而非卡死。
  const waitStart = Date.now();
  let stageLabel = '识别处理';
  const waitTimer = setInterval(() => {
    const secs = Math.round((Date.now() - waitStart) / 1000);
    deps.showAttachProgress(`${stageLabel}中…（已等待 ${secs}s）`);
  }, 1000);
  try {
    // 2. Poll file status (sidepanel, has window)
    const poll = await pollFileStatus(asr.baseUrl, asr.apiKey, up.fileId, {
      timeoutMs: asr.timeoutMs,
    });
    console.log('[ASR] poll result:', JSON.stringify(poll));
    if (!poll.ready) {
      throw new Error('ASR file processing failed: ' + (poll.error || ''));
    }
    // 上传+处理成功 → 落缓存（复用命中时不覆盖原 expireAt）。
    await saveArkFileCacheEntry({
      baseUrl: asr.baseUrl, apiKey: asr.apiKey, platform, pageUrl, durationSec: wantDurSec,
      audioFileId: cached.audioFileId ? '' : up.fileId,
    });
    // 3. Transcribe via Responses API（流式）
    stageLabel = '转写';
    const tr = await asrAdapterFor(asr.provider).transcribeAudio({
      baseUrl: asr.baseUrl,
      apiKey: asr.apiKey,
      fileId: up.fileId,
      model: asr.model,
      language: asr.language,
      // 全片覆盖硬约束：转写 prompt 也要具体的 90% 时刻锚点（与视频精读同款，
      // 见 attach-asr.js coverageHintZh/En）——客户端 90% 守卫靠它提高一次过审率。
      durationSec: wantDurSec,
      // 墙钟预算随视频时长缩放：单次转写整段音频所需时间 ≈ 音频时长 ÷ 转写
      // 速度（实测 ≥3.3 倍实时）。给到「音频时长 ÷ 2」（2 倍实时速度的余量），
      // 默认 10 分钟兜底、上限 45 分钟，防无限挂起；流式内部另有 60s 空闲超时。
      signal: AbortSignal.timeout(Math.max(10 * 60_000, Math.min(45 * 60_000, Math.round((wantDurSec || 0) * 1000 / 2)))),
    });
    if (tr.truncated) {
      console.warn('[ASR] model output truncated:', tr.finishReason);
      throw new Error(`ASR 转写被模型输出上限截断（${tr.finishReason || 'max_output_tokens'}）`);
    }
    const fmt = formatAsrTranscript(tr.text);
    // 完整度兜底：即使音频本身完整（WAV 校验过了）、模型也没报截断，只要转写
    // 明显没覆盖到视频结尾（最后一句时间戳 < 视频 90%），说明输出被中途截断
    // ——绝不允许静默存半截字幕，必须失败回退（纯文本 + toast）。
    // transcriptEndSec 自识裸秒数（[624.0]）并保留小数精度（2026-08-30 真实故障）。
    console.log('[ASR] transcribe usage:', JSON.stringify(tr.usage || {}));
    const endSec = transcriptEndSec(tr.text);
    const incomplete = !!(wantDurSec > 0 && endSec != null && endSec < wantDurSec * 0.9);
    if (incomplete) {
      console.warn('[ASR] transcript incomplete: last stamp', endSec, 's < 90% of', wantDurSec, 's video');
      throw new Error('ASR transcript is incomplete (' + (endSec == null ? '?' : endSec.toFixed(0)) + 's of ' + wantDurSec + 's video)');
    }
    // 空洞守卫（与视频精读同款）：52:48 视频中途停 ×90% 守卫的教训之外，
    // 中段整段跳过也必须拦下（last stamp 合格但中间有洞）。
    const gap = largestTranscriptGapSec(tr.text);
    if (gap && gap.gapSec > TRANSCRIPT_GAP_LIMIT_SEC) {
      console.warn('[ASR] transcript incomplete: gap', JSON.stringify(gap));
      throw new Error(`ASR transcript is incomplete (时间轴 ${Math.round(gap.gapSec / 60)} 分钟空窗：${formatStampSec(gap.fromSec)} → ${formatStampSec(gap.toSec)})`);
    }
    if (endSec != null) {
      console.log(`[ASR] transcript complete: last stamp ${endSec.toFixed(1)}s (${(wantDurSec > 0 ? ((endSec / wantDurSec) * 100).toFixed(0) : '?')}% of ${wantDurSec}s video)`);
    }
    const finalText = fmt.lines.join('\n');
    if (!finalText) {
      throw new Error('ASR returned empty transcript');
    }
    return { transcriptText: finalText, audioBytes: best ? best.bytes : 0 };
  } finally {
    clearInterval(waitTimer);
  }
}

export async function onAttachPage() {
  if (!deps.getTabId()) return;
  const mode = [...deps.getCtxRadios()].find((r) => r.checked)?.value || 'reader';
  const origAttachIcon = deps.attachBtn.innerHTML;
  const origTitle = deps.attachBtn.title;
  deps.attachBtn.disabled = true;
  deps.attachBtn.innerHTML = ICONS.retry;
  deps.attachBtn.classList.add('is-attaching');
  deps.attachBtn.title = 'Reading page…';
  deps.showAttachProgress(_t('progressReadingPage', '正在读取页面…'));

  try {
    const res = await sendMessage({ type: 'ATTACH_PAGE', tabId: deps.getTabId(), mode, query: deps.inputEl.value || '' });
    if (!res?.ok || !res.data?.ok) {
      deps.appendError(res?.data?.error || res?.error || _t('readPageFailed', 'Failed to read page'));
      return;
    }
    const ctx = res.data?.ctx;
    const title = ctx?.articleTitle || ctx?.meta?.title || 'Page';

    // Screenshot mode: show crop UI before storing. User can select a region
    // or use the full image. Storing to history happens only on confirm.
    if (mode === 'screenshot' && ctx?.imageDataUrl) {
      deps.showScreenshotCropUI({
        imageDataUrl: ctx.imageDataUrl,
        metaUrl: ctx.meta?.url || '',
        metaTitle: title,
      }, async (finalDataUrl) => {
        // Confirmed (full or cropped image) — await so nextHistoryIdx only
        // increments if the storage write actually succeeded.
        const res = await sendMessage({ type: 'ATTACH_SCREENSHOT_CONFIRM',
          imageDataUrl: finalDataUrl,
          metaUrl: ctx.meta?.url || '',
          metaTitle: title }).catch(() => null);
        if (res?.data?.ok) deps.bumpHistoryIdx();
        const screenshotEl = deps.appendScreenshot(finalDataUrl);
        deps.appendAttachSystem(`📎 已附加截图："${title}"`, screenshotEl, undefined, undefined, undefined, res?.data?.attachId);
      });
      return; // crop UI takes over; nothing else to do here
    }

    // PDF bytes ready: run pdf.js text extraction here (sidepanel has a real
    // `window` that pdf.js needs; background.js service worker does not).
    // Any failure falls back to the same URL placeholder text as before --
    // never a stuck/broken state. History storage happens via ATTACH_PDF_CONFIRM.
    if (ctx?.mode === 'pdf-pending' && ctx?.pdfBase64) {
      deps.attachBtn.title = '解析 PDF 中…';
      deps.showAttachProgress(_t('progressParsingPdf', '解析 PDF 中…'));
      const attachT0 = performance.now();
      // arXiv enrichment runs alongside extraction: authors/categories/dates
      // for the context header. Best-effort + 6s timeout — never delays the
      // attach by more than that, and a miss just means no header block.
      const pdfUrl = ctx.meta?.url || '';
      const arxivMetaPromise = fetchArxivMeta(pdfUrl).catch(() => null);
      let pdfText, pdfNumPages, pdfOcrPages, pdfFigureImages = [], pdfExtra = {};
      try {
        const pdfResult = await Promise.race([
          extractPdfContent(ctx.pdfBase64, { extractFigures: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('pdf extraction timeout')), 150_000))
        ]);
        pdfText = pdfResult.text;
        pdfNumPages = pdfResult.numPages;
        pdfOcrPages = pdfResult.pagesNeedingOcr;
        pdfFigureImages = Array.isArray(pdfResult.figureImages) ? pdfResult.figureImages : [];
        pdfExtra = {
          docTitle: pdfResult.docTitle || '',
          layout: pdfResult.layout || null,
          hasEncodingIssues: !!pdfResult.hasEncodingIssues
        };
      } catch (e) {
        console.warn('browsa: pdf extraction failed, using placeholder', e.message);
        pdfText = `[PDF file — agent should fetch and read directly]\nURL: ${ctx.meta?.url || ''}\nTitle: ${ctx.meta?.title || ''}`;
      }
      const arxivMeta = await arxivMetaPromise;
      const arxivHeader = arxivMeta ? formatArxivMeta(arxivMeta, arxivIdFromUrl(pdfUrl)?.version) : '';
      console.log(`browsa[pdf]: attach pipeline (extract+arxiv) took ${Math.round(performance.now() - attachT0)}ms`);
      const confirmRes = await sendMessage({
        type: 'ATTACH_PDF_CONFIRM',
        text: pdfText,
        metaUrl: ctx.meta?.url || '',
        metaTitle: ctx.meta?.title || '',
        numPages: pdfNumPages,
        figureImages: pdfFigureImages,
        arxivHeader,
        paper: !!arxivMeta
      }).catch(() => null);
      // handler 在 text 为空时返回内层 { ok:false, error:'no text' }——外层
      // res.ok 只是桥接层标志，误当成功会虚增 nextHistoryIdx（索引错位）。
      if (confirmRes?.data?.ok) {
        deps.bumpHistoryIdx();
        const title = ctx.meta?.title || 'PDF';
        const charLabel = pdfText?.length > 0 ? `，${pdfText.length.toLocaleString()} 字符` : '';
        const pagesLabel = pdfNumPages ? `，${pdfNumPages} 页` : '';
        const ocrLabel = pdfOcrPages?.length > 0 ? `，${pdfOcrPages.length} 页可能需要 OCR` : '';
        const figLabel = pdfFigureImages.length > 0 ? `，${pdfFigureImages.length} figure${pdfFigureImages.length > 1 ? 's' : ''}` : '';
        const encLabel = pdfExtra.hasEncodingIssues ? '，文本可能存在编码问题' : '';
        const tblLabel = pdfExtra.layout?.pagesWithTables?.length ? `，${pdfExtra.layout.pagesWithTables.length} 页含表格` : '';
        // Visible confirmation that the arXiv metadata fetch landed — the
        // inspect dialog only shows the pre-header body text.
        const arxivLabel = arxivMeta ? `，arXiv:${arxivIdFromUrl(pdfUrl)?.id || '✓'}` : '';
        // background 回传 contextText = 模型实际收到的完整上下文（头部含
        // arXiv 元数据块 + 正文含 ## Figures 段）；回退旧响应时降级用 pdfText。
        const inspectCtx = confirmRes?.data?.contextText || pdfText;
        deps.appendAttachSystem(
          `📎 已附加 PDF："${title}"（pdf-text${arxivLabel}${pagesLabel}${charLabel}${ocrLabel}${figLabel}${encLabel}${tblLabel}）`,
          null, inspectCtx, pdfFigureImages, undefined, confirmRes?.data?.attachId
        );
      } else {
        deps.appendError(_t('pdfAttachFailed', 'PDF attach failed'));
      }
      return;
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
    if (ctx?.mode === 'asr-pending' && ctx?.audioUrl && ctx?.asr) {
      const { asr } = ctx;
      // 播放地址全部过期且自动刷新失败（deadline 签名的 m4s URL，过期后 CDN 一律
      // 403，referer/cookie 再对也没用）——再试也是白等三轮 403，直接明示原因并
      // 走回退（用户刷新视频页后重新 attach 即可，刷新 = 重新拉 playurl = 新签名）。
      // 平台显示名（错误/toast/确认标签共用）——必须在 asrExpiredError 的
      // throw 之前声明，否则那条错误自己先炸成 ReferenceError（TDZ）。
      const platform = ctx.asrPlatform || 'bilibili';
      const platformLabel = platform === 'youtube' ? 'YouTube' : 'B站';
      if (ctx.asrExpiredError) {
        console.warn('[ASR] expired playurl, auto-refresh failed:', ctx.asrExpiredError);
        throw new Error(`${platformLabel}播放地址已过期且自动刷新失败（${ctx.asrExpiredError}）——请刷新视频页面后重新附加`);
      }
      const wantDurSec = (ctx.videoDurationSec && ctx.videoDurationSec > 0) ? ctx.videoDurationSec : 0;
      // 视频解析模式（v1，当前暂时只支持 B 站）：有 video/muxed 流候选时弹模式选择卡，由用户在
      // 「音频转写（字幕）」与「视频精读（画面＋语音）」之间选；没有候选（YouTube
      // 的流捕获是 audio-only）维持旧行为直接跑音频。pickVideoStream 已在方舟
      // 512MB 上传预算内选好流（全部超预算 → null → 不出卡），预估体积在卡上展示。
      const videoPick = pickVideoStream({
        videoCandidates: ctx.videoCandidates,
        muxedStream: ctx.muxedStream,
        durationSec: wantDurSec,
      });
      let analysisMode = 'audio';
      if (videoPick) {
        deps.attachBtn.title = '选择解析方式…';
        analysisMode = await showAsrModeCard({ ctx, videoPick, durationSec: wantDurSec });
        if (analysisMode === 'abort') return; // 卡片被会话切换等清掉 → 静默取消（finally 恢复按钮）
      } else {
        deps.attachBtn.title = '转写音频中…';
        deps.showAttachProgress(_t('progressDownloadTranscribe', '下载并转写音频中…'));
      }
      let transcriptText = '';
      let audioBytes = 0;
      let videoBytes = 0;
      let figures = [];
      const dnrRuleId = Math.floor(Math.random() * 4_999_999) + 1;
      try {
        // 0. Register the session DNR rule injecting the platform CDN's required
        // headers (Referer/Origin/Cookie) onto the media downloads — shared by the
        // audio and video pipelines (the helper holds the per-header history).
        await registerMediaHeaders(dnrRuleId, platform, ctx.biliCookie || await readPlatformCookie(platform));
        if (analysisMode === 'video') {
          // —— 视频精读管线（v1，当前暂时只支持 B 站；durl 合一流走单文件，否则视频＋音频双文件）——
          const r = await runVideoAnalysisPipeline({ ctx, platform, videoPick, wantDurSec });
          transcriptText = r.transcriptText;
          audioBytes = r.audioBytes;
          videoBytes = r.videoBytes;
          figures = r.figures || [];
        } else {
          // —— 音频转写管线（原行为：下载最佳音频流 → WAV → 上传 → 轮询 → 转写）——
          const r = await runAudioTranscribePipeline({ ctx, platform, wantDurSec });
          transcriptText = r.transcriptText;
          audioBytes = r.audioBytes;
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
          : _t('asrFallbackVideoInfo', '已回退为视频信息');
        // 401 + "API key format is incorrect" = key 类型不对（不是密码错）：Agent
        // Plan 专属 key 与标准方舟平台 key 官方明确不通用，而 ASR/视频解析走标准
        // 端点的 Files API。给出可操作的提示，别让用户去猜。
        const authHint = /API key format is incorrect|AuthenticationError/i.test(e?.message || '')
          ? _t('asrAuthHint', '——ASR 配置里的 API Key 像是 Agent Plan 专属 key，与方舟平台 key 不通用，请到 设置 → ASR 字幕识别 换成平台 API Key（UUID 或 ark- 前缀）') : '';
        showToast(`${analysisMode === 'video' ? _t('asrModeVideo', '视频解析') : _t('asrModeTranscribe', 'ASR 转写')}${_t('failColon', '失败：')}${deps.compactArkErrorText(e?.message || _t('unknownError', '未知错误'))}${authHint}（${fallbackLabel}）`, 'error');
      } finally {
        // Remove the Referer-injection rule now that the download is done.
        // (A download that never started, a throw, or a success all land here.)
        try {
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [dnrRuleId] });
        } catch (_) {}
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
      const confirmRes = await sendMessage({
        type: 'ATTACH_ASR_CONFIRM',
        text: confirmText,
        metaUrl: ctx.meta?.url || '',
        metaTitle: ctx.meta?.title || '',
        platform,
        tabId: deps.getTabId(),
        // 视频精读的 format 标签区分产物（ATTACH_ASR_CONFIRM 缺省仍是 -asr）。
        ...(analysisMode === 'video' ? { format: platform + '-video' } : {}),
        // 关键帧截图（视频精读）：{url, caption} 列表，镜像 PDF 的 figureImages。
        ...(analysisMode === 'video' && figures.length ? { figureImages: figures } : {}),
      }).catch(() => null);
      if (confirmRes?.data?.ok) {
        deps.bumpHistoryIdx();
        deps.refreshTranscriptSource(); // 字幕进历史了，抽屉按钮可能该亮出来
        const title = ctx.meta?.title || (platform === 'youtube' ? 'YouTube视频' : 'B站视频');
        const lineCount = transcriptText ? transcriptText.split('\n').length : 0;
        const kindLabel = analysisMode === 'video' ? '视听精读' : '字幕';
        const bytesLabel = [
          videoBytes > 0 ? `，${(videoBytes / 1024 / 1024).toFixed(1)}MB 视频` : '',
          audioBytes > 0 ? `，${(audioBytes / 1024 / 1024).toFixed(1)}MB 音频` : '',
        ].join('');
        // 解析失败时的回退标签要区分：有原字幕的视频保留原字幕，无字幕的视频才是纯视频信息。
        const subLabel = transcriptText
          ? `，${lineCount} 行${kindLabel === '视听精读' ? '精读' : '字幕'}${figures.length ? `，${figures.length} 张截图` : ''}`
          : (ctx.noTranscript === false ? '（解析失败，已保留原字幕）' : '（无字幕，已用视频信息代替）');
        deps.appendAttachSystem(`📎 已附加 ${platformLabel}${kindLabel}："${title}"（${analysisMode === 'video' ? '视频解析' : 'ASR'}${bytesLabel}${subLabel}）`, null, confirmText, figures, undefined, confirmRes?.data?.attachId);
      } else {
        deps.appendError(_t('asrAttachFailed', 'ASR attach failed'));
      }
      return;
    }

    deps.bumpHistoryIdx(); // page context stored in ATTACH_PAGE handler
    deps.refreshTranscriptSource(); // 视频页上下文带 videoSrc，抽屉按钮可能该亮出来
    const charCount = ctx?.truncated?.textLength ?? (ctx?.text?.length || 0);
    const charLabel = charCount > 0 ? `，${charCount.toLocaleString()} 字符` : '，内容为空';
    // For auto mode, show which sub-mode was actually used
    const modeLabel = mode === 'auto' ? `auto/${ctx?.autoMode || 'reader'}` : mode;
    // Video without subtitles + ASR not enabled: tell the user the
    // current behavior (plain video-info attach, no transcription) and how
    // to opt into automatic subtitle transcription. Mode-specific label so the
    // hint reads naturally for B站 vs YouTube.
    const noTranscriptHint = ctx.noTranscriptHint
      ? _t('noTranscriptHint', '⚠️ 该视频无字幕：已保持现状（仅保存视频信息）。如需自动转写为字幕，请到 设置 → ASR 字幕识别 启用后重新附加。')
      : undefined;
    deps.appendAttachSystem(`📎 已附加："${title}"（${modeLabel}${charLabel}）`, null, ctx?.text || '', undefined, noTranscriptHint, res?.data?.attachId);
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
