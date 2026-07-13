// lib/content-scripts/geektime-content-script.js
//
// Injected into time.geekbang.org pages. Intercepts:
//   POST /serv/v1/article  — column article detail
//
// Request body: { "id": article_id }
// Response:     { code: 0, data: { article_info: { article_id, article_title,
//                 article_content (HTML), article_summary, author_name } } }
//
// article_content is HTML; we strip it to plain text in MAIN world using a
// temporary DOM element, same pattern as zhihu-content-script.js.

// Pure: is this the Geektime article endpoint?
function isGeektimeArticleUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'time.geekbang.org' && u.pathname === '/serv/v1/article';
  } catch (_) { return false; }
}

// Pure: is this a valid article response?
function isValidGeektimeResponse(data) {
  return data?.code === 0 && data?.data?.article_info?.article_content?.length > 0;
}

// Pure extractor (toText injected for testability without DOM)
function extractGeektimeArticle(data, toText) {
  const info = data.data.article_info;
  return {
    articleId: String(info.article_id || ''),
    title: (info.article_title || '').trim(),
    text: toText(info.article_content || ''),
    summary: (info.article_summary || '').trim(),
    author: (info.author_name || '').trim(),
    rawAt: Date.now()
  };
}

function maybeExtractGeektime(url, data, toText) {
  if (!isGeektimeArticleUrl(url)) return null;
  if (!isValidGeektimeResponse(data)) return null;
  return extractGeektimeArticle(data, toText);
}

// ---- Side-effect code -------------------------------------------------------

function installGeektimeInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaGeektimeInterceptorInstalled) return true;
  window.__browsaGeektimeInterceptorInstalled = true;

  function htmlToText(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function safeSend(article) {
    try {
      chrome.runtime.sendMessage({ type: 'GEEKTIME_ARTICLE', article });
    } catch (_) {}
  }

  // Wrap fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isGeektimeArticleUrl(url)) {
        p.then(r => r.clone().json())
          .then(data => {
            const a = maybeExtractGeektime(url, data, htmlToText);
            if (a) safeSend(a);
          })
          .catch(() => {});
      }
      return p;
    };
  }

  // Wrap XHR
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function () {
      if (isGeektimeArticleUrl(this.__browsaUrl)) {
        this.addEventListener('load', function () {
          try {
            const data = JSON.parse(this.responseText);
            const a = maybeExtractGeektime(this.__browsaUrl, data, htmlToText);
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
    isGeektimeArticleUrl,
    isValidGeektimeResponse,
    extractGeektimeArticle,
    maybeExtractGeektime,
    installGeektimeInterceptor
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installGeektimeInterceptor();
}
