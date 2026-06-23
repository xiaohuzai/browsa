// lib/bilibili-content-script.js
//
// Injected into bilibili.com video pages at document_start (MAIN world).
// Intercepts:
//   1. GET api.bilibili.com/x/web-interface/view — video metadata (title, author, desc, stats)
//   2. GET api.bilibili.com/x/player/wbi/v2 — player config including CC subtitle URLs
//
// Fetches the CC subtitle JSON and converts to timestamped plain text,
// then sends the complete video context to the background cache.

function isBilibiliViewUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/view';
  } catch (_) { return false; }
}

function isBilibiliPlayerUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.hostname === 'api.bilibili.com' && (
      u.pathname === '/x/player/wbi/v2' || u.pathname === '/x/player/v2'
    );
  } catch (_) { return false; }
}

function extractBilibiliVideo(data) {
  const d = data?.data;
  if (!d?.bvid) return null;
  return {
    bvid: d.bvid,
    title: (d.title || '').trim(),
    desc: (d.desc || '').trim(),
    author: (d.owner?.name || '').trim(),
    tname: (d.tname || '').trim(),
    duration: d.duration || 0,
    cid: d.pages?.[0]?.cid || 0,
    stat: {
      view: d.stat?.view || 0,
      like: d.stat?.like || 0,
      coin: d.stat?.coin || 0,
      favorite: d.stat?.favorite || 0,
      reply: d.stat?.reply || 0,
    },
    rawAt: Date.now()
  };
}

// Fetch CC subtitle JSON and convert to timestamped plain text.
async function fetchBilibiliSubtitle(subtitles) {
  if (!subtitles?.length) return null;
  // Prefer: AI Chinese > Chinese > English > first available
  const sub =
    subtitles.find(s => s.lan === 'ai-zh') ||
    subtitles.find(s => s.lan?.startsWith('zh')) ||
    subtitles.find(s => s.lan?.startsWith('en')) ||
    subtitles[0];
  if (!sub?.subtitle_url) return null;
  try {
    const url = sub.subtitle_url.startsWith('//') ? 'https:' + sub.subtitle_url : sub.subtitle_url;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const body = data.body || [];
    const lines = body.map(item => {
      const t = Math.floor(item.from || 0);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      return `[${mm}:${ss}] ${(item.content || '').trim()}`;
    }).filter(l => l.length > 8);
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (_) {
    return null;
  }
}

function installBilibiliInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaBilibiliInterceptorInstalled) return true;
  window.__browsaBilibiliInterceptorInstalled = true;

  // Shared state — merge video meta from view API + subtitle from player API
  let videoMeta = null;

  function safeSend(video) {
    try { chrome.runtime.sendMessage({ type: 'BILIBILI_VIDEO', video }); } catch (_) {}
  }

  async function handleViewResponse(data) {
    const meta = extractBilibiliVideo(data);
    if (!meta) return;
    videoMeta = meta;
    safeSend(meta); // Send immediately (no transcript yet)
  }

  async function handlePlayerResponse(data) {
    const subtitles = data?.data?.subtitle?.subtitles;
    if (!subtitles?.length || !videoMeta) return;
    const transcript = await fetchBilibiliSubtitle(subtitles);
    if (transcript) {
      videoMeta = Object.assign({}, videoMeta, { transcript });
      safeSend(videoMeta); // Re-send with transcript
    }
  }

  // Wrap fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isBilibiliViewUrl(url)) {
        p.then(r => r.clone().json()).then(handleViewResponse).catch(() => {});
      } else if (isBilibiliPlayerUrl(url)) {
        p.then(r => r.clone().json()).then(handlePlayerResponse).catch(() => {});
      }
      return p;
    };
  }

  // Wrap XHR (fallback)
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function() {
      if (isBilibiliViewUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { handleViewResponse(JSON.parse(this.responseText)); } catch (_) {}
        });
      } else if (isBilibiliPlayerUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { handlePlayerResponse(JSON.parse(this.responseText)); } catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isBilibiliViewUrl, isBilibiliPlayerUrl, extractBilibiliVideo, installBilibiliInterceptor };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installBilibiliInterceptor();
}
