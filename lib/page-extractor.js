// lib/page-extractor.js
import { PAGE_CONTEXT_PREFIX } from './constants.js';
import { synthesizeSiteCache, synthesizeYouTubeResult, synthesizeBilibiliResult } from './site-synthesizers.js';
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

  // 2b) Capture same-origin iframe bodies and open shadow roots on the LIVE
  //     document -- like HIDDEN_MARK above, this needs to happen before the
  //     clone since cloneNode(true) doesn't clone shadow trees and can't
  //     reach into a live iframe's contentDocument. Bounded (MAX_EMBEDS) and
  //     gated on non-trivial text, same rationale as HIDDEN_MARK's checks.
  const EMBED_MARK = 'data-browsa-embed';
  const embeds = []; // { html, kind: 'shadow'|'iframe' }
  const embedEls = [];
  try {
    const MAX_EMBEDS = 20;
    const candidates2 = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of candidates2) {
      if (embeds.length >= MAX_EMBEDS) break;
      if (el.shadowRoot) {
        const t = (el.shadowRoot.textContent || '').trim();
        if (t.length > 40) {
          el.setAttribute(EMBED_MARK, String(embeds.length));
          embeds.push({ html: el.shadowRoot.innerHTML, kind: 'shadow' });
          embedEls.push(el);
        }
      } else if (el.tagName === 'IFRAME') {
        try {
          const body = el.contentDocument && el.contentDocument.body;
          const t = body ? (body.textContent || '').trim() : '';
          if (t.length > 40) {
            el.setAttribute(EMBED_MARK, String(embeds.length));
            embeds.push({ html: body.innerHTML, kind: 'iframe' });
            embedEls.push(el);
          }
        } catch (_) { /* cross-origin -- expected, skip */ }
      }
    }
  } catch (_) {
    // ignore
  }

  // 3) clone document so Readability's mutations don't affect the live page
  //    (the HIDDEN_MARK/EMBED_MARK attributes set above carry over onto the clone)
  const docClone = document.cloneNode(true);

  // Un-mark the live document immediately -- the clone already has its own
  // copies of the attribute, so the live page must not be left mutated.
  try {
    markedEls.forEach((el) => el.removeAttribute(HIDDEN_MARK));
    embedEls.forEach((el) => el.removeAttribute(EMBED_MARK));
  } catch (_) {
    // ignore
  }

  // Inject captured embed content into the clone BEFORE the NOISE_SELECTORS
  // strip below (which still removes bare <iframe> tags) -- this way the
  // injected content flows through the same noise/template/comment
  // stripping and Readability parsing as native page content.
  embeds.forEach((embed, i) => {
    const marked = docClone.querySelector(`[${EMBED_MARK}="${i}"]`);
    if (!marked) return;
    const div = docClone.createElement('div');
    div.innerHTML = embed.html;
    if (embed.kind === 'iframe') {
      // The iframe tag itself gets removed wholesale by NOISE_SELECTORS --
      // replace it with a plain div so the captured content survives.
      marked.replaceWith(div);
    } else {
      // Shadow-DOM host survives NOISE_SELECTORS -- append as a child so we
      // don't clobber any of the host's own light-DOM (e.g. slotted) content.
      marked.appendChild(div);
    }
  });

  // 3b) Responsive images often carry a low-res/placeholder `src` (lazy-load)
  //     with the real high-res candidates only in `srcset`. Turndown converts
  //     `<img>` using `src`, so without this the extracted Markdown can point
  //     at a blurry placeholder even though a much better URL was available.
  //     `w`/`x` descriptors are never mixed within one srcset per spec, so
  //     comparing raw parsed floats within one image's own candidate list is
  //     safe (even though "800w" and "2x" aren't cross-comparable in general).
  try {
    docClone.querySelectorAll('img[srcset]').forEach((img) => {
      const candidates = (img.getAttribute('srcset') || '').split(',').map((s) => s.trim()).filter(Boolean);
      let best = null, bestScore = -1;
      for (const c of candidates) {
        const [url, descriptor = ''] = c.split(/\s+/);
        const score = parseFloat(descriptor) || 0;
        if (url && score >= bestScore) { bestScore = score; best = url; }
      }
      if (best) img.setAttribute('src', best);
    });
  } catch (_) {
    // malformed srcset -- leave original src
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
    '.lang-selector, .language, #language-selector',
    '.breadcrumbs, #breadcrumbs',
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
  //    Nested (not a module-level sibling) -- a real bug found while adding
  //    postProcessMarkdown below: chrome.scripting.executeScript's `func`
  //    injection only serializes the ONE function it's given (Function.
  //    toString() of just that function, re-evaluated in the page's own
  //    realm), so a call to a sibling top-level function like the old
  //    module-scope `countImages` throws ReferenceError in real Chrome the
  //    moment Readability actually succeeds -- it only appeared to work in
  //    this file's own tests because the test harness manually concatenated
  //    both function bodies into one vm context, something the real
  //    chrome.scripting.executeScript call never does.
  function countImages(contentHtml) {
    if (!contentHtml) return 0;
    try {
      const doc = new DOMParser().parseFromString(contentHtml, 'text/html');
      return doc.querySelectorAll('figure img').length;
    } catch (_) {
      return 0;
    }
  }
  const imageCount = countImages(article.content);

  // 5) Turndown: HTML → Markdown
  let markdown;
  // Populated by postProcessMarkdown's citation-numbering step (if triggered)
  // and appended AFTER truncation below, never before -- appending it inside
  // postProcessMarkdown (pre-truncation) would let the hard htmlCap cut land
  // before reaching the References list on a long page, leaving dangling
  // ⟨N⟩ markers in the model's input with no way to resolve which URL they
  // refer to (exactly the long-page scenario this feature targets).
  let referencesBlock = '';
  try {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    // Optional GFM plugin (tables/strikethrough/task-lists) -- injected
    // alongside Turndown by ensureReadabilityInjected, but best-effort: if
    // it's missing for any reason, fall through to plain Turndown output
    // rather than erroring (see ensureReadabilityInjected's doc comment).
    if (typeof TurndownPluginGfm !== 'undefined' && TurndownPluginGfm.gfm) {
      td.use(TurndownPluginGfm.gfm);
    }
    markdown = td.turndown(article.content);
    // Markdown-level cleanup pass, applied after Turndown so it works on the
    // final text regardless of which HTML shape produced it. Declared as a
    // nested function (not a module-level sibling like countImages above) --
    // chrome.scripting.executeScript's `func` injection only serializes the
    // ONE function it's given (see the XHS/dom-similarity comments elsewhere
    // in this file for the same constraint), so a helper this function
    // depends on must live inside its own body to survive injection.
    function postProcessMarkdown(md) {
      if (!md) return md;
      // Inline base64 images bloat the char budget for nothing -- this is
      // plain text sent to the model, not a vision attachment, so the model
      // never "sees" the pixels either way, base64 or not.
      let out = md.replace(/(!\[.*?\])\(data:image\/[^)]*?;base64,[^)]*?\)/g, '$1(<image-removed>)');
      // "Skip to Content" a11y anchors are boilerplate present on the vast
      // majority of CMS/framework themes -- pure noise for an LLM reader.
      out = out.replace(/\[skip(?: to)? (?:the )?(?:main )?content\]\([^)]*\)\n*/gi, '');
      // A link whose visible text spans multiple lines breaks Markdown's
      // single-line [text](url) syntax -- escape the inner newlines.
      out = out.replace(/\[([^\]]*\n[^\]]*)\]\(([^)]+)\)/g, (m, text, url) => `[${text.replace(/\n/g, '\\\n')}](${url})`);
      // SPA-embedded JSON state/config blobs (LinkedIn, Facebook, and similar
      // component-driven sites leave large JSON-object blobs sitting inside
      // otherwise-readable DOM text) bloat the char budget with data the
      // model can't meaningfully use. Ported from browser-use's
      // _preprocess_markdown_content: size-gated regexes (avoids stripping
      // small legitimate inline JSON examples) plus a per-line JSON.parse
      // sanity check before dropping a long line that merely starts with an
      // opening brace or bracket -- a prefix check alone isn't enough since
      // markdown links/images also start with an opening bracket.
      // Braces below are written as \x7B/\x7D and hex char codes rather than
      // literal curly-brace characters, so this function's source stays
      // brace-balanced for test/page-extractor.test.mjs's loadSiblingFn,
      // which extracts function bodies via naive char-by-char brace
      // counting with no awareness of regex/string literals or comments.
      out = out.replace(/`\x7B["\w][\s\S]{100,}?\x7D`/g, ''); // JSON inside a code span
      out = out.replace(/\x7B"\$type":[\s\S]{100,}?\x7D/g, ''); // JSON with a $type field (common SPA pattern)
      out = out.replace(/\x7B"[^"]{5,}":\x7B[\s\S]{100,}?\x7D/g, ''); // nested JSON objects
      out = out.split('\n').filter((line) => {
        const t = line.trim();
        const first = t.charCodeAt(0);
        if (t.length <= 100 || (first !== 0x7B && first !== 0x5B)) return true;
        try { JSON.parse(t); return false; } catch (_) { return true; }
      }).join('\n');
      // Link-to-citation numbering (ported from auditing crawl4ai's
      // convert_links_to_citations): on link-dense pages, replacing
      // [text](https://long-url...) with text⟨N⟩ and appending a
      // References section significantly cuts token usage (URLs don't repeat
      // inline, just appear once in the footer list). Only applied when
      // unique URL count >= 6 -- pages with a handful of links are left
      // untouched since the overhead (added markers + a References header)
      // is not worth the small savings.
      // Unicode angle brackets ⟨/⟩ used rather than <N> (which
      // DOMPurify would strip if this text ever went through a renderer) or
      // [N] (which could be confused with Markdown link syntax).
      // Negative lookbehind (?<!!) excludes image syntax ![alt](url).
      // The References list itself is NOT appended here -- it's stashed in
      // the outer referencesBlock and appended after truncation (see there).
      const LINK_RE = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
      const urlIndex = new Map();
      let linkMatch;
      while ((linkMatch = LINK_RE.exec(out)) !== null) {
        if (!urlIndex.has(linkMatch[2])) urlIndex.set(linkMatch[2], urlIndex.size + 1);
      }
      if (urlIndex.size >= 6) {
        LINK_RE.lastIndex = 0;
        out = out.replace(LINK_RE, (_, text, url) => text + '⟨' + urlIndex.get(url) + '⟩');
        const refLines = ['\n\n## References'];
        for (const [url, n] of urlIndex) refLines.push('[' + n + '] ' + url);
        referencesBlock = refLines.join('\n');
      }
      return out;
    }
    markdown = postProcessMarkdown(markdown);
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
  //    Also strips UNPAIRED UTF-16 surrogates (ported from auditing
  //    browser-use's sanitize_surrogates) -- real-world pages sometimes leak
  //    broken emoji/symbol encodings as lone surrogate code units, which can
  //    break JSON encoding of the request body or get rejected by a provider.
  //    Must only remove surrogates that AREN'T part of a valid pair, or real
  //    emoji/astral characters (which are exactly a valid high+low pair)
  //    would be silently destroyed too.
  markdown = markdown
    .replace(new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "")
    .replace(new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g"), "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

  // 7) Apply the hard cap. Markdown is denser than HTML, so 1M chars is
  //    well past the practical limit for any modern LLM.
  // findSafeCutPoint avoids slicing inside a fenced code block or on a table
  // row line. Inlined here (not imported from lib/markdown-chunker.js) because
  // chrome.scripting.executeScript's `func` injection only serializes the ONE
  // given function -- any module-level sibling would throw ReferenceError in
  // the page's realm (same countImages/postProcessMarkdown lesson). Braces and
  // backtick chars use hex escapes to keep this function's raw source text
  // brace-balanced for test/page-extractor.test.mjs's loadSiblingFn.
  function findSafeCutPoint(txt, cap) {
    if (!txt || cap >= txt.length) return cap;
    var lastSafe = -1;
    var inFence = false;
    var pos = 0;
    while (pos < cap) {
      var nl = txt.indexOf('\n', pos);
      var lineEnd = nl === -1 ? txt.length : nl;
      if (lineEnd > cap) break;
      var ls = pos;
      var t0 = txt[ls]; var t1 = txt[ls + 1]; var t2 = txt[ls + 2];
      var isFence = (t0 === '\x60' && t1 === '\x60' && t2 === '\x60') ||
                   (t0 === '\x7e' && t1 === '\x7e' && t2 === '\x7e');
      if (isFence) inFence = !inFence;
      var isTable = t0 === '\x7c';
      if (!inFence && !isTable && nl !== -1 && nl <= cap) lastSafe = nl;
      if (nl === -1) break;
      pos = nl + 1;
    }
    return lastSafe > 0 ? lastSafe : cap;
  }
  const wasCapped = markdown.length > htmlCap;
  const finalText = wasCapped
    ? markdown.slice(0, findSafeCutPoint(markdown, htmlCap)) + `\n\n[... truncated at ${htmlCap} chars ...]` + referencesBlock
    : markdown + referencesBlock;

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
function extractDomTreeInPageWorld({ htmlCap, query }) {
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
    // functions can't import that module). Also strips unpaired UTF-16
    // surrogates -- see extractInPageWorld's matching comment for why the
    // regex must be pair-aware (real emoji/astral chars are valid pairs).
    return (text || '')
      .replace(new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "")
      .replace(new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g"), "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
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

  // BM25 relevance scoring over character bigrams (ported from auditing
  // crawl4ai's BM25ContentFilter). Nested here (not a module-level sibling)
  // per the MAIN-world chrome.scripting.executeScript constraint: only this
  // function's own body is serialized on injection, never sibling top-level
  // declarations. Bigram tokens (not crawl4ai's whitespace-split + stemmed
  // words) are used as BM25's "terms" -- CJK text has no word-boundary
  // whitespace, and this reuses the same bigram technique already duplicated
  // elsewhere in this file (lib/dom-similarity.js's stringRatio, the XHS
  // anchor-relocation code) rather than needing a stemmer/tokenizer dependency.
  // Unlike the plain Dice-coefficient cosine this replaces, proper BM25 term
  // frequency + document-length normalization + inverse-document-frequency
  // weighting rewards items that are distinctively about the query rather
  // than merely containing common bigrams, and doesn't need a stemmer since
  // bigrams sidestep morphology entirely.
  function tokenizeBigrams(s) {
    const str = String(s).toLowerCase();
    const tokens = [];
    for (let i = 0; i < str.length - 1; i++) tokens.push(str.slice(i, i + 2));
    if (tokens.length === 0 && str.length > 0) tokens.push(str);
    return tokens;
  }

  // Computes BM25 scores for `texts` (the CURRENT repeated-group's items,
  // treated as the whole corpus -- N = group size, not the whole page) against
  // `queryText`. k1/b are the standard Okapi BM25 defaults.
  function bm25ScoreItems(texts, queryText) {
    const qTokens = tokenizeBigrams(queryText);
    if (qTokens.length === 0) return texts.map(() => 0);
    const docs = texts.map(tokenizeBigrams);
    const N = docs.length;
    const avgdl = docs.reduce((s, d) => s + d.length, 0) / (N || 1);
    const df = new Map();
    for (const d of docs) {
      for (const tok of new Set(d)) df.set(tok, (df.get(tok) || 0) + 1);
    }
    const k1 = 1.5;
    const b = 0.75;
    const idf = new Map();
    for (const qt of new Set(qTokens)) {
      const n = df.get(qt) || 0;
      idf.set(qt, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }
    return docs.map((d) => {
      const dl = d.length;
      const tf = new Map();
      for (const tok of d) tf.set(tok, (tf.get(tok) || 0) + 1);
      let score = 0;
      for (const qt of new Set(qTokens)) {
        const f = tf.get(qt) || 0;
        if (f === 0) continue;
        const denom = f + k1 * (1 - b + b * (dl / (avgdl || 1)));
        score += (idf.get(qt) || 0) * (f * (k1 + 1)) / (denom || 1);
      }
      return score;
    });
  }

  // Gentle multiplier for items whose dominant heading is h1-h6 -- much
  // gentler than crawl4ai's page-wide h1x5 weighting, since repeated-group
  // items are all the same type of thing (e.g. product cards), not a mixed
  // document tree where an h1 is structurally far more important than a div.
  function tagPriorityWeight(el) {
    const h = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6');
    if (!h) return 1.0;
    const weights = { h1: 1.5, h2: 1.35, h3: 1.2, h4: 1.1, h5: 1.1, h6: 1.1 };
    return weights[h.tagName.toLowerCase()] || 1.0;
  }

  function walk(el, depth) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = el.tagName.toLowerCase();

    // Same-origin iframes are otherwise pure noise (SKIP below), but their
    // body content is real page content the LLM would silently never see.
    // Cross-origin access throws/returns null depending on engine — expected,
    // just fall through to the normal skip in that case.
    if (tag === 'iframe') {
      try {
        const body = el.contentDocument && el.contentDocument.body;
        if (body && (body.textContent || '').trim().length > 40) {
          walk(body, depth + 1);
        }
      } catch (_) { /* cross-origin — expected, skip */ }
      return;
    }

    if (SKIP.has(tag)) return;
    if (isHidden(el)) return;

    // Open shadow roots are a separate tree from el's light DOM — el's own
    // textContent never includes shadow content, so recursing here can't
    // double-count text. Runs regardless of which branch below el falls
    // into, since several of them return early.
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) walk(child, depth + 1);
    }

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

    // <img> is not in SKIP/HEADINGS/INTERACTIVE/TEXTBLOCK and has no
    // children/text of its own, so without this branch it silently vanishes
    // -- unlike extractInPageWorld (Readability+Turndown), which converts it
    // to markdown image syntax. Real bug found via a paid-article page whose
    // body had 13 <img> tags: none appeared anywhere in the DOM-tree output.
    // Small icon/spacer images (explicit width/height both < 16) are skipped
    // as noise -- everything else gets a line so the LLM at least knows an
    // image was there, even without alt text.
    if (tag === 'img') {
      const w = parseInt(el.getAttribute('width') || '', 10);
      const h = parseInt(el.getAttribute('height') || '', 10);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w < 16 && h < 16) return;
      const alt = compress(el.getAttribute('alt') || '').slice(0, 120);
      let src = (el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-original') || '').trim();
      // A truncated base64 data: URI is meaningless noise to the LLM (and can
      // be megabytes long) -- report that it's an inline image instead of
      // dumping garbage bytes.
      src = src.startsWith('data:') ? '(inline data URI)' : src.slice(0, 200);
      if (!alt && !src) return;
      lines.push(`${indent}[${idx}]<img> ${alt || '(no alt text)'}${src ? ` → ${src}` : ''}`);
      idx++;
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
      // Capture each group item's true DOM-order position BEFORE any
      // relevance reordering -- "— Item N —" must always mean the Nth such
      // item on the page, never its position in a reordered output slot.
      const orderedGroupItems = [];
      let n = 0;
      for (const child of el.children) {
        if (repeatedGroup.includes(child)) { n++; orderedGroupItems.push({ child, itemNum: n }); }
      }
      // When a non-empty query is available, promote items whose text overlaps
      // the query into earlier slots so they survive if the total output is
      // later truncated at htmlCap. query='' (the common case: user attaches
      // before typing) is a provable no-op -- stable sort with all-equal scores
      // keeps the original DOM order unchanged, producing byte-identical output.
      // Scoring: BM25 over the group's items as the corpus, weighted by a
      // gentle tag-priority multiplier for items containing a heading.
      let emitQueue = orderedGroupItems;
      if (query) {
        const texts = orderedGroupItems.map((it) => compress(it.child.textContent));
        const bm25 = bm25ScoreItems(texts, query);
        const weighted = orderedGroupItems.map((it, i) => bm25[i] * tagPriorityWeight(it.child));
        emitQueue = orderedGroupItems
          .map((it, i) => ({ it, score: weighted[i] }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.it);
      }
      // Walk el.children in original DOM order -- non-group "outlier" siblings
      // (e.g. a "Load more" button among item cards) keep their exact original
      // relative position; only which group-item's content appears in each
      // group-slot is reordered by the relevance queue.
      let slot = 0;
      for (const child of el.children) {
        if (repeatedGroup.includes(child)) {
          const item = emitQueue[slot++];
          lines.push(`${indent}— Item ${item.itemNum} —`);
          walk(item.child, depth + 1);
        } else {
          walk(child, depth + 1);
        }
      }
      return;
    }

    // Plain container — recurse into children AND emit any direct text
    // nodes this container has, so bare text (no wrapping <p>/TEXTBLOCK
    // element — common in custom rich-text renderers, e.g. a paid article
    // site that renders each paragraph as `<div class="rich-text">plain
    // text</div>` with no <p> tag) isn't silently dropped. A real bug found
    // this way: such a page's headings/links/item-markers all survived
    // (they're proper elements, walked below), but every paragraph's actual
    // words were gone — because el.children only enumerates ELEMENT nodes,
    // never TEXT nodes, so a container with no matching element children
    // had nothing to recurse into and its own text was never read anywhere.
    // childNodes (not children, not el.textContent) is deliberate: el.textContent
    // would double-count text also captured by recursing into child elements
    // below; iterating childNodes precisely visits each text run and each
    // element exactly once.
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = compress(child.textContent);
        if (t.length > 3) lines.push(`${indent}${t}`);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child, depth + 1);
      }
    }
  }

  walk(document.body, 0);

  // Deduplicate adjacent identical lines and remove blanks
  const deduped = lines.filter((l, i) => l.trim() && l !== lines[i - 1]);
  const raw = deduped.join('\n');
  // findDomTreeCutPoint: prefer cutting at an item-group boundary or heading
  // rather than mid-line. Scans backward from cap for a '\n' followed by
  // '— Item ' or '#' (ATX heading). Falls back to the last plain '\n'.
  // Inlined for the same MAIN-world serialization reason as findSafeCutPoint
  // in extractInPageWorld. Hex-escapes used for brace-balance in loadSiblingFn.
  function findDomTreeCutPoint(txt, cap) {
    if (!txt || cap >= txt.length) return cap;
    var i = cap;
    while (i > 0) {
      if (txt[i] === '\n') {
        var next = txt[i + 1];
        if (next === '—' || next === '#') return i;
      }
      i--;
    }
    var plain = txt.lastIndexOf('\n', cap);
    return plain > 0 ? plain : cap;
  }
  const wasCapped = raw.length > htmlCap;
  const text = wasCapped
    ? raw.slice(0, findDomTreeCutPoint(raw, htmlCap)) + `\n\n[... truncated at ${htmlCap} chars ...]`
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
  // textContent/innerText/TreeWalker above never cross shadow-DOM or frame
  // boundaries — pull in same-origin iframe bodies and open shadow roots
  // separately so their content isn't silently dropped. Bounded to avoid
  // pathological pages (many iframes/web components) blowing up cost.
  try {
    const MAX_EMBEDS = 20;
    let embedCount = 0;
    const candidates = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of candidates) {
      if (embedCount >= MAX_EMBEDS) break;
      let t = '';
      if (el.shadowRoot) {
        t = (el.shadowRoot.textContent || '').trim();
      } else if (el.tagName === 'IFRAME') {
        try {
          const body = el.contentDocument && el.contentDocument.body;
          t = body ? (body.textContent || '').trim() : '';
        } catch (_) { /* cross-origin — expected, skip */ }
      }
      if (t.length > 40) {
        raw += '\n\n' + t;
        embedCount++;
      }
    }
  } catch (_) { /* ignore */ }
  // Strip zero-width/control chars a page may use to hide prompt-injection
  // text from a human reader (same logic as extractInPageWorld/compress()).
  // Also strips unpaired UTF-16 surrogates -- see extractInPageWorld's
  // matching comment for why the regex must be pair-aware.
  raw = raw
    .replace(new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "")
    .replace(new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g"), "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  const wasCapped = raw.length > htmlCap;
  // For the raw textContent dump, prefer cutting at a paragraph boundary
  // (\n\n = source join) over slicing mid-word. Plain lastIndexOf suffices --
  // no fences or tables to track. Inlined for MAIN-world serialization reason.
  var fullCut = htmlCap;
  if (wasCapped) {
    var nn = raw.lastIndexOf('\n\n', htmlCap);
    var n1 = raw.lastIndexOf('\n', htmlCap);
    fullCut = nn > 0 ? nn : (n1 > 0 ? n1 : htmlCap);
  }
  const text = wasCapped ? raw.slice(0, fullCut) + `\n\n[... truncated at ${htmlCap} chars ...]` : raw;
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
export async function extractActiveTab({ mode = 'reader', maxTextChars, xhsXhrNote = null, siteCache = null, query = '', preClean = true } = {}) {
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

  return await runGenericExtraction(tab, mode, meta, textCap, result, query, preClean);
}

// Max PDF size we'll fetch+base64-encode for client-side text extraction.
// Bigger than this, or any fetch/parse failure, falls back to the placeholder
// text below unchanged -- pdf.js extraction is a pure enhancement, never a
// dependency the rest of the pipeline can get stuck on.
const MAX_PDF_BYTES = 20 * 1024 * 1024;

// Runs IN THE TAB (MAIN world) so the fetch carries the page's own cookies --
// same reasoning as fetchImageBase64 above for XHS images: a background/
// service-worker fetch of an arbitrary site's URL is cross-origin and will be
// CORS-blocked for anything login-gated, but a fetch from inside the page
// itself is same-origin and gets cookies automatically. Self-contained (no
// sibling module-scope calls) per the countImages MAIN-world lesson from this
// same file -- chrome.scripting.executeScript only serializes this function.
function _fetchPdfBytesInPageWorld(maxBytes) {
  return fetch(location.href, { credentials: 'include' })
    .then((resp) => {
      if (!resp.ok) return { error: 'fetch failed: ' + resp.status };
      return resp.blob().then((blob) => {
        if (blob.size > maxBytes) return { error: 'pdf too large: ' + blob.size };
        return blob.arrayBuffer().then((buf) => {
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          return { base64: btoa(binary), byteLength: bytes.length };
        });
      });
    })
    .catch((e) => ({ error: e.message }));
}

/**
 * PDF served with or without ".pdf" in the URL. Tries to fetch the PDF's raw
 * bytes in-tab (for pdf.js text extraction to run in sidepanel.js, which has
 * a real `window` pdf.js's getDocument() needs -- background.js's service
 * worker does not). On any failure, falls back to the pre-existing URL-only
 * placeholder result unchanged, so PDF extraction is a pure enhancement with
 * no new failure mode reachable by the caller. Returns null if not a PDF.
 */
async function tryPdfExtraction(tab, mode, meta) {
  // Some sites (e.g. arxiv.org/pdf/1807.00412) serve PDFs without ".pdf" in
  // the URL, so also do a cheap in-page contentType check — this catches
  // Chrome's built-in PDF viewer instantly, before the slow Readability
  // pipeline gets a chance to run (and fail) on it.
  if (!(/\.pdf(\?.*)?$/i.test(tab.url) || (mode !== 'screenshot' && await isPdfDocument(tab.id)))) {
    return null;
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: _fetchPdfBytesInPageWorld,
      args: [MAX_PDF_BYTES],
      world: 'MAIN'
    });
    const fetched = res?.result;
    if (fetched?.base64) {
      return {
        meta,
        mode: 'pdf-pending',
        pdfBase64: fetched.base64,
        truncated: { rawTextLength: fetched.byteLength, textLength: 0, wasCapped: false }
      };
    }
    if (fetched?.error) {
      console.warn('browsa: pdf byte fetch failed, falling back to placeholder:', fetched.error);
    }
  } catch (e) {
    console.warn('browsa: pdf byte fetch threw, falling back to placeholder:', e.message);
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
 * Run before extracting a generic page to dismiss cookie banners, expand
 * folded "read more" sections, and scroll to trigger lazy-load. Self-contained
 * (no calls to sibling module functions — serialized via chrome.scripting
 * executeScript's func: injection, so only browser built-ins are available)
 * and async (scrolling needs small sleeps for the DOM to react).
 *
 * Safety: cookie dismissal is double-gated —
 *   1. Container scoping: only clicks within elements matching the same cookie/
 *      consent selector family already in NOISE_SELECTORS, so a random "OK"
 *      button elsewhere on the page is never touched.
 *   2. Danger-word veto: even inside a matched banner, a button whose text
 *      contains purchase/delete/confirm/pay-related keywords is skipped.
 *
 * Best-effort: any thrown exception is caught per-step; the caller also wraps
 * the whole executeScript call in try/catch. Never blocks extraction.
 */
async function preExtractCleanup() {
  const BUDGET_MS = 3500;
  const start = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - start);
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  const DANGER_WORDS = /delete|remove|purchase|buy now|checkout|\bpay\b|place order|submit|confirm|删除|购买|下单|支付|提交|确认订单|立即购买/i;
  const COOKIE_CONTAINER_SELECTOR = '.cookie, .cookie-banner, #cookie, #cookie-banner, [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="gdpr" i]';
  const ACCEPT_TEXT = /accept all|accept cookies|i agree|got it|allow all|agree and continue|同意|接受全部|我知道了|好的|允许全部/i;
  const EXPAND_TEXT = /read more|show more|阅读全文|查看更多|展开全文|^展开$/i;
  const MAX_EXPAND = 8;

  function safeClick(el) {
    if (!el || typeof el.click !== 'function') return false;
    const text = (el.textContent || '').trim();
    if (DANGER_WORDS.test(text)) return false;
    try { el.click(); return true; } catch (_) { return false; }
  }

  // Virtualized/windowed-feed detection (ported from auditing crawl4ai's
  // _handle_virtual_scroll). Distinct from ordinary lazy-load (Step 3 below,
  // which only ever APPENDS content): a virtualized feed (e.g. a
  // react-window-style infinite list) REPLACES off-screen items in the DOM
  // as the user scrolls, so most items are never simultaneously present --
  // Step 3 alone would silently lose everything except whatever's rendered
  // at the final scroll position. Nested (not module-level siblings) per the
  // same MAIN-world serialization constraint as everything else in this
  // file -- this duplicates the fingerprint concept from
  // extractDomTreeInPageWorld's findRepeatedGroup rather than sharing code,
  // since the two functions are injected via separate executeScript calls
  // with no shared closure.
  function fpKey(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/)[0] : '';
    return tag + '|' + (cls || '');
  }
  function itemHashKey(el) {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150);
    if (t) return t;
    // Image-only items (photo/thumbnail feeds with no visible text) would
    // otherwise all hash to '' and get silently skipped by a truthy check --
    // fall back to a structural signature (first <img> src + markup length)
    // so distinct image items are still individually trackable.
    const img = el.querySelector && el.querySelector('img[src]');
    const src = img ? (img.getAttribute('src') || '') : '';
    return 'img:' + src.slice(-80) + ':' + (el.innerHTML || '').length;
  }
  function findFeedCandidate() {
    if (!document.body) return null;
    const MAX_CANDIDATES = 500;
    let checked = 0;
    let best = null;
    let bestScore = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (checked++ >= MAX_CANDIDATES || timeLeft() <= 0) break;
      const children = el.children;
      if (!children || children.length < 3) continue;
      const groups = new Map();
      for (const c of children) {
        const fp = fpKey(c);
        if (!groups.has(fp)) groups.set(fp, []);
        groups.get(fp).push(c);
      }
      let dominant = null;
      for (const g of groups.values()) {
        if (!dominant || g.length > dominant.length) dominant = g;
      }
      if (!dominant || dominant.length < 3) continue;
      const coverage = dominant.length / children.length;
      if (coverage < 0.6) continue;
      const sh = el.scrollHeight || 0;
      const ch = el.clientHeight || (window.innerHeight || 800);
      if (sh <= ch * 1.5) continue; // not meaningfully scrollable
      const score = dominant.length * coverage;
      if (score > bestScore) { bestScore = score; best = { container: el, fpKey: fpKey(dominant[0]) }; }
    }
    return best;
  }

  const actions = { cookieDismissed: false, expandedCount: 0, scrolledRounds: 0 };

  // Step 1: cookie/consent banners — container-gated for safety
  try {
    outer:
    for (const c of document.querySelectorAll(COOKIE_CONTAINER_SELECTOR)) {
      if (timeLeft() <= 0) break;
      for (const b of c.querySelectorAll('button, a, [role="button"]')) {
        const t = (b.textContent || '').trim();
        if (ACCEPT_TEXT.test(t) && safeClick(b)) {
          actions.cookieDismissed = true;
          break outer;
        }
      }
    }
  } catch (_) {}

  // Step 2: expand collapsed content — bounded by MAX_EXPAND
  try {
    for (const el of document.querySelectorAll('[aria-expanded="false"], [class*="read-more" i], [class*="show-more" i]')) {
      if (actions.expandedCount >= MAX_EXPAND || timeLeft() <= 0) break;
      const t = (el.textContent || '').trim();
      const isExpandable = el.getAttribute('aria-expanded') === 'false' || EXPAND_TEXT.test(t);
      if (isExpandable && safeClick(el)) actions.expandedCount++;
    }
  } catch (_) {}

  // Step 3: scroll to bottom to trigger lazy-loaded content; repeat if the
  // page grows (new items appended), up to MAX_ROUNDS times. Always restores
  // the original scroll position so the user's view isn't disrupted.
  // Interleaved: snapshot any detected virtualized-feed candidate's current
  // items before each scroll, since a virtualized feed may REPLACE (not
  // append) its children as scrolling proceeds.
  const feedCandidate = (() => { try { return findFeedCandidate(); } catch (_) { return null; } })();
  const restoredMap = new Map(); // itemHashKey -> cloned element
  const MAX_RESTORED = 30;
  function snapshotFeedItems() {
    if (!feedCandidate || restoredMap.size >= MAX_RESTORED) return;
    try {
      for (const c of feedCandidate.container.children) {
        if (fpKey(c) !== feedCandidate.fpKey) continue;
        const key = itemHashKey(c);
        if (!restoredMap.has(key)) restoredMap.set(key, c.cloneNode(true));
        if (restoredMap.size >= MAX_RESTORED) break;
      }
    } catch (_) {}
  }
  const originalScrollY = window.scrollY || 0;
  try {
    const MAX_ROUNDS = 3;
    let lastHeight = document.body ? document.body.scrollHeight : 0;
    snapshotFeedItems();
    while (actions.scrolledRounds < MAX_ROUNDS && timeLeft() > 400) {
      window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
      await sleep(Math.min(500, Math.max(50, timeLeft() - 100)));
      snapshotFeedItems();
      const newHeight = document.body ? document.body.scrollHeight : 0;
      actions.scrolledRounds++;
      if (newHeight <= lastHeight) break;
      lastHeight = newHeight;
    }
  } catch (_) {
    // ignore scroll failures (e.g. the document disappeared mid-flight)
  } finally {
    try { window.scrollTo(0, originalScrollY); } catch (_) {}
    // Restore any snapshotted feed items no longer present live, as
    // invisible (position:absolute, off-screen) real DOM children of the
    // original container -- extractDomTreeInPageWorld's later, separate
    // extraction pass picks them up naturally via el.children, correctly
    // grouped under the same fingerprint/numbering scheme. Absolute
    // positioning (not display:none/hidden) avoids extraction's isHidden()
    // treating them as noise, while removing them from visual flow so the
    // user sees no layout shift or flash of duplicate content. This follows
    // the same live-page-mutation risk profile this function already accepts
    // for cookie dismissal and read-more expansion (both permanent, no
    // revert) -- restored clones are strictly lower-risk: additive-only and
    // invisible.
    if (feedCandidate && restoredMap.size > 0) {
      try {
        const liveKeys = new Set();
        for (const c of feedCandidate.container.children) {
          if (fpKey(c) === feedCandidate.fpKey) liveKeys.add(itemHashKey(c));
        }
        let restoredCount = 0;
        for (const [key, clone] of restoredMap) {
          if (liveKeys.has(key)) continue;
          clone.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
          clone.setAttribute('data-browsa-restored', '1');
          feedCandidate.container.appendChild(clone);
          restoredCount++;
        }
        actions.feedItemsRestored = restoredCount;
      } catch (_) {}
    }
  }

  return actions;
}

/**
 * Generic Reader → DOM → Full cascade, used when no site-specific fast path
 * applied. Also runs the PDF-content-type safety net on empty results.
 */
async function runGenericExtraction(tab, mode, meta, textCap, result, query = '', preClean = true) {
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

    // Pre-extraction cleanup: dismiss cookie banners, expand folded content,
    // scroll to trigger lazy-loaded items. Best-effort — any failure here is
    // silently swallowed; the main extraction always runs regardless.
    if (preClean) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: preExtractCleanup,
          world: 'MAIN'
        });
      } catch (_) { /* cleanup is always best-effort */ }
    }

    const run = async (func) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func,
        args: [{ htmlCap: textCap, query }],
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
let _turndownGfmSrcCache = null;

async function getVendorSrc(name, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const src = await fetch(chrome.runtime.getURL(`lib/vendor/${name}`)).then((r) => r.text());
  cacheRef.value = src;
  return src;
}

/**
 * Inject Readability.js, Turndown.js, and the Turndown GFM plugin into the
 * page's MAIN world. Idempotent — checks `window.Readability`,
 * `window.TurndownService`, and `window.TurndownPluginGfm` first.
 * Readability/Turndown are bundled as ESM and patched with `export` lines; we
 * strip the exports before injecting as classic scripts via `(0, eval)(src)`.
 * The GFM plugin is treated as optional best-effort "garnish" — unlike
 * Readability/Turndown (required for extraction to work at all), a failure to
 * load it must not break `ensureReadabilityInjected`'s overall promise;
 * `extractInPageWorld` just renders plain (non-GFM) Markdown if it's absent.
 * Library sources are cached in service-worker memory after the first fetch.
 */
export async function ensureReadabilityInjected(tabId) {
  // Quick check: are they already there?
  let needReadability = true;
  let needTurndown = true;
  let needTurndownGfm = true;
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        readability: typeof Readability !== 'undefined',
        turndown: typeof TurndownService !== 'undefined',
        turndownGfm: typeof TurndownPluginGfm !== 'undefined'
      }),
      world: 'MAIN'
    });
    const r = probe?.result || {};
    if (r.readability && r.turndown && r.turndownGfm) return { injected: false, alreadyPresent: true };
    needReadability = !r.readability;
    needTurndown = !r.turndown;
    needTurndownGfm = !r.turndownGfm;
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
  const gfmCacheRef = { get value() { return _turndownGfmSrcCache; }, set value(v) { _turndownGfmSrcCache = v; } };
  try {
    const [readabilitySrc, turndownSrc, turndownGfmSrc] = await Promise.all([
      needReadability ? getVendorSrc('Readability.iife.js', rdCacheRef) : null,
      needTurndown ? getVendorSrc('Turndown.iife.js', tdCacheRef) : null,
      // Best-effort: the GFM plugin is a nice-to-have, so a fetch failure
      // here must not abort Readability/Turndown injection.
      needTurndownGfm ? getVendorSrc('TurndownPluginGfm.iife.js', gfmCacheRef).catch(() => null) : null
    ]);

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rdSrc, tdSrc, gfmSrc) => {
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
          // turndown's CJS entry does `module.exports = TurndownService` directly
          // (the constructor itself, no .TurndownService/.default wrapper) as of
          // 7.2.4 — a real regression found while rebuilding this bundle for the
          // GFM plugin: the old `tGlobal.TurndownService || tGlobal.default` chain
          // silently resolved to undefined against a freshly-built bundle. Falling
          // back to tGlobal itself keeps both shapes working.
          window.TurndownService = tGlobal.TurndownService || tGlobal.default || tGlobal;
        }
        if (gfmSrc) {
          // Optional — swallow any eval failure so a broken/stale GFM bundle
          // never takes down the required Readability/Turndown injection.
          try {
            // eslint-disable-next-line no-eval
            (0, eval)(gfmSrc);
            window.TurndownPluginGfm = (0, eval)('TurndownPluginGfm');
          } catch (_) { /* GFM tables/strikethrough/tasklists just won't render */ }
        }
      },
      args: [readabilitySrc, turndownSrc, turndownGfmSrc],
      world: 'MAIN'
    });
    const injected = [needReadability && 'Readability', needTurndown && 'Turndown', needTurndownGfm && turndownGfmSrc && 'TurndownPluginGfm'].filter(Boolean);
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
  const { meta, mode, text, format, fallback, changedSinceLastAttach } = pageContext;
  const formatNote = format ? ` | ${format}` : '';
  const changeNote = changedSinceLastAttach
    ? `\nNote: this page's content has changed since it was last attached (previously attached ${new Date(changedSinceLastAttach.previousAttachedAt).toLocaleString()}).`
    : '';
  return (
    `${PAGE_CONTEXT_PREFIX}\n` +
    `URL: ${meta.url}\n` +
    `Title: ${meta.title}\n` +
    `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}${changeNote}\n` +
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
