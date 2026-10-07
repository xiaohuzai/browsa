// lib/content-scripts/zhihu-content-script.js
//
// Injected into zhihu.com and zhuanlan.zhihu.com pages. Intercepts two
// API endpoints:
//
//   GET /api/v4/articles/{id}          — 专栏文章 (zhuanlan.zhihu.com/p/xxx)
//   GET /api/v4/questions/{id}/answers — Q&A 页最高赞回答 (zhihu.com/question/xxx)
//
// Both return HTML in their content fields. We strip it to plain text in
// the page world (MAIN) using a temporary DOM element — cheap and reliable,
// no regex hacks.

// Pure: strip HTML to plain text using a temporary element.
// Must only be called in a browser context (not Node/tests).
function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

// Pure URL matchers
function isZhihuArticleUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'www.zhihu.com' &&
           /^\/api\/v4\/articles\/\d+/.test(u.pathname);
  } catch (_) { return false; }
}

function isZhihuAnswersUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'www.zhihu.com' &&
           /^\/api\/v4\/questions\/\d+\/answers/.test(u.pathname);
  } catch (_) { return false; }
}

// Pure extractors (htmlToText injected so they're testable without a DOM)
function extractZhihuArticle(data, toText) {
  if (!data?.id || !data?.title) return null;
  return {
    type: 'article',
    id: String(data.id),
    title: (data.title || '').trim(),
    text: toText(data.content || ''),
    author: (data.author?.name || '').trim(),
    voteupCount: data.voteup_count || 0,
    commentCount: data.comment_count || 0,
    rawAt: Date.now()
  };
}

function extractZhihuAnswers(data, toText) {
  const answers = data?.data;
  if (!Array.isArray(answers) || answers.length === 0) return null;
  // Question title lives on the first answer's .question object
  const questionTitle = (answers[0]?.question?.title || '').trim();
  const questionId = String(answers[0]?.question?.id || '');
  const top = answers.slice(0, 10).map(a => ({
    id: String(a.id),
    text: toText(a.content || ''),
    author: (a.author?.name || '').trim(),
    voteupCount: a.voteup_count || 0
  })).filter(a => a.text.length > 0);
  if (top.length === 0) return null;
  return {
    type: 'question',
    id: questionId,
    title: questionTitle,
    text: '',                   // assembled later in synthesizer
    author: '',
    voteupCount: 0,
    commentCount: 0,
    answers: top,
    rawAt: Date.now()
  };
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

function installZhihuInterceptor() {
  if (typeof window === 'undefined') return false;
  if (window.__browsaZhihuInterceptorInstalled) return true;
  window.__browsaZhihuInterceptorInstalled = true;

  const toText = htmlToText; // closure over DOM helper

  function handleResponse(url, data) {
    let extracted = null;
    if (isZhihuArticleUrl(url)) {
      extracted = extractZhihuArticle(data, toText);
    } else if (isZhihuAnswersUrl(url)) {
      extracted = extractZhihuAnswers(data, toText);
    }
    if (!extracted) return;
    try {
      relayToHost({ type: 'ZHIHU_CONTENT', content: extracted });
    } catch (_) {}
  }

  function shouldIntercept(url) {
    return isZhihuArticleUrl(url) || isZhihuAnswersUrl(url);
  }

  // Wrap fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (shouldIntercept(url)) {
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
      if (shouldIntercept(this.__browsaUrl)) {
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

// ---- Active fallback (SW-injectable, MAIN world) ---------------------------
//
// Single-answer pages (/question/N/answer/M, /answer/M) and zhuanlan articles
// are server-rendered: the SPA often fires no XHR the interceptor above could
// catch, and the rendered DOM collapses long answers behind 展开阅读全文 —
// generic Readability then attaches a truncated body. Fetch the item's own API
// in the page MAIN world instead (signed-in session, same-origin), the same
// on-demand-injection pattern as activeXFetch / activeFetchBilibiliVideo.
// Question pages WITHOUT a specific answer stay on the passive path (the
// top-answers list XHR), which gives more than one answer.

// Pure: which zhihu item does this page URL name? article (zhuanlan /p/N) or
// single answer (question/N/answer/M, bare /answer/M). Returns null for
// question pages without an answer id — nothing for the active path to fetch.
function zhihuTargetFromUrl(href) {
  if (typeof href !== 'string' || !href) return null;
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (host === 'zhuanlan.zhihu.com' || host === 'www.zhuanlan.zhihu.com') {
      const m = u.pathname.match(/^\/p\/(\d+)(?=\/|$)/);
      return m ? { kind: 'article', id: m[1] } : null;
    }
    if (host !== 'zhihu.com' && host !== 'www.zhihu.com') return null;
    const ans = u.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)(?=\/|$)/);
    if (ans) return { kind: 'answer', id: ans[2], questionId: ans[1] };
    const bare = u.pathname.match(/^\/answer\/(\d+)(?=\/|$)/);
    if (bare) return { kind: 'answer', id: bare[1] };
    return null;
  } catch (_) { return null; }
}

async function activeZhihuFetch() {
  try {
    const target = zhihuTargetFromUrl(window.location?.href || '');
    if (!target) return null;
    const res = target.kind === 'article'
      ? await fetch(`https://zhuanlan.zhihu.com/api/articles/${target.id}`, { credentials: 'include', headers: { accept: 'application/json' } })
      : await fetch(`/api/v4/answers/${target.id}?include=content,author.name,question.title,question.id,voteup_count,comment_count,content_need_truncated`, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (target.kind === 'article') {
      if (!data?.id || !data?.title) return null;
      return {
        type: 'article',
        id: String(data.id),
        title: (data.title || '').trim(),
        text: htmlToText(data.content || ''),
        author: (data.author?.name || '').trim(),
        voteupCount: data.voteupCount || 0,
        commentCount: data.commentsCount || 0,
        rawAt: Date.now()
      };
    }
    const q = data?.question || {};
    if (!data?.id || !q?.title) return null;
    return {
      type: 'answer',
      id: String(data.id),
      // Synthesizer input shape: the question is the heading, the answer body
      // is the text — a direct answer page has no other title to offer.
      title: (q.title || '').trim(),
      text: htmlToText(data.content || ''),
      author: (data.author?.name || '').trim(),
      voteupCount: data.voteup_count || 0,
      commentCount: data.comment_count || 0,
      questionId: String(q.id || target.questionId || ''),
      rawAt: Date.now()
    };
  } catch (_) {
    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isZhihuArticleUrl,
    isZhihuAnswersUrl,
    extractZhihuArticle,
    extractZhihuAnswers,
    installZhihuInterceptor,
    zhihuTargetFromUrl,
    activeZhihuFetch
  };
}

if (typeof window !== 'undefined') {
  installZhihuInterceptor();
}
