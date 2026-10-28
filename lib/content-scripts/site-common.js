// lib/content-scripts/site-common.js — the MAIN-world helpers shared by every
// site interceptor, injected as a SEPARATE content script immediately before
// each site script (same world, same document → globals are visible).
//
// Ten site scripts each carried a byte-identical `relayToHost` (post the
// structured payload to the ISOLATED relay via postMessage). One change to the
// wire shape had to be repeated ten times — the exact drift class that already
// killed this channel once during the v0.19.1 MAIN-world migration. The local
// copies are gone; manifest ordering (asserted by
// test/site-content-scripts.test.mjs) is what guarantees the global exists.
//
// The same consolidation now hosts the other helpers that used to live as
// byte-twins in individual site scripts:
//   - pageImgUrl + htmlToArticleText — the HTML→markdown-text walker
//     (zhihu/geektime; the 2026-10-15 sibling-audit regression pair).
//   - fetchImagesAsJpegDataUrls — MAIN-world photo fetch + ≤1024px JPEG
//     canvas compression (reddit/twitter budget pair).
// Site scripts bind these through a tiny bridge (window global in MAIN world,
// CommonJS require under Node) so the Node suites keep exercising the real
// implementation. The xhs-extractor func: payloads stay self-contained instead
// (executeScript serializes only the passed function) — their twins are pinned
// by test/site-twin-lockstep.test.mjs, not consolidated.
//
// Trust boundary is unchanged: every payload still crosses the page world, so
// the ISOLATED relay continues to treat it as page-controlled input.
(function () {
  function relayToHost(msg) {
    try {
      window.postMessage({ __browsaRelay: true, message: msg }, window.location.origin);
    } catch (_) { /* page navigated mid-post — nothing to deliver */ }
  }

  // First real image URL on the element: prefer the attributes carrying what
  // the page actually rendered (the plain `src` is often the 80px/720w variant
  // or a lazy placeholder). data:/blob: placeholders never qualify.
  function pageImgUrl(img) {
    for (const attr of ['data-actualsrc', 'data-original', 'src']) {
      const v = (typeof img.getAttribute === 'function' && img.getAttribute(attr)) || '';
      if (v && !/^(data:|blob:)/i.test(v)) return v;
    }
    return '';
  }

  // Pure: strip HTML to plain text, but keep article figures in place as
  // markdown image syntax (`![alt](url)`), with the image-URL picker injected
  // by the caller (per-site attribute preferences stay with the site script).
  // Plain-textContent stripping here was the 2026-10-15 reported regression —
  // zhihu attaches came out text-only because the image URLs died in this
  // step, and mode 'zhihu' had no other figure channel (the [图N] pipeline
  // consumes the markdown syntax downstream). NOSCRIPT is skipped because
  // zhihu content HTML carries a <noscript> twin of every figure — walking it
  // would duplicate each image. Must only run in a browser context (or tests
  // with a DOM global).
  const ARTICLE_BLOCK_RE = /^(P|DIV|FIGURE|BLOCKQUOTE|LI|UL|OL|TABLE|TR|PRE|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER)$/;

  function htmlToArticleText(html, imgUrlOf) {
    if (typeof document === 'undefined') return '';
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const out = [];
    const mdAlt = (s) => String(s || '').replace(/[[\]()\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out.push(child.textContent || ''); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        if (tag === 'IMG' || tag === 'PICTURE') {
          const img = tag === 'IMG' ? child : child.querySelector('img');
          const url = img ? imgUrlOf(img) : '';
          if (url) out.push(`\n\n![${mdAlt(img.getAttribute('alt'))}](${url})\n\n`);
          continue;
        }
        if (tag === 'BR') { out.push('\n'); continue; }
        walk(child);
        if (ARTICLE_BLOCK_RE.test(tag)) out.push('\n\n');
      }
    };
    walk(div);
    return out.join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Fetch image bytes in the page MAIN world (i.redd.it / pbs.twimg.com serve
  // CORS '*', so a plain page fetch works — no DNR/header recipe needed, same
  // tier as the XHS image fetcher) and canvas-compress to ≤1024px JPEG data
  // URLs. Up to `cap` photos. Fail-open everywhere: each fetch keeps its own
  // 10s timeout and drops individually; an unusable environment (Node/jsdom
  // tests, blocked CDN, no canvas) returns [] and the caller stays
  // text+URL-only. The per-image fetches are concurrent (2026-10-17: a serial
  // loop let one slow CDN node serialize the whole attach, worst case
  // cap × 10s); Promise.allSettled preserves the order of the source list.
  async function fetchImagesAsJpegDataUrls(urls, cap) {
    const out = [];
    const list = Array.isArray(urls) ? urls : [];
    if (!list.length) return out;
    if (typeof fetch !== 'function' || typeof Image === 'undefined' || typeof document === 'undefined') return out;
    const fetchOne = async (url) => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        const b64 = await new Promise((resolve) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(blob);
          // Revoke on BOTH paths: the original blob (up to several MB per
          // photo) stayed pinned to the page's lifetime when onerror (or a
          // canvas failure) bailed without releasing it.
          const done = (v) => { URL.revokeObjectURL(objectUrl); resolve(v); };
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
              if (!ctx) { done(null); return; }
              ctx.drawImage(img, 0, 0, w, h);
              done(c.toDataURL('image/jpeg', 0.85));
            } catch (_) { done(null); }
          };
          img.onerror = () => done(null);
          img.src = objectUrl;
        });
        return b64 || null;
      } catch (_) { return null; /* dropped image */ }
    };
    const results = await Promise.allSettled(list.slice(0, cap).map(fetchOne));
    for (const r of results) if (r.status === 'fulfilled' && r.value) out.push(r.value);
    return out;
  }

  if (typeof window !== 'undefined' && !window.__browsaRelayToHost) {
    window.__browsaRelayToHost = relayToHost;
    window.__browsaPageImgUrl = pageImgUrl;
    window.__browsaHtmlToArticleText = htmlToArticleText;
    window.__browsaFetchImagesAsJpegDataUrls = fetchImagesAsJpegDataUrls;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { relayToHost, pageImgUrl, htmlToArticleText, fetchImagesAsJpegDataUrls };
  }
})();
