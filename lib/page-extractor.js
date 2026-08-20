// lib/page-extractor.js
import { synthesizeSiteCache, synthesizeYouTubeResult, synthesizeBilibiliResult } from './site-synthesizers.js';
import { tryXhsExtraction } from './xhs-extractor.js';
import { ensureReadabilityInjected } from './readability-injector.js';
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
  if (typeof Readability === 'undefined' || typeof TurndownService === 'undefined') {
    // Diagnostic: report WHICH lib is missing (a real attach bug report on
    // pi.dev showed reader silently failing in auto mode and falling to DOM;
    // knowing whether Readability or Turndown is absent distinguishes an
    // injection failure from a parse failure).
    const missing = [];
    if (typeof Readability === 'undefined') missing.push('Readability');
    if (typeof TurndownService === 'undefined') missing.push('TurndownService');
    return { error: `page libs not loaded in page world (missing: ${missing.join(', ')})` };
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

  // Site chrome (navigation, sidebars, page/site header+footer, the right-hand
  // "on this page" TOC on docs sites) is pure noise to an LLM reader -- it
  // repeats on every page of the site and crowds out the actual content. Reader
  // mode (extractInPageWorld) strips exactly these tags/roles/attrs via
  // NOISE_SELECTORS; DOM-tree mode was the one path that dumped them all,
  // which is what makes a docs-page attach come back as a wall of menu links
  // (real user report: pi.dev/docs/latest/settings attached via 📎 came back as
  // the full nav/sidebar/"On this page"/footer dump instead of the article).
  // Mirroring reader mode's structural selectors here keeps the two modes'
  // noise handling consistent. Nested helper (not a module-level sibling) per
  // the MAIN-world chrome.scripting.executeScript constraint. `hidden` is
  // already covered by isHidden() above; `aria-hidden="true"` is not.
  function isChromeNoise(el) {
    const t = el.tagName.toLowerCase();
    if (t === 'nav' || t === 'header' || t === 'footer' || t === 'aside') return true;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo' ||
        role === 'complementary' || role === 'search') return true;
    // A collapsible <details>/<summary> disclosure that wraps navigation chrome
    // (a mobile nav panel, a "On this page" TOC drawer) is itself chrome -- its
    // <summary> label AND any nav-section heading text inside (pi.dev renders
    // its mobile sidebar/TOC this way, as <details class="docs-mobile-*">
    // siblings OUTSIDE the <aside> rails, with a <p class="docs-mobile-nav-
    // heading">On this page</p> label beside the <nav>) would otherwise leak
    // bare "Navigation / Documentation / On this page" labels into the
    // extraction even though the <nav> they wrap is stripped. A legit FAQ
    // accordion (<details><summary>Question</summary><p>Answer</p></details>)
    // has no <nav>/<aside>/etc. descendant and is untouched. One querySelector
    // per details, bounded (details are rare, subtrees are small).
    if (t === 'details') {
      if (el.querySelector('nav, aside, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]')) {
        return true;
      }
    }
    return (el.getAttribute && el.getAttribute('aria-hidden')) === 'true';
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
    if (isChromeNoise(el)) return;

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
      (c) => !isHidden(c) && !SKIP.has(c.tagName.toLowerCase()) && !isChromeNoise(c)
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
export async function extractActiveTab({ mode = 'reader', maxTextChars, xhsXhrNote = null, siteCache = null, query = '', preClean = true, tabId = null } = {}) {
  // Readability typically yields <30K chars; we only cap as a safety net.
  const textCap = maxTextChars && maxTextChars > 0 ? maxTextChars : 1_000_000;

  // Prefer the caller-supplied tabId (from ATTACH_PAGE's msg.tabId) so we
  // always extract the tab the user intended — getActiveTab() uses
  // lastFocusedWindow which can return the wrong tab when the side panel
  // has focus.
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await getActiveTab();
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
    // YouTube: skip XHR cache entirely — installYouTubeInterceptor() never
    // runs in MAIN world (chrome.runtime is undefined there), so SITE_CACHES
    // never gets YouTube data from the passive interceptor path. All YouTube
    // extraction goes through activeYouTubeFetch.
    if (siteCache.source !== 'youtube') {
      const synthesized = synthesizeSiteCache(siteCache, meta);
      if (synthesized) {
        console.log(`browsa: ${siteCache.source} using XHR-cached data (${synthesized.text?.length || 0} chars)`);
        return synthesized;
      }
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

  // GitHub /blob/ fast path: fetch the file's raw source directly, bypassing
  // preExtractCleanup (whose [aria-expanded] clicks churn the GitHub UI) and
  // Readability. Fail-open -> null falls through to runGenericExtraction.
  const gh = await tryGithubExtraction(tab, meta, textCap);
  if (gh) return gh;

  return await runGenericExtraction(tab, mode, meta, textCap, result, query, preClean);
}

// Max PDF size we'll fetch+base64-encode for client-side text extraction.
// 30 MiB accommodates real-world ~20 MiB PDFs (e.g. a GitHub-hosted book) with
// headroom; the tradeoff is that base64 inflates this to ~40 MB travelling
// through chrome.runtime messaging, and wasm/pdf.js parsing a file this large
// is slower -- onAttachPage's race timeout and the wasm worker TIMEOUT_MS are
// sized accordingly. Bigger than this, or any fetch/parse failure, falls back
// to the placeholder text below unchanged -- pdf.js extraction is a pure
// enhancement, never a dependency the rest of the pipeline can get stuck on.
const MAX_PDF_BYTES = 30 * 1024 * 1024;

// Runs IN THE TAB (MAIN world) so the fetch carries the page's own cookies --
// same reasoning as fetchImageBase64 above for XHS images: a background/
// service-worker fetch of an arbitrary site's URL is cross-origin and will be
// CORS-blocked for anything login-gated, but a fetch from inside the page
// itself is same-origin and gets cookies automatically. Self-contained (no
// sibling module-scope calls) per the countImages MAIN-world lesson from this
// same file -- chrome.scripting.executeScript only serializes this function.
//
// Two refinements over a plain fetch(location.href):
//  1. GitHub /blob/ rewrite. A github.com/{owner}/{repo}/blob/{ref}/{path} URL
//     serves the GitHub web UI (text/html), NOT the file's bytes -- so for a
//     /blob/ .pdf link, fetch(location.href) returns a page of HTML, which then
//     fails PDF parsing and falls back to the URL-only placeholder. toRawPdfUrl
//     rewrites such URLs to raw.githubusercontent.com, which serves the actual
//     file bytes and sends Access-Control-Allow-Origin:*. That cross-origin
//     fetch must use credentials:'omit' -- raw.githubusercontent.com does not
//     send Access-Control-Allow-Credentials, so 'include' would be blocked by
//     the browser (and the public raw endpoint needs no auth anyway). Same-site
//     (non-rewritten) fetches still use 'include' to carry login cookies.
//  2. HTML viewer detection. After fetching, if the Content-Type is text/html
//     this is a viewer page rather than the PDF itself (some other host's docs
//     viewer, or a /blob/ URL we did not rewrite). Surface it as an error
//     instead of base64-encoding a page of HTML and shipping it to the PDF
//     parser -- the caller then falls through to the placeholder cleanly. A
//     genuine PDF served as application/pdf, application/octet-stream, or even
//     text/plain still passes (only text/html is rejected).
function _fetchPdfBytesInPageWorld(maxBytes) {
  function toRawPdfUrl(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + u.search;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function fetchAsBase64(url, credentials) {
    return fetch(url, { credentials })
      .then((resp) => {
        if (!resp.ok) return { error: 'fetch failed: ' + resp.status };
        const ct = (resp.headers && resp.headers.get('content-type')) || '';
        if (/text\/html/i.test(ct)) return { error: 'not a pdf (html viewer page): ' + ct };
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
      });
  }

  const rawUrl = toRawPdfUrl(location.href);
  if (rawUrl) return fetchAsBase64(rawUrl, 'omit').catch((e) => ({ error: e.message }));
  return fetchAsBase64(location.href, 'include').catch((e) => ({ error: e.message }));
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
 * GitHub /blob/ fast path: fetch the file's raw source directly from
 * raw.githubusercontent.com instead of scraping the rendered GitHub UI.
 *
 * Why: the GitHub blob page is a JS-heavy UI whose nav mega-menus
 * (Platform/Solutions/Resources/...), branch picker, and file-search box
 * are all `[aria-expanded="false"]` controls - 13 of them on a typical
 * page. preExtractCleanup's Step 2 clicks up to 8 of them, opening those
 * overlays in a real browser (visible "the page is operating on itself"
 * churn) AND polluting the DOM clone that Readability then parses, so the
 * extracted article is wrong. Fetching the raw bytes sidesteps both: no
 * page mutation, no Readability, and the raw source (markdown for READMEs,
 * source for code files) preserves code fences / link URLs / tables that
 * Readability flattens to plain text.
 *
 * raw.githubusercontent.com serves `access-control-allow-origin: *` and
 * text/plain for text files (verified), so the service worker can fetch it
 * directly - no MAIN-world/cookie dance (unlike XHS image fetches). The
 * rewrite mirrors _fetchPdfBytesInPageWorld's toRawPdfUrl. Fail-open: 404
 * (private repo), binary, or non-text content-type returns null and the
 * caller falls through to the generic cascade (which still works via the
 * authenticated page for private repos). PDFs never reach here -
 * tryPdfExtraction runs first and has its own raw rewrite.
 */
export async function tryGithubExtraction(tab, meta, textCap) {
  let u;
  try { u = new URL(tab.url || ''); } catch (_) { return null; }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  // Only /blob/ (the rendered file viewer). /tree/, /releases/, /raw/ etc.
  // are different surfaces - leave them to the generic cascade.
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (!m) return null;
  const rawUrl = 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
  let res;
  try {
    // credentials:'omit' - raw sends no Access-Control-Allow-Credentials,
    // so 'include' is browser-blocked (same reasoning as the PDF path).
    res = await fetch(rawUrl, { credentials: 'omit' });
  } catch (_) { return null; }
  if (!res.ok) return null;
  // raw serves all text files (.md/.py/.toml/.json/.js) as text/plain;
  // images/PDFs come back as image/* or application/pdf. Only accept text.
  const ct = (res.headers && res.headers.get('content-type')) || '';
  if (!/^text\//i.test(ct)) return null;
  let text;
  try { text = await res.text(); } catch (_) { return null; }
  if (!text) return null;
  // Binary disguised as text (shouldn't happen from raw, but guard).
  if (/\x00/.test(text.slice(0, 4000))) return null;
  const rawLen = text.length;
  let capped = text;
  let wasCapped = false;
  if (textCap > 0 && rawLen > textCap) {
    capped = text.slice(0, textCap);
    wasCapped = true;
  }
  console.log(`browsa: github raw fast-path (${capped.length} chars) from ${rawUrl}`);
  return {
    meta,
    mode: 'github-raw',
    text: capped,
    articleTitle: meta.title || '',
    truncated: { rawTextLength: rawLen, textLength: capped.length, wasCapped, textCap }
  };
}

/**
 * YouTube active fallback: inject the content script on-demand (if not already
 * present) then call activeYouTubeFetch(). Using `files` injection means this
 * works on any tab regardless of when it was opened — no dependency on the
 * manifest content_script having run at document_start.
 */
async function tryYoutubeActiveFallback(tab, meta) {
  if (!/youtube\.com\/watch\?/.test(tab.url || '')) return null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['lib/content-scripts/youtube-content-script.js']
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => activeYouTubeFetch()
    });
    const video = res?.result;
    if (video?.videoId) {
      const synthesized = synthesizeYouTubeResult(video, meta);
      console.log(`browsa: youtube active-fetch fallback transcript=${!!video.transcript} chapters=${!!video.chapters}`);
      return synthesized;
    }
  } catch (e) { console.log('browsa: tryYoutubeActiveFallback error:', e?.message); }
  return null;
}

/**
 * Bilibili active fallback: inject the content script on-demand (if not already
 * present) then call activeFetchBilibiliVideo(). Same on-demand injection
 * pattern as tryYoutubeActiveFallback — works regardless of tab open time.
 */
async function tryBilibiliActiveFallback(tab, meta) {
  if (!/bilibili\.com\/video\//.test(tab.url || '')) return null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['lib/content-scripts/bilibili-content-script.js']
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => activeFetchBilibiliVideo()
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
        // Reader failed. The most common real-world cause is a transient
        // injection failure: ensureReadabilityInjected's probe/inject can
        // silently come back {injected:false} (e.g. the probe executeScript
        // threw, or the vendor-source fetch hiccuped), leaving window.Readability/
        // window.TurndownService undefined so extractInPageWorld returns
        // "Readability not loaded in page world" / "Turndown not loaded in page
        // world" -- and background.js's ATTACH_PAGE awaits it with
        // .catch(() => {}) so the failure is invisible. Re-inject (idempotent)
        // and retry the reader ONCE before giving up to the DOM fallback. A
        // genuine parse failure ("Readability parse failed: ..."/"...no
        // content...") will fail identically on the retry and still fall
        // through to DOM -- the retry only ever helps the injection-transient
        // class of failure.
        console.log(`browsa: auto — reader gave ${readerChars} chars${page.error ? ` (error: ${page.error})` : ''}; re-injecting + retrying once`);
        try {
          await ensureReadabilityInjected(tab.id);
        } catch (_) { /* best-effort; reader may fail for a real reason */ }
        page = await run(extractInPageWorld);
        const retryChars = (page.text || '').length;
        if (!page.error && retryChars >= 500) {
          result.autoMode = 'reader';
          console.log(`browsa: auto — reader retry succeeded (${retryChars} chars)`);
        } else {
          if (page.error) console.log(`browsa: auto — reader retry also failed (error: ${page.error}); trying DOM tree`);
          else console.log(`browsa: auto — reader retry gave ${retryChars} chars; trying DOM tree`);
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
