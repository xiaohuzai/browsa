// lib/handlers/attach-asr-pending.js — the ASR/video "pending" context
// builder, extracted from background.js (Phase 4 of the modularization refactor).
// Runs the MAIN-world executeScript probes that read a video page's playurl /
// session data and returns the ctx the sidepanel's ASR / 视听精读 pipeline needs
// (background.js's ATTACH_PAGE → "asr-pending" branch awaits it).
//
// Its external dependencies are three pure helpers plus the storage namespace
// (chrome.storage) — no background.js-owned state, which is why it could move
// cleanly. (Each injected `func:` must stay self-contained for
// chrome.scripting.executeScript; see AGENTS.md's countImages lesson.)
import * as storage from '../storage.js';
import { ASR_DEFAULTS, ASR_SUBTITLE_SOURCE, resolveVideoDurationSec } from './attach-asr.js';

export async function buildAsrPendingCtx(tabId, ctx) {
  try {
    // --- Platform dispatch: Bilibili vs YouTube ---
    // Both paths produce a list of audio stream candidates + the video's true
    // length (sec); the shared stream-selection logic below picks the best one.
    let got = null;
    if (ctx.mode === 'youtube') {
      // YouTube: no passive playurl cache like B站's __playinfo__ — the audio
      // stream must come from a FRESH /youtubei/v1/player response (ANDROID
      // client) so the PO token / signature in the URL is valid at download
      // time. ytInitialPlayerResponse goes stale after SPA navigation and
      // carries no guarantee of freshness, so we always re-fetch here.
      // NOTE: the videoId is parsed INSIDE the injected func from
      // window.location (never captured from the service-worker closure) —
      // chrome.scripting.executeScript serializes func via toString() and
      // re-evaluates it in the page, so closure variables are NOT available
      // (the countImages lesson). A closure-captured videoId is undefined in
      // the page, the fresh fetch returns no streams, and buildAsrPendingCtx
      // silently falls through to the normal store path.
      const videoId = (() => {
        try { return new URLSearchParams(new URL(ctx.meta?.url).search).get('v') || ''; }
        catch (_) { return ''; }
      })();
      if (!videoId) return null;
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['lib/content-scripts/youtube-content-script.js']
      });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async () => {
          const fn = window.__browsaFetchFreshYouTubeStreams;
          if (typeof fn !== 'function') return { streams: [], videoDurationSec: 0, asrExpiredError: '脚本未注入 __browsaFetchFreshYouTubeStreams' };
          // videoId from the live page URL — NOT a closure capture (see note above).
          const vid = (() => {
            try { return new URLSearchParams(window.location.search).get('v') || ''; }
            catch (_) { return ''; }
          })();
          if (!vid) return { streams: [], videoDurationSec: 0, asrExpiredError: '页面 URL 无 videoId' };
          // 1) Prefer the pot-bearing audio streams captured from the page's REAL
          // player response (handlePlayerResponse caches them). These carry a valid
          // PO token — the pot-less ANDROID POST (fetchFreshYouTubeStreams) returns
          // URLs that googlevideo 403s (real test 2026-08-25). Only pot URLs stand a
          // chance of being downloadable outside the player context.
          try {
            const potStreams = (typeof window.__browsaGetPlayerAudioStreams === 'function')
              ? window.__browsaGetPlayerAudioStreams(vid)
              : [];
            if (Array.isArray(potStreams) && potStreams.length > 0) {
              const usable = potStreams.filter((s) => s.url && s.hasPot);
              if (usable.length > 0) {
                console.log(`browsa: ASR using ${usable.length} captured pot audio streams`);
                return { streams: usable, videoDurationSec: 0 };
              }
            }
          } catch (_) {}
          // 2) Fall back to the fresh ANDROID /player POST (pot-less — likely 403,
          // but kept for the case where no pot capture exists yet).
          try {
            const r = await fn(vid);
            if (Array.isArray(r.streams) && r.streams.length > 0) return r;
            return { streams: [], videoDurationSec: r.videoDurationSec || 0, asrExpiredError: 'player 返回空音频流列表' };
          } catch (e) {
            return { streams: [], videoDurationSec: 0, asrExpiredError: 'player 自动刷新失败：' + String((e && e.message) || e) };
          }
        }
      });
      got = (res?.result && Array.isArray(res.result.streams)) ? res.result : null;
      if (!got) return null;
    } else {
      // Bilibili: existing behavior — prefer cached __playinfo__ URLs, fall
      // back to fresh playurl API on expiry. (Unchanged from before the
      // youtube branch; kept in its own else for clarity.)
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['lib/content-scripts/bilibili-content-script.js']
      });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        // Prefer __playinfo__ cached URLs (SSR-picked CDN nodes, fastest) — only
        // fall back to the fresh playurl API when the cached URL is expired
        // (deadline signature → 403). For ASR we only need the audio stream, and
        // we want the LOWEST bitrate one (smallest/fastest download — quality is
        // irrelevant, it gets transcoded to 16kHz mono WAV for Ark anyway). BUT a
        // truncated/short stream (a real user bug: 100+ min video → only ~20 min
        // of subtitles) must be rejected — each stream carries a `duration` (sec)
        // that we compare against the video's true length.
        func: async () => {
          try {
            const cached = (typeof window.__browsaGetBilibiliStreams === 'function')
              ? window.__browsaGetBilibiliStreams()
              : [];
            // Expiry is detected by parsing the `deadline` query param from the
            // signed URL itself (a network probe is unreliable — B站 CDN may
            // answer 200 to a plain GET for an already-expired URL, only the
            // actual media download 403s). No deadline param → assume valid.
            const isLive = (u) => {
              try {
                const m = /[?&]deadline=(\d+)/.exec(u);
                return !m || (parseInt(m[1], 10) * 1000) > Date.now() + 5 * 60_000;
              } catch (_) { return true; }
            };
            // Video true length (sec) from __playinfo__ SSR data — the reference
            // for detecting truncated audio streams.
            const pi = window.__playinfo__?.data || window.__playinfo__;
            const videoDurationSec = (pi?.duration || 0) > 0 ? pi.duration : 0;
            const cachedAudio = cached
              .filter(s => s.type === 'audio' && s.url && isLive(s.url))
              .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
            if (cachedAudio) return { streams: cached, videoDurationSec };
            // Cached audio empty or expired — fall back to fresh playurl API
            // (re-signs a brand-new URL with a fresh deadline, no page refresh).
            // bvid 绝不能从 __playinfo__ 读：B站 playurl 响应里没有 bvid 字段，
            // pi?.bvid 恒为空串 → 自愈刷新永远被 !bvid 拦死（真实故障 2026-08-29：
            // 页面开久了缓存流过期后必报「脚本未注入或缺 bvid/cid」让用户白刷新）。
            // 与字幕提取的主动拉取同策略：URL path 优先，__INITIAL_STATE__ 兜底；
            // cid 用 playinfo（有此字段）+ INITIAL_STATE 兜底。
            //（注意：函数体内不要出现 activeFetch / contentType 等 mock 匹配标记词，
            // attach-asr.test.mjs 按 func.toString() 字符串路由 canned 结果。）
            const pathBvid = (window.location?.pathname || '').match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1] || '';
            const vd = window.__INITIAL_STATE__?.videoData;
            const bvid = pathBvid || pi?.bvid || vd?.bvid || '';
            const cid = pi?.cid || vd?.cid || 0;
            const freshFn = window.__browsaFetchFreshBilibiliStreams;
            if (typeof freshFn === 'function' && bvid && cid) {
              try {
                const fresh = await freshFn(bvid, cid);
                if (Array.isArray(fresh) && fresh.length > 0) {
                  return { streams: fresh, videoDurationSec };
                }
                // 刷新返回空流：把原因留给调用方（缓存已过期，不能再静默回退死 URL）。
                return { streams: cached, videoDurationSec, asrExpiredError: 'fresh playurl 返回空流列表' };
              } catch (e) {
                // fresh playurl 失败（WBI 签名/网络/风控）时缓存已过期——不能静默
                // 回退到死 URL 让用户白等 403 重试；原因必须传到 UI（toast + 日志）。
                return { streams: cached, videoDurationSec, asrExpiredError: 'playurl 自动刷新失败：' + String((e && e.message) || e) };
              }
            }
            return { streams: cached, videoDurationSec, asrExpiredError: '缓存流全部过期且无自动刷新可用（脚本未注入或缺 bvid/cid）' };
          } catch (_) { return { streams: [], videoDurationSec: 0 }; }
        }
      });
      got = (res?.result && Array.isArray(res.result.streams)) ? res.result : null;
      if (!got) return null;
    }
    const streams = got.streams || [];
    // SSR duration 缺失时用 DASH 流自带 duration（秒）兜底（resolveVideoDurationSec）。
    const videoDurationSec = resolveVideoDurationSec(got.videoDurationSec, streams);
    const audioCandidates = streams
      .filter((s) => s.type === 'audio' && s.url)
      .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    // ASR only needs the audio track — prefer the LOWEST bitrate (smallest /
    // fastest download; quality is irrelevant, it gets transcoded to 16kHz
    // mono WAV for Ark anyway). BUT reject streams whose duration is clearly
    // shorter than the video (truncated/partial stream → 20 min of a 100+ min
    // video, a real user bug), AND prefer decodable codecs: the lowest-bitrate
    // stream is often HE-AAC (mp4a.40.5), which decodeAudioData may reject
    // (real bug: transcode "Unable to decode audio data"), while AAC-LC
    // (mp4a.40.2) decodes reliably. Only fall back to lowest-bitrate-everything
    // when duration metadata is missing/unusable.
    const fullLen = (s) => {
      if (!videoDurationSec || !s.duration) return null; // 无法判定 → 不拦截
      // 允许 -10% 容差（不同容器时长略有出入）；明显短则视为截断流。
      return s.duration >= videoDurationSec * 0.9 ? true : false;
    };
    // codecPrio: AAC-LC 最稳（decodeAudioData 可靠）；未知居中；HE-AAC 等靠后。
    const codecPrio = (s) => {
      const c = s.codecs || '';
      if (c === 'mp4a.40.2') return 0;
      if (!c) return 1;
      return 2; // 含 mp4a.40.5 (HE-AAC) 等
    };
    const sortBest = (list) => list.slice()
      .sort((a, b) => (codecPrio(a) - codecPrio(b)) || ((a.bandwidth || 0) - (b.bandwidth || 0)));
    const fullStreams = sortBest(audioCandidates.filter((s) => fullLen(s) === true));
    const unknownStreams = sortBest(audioCandidates.filter((s) => fullLen(s) === null));
    const anyStreams = sortBest(audioCandidates);
    // 完整长度的流优先；无法判定时长（元数据缺失）次之；都没有才退回全部。
    const ordered = fullStreams.length ? fullStreams : (unknownStreams.length ? unknownStreams : anyStreams);
    const audio = ordered[0];
    // 即便被选中的流元数据看似完整，若真实解码时长远小于视频总长（服务端 body
    // 截断、元数据谎报），或转码失败（编码不支持），也交由 sidepanel 在转码后
    // 校验并换下一候选重试——这里把完整候选列表（按优先级排序）+ 视频时长传给
    // sidepanel。
    const candidateAudios = ordered.map((s) => ({
      url: s.url, label: s.label || '', bandwidth: s.bandwidth || 0,
      duration: s.duration || 0, size: s.size || 0, codecs: s.codecs || '', id: s.id || 0,
    }));
    if (!audio) return null;
    // 视频解析（v1，当前暂时只支持 B 站）：透传 video-only 流候选（按码率降序）+ durl 合一流。
    // YouTube 的流捕获是 audio-only（pot 视频 URL 未验证），天然没有 video 条目 →
    // sidepanel 不出模式选择卡，维持纯音频行为。选流/512MB 预算判定在 sidepanel
    // 的 pickVideoStream 里做（卡片上要展示预估体积，选流必须发生在 UI 层）。
    const videoCandidates = streams
      .filter((s) => s.type === 'video' && s.url)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
      .map((s) => ({
        url: s.url, label: s.label || '', bandwidth: s.bandwidth || 0,
        duration: s.duration || 0, size: s.size || 0,
        width: s.width || 0, height: s.height || 0, id: s.id || 0,
      }));
    const muxedRaw = streams.find((s) => s.type === 'muxed' && s.url);
    const muxedStream = muxedRaw ? {
      url: muxedRaw.url, label: muxedRaw.label || 'mp4', bandwidth: muxedRaw.bandwidth || 0,
      duration: muxedRaw.duration || 0, size: muxedRaw.size || 0,
    } : null;
    // 读完整平台 cookie（含 HttpOnly 的 SESSDATA / SID），传给 sidepanel 在下载前经
    // DNR 注入 Cookie 头——对齐 cat-catch 的下载逻辑：cat-catch 用 chrome.webRequest
    // onSendHeaders 捕获页面播放器真实请求的完整 cookie（含 HttpOnly），而
    // document.cookie 读不到 HttpOnly。登录态/大会员 m4s 流缺 SESSDATA 会 403，
    // YouTube 的 googlevideo 下载也带 cookie（SID/SSID/VISITOR_INFO1_LIVE 等）。
    // chrome.cookies 权限 + <all_urls> host_permissions 才能读 HttpOnly cookie。
    // 早期假设 YouTube 靠 URL 里的 PO token（pot）免 cookie —— 实机测试（2026-08-25）
    // 证明不行：扩展上下文直接 fetch googlevideo 一律 403（chrome-extension origin
    // 被拒），必须像 B 站一样 DNR 注入 Referer+Origin+Cookie。
    let platformCookie = '';
    const cookieUrl = ctx.mode === 'bilibili' ? 'https://www.bilibili.com' : 'https://www.youtube.com';
    try {
      const cookies = await chrome.cookies.getAll({ url: cookieUrl });
      platformCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      console.warn('browsa: chrome.cookies.getAll failed', e?.message);
    }
    const all = await storage.getAll();
    const asr = { ...ASR_DEFAULTS, ...(all.asr || {}) };
    // 缓存播放地址过期且自动刷新失败（真实复现：页面开太久，playurl 签名 URL 的
    // deadline 已过期 → CDN 一律 403）。原因传入 ctx：sidepanel 会在下载前直接
    // 明示给用户（不再无意义地重试死 URL），请其刷新视频页后重新 attach。
    if (got.asrExpiredError) {
      console.warn('browsa: ASR cached playurl expired, auto-refresh failed:', got.asrExpiredError);
    }
    return Object.assign({}, ctx, {
      mode: 'asr-pending',
      // 保留原始平台（bilibili / youtube），sidepanel 据此决定 DNR 规则、下载头、
      // 平台文案和自愈路径。
      asrPlatform: ctx.mode,
      audioUrl: audio.url,
      audioLabel: audio.label || '',
      audioCodec: audio.codecs || '', audioId: audio.id || 0,
      // 完整候选音频流列表 + 视频总时长（秒）：sidepanel 转码后若发现实际解码
      // 时长远小于视频总长（服务端 body 截断 / 元数据谎报），可换下一候选流重试。
      audioCandidates: candidateAudios,
      // 视频解析候选（B站才有内容）：video-only 流（码率降序）+ durl 合一流（可空）。
      videoCandidates,
      muxedStream,
      videoDurationSec: videoDurationSec || 0,
      // 传給 sidepanel，供下载前 DNR 注入 Cookie 头（对齐 cat-catch 的下载逻辑）。
      biliCookie: platformCookie,
      // 播放地址过期/刷新失败原因（无则空串）。
      asrExpiredError: got.asrExpiredError || '',
      asr: {
        provider: asr.provider || 'ark',
        apiKey: asr.apiKey,
        baseUrl: asr.baseUrl,
        model: asr.model,
        videoModel: asr.videoModel || '',
        language: asr.language,
        format: asr.format,
        timeoutMs: asr.timeoutMs,
        subtitleSource: asr.subtitleSource || ASR_SUBTITLE_SOURCE.ORIGINAL,
      },
    });
  } catch (e) {
    console.warn('browsa: buildAsrPendingCtx failed', e?.message);
    return null;
  }
}
