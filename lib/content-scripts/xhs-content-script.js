// lib/content-scripts/xhs-content-script.js
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
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    if (u.hostname !== 'edith.xiaohongshu.com') return false;
    if (u.pathname !== '/api/sns/web/v1/feed') return false;
    return true;
  } catch (_) {
    return false;
  }
}

// Pure: does this URL look like a XHS comment list XHR?
//   /api/sns/web/v2/comment/page       — first-level comments
//   /api/sns/web/v2/comment/sub/page   — nested replies
function isXhsCommentUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    if (u.hostname !== 'edith.xiaohongshu.com') return false;
    return u.pathname === '/api/sns/web/v2/comment/page' ||
           u.pathname === '/api/sns/web/v2/comment/sub/page';
  } catch (_) {
    return false;
  }
}

// Pure: extract top-level comments from a comment page response.
// Returns an array of { author, text, likes } or null if not applicable.
function extractXhsComments(payload) {
  const list = payload?.data?.comments;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map(c => ({
    author: (c.user_info?.nickname || c.user_info?.userid || '').trim(),
    text: (c.content || '').trim(),
    likes: c.like_count || 0,
  })).filter(c => c.text.length > 0);
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

// Pure: per-image scene rank (ported from EdgeEver's clipper 2026-10-07).
// ORG (original) > DFT (WB_DFT watermark-free default) > other WB_* variants >
// the flat `url` (the page's rendered variant — NOT always the best) >
// unknown scenes > PRV/PREV/THUMB previews. Keep identical to the inline copy
// inside extractXiaohongshuInPageWorld (lib/xhs-extractor.js) — MAIN-world
// serialization forces the duplication (same reason as the grade helper there).
function xhsSceneRank(scene) {
  const v = String(scene || '').toUpperCase();
  if (v.includes('ORG')) return 0;
  if (v.includes('DFT')) return 1;
  if (v.includes('PRV') || v.includes('PREV') || v.includes('THUMB')) return 5;
  if (v.startsWith('WB_')) return 2;
  return 4;
}

// Pure: best candidate URL per image, by scene rank, with CDN-host/avatar/
// video filtering and cross-image dedup by hostname+pathname (the same photo
// may appear under several scene variants). fileId assembly stays as the
// last-resort fallback when no explicit candidate survives.
function pickXhsImageUrls(imageList, cap) {
  const out = [];
  const seen = new Set();
  const normalize = (raw) => {
    const v = String(raw || '').trim();
    if (!v || v.startsWith('data:') || v.startsWith('blob:')) return '';
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (u.protocol === 'http:') u.protocol = 'https:';
      const host = u.hostname.toLowerCase();
      const okHost = host === 'xhscdn.com' || host.endsWith('.xhscdn.com')
        || host === 'xhscdn.net' || host.endsWith('.xhscdn.net')
        || host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com');
      if (!okHost) return '';
      if (u.pathname.toLowerCase().includes('avatar')) return '';
      if (/\.(mp4|mov|m3u8)$/i.test(u.pathname)) return '';
      return u.toString();
    } catch (_) { return ''; }
  };
  const dedupeKey = (value) => {
    try {
      const u = new URL(value);
      return `${u.hostname.toLowerCase()}${u.pathname.replace(/![^/]*$/, '').toLowerCase()}`;
    } catch (_) { return value; }
  };
  for (const img of (Array.isArray(imageList) ? imageList : [])) {
    if (out.length >= cap) break;
    if (!img || typeof img !== 'object') continue;
    const ranked = [];
    if (Array.isArray(img.infoList)) {
      for (const info of img.infoList) {
        if (info?.url) ranked.push({ rank: xhsSceneRank(info.imageScene), url: info.url });
      }
    }
    if (img.urlDefault) ranked.push({ rank: 1, url: img.urlDefault });
    if (img.url) ranked.push({ rank: 3, url: img.url });
    if (img.urlPre) ranked.push({ rank: 5, url: img.urlPre });
    ranked.sort((a, b) => a.rank - b.rank);
    let picked = '';
    for (const item of ranked) {
      const normalized = normalize(item.url);
      if (!normalized) continue;
      const key = dedupeKey(normalized);
      if (seen.has(key)) break; // this photo already came in under an earlier image entry
      picked = normalized;
      seen.add(key);
      break;
    }
    if (!picked && img.fileId) {
      const assembled = normalize(`https://sns-webpic-qc.xhscdn.com/${img.fileId}`);
      if (assembled && !seen.has(dedupeKey(assembled))) {
        picked = assembled;
        seen.add(dedupeKey(assembled));
      }
    }
    if (picked) out.push(picked);
  }
  return out;
}

// Pure: extract what we need to forward to the background. We don't
// send the full payload — image URLs are CDN-signed, so we forward only
// the per-image best-scene candidate URLs (capped); the background fetches
// the actual bytes in the page MAIN world at attach time (auto cookies +
// Referer there), feeding ctx.imageBase64List → message-builder's
// vision-part interleave.
function extractNoteSummary(payload) {
  const note = payload.data.noteList[0];
  const imageUrls = pickXhsImageUrls(note.imageList, 8);
  return {
    noteId: note.noteId,
    title: note.title || '',
    desc: note.desc || '',
    author: (note.user && note.user.nickname) || '',
    userId: (note.user && note.user.userId) || '',
    imageCount: Array.isArray(note.imageList) ? note.imageList.length : 0,
    imageUrls,
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
// MAIN world has no chrome.runtime — pushes go out via the ISOLATED-world
// relay (lib/content-scripts/site-relay.js, injected on this same site):
// it forwards window messages to chrome.runtime.sendMessage, feeding the
// background SITE_MESSAGE_MAP / XHS_XHR_NOTE receiver. (Restored 2026-10-01;
// this channel had been silently dead since the v0.19.1 MAIN-world move.)
function relayToHost(msg) {
  try { window.postMessage({ __browsaRelay: true, message: msg }, window.location.origin); } catch (_) {}
}

function installInterceptor() {
  if (typeof window === 'undefined') { console.log('browsa[xhs-cs]: no window (Node?)'); return false; }
  if (window.__browsaXhsInterceptorInstalled) return true;
  window.__browsaXhsInterceptorInstalled = true;
  console.log('browsa[xhs-cs]: interceptor installed (MAIN world; pushes relay via site-relay)');

  // Current note summary — kept in sync so that comment batches can be
  // merged into it and re-sent as an enriched XHS_XHR_NOTE message.
  let currentNote = null;

  function safeSend(msg) {
    try {
      relayToHost(msg);
      console.log('browsa[xhs-cs]: sent XHR noteId=' + (msg.note && msg.note.noteId));
    } catch (_) {
      console.warn('browsa[xhs-cs]: sendMessage failed (context invalidated?)', _);
    }
  }

  function handleFeedPayload(url, payload) {
    const note = maybeExtract(url, payload);
    if (!note) return;
    // New note navigated — reset comment accumulator.
    if (!currentNote || currentNote.noteId !== note.noteId) {
      currentNote = note;
    }
    safeSend({ type: 'XHS_XHR_NOTE', note: currentNote });
  }

  function handleCommentPayload(payload) {
    const comments = extractXhsComments(payload);
    if (!comments || !currentNote) return;
    // Merge into existing comment list (multiple pages may arrive).
    const existing = currentNote.comments || [];
    const merged = existing.concat(comments).slice(0, 50); // cap at 50
    currentNote = Object.assign({}, currentNote, { comments: merged });
    safeSend({ type: 'XHS_XHR_NOTE', note: currentNote });
  }

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  const NativeXHR = window.XMLHttpRequest;

  // wrap fetch — preserve its behavior, observe feed + comment endpoints
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = nativeFetch(input, init);
      if (isXhsFeedUrl(url)) {
        p.then((r) => r.clone().json().then((payload) => {
          handleFeedPayload(url, payload);
        }).catch(() => {})).catch(() => {});
      } else if (isXhsCommentUrl(url)) {
        p.then((r) => r.clone().json().then((payload) => {
          handleCommentPayload(payload);
        }).catch(() => {})).catch(() => {});
      }
      return p;
    };
  }

  // wrap XHR — replace the prototype's open + send so we capture both
  // the URL (set in open) and the response (parsed in send's onload).
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
          try { handleFeedPayload(this.__browsaUrl, JSON.parse(this.responseText)); }
          catch (_) {}
        });
      } else if (isXhsCommentUrl(this.__browsaUrl)) {
        this.addEventListener('load', function () {
          try { handleCommentPayload(JSON.parse(this.responseText)); }
          catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
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
    isXhsCommentUrl,
    isNoteDetailPayload,
    extractNoteSummary,
    extractXhsComments,
    maybeExtract,
    installInterceptor
  };
}

// Auto-install in browser / extension content-script context.
if (typeof window !== 'undefined') {
  installInterceptor();
}
