// lib/content-scripts/xueqiu-content-script.js
//
// Injected into xueqiu.com (雪球) pages at document_start (MAIN world).
// Intercepts:
//   1. stock.xueqiu.com/v5/stock/quote.json — real-time stock quote + details
//   2. xueqiu.com/v4/statuses/show.json — individual post/article data
//
// User must be logged into Xueqiu for cookie-authenticated data (e.g. premium
// data fields). Public fields (price, name, symbol) work without login.

function isXueqiuStockUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'stock.xueqiu.com' && u.pathname.startsWith('/v5/stock/quote.json');
  } catch (_) { return false; }
}

function isXueqiuPostUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return (u.hostname === 'xueqiu.com' || u.hostname === 'www.xueqiu.com') && (
      u.pathname.startsWith('/v4/statuses/show') ||
      u.pathname.startsWith('/v4/user/statuses/show')
    );
  } catch (_) { return false; }
}

function extractXueqiuStock(data) {
  const q = data?.data?.quote;
  if (!q?.symbol) return null;
  return {
    type: 'stock',
    symbol: q.symbol || '',
    name: (q.name || '').trim(),
    current: q.current,
    percent: q.percent,
    open: q.open,
    high: q.high,
    low: q.low,
    volume: q.volume,
    marketCapital: q.market_capital,
    pe: q.pe_ttm,
    exchange: (q.exchange || '').trim(),
    orgName: (q.org_cn_name || q.org_en_abbreviation || '').trim(),
    rawAt: Date.now()
  };
}

function extractXueqiuPost(data) {
  const s = data?.status;
  if (!s?.id) return null;
  // Strip HTML tags from text
  const rawText = s.text || s.description || '';
  const text = rawText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  return {
    type: 'post',
    id: String(s.id),
    title: (s.title || '').trim(),
    text,
    author: (s.user?.screen_name || '').trim(),
    likes: s.like_count || 0,
    comments: s.reply_count || 0,
    createdAt: s.created_at || 0,
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

function installXueqiuInterceptor() {
  if (typeof window === 'undefined') return false;
  if (window.__browsaXueqiuInterceptorInstalled) return true;
  window.__browsaXueqiuInterceptorInstalled = true;

  function safeSend(data) {
    try { relayToHost({ type: 'XUEQIU_DATA', data }); } catch (_) {}
  }

  function handleResponse(url, responseJson) {
    if (isXueqiuStockUrl(url)) {
      const stock = extractXueqiuStock(responseJson);
      if (stock) safeSend(stock);
    } else if (isXueqiuPostUrl(url)) {
      const post = extractXueqiuPost(responseJson);
      if (post) safeSend(post);
    }
  }

  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isXueqiuStockUrl(url) || isXueqiuPostUrl(url)) {
        p.then(r => r.clone().json()).then(data => handleResponse(url, data)).catch(() => {});
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
      if (isXueqiuStockUrl(this.__browsaUrl) || isXueqiuPostUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { handleResponse(this.__browsaUrl, JSON.parse(this.responseText)); } catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isXueqiuStockUrl, isXueqiuPostUrl, extractXueqiuStock, extractXueqiuPost, installXueqiuInterceptor };
}

if (typeof window !== 'undefined') {
  installXueqiuInterceptor();
}
