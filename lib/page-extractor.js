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
function extractInPageWorld({ mode, readabilitySource, htmlCap }) {
  // Readability is loaded by the caller (see page-extractor-main.js) — if
  // it's not on the global, return an error.
  if (typeof Readability === 'undefined') {
    return { error: 'Readability not loaded in page world' };
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
      charThreshold: 200,    // smaller articles still get parsed
      keepClasses: false,    // strip class names to save bytes
      debug: false
    });
    article = reader.parse();
  } catch (e) {
    return { error: 'Readability parse failed: ' + e.message };
  }

  if (!article || !article.textContent) {
    return { error: 'Readability returned no content (page may not be article-like)' };
  }

  // 4) Inline image URLs into the text. Readability's textContent strips <img>
  //    tags entirely, so the model only sees the figure caption. We pull
  //    <figure><img><figcaption> triples from article.content (still HTML)
  //    and append the image URL after each caption.
  const text = augmentWithImageUrls(article.textContent, article.content);

  // 5) Compute raw length for truncation reporting
  const wasCapped = text.length > htmlCap;
  const finalText = wasCapped
    ? text.slice(0, htmlCap) + `\n\n[... truncated at ${htmlCap} chars ...]`
    : text;

  return {
    text: finalText,
    rawTextLength: text.length,
    wasCapped,
    articleTitle: article.title || '',
    articleExcerpt: article.excerpt || '',
    articleByline: article.byline || '',
    articleSiteName: article.siteName || '',
    imageCount: countImages(article.content),
    selection: sel
  };
}

// Walk article.content (HTML string), find each <figure> containing an <img>
// and a <figcaption>. Append "[image: <url>]" to the caption text so the LLM
// at least knows the image exists, where it is, and the caption.
//
// NOTE: This function runs inside the page's MAIN world (via
// chrome.scripting.executeScript's `func` arg), so DOMParser is a real
// browser API here — not a polyfill. (Node/JSDOM would need a workaround.)
function augmentWithImageUrls(textContent, contentHtml) {
  if (!contentHtml) return textContent;
  try {
    const doc = new DOMParser().parseFromString(contentHtml, 'text/html');
    const figures = doc.querySelectorAll('figure');
    if (!figures.length) return textContent;

    // Map caption text → image URL. If a figure has no caption, skip it
    // (LLM doesn't need to know about decorative images).
    const augmentByCaption = new Map();
    for (const fig of figures) {
      const img = fig.querySelector('img');
      const cap = fig.querySelector('figcaption');
      if (!img || !cap) continue;
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      const captionText = (cap.textContent || '').trim();
      if (!src || !captionText) continue;
      const normalized = captionText.replace(/\s+/g, ' ');
      if (!augmentByCaption.has(normalized)) {
        augmentByCaption.set(normalized, src);
      }
    }
    if (!augmentByCaption.size) return textContent;

    // Append the URL to every occurrence of each caption in textContent.
    let out = textContent;
    for (const [caption, src] of augmentByCaption) {
      // Escape regex special chars in the caption
      const esc = caption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${esc})`, 'g');
      out = out.replace(re, `$1\n  [image: ${src}]`);
    }
    return out;
  } catch (_) {
    return textContent;
  }
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

// Same as above but for the "full" (non-Readability) fallback mode — use
// document.body.innerText directly.
function extractFullInPageWorld({ htmlCap }) {
  const sel = window.getSelection ? String(window.getSelection() || '') : '';
  const raw = (document.body?.innerText || '').trim();
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
export async function extractActiveTab({ mode = 'reader', maxTextChars } = {}) {
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

  // Screenshot mode: just capture, no DOM walking.
  if (mode === 'screenshot') {
    result.imageDataUrl = await captureVisibleTab(tab.id);
    result.text = `(screenshot of "${meta.title}")`;
    result.truncated = { rawTextLength: 0, textLength: 0, wasCapped: false };
    return result;
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
 * Inject Readability.js into the page's MAIN world. Idempotent — checks
 * `window.Readability` first to avoid re-injection.
 */
export async function ensureReadabilityInjected(tabId) {
  // Quick check: is it already there?
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof Readability !== 'undefined',
      world: 'MAIN'
    });
    if (probe?.result === true) return { injected: false, alreadyPresent: true };
  } catch (_) {
    // Couldn't probe (e.g. about:blank). Skip.
    return { injected: false, error: 'probe failed' };
  }

  // Fetch the bundled source and inject as a <script>.
  const url = chrome.runtime.getURL('lib/Readability.js');
  let source;
  try {
    const res = await fetch(url);
    source = await res.text();
  } catch (e) {
    return { injected: false, error: 'fetch Readability source: ' + e.message };
  }

  // Strip the `export { Readability }` line we appended; it would SyntaxError
  // in page-world classic-script context.
  const stripped = source.replace(/\nexport\s*\{[^}]*\};?/g, '');

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (src) => {
      // eslint-disable-next-line no-eval
      (0, eval)(src + '\n;window.Readability = Readability;');
    },
    args: [stripped],
    world: 'MAIN'
  });

  return { injected: true };
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
export function buildMessages({ history, userText, pageContext, withImage }) {
  const messages = [];

  if (pageContext) {
    const { meta, mode, text, imageDataUrl, fallback } = pageContext;
    const header =
      `[Page context attached by browsa]\n` +
      `URL: ${meta.url}\n` +
      `Title: ${meta.title}\n` +
      `Mode: ${mode}${fallback ? ' (fallback to full)' : ''}\n` +
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

  // Final user instruction
  messages.push({ role: 'user', content: userText || '(no instruction; just respond to the page context)' });

  return messages;
}
