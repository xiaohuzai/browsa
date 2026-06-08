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
// Readability fails on 小红书 detail pages because the DOM is full of feed
// cards, recommendations, and comment widgets that out-score the actual note
// text. Instead, we hit the two React-emotion-hashed anchors that 小红书's
// own frontend uses for the title and body — `#detail-title` and
// `#detail-desc`. These are stable as long as the site's component naming
// doesn't change (which would also break their own readers + 3rd-party
// tools like XHS-Downloader). We return textContent — preserved line
// breaks, emojis, numbers; the markdown layer is unnecessary for this
// short, plain-text content. We prefer textContent over innerText because
// (a) textContent is also what we read in tests under JSDOM (which has no
// layout engine, so innerText returns undefined), and (b) on the live
// page the desc node is never CSS-hidden, so we lose nothing.
//
// We also opportunistically pull comments (top-level) and image count from
// the same DOM. We do NOT call any XHR — that would require a logged-in
// cookie round-trip and break the "read DOM only" invariant.
//
// Returns { error } when neither anchor is present so the caller can fall
// back to Readability.
function extractXiaohongshuInPageWorld() {
  const titleEl = document.querySelector('#detail-title');
  const descEl = document.querySelector('#detail-desc');

  const title = (titleEl?.textContent || '').trim();
  const desc = (descEl?.textContent || '').trim();

  if (!title && !desc) {
    return { error: 'xhs anchors not found (#detail-title / #detail-desc missing)' };
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
export async function extractActiveTab({ mode = 'reader', maxTextChars, waitMs = 0 } = {}) {
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
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractXiaohongshuInPageWorld,
        world: 'MAIN'
      });
      const xhs = res?.result || {};
      if (!xhs.error) {
        result.text = xhs.text;
        result.articleTitle = xhs.articleTitle || '';
        result.imageCount = xhs.imageCount || 0;
        result.xhsSource = true;
        result.truncated = {
          rawTextLength: xhs.rawTextLength || 0,
          textLength: (xhs.text || '').length,
          wasCapped: !!xhs.wasCapped,
          textCap
        };
        return result;
      }
      console.warn('browsa: xhs extractor returned no anchors, falling back to Readability');
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
    const { meta, mode, text, textContent, format, imageDataUrl, fallback } = pageContext;
    const formatNote = format ? ` | ${format}` : '';
    const header =
      `[Page context attached by browsa]\n` +
      `URL: ${meta.url}\n` +
      `Title: ${meta.title}\n` +
      `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}\n` +
      `---`;

    if (withImage && imageDataUrl) {
      // Multimodal: pass image alongside text
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `${header}\n\n${text || ''}` },
          { type: 'image_url', image_url: { url: imageDataUrl } }
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
