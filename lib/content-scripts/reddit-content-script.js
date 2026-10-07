// lib/content-scripts/reddit-content-script.js
//
// Reddit extraction — active fallback, SW-injectable (MAIN world).
//
// Reddit has no passive content-script interceptor in browsa: the site is a
// heavily componentized SPA whose feed/comments are rendered client-side from
// SSR state, and there is no simple XHR endpoint to hook (unlike the GraphQL
// call Twitter makes). Attaching a Reddit page therefore used to fall through
// to the generic DOM-tree dump, which for Reddit's div/web-component layout
// pulled in the whole chrome: skip links, vote/share/reward buttons, ads,
// footer links, stray "— Item N —" repeated-group markers, and even the
// raw `SML.load([...])` module-loader strings Reddit's comments leak into
// their <summary> text.
//
// This mirrors the active fallback pattern of activeXFetch /
// activeFetchBilibiliVideo / tryXhsExtraction: the service worker injects this
// script via chrome.scripting.executeScript({ world:'MAIN', func: () =>
// activeRedditFetch() }) and reads the result. It reads the post (+ comments)
// out of window.__INITIAL_STATE__ when present (Reddit embeds the SSR state
// the same way Bilibili/X/XHS do), falling back to the rendered DOM's stable
// shreddit-* web components, then to the generic <details>/<summary> comment
// structure that the DOM-tree dump shows.

// -- helpers (all self-contained; MAIN-world injection can't import) --------

function compress(s) {
  return (s || '')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Strip Reddit's `SML.load([...])` module-loader call that leaks into comment
// <summary> text, plus any other JSON-array / hash noise adjacent to it.
function stripSmlNoise(s) {
  return (s || '')
    .replace(/SML\.load\(\s*\[[^\]]*\]\s*\)\s*/g, '')
    .replace(/^\s*[\[\]"']+|[\[\]"']+\s*$/g, '')
    .trim();
}

// Reddit's web-component posts/comments carry author/score/time in attributes
// (e.g. <shreddit-comment author="..." score="...">). Read one via attributes
// with text fallbacks.
function attr(el, name) { return (el && el.getAttribute && el.getAttribute(name)) || ''; }

// -- INITIAL_STATE extraction -------------------------------------------------

// Reddit's SSR state shape is route-dependent and has changed over time; these
// probes walk a handful of known paths and return the first hit. Returns null
// if no recognizable post data is found.
function probePostsFromState(state) {
  if (!state) return null;
  // /r/{sub}/comments/{id} post pages (new UI): state.posts.posts keyed by id
  const postsMap = state?.posts?.posts;
  if (postsMap && typeof postsMap === 'object') {
    const ids = Object.keys(postsMap);
    if (ids.length) return { postsMap, ids };
  }
  // user profile pages: state.profiles / state.users
  const profMap = state?.profiles?.profiles || state?.users?.users;
  if (profMap && typeof profMap === 'object') {
    const ids = Object.keys(profMap);
    if (ids.length) return { postsMap: profMap, ids };
  }
  return null;
}

// Map a Reddit post (from INITIAL_STATE) to the compact shape the synthesizer
// expects.
function postFromState(p) {
  const post = p?.post || p;
  if (!post) return null;
  const title = compress(post.title);
  if (!title) return null;
  return {
    postId: String(post.id || post.name || ''),
    title,
    subreddit: compress(post.subreddit || post.subreddit_name_prefixed || ''),
    author: compress(post.author || ''),
    selftext: compress(post.selftext || post.body || ''),
    score: post.score || 0,
    upvoteRatio: post.upvote_ratio || 0,
    numComments: post.num_comments || post.numComments || 0,
    createdUtc: post.created_utc || post.created || 0,
    url: post.url || '',
    permalink: post.permalink || '',
  };
}

// Read the comment tree from INITIAL_STATE (posts[].comments / comments tree).
// Reddit's state nests comments under the post with {children:[...]} nodes; we
// flatten in depth-first order with a depth marker.
function commentsFromState(postData) {
  const out = [];
  const walk = (nodes, depth) => {
    for (const n of (nodes || [])) {
      const c = n?.data || n?.comment || n;
      if (!c || typeof c !== 'object') continue;
      const author = compress(c.author || '');
      const text = compress(stripSmlNoise(c.body || ''));
      if (author || text) {
        out.push({ author, score: c.score || 0, depth, text, createdUtc: c.created_utc || 0 });
      }
      walk(n?.children, depth + 1);
    }
  };
  walk(postData, 0);
  return out;
}

// -- DOM extraction -----------------------------------------------------------

// Reddit's new UI renders posts as <shreddit-post> web components and comments
// as <shreddit-comment>. Fall back to those when present.
function postFromDom(doc) {
  const el = doc?.querySelector('shreddit-post');
  if (el) {
    const title = compress(el.getAttribute('post-title') || el.querySelector('[slot="title"], [slot="post-title"]')?.textContent || '');
    if (title) {
      const bodyEl = el.querySelector('[slot="text-body"], [slot="post-body"], .md');
      return {
        postId: attr(el, 'id'),
        title,
        subreddit: compress(attr(el, 'subreddit') || attr(el, 'subreddit-prefixed-name') || ''),
        author: compress(attr(el, 'author') || ''),
        selftext: compress(bodyEl?.textContent || ''),
        score: parseInt(attr(el, 'score') || '0', 10) || 0,
        upvoteRatio: 0,
        numComments: parseInt(attr(el, 'comment-count') || '0', 10) || 0,
        createdUtc: parseInt(attr(el, 'created-timestamp') || '0', 10) || 0,
        url: '',
        permalink: '',
      };
    }
  }
  return null;
}

// Generic fallback: find the first <h1> (post title) on the page and the main
// content region. Used only when neither INITIAL_STATE nor shreddit-post exist.
function postFromGenericDom(doc) {
  const h1 = doc?.querySelector('h1');
  const title = h1 ? compress(h1.textContent) : '';
  if (!title) return null;
  // Walk up to a likely post container, then grab readable paragraphs.
  let container = h1.parentElement;
  let selftext = '';
  for (let i = 0; i < 4 && container; i++) {
    const p = compress(container.querySelector(':scope > div, :scope > article, :scope > section')?.textContent || '');
    if (p.length > selftext.length) selftext = p;
    container = container.parentElement;
  }
  // Strip the title itself from the body copy if it leaked in.
  selftext = compress(selftext.replace(title, ''));
  return {
    postId: '',
    title, subreddit: '', author: '', selftext,
    score: 0, upvoteRatio: 0, numComments: 0, createdUtc: 0, url: '', permalink: '',
  };
}

// Comments from the DOM: prefer shreddit-comment web components, else the
// <details>/<summary> collapsible structure the DOM-tree dump shows.
function commentsFromDom(doc) {
  const out = [];
  const seen = new Set();
  const shComs = doc?.querySelectorAll('shreddit-comment');
  if (shComs && shComs.length) {
    for (const c of shComs) {
      const author = compress(attr(c, 'author') || '');
      const score = parseInt(attr(c, 'score') || '0', 10) || 0;
      const depth = parseInt(attr(c, 'depth') || '0', 10) || 0;
      const bodyEl = c.querySelector('[slot="comment"], [slot="comment-body"], .md');
      const text = compress(stripSmlNoise(bodyEl?.textContent || ''));
      const key = author + '|' + text;
      if ((author || text) && !seen.has(key)) { seen.add(key); out.push({ author, score, depth, text, createdUtc: 0 }); }
    }
    return out;
  }
  // <details>/<summary> structure: summary holds "author • time SML.load([..])",
  // the comment body follows in a sibling / the details' text.
  const dets = doc?.querySelectorAll('details');
  if (dets) {
    for (const d of dets) {
      const sum = d.querySelector(':scope > summary');
      const sumText = compress(stripSmlNoise(sum?.textContent || ''));
      const author = compress((sumText.match(/^(.+?)\s*[•·]\s*\d/) || [])[1] || sumText);
      // The body is the details' text minus the summary text.
      let body = compress(d.textContent || '');
      if (sumText) body = compress(body.replace(sumText, ''));
      const key = sumText + '|' + body;
      if ((author || body) && !seen.has(key)) { seen.add(key); out.push({ author, score: 0, depth: 0, text: body, createdUtc: 0 }); }
    }
  }
  return out;
}

// -- main entry ---------------------------------------------------------------

// Returns a clean { post, comments } object, or null (caller falls through to
// the generic cascade) when nothing recognizable is found. Never throws.
// -- Public JSON API (2026-10-07, ported from EdgeEver's clipper) -----------
//
// Reddit serves each post's canonical data at /comments/{id}/.json — cleaner
// than either the route-dependent SSR state or the shreddit DOM attributes
// (which changed shape across redesigns). API-first, existing paths stay as
// fallbacks. limit=0 keeps the payload to the post + top-level comment stubs
// actually returned; deep threads cap below.

// Pure: image URLs from the post's gallery_data/media_metadata (multi-image
// galleries), url_overridden_by_dest (single image posts), or preview.source
// (linked-image fallback) — ported from EdgeEver's reddit clip (2026-10-07).
// media_metadata URLs are HTML-escaped (`&amp;`); only https redd.it /
// redditmedia.com hosts pass; capped at 4 (the tweet-photos budget).
function redditImagesFromJson(data) {
  const child = data?.[0]?.data?.children?.[0]?.data;
  if (!child || typeof child !== 'object') return [];
  const out = [];
  const add = (raw, alt = '') => {
    const url = String(raw || '').replace(/&amp;/g, '&').trim();
    if (!url) return;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/(^|\.)redd\.it$|(^|\.)redditmedia\.com$/.test(u.hostname)) return;
      if (out.length >= 4 || out.some((i) => i.url === u.href)) return;
      out.push({ url: u.href, alt: String(alt || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
    } catch (_) { /* not an URL — skip */ }
  };
  const gallery = child.gallery_data && typeof child.gallery_data === 'object' ? child.gallery_data : null;
  const metadata = child.media_metadata && typeof child.media_metadata === 'object' ? child.media_metadata : {};
  if (Array.isArray(gallery?.items)) {
    for (const item of gallery.items) {
      if (out.length >= 4) break;
      const mediaId = item && typeof item === 'object' ? item.media_id : '';
      const meta = mediaId && typeof metadata[mediaId] === 'object' ? metadata[mediaId] : null;
      const small = meta && typeof meta.s === 'object' ? meta.s : null;
      if (small && typeof small.u === 'string') add(small.u, item?.caption);
    }
  }
  if (out.length === 0) add(child.url_overridden_by_dest, child.title);
  if (out.length === 0) {
    const preview = child.preview && typeof child.preview === 'object' ? child.preview : null;
    const source = Array.isArray(preview?.images) ? preview.images[0]?.source : null;
    if (source && typeof source.url === 'string') add(source.url, child.title);
  }
  return out;
}

// Pure: the post object from /comments/{id}.json's [0].data.children[0].data.
// Same shape postFromState produces (+ images from the gallery/preview ladder).
function postFromRedditJson(data) {
  const child = data?.[0]?.data?.children?.[0]?.data;
  if (!child || typeof child !== 'object') return null;
  const p = postFromState(child);
  // Link posts have empty selftext — keep the destination URL so the model
  // knows the post points somewhere (postFromState already maps child.url).
  if (p) p.images = redditImagesFromJson(data);
  return p;
}

// Pure: flatten /comments/{id}.json's [1] comment forest into the
// commentsFromState shape ({author, score, depth, text, createdUtc}).
// `more` nodes are skipped (limit=0 already trims depth); depth/count capped.
function commentsFromRedditJson(data, { maxDepth = 8, maxCount = 200 } = {}) {
  const roots = data?.[1]?.data?.children;
  if (!Array.isArray(roots)) return [];
  const out = [];
  const walk = (children, depth) => {
    for (const n of children) {
      if (out.length >= maxCount || depth > maxDepth) return;
      if (n?.kind !== 't1' || !n.data || typeof n.data !== 'object') continue;
      const author = compress(n.data.author || '');
      const text = compress(stripSmlNoise(n.data.body || ''));
      if (author || text) {
        out.push({ author, score: n.data.score || 0, depth, text, createdUtc: n.data.created_utc || 0 });
      }
      const nested = n.data.replies?.data?.children;
      if (Array.isArray(nested)) walk(nested, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// Pure: the base36 post id a reddit comments URL points at.
function redditPostIdFromUrl(href) {
  if (typeof href !== 'string') return '';
  try {
    return new URL(href).pathname.match(/\/comments\/([a-z0-9]+)(?=\/|$)/i)?.[1]?.toLowerCase() || '';
  } catch (_) {
    return '';
  }
}

// Fetch image bytes in the page MAIN world (i.redd.it / preview.redd.it serve
// CORS '*') and canvas-compress to ≤1024px JPEG data URLs — the same budget
// and fail-open pattern as fetchTweetPhotosInPage in twitter-content-script.js
// (import-free worlds force the duplication). Up to 4 photos; an unusable
// environment (Node/jsdom tests, blocked CDN, no canvas) returns [] and the
// synthesizer falls back to [图N] URL lines.
async function fetchRedditImagesInPage(urls) {
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
    } catch (_) { /* next image */ }
  }
  return out;
}

async function activeRedditFetch() {
  try {
    const loc = (typeof window !== 'undefined' && window.location) || (typeof location !== 'undefined' ? location : null);
    const isReddit = /(^|\.)reddit\.com$/i.test(loc?.hostname || '');
    if (!isReddit) return null;

    // 0. Public JSON API first (canonical data, survives UI redesigns).
    const postId = redditPostIdFromUrl(loc?.href || '');
    if (postId && typeof fetch === 'function' && /^https?:/.test(loc?.protocol || '')) {
      try {
        const res = await fetch(`/comments/${postId}/.json?raw_json=1&limit=0`, {
          credentials: 'include',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          const post = postFromRedditJson(data);
          if (post) {
            return {
              post,
              comments: commentsFromRedditJson(data),
              imageBase64List: await fetchRedditImagesInPage((post.images || []).map((i) => i.url)),
              via: 'json-api',
            };
          }
        }
      } catch (_) { /* rate-limit / JSON disabled / offline — fall through */ }
    }

    let post = null;
    let comments = [];

    // 1. INITIAL_STATE (authoritative — has score/comment counts/author).
    try {
      const state = window.__INITIAL_STATE__;
      const probe = probePostsFromState(state);
      if (probe) {
        for (const id of probe.ids) {
          const p = postFromState(probe.postsMap[id]);
          if (p) {
            if (!post) post = p;
            // Comments: post.comments is the tree on post pages.
            const tree = probe.postsMap[id]?.comments || probe.postsMap[id]?.post?.comments;
            if (tree && !comments.length) comments = commentsFromState(tree);
          }
        }
      }
    } catch (_) {}

    // 2. DOM fallback (shreddit web components), used when state was absent.
    if (!post) {
      const doc = (typeof window !== 'undefined' && window.document) || (typeof document !== 'undefined' ? document : null);
      if (doc) {
        try { post = postFromDom(doc); } catch (_) {}
        if (!post) { try { post = postFromGenericDom(doc); } catch (_) {} }
        if (!comments.length) { try { comments = commentsFromDom(doc); } catch (_) {} }
      }
    }

    if (!post) return null;
    return { post, comments };
  } catch (_) {
    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    activeRedditFetch, postFromState, postFromDom, postFromGenericDom,
    commentsFromState, commentsFromDom, stripSmlNoise,
    postFromRedditJson, commentsFromRedditJson, redditPostIdFromUrl,
    redditImagesFromJson,
  };
}
