// lib/site-fallbacks.js — site-specific ACTIVE fallbacks: when passive
// interception found nothing, inject the site's content script on demand and
// ask it to fetch through the page's own authenticated context.
//
// Extracted from lib/page-extractor.js (2026-10-17). These are service-worker
// code (they call chrome.scripting), unlike the MAIN-world extractors which
// must stay in page-extractor.js because each is serialized by value into the
// page and may only use browser built-ins.
//
// Every path is fail-open: a miss returns null and the generic cascade keeps
// its baseline result.

import {
  synthesizeYouTubeResult, synthesizeBilibiliResult, synthesizeTwitterResult,
  synthesizeRedditResult, synthesizeZhihuResult, twitterFromSyndication,
} from './site-synthesizers.js';
import { blobToJpegDataURL } from './page-images.js';

/**
 * The shell every "active fallback" shares: on-demand inject the site's content
 * script (so this works on any tab regardless of when it was opened), ask the page
 * to fetch through its own authenticated context, and hand the result to that site's
 * synthesizer. `accept` is the site's "did we get anything usable" predicate —
 * everything else (injection shape, the [res] destructure, fail-open null) was
 * identical in five copies. Each caller still owns its URL gate and its success log
 * line, because those are the parts that actually differ.
 */
async function runActiveFallback({ tab, meta, script, fetchInPage, accept, synth, log, label, onError }) {
  try {
    // site-common.js 必须先于站点脚本注入（与 manifest 排序不变量一致）：按需
    // 兜底的目标正是「manifest 没跑过的 tab」（扩展安装/重载后未刷新的页面），
    // 此时 window.__browsa* 全局缺失，站点脚本会走 require('./site-common.js')
    // 桥——MAIN world 无 require → ReferenceError，整个主动兜底失效（2026-11-03
    // 审计）。site-common 是 IIFE + 守卫赋值，重复注入安全。
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['lib/content-scripts/site-common.js', script],
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fetchInPage,
    });
    const data = res?.result;
    if (accept(data)) {
      const synthesized = synth(data, meta);
      console.log(`browsa: ${label} active-fetch fallback ${log(data)}`);
      return synthesized;
    }
  } catch (e) {
    (onError || ((err) => console.log(`browsa: ${label} active-fetch fallback error:`, err?.message)))(e);
  }
  return null;
}

/**
 * YouTube active fallback: inject the content script on-demand (if not already
 * present) then call activeYouTubeFetch(). Using `files` injection means this
 * works on any tab regardless of when it was opened — no dependency on the
 * manifest content_script having run at document_start.
 */
export async function tryYoutubeActiveFallback(tab, meta) {
  // /watch?v=（普通页）+ /shorts/、/live/、/embed/、/v/（2026-10-20 补——
  // Shorts 页没有 ?v=，旧门直接拒掉，videoId 的路径提取根本到不了）。
  // 门后面的 activeYouTubeFetch 对认不出的页面自己返回 null，所以这里
  // 放宽是安全的。
  if (!/youtube\.com\/(watch\?|shorts\/|live\/|embed\/|v\/)/.test(tab.url || '')) return null;
  return runActiveFallback({
    tab,
    meta,
    script: 'lib/content-scripts/youtube-content-script.js',
    fetchInPage: async () => activeYouTubeFetch(),
    accept: (video) => !!video?.videoId,
    synth: synthesizeYouTubeResult,
    log: (video) => `transcript=${!!video.transcript} chapters=${!!video.chapters}`,
    label: 'youtube',
  });
}

/**
 * Bilibili active fallback: inject the content script on-demand (if not already
 * present) then call activeFetchBilibiliVideo(). Same on-demand injection
 * pattern as tryYoutubeActiveFallback — works regardless of tab open time.
 */
export async function tryBilibiliActiveFallback(tab, meta) {
  // /video/（普通播放页）+ /festival/、/blackboard/ 等活动页（2026-10-19
  // 用户报告：/festival/jzj2023?bvid=BV… attach 拿不到字幕）+ 任何带
  // ?bvid=/&bvid=/&aid= 的 bilibili 页面（player.html 嵌入形态）。bvid/aid
  // 都没有的页面里 activeFetchBilibiliVideo 会抛 'no bvid on page' → 捕获
  // 后原样回落通用提取，所以这个门可以放宽。
  const url = tab.url || '';
  const isBiliVideoPage = /bilibili\.com\/(video\/|festival\/|blackboard\/)/.test(url)
    || (/bilibili\.com\//.test(url) && /[?&](bvid|aid)=/.test(url));
  if (!isBiliVideoPage) return null;
  return runActiveFallback({
    tab,
    meta,
    script: 'lib/content-scripts/bilibili-content-script.js',
    fetchInPage: async () => activeFetchBilibiliVideo(),
    accept: (video) => !!video?.bvid,
    synth: synthesizeBilibiliResult,
    log: (video) => `transcript=${!!video.transcript}`,
    label: 'bilibili',
    // An injection/fetch failure here silently degrades to whatever the passive
    // path found — warn so the trace of WHY the (better) active path skipped exists.
    onError: (e) => console.warn('browsa: bilibili active-fetch fallback failed:', e?.message || e),
  });
}

// X syndication 兜底（2026-10-16 用户报告：auto 模式本地提取 X 页为空时曾
// 静默落到 r.jina.ai——匿名服务端抓取只拿得到 X 的登录墙，推文图片也丢）。
// cdn.syndication.twimg.com/tweet-result 是 X 自家 embed 数据源：免登录、免
// Cookie、免 DOM 渲染，返回全文/作者/计数/mediaDetails 原图 URL。token 是
// react-tweet 同款公开公式（(id/1e15)*π 的六进制去零，非鉴权）。照片 SW 侧
// 下载压缩（twimg 无 Referer 门，200 image/*），bytes 随 imageBase64List 入
// 库——与页内抓取同一 fail-open 精神：单张失败只是缺一张，端点失败返回
// null 进下一级。
function syndicationToken(statusId) {
  return ((Number(statusId) / 1e15) * Math.PI).toString(6).replace(/(0+|\.)/g, '');
}

export async function fetchTweetViaSyndication(statusId) {
  if (!/^\d+$/.test(String(statusId || ''))) return null;
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${syndicationToken(statusId)}&lang=zh`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const tweet = twitterFromSyndication(await resp.json());
    if (!tweet) return null;
    const images = [];
    for (const photoUrl of (tweet.photos || []).slice(0, 4)) {
      try {
        const r = await fetch(photoUrl, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const b64 = await blobToJpegDataURL(await r.blob());
        if (b64) images.push(b64);
      } catch (_) { /* next photo */ }
    }
    tweet.imageBase64List = images;
    return tweet;
  } catch (_) {
    return null;
  }
}

/**
 * X/Twitter active fallback: inject the content script on-demand then call
 * activeXFetch(). Same on-demand injection pattern as tryYoutubeActiveFallback
 * / tryBilibiliActiveFallback — works on any tab regardless of when it was
 * opened. Returns null (falls through to the generic cascade) when the page
 * isn't a tweet URL or extraction yields nothing.
 */
export async function tryXActiveFallback(tab, meta) {
  // HOST GATE FIRST. `/status/<digits>` is a generic URL shape (status pages,
  // ticket links); without the host check any such page could inject the X
  // script and attach a *real tweet* whose id happens to match, silently
  // attaching the wrong content (2026-10-21 release audit). v0.44.3 had this
  // exact gate.
  const tabUrl = String(tab.url || '');
  if (!/^https?:\/\/([^/]*\.)?(x|twitter)\.com\//i.test(tabUrl)) return null;
  const statusId = (tabUrl.match(/\/status\/(\d+)/) || [])[1];
  if (!statusId) return null;
  const fromPage = await runActiveFallback({
    tab,
    meta,
    script: 'lib/content-scripts/twitter-content-script.js',
    fetchInPage: async () => activeXFetch(),
    accept: (tweet) => !!tweet?.text,
    synth: synthesizeTwitterResult,
    log: (tweet) => `text=${tweet.text?.length || 0} replies=${Array.isArray(tweet.replies) ? tweet.replies.length : 0}`,
    label: 'x',
  });
  if (fromPage) return fromPage;
  // 页内路径拿不到（登出页 __INITIAL_STATE__ 缺失 / DOM 未渲染 / 注入失败）
  // 时，syndication 端点是免登录的权威兜底——否则 auto 曾一路跌到 r.jina.ai
  // 的登录墙垃圾。端点不含回复，可见回复仍以页内路径优先（上面的 return）。
  try {
    const sc = await fetchTweetViaSyndication(statusId);
    if (sc?.text) {
      const synthesized = synthesizeTwitterResult(sc, meta);
      console.log(`browsa: x syndication fallback text=${sc.text.length} photos=${(sc.imageBase64List || []).length}`);
      return synthesized;
    }
  } catch (_) { /* fail-open into the generic cascade */ }
  return null;
}

/**
 * Reddit active fallback: inject the reddit content script on-demand then call
 * activeRedditFetch(). Same on-demand injection pattern as the other active
 * fallbacks — works on any tab regardless of when it was opened. Returns null
 * (falls through to the generic cascade) when the page isn't a Reddit page or
 * extraction yields nothing.
 */
export async function tryRedditActiveFallback(tab, meta) {
  if (!/\.reddit\.com\//.test(tab.url || '')) return null;
  return runActiveFallback({
    tab,
    meta,
    script: 'lib/content-scripts/reddit-content-script.js',
    fetchInPage: async () => activeRedditFetch(),
    accept: (data) => !!data?.post?.title,
    synth: synthesizeRedditResult,
    log: (data) => `title=${data.post.title?.length || 0} comments=${Array.isArray(data.comments) ? data.comments.length : 0}`,
    label: 'reddit',
  });
}

/**
 * Zhihu active fallback: inject the zhihu content script on-demand then call
 * activeZhihuFetch(). Same on-demand injection pattern as tryXActiveFallback /
 * tryRedditActiveFallback — works on any tab regardless of when it was opened.
 * Returns null (falls through to the generic cascade) when the page isn't a
 * zhihu answer/article URL or the API fetch yields nothing usable.
 */
export async function tryZhihuActiveFallback(tab, meta) {
  if (!/^https?:\/\/([^/]*\.)?zhihu\.com\//.test(tab.url || '')) return null;
  return runActiveFallback({
    tab,
    meta,
    script: 'lib/content-scripts/zhihu-content-script.js',
    fetchInPage: async () => activeZhihuFetch(),
    accept: (data) => !!data?.text && data.text.length > 40,
    synth: synthesizeZhihuResult,
    log: (data) => `kind=${data.type} text=${data.text.length} chars`,
    label: 'zhihu',
  });
}
