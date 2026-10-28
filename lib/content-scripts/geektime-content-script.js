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

// htmlToArticleText（含首图属性挑选 pageImgUrl）收编在 site-common.js——与
// zhihu 是同一份实现，曾以字节孪生各存一份（2026-10-15 姊妹批：course
// figures 走 protocol-relative URL，由 lib/page-images.js 对页面基座解析）。
// MAIN world 由 manifest 先注的 site-common 挂 window 全局；Node 测试走
// CommonJS require 拿同一份实现。
const siteCommon = (typeof window !== 'undefined' && window.__browsaHtmlToArticleText)
  ? { htmlToArticleText: window.__browsaHtmlToArticleText, pageImgUrl: window.__browsaPageImgUrl }
  : require('./site-common.js');

function htmlToArticleText(html) {
  return siteCommon.htmlToArticleText(html, siteCommon.pageImgUrl);
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

// MAIN world has no chrome.runtime — pushes go out via the ISOLATED-world
// relay (lib/content-scripts/site-relay.js, injected on this same site):
// it forwards window messages to chrome.runtime.sendMessage, feeding the
// background SITE_MESSAGE_MAP / XHS_XHR_NOTE receiver. (Restored 2026-10-01;
// this channel had been silently dead since the v0.19.1 MAIN-world move.)
// The postMessage wire shape lives in lib/content-scripts/site-common.js,
// injected as the first MAIN-world script for every site (manifest ordering is
// asserted in test/site-content-scripts.test.mjs). Resolved lazily so this
// file still loads under Node for the pure-function tests.
// The forwarder is installed by site-common.js (first in this script's
// manifest entry). If that ever fails to load, this wrapper used to throw a
// TypeError into each caller's fail-open catch — the site's whole data
// channel went dark with NO diagnostic (exactly the v0.19.1 failure mode).
// Warn once per page instead, and keep the callers' fail-open contract.
function relayToHost(msg) {
  const forward = window.__browsaRelayToHost;
  if (typeof forward !== 'function') {
    if (!window.__browsaRelayMissing) {
      window.__browsaRelayMissing = true;
      console.warn('browsa: site-common.js did not load before this site script — page data cannot reach the panel');
    }
    return;
  }
  return forward(msg);
}

function installGeektimeInterceptor() {
  if (typeof window === 'undefined') return false;
  if (window.__browsaGeektimeInterceptorInstalled) return true;
  window.__browsaGeektimeInterceptorInstalled = true;

  function safeSend(article) {
    try {
      relayToHost({ type: 'GEEKTIME_ARTICLE', article });
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
            const a = maybeExtractGeektime(url, data, htmlToArticleText);
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
            const a = maybeExtractGeektime(this.__browsaUrl, data, htmlToArticleText);
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
    htmlToArticleText,
    extractGeektimeArticle,
    maybeExtractGeektime,
    installGeektimeInterceptor
  };
}

if (typeof window !== 'undefined') {
  installGeektimeInterceptor();
}
