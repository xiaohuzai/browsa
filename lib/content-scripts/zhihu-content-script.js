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

function installZhihuInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
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
      chrome.runtime.sendMessage({ type: 'ZHIHU_CONTENT', content: extracted });
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isZhihuArticleUrl,
    isZhihuAnswersUrl,
    extractZhihuArticle,
    extractZhihuAnswers,
    installZhihuInterceptor
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installZhihuInterceptor();
}
