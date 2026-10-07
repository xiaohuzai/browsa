// lib/content-scripts/twitter-content-script.js
//
// Injected into twitter.com / x.com pages at document_start (MAIN world).
// Intercepts GraphQL API calls for individual tweet detail pages.
//
// Twitter uses GraphQL with rotating operation hashes in the path:
//   https://twitter.com/i/api/graphql/{HASH}/TweetDetail
//   https://twitter.com/i/api/graphql/{HASH}/TweetResultByRestId
//
// The hash changes with each deploy but the operation name suffix is stable.
// We match on the pathname pattern rather than the exact hash.

function isTwitterTweetUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return (u.hostname === 'twitter.com' || u.hostname === 'x.com') &&
      u.pathname.includes('/graphql/') &&
      (u.pathname.endsWith('/TweetDetail') || u.pathname.endsWith('/TweetResultByRestId'));
  } catch (_) { return false; }
}

// Navigate Twitter GraphQL response structure to find a single tweet.
// Pure: photo URLs from a legacy tweet entity's media lists (extendedEntities
// is the fuller one; entities.media mirrors it when present), in order, capped
// at 4. Videos/GIFs are skipped — only type "photo".
function tweetPhotosFromLegacy(legacy) {
  const media = legacy?.extendedEntities?.media || legacy?.entities?.media || [];
  const out = [];
  for (const m of media) {
    if (m?.type !== 'photo') continue;
    const url = (m.media_url_https || m.media_url || '').trim();
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= 4) break;
  }
  return out;
}

// Pure: upgrade a rendered tweet-photo URL from the placeholder size the DOM
// serves (name=small / :small ≈ 240px) to medium (≈680px) — enough detail for
// a 1024px-capped canvas compression without pulling the XXL originals.
function upgradeTweetPhotoUrl(src) {
  const s = String(src || '');
  if (!s) return '';
  if (/(?:\?|&)name=small/.test(s)) return s.replace(/name=small/, 'name=medium');
  if (/:small$/.test(s)) return s.replace(/:small$/, '?name=medium');
  return s;
}

function extractTweetFromResult(result) {
  if (!result) return null;
  // Unwrap typename wrappers
  const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  const legacy = tweet?.legacy;
  if (!legacy?.id_str) return null;
  const user = tweet?.core?.user_results?.result?.legacy;
  // Long tweets (>280 chars) live in note_tweet — legacy.full_text only has a
  // truncated rendering ending in an ellipsis + t.co "show more" link.
  const noteText = (tweet?.note_tweet?.note_tweet_results?.result?.text || '').trim();
  return {
    tweetId: legacy.id_str,
    text: (noteText || legacy.full_text || legacy.text || '').trim(),
    author: (user?.name || '').trim(),
    screenName: (user?.screen_name || '').trim(),
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    quotes: legacy.quote_count || 0,
    lang: legacy.lang || '',
    createdAt: legacy.created_at || '',
    photos: tweetPhotosFromLegacy(legacy),
    rawAt: Date.now()
  };
}

function extractTwitterTweet(data) {
  try {
    // TweetResultByRestId
    const byId = data?.data?.tweetResult?.result;
    if (byId) return extractTweetFromResult(byId);

    // TweetDetail: conversation thread — take the first tweet in the first entry
    const instructions =
      data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
      if (inst.type !== 'TimelineAddEntries') continue;
      for (const entry of (inst.entries || [])) {
        const itemContent = entry?.content?.itemContent;
        if (itemContent?.itemType === 'TimelineTweet') {
          const result = itemContent?.tweet_results?.result;
          if (result) return extractTweetFromResult(result);
        }
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

// MAIN world has no chrome.runtime — pushes go out via the ISOLATED-world
// relay (lib/content-scripts/site-relay.js, injected on this same site):
// it forwards window messages to chrome.runtime.sendMessage, feeding the
// background SITE_MESSAGE_MAP / XHS_XHR_NOTE receiver. (Restored 2026-10-01;
// this channel had been silently dead since the v0.19.1 MAIN-world move.)
function relayToHost(msg) {
  try { window.postMessage({ __browsaRelay: true, message: msg }, window.location.origin); } catch (_) {}
}

function installTwitterInterceptor() {
  if (typeof window === 'undefined') return false;
  if (window.__browsaTwitterInterceptorInstalled) return true;
  window.__browsaTwitterInterceptorInstalled = true;

  function safeSend(tweet) {
    try { relayToHost({ type: 'TWITTER_TWEET', tweet }); } catch (_) {}
  }

  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isTwitterTweetUrl(url)) {
        p.then(r => r.clone().json())
          .then(data => { const t = extractTwitterTweet(data); if (t) safeSend(t); })
          .catch(() => {});
      }
      return p;
    };
  }

  // XHR fallback
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function() {
      if (isTwitterTweetUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try {
            const t = extractTwitterTweet(JSON.parse(this.responseText));
            if (t) safeSend(t);
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
    isTwitterTweetUrl, extractTweetFromResult, extractTwitterTweet,
    installTwitterInterceptor, activeXFetch, extractTweetFromDom, extractTweetsFromInitState,
    tweetPhotosFromLegacy, upgradeTweetPhotoUrl, quotedTweetFromArticle,
  };
}

if (typeof window !== 'undefined') {
  installTwitterInterceptor();
}

// ---------------------------------------------------------------------------
// Active extraction (SW-injectable, MAIN world).
//
// The passive installTwitterInterceptor above only runs when chrome.runtime
// is defined — and in a MAIN-world content script it is NOT (same lesson as
// YouTube: installYouTubeInterceptor() must not guard on chrome.runtime). So
// SITE_CACHES.twitter is effectively never populated by the passive path, and
// a tweet page otherwise falls through to the generic DOM-tree dump (which
// for X's div-based layout includes all the nav/trending/sidebar chrome).
//
// This is the active fallback that actually works, mirroring the exact
// pattern of activeYouTubeFetch / activeFetchBilibiliVideo / XHS's
// tryXhsExtraction: the service worker injects this script via
// chrome.scripting.executeScript({ world: 'MAIN', func: () => activeXFetch() })
// and reads the result. Reads the current tweet (+ its visible replies) out of
// window.__INITIAL_STATE__ (X embeds the conversation in the SSR state, same
// idea as Bilibili/XHS), falling back to the rendered DOM's stable data-testid
// attributes if the state object is absent/stale.

// Map a tweet in INITIAL_STATE's entities.tweets to the compact shape the
// synthesizer expects.
function tweetFromInitState(t, users) {
  if (!t || !t.id_str) return null;
  const u = users?.[t.user_id_str];
  const legacy = t; // entities.tweets entries are already legacy-shaped
  return {
    tweetId: legacy.id_str,
    text: (legacy.full_text || legacy.text || '').trim(),
    author: (u?.name || '').trim(),
    screenName: (u?.screen_name || '').trim(),
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    quotes: legacy.quote_count || 0,
    lang: legacy.lang || '',
    createdAt: legacy.created_at || '',
    photos: tweetPhotosFromLegacy(legacy),
    // INITIAL_STATE entries keyed by tweet id, plus the user's avatar/handle
    userId: legacy.user_id_str || '',
  };
}

// Read every tweet currently rendered in the DOM using X's stable
// data-testid attributes. Returns an array of tweet-shaped objects in DOM
// order (the conversation's visible order).
// Extract the quoted-tweet card embedded in a tweet article: the tweetText
// sitting inside the article's own `[role="link"]` quote card (EdgeEver's
// main/quote discrimination — the main text is the tweetText NOT inside a
// role=link). Quote-posts otherwise attach as a bare t.co link with the
// quoted content lost. Defensive throughout: mock articles in tests (and any
// DOM drift) degrade to `quoted: null`.
function quotedTweetFromArticle(el) {
  if (typeof el.querySelectorAll !== 'function') return null;
  try {
    const quotedNode = [...el.querySelectorAll('[data-testid="tweetText"]')]
      .find((n) => typeof n.closest === 'function' && n.closest('[role="link"]'));
    if (!quotedNode) return null;
    const text = (quotedNode.textContent || '').trim();
    if (!text) return null;
    const card = quotedNode.closest('[role="link"]');
    const line = (card?.querySelector?.('[data-testid="User-Name"]')?.textContent || '').trim();
    const m = line.match(/^([^\n]+)\n@([A-Za-z0-9_]+)/);
    return { author: m?.[1]?.trim() || '', screenName: m?.[2] || '', text };
  } catch (_) {
    return null;
  }
}

function extractTweetFromDom(root = document) {
  const out = [];
  const seen = new Set();
  try {
    const els = root.querySelectorAll('[data-testid="tweet"]');
    for (const el of els) {
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const userEl = el.querySelector('[data-testid="User-Name"]');
      const text = (textEl?.textContent || '').trim();
      const authorLine = (userEl?.textContent || '').trim();
      // "Alice\n@alice" or "Alice\n@alice\n·\n2h"
      const m = authorLine.match(/^([^\n]+)\n@([A-Za-z0-9_]+)/);
      const key = text + '|' + authorLine;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const timeEl = el.querySelector('time');
      // The <time> sits inside the article's own permalink — anchors a DOM
      // tweet to its status id so activeXFetch can match it against the main
      // tweet (the first article on a self-thread page is the PARENT, not
      // the tweet the URL points at).
      const statusHref = (typeof timeEl?.closest === 'function' && timeEl.closest('a')?.getAttribute('href')) || '';
      // Rendered photos (placeholder-size URLs; upgradeTweetPhotoUrl fixes them).
      const photos = [];
      if (typeof el.querySelectorAll === 'function') {
        for (const img of el.querySelectorAll('img[data-testid="tweetPhoto"]')) {
          const src = upgradeTweetPhotoUrl(img.currentSrc || img.getAttribute?.('src') || '');
          if (/pbs\.twimg\.com\/media/.test(src) && !photos.includes(src)) photos.push(src);
          if (photos.length >= 4) break;
        }
      }
      out.push({
        tweetId: '',
        text,
        author: m?.[1]?.trim() || '',
        screenName: m?.[2] || '',
        likes: 0, retweets: 0, replies: 0, quotes: 0,
        lang: '',
        createdAt: timeEl?.getAttribute?.('datetime') || '',
        photos,
        statusHref,
        quoted: quotedTweetFromArticle(el),
        userId: '',
      });
    }
  } catch (_) {}
  return out;
}

// Main entry: extract the current tweet conversation from the page.
// Returns null (caller falls through to the generic cascade) when neither
// INITIAL_STATE nor the DOM yields anything — never throws.
async function activeXFetch() {
  try {
    // Use window.location, not bare `location` — the Node test harness sets
    // globalThis.window.location, not the bare global, and in the browser
    // MAIN world they're the same object.
    const loc = (typeof window !== 'undefined' && window.location) || (typeof location !== 'undefined' ? location : null);
    const statusId = (String(loc?.pathname || '').match(/\/status\/(\d+)/) || [])[1];
    const tweets = [];
    let main = null;

    // 1. Prefer INITIAL_STATE (authoritative, has engagement counts).
    try {
      const entities = window.__INITIAL_STATE__?.entities;
      const tMap = entities?.tweets || {};
      const uMap = entities?.users || {};
      const ids = Object.keys(tMap);
      if (ids.length) {
        // The main tweet is the one matching the URL status id, else the
        // first (most-recently-loaded) one.
        const ordered = statusId && tMap[statusId]
          ? [tMap[statusId], ...ids.filter((i) => i !== statusId).map((i) => tMap[i])]
          : ids.map((i) => tMap[i]);
        for (const t of ordered) {
          const tw = tweetFromInitState(t, uMap);
          if (tw) {
            if (statusId && t.id_str === statusId && !main) main = tw;
            tweets.push(tw);
          }
        }
      }
    } catch (_) {}

    // 2. DOM fallback: conversation rendered in the timeline. Prefer it when
    // INITIAL_STATE was empty; also used to fill replies the state object
    // didn't carry (e.g. an expanded thread).
    const domTweets = extractTweetFromDom((typeof window !== 'undefined' && window.document) || (typeof document !== 'undefined' ? document : null));
    if (!tweets.length && domTweets.length) {
      for (const t of domTweets) tweets.push(t);
    }
    // If the state had the main tweet but no visible replies, and the DOM
    // shows more tweets than the state did, merge the extras in order.
    else if (domTweets.length > tweets.length) {
      for (const t of domTweets) {
        if (!tweets.some((x) => x.text === t.text && x.author === t.author)) tweets.push(t);
      }
    }

    if (!main && tweets.length) main = tweets[0];
    if (!main) return null;

    // Long tweets: the rendered tweetText carries the FULL text even when the
    // state/GraphQL entity only has the truncated legacy rendering (note_tweet
    // bodies). Adopt the DOM text for the main tweet when it is longer —
    // matched via the article's own permalink so a self-thread parent above
    // the main tweet can't pose as it.
    const mainStatusId = main.tweetId || statusId || '';
    const domMain = mainStatusId
      ? domTweets.find((t) => (t.statusHref || '').replace(/^.*\/status\//, '/status/').endsWith('/status/' + mainStatusId))
      : null;
    if (domMain) {
      if (domMain.text.length > main.text.length) main = Object.assign({}, main, { text: domMain.text });
      if ((!Array.isArray(main.photos) || main.photos.length === 0) && domMain.photos?.length) {
        main = Object.assign({}, main, { photos: domMain.photos });
      }
      if (domMain.quoted) main = Object.assign({}, main, { quoted: domMain.quoted });
    }

    // Replies = everything after the main tweet, in order.
    const replies = tweets.filter((t) => t !== main);
    return {
      tweetId: main.tweetId,
      text: main.text,
      author: main.author,
      screenName: main.screenName,
      likes: main.likes,
      retweets: main.retweets,
      repliesCount: main.replies,
      quotes: main.quotes,
      lang: main.lang,
      createdAt: main.createdAt,
      photos: Array.isArray(main.photos) ? main.photos : [],
      imageBase64List: await fetchTweetPhotosInPage(main.photos),
      quoted: main.quoted || null,
      replies: replies.map((r) => ({ text: r.text, author: r.author, screenName: r.screenName, likes: r.likes, retweets: r.retweets, createdAt: r.createdAt })),
    };
  } catch (_) {
    return null;
  }
}

// Fetch photo bytes in the page MAIN world (pbs.twimg.com serves CORS '*', so
// a plain page fetch works — no DNR/header recipe needed, same tier as the
// XHS image fetcher) and canvas-compress to ≤1024px JPEG data URLs. Up to 4
// photos. Fail-open everywhere: an unusable environment (Node/jsdom tests,
// blocked CDN, no canvas) returns [] and the attach stays text+URL-only.
async function fetchTweetPhotosInPage(urls) {
  const out = [];
  const list = Array.isArray(urls) ? urls : [];
  if (!list.length) return out;
  if (typeof fetch !== 'function' || typeof Image === 'undefined' || typeof document === 'undefined') return out;
  for (const url of list.slice(0, 4)) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const b64 = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            let w = img.width, h = img.height;
            const maxDim = 1024;
            if (w > maxDim || h > maxDim) {
              const ratio = Math.min(maxDim / w, maxDim / h);
              w = Math.round(w * ratio); h = Math.round(h * ratio);
            }
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            if (!ctx) { resolve(null); return; }
            ctx.drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', 0.85));
          } catch (_) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = URL.createObjectURL(blob);
      });
      if (b64) out.push(b64);
    } catch (_) { /* next photo */ }
  }
  return out;
}

// Export both helper names for direct unit testing (the Node test harness
// cannot run chrome.scripting.executeScript, so it tests these pure-ish
// extraction helpers directly with a mocked window).
function extractTweetsFromInitState(state) {
  const entities = state?.entities;
  const tMap = entities?.tweets || {};
  const uMap = entities?.users || {};
  const out = [];
  for (const id of Object.keys(tMap)) {
    const tw = tweetFromInitState(tMap[id], uMap);
    if (tw) out.push(tw);
  }
  return out;
}
