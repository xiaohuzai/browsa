// lib/juejin-content-script.js
//
// Injected into juejin.cn pages. Intercepts the POST to
// api.juejin.cn/content_api/v1/article/detail which returns the full
// article including `mark_content` — the Markdown source — so we get
// clean, structured content without any DOM scraping or Readability.
//
// Pure functions at the top are unit-testable in Node. The IIFE at the
// bottom only runs in a browser extension content-script context.

// Pure: is this the Juejin article detail endpoint?
function isJuejinArticleUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.hostname === 'api.juejin.cn' &&
           u.pathname === '/content_api/v1/article/detail';
  } catch (_) { return false; }
}

// Pure: does the response look like a valid article?
function isValidJuejinResponse(data) {
  return data?.err_no === 0 &&
         typeof data?.data?.article_info?.mark_content === 'string' &&
         data.data.article_info.mark_content.length > 0;
}

// Pure: extract only what we need — no base64 images, just structured text.
function extractJuejinArticle(data) {
  const info = data.data.article_info;
  const author = data.data.author_user_info || {};
  const tags = (data.data.tags || [])
    .map(t => (t.tag_name || '').trim())
    .filter(Boolean);
  return {
    articleId: info.article_id || '',
    title: (info.title || '').trim(),
    markContent: info.mark_content || '',
    author: (author.user_name || '').trim(),
    tags,
    viewCount: info.view_count || 0,
    diggCount: info.digg_count || 0,
    commentCount: info.comment_count || 0,
    collectCount: info.collect_count || 0,
    rawAt: Date.now()
  };
}

// Pure dispatch gate.
function maybeExtractJuejin(url, data) {
  if (!isJuejinArticleUrl(url)) return null;
  if (!isValidJuejinResponse(data)) return null;
  return extractJuejinArticle(data);
}

// ---- Side-effect code -------------------------------------------------------

function installJuejinInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaJuejinInterceptorInstalled) return true;
  window.__browsaJuejinInterceptorInstalled = true;

  function safeSend(article) {
    try {
      chrome.runtime.sendMessage({ type: 'JUEJIN_ARTICLE', article });
    } catch (_) {}
  }

  // Wrap fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isJuejinArticleUrl(url)) {
        p.then(r => r.clone().json())
          .then(data => { const a = maybeExtractJuejin(url, data); if (a) safeSend(a); })
          .catch(() => {});
      }
      return p;
    };
  }

  // Wrap XHR (fallback)
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function () {
      if (isJuejinArticleUrl(this.__browsaUrl)) {
        this.addEventListener('load', function () {
          try {
            const data = JSON.parse(this.responseText);
            const a = maybeExtractJuejin(this.__browsaUrl, data);
            if (a) safeSend(a);
          } catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isJuejinArticleUrl,
    isValidJuejinResponse,
    extractJuejinArticle,
    maybeExtractJuejin,
    installJuejinInterceptor
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installJuejinInterceptor();
}
