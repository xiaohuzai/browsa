// lib/dedao-content-script.js
//
// Injected into dedao.cn pages. Intercepts the article detail API calls
// that the SPA makes when loading course articles. Dedao's API is not
// publicly documented, so we intercept broadly on likely path patterns
// and probe the response for recognisable content fields.
//
// Known patterns (reverse-engineered from network captures and the
// yann0917/dedao-dl Go project):
//   GET /pc/v2/content/detail?id=xxx  — course article detail
//   GET /pc-college/v1/content/article/details  — college content
//   GET /pc/v2/article/detail?id=xxx  — alternative path
//
// Response structure varies but content is typically in:
//   data.content  |  data.article_content  |  data.text  |  data.detail

// Pure: does this URL look like a Dedao content detail endpoint?
function isDedaoContentUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    if (!u.hostname.endsWith('dedao.cn')) return false;
    const p = u.pathname;
    return /\/(content|article)\/(detail|details)/.test(p);
  } catch (_) { return false; }
}

// Pure: probe a response object for article content in known field locations.
// Returns { title, content, author } or null if nothing useful found.
function probeDedaoContent(data) {
  // Unwrap common envelope shapes: { code, data: {...} } or { errno, data }
  const d = data?.data ?? data;
  if (!d || typeof d !== 'object') return null;

  const title = (
    d.title || d.article_title || d.name || ''
  ).trim();

  const content = (
    d.content || d.article_content || d.text || d.detail || d.body || ''
  ).trim();

  if (!content || content.length < 50) return null; // too short to be real content

  const author = (
    d.author?.nickname || d.author?.name || d.nickname ||
    d.author_info?.nickname || ''
  ).trim();

  const id = String(d.id || d.article_id || d.eid || '');

  return { id, title, content, author };
}

function extractDedaoArticle(url, data) {
  const found = probeDedaoContent(data);
  if (!found) return null;
  return {
    ...found,
    sourceUrl: url,
    rawAt: Date.now()
  };
}

// ---- Side-effect code -------------------------------------------------------

function installDedaoInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaDedaoInterceptorInstalled) return true;
  window.__browsaDedaoInterceptorInstalled = true;

  function handleResponse(url, data) {
    const article = extractDedaoArticle(url, data);
    if (!article) return;
    try {
      chrome.runtime.sendMessage({ type: 'DEDAO_ARTICLE', article });
    } catch (_) {}
  }

  // Wrap fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isDedaoContentUrl(url)) {
        p.then(r => r.clone().json())
          .then(data => handleResponse(url, data))
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
      if (isDedaoContentUrl(this.__browsaUrl)) {
        this.addEventListener('load', function () {
          try { handleResponse(this.__browsaUrl, JSON.parse(this.responseText)); }
          catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isDedaoContentUrl,
    probeDedaoContent,
    extractDedaoArticle,
    installDedaoInterceptor
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installDedaoInterceptor();
}
