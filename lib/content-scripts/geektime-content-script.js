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

// Pure: strip HTML to plain text, but keep article figures in place as
// markdown image syntax (`![alt](url)`). Plain textContent stripping here was
// the 2026-10-15 sibling-audit finding (same shape as the zhihu regression):
// geektime article_content HTML carries course figures
// (`//static001.geekbang.org/...`, protocol-relative — resolved against the
// page base by lib/page-images.js) that died with the tags. Self-contained
// copy: content scripts are MAIN world and cannot import ES modules.
const GEEKTIME_BLOCK_RE = /^(P|DIV|FIGURE|BLOCKQUOTE|LI|UL|OL|TABLE|TR|PRE|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER)$/;

function geektimeImgUrl(img) {
  for (const attr of ['data-actualsrc', 'data-original', 'src']) {
    const v = (typeof img.getAttribute === 'function' && img.getAttribute(attr)) || '';
    if (v && !/^(data:|blob:)/i.test(v)) return v;
  }
  return '';
}

function htmlToArticleText(html) {
  if (typeof document === 'undefined') return '';
  const div = document.createElement('div');
  div.innerHTML = html || '';
  const out = [];
  const mdAlt = (s) => String(s || '').replace(/[[\]()\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.push(child.textContent || ''); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      if (tag === 'IMG' || tag === 'PICTURE') {
        const img = tag === 'IMG' ? child : child.querySelector('img');
        const url = img ? geektimeImgUrl(img) : '';
        if (url) out.push(`\n\n![${mdAlt(img.getAttribute('alt'))}](${url})\n\n`);
        continue;
      }
      if (tag === 'BR') { out.push('\n'); continue; }
      walk(child);
      if (GEEKTIME_BLOCK_RE.test(tag)) out.push('\n\n');
    }
  };
  walk(div);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
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
function relayToHost(msg) {
  try { window.postMessage({ __browsaRelay: true, message: msg }, window.location.origin); } catch (_) {}
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
