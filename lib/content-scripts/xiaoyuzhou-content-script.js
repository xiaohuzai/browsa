// lib/content-scripts/xiaoyuzhou-content-script.js
//
// Injected into xiaoyuzhoufm.com (小宇宙) podcast pages at document_start (MAIN world).
// Intercepts API calls from their SPA to capture episode metadata.
//
// 小宇宙 is a popular Chinese podcast platform. Episode pages load data
// via REST API calls to api.xiaoyuzhoufm.com. We intercept these to
// capture episode title, description, podcast name, and duration.

function isXiaoyuzhouApiUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'api.xiaoyuzhoufm.com' || u.hostname === 'audioclip.oss-cn-shanghai.aliyuncs.com';
  } catch (_) { return false; }
}

function extractXiaoyuzhouEpisode(data) {
  // Try top-level episode object or nested under data/episode
  const ep = data?.data?.episode || data?.episode || (data?.eid ? data : null);
  if (!ep?.eid && !ep?.title) return null;
  return {
    eid: ep.eid || ep.id || '',
    title: (ep.title || '').trim(),
    podcast: (ep.podcast?.title || ep.podcastTitle || '').trim(),
    description: (ep.description || ep.shownotes || ep.content || '').trim(),
    duration: ep.duration || 0,
    mediaUrl: ep.enclosureUrl || ep.mediaUrl || '',
    publishedAt: ep.publishedAt || ep.pubDate || '',
    rawAt: Date.now()
  };
}

// MAIN world has no chrome.runtime — pushes go out via the ISOLATED-world
// relay (lib/content-scripts/site-relay.js, injected on this same site):
// it forwards window messages to chrome.runtime.sendMessage, feeding the
// background SITE_MESSAGE_MAP / XHS_XHR_NOTE receiver. (Restored 2026-10-01;
// this channel had been silently dead since the v0.19.1 MAIN-world move.)
function relayToHost(msg) {
  try { window.postMessage({ __browsaRelay: true, message: msg }, window.location.origin); } catch (_) {}
}

function installXiaoyuzhouInterceptor() {
  if (typeof window === 'undefined') return false;
  if (window.__browsaXiaoyuzhouInterceptorInstalled) return true;
  window.__browsaXiaoyuzhouInterceptorInstalled = true;

  function safeSend(episode) {
    try { relayToHost({ type: 'XIAOYUZHOU_EPISODE', episode }); } catch (_) {}
  }

  function tryExtract(data) {
    if (!data || typeof data !== 'object') return;
    const ep = extractXiaoyuzhouEpisode(data);
    if (ep?.title) safeSend(ep);
  }

  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isXiaoyuzhouApiUrl(url)) {
        p.then(r => r.clone().json()).then(tryExtract).catch(() => {});
      }
      return p;
    };
  }

  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function() {
      if (isXiaoyuzhouApiUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { tryExtract(JSON.parse(this.responseText)); } catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isXiaoyuzhouApiUrl, extractXiaoyuzhouEpisode, installXiaoyuzhouInterceptor };
}

if (typeof window !== 'undefined') {
  installXiaoyuzhouInterceptor();
}
