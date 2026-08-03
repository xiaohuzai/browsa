// lib/xhs-extractor.js - 小红书 (XHS / Xiaohongshu) note detail-page
// extraction. Extracted out of page-extractor.js as a self-contained group
// (along the same responsibility-split line as lib/site-synthesizers.js,
// lib/message-builder.js, lib/readability-injector.js).
//
// Three functions here run in the page's MAIN world via
// chrome.scripting.executeScript's `func:` form (extractXiaohongshuInPageWorld,
// _captureXhsAnchorFingerprintsInPageWorld, _relocateXhsAnchorsInPageWorld).
// Each is self-contained per the countImages MAIN-world lesson from
// page-extractor.js: executeScript serializes ONLY the passed function, so no
// sibling module-scope calls are reachable - all helpers (grade,
// fetchImageBase64, blobToBase64, describe, bigrams, stringRatio, score,
// findBest) are nested inside their respective MAIN-world function. Moving
// them into this module changes nothing: they are still passed as `func:`
// references and still serialize alone.
//
// The four service-worker-side coordinators (tryXhsExtraction,
// tryXhsAnchorRelocation, gradeXiaohongshuResult, synthesizeXhsResultFromXhr)
// run in the normal extension context and call only each other + the three
// MAIN-world functions (via executeScript({func})). tryXhsExtraction is the
// single entry point extractActiveTab calls; it is the only export.
//
// gradeXiaohongshuResult is kept here as a tested reference: its logic is
// inlined (duplicated) inside extractXiaohongshuInPageWorld for serialization
// safety, so the module-scope copy has zero production call sites - but the
// test suite exercises it directly (same "tested source of truth" pattern as
// lib/dom-similarity.js). Do not delete it.

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

export { tryXhsExtraction };
