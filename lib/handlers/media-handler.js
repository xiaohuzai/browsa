// lib/handlers/media-handler.js
//
// The GET_MEDIA_STREAMS / DOWNLOAD_MEDIA message handlers, extracted from
// background.js's handle() switch (same split as chat-handler.js /
// session-handler.js: handle() stays a thin dispatcher, each handler file
// owns its own imports and logic).
//
// Both cases are deliberately self-contained: they touch only chrome.* APIs
// plus the pure helpers in media-downloader.js — no background.js-internal
// state — so they move without any wiring changes. The MAIN-world injected
// funcs stay nested/self-contained per the countImages lesson (never sibling
// module-level calls).

import { extFromMime } from './media-downloader.js';

export async function handleGetMediaStreams(msg) {
  // Fetch the current video page's downloadable audio/video stream list.
  // Runs the site content-script's readXxxMediaStreams() in the page's MAIN
  // world (reads window.__playinfo__ / ytInitialPlayerResponse directly),
  // so the signed stream URLs are always fresh - no dependency on the
  // passive interceptor having fired.
  const tabId = msg.tabId;
  if (tabId == null) throw new Error('no tabId');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || '';
  let files, func, diagFunc;
  if (/bilibili\.com\/video\//.test(url)) {
    files = ['lib/content-scripts/bilibili-content-script.js'];
    // Prefer __playinfo__ cached URLs (SSR-picked CDN nodes, fastest) — only
    // fall back to the fresh playurl API when the cached URL is expired
    // (deadline signature → 403). This avoids the slow-CDN-node issue where
    // the API re-routes to a different, slower mirror. Expiry is detected
    // by parsing the `deadline` query param from the signed URL itself (a
    // network probe is unreliable — B站 CDN may answer 200 to a plain GET
    // for an already-expired URL, only the actual media download 403s).
    func = async () => {
      const valid = (readBilibiliMediaStreams() || []).filter(s => {
        if (!s.url) return false;
        try {
          const m = /[?&]deadline=(\d+)/.exec(s.url);
          // No deadline param (non-CDN URL?) → assume valid. Buffer of 5
          // min so a URL that's about to expire mid-download is not used.
          return !m || (parseInt(m[1], 10) * 1000) > Date.now() + 5 * 60_000;
        } catch (_) { return true; }
      });
      if (valid.length > 0) return valid;
      // All cached URLs expired (or empty) — fall back to fresh playurl API
      try {
        const pi = window.__playinfo__?.data || window.__playinfo__;
        const bvid = pi?.bvid || '';
        const cid = pi?.cid || 0;
        const freshFn = window.__browsaFetchFreshBilibiliStreams;
        if (typeof freshFn === 'function' && bvid && cid) {
          try {
            const fresh = await freshFn(bvid, cid);
            if (Array.isArray(fresh) && fresh.length > 0) return fresh;
          } catch (_) {}
        }
      } catch (_) {}
      return valid;
    };
    // Self-contained diagnostic (only window + built-ins) run in MAIN world
    // when the stream list is empty, so the panel can show WHY (absent
    // __playinfo__, not-logged-in code:-101, structural change, ...).
    diagFunc = () => {
      try {
        const pi = window.__playinfo__;
        if (!pi) {
          const c = Object.keys(window).filter(k => /play|state|initial|video/i.test(k));
          return 'window.__playinfo__ 不存在。候选全局: ' + (c.join(', ') || '(无)');
        }
        const d = (pi && typeof pi === 'object' && pi.data) ? pi.data : pi;
        const b = ['type=' + typeof pi];
        if (pi && typeof pi === 'object') {
          b.push('code=' + (pi.code ?? '无'));
          b.push('顶层键=' + Object.keys(pi).slice(0, 12).join(','));
          if (d && typeof d === 'object') {
            b.push('dash=' + (d.dash ? Object.keys(d.dash).join(',') : '无'));
            b.push('durl=' + (Array.isArray(d.durl) ? d.durl.length : '无'));
          }
        }
        return b.join(' | ');
      } catch (e) { return '诊断异常: ' + (e && e.message || e); }
    };
  } else if (/youtube\.com\/watch/.test(url)) {
    files = ['lib/content-scripts/youtube-content-script.js'];
    func = () => readYouTubeStreams();
    diagFunc = () => {
      try {
        const p = window.ytInitialPlayerResponse;
        if (!p) {
          const c = Object.keys(window).filter(k => /player|initial|yt/i.test(k));
          return 'ytInitialPlayerResponse 不存在。候选全局: ' + (c.join(', ') || '(无)');
        }
        const sd = p.streamingData;
        const b = ['顶层键=' + Object.keys(p).slice(0, 15).join(',')];
        if (p.playabilityStatus) b.push('status=' + p.playabilityStatus.status);
        if (sd) {
          b.push('formats=' + (Array.isArray(sd.formats) ? sd.formats.length : '无'));
          b.push('adaptive=' + (Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats.length : '无'));
        } else b.push('无streamingData');
        return b.join(' | ');
      } catch (e) { return '诊断异常: ' + (e && e.message || e); }
    };
  } else {
    throw new Error('not a video page');
  }
  // `files` injection first so the content script's top-level functions
  // exist as page globals the func can call (same pattern as the
  // active-fetch fallbacks in lib/page-extractor.js).
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func });
  const streams = Array.isArray(res?.result) ? res.result : [];
  let debug = '';
  if (streams.length === 0) {
    try {
      const [d] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: diagFunc });
      debug = (d?.result && String(d.result)) || '';
    } catch (_) {}
  }
  // Plain return (no inner ok: envelope) - the onMessage listener wraps
  // this as { ok:true, data:{streams,url,debug} }; the panel reads
  // res.data.streams directly. Errors throw -> { ok:false, error }.
  return { streams, url, debug };
}

export async function handleDownloadMedia(msg) {
  // Download one stream (audio/video).
  //
  // PRIMARY: chrome.downloads.download with saveAs - the instant save
  // dialog and the browser's downloader stream the file straight from the
  // CDN to disk. Two things the page-world fetch can't provide combine
  // here: the downloader sends the site's cookies (a page fetch omits
  // cross-origin cookies, which some login-scoped B站 m4s reject with
  // 403), and with a session declarativeNetRequest rule the Referer B站's
  // CDN checks is injected too (resourceTypes lists every type so the rule
  // matches however Chrome classifies the download request). This is
  // exactly the download call the user confirmed working ("现在可以下载
  // 了" page path and the saveAs path both verified).
  //
  // NO success watcher, NO auto-cancel/erase: a freshly created saveAs
  // download transiently reports state:'interrupted' while the dialog is
  // open, and watchers kept mistaking that for failure - the panel just
  // shows "已开始下载" and the browser's own download bar owns the outcome.
  // The DNR rule is left registered until the SW next restarts (session
  // rules are self-cleaning) - it's idempotent and scoped to one URL.
  //
  // FALLBACK (when chrome.downloads.download itself rejects, not on a
  // later download failure): page-world fetch+blob+<a download> - carries
  // the Referer natively; the MV3 SW has no URL.createObjectURL, so it
  // must run in the page.
  // Returns plain data on success, throws on failure (no inner envelope -
  // the listener wraps as ok:true/data).
  const { tabId, stream, filename } = msg;
  if (tabId == null || !stream?.url) throw new Error('invalid request');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = tab?.url || '';
  const isBili = /bilibili\.com/.test(pageUrl);
  if (!/bilibili\.com|youtube\.com/.test(pageUrl)) throw new Error('not a video page');
  const ext = extFromMime(stream.mimeType) || (stream.type === 'audio' ? 'm4a' : 'mp4');
  const name = (filename || stream.label || 'media').replace(/[/\\:*?"<>|~]/g, '_') + '.' + ext;

  if (isBili) {
    const ruleId = Math.floor(Math.random() * 4_999_999) + 1;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.bilibili.com' }]
          },
          condition: {
            // Host-wide match (NOT the exact signed URL): the B站 CDN
            // 302-redirects downloads to mirror hosts (upos-sz-a -> upos-sz-b,
            // etc.), and an exact-URL rule is lost after the redirect - the
            // redirect target has no Referer, the CDN returns a 403 HTML
            // page, and Chrome saves/fails it as .html/.txt. Substring
            // 'bilivideo' covers every mirror host including redirect
            // targets, on both .com and .cn CDN hosts (real downloads hit
            // mcdn.bilivideo.cn and upos-sz-*.bilivideo.com). Injecting
            // bilibili.com as Referer on bilivideo.* requests is harmless
            // (that's the value a B站 page sends naturally anyway).
            urlFilter: 'bilivideo',
            resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other']
          }
        }]
      });
    } catch (_) {}  // no Referer injection, no harm - downloads may still work with cookies
  }

  try {
    const downloadId = await chrome.downloads.download({ url: stream.url, filename: name, saveAs: true });
    return { downloadId, bytes: null, userCanceled: false };
  } catch (e) {
    if (/cancel/i.test(String(e?.message || e))) {
      // User dismissed the save dialog - not a failure, no fallback.
      return { downloadId: null, bytes: null, userCanceled: true };
    }
    // Real rejection (e.g. a CDN that refuses the browser downloader) -
    // fall through to the page-world path below.
  }

  // Self-contained func (only fetch/Blob/URL/document - no sibling calls,
  // per the countImages MAIN-world-injection lesson).
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (streamUrl, n) => {
      try {
        // Default credentials (omit): a cross-origin fetch with
        // credentials:'include' demands a non-* Access-Control-Allow-Origin
        // + Access-Control-Allow-Credentials, which B站 CDN doesn't send -
        // it only sends allow-origin:*. `Range: bytes=0-` because some
        // CDN paths reject a Range-less .m4s request with 403.
        const resp = await fetch(streamUrl, { headers: { Range: 'bytes=0-' } });
        if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = n;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (_) {} }, 60000);
        return { ok: true, bytes: blob.size };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
    args: [stream.url, name],
  });
  const result = res?.result || { ok: false, error: 'no result from page' };
  if (!result.ok) throw new Error(result.error);
  return { bytes: result.bytes, userCanceled: false };
}
