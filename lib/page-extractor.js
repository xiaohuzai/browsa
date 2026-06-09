// lib/page-extractor.js
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

// We bundle Readability as text and inject it as a <script> into the page,
// then call it. We can't `import` it from page-world code because the page
// is a different realm. The injection string is built once at module load.
const READABILITY_SOURCE = (() => {
  // Self-reference: we read our own file's source via fetch. Since this runs
  // in the extension background, it uses the extension's file:// URL.
  // To keep it simple, we instead inline the source via a string we ship.
  // (Readability.js is included as a sibling file; we read it at build time
  // via a fetch in the background script. For simplicity, the background
  // script does the file fetch and passes the source down.)
  return null; // populated at runtime by background.js
})();

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

  // 2) clone document so Readability's mutations don't affect the live page
  const docClone = document.cloneNode(true);

  // 3) pre-strip obvious noise. This is the recipe recommended in Mozilla's
  //    Readability docs: remove elements Readability can't classify.
  const NOISE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'video',
    'header', 'footer', 'nav', 'aside',
    '.ad, .ads, .advert, .advertisement',
    '.cookie, .cookie-banner, #cookie, #cookie-banner',
    '.share, .social, .social-share',
    '.comments, #comments, .comment-section',
    '.related, .recommended, .suggestions',
    '.sidebar, .widget',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-hidden="true"]', '[hidden]'
  ];
  try {
    docClone.querySelectorAll(NOISE_SELECTORS.join(',')).forEach((el) => el.remove());
  } catch (_) {
    // ignore selector errors
  }

  let article = null;
  try {
    const reader = new Readability(docClone, {
      charThreshold: 1500,   // raise so nav/footer get stripped even on short pages
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

  // 6) Apply the hard cap. Markdown is denser than HTML, so 1M chars is
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
    limitHint: rawTextLength > 300_000
      ? `⚠ Page content is large (~${Math.round(rawTextLength/1000)}K chars). The LLM may not see everything. Use Selection mode.`
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

        // Fetch images IN MAIN WORLD (auto cookies + Referer) — up to 3
        const rawImages = note.imageList || [];
        const imageUrls = rawImages
          .map((img) => img?.url || (img?.infoList && img.infoList[0]?.url))
          .filter(Boolean);
        const imageBase64List = [];
        for (const url of imageUrls.slice(0, 3)) {
          const b64 = await fetchImageBase64(url);
          if (b64) imageBase64List.push(b64);
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
// note. The content script in lib/xhs-content-script.js calls this
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
export async function extractActiveTab({ mode = 'reader', maxTextChars, waitMs = 0, xhsXhrNote = null } = {}) {
  // Readability typically yields <30K chars; we only cap as a safety net.
  const textCap = maxTextChars && maxTextChars > 0 ? maxTextChars : 1_000_000;

  const tab = await getActiveTab();
  if (!tab) throw new Error('No active tab');
  if (!tab.id) throw new Error('Active tab has no id');
  if (!/^https?:/.test(tab.url || '')) {
    throw new Error(`Cannot extract from non-http(s) URL: ${tab.url}`);
  }

  // Optional JS render wait (manual opt-in for SPA sites like 小红书).
  // Default 0 = skip; the user checks "⏳ Wait JS" to add a 2s delay.
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
    console.log(`browsa: waited ${waitMs}ms for JS rendering`);
  }

  const meta = {
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl || ''
  };

  const result = { meta, mode };

  // Screenshot mode: just capture, no DOM walking.
  if (mode === 'screenshot') {
    result.imageDataUrl = await captureVisibleTab(tab.id);
    result.text = `(screenshot of "${meta.title}")`;
    result.truncated = { rawTextLength: 0, textLength: 0, wasCapped: false };
    return result;
  }

  // Xiaohongshu (小红书) detail page: skip Readability entirely.
  // The site's detail page is full of feed cards / recommendations /
  // comment widgets that out-score the actual note text, and the title +
  // body are React-emotion-hashed to stable #detail-title / #detail-desc
  // anchors. If we fail to find them, fall through to the regular
  // Readability/full pipeline.
  const isXhsNote = /^https?:\/\/(www\.)?xiaohongshu\.com\/explore\//.test(tab.url || '');
  if (isXhsNote) {
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
      }
      console.warn('browsa: xhs extractor timed out waiting for content, falling back to Readability');
    } catch (e) {
      console.warn('browsa: xhs extractor threw, falling back to Readability', e);
    }
  }

  // Inject + run in the page's MAIN world. We pass the function as a string
  // (chrome.scripting.executeScript's `func` form serializes the function
  // body, but for a function with a closure over a large source string we
  // use `args` + a function literal).
  let page;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: mode === 'full' ? extractFullInPageWorld : extractInPageWorld,
      args: [{ htmlCap: textCap }],
      world: 'MAIN'
    });
    page = res?.result || {};
  } catch (e) {
    throw new Error(`Failed to read page DOM: ${e.message}`);
  }

  // Readability failed (page isn't article-like) — fall back to innerText
  if (page.error) {
    console.warn('browsa: reader mode failed, falling back to full', page.error);
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractFullInPageWorld,
        args: [{ htmlCap: textCap }],
        world: 'MAIN'
      });
      page = res?.result || {};
      result.fallback = true;
    } catch (e) {
      throw new Error(`Readability + full fallback both failed: ${e.message}`);
    }
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

  return result;
}

/**
 * Inject both Readability.js and Turndown.js into the page's MAIN world.
 * Idempotent — checks `window.Readability` and `window.TurndownService` first.
 * Both libraries are bundled as ESM and patched with `export` lines; we strip
 * the exports before injecting as classic scripts via `(0, eval)(src)`.
 */
export async function ensureReadabilityInjected(tabId) {
  // Quick check: are they already there?
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
    if (r.readability && !r.turndown) return { injectTurndown: true };
    if (!r.readability && r.turndown) return { injectReadability: true };
  } catch (_) {
    return { injected: false, error: 'probe failed' };
  }

  // Inject both libraries. The vendored IIFE bundles are evaluated in the
  // page's MAIN world via indirect eval; they self-assign to a script-level
  // `var Readability` / `var TurndownService`, so the constructor lives on
  // the eval's global object. We pluck it off and bind it to window.
  try {
    const [readRes, tdRes] = await Promise.all([
      fetch(chrome.runtime.getURL('lib/vendor/Readability.iife.js')),
      fetch(chrome.runtime.getURL('lib/vendor/Turndown.iife.js'))
    ]);
    const readabilitySrc = await readRes.text();
    const turndownSrc = await tdRes.text();

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rdSrc, tdSrc) => {
        // eslint-disable-next-line no-eval
        (0, eval)(rdSrc);
        // eslint-disable-next-line no-eval
        (0, eval)(tdSrc);
        // The bundle assigns `var Readability = ...` at script scope, which
        // lands on the indirect-eval's global object (not the IIFE local).
        // `this` inside an arrow function called via executeScript is the
        // page's window, but inside the eval-scope `this` is undefined —
        // so we reach for the global object via globalThis explicitly.
        const rGlobal = (0, eval)('Readability');
        const tGlobal = (0, eval)('TurndownService');
        window.Readability = rGlobal.Readability || rGlobal.default;
        window.TurndownService = tGlobal.TurndownService || tGlobal.default;
      },
      args: [readabilitySrc, turndownSrc],
      world: 'MAIN'
    });
    return { injected: true, libraries: ['Readability', 'Turndown'] };
  } catch (e) {
    console.warn('browsa: page library injection failed', e);
    return { injected: false, error: 'inject libs: ' + e.message };
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function captureVisibleTab(tabId) {
  // chrome.tabs.captureVisibleTab requires <all_urls> or activeTab + scripting.
  // activeTab grants temporary host permission when user invokes the extension
  // (e.g. clicks the action button). Since this is called from a user gesture
  // (clicking "send"), activeTab should be sufficient.
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

/**
 * Build the messages array for a chat turn. Adds a system-style "user attachment"
 * prefix so the model understands the context.
 */
export function buildMessages({ history, userText, pageContext, withImage, userImages }) {
  const messages = [];

  if (pageContext) {
    const { meta, mode, text, textContent, format, imageDataUrl, imageBase64List, fallback } = pageContext;
    const formatNote = format ? ` | ${format}` : '';
    const header =
      `[Page context attached by browsa]\n` +
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
