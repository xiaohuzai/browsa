// lib/page-extractor.js
import { PAGE_CONTEXT_PREFIX } from './constants.js';
// Extracts page context from the active tab. The user can choose the mode:
//   - 'reader'   : Mozilla Readability extracts the main article content (recommended)
//   - 'full'     : dump of <body> innerText (no HTML tags, but no semantic filtering)
//   - 'selected' : only the user's text selection
//   - 'screenshot' : PNG of the visible tab (multimodal)
//
// Readability is the same algorithm Firefox Reader View uses; LLMFeeder (a
// similar extension) uses it. We bundle Readability.js as a single 90KB file
// and load it via chrome.scripting.executeScript in the page's MAIN world so
// the algorithm has access to a real `document`.
//
// Why "reader" by default?
//   - innerText still includes nav, ads, related-article widgets, comments
//   - Readability picks the highest-text-density subtree (the article) and
//     returns clean textContent, typically 5-20K chars for an article that
//     would be 100-300K of outerHTML
//   - No need for arbitrary character caps — the input is already small

// Run in the page's MAIN world. The Readability constructor expects a
// Document, so we operate on document.cloneNode(true) to keep the page's
// original DOM intact (Readability mutates).
//
// Turndown is also injected into the page world so it can use the real
// browser DOMParser / document.implementation to parse the article HTML.
//
// Pipeline:
//   1. Clone document, strip obvious noise
//   2. Readability → { title, byline, content (HTML), textContent }
//   3. Inline image URLs into textContent (so Markdown preserves them)
//   4. Turndown(content) → clean Markdown
//   5. Return { markdown, textContent, imageCount, ... }
function extractInPageWorld({ mode, htmlCap }) {
  if (typeof Readability === 'undefined') {
    return { error: 'Readability not loaded in page world' };
  }
  if (typeof TurndownService === 'undefined') {
    return { error: 'Turndown not loaded in page world' };
  }

  // 1) selection is mode-independent
  const sel = window.getSelection ? String(window.getSelection() || '') : '';

  if (mode === 'selected') {
    return { selection: sel };
  }

  // 2) Mark CSS-hidden elements on the LIVE document before cloning --
  //    getComputedStyle needs rendering info a detached clone doesn't have.
  //    NOISE_SELECTORS below only catches [hidden]/[aria-hidden="true"]
  //    attributes; this catches the stylesheet-driven equivalents
  //    (display:none, visibility:hidden, opacity:0, font-size:0, or
  //    zero-dimension boxes) that a page can use to hide boilerplate --
  //    or an actual prompt-injection payload -- from a human reader while
  //    still feeding it to an LLM. Same threat model as the <template>/
  //    comment stripping below, just a CSS-based blind spot. Only checked
  //    on elements that actually carry text, to bound cost and avoid
  //    false-positives on empty containers awaiting JS hydration.
  const HIDDEN_MARK = 'data-browsa-hidden';
  const markedEls = [];
  try {
    const candidates = document.body ? document.body.querySelectorAll('*') : [];
    candidates.forEach((el) => {
      if (!el.textContent || !el.textContent.trim()) return;
      const cs = window.getComputedStyle(el);
      if (!cs) return;
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' ||
        parseFloat(cs.opacity) === 0 || parseFloat(cs.fontSize) === 0 ||
        (el.offsetWidth === 0 && el.offsetHeight === 0);
      if (hidden) {
        el.setAttribute(HIDDEN_MARK, '1');
        markedEls.push(el);
      }
    });
  } catch (_) {
    // ignore
  }

  // 3) clone document so Readability's mutations don't affect the live page
  //    (the HIDDEN_MARK attributes set above carry over onto the clone)
  const docClone = document.cloneNode(true);

  // Un-mark the live document immediately -- the clone already has its own
  // copies of the attribute, so the live page must not be left mutated.
  try {
    markedEls.forEach((el) => el.removeAttribute(HIDDEN_MARK));
  } catch (_) {
    // ignore
  }

  // 4) pre-strip obvious noise. This is the recipe recommended in Mozilla's
  //    Readability docs: remove elements Readability can't classify.
  const NOISE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'canvas', 'video',
    'header', 'footer', 'nav', 'aside',
    '.ad, .ads, .advert, .advertisement',
    '.cookie, .cookie-banner, #cookie, #cookie-banner',
    '.share, .social, .social-share',
    '.comments, #comments, .comment-section',
    '.related, .recommended, .suggestions',
    '.sidebar, .widget',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-hidden="true"]', '[hidden]',
    `[${HIDDEN_MARK}]`
  ];
  try {
    docClone.querySelectorAll(NOISE_SELECTORS.join(',')).forEach((el) => el.remove());
  } catch (_) {
    // ignore selector errors
  }

  // Prompt-injection defensive pass: <template> content isn't live DOM but
  // its raw markup can still bias Readability's scoring, and HTML comments
  // occasionally carry hidden instructions meant for an LLM reading the page
  // (rather than a human viewing it). Both are safe to strip on this clone.
  try {
    docClone.querySelectorAll('template').forEach((el) => el.remove());
    const commentWalker = docClone.createTreeWalker(docClone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
    comments.forEach((c) => c.remove());
  } catch (_) {
    // ignore
  }

  let article = null;
  try {
    const reader = new Readability(docClone, {
      charThreshold: 500,    // Readability default; nav/footer stripping is done above
      keepClasses: false,
      debug: false
    });
    article = reader.parse();
  } catch (e) {
    return { error: 'Readability parse failed: ' + e.message };
  }

  if (!article || !article.textContent) {
    return { error: 'Readability returned no content (page may not be article-like)' };
  }

  // 4) Turndown handles <img> natively (turns into ![](url) Markdown), so we
  //    don't need to inject image URLs ourselves. We do count images so the
  //    UI can warn the user when the page is heavy on figures.
  const imageCount = countImages(article.content);

  // 5) Turndown: HTML → Markdown
  let markdown;
  try {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    markdown = td.turndown(article.content);
    console.log('browsa: turndown output length', markdown.length, 'chars (from', article.content.length, 'bytes HTML)');
  } catch (e) {
    console.warn('browsa: turndown failed, falling back to textContent', e);
    markdown = article.textContent.trim();
  }

  // 6) Strip zero-width/control characters the page may carry to hide
  //    prompt-injection text from a human reader while still reaching the
  //    LLM (concept ported from Scrapling's AI-facing sanitization pass;
  //    logic mirrors lib/dom-similarity.js's cleanText, duplicated here
  //    since MAIN-world injected functions can't import that module).
  markdown = markdown
    .replace(new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "")
    .replace(new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g"), "");

  // 7) Apply the hard cap. Markdown is denser than HTML, so 1M chars is
  //    well past the practical limit for any modern LLM.
  const wasCapped = markdown.length > htmlCap;
  const finalText = wasCapped
    ? markdown.slice(0, htmlCap) + `\n\n[... truncated at ${htmlCap} chars ...]`
    : markdown;

  return {
    text: finalText,
    textContent: article.textContent.trim(),
    format: 'markdown',
    rawTextLength: markdown.length,
    wasCapped,
    articleTitle: article.title || '',
    articleExcerpt: article.excerpt || '',
    articleByline: article.byline || '',
    articleSiteName: article.siteName || '',
    imageCount,
    selection: sel,
    limitHint: markdown.length > 300_000
      ? `⚠ Page content is large (~${Math.round(markdown.length/1000)}K chars). The LLM may not see everything. Use Selection mode.`
      : null
  };
}

function countImages(contentHtml) {
  if (!contentHtml) return 0;
  try {
    const doc = new DOMParser().parseFromString(contentHtml, 'text/html');
    return doc.querySelectorAll('figure img').length;
  } catch (_) {
    return 0;
  }
}

// Xiaohongshu (小红书) note detail extractor.
//
// We try two independent sources, in order of preference:
//
//   1. window.__INITIAL_STATE__.note.noteDetailMap[noteId].note
//      The XHR response that populates the detail page is also kept on
//      window.__INITIAL_STATE__. This is the SAME data that ends up in
//      #detail-title / #detail-desc, but it's available the instant the
//      XHR resolves — no waiting for React to re-render. It's also
//      richer (imageList, interactInfo, tagList, etc.).
//
//   2. DOM scrape of #detail-title / #detail-desc
//      These React-emotion-hashed IDs are the same ones XHS-Downloader's
//      Tampermonkey script targets. Verified working on real pages via
//      console probe (e.g. /explore/6a141d03000000003502b14f returns
//      title="创业早期最大的幻觉之一" and a full desc with hashtags).
//
// We prefer source 1 (more data, no DOM race), but fall back to 2 for
// any reason (state missing, noteId not in map, etc.) and ultimately to
// 3 (returning an error so the caller can fall back to Readability).
//
// We do NOT call any XHR — that would require a logged-in cookie
// round-trip and break the "read DOM only" invariant.
async function extractXiaohongshuInPageWorld() {
  const noteId = (location.pathname.match(/\/explore\/([a-f0-9]+)/) || [])[1];

  // Inline grade helper. executeScript serializes ONLY this function
  // body; module-scope gradeXiaohongshuResult is invisible. The logic
  // is identical — just duplicated for serialization safety.
  function grade({ desc, title, imageCount }) {
    const dl = (desc || '').length, tl = (title || '').length, r = [];
    if (tl === 0) r.push('title empty');
    if (dl < 20) r.push(`desc too short (${dl} chars)`);
    if (imageCount === 0 && dl < 30) r.push('no images, near-empty desc');
    return { xhsDegraded: r.length > 0, xhsDegradeReasons: r, xhsDescLen: dl };
  }

  // helpers for fetching XHS images and converting to base64 data URLs.
  // All run in MAIN world so the browser auto-attaches correct cookies + Referer.
  async function fetchImageBase64(url) {
    try {
      const resp = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await blobToBase64(blob, 1024);
    } catch (_) { return null; }
  }

  function blobToBase64(blob, maxDim) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(blob);
    });
  }

  // --- Source 1: INITIAL_STATE ---------------------------------------------
  if (noteId) {
    try {
      const note = window.__INITIAL_STATE__?.note?.noteDetailMap?.[noteId]?.note;
      if (note && (note.title || note.desc)) {
        const title = (note.title || '').trim();
        const desc = (note.desc || '').trim();
        const tags = (note.tagList || [])
          .map((t) => (t?.name || '').trim())
          .filter(Boolean)
          .map((t) => (t.startsWith('#') ? t : `#${t}`));
        const imageCount = Array.isArray(note.imageList) ? note.imageList.length : 0;
        const likedCount = note.interactInfo?.likedCount;
        const commentCount = note.interactInfo?.commentCount;
        const author = (note.user?.nickname || '').trim();

        // Fetch images IN MAIN WORLD (auto cookies + Referer) — up to 5.
        // Try multiple URL patterns per image: some are flat `url`, others
        // nested under `infoList[0].url`, and a few need `fileId` assembly.
        const rawImages = note.imageList || [];
        const imageUrls = [];
        for (const img of rawImages.slice(0, 8)) {
          const u = img?.url
            || (img?.infoList && img?.infoList[0]?.url)
            || (img?.fileId ? `https://sns-webpic-qc.xhscdn.com/${img.fileId}` : null);
          if (u) imageUrls.push(u);
        }
        const imageBase64List = [];
        const failedUrls = [];
        for (const url of imageUrls.slice(0, 5)) {
          const b64 = await fetchImageBase64(url);
          if (b64) {
            imageBase64List.push(b64);
          } else {
            failedUrls.push(url);
          }
        }
        if (failedUrls.length > 0) {
          console.log(`browsa[xhs]: fetched ${imageBase64List.length}/${imageUrls.slice(0, 5).length} images, failed: ${failedUrls.map((u) => u.slice(0, 80)).join(', ')}`);
        }

        const parts = [];
        if (author) parts.push(`**作者**: ${author}`);
        if (title) parts.push(`# ${title}`);
        if (desc) parts.push(desc);
        if (tags.length) parts.push('Tags: ' + tags.join(' '));
        const meta = [];
        if (typeof likedCount === 'number') meta.push(`👍 ${likedCount}`);
        if (typeof commentCount === 'number') meta.push(`💬 ${commentCount}`);
        if (imageCount) meta.push(`🖼 ${imageCount} 图`);
        if (meta.length) parts.push(meta.join('  ·  '));
        const text = parts.join('\n\n');

        return {
          text,
          articleTitle: title,
          articleByline: author,
          imageCount,
          imageBase64List,
          rawTextLength: text.length,
          wasCapped: false,
          source: 'xiaohongshu',
          xhsSubSource: 'initial-state',
          xhsNoteId: noteId,
          ...grade({ desc, title, imageCount })
        };
      }
    } catch (_) {
      // fall through to DOM scrape
    }
  }

  // --- Source 2: DOM scrape ------------------------------------------------
  const titleEl = document.querySelector('#detail-title');
  const descEl = document.querySelector('#detail-desc');

  const title = (titleEl?.textContent || '').trim();
  const desc = (descEl?.textContent || '').trim();

  if (!title && !desc) {
    return { error: 'xhs anchors not found (#detail-title / #detail-desc missing) and INITIAL_STATE empty' };
  }

  // Optional: collect top-level comment previews from the comment list.
  // We try the common container first, then fall back gracefully.
  const commentEls = document.querySelectorAll(
    '.comment-item .content, .comments-content .content, [class*="comment"] [class*="content"]'
  );
  const commentSnippets = [];
  commentEls.forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t && t.length < 500 && commentSnippets.length < 5) {
      commentSnippets.push(t);
    }
  });

  // Tag chips (e.g. #自驾转具身)
  const tagEls = document.querySelectorAll('a.tag, [class*="tag"]');
  const tags = [];
  tagEls.forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t && t.length < 30 && tags.length < 10) tags.push(t);
  });

  // Image count — count <img> inside the swiper/carousel container.
  const imageEls = document.querySelectorAll(
    '.note-image, .swiper-slide img, [class*="media"] img'
  );
  const imageCount = imageEls.length;

  const parts = [];
  if (title) parts.push(`# ${title}`);
  if (desc) parts.push(desc);
  if (tags.length) parts.push('\nTags: ' + tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' '));
  if (commentSnippets.length) {
    parts.push('\n## Top comments');
    commentSnippets.forEach((c, i) => parts.push(`${i + 1}. ${c}`));
  }
  const text = parts.join('\n\n');

  return {
    text,
    articleTitle: title,
    articleByline: '',
    imageCount,
    rawTextLength: text.length,
    wasCapped: false,
    source: 'xiaohongshu',
    xhsSubSource: 'dom',
    xhsNoteId: noteId,
    ...grade({ desc, title, imageCount, source: 'dom' })
  };
}

// Heuristic "is this XHS extraction result trustworthy?" check.
//
// 小红书's anti-scraping stack (signed x-s headers, login-state
// required for full desc, xsec_token expiry) means we frequently
// receive a "skeleton" or a different note's data and present it as
// if it's the requested one. We can't fix that from the DOM alone,
// but we CAN flag the result so the side panel can warn the user.
//
// Signals we treat as "degraded":
//   - desc < 20 chars (real Xiaohongshu notes almost always have > 20)
//   - title is empty (we have nothing to anchor the result to)
//   - 0 images AND < 30 chars of desc (notes with no images AND no
//     body are vanishingly rare)
//
// The caller surfaces this via a yellow banner in the side panel,
// so the user knows "this is likely not the full note."
function gradeXiaohongshuResult({ desc, title, imageCount, source }) {
  const descLen = (desc || '').length;
  const titleLen = (title || '').length;
  const reasons = [];
  if (titleLen === 0) reasons.push('title empty');
  if (descLen < 20) reasons.push(`desc too short (${descLen} chars)`);
  if (imageCount === 0 && descLen < 30) reasons.push('no images, near-empty desc');
  const degraded = reasons.length > 0;
  return {
    xhsDegraded: degraded,
    xhsDegradeReasons: reasons,
    xhsDescLen: descLen
  };
}

// Build a complete extraction result from a XHR-intercepted 小红书
// note. The content script in lib/content-scripts/xhs-content-script.js calls this
// data with full desc/imageList/interactInfo — far more reliable
// than scraping the rendered DOM, which on 小红书 can be a skeleton
// or a different note entirely (see jackwener/OpenCLI#994).
//
// The shape mirrors what extractActiveTab returns for the DOM-based
// path, so downstream consumers (the LLM, the diagnostic banner)
// can stay agnostic about which source delivered the data.
function synthesizeXhsResultFromXhr(note) {
  const desc = (note.desc || '').trim();
  const title = (note.title || '').trim();
  const imageCount = note.imageCount || 0;
  const tags = (note.tagList || []).map((t) => (t ? '#' + t.replace(/^#/, '') : '')).filter(Boolean);
  const parts = [];
  if (note.author) parts.push(`**作者**: ${note.author}`);
  if (title) parts.push(`# ${title}`);
  if (desc) parts.push(desc);
  if (tags.length) parts.push('Tags: ' + tags.join(' '));
  const meta = [];
  if (note.likedCount) meta.push(`👍 ${note.likedCount}`);
  if (note.commentCount) meta.push(`💬 ${note.commentCount}`);
  if (note.shareCount) meta.push(`🔁 ${note.shareCount}`);
  if (note.collectedCount) meta.push(`⭐ ${note.collectedCount}`);
  if (imageCount) meta.push(`🖼 ${imageCount} 图`);
  if (meta.length) parts.push(meta.join('  ·  '));
  // Append intercepted comments if available (capped at 50 by content script).
  if (Array.isArray(note.comments) && note.comments.length > 0) {
    const commentLines = note.comments.map(
      (c, i) => `${i + 1}. **${c.author}**${c.likes ? ` (👍${c.likes})` : ''}: ${c.text}`
    );
    parts.push(`## 评论\n\n${commentLines.join('\n')}`);
  }
  const text = parts.join('\n\n');

  return {
    text,
    articleTitle: title,
    articleByline: note.author || '',
    imageCount,
    rawTextLength: text.length,
    wasCapped: false,
    source: 'xiaohongshu',
    xhsSource: true,
    xhsSubSource: 'xhr-intercepted',
    xhsNoteId: note.noteId,
    xhsDegraded: false, // by construction — we have the XHR data
    xhsDegradeReasons: [],
    xhsDescLen: desc.length,
    truncated: {
      rawTextLength: text.length,
      textLength: text.length,
      wasCapped: false,
      textCap: 0
    },
    fallback: false
  };
}

// DOM tree extraction mode: produces a structured, indexed summary of the
// page's visible DOM — better than "full" for SPA/app pages where Readability
// returns nothing useful (dashboards, github, figma, etc.).
//
// Output format (LLM-friendly):
//   # Heading text           ← h1-h6 as markdown headers
//   Paragraph text…          ← p / li / td text nodes
//   [0]<a> Link label → /path  ← interactive elements with numeric index
//   [1]<button> Submit
//
// Interactive elements are indexed so the user can refer to them by number.
// Container elements (div, section…) are traversed without emitting a line.
function extractDomTreeInPageWorld({ htmlCap }) {
  const sel = window.getSelection ? String(window.getSelection() || '') : '';

  const SKIP = new Set(['script','style','noscript','head','meta','link',
    'svg','path','defs','symbol','use','g','circle','rect','polygon',
    'canvas','video','audio','iframe','template','slot','picture']);
  const HEADINGS = new Set(['h1','h2','h3','h4','h5','h6']);
  const INTERACTIVE = new Set(['a','button','input','select','textarea','summary']);
  const TEXTBLOCK = new Set(['p','li','td','th','dt','dd','caption','blockquote',
    'pre','figcaption','label','time']);

  let idx = 0;
  const lines = [];

  function isHidden(el) {
    try {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return true;
    } catch (_) {}
    return el.hidden === true;
  }

  function compress(text) {
    // Also strips zero-width/control chars a page may use to hide
    // prompt-injection text from a human reader (see extractInPageWorld's
    // matching pass; lib/dom-similarity.js's cleanText is the tested source
    // of truth for this logic, duplicated here since MAIN-world injected
    // functions can't import that module).
    return (text || '')
      .replace(new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "")
      .replace(new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g"), "")
      .replace(/\s+/g, ' ').trim();
  }

  function shortText(el, max) {
    const t = compress(el.textContent);
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  function getLabel(el) {
    return compress(
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      el.textContent || el.tagName
    ).slice(0, 120);
  }

  // Repeated-structure detection: a lightweight heuristic (tag + primary
  // class token) to spot sibling elements that are "the same kind of thing
  // repeated" — product cards, comment rows, search results. Without this,
  // walk()'s per-tag line emission scatters a single item's title/price/link
  // across separate lines with nothing tying them together, and the LLM
  // can't tell where one item ends and the next begins. Concept: give each
  // detected item a numbered boundary marker so its fields stay grouped.
  function fingerprint(el) {
    const cls = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/)[0] || ''
      : '';
    return el.tagName.toLowerCase() + '|' + cls;
  }

  /** Returns the dominant group of >=3 structurally-similar children, or null. */
  function findRepeatedGroup(children) {
    const groups = new Map();
    for (const child of children) {
      const fp = fingerprint(child);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(child);
    }
    let dominant = null;
    for (const grp of groups.values()) {
      if (grp.length >= 3 && (!dominant || grp.length > dominant.length)) dominant = grp;
    }
    // Require the dominant group to make up most of this container's visible
    // children — otherwise a handful of similarly-tagged nav buttons among
    // mostly-unrelated content would get spuriously numbered.
    if (dominant && dominant.length >= 3 && dominant.length >= children.length * 0.6) {
      return dominant;
    }
    return null;
  }

  function walk(el, depth) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (isHidden(el)) return;

    const indent = '  '.repeat(Math.min(depth, 6));

    if (HEADINGS.has(tag)) {
      const t = shortText(el, 150);
      if (t) lines.push(`${indent}${'#'.repeat(parseInt(tag[1]))} ${t}`);
      return;
    }

    if (INTERACTIVE.has(tag)) {
      const label = getLabel(el);
      let extra = '';
      if (tag === 'a') {
        const href = (el.getAttribute('href') || '').slice(0, 80);
        if (href && !href.startsWith('#')) extra = ` → ${href}`;
      } else if (tag === 'input') {
        const type = el.getAttribute('type') || 'text';
        const val = el.value ? ` value="${el.value.slice(0,40)}"` : '';
        extra = ` [${type}${val}]`;
      } else if (tag === 'select') {
        const chosen = el.options[el.selectedIndex]?.text || '';
        if (chosen) extra = ` [selected: ${chosen}]`;
      }
      lines.push(`${indent}[${idx}]<${tag}> ${label}${extra}`);
      idx++;
      return;
    }

    if (TEXTBLOCK.has(tag)) {
      const t = shortText(el, 300);
      if (t.length > 3) lines.push(`${indent}${t}`);
      return;
    }

    // Container — check for a repeated-structure list among children first,
    // so each item's fields (title/price/link, etc.) stay visibly grouped
    // under a numbered boundary instead of interleaving across siblings.
    const visibleChildren = Array.from(el.children).filter(
      (c) => !isHidden(c) && !SKIP.has(c.tagName.toLowerCase())
    );
    const repeatedGroup = visibleChildren.length >= 3 ? findRepeatedGroup(visibleChildren) : null;

    if (repeatedGroup) {
      let itemNum = 0;
      for (const child of el.children) {
        if (repeatedGroup.includes(child)) {
          itemNum++;
          lines.push(`${indent}— Item ${itemNum} —`);
        }
        walk(child, depth + 1);
      }
      return;
    }

    // Plain container — recurse into children
    for (const child of el.children) {
      walk(child, depth + 1);
    }
  }

  walk(document.body, 0);

  // Deduplicate adjacent identical lines and remove blanks
  const deduped = lines.filter((l, i) => l.trim() && l !== lines[i - 1]);
  const raw = deduped.join('\n');
  const wasCapped = raw.length > htmlCap;
  const text = wasCapped
    ? raw.slice(0, htmlCap) + `\n\n[... truncated at ${htmlCap} chars ...]`
    : raw;

  return {
    text,
    rawTextLength: raw.length,
    wasCapped,
    selection: sel,
    format: 'dom-tree'
  };
}

// Same as above but for the "full" (non-Readability) fallback mode.
// Uses textContent (catches CSS-hidden text) + innerText as fallback.
function extractFullInPageWorld({ htmlCap }) {
  const sel = window.getSelection ? String(window.getSelection() || '') : '';
  // textContent includes all text nodes (even display:none); innerText respects CSS.
  // Some sites (小红书) hide content with CSS — textContent catches it.
  let raw = (document.body?.textContent || document.body?.innerText || '').trim();
  // If still empty, try walking all text nodes directly (bypasses Shadow DOM limits)
  if (!raw) {
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent?.trim();
      if (t && t.length > 20) parts.push(t);
    }
    raw = parts.join('\n\n');
  }
  // Strip zero-width/control chars a page may use to hide prompt-injection
  // text from a human reader (same logic as extractInPageWorld/compress()).
  raw = raw
    .replace(new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "")
    .replace(new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g"), "");
  const wasCapped = raw.length > htmlCap;
  const text = wasCapped ? raw.slice(0, htmlCap) + `\n\n[... truncated at ${htmlCap} chars ...]` : raw;
  return { text, rawTextLength: raw.length, wasCapped, selection: sel };
}

/**
 * Public API: extract page context. The caller (background.js) injects the
 * Readability library source first, then calls us.
 *
 * @param {Object} opts
 * @param {string} opts.mode       'reader' | 'full' | 'selected' | 'screenshot'
 * @param {number} opts.maxTextChars  hard cap on returned text
 * @returns {Promise<{text, imageDataUrl?, meta, mode, fallback?, truncated?}>}
 */
// ---------------------------------------------------------------------------
// Site-specific synthesis functions — turn cached XHR data into the same
// shape that Readability/DOM extraction returns, so downstream code is agnostic.
// ---------------------------------------------------------------------------

function synthesizeYouTubeResult(data, meta) {
  const duration = data.lengthSeconds > 0
    ? `${Math.floor(data.lengthSeconds / 60)}:${String(data.lengthSeconds % 60).padStart(2, '0')}`
    : '';
  const parts = [];
  if (data.author) parts.push(`**Channel**: ${data.author}${data.subsText ? ` (${data.subsText})` : ''}`);
  if (data.title) parts.push(`# ${data.title}`);

  const stats = [];
  if (data.viewsText)   stats.push(data.viewsText);
  if (data.likesText)   stats.push(`👍 ${data.likesText}`);
  if (duration)         stats.push(`时长 ${duration}`);
  if (data.publishDate) stats.push(data.publishDate);
  if (data.category)    stats.push(data.category);
  if (stats.length) parts.push(stats.join(' | '));

  if (data.shortDescription) parts.push(`**Description**: ${data.shortDescription}`);
  if (Array.isArray(data.keywords) && data.keywords.length > 0) {
    parts.push(`**Tags**: ${data.keywords.join(', ')}`);
  }
  if (Array.isArray(data.chapters) && data.chapters.length > 1) {
    parts.push(`## Chapters\n\n${data.chapters.join('\n')}`);
  }
  if (data.transcript) {
    parts.push(`## Transcript\n\n${data.transcript}`);
  } else {
    parts.push('*(No captions available for this video)*');
  }
  const text = parts.join('\n\n');
  return {
    meta, mode: 'youtube', text,
    articleTitle: data.title || '',
    articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false }
  };
}

function synthesizeJuejinResult(data, meta) {
  const parts = [];
  if (data.author)         parts.push(`**作者**: ${data.author}`);
  if (data.title)          parts.push(`# ${data.title}`);
  if (data.markContent)    parts.push(data.markContent);
  if (data.tags?.length)   parts.push('Tags: ' + data.tags.map(t => '#' + t).join(' '));
  const stats = [];
  if (data.viewCount)    stats.push(`👁 ${data.viewCount}`);
  if (data.diggCount)    stats.push(`👍 ${data.diggCount}`);
  if (data.commentCount) stats.push(`💬 ${data.commentCount}`);
  if (stats.length) parts.push(stats.join('  ·  '));
  const text = parts.join('\n\n');
  return { meta, mode: 'juejin', text, articleTitle: data.title || '', articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeZhihuResult(data, meta) {
  const parts = [];
  if (data.author) parts.push(`**作者**: ${data.author}`);
  if (data.title)  parts.push(`# ${data.title}`);
  if (data.text)   parts.push(data.text);
  const stats = [];
  if (data.voteupCount)  stats.push(`👍 ${data.voteupCount}`);
  if (data.commentCount) stats.push(`💬 ${data.commentCount}`);
  if (stats.length) parts.push(stats.join('  ·  '));
  // Q&A: append top answers
  if (data.type === 'question' && data.answers?.length) {
    parts.push('\n## 高赞回答');
    for (const ans of data.answers.slice(0, 3)) {
      parts.push(`### ${ans.author}（👍 ${ans.voteupCount}）\n\n${ans.text}`);
    }
  }
  const text = parts.join('\n\n');
  return { meta, mode: 'zhihu', text, articleTitle: data.title || '', articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeDedaoResult(data, meta) {
  const parts = [];
  if (data.author)  parts.push(`**作者**: ${data.author}`);
  if (data.title)   parts.push(`# ${data.title}`);
  if (data.content) parts.push(data.content);
  const text = parts.join('\n\n');
  return { meta, mode: 'dedao', text, articleTitle: data.title || '', articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeGeektimeResult(data, meta) {
  const parts = [];
  if (data.author)  parts.push(`**作者**: ${data.author}`);
  if (data.title)   parts.push(`# ${data.title}`);
  if (data.summary) parts.push(`> ${data.summary}`);
  if (data.text)    parts.push(data.text);
  const text = parts.join('\n\n');
  return { meta, mode: 'geektime', text, articleTitle: data.title || '', articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeBilibiliResult(data, meta) {
  const parts = [];
  if (data.author) parts.push(`**UP主**: ${data.author}`);
  if (data.title)  parts.push(`# ${data.title}`);
  if (data.tname)  parts.push(`**分区**: ${data.tname}`);
  if (data.desc)   parts.push(data.desc);
  const duration = data.duration > 0
    ? `${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, '0')}`
    : '';
  const stats = [];
  if (data.stat?.view)     stats.push(`${data.stat.view.toLocaleString()} 播放`);
  if (data.stat?.like)     stats.push(`${data.stat.like.toLocaleString()} 点赞`);
  if (data.stat?.coin)     stats.push(`${data.stat.coin.toLocaleString()} 投币`);
  if (data.stat?.favorite) stats.push(`${data.stat.favorite.toLocaleString()} 收藏`);
  if (duration)            stats.push(`时长 ${duration}`);
  if (stats.length) parts.push(stats.join(' | '));
  if (data.summary) parts.push(`## B站AI总结\n\n${data.summary}`);
  if (data.transcript) {
    parts.push(`## 字幕\n\n${data.transcript}`);
  } else if (data.audioUrl) {
    parts.push(
      `## 音频\n\n此视频暂无字幕。音频流 URL（时效链接，需及时使用；下载时携带 \`Referer: https://www.bilibili.com\`）：\n\n${data.audioUrl}`
    );
  }
  const text = parts.join('\n\n');
  return { meta, mode: 'bilibili', text, articleTitle: data.title || '', articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeXueqiuResult(data, meta) {
  const parts = [];
  if (data.type === 'stock') {
    parts.push(`# ${data.name} (${data.symbol})`);
    if (data.exchange) parts.push(`**交易所**: ${data.exchange}`);
    const priceStats = [];
    if (data.current !== undefined) priceStats.push(`现价: ${data.current}`);
    if (data.percent !== undefined) priceStats.push(`涨跌幅: ${(+data.percent).toFixed(2)}%`);
    if (data.open !== undefined)    priceStats.push(`开盘: ${data.open}`);
    if (data.high !== undefined)    priceStats.push(`最高: ${data.high}`);
    if (data.low !== undefined)     priceStats.push(`最低: ${data.low}`);
    if (data.pe !== undefined && data.pe !== null) priceStats.push(`PE(TTM): ${(+data.pe).toFixed(2)}`);
    if (priceStats.length) parts.push(priceStats.join(' | '));
    if (data.marketCapital) parts.push(`**总市值**: ${(data.marketCapital / 1e8).toFixed(2)} 亿`);
    if (data.orgName) parts.push(data.orgName);
  } else if (data.type === 'post') {
    if (data.author) parts.push(`**作者**: ${data.author}`);
    if (data.title)  parts.push(`# ${data.title}`);
    if (data.text)   parts.push(data.text);
    const stats = [];
    if (data.likes)    stats.push(`${data.likes} 点赞`);
    if (data.comments) stats.push(`${data.comments} 评论`);
    if (stats.length) parts.push(stats.join(' | '));
  }
  const text = parts.join('\n\n');
  return { meta, mode: 'xueqiu', text, articleTitle: data.name || data.title || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeTwitterResult(data, meta) {
  const parts = [];
  const author = [data.author, data.screenName ? `@${data.screenName}` : ''].filter(Boolean).join(' ');
  if (author) parts.push(`**作者**: ${author}`);
  if (data.text) parts.push(data.text);
  const stats = [];
  if (data.likes)    stats.push(`${data.likes} 喜欢`);
  if (data.retweets) stats.push(`${data.retweets} 转推`);
  if (data.replies)  stats.push(`${data.replies} 回复`);
  if (data.quotes)   stats.push(`${data.quotes} 引用`);
  if (stats.length) parts.push(stats.join(' | '));
  const text = parts.join('\n\n');
  return { meta, mode: 'twitter', text, articleTitle: data.text?.slice(0, 80) || '',
    articleByline: data.author || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

function synthesizeXiaoyuzhouResult(data, meta) {
  const parts = [];
  if (data.podcast) parts.push(`**播客**: ${data.podcast}`);
  if (data.title)   parts.push(`# ${data.title}`);
  if (data.description) parts.push(data.description);
  if (data.duration > 0) {
    const mm = Math.floor(data.duration / 60);
    const ss = String(data.duration % 60).padStart(2, '0');
    parts.push(`**时长**: ${mm}:${ss}`);
  }
  const text = parts.join('\n\n');
  return { meta, mode: 'xiaoyuzhou', text, articleTitle: data.title || '',
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false } };
}

/** Dispatch siteCache to the right synthesis function based on source tag. */
function synthesizeSiteCache(siteCache, meta) {
  if (!siteCache?.data) return null;
  switch (siteCache.source) {
    case 'youtube':    return synthesizeYouTubeResult(siteCache.data, meta);
    case 'juejin':     return synthesizeJuejinResult(siteCache.data, meta);
    case 'zhihu':      return synthesizeZhihuResult(siteCache.data, meta);
    case 'dedao':      return synthesizeDedaoResult(siteCache.data, meta);
    case 'geektime':   return synthesizeGeektimeResult(siteCache.data, meta);
    case 'bilibili':   return synthesizeBilibiliResult(siteCache.data, meta);
    case 'xueqiu':     return synthesizeXueqiuResult(siteCache.data, meta);
    case 'twitter':    return synthesizeTwitterResult(siteCache.data, meta);
    case 'xiaoyuzhou': return synthesizeXiaoyuzhouResult(siteCache.data, meta);
    default: return null;
  }
}

// ---------------------------------------------------------------------------

export async function extractActiveTab({ mode = 'reader', maxTextChars, xhsXhrNote = null, siteCache = null } = {}) {
  // Readability typically yields <30K chars; we only cap as a safety net.
  const textCap = maxTextChars && maxTextChars > 0 ? maxTextChars : 1_000_000;

  const tab = await getActiveTab();
  if (!tab) throw new Error('No active tab');
  if (!tab.id) throw new Error('Active tab has no id');
  if (!/^https?:/.test(tab.url || '')) {
    throw new Error(`Cannot extract from non-http(s) URL: ${tab.url}`);
  }

  const meta = {
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl || ''
  };

  const result = { meta, mode };

  // PDF: skip all extraction — pass the URL directly so the agent can fetch
  // and process it with its own tools (curl, pdftotext, OCR, etc.).
  const pdf = await tryPdfExtraction(tab, mode, meta);
  if (pdf) return pdf;

  // Screenshot mode: just capture, no DOM walking.
  if (mode === 'screenshot') {
    result.imageDataUrl = await captureVisibleTab(tab.id);
    result.text = `(screenshot of "${meta.title}")`;
    result.truncated = { rawTextLength: 0, textLength: 0, wasCapped: false };
    return result;
  }

  // Site-specific fast path: use XHR-intercepted data from content scripts.
  // This is the primary extraction method for SPAs where Readability fails.
  // The content script fires when the SPA makes its own API call (with the
  // user's auth cookies), so we get fully authenticated content for free.
  if (siteCache) {
    const synthesized = synthesizeSiteCache(siteCache, meta);
    if (synthesized) {
      console.log(`browsa: ${siteCache.source} using XHR-cached data (${synthesized.text?.length || 0} chars)`);
      return synthesized;
    }
  }

  const youtube = await tryYoutubeActiveFallback(tab, meta);
  if (youtube) return youtube;

  const bilibili = await tryBilibiliActiveFallback(tab, meta);
  if (bilibili) return bilibili;

  // Xiaohongshu (小红書) detail page: skip Readability entirely (see
  // tryXhsExtraction for why). Falls through to the generic cascade below
  // if it can't get authoritative data in time.
  const isXhsNote = /^https?:\/\/(www\.)?xiaohongshu\.com\/explore\//.test(tab.url || '');
  if (isXhsNote) {
    const xhs = await tryXhsExtraction(tab, meta, xhsXhrNote, textCap, result);
    if (xhs) return xhs;
  }

  return await runGenericExtraction(tab, mode, meta, textCap, result);
}

/** PDF served with or without ".pdf" in the URL — returns a URL-only placeholder result, or null if not a PDF. */
async function tryPdfExtraction(tab, mode, meta) {
  // Some sites (e.g. arxiv.org/pdf/1807.00412) serve PDFs without ".pdf" in
  // the URL, so also do a cheap in-page contentType check — this catches
  // Chrome's built-in PDF viewer instantly, before the slow Readability
  // pipeline gets a chance to run (and fail) on it.
  if (!(/\.pdf(\?.*)?$/i.test(tab.url) || (mode !== 'screenshot' && await isPdfDocument(tab.id)))) {
    return null;
  }
  const text = `[PDF file — agent should fetch and read directly]\nURL: ${tab.url}\nTitle: ${meta.title}`;
  return {
    meta,
    mode: 'pdf-url',
    text,
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false }
  };
}

/**
 * YouTube active fallback: when passive interception cache is empty, call
 * activeYouTubeFetch() defined in the content script via executeScript(world:'MAIN').
 * Returns a synthesized result, or null if not applicable / no data.
 */
async function tryYoutubeActiveFallback(tab, meta) {
  if (!/youtube\.com\/watch\?/.test(tab.url || '')) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        if (typeof activeYouTubeFetch !== 'function') return null;
        return await activeYouTubeFetch();
      }
    });
    const video = res?.result;
    if (video?.videoId) {
      const synthesized = synthesizeYouTubeResult(video, meta);
      console.log(`browsa: youtube active-fetch fallback transcript=${!!video.transcript} chapters=${!!video.chapters}`);
      return synthesized;
    }
  } catch (_) {}
  return null;
}

/**
 * Bilibili active fallback: passive interception may miss API calls when
 * the SW was asleep when the page loaded, or the tab was already open.
 * MAIN world content scripts can only SEND messages (chrome.runtime.sendMessage),
 * not receive them — so we use executeScript(world:'MAIN') to directly call
 * the activeFetchBilibiliVideo() function defined by the content script.
 * Returns a synthesized result, or null if not applicable / no data.
 */
async function tryBilibiliActiveFallback(tab, meta) {
  if (!/bilibili\.com\/video\//.test(tab.url || '')) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        if (typeof activeFetchBilibiliVideo !== 'function') return null;
        return await activeFetchBilibiliVideo();
      }
    });
    const video = res?.result;
    if (video?.bvid) {
      const synthesized = synthesizeBilibiliResult(video, meta);
      console.log(`browsa: bilibili active-fetch fallback transcript=${!!video.transcript}`);
      return synthesized;
    }
  } catch (_) {}
  return null;
}

/**
 * Xiaohongshu (小红書) detail page extraction: skip Readability entirely.
 * The site's detail page is full of feed cards / recommendations /
 * comment widgets that out-score the actual note text, and the title +
 * body are React-emotion-hashed to stable #detail-title / #detail-desc
 * anchors. Returns a populated `result`, or null to fall through to the
 * regular Readability/full pipeline.
 */
async function tryXhsExtraction(tab, meta, xhsXhrNote, textCap, result) {
  // Fast path: if the content script already intercepted the XHR for
  // this tab and the noteId matches the current URL, we have the
  // most authoritative data we can get — the browser's own signed
  // fetch response. We synthesize an extraction result from it
  // without any DOM round-trip.
  if (xhsXhrNote && xhsXhrNote.noteId) {
    const urlNoteId = (tab.url.match(/\/explore\/([a-f0-9]+)/) || [])[1];
    if (!urlNoteId || xhsXhrNote.noteId === urlNoteId) {
      const fromXhr = synthesizeXhsResultFromXhr(xhsXhrNote);
      console.log(`browsa: xhs using xhr-intercepted note noteId=${xhsXhrNote.noteId} subSource=xhr-intercepted`);
      return fromXhr;
    }
    console.log(`browsa: xhs xhr noteId=${xhsXhrNote.noteId} != url noteId=${urlNoteId}, ignoring`);
  }
  try {
    // Wait for either the XHR's INITIAL_STATE to populate or the
    // #detail-desc DOM anchor to appear with text. The XHR resolve
    // happens before the React re-render, so INITIAL_STATE shows up
    // first. We treat EITHER as ready, so fast notes don't pay for a
    // 5s timeout, and slow notes hard-cap at 5s.
    const xhsWaitMs = 5000;
    const xhsPollMs = 150;
    const noteId = (tab.url.match(/\/explore\/([a-f0-9]+)/) || [])[1];
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (noteId, waitMs, pollMs) => {
        const start = Date.now();
        const reason = () => {
          // INITIAL_STATE preferred — it's the XHR's data, available
          // before React renders the DOM.
          if (noteId) {
            const n = window.__INITIAL_STATE__?.note?.noteDetailMap?.[noteId]?.note;
            if (n && (n.title || n.desc)) {
              return { ready: true, via: 'initial-state', waited: Date.now() - start };
            }
          }
          // Fallback signal: DOM anchor with text.
          const t = document.querySelector('#detail-title');
          const d = document.querySelector('#detail-desc');
          if (t && d && (d.textContent || '').trim()) {
            return { ready: true, via: 'dom', waited: Date.now() - start };
          }
          return null;
        };
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const r = reason();
          if (r) return r;
          if (Date.now() - start > waitMs) {
            return { ready: false, via: 'timeout', waited: Date.now() - start };
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      },
      args: [noteId, xhsWaitMs, xhsPollMs],
      world: 'MAIN'
    });
    const poll = res?.result || {};
    console.log(`browsa: xhs poll: ready=${poll.ready} via=${poll.via} waited=${poll.waited}ms noteId=${noteId}`);

    if (poll.ready) {
      const [r2] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractXiaohongshuInPageWorld,
        world: 'MAIN'
      });
      const xhs = r2?.result || {};
      console.log(`browsa: xhs extractor: subSource=${xhs.xhsSubSource} textLen=${(xhs.text || '').length} error=${xhs.error || 'none'}`);
      if (!xhs.error) {
        // Save the DOM anchors' structural fingerprint whenever the DOM
        // path succeeds, so a future selector-miss (site redesign) has
        // something to relocate against. Cheap (small JSON), best-effort.
        if (xhs.xhsSubSource === 'dom') {
          try {
            const [fp] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: _captureXhsAnchorFingerprintsInPageWorld,
              world: 'MAIN'
            });
            if (fp?.result?.titleFingerprint || fp?.result?.descFingerprint) {
              await chrome.storage.local.set({ xhsAnchorFingerprint: fp.result });
            }
          } catch (_) { /* best-effort, never block on this */ }
        }
        result.text = xhs.text;
        result.articleTitle = xhs.articleTitle || '';
        result.imageCount = xhs.imageCount || 0;
        result.imageBase64List = xhs.imageBase64List || [];
        result.xhsSource = true;
        result.xhsSubSource = xhs.xhsSubSource;
        result.xhsWaitedMs = poll.waited;
        result.truncated = {
          rawTextLength: xhs.rawTextLength || 0,
          textLength: (xhs.text || '').length,
          wasCapped: !!xhs.wasCapped,
          textCap
        };
        return result;
      }
      // DOM anchors missing (selector drift, e.g. a redesign) — try
      // relocating via a previously-saved structural fingerprint before
      // giving up entirely and falling through to Readability.
      const relocated = await tryXhsAnchorRelocation(tab, result, textCap);
      if (relocated) return relocated;
    }
    console.warn('browsa: xhs extractor timed out waiting for content, falling back to Readability');
  } catch (e) {
    console.warn('browsa: xhs extractor threw, falling back to Readability', e);
  }
  return null;
}

/**
 * Adaptive relocation fallback for XHS's DOM-anchor extraction: when
 * #detail-title/#detail-desc are missing (site redesign changed the anchor
 * ids/classes), try to relocate structurally-similar elements using a
 * fingerprint saved the last time extraction succeeded. Returns a populated
 * `result` if relocation found usable text, or null.
 */
async function tryXhsAnchorRelocation(tab, result, textCap) {
  try {
    const stored = await chrome.storage.local.get('xhsAnchorFingerprint');
    const fingerprint = stored?.xhsAnchorFingerprint;
    if (!fingerprint || (!fingerprint.titleFingerprint && !fingerprint.descFingerprint)) return null;
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: _relocateXhsAnchorsInPageWorld,
      args: [{ titleFingerprint: fingerprint.titleFingerprint, descFingerprint: fingerprint.descFingerprint, minScore: 0.5 }],
      world: 'MAIN'
    });
    const relocated = r?.result || {};
    if (!relocated.title && !relocated.desc) return null;
    const parts = [];
    if (relocated.title) parts.push(`# ${relocated.title}`);
    if (relocated.desc) parts.push(relocated.desc);
    const text = parts.join('\n\n');
    console.log(`browsa: xhs relocated anchors via saved fingerprint (title=${!!relocated.title} desc=${!!relocated.desc})`);
    result.text = text;
    result.articleTitle = relocated.title || '';
    result.xhsSource = true;
    result.xhsSubSource = 'dom-relocated';
    result.truncated = { rawTextLength: text.length, textLength: text.length, wasCapped: false, textCap };
    return result;
  } catch (_) {
    return null;
  }
}

// --- Adaptive relocation for XHS's DOM-anchor fallback --------------------
// Ported concept: Scrapling's adaptive element relocation (parser.py). Only
// applied narrowly here — XHS's #detail-title/#detail-desc DOM fallback path
// (Source 2 in extractXiaohongshuInPageWorld above), not the other 9 sites,
// since they rely on XHR interception rather than fixed CSS selectors and
// don't have this failure mode. Self-contained (no shared helpers — MAIN-
// world executeScript only serializes the passed function itself).

function _captureXhsAnchorFingerprintsInPageWorld() {
  function describe(el) {
    if (!el) return null;
    const attrs = {};
    for (const a of el.attributes || []) {
      if (a.name === 'class' || a.name === 'id') continue;
      attrs[a.name] = a.value;
    }
    let depth = 0, n = el;
    while (n.parentElement) { depth++; n = n.parentElement; }
    return {
      tag: el.tagName.toLowerCase(),
      classes: el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
      id: el.id || '',
      attrs,
      depth,
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : ''
    };
  }
  const titleEl = document.querySelector('#detail-title');
  const descEl = document.querySelector('#detail-desc');
  if (!titleEl && !descEl) return { titleFingerprint: null, descFingerprint: null };
  return {
    titleFingerprint: describe(titleEl),
    descFingerprint: describe(descEl)
  };
}

function _relocateXhsAnchorsInPageWorld({ titleFingerprint, descFingerprint, minScore }) {
  function bigrams(str) {
    const s = String(str).toLowerCase();
    if (s.length < 2) return new Set(s ? [s] : []);
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }
  function stringRatio(x, y) {
    const sa = x == null ? '' : String(x);
    const sb = y == null ? '' : String(y);
    if (sa === sb) return 1;
    if (!sa || !sb) return 0;
    const ga = bigrams(sa);
    const gb = bigrams(sb);
    if (ga.size === 0 || gb.size === 0) return sa === sb ? 1 : 0;
    let overlap = 0;
    for (const g of ga) if (gb.has(g)) overlap++;
    return (2 * overlap) / (ga.size + gb.size);
  }
  function score(a, b) {
    if (!a || !b) return 0;
    if ((a.tag || '').toLowerCase() !== (b.tag || '').toLowerCase()) return 0;
    const classRatio = stringRatio((a.classes || []).join(' '), (b.classes || []).join(' '));
    const idRatio = stringRatio(a.id || '', b.id || '');
    const attrsRatio = stringRatio(JSON.stringify(a.attrs || {}), JSON.stringify(b.attrs || {}));
    const parentRatio = (a.parentTag || '').toLowerCase() === (b.parentTag || '').toLowerCase() ? 1 : 0;
    const depthRatio = Number.isFinite(a.depth) && Number.isFinite(b.depth)
      ? 1 / (1 + Math.abs(a.depth - b.depth))
      : 0.5;
    // Deliberately no text-similarity term — the whole point of relocation
    // is that the *content* changed (new note), only structure carries over.
    return classRatio * 0.4 + idRatio * 0.2 + attrsRatio * 0.15 + parentRatio * 0.15 + depthRatio * 0.1;
  }
  function findBest(fingerprint) {
    if (!fingerprint || !fingerprint.tag) return null;
    let best = null, bestScore = 0;
    const candidates = document.querySelectorAll(fingerprint.tag);
    for (const el of candidates) {
      const attrs = {};
      for (const a of el.attributes || []) {
        if (a.name === 'class' || a.name === 'id') continue;
        attrs[a.name] = a.value;
      }
      let depth = 0, n = el;
      while (n.parentElement) { depth++; n = n.parentElement; }
      const descriptor = {
        tag: el.tagName.toLowerCase(),
        classes: el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
        id: el.id || '',
        attrs,
        depth,
        parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : ''
      };
      const s = score(fingerprint, descriptor);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return bestScore >= (minScore != null ? minScore : 0.5) ? best : null;
  }
  const titleEl = findBest(titleFingerprint);
  const descEl = findBest(descFingerprint);
  return {
    title: (titleEl?.textContent || '').trim(),
    desc: (descEl?.textContent || '').trim()
  };
}

/**
 * Generic Reader → DOM → Full cascade, used when no site-specific fast path
 * applied. Also runs the PDF-content-type safety net on empty results.
 */
async function runGenericExtraction(tab, mode, meta, textCap, result) {
  // Inject + run in the page's MAIN world. We pass the function as a string
  // (chrome.scripting.executeScript's `func` form serializes the function
  // body, but for a function with a closure over a large source string we
  // use `args` + a function literal).
  //
  // Pre-check that the tab still exists. Tabs can be closed (or never
  // existed) between when the side panel captured `currentTabId` and
  // when this call happens, especially with rapid tab switching. Returning
  // a typed error here is friendlier than a generic "No tab with id" throw.
  let page;
  try {
    let tabStill;
    try {
      tabStill = await chrome.tabs.get(tab.id);
    } catch (_) {
      return {
        meta,
        mode,
        error: 'tab-closed',
        text: '',
        articleTitle: meta.title || '',
        wasCapped: false
      };
    }
    // The tab may have changed URL (SPA nav, redirect) since the side
    // panel decided to act on it. Refuse to inject if it's now a chrome://
    // page or a tab we don't have scripting access to.
    if (!tabStill || !/^https?:/i.test(tabStill.url || '')) {
      return {
        meta,
        mode,
        error: 'tab-not-injectable',
        text: '',
        articleTitle: tabStill?.title || meta.title || '',
        wasCapped: false
      };
    }
    const run = async (func) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func,
        args: [{ htmlCap: textCap }],
        world: 'MAIN'
      });
      return res?.result || {};
    };

    if (mode === 'full') {
      page = await run(extractFullInPageWorld);
    } else if (mode === 'dom') {
      page = await run(extractDomTreeInPageWorld);
    } else if (mode === 'reader') {
      // Legacy explicit reader mode — fallback to full on failure (old behaviour)
      page = await run(extractInPageWorld);
      if (page.error) {
        console.warn('browsa: reader mode failed, falling back to full', page.error);
        page = await run(extractFullInPageWorld);
        result.fallback = true;
      }
    } else {
      // 'auto' mode (default): Reader → DOM → Full cascade
      // 1. Try Readability first — best for articles/blogs
      page = await run(extractInPageWorld);
      const readerChars = (page.text || '').length;
      if (page.error || readerChars < 500) {
        console.log(`browsa: auto — reader gave ${readerChars} chars${page.error ? ' (error)' : ''}, trying DOM tree`);
        const domPage = await run(extractDomTreeInPageWorld);
        const domChars = (domPage.text || '').length;
        if (domChars >= 300) {
          // DOM tree gave useful content
          page = domPage;
          result.autoMode = 'dom';
          console.log(`browsa: auto — using DOM tree (${domChars} chars)`);
        } else {
          // 3. Last resort: full innerText
          console.log(`browsa: auto — DOM gave ${domChars} chars, falling back to full`);
          page = await run(extractFullInPageWorld);
          result.autoMode = 'full';
          result.fallback = true;
        }
      } else {
        result.autoMode = 'reader';
        console.log(`browsa: auto — using reader (${readerChars} chars)`);
      }
    }
  } catch (e) {
    throw new Error(`Failed to read page DOM: ${e.message}`);
  }

  // Suppress unused page.error for non-reader modes
  if (page.error && (mode === 'dom' || mode === 'full')) {
    page.error = null;
  }

  if (mode === 'selected') {
    const sel = (page.selection || '').trim();
    if (sel) {
      result.text = sel;
    } else {
      result.text = page.text || '';
      result.fallback = true;
    }
  } else {
    result.text = page.text || '';
    if (page.articleTitle) result.articleTitle = page.articleTitle;
    if (page.articleExcerpt) result.articleExcerpt = page.articleExcerpt;
    if (page.articleByline) result.articleByline = page.articleByline;
    if (page.articleSiteName) result.articleSiteName = page.articleSiteName;
    if (page.limitHint) result.limitHint = page.limitHint;
  }

  result.truncated = {
    rawTextLength: page.rawTextLength || 0,
    textLength: (result.text || '').length,
    wasCapped: !!page.wasCapped,
    textCap
  };

  // Last-resort safety net: the upfront document.contentType check in
  // tryPdfExtraction is fast but not guaranteed to catch every
  // PDF-without-".pdf-in-the-URL" case (e.g. if executeScript failed). If
  // extraction still came back empty, double-check via the actual HTTP
  // Content-Type header before giving up.
  if ((result.text || '').trim().length < 50 && mode !== 'selected' && mode !== 'screenshot') {
    const isPdf = await checkContentTypeIsPdf(tab.url);
    if (isPdf) {
      const text =
        `[PDF file — agent should fetch and read directly]\nURL: ${tab.url}\nTitle: ${meta.title}`;
      result.text = text;
      result.mode = 'pdf-url';
      result.truncated = { rawTextLength: text.length, textLength: text.length, wasCapped: false };
    }
  }

  return result;
}

// Module-level source cache for vendored libraries. The service worker stays
// alive across multiple tabs/injections, so we fetch each bundle at most once
// per service-worker lifetime instead of hitting the extension's file system
// on every new tab. Both files are ~90KB; caching them shaves a disk-read
// round-trip on every reader-mode extraction after the first.
let _readabilitySrcCache = null;
let _turndownSrcCache = null;

async function getVendorSrc(name, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const src = await fetch(chrome.runtime.getURL(`lib/vendor/${name}`)).then((r) => r.text());
  cacheRef.value = src;
  return src;
}

/**
 * Inject both Readability.js and Turndown.js into the page's MAIN world.
 * Idempotent — checks `window.Readability` and `window.TurndownService` first.
 * Both libraries are bundled as ESM and patched with `export` lines; we strip
 * the exports before injecting as classic scripts via `(0, eval)(src)`.
 * Library sources are cached in service-worker memory after the first fetch.
 */
export async function ensureReadabilityInjected(tabId) {
  // Quick check: are they already there?
  let needReadability = true;
  let needTurndown = true;
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        readability: typeof Readability !== 'undefined',
        turndown: typeof TurndownService !== 'undefined'
      }),
      world: 'MAIN'
    });
    const r = probe?.result || {};
    if (r.readability && r.turndown) return { injected: false, alreadyPresent: true };
    needReadability = !r.readability;
    needTurndown = !r.turndown;
  } catch (_) {
    return { injected: false, error: 'probe failed' };
  }

  // Inject only the libraries that are missing. Sources are loaded from the
  // module-level cache (populated on first use) to avoid redundant disk reads.
  // The vendored IIFE bundles are evaluated in the page's MAIN world via
  // indirect eval; they self-assign to a script-level `var Readability` /
  // `var TurndownService`, so the constructor lives on the eval's global
  // object. We pluck it off and bind it to window.
  const rdCacheRef = { get value() { return _readabilitySrcCache; }, set value(v) { _readabilitySrcCache = v; } };
  const tdCacheRef = { get value() { return _turndownSrcCache; }, set value(v) { _turndownSrcCache = v; } };
  try {
    const [readabilitySrc, turndownSrc] = await Promise.all([
      needReadability ? getVendorSrc('Readability.iife.js', rdCacheRef) : null,
      needTurndown ? getVendorSrc('Turndown.iife.js', tdCacheRef) : null
    ]);

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rdSrc, tdSrc) => {
        if (rdSrc) {
          // eslint-disable-next-line no-eval
          (0, eval)(rdSrc);
          const rGlobal = (0, eval)('Readability');
          window.Readability = rGlobal.Readability || rGlobal.default;
        }
        if (tdSrc) {
          // eslint-disable-next-line no-eval
          (0, eval)(tdSrc);
          // The bundle assigns `var TurndownService = ...` at script scope, which
          // lands on the indirect-eval's global object (not the IIFE local).
          const tGlobal = (0, eval)('TurndownService');
          window.TurndownService = tGlobal.TurndownService || tGlobal.default;
        }
      },
      args: [readabilitySrc, turndownSrc],
      world: 'MAIN'
    });
    const injected = [needReadability && 'Readability', needTurndown && 'Turndown'].filter(Boolean);
    return { injected: true, libraries: injected };
  } catch (e) {
    console.warn('browsa: page library injection failed', e);
    return { injected: false, error: 'inject libs: ' + e.message };
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** Cheap check for whether a tab is currently rendering a PDF, for sites that omit ".pdf" from the URL. */
async function isPdfDocument(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType === 'application/pdf',
      world: 'MAIN'
    });
    return !!res?.result;
  } catch (_) {
    return false;
  }
}

/** HEAD-check whether a URL serves a PDF — last-resort fallback when the in-page check misses. */
async function checkContentTypeIsPdf(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return (resp.headers.get('content-type') || '').toLowerCase().includes('application/pdf');
  } catch (_) {
    return false;
  }
}

async function captureVisibleTab(tabId) {
  // chrome.tabs.captureVisibleTab requires <all_urls> or activeTab + scripting.
  // activeTab grants temporary host permission when user invokes the extension
  // (e.g. clicks the action button). Since this is called from a user gesture
  // (clicking "send"), activeTab should be sufficient.
  const tab = await chrome.tabs.get(tabId);
  // JPEG at 70 quality keeps screenshots under ~200KB (vs PNG at 3-5MB),
  // small enough to store in chrome.storage.local alongside history.
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
}

/**
 * Build the plain-text representation of a page context for storage in history.
 * Intentionally omits images (base64 is too large for chrome.storage).
 * This is what gets saved after the first turn so subsequent turns can reuse it.
 */
export function buildPageContextText(pageContext) {
  const { meta, mode, text, format, fallback } = pageContext;
  const formatNote = format ? ` | ${format}` : '';
  return (
    `${PAGE_CONTEXT_PREFIX}\n` +
    `URL: ${meta.url}\n` +
    `Title: ${meta.title}\n` +
    `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}\n` +
    `---\n\n${text || ''}`
  );
}

/**
 * Build the messages array for a chat turn. Adds a system-style "user attachment"
 * prefix so the model understands the context.
 */
export function buildMessages({ history, userText, pageContext, withImage, userImages, systemPrompt }) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (pageContext) {
    const { meta, mode, text, textContent, format, imageDataUrl, imageBase64List, fallback } = pageContext;
    const formatNote = format ? ` | ${format}` : '';
    const header =
      `${PAGE_CONTEXT_PREFIX}\n` +
      `URL: ${meta.url}\n` +
      `Title: ${meta.title}\n` +
      `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}\n` +
      `---`;

    // Images to include as vision content. Priority:
    // 1. XHS imageBase64List (v0.20.0 image-fetch path)
    // 2. Screenshot imageDataUrl (screenshot mode)
    const visionImages = (Array.isArray(imageBase64List) && imageBase64List.length > 0)
      ? imageBase64List.map((url) => ({ type: 'image_url', image_url: { url } }))
      : (withImage && imageDataUrl)
        ? [{ type: 'image_url', image_url: { url: imageDataUrl } }]
        : null;

    if (visionImages) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `${header}\n\n${text || ''}` },
          ...visionImages
        ]
      });
    } else {
      messages.push({ role: 'user', content: `${header}\n\n${text || ''}` });
    }
  }

  // Append conversation history (skip the last user message we just added if any)
  if (history && history.length) {
    for (const m of history) {
      // Avoid duplicating the page-context message we just pushed
      if (pageContext && messages.length && m === messages[0]) continue;
      messages.push(m);
    }
  }

  // Final user instruction (with optional pasted/dropped images)
  if (userImages && userImages.length > 0) {
    const content = [{ type: 'text', text: userText || 'Describe these images.' }];
    for (const dataUrl of userImages) {
      content.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userText || '(no instruction; just respond to the page context)' });
  }

  return messages;
}
