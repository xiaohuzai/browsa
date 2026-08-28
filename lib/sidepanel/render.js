// lib/sidepanel/render.js — Markdown/Mermaid/ECharts/Markmap rendering pipeline for sidepanel.js.
// Extracted verbatim (Phase 3 of the sidepanel/background modularization
// refactor) from what used to be ~900 lines spread through sidepanel.js.

import marked from '../vendor/marked.bundle.js';
import DOMPurify from '../vendor/purify.bundle.js';
import hljs from '../vendor/highlight.bundle.js';
import { sanitizeMermaidSvg } from '../vendor/stream-markdown-parser.bundle.js';
import { ICONS } from './icons.js';
import { escM, _copyText, showToast } from './ui-utils.js';
import { createRevealPacer } from './reveal-pacer.js';
import { renderMathBatch } from './katex-worker-client.js';
import { estimateMermaidPreviewHeight, clampMermaidPreviewHeight, renderMermaidWithRetry } from './mermaid-utils.js';

// Configure marked: GitHub-flavored breaks for line breaks.
// DOMPurify handles XSS sanitization downstream.
marked.setOptions({
  gfm: true,
  breaks: true
});

// Auto-collapse <thinking> blocks — set from sidepanel.js's init()/storage
// listener (user preference), read by renderSafe/makeStreamRenderer below.
let thoughtAutoCollapse = false;
export function setThoughtAutoCollapse(v) { thoughtAutoCollapse = !!v; }

function _msg(key, fallback) {
  return (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
}

const SAFE_URI_REGEXP = /^(?:https?:|mailto:|tel:|data:image\/|#)/;
// Attribute names actually validated against SAFE_URI_REGEXP by the hook
// below — NOT passed as DOMPurify's ALLOWED_URI_REGEXP option (see hook
// comment for why that blanket form is unsafe for non-URI attributes).
const URI_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'background', 'xlink:href']);
// ALLOWED_URI_REGEXP above does NOT govern data: URIs on <img> — DOMPurify
// puts img/video/audio/source/track in a default DATA_URI_TAGS allow-list
// and validates data: URIs on those tags via its own internal check,
// bypassing ALLOWED_URI_REGEXP entirely (confirmed empirically: tightening
// the regex to exclude svg+xml had no effect on <img src>). So block
// data:image/svg+xml — an SVG data URL can carry its own <script>/
// event-handler content, same class of risk sanitizeMermaidSvg addresses
// for Mermaid's SVG output below — via a sanitize-attribute hook instead,
// matching stream-markdown-parser's isUnsafeHtmlUrl policy for image sources.
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'src' && /^data:image\/svg\+xml/i.test(data.attrValue)) {
    data.keepAttr = false;
    return;
  }
  // Enforce SAFE_URI_REGEXP only on attributes that actually carry a URI.
  // Passing ALLOWED_URI_REGEXP directly to sanitize() was tried first and
  // caused a real bug: DOMPurify applies that regex to the VALUE of every
  // attribute not on its own internal "safe" allow-list (id/class/style/
  // title/alt/... — see ADD_URI_SAFE_ATTR in DOMPurify's source), not just
  // href/src. That silently stripped <ol start="N"> (a plain number fails
  // an https?:/mailto:/tel:/data:image:/# allowlist), <td colspan="N">, and
  // <input type="checkbox"> — confirmed empirically by diffing sanitize()
  // output with/without the option on identical input. Checking the
  // attribute name here instead scopes the regex to what it was meant for.
  if (URI_ATTRS.has(data.attrName) && data.attrValue && !SAFE_URI_REGEXP.test(data.attrValue)) {
    data.keepAttr = false;
  }
});

// ─── Mermaid ────────────────────────────────────────────────────────────────
let mermaidModule = null; // lazily loaded on first mermaid block

async function getMermaid() {
  if (mermaidModule) return mermaidModule;
  try {
    // katex.bundle.js (264KB) used to be a top-level `import` in this file,
    // eagerly parsed/evaluated on every sidepanel load even though its ONLY
    // use is this one assignment -- purely dead weight on the main thread
    // for the (common) case where the user never opens a mermaid diagram.
    // Dynamic-imported here instead, alongside mermaid itself.
    const [{ default: mermaid }, { default: katex }] = await Promise.all([
      import('../vendor/mermaid.bundle.js'),
      import('../vendor/katex.bundle.js'),
    ]);
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // Expose KaTeX globally so Mermaid v11 can render $$...$$ math in node labels
    window.katex = katex;
    // Legibility in the narrow side panel: the SVG gets scaled down to the
    // bubble width via `max-width:100%`, so a wide layout means tiny text.
    // Tighter default flowchart spacing shrinks the natural width (bigger
    // effective scale), and a bumped base font keeps labels readable after
    // that scale. Layout-only — no semantic change to user diagrams.
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'loose',
      flowchart: { nodeSpacing: 30, rankSpacing: 40 },
      themeVariables: { fontSize: '18px' },
    });
    mermaidModule = mermaid;
  } catch (e) {
    console.warn('browsa: mermaid load failed', e);
  }
  return mermaidModule;
}

export async function renderMermaid(el) {
  const blocks = el.querySelectorAll('code.language-mermaid');
  if (!blocks.length) {
    // Fallback: look for code block containing mermaid keywords without explicit class
    console.debug('browsa: no code.language-mermaid found in', el);
    return;
  }
  const m = await getMermaid();
  // Mermaid v10+ needs a DOM-attached container during render. Its width
  // determines the diagram's actual layout (node spacing, lifeline
  // spacing, etc.) — a fixed width here regardless of the real container
  // was a real bug: browsa's side panel is typically much narrower than a
  // hardcoded 800px, so diagrams got laid out for 800px of space and then
  // visually squashed down to fit via the `max-width:100%` on the SVG,
  // distorting proportions. Match the actual bubble's rendered width
  // instead, with a sane floor for the (rare) case el isn't laid out yet.
  const host = document.createElement('div');
  const hostWidth = Math.max(el.clientWidth || 0, 280);
  host.style.cssText = `position:fixed;left:-9999px;top:0;width:${hostWidth}px;opacity:0;pointer-events:none`;
  document.body.appendChild(host);
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent;
    const errDiv = document.createElement('div');
    errDiv.className = 'mermaid-error';
    // Estimate the diagram's likely height before rendering starts, and hold
    // ONLY the temporary placeholder code-fence at roughly that height —
    // reduces the visible jump between "raw code block" and "rendered
    // diagram" once pre.replaceWith(wrapper) swaps them below. Must NOT
    // carry over to the final wrapper: the estimate formula (ported from
    // markstream-vue, tuned for its own rendering context) can overshoot the
    // real SVG height for browsa's typically simpler diagrams, and a
    // min-height on the FINAL wrapper would then force it taller than its
    // actual content — a large blank gap below the diagram. The final
    // wrapper sizes to its real content (the SVG) once rendered.
    const estimatedHeight = clampMermaidPreviewHeight(estimateMermaidPreviewHeight(source));
    pre.style.minHeight = estimatedHeight + 'px';
    try {
      if (!m) throw new Error('mermaid 模块加载失败，请检查控制台');
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      const { svg } = await renderMermaidWithRetry(m, id, source, host);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      const svgWrap = document.createElement('div');
      svgWrap.className = 'mermaid-svg-wrap';
      // securityLevel:'loose' (needed for $$...$$ KaTeX math in node labels,
      // set above in getMermaid()) also permits arbitrary HTML/click-binding
      // content in foreignObject labels to reach innerHTML unsanitized —
      // sanitizeMermaidSvg() strips scripts/event handlers/dangerous URLs
      // and downgrades foreignObject HTML to plain text before it lands here.
      // sanitizeMermaidSvg returns null when it REJECTS the svg (degenerate
      // layout NaNs, missing drawing elements). Falling back to the raw
      // string here would inject the never-sanitized markup precisely on
      // the reject path — render nothing instead.
      svgWrap.innerHTML = sanitizeMermaidSvg(svg) ?? '';
      wrapper.appendChild(svgWrap);
      wrapper.appendChild(_mermaidToolbar(svgWrap, source));
      _mermaidInteractions(wrapper, svgWrap);
      pre.replaceWith(wrapper);
    } catch (e) {
      console.warn('browsa: mermaid render failed', e);
      errDiv.innerHTML =
        `<span>⚠ Mermaid: ${escM(e?.message || String(e))}</span>` +
        `<button class="mermaid-err-copy">复制代码</button>` +
        `<details><summary>查看源码</summary><pre class="mermaid-err-src">${escM(source)}</pre></details>`;
      errDiv.querySelector('.mermaid-err-copy').addEventListener('click', (btn) => {
        _copyText(source).then(() => { btn.target.textContent = '✓'; setTimeout(() => { btn.target.textContent = '复制代码'; }, 1500); }).catch(() => {});
      });
      pre.replaceWith(errDiv);
    }
  }
  document.body.removeChild(host);
}

function _mermaidToolbar(svgWrap, source) {
  const bar = document.createElement('div');
  bar.className = 'mermaid-toolbar';
  const btns = [
    { title: '放大', text: '+', action: () => _mermaidZoom(svgWrap, 0.2) },
    { title: '缩小', text: '−', action: () => _mermaidZoom(svgWrap, -0.2) },
    { title: '重置', text: '⊙', action: () => _mermaidReset(svgWrap) },
    { title: '复制代码', html: ICONS.copy, action: (btn) => _copyText(source).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500); }).catch(() => {}) },
    { title: '导出SVG', text: '↓', action: (btn) => _mermaidExportSvg(svgWrap).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '↓'; }, 1500); }).catch(() => {}) },
  ];
  for (const { title, text, html, action } of btns) {
    const btn = document.createElement('button');
    btn.className = 'mermaid-btn';
    btn.title = title;
    if (html) btn.innerHTML = html; else btn.textContent = text;
    btn.addEventListener('click', (e) => { e.stopPropagation(); action(btn); });
    bar.appendChild(btn);
  }
  return bar;
}

function _mermaidState(svgWrap) {
  if (!svgWrap._mstate) svgWrap._mstate = { scale: 1, tx: 0, ty: 0 };
  return svgWrap._mstate;
}

function _mermaidApply(svgWrap) {
  const s = _mermaidState(svgWrap);
  const svgEl = svgWrap.querySelector('svg');
  if (!svgEl) return;

  // Lazily capture the original viewBox and screen size on first use.
  // We manipulate the SVG viewBox directly rather than CSS transform/dimensions:
  // - CSS transform on a div rasterizes it → blurry at non-1x scales
  // - Changing SVG width/height is blocked by Mermaid's inline max-width style
  // - viewBox manipulation keeps the SVG at its natural screen size and re-renders
  //   purely as vectors at any zoom level → always crisp
  if (!s._origVB) {
    const vb = svgEl.viewBox?.baseVal;
    if (vb && vb.width > 0) {
      s._origVB = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    } else {
      // No viewBox — synthesize one from element dimensions
      const rect = svgEl.getBoundingClientRect();
      const w = rect.width || parseFloat(svgEl.getAttribute('width')) || 600;
      const h = rect.height || parseFloat(svgEl.getAttribute('height')) || 400;
      s._origVB = { x: 0, y: 0, w, h };
      svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    // Cache screen size (stable since we never change SVG element dimensions)
    const r = svgEl.getBoundingClientRect();
    s._svgW = r.width  || s._origVB.w;
    s._svgH = r.height || s._origVB.h;
  }

  const { x: ox, y: oy, w: ow, h: oh } = s._origVB;

  if (s.scale === 1 && !s.tx && !s.ty) {
    svgEl.setAttribute('viewBox', `${ox} ${oy} ${ow} ${oh}`);
    svgWrap.style.transform = '';
    return;
  }

  // Zoomed viewport in viewBox units
  const vbW = ow / s.scale;
  const vbH = oh / s.scale;

  // Clamp pan (screen-pixel units, mutating s.tx/s.ty in place so a later
  // drag in the opposite direction resumes smoothly instead of first
  // having to "unwind" through a dead zone) so the viewport can never
  // fully separate from the diagram — previously unbounded, letting users
  // drag the diagram arbitrarily far off-screen with no way back short of
  // hitting the reset button. Bound derived from requiring the panned
  // viewBox window to keep at least touching the diagram's original
  // extent: maxPan(viewBox units) = (ow + vbW) / 2, converted to screen
  // pixels via the same vbW/svgW ratio used below, which simplifies to
  // svgW * (scale + 1) / 2 (same shape for the Y axis with oh/svgH/vbH).
  const maxTx = s._svgW * (s.scale + 1) / 2;
  const maxTy = s._svgH * (s.scale + 1) / 2;
  s.tx = Math.min(maxTx, Math.max(-maxTx, s.tx));
  s.ty = Math.min(maxTy, Math.max(-maxTy, s.ty));

  // Convert screen-pixel pan to viewBox units
  const panX = -s.tx * vbW / s._svgW;
  const panY = -s.ty * vbH / s._svgH;

  // Center the zoom window, then apply pan
  const vbX = ox + (ow - vbW) / 2 + panX;
  const vbY = oy + (oh - vbH) / 2 + panY;

  svgEl.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  svgWrap.style.transform = '';
}

function _mermaidZoom(svgWrap, delta) {
  const s = _mermaidState(svgWrap);
  s.scale = Math.min(4, Math.max(0.2, s.scale + delta));
  _mermaidApply(svgWrap);
}

function _mermaidReset(svgWrap) {
  const s = _mermaidState(svgWrap);
  const svgEl = svgWrap.querySelector('svg');
  if (svgEl && s._origVB) {
    const { x, y, w, h } = s._origVB;
    svgEl.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
  s.scale = 1; s.tx = 0; s.ty = 0;
  s._origVB = null; s._svgW = null; s._svgH = null;
  svgWrap.style.transform = '';
}

async function _mermaidExportSvg(svgWrap) {
  const svgEl = svgWrap.querySelector('svg');
  if (!svgEl) throw new Error('no svg');
  const svgStr = new XMLSerializer().serializeToString(svgEl);
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
  await chrome.downloads.download({ url: dataUrl, filename: 'diagram.svg', saveAs: true });
}

function _mermaidInteractions(wrapper, svgWrap) {
  // Wheel zoom
  wrapper.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    _mermaidZoom(svgWrap, e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
  // Drag to pan
  let dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
  svgWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const s = _mermaidState(svgWrap);
    startTx = s.tx; startTy = s.ty;
    svgWrap.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const s = _mermaidState(svgWrap);
    s.tx = startTx + (e.clientX - startX);
    s.ty = startTy + (e.clientY - startY);
    _mermaidApply(svgWrap);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    svgWrap.style.cursor = 'grab';
  });
  svgWrap.style.cursor = 'grab';
}

// ─── ECharts ────────────────────────────────────────────────────────────────
let echartsModule = null; // lazily loaded on first echarts block

async function getEcharts() {
  if (echartsModule) return echartsModule;
  try {
    const mod = await import('../vendor/echarts.bundle.js');
    echartsModule = mod.default || mod;
  } catch (e) {
    console.warn('browsa: echarts load failed', e);
  }
  return echartsModule;
}

function _echartsToolbar(source, chart, container) {
  const ORIG_H = 380;
  let scale = 1;
  const bar = document.createElement('div');
  bar.className = 'mermaid-toolbar'; // reuse same styling
  const zoom = (delta) => {
    scale = Math.min(3, Math.max(0.4, scale + delta));
    const newH = Math.round(ORIG_H * scale);
    container.style.height = newH + 'px';
    // Pass explicit height so ECharts doesn't read stale DOM before reflow
    chart.resize({ height: newH });
  };
  const btns = [
    { title: '放大',    text: '+',  action: () => zoom(0.2) },
    { title: '缩小',    text: '−',  action: () => zoom(-0.2) },
    { title: '重置',    text: '⊙',  action: () => { scale = 1; container.style.height = ORIG_H + 'px'; chart.resize({ height: ORIG_H }); } },
    { title: '复制代码', html: ICONS.copy, action: (btn) => _copyText(source).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500); }).catch(() => {}) },
    { title: '导出PNG', text: '↓',  action: (btn) => {
        const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
        const a = document.createElement('a');
        a.href = url; a.download = 'chart.png'; a.click();
        btn.textContent = '✓'; setTimeout(() => { btn.textContent = '↓'; }, 1500);
      }
    },
  ];
  for (const { title, text, html, action } of btns) {
    const btn = document.createElement('button');
    btn.className = 'mermaid-btn';
    btn.title = title;
    if (html) btn.innerHTML = html; else btn.textContent = text;
    btn.addEventListener('click', (e) => action(e.currentTarget));
    bar.appendChild(btn);
  }
  return bar;
}

// ECharts text fields (title.text, axis/legend labels, series names, etc.)
// render as plain text, not HTML — unlike Mermaid node labels. CAPABILITY_HINTS
// (background.js) already asks the model not to put raw HTML tags there, but
// that's a soft instruction the model can still ignore, so this is the
// deterministic backstop: recursively strip/convert HTML tags from every
// string in the parsed option before handing it to ECharts. <br/> (in any of
// its written forms) becomes a real newline since that's almost always what
// was actually meant; everything else is just stripped, keeping the inner
// text (e.g. "<b>foo</b>" -> "foo" — ECharts text fields can't render bold
// anyway without its own rich-text syntax, so there's nothing to preserve).
export function sanitizeEchartsText(value) {
  if (typeof value === 'string') {
    return value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  }
  if (Array.isArray(value)) return value.map(sanitizeEchartsText);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = sanitizeEchartsText(value[key]);
    return out;
  }
  return value;
}

export async function renderEcharts(el) {
  const blocks = el.querySelectorAll('code.language-echarts');
  if (!blocks.length) return;
  if (!await getEcharts()) return;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent.trim();
    const errDiv = document.createElement('div');
    errDiv.className = 'echarts-error';
    try {
      const option = sanitizeEchartsText(JSON.parse(source));
      const wrapper = document.createElement('div');
      wrapper.className = 'echarts-diagram';
      const container = document.createElement('div');
      container.style.cssText = 'width:100%;height:380px;';
      wrapper.appendChild(container);
      pre.replaceWith(wrapper);
      const chart = echartsModule.init(container);
      chart.setOption(option);
      wrapper.appendChild(_echartsToolbar(source, chart, container));
      // Re-render when container width changes (e.g. panel resize)
      new ResizeObserver(() => chart.resize()).observe(container);
    } catch (e) {
      console.warn('browsa: echarts render failed', e);
      errDiv.textContent = `⚠ ECharts: ${e?.message || e}`;
      pre.replaceWith(errDiv);
    }
  }
}

// ─── Markmap (mind map) ─────────────────────────────────────────────────────
let markmapLibModule = null;
let markmapViewModule = null;

async function getMarkmapLib() {
  if (markmapLibModule) return markmapLibModule;
  try {
    markmapLibModule = await import('../vendor/markmap-lib.bundle.js');
  } catch (e) {
    console.warn('browsa: markmap-lib load failed', e);
  }
  return markmapLibModule;
}

async function getMarkmapView() {
  if (markmapViewModule) return markmapViewModule;
  try {
    markmapViewModule = await import('../vendor/markmap-view.bundle.js');
    // markmap-view expects this stylesheet to exist globally — it doesn't
    // inline per-instance styles the way mermaid/echarts do, so inject it
    // once on first use (same rationale as mermaid's window.katex assignment
    // in getMermaid() above).
    const style = document.createElement('style');
    style.textContent = markmapViewModule.globalCSS;
    document.head.appendChild(style);
  } catch (e) {
    console.warn('browsa: markmap-view load failed', e);
  }
  return markmapViewModule;
}

// Speculative warm-up: called (fire-and-forget, never awaited) as soon as a
// turn starts, so by the time DONE arrives and renderMermaid/renderEcharts/
// renderMarkmap actually run, the vendor bundles are already sitting in the
// browser's module cache — turning "first diagram in this session" from a
// multi-MB cold import into an instant cache hit, same as every diagram
// after the first already was. Safe to call unconditionally on every turn:
// each getXxx() is itself idempotent (checks its own module-level cache
// before importing), so a turn with no diagrams just does nothing extra,
// and calling it repeatedly across turns is a cheap no-op after the first.
export function preloadChartVendors() {
  getMermaid();
  getEcharts();
  getMarkmapLib();
  getMarkmapView();
}

// markmap-view is built on d3-zoom, which stashes the live transform on the
// SVG DOM node as `svgNode.__zoom` (the same field the public
// d3.zoomTransform(node) helper reads internally) — reading it directly here
// avoids pulling in a separate d3 dependency just for this one lookup.
// mermaid's zoom (viewBox mutation) is NOT reused for markmap: markmap-view
// already drives its own zoom/pan via a transform on its inner <g>, and
// mutating the <svg> viewBox on top of that would fight the library's own
// zoom state instead of cooperating with it.
function _markmapScale(svgEl) {
  return svgEl.__zoom?.k ?? 1;
}

// mm.rescale(t) treats `t` as a RELATIVE multiplier applied on top of the
// CURRENT transform (confirmed by reading markmap-view's source: it composes
// the existing transform's k with the given t), not an absolute target scale.
// A real bug this fixes: the zoom buttons used to pre-multiply the current
// scale into the argument themselves (`rescale(current * 1.25)`), so the
// current scale got applied a SECOND time inside rescale() — squaring it.
// Since the diagram starts auto-fit below 1x, squaring a sub-1 number makes
// it SMALLER, so both the + and - buttons visibly shrank the diagram. Fix:
// compute the desired absolute target (clamped to a sane range), then derive
// the relative factor rescale() actually needs to land exactly on it.
function _markmapZoomBy(mm, svgEl, factor) {
  const current = _markmapScale(svgEl);
  if (current <= 0) return;
  const target = Math.min(4, Math.max(0.2, current * factor));
  mm.rescale(target / current);
}

function _markmapToolbar(mm, source, svgEl, wrapper) {
  const bar = document.createElement('div');
  bar.className = 'mermaid-toolbar'; // reuse same styling
  const btns = [
    { title: '放大', text: '+', action: () => _markmapZoomBy(mm, svgEl, 1.25) },
    { title: '缩小', text: '−', action: () => _markmapZoomBy(mm, svgEl, 0.8) },
    { title: '重置', text: '⊙', action: () => mm.fit() },
    { title: '复制代码', html: ICONS.copy, action: (btn) => _copyText(source).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500); }).catch(() => {}) },
    { title: '导出SVG', text: '↓', action: (btn) => _mermaidExportSvg(wrapper).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '↓'; }, 1500); }).catch(() => {}) },
  ];
  for (const { title, text, html, action } of btns) {
    const btn = document.createElement('button');
    btn.className = 'mermaid-btn';
    btn.title = title;
    if (html) btn.innerHTML = html; else btn.textContent = text;
    btn.addEventListener('click', (e) => { e.stopPropagation(); action(btn); });
    bar.appendChild(btn);
  }
  return bar;
}

export async function renderMarkmap(el) {
  const blocks = el.querySelectorAll('code.language-markmap');
  if (!blocks.length) return;
  // markmap-lib (1.7MB) and markmap-view (80KB) have no dependency on each
  // other — loading them sequentially wastes markmap-view's entire fetch/
  // parse time behind markmap-lib's much larger one. Load in parallel.
  const [lib, view] = await Promise.all([getMarkmapLib(), getMarkmapView()]);
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent;
    // markmap-view needs a DOM-attached <svg> to measure node text extents
    // during layout, so the wrapper is inserted (replacing the placeholder
    // <pre>) BEFORE calling Markmap.create — unlike renderMermaid/
    // renderEcharts, whose risky work all happens before their own
    // replaceWith. That means a failure past this point must replace the
    // wrapper (now the thing actually in the DOM), not the already-detached
    // `pre`.
    const wrapper = document.createElement('div');
    wrapper.className = 'markmap-diagram';
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'markmap-svg');
    wrapper.appendChild(svgEl);
    pre.replaceWith(wrapper);
    try {
      if (!lib || !view) throw new Error('markmap 模块加载失败，请检查控制台');
      const { root } = new lib.Transformer().transform(source);
      const mm = view.Markmap.create(svgEl, {}, root);
      wrapper.appendChild(_markmapToolbar(mm, source, svgEl, wrapper));
      // Re-fit when the container width changes (e.g. side panel resize),
      // same rationale as renderEcharts's ResizeObserver -> chart.resize().
      new ResizeObserver(() => mm.fit()).observe(wrapper);
    } catch (e) {
      console.warn('browsa: markmap render failed', e);
      const errDiv = document.createElement('div');
      errDiv.className = 'markmap-error';
      errDiv.innerHTML =
        `<span>⚠ Markmap: ${escM(e?.message || String(e))}</span>` +
        `<button class="markmap-err-copy">复制代码</button>` +
        `<details><summary>查看源码</summary><pre class="markmap-err-src">${escM(source)}</pre></details>`;
      errDiv.querySelector('.markmap-err-copy').addEventListener('click', (e2) => {
        _copyText(source).then(() => { e2.target.textContent = '✓'; setTimeout(() => { e2.target.textContent = '复制代码'; }, 1500); }).catch(() => {});
      });
      wrapper.replaceWith(errDiv);
    }
  }
}

// ─── Diff syntax highlighting ─────────────────────────────────────────────────
export function highlightDiffBlocks(el) {
  for (const code of el.querySelectorAll('code.language-diff, code.language-patch')) {
    if (code.dataset.diffDone) continue;
    code.dataset.diffDone = '1';
    const lines = code.textContent.split('\n');
    code.textContent = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const span = document.createElement('span');
      if (/^@@/.test(line))       span.className = 'diff-hunk';
      else if (line.startsWith('+')) span.className = 'diff-add';
      else if (line.startsWith('-')) span.className = 'diff-del';
      span.textContent = line;
      code.appendChild(span);
      if (i < lines.length - 1) code.appendChild(document.createTextNode('\n'));
    }
  }
}

// Add a copy button to each think-block <summary> (idempotent).
// root defaults to '#messages' (main chat: only .msg.assistant bubbles get
// copy buttons). Pass an explicit element (e.g. a detail-thread card's AI
// bubble) to scope everything to just that element instead.
export function addThinkCopyButtons(el) {
  for (const details of (el || document.getElementById('messages')).querySelectorAll('.think-block:not([data-copy-added])')) {
    details.dataset.copyAdded = '1';
    const summary = details.querySelector('summary');
    if (!summary) continue;
    const btn = document.createElement('button');
    btn.className = 'think-copy-btn';
    btn.title = 'Copy thinking';
    btn.innerHTML = ICONS.copy;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't toggle the details
      const body = details.querySelector('.think-body');
      try {
        await _copyText(body?.textContent || '');
        btn.textContent = '✓';
        setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500);
      } catch (_) {}
    });
    summary.appendChild(btn);
  }
}

export function addCodeCopyButtons(root) {
  const scoped = root != null;
  const messagesEl = document.getElementById('messages');
  highlightDiffBlocks(scoped ? root : messagesEl);
  addThinkCopyButtons(scoped ? root : messagesEl);
  const pres = scoped ? root.querySelectorAll('pre') : messagesEl.querySelectorAll('.msg.assistant pre');
  for (const pre of pres) {
    // Add language label (from code[class*="language-xxx"])
    const code = pre.querySelector('code[class*="language-"]');
    if (code && !pre.hasAttribute('data-lang')) {
      const cls = code.className.match(/language-(\w+)/);
      if (cls) pre.setAttribute('data-lang', cls[1]);
    }

    // Apply syntax highlighting via highlight.js (skip mermaid + diff — handled separately)
    if (code && !code.dataset.highlighted) {
      const lang = code.className.match(/language-(\w+)/)?.[1];
      if (lang && lang !== 'mermaid' && lang !== 'markmap' && lang !== 'diff' && lang !== 'patch') {
        try {
          const result = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true });
          code.innerHTML = result.value;
          code.dataset.highlighted = '1';
        } catch (_) {
          // Language not supported — try auto-detect for unknown blocks
          if (lang === 'text' || lang === 'plain' || lang === 'plaintext') {
            // skip
          } else {
            try {
              const result = hljs.highlightAuto(code.textContent, { subset: ['python','javascript','typescript','java','c','cpp','go','rust','ruby','php','swift','kotlin','sql','bash','shell','json','yaml','xml','html','css'] });
              if (result.relevance > 5) { code.innerHTML = result.value; code.dataset.highlighted = '1'; }
            } catch (_2) {}
          }
        }
      }
    }

    if (pre.querySelector('.code-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const text = code?.textContent || pre.textContent || '';
      try {
        await _copyText(text);
        btn.textContent = '✓';
        showToast('Copied', 'success');
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      } catch (_) {}
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}

// ─── CJK + emphasis-delimiter spacing fix ──────────────────────────────────
// Two distinct model quirks break CommonMark's emphasis flanking rule for
// **bold** spans, both fixed in one pass over matched **...** pairs (not
// independent regexes each scanning for a local pattern — see below for why
// that combination actively fought itself):
//
// 1. CJK-adjacent punctuation: a ** delimiter can't open/close when it
//    directly touches a CJK character on one side AND punctuation (e.g. a
//    quote mark) on the other, with no space — marked.js then renders it as
//    literal asterisks instead of <strong>. Verified directly against this
//    project's marked bundle: 用一个**"x"**因子 fails to bold, 用一个 **"x"**
//    因子 (space added) and 用一个**x**因子 (no punctuation inside) both work.
// 2. Internal padding: models sometimes pad spans with whitespace just
//    inside the delimiters (e.g. "** text **" or "**text **"), presumably
//    overcorrecting for quirk #1. A delimiter run must NOT be followed
//    (opening) / preceded (closing) by whitespace to flank — so "** text **"
//    also renders as literal asterisks.
//
// CAPABILITY_HINTS in background.js already asks the model to avoid both,
// but models don't always comply — this is a deterministic backstop.
//
// An earlier version fixed these independently: a trim pass for #2, then
// two local-window regexes for #1 (CJK char + ** + punctuation-lookahead,
// fired unconditionally wherever that 3-character pattern appeared). That
// regex can't tell whether the ** it's looking at is an *opening* or a
// *closing* delimiter of some other bold span — so for ordinary
// "**bold内容**：" (a valid closing ** immediately preceded by CJK content
// and followed by punctuation, needing no fix), it fired anyway and
// inserted a space between the CJK content and the closing **, which
// *reintroduced* a broken whitespace-preceded closing delimiter — undoing
// the trim pass for the single most common shape of this bug. Matching
// **...** as pairs first and checking only the true boundary chars (before
// the opening delimiter / after the closing one, vs. the first/last char of
// the trimmed inner content) avoids that ambiguity entirely.
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/;
const PUNCT_RE = /\p{P}/u;
const BOLD_SPAN_RE = /\*\*([^\n*]*?)\*\*/g;
export function fixBoldSpans(text) {
  let result = '';
  let last = 0;
  let m;
  BOLD_SPAN_RE.lastIndex = 0;
  while ((m = BOLD_SPAN_RE.exec(text))) {
    const start = m.index, end = start + m[0].length;
    const inner = m[1].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (!inner) { result += text.slice(last, end); last = end; continue; }
    const before = text[start - 1] || '';
    const after = text[end] || '';
    const openPad = (CJK_RE.test(before) && PUNCT_RE.test(inner[0])) ? ' ' : '';
    const closePad = (CJK_RE.test(after) && PUNCT_RE.test(inner[inner.length - 1])) ? ' ' : '';
    result += text.slice(last, start) + openPad + '**' + inner + '**' + closePad;
    last = end;
  }
  return result + text.slice(last);
}

export function fixCjkEmphasisSpacing(text) {
  if (!text) return text;
  // Split on fenced code blocks and inline code spans first so real code
  // (e.g. Python's x**2) is never touched — only the prose segments in
  // between (even indices) get the fix applied.
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => {
    if (i % 2 === 1) return part;
    return fixBoldSpans(part);
  }).join('');
}

// Markdown -> sanitized HTML pipeline with proper LaTeX rendering.
//
// Order of operations matters:
//   1. Extract $...$ and $$...$$ BEFORE marked so markdown syntax (_, *, etc.)
//      inside formulas doesn't get mangled.
//   2. Parse the placeholder-substituted markdown with marked.
//   3. Sanitize with DOMPurify (placeholders are plain text — safe, survive).
//   4. Replace placeholders with KaTeX MathML output AFTER sanitization so
//      DOMPurify never sees (or strips) MathML attributes.
//
// Chrome 114+ supports MathML Core natively, so output:'mathml' works with
// zero extra CSS or font files.

// Lightweight markdown render used during streaming (skips KaTeX + think blocks).
export function renderStreamingSafe(text) {
  try {
    return DOMPurify.sanitize(marked.parse(fixCjkEmphasisSpacing(text || '')), {
      ADD_ATTR: ['target', 'rel']
    });
  } catch (_) {
    return DOMPurify.sanitize(text || '');
  }
}

export async function renderSafe(markdown) {
  try {
    const mathParts = []; // { displayMode: bool, formula: string }
    const thinkBlocks = []; // extracted <think>…</think> content

    let md = fixCjkEmphasisSpacing(markdown || '')
      // Extract <think>/<thinking> blocks before marked (handles Claude + DeepSeek).
      // Whitespace-only think blocks (a reasoning model's empty think around a
      // trivial reply) are dropped outright — an empty collapsible that just
      // says "thinking" reads as a bug to the user.
      .replace(/<(?:think|thinking|antml:thinking)[^>]*>([\s\S]*?)<\/(?:think|thinking|antml:thinking)>/gi, (_, content) => {
        const trimmed = content.trim();
        if (!trimmed) return '\n\n';
        const i = thinkBlocks.push(trimmed) - 1;
        return `\n\n<div data-think="${i}"></div>\n\n`;
      })
      // Block math: $$...$$ or \[...\]
      .replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (_, a, b) => {
        const i = mathParts.push({ displayMode: true,  formula: (a ?? b).trim() }) - 1;
        return `\n\nBROWSAMATH${i}END\n\n`;
      })
      // Inline math: $...$ or \(...\)
      .replace(/\$([^$\n]+?)\$|\\\(([^)]+?)\\\)/g, (_, a, b) => {
        const i = mathParts.push({ displayMode: false, formula: (a ?? b).trim() }) - 1;
        return `BROWSAMATH${i}END`;
      });

    let html = marked.parse(md);

    html = DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel', 'data-think']
    });

    // Restore rendered math after sanitization — KaTeX output is trusted.
    // Rendering happens off the main thread for message-sized batches of
    // formulas (see katex-worker-client.js); small batches stay synchronous
    // with zero added latency. Results are resolved BEFORE the replace pass
    // below, since a regex replace callback can't itself be async.
    if (mathParts.length > 0) {
      const mathResults = await renderMathBatch(mathParts);
      html = html.replace(/BROWSAMATH(\d+)END/g, (_, idx) => {
        const part = mathParts[+idx];
        // A reply echoing the literal placeholder string (model quoting our
        // own output) would destructure undefined and throw — the outer
        // catch downgrades the ENTIRE message to escaped plain text.
        if (!part) return '';
        const { displayMode, formula } = part;
        const result = mathResults[+idx];
        if (result?.ok) return result.html;
        return displayMode
          ? `<div class="math-block">${escM(formula)}</div>`
          : `<code>${escM(formula)}</code>`;
      });
    }

    // Restore think blocks as collapsible <details> elements (after sanitization
    // so DOMPurify never sees the raw inner content). The summary is a done-state
    // noun ("思考过程"/"Thought process") — the stream is over by the time this
    // renders, and a permanent "Thinking…" progress label on finished messages
    // reads as something still in flight.
    if (thinkBlocks.length > 0) {
      const openAttr = thoughtAutoCollapse ? '' : ' open';
      html = html.replace(/<div data-think="(\d+)"><\/div>/g, (_, idx) => {
        const content = thinkBlocks[+idx];
        // Literal <div data-think="7"> in the reply (survives DOMPurify via
        // ALLOW_DATA_ATTR) must not crash the whole render.
        if (content == null) return '';
        const inner = DOMPurify.sanitize(marked.parse(fixCjkEmphasisSpacing(content)));
        return `<details class="think-block"${openAttr}><summary>${_msg('thinkDoneTitle', 'Thought process')}</summary><div class="think-body">${inner}</div></details>`;
      });
    }

    return html;
  } catch (e) {
    return DOMPurify.sanitize(
      (markdown || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;'
      }[c]))
    );
  }
}

// After every innerHTML update, ensure external links open in new tab with
// rel="noopener noreferrer". Cheap (runs on the bubble subtree only).
export function decorateLinks(el) {
  for (const a of el.querySelectorAll('a[href]')) {
    if (a.host && a.host !== location.host) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
}

// Wrap [mm:ss] / [h:mm:ss] timestamps (and BiliNote-style *Content-[mm:ss]
// markers, in case the model emits them) in clickable spans so video-note
// replies can seek the video in place. Operates on TEXT nodes only via a
// TreeWalker, so it never disturbs the surrounding HTML; skips text inside
// <script>/<style>/<a>. Spans (not <a>) are used on purpose so decorateLinks
// can't mis-tag them as external links. The actual seek happens via a
// delegated click handler in sidepanel.js reading data-s + the bubble's
// data-video-src.
// 兼容 [mm:ss] 单点与 [mm:ss, mm:ss] / [mm:ss-mm:ss] 区间（模型会输出逗号区间——真实案例
// 2026-08-24）；区间点击跳转取起始时刻（m[1..3]），分隔符类 [-,\s] 与 ASR 归一化保持一致。
const _TS_TEST_RE = /(?:\*Content-)?\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:(?:\s*[-,]\s*|\s+)(?:(?:\d+):)?\d{1,3}:\d{2})*\]/;
const _TS_RE = /(?:\*Content-)?\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:(?:\s*[-,]\s*|\s+)(?:(?:\d+):)?\d{1,3}:\d{2})*\]/g;
export function linkifyTimestamps(el) {
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.includes('[')) return NodeFilter.FILTER_REJECT;
      let p = node.parentNode;
      while (p && p !== el) {
        const nn = p.nodeName;
        if (nn === 'SCRIPT' || nn === 'STYLE' || nn === 'A') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return _TS_TEST_RE.test(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue;
    _TS_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    let any = false;
    while ((m = _TS_RE.exec(text))) {
      any = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const seconds = (m[1] ? parseInt(m[1], 10) : 0) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      const span = document.createElement('span');
      span.className = 'browsa-ts';
      span.dataset.s = String(seconds);
      span.setAttribute('role', 'button');
      span.setAttribute('tabindex', '0');
      span.title = `跳转到 ${m[0].replace(/^\*Content-/, '')}`;
      span.textContent = m[0].replace(/^\*Content-/, ''); // strip BiliNote prefix in display
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (!any) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// Matches <think> / <thinking> opening and closing tags (Claude, DeepSeek, etc.)
const _THINK_OPEN_RE  = /<(think|antml:thinking)(\s[^>]*)?>|<thinking>/i;
const _THINK_CLOSE_RE = /<\/(think|antml:thinking)>|<\/thinking>/i;

// Build a streaming-render closure for a specific bubble.
// During streaming:
//   - <think>/<thinking> content shown in a live collapsible element above the bubble
//   - Non-think text rendered each tick via renderStreamingSafe (marked + DOMPurify)
// At DONE: live think removed; full renderSafe() handles KaTeX + final think blocks.
//
// `onDone(el, delta)` is called once the stream finishes and el.innerHTML has
// already been set to the final renderSafe(delta) output — sidepanel.js
// passes a callback that wires up addMsgActions/scrollToBottom, since those
// are sidepanel.js-owned UI concerns this module doesn't need to know about.
export function makeStreamRenderer(el, { onTick, onDone } = {}) {
  let fullAccum = '';
  let raf = null;
  let thinkEl = null;
  let thinkBodyEl = null;

  function ensureThinkEl() {
    if (!thinkEl) {
      thinkEl = document.createElement('details');
      thinkEl.className = 'think-block live-think';
      thinkEl.open = !thoughtAutoCollapse;
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking…';
      thinkBodyEl = document.createElement('div');
      thinkBodyEl.className = 'think-body';
      thinkEl.appendChild(sum);
      thinkEl.appendChild(thinkBodyEl);
      el.parentNode.insertBefore(thinkEl, el);
    }
  }

  // Split accumulated text into display (non-think) and think portions.
  // Scans the full buffer each tick so partial tags across chunk boundaries are handled.
  function splitThink(text) {
    let display = '';
    let think = '';
    let rest = text;
    let inside = false;
    while (rest.length > 0) {
      if (!inside) {
        const m = _THINK_OPEN_RE.exec(rest);
        if (!m) { display += rest; break; }
        display += rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        inside = true;
      } else {
        const m = _THINK_CLOSE_RE.exec(rest);
        if (!m) { think += rest; break; }
        think += rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        inside = false;
        if (thinkEl) thinkEl.open = false; // collapse once tag closed
      }
    }
    return { display, think };
  }

  // Deltas pass through a pacer (markstream-core) before hitting fullAccum/raf,
  // so a bursty single delta (e.g. one big paragraph) reveals smoothly instead
  // of jumping. Pacing only affects the timing of intermediate ticks — the
  // isDone branch below is untouched and always renders the caller's exact
  // final text immediately, regardless of pacer backlog.
  const pacer = createRevealPacer((revealedDelta) => {
    fullAccum += revealedDelta;
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const { display, think } = splitThink(fullAccum);
      // Render as markdown (same renderStreamingSafe path as the main
      // display text) instead of textContent — otherwise live thinking
      // shows raw markdown syntax (lists, bold, code) as literal characters,
      // then snaps to properly-rendered markdown the instant the stream
      // finishes and the final renderSafe() think-block pass takes over.
      if (think) { ensureThinkEl(); thinkBodyEl.innerHTML = renderStreamingSafe(think); }
      el.innerHTML = renderStreamingSafe(display);
      el.classList.remove('done');
      onTick?.(el);
    });
  });

  const renderStream = async function renderStream(delta, isDone) {
    if (isDone) {
      pacer.destroy();
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (thinkEl) { thinkEl.remove(); thinkEl = null; thinkBodyEl = null; }
      el.innerHTML = await renderSafe(delta);
      el.classList.add('done');
      el.dataset.raw = delta; // raw markdown, mirrors appendUser's dataset.raw — read by openDetailThread
      addThinkCopyButtons(el);
      decorateLinks(el);
      linkifyTimestamps(el);
      onDone?.(el, delta);
      return;
    }
    pacer.enqueue(delta);
  };
  // Exposed so callers that reassign renderStream mid-stream (before isDone
  // ever fires — e.g. a RETRY or a tab-switch DOM-identity change) can clean
  // up the abandoned pacer instead of leaving it to reveal into a stale el.
  renderStream.destroy = () => {
    pacer.destroy();
    // A raf already scheduled by the last pacer tick would still fire once
    // after destroy, repainting the abandoned attempt into a possibly
    // re-targeted bubble (RETRY / tab-switch paths).
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  };
  return renderStream;
}
