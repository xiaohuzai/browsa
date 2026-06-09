// lib/xhs-content-script.js
//
// Injected into xiaohongshu.com pages. Wraps fetch and XMLHttpRequest to
// observe the SPA's calls to /api/sns/web/v1/feed (the XHR that returns
// the actual note data — desc, imageList, interactInfo, etc.).
//
// We DO NOT modify the request, the response, or the timing. We call
// the original fetch / XHR, .clone() the response, parse the JSON, and
// forward it to the background script via chrome.runtime.sendMessage.
//
// Why this works: 小红书 signs its XHRs with x-s/x-s-common/x-t headers
// (per jackwener/xiaohongshu-cli). Reverse-engineering that signing
// function into the extension would be fragile and version-coupled. By
// intercepting the browser's OWN fetch, we get the correctly signed
// request, the right cookies, and the right Referer — all for free.
//
// We isolate the matching and dispatch logic into pure functions so
// the tests can run in Node without a real browser. The IIFE that
// wraps the actual side-effect code is what runs in the content world.

// Pure: does this URL look like a XHS note-detail feed XHR?
//   - path is /api/sns/web/v1/feed
//   - the SPA only ever hits this path with a JSON body, but we don't
//     need to inspect the body to decide to clone — we always clone and
//     let the receiver decide whether the payload is relevant.
function isXhsFeedUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.hostname !== 'edith.xiaohongshu.com') return false;
    if (u.pathname !== '/api/sns/web/v1/feed') return false;
    return true;
  } catch (_) {
    return false;
  }
}

// Pure: does the JSON payload look like a single-note feed response?
// We want `data.noteList[0]` to be a real note with title/desc.
function isNoteDetailPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.success !== true) return false;
  const list = payload.data && payload.data.noteList;
  if (!Array.isArray(list) || list.length === 0) return false;
  const note = list[0];
  if (!note || typeof note !== 'object') return false;
  if (typeof note.noteId !== 'string') return false;
  // desc OR title must be present and non-empty for this to be useful
  const hasTitle = typeof note.title === 'string' && note.title.length > 0;
  const hasDesc = typeof note.desc === 'string' && note.desc.length > 0;
  return hasTitle || hasDesc;
}

// Pure: extract what we need to forward to the background. We don't
// send the full payload — imageList URLs are CDN-signed and large,
// and the background only needs the textual fields. Image URLs come
// later via a separate pass if/when we add image support.
function extractNoteSummary(payload) {
  const note = payload.data.noteList[0];
  return {
    noteId: note.noteId,
    title: note.title || '',
    desc: note.desc || '',
    author: (note.user && note.user.nickname) || '',
    userId: (note.user && note.user.userId) || '',
    imageCount: Array.isArray(note.imageList) ? note.imageList.length : 0,
    tagList: Array.isArray(note.tagList) ? note.tagList.map((t) => t && t.name).filter(Boolean) : [],
    likedCount: (note.interactInfo && note.interactInfo.likedCount) || 0,
    commentCount: (note.interactInfo && note.interactInfo.commentCount) || 0,
    shareCount: (note.interactInfo && note.interactInfo.shareCount) || 0,
    collectedCount: (note.interactInfo && note.interactInfo.collectedCount) || 0,
    // rawAt lets the receiver de-dup stale XHRs if a fast-clicking user
    // triggers multiple fetches in quick succession. We trust the
    // browser's Date.now() rather than the wall clock.
    rawAt: Date.now()
  };
}

// Pure: is this XHR response something we should forward? Returns the
// note summary if yes, null if no. This is the dispatch gate that the
// IIFE uses.
function maybeExtract(url, payload) {
  if (!isXhsFeedUrl(url)) return null;
  if (!isNoteDetailPayload(payload)) return null;
  return extractNoteSummary(payload);
}

// ---- Side-effect code ------------------------------------------------------
// Everything above is pure and unit-tested. Everything below runs once
// per page-load in the page's MAIN world (well, isolated world — content
// scripts don't share the page's JS heap, but they share the DOM and
// can monkey-patch globals like fetch).
//
// IMPORTANT: This IIFE must NOT run when the file is `require()`d
// from Node (tests). Node has no `window`, so trying to access it
// throws. We guard on `typeof window !== 'undefined'` AND on the
// presence of `chrome` (content scripts always have it; Node never does).
function installInterceptor() {
  if (typeof window === 'undefined') { console.log('browsa[xhs-cs]: no window (Node?)'); return false; }
  if (typeof chrome === 'undefined' || !chrome.runtime) { console.log('browsa[xhs-cs]: no chrome.runtime (not extension?)'); return false; }
  if (window.__browsaXhsInterceptorInstalled) return true;
  window.__browsaXhsInterceptorInstalled = true;
  console.log('browsa[xhs-cs]: interceptor installed in ' + (typeof chrome !== 'undefined' && chrome.runtime ? 'extension' : 'unknown') + ' context (world: ' + (typeof window !== 'undefined' ? 'MAIN' : '?') + ')');

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  const NativeXHR = window.XMLHttpRequest;

  // wrap fetch — preserve its behavior, just observe /api/sns/web/v1/feed
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = nativeFetch(input, init);
      if (isXhsFeedUrl(url)) {
        // clone before awaiting so we don't disturb the original
        p.then((r) => r.clone().json().then((payload) => {
          const note = maybeExtract(url, payload);
          if (note) safeSend({ type: 'XHS_XHR_NOTE', note });
        }).catch(() => {})).catch(() => {});
      }
      return p;
    };
  }

  // wrap XHR — replace the prototype's open + send so we capture both
  // the URL (set in open) and the response (parsed in send's onload).
  // We don't touch readyState / status — just clone the response and
  // try to parse it.
  if (NativeXHR && NativeXHR.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function browsaOpen(method, url) {
      this.__browsaUrl = url;
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function browsaSend() {
      if (isXhsFeedUrl(this.__browsaUrl)) {
        this.addEventListener('load', function () {
          try {
            const payload = JSON.parse(this.responseText);
            const note = maybeExtract(this.__browsaUrl, payload);
            if (note) safeSend({ type: 'XHS_XHR_NOTE', note });
          } catch (_) { /* not JSON or not parseable — ignore */ }
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg);
      console.log('browsa[xhs-cs]: sent XHR noteId=' + (msg.note && msg.note.noteId));
    } catch (_) {
      console.warn('browsa[xhs-cs]: sendMessage failed (context invalidated?)', _);
    }
  }
  return true;
}

// Export the pure helpers for unit tests. Tests can also call
// installInterceptor() under jsdom to drive the install path. In a
// real content-script context, the IIFE at the bottom of this file
// runs installInterceptor() automatically.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isXhsFeedUrl,
    isNoteDetailPayload,
    extractNoteSummary,
    maybeExtract,
    installInterceptor
  };
}

// Auto-install in browser / extension content-script context.
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installInterceptor();
}
