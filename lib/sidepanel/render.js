// lib/sidepanel/render.js — Markdown/Mermaid/ECharts/Markmap rendering pipeline for sidepanel.js.
// Extracted verbatim (Phase 3 of the sidepanel/background modularization
// refactor) from what used to be ~900 lines spread through sidepanel.js.

import marked from '../vendor/marked.bundle.js';
import DOMPurify from '../vendor/purify.bundle.js';
import hljs from '../vendor/highlight.bundle.js';
import { ICONS } from './icons.js';
import { escM, _copyText, showToast, sendMessage } from './ui-utils.js';
import { createRevealPacer } from './reveal-pacer.js';
import { renderMathBatch } from './katex-worker-client.js';
import { estimateMermaidPreviewHeight, clampMermaidPreviewHeight, renderMermaidWithRetry, formatMermaidParseError } from './mermaid-utils.js';
import { addMathCopyButtons } from './math-copy.js';
import { t as _t } from '../i18n.js';

// Configure marked: GitHub-flavored breaks for line breaks.
// DOMPurify handles XSS sanitization downstream.
marked.setOptions({
  gfm: true,
  breaks: true
});

// Auto-collapse <thinking> blocks — set from sidepanel.js's init()/storage
// listener (user preference), read by renderSafe/makeStreamRenderer below.
// 默认折叠（用户反馈展开不好看）；sidepanel 侧以 cfg.thoughtAutoCollapse !== false
// 传入——storage 里显式存过 false（用户取消勾选）才展开。
let thoughtAutoCollapse = true;
export function setThoughtAutoCollapse(v) { thoughtAutoCollapse = !!v; }

import { t, tSub } from '../i18n.js';
// 既有调用点保留短别名；t() 解析顺序：显式语言字典 → chrome.i18n → 内联 fallback
// （jsdom 无 chrome.i18n 时显示源文案，测试零扰动）。
const _msg = t;

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
let sanitizeModule = null; // stream-markdown-parser (388KB) — only ever used
                           // for sanitizeMermaidSvg, so it lazy-loads with the
                           // first mermaid block instead of at panel startup

async function getSanitizeMermaidSvg() {
  if (!sanitizeModule) sanitizeModule = import('../vendor/stream-markdown-parser.bundle.js');
  return (await sanitizeModule).sanitizeMermaidSvg;
}

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
      if (!m) throw new Error(_msg('mermaidLoadFailed', 'mermaid 模块加载失败，请检查控制台'));
      await _replaceWithMermaid(m, source, pre, host);
    } catch (e) {
      console.warn('browsa: mermaid render failed', e);
      _showMermaidError(m, errDiv, pre, source, e);
    }
  }
  document.body.removeChild(host);
}

// 渲染 source 并用渲染结果替换 replaceEl。host 传调用方的共享离屏测量容器
// （主渲染路径一个循环复用）；不传则自建自删——AI 修复重绘路径在错误卡就地
// 换图时没有共享 host 可用。返回已插入 DOM 的 wrapper。
async function _replaceWithMermaid(m, source, replaceEl, host = null) {
  const ownHost = host || _makeOffscreenHost(replaceEl?.clientWidth);
  try {
    const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
    const { svg } = await renderMermaidWithRetry(m, id, source, ownHost);
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
    const sanitizeMermaidSvg = await getSanitizeMermaidSvg();
    svgWrap.innerHTML = sanitizeMermaidSvg(svg) ?? '';
    wrapper.appendChild(svgWrap);
    wrapper.appendChild(_mermaidToolbar(svgWrap, source));
    _mermaidInteractions(wrapper, svgWrap);
    replaceEl.replaceWith(wrapper);
    return wrapper;
  } finally {
    if (!host) ownHost.remove();
  }
}

function _makeOffscreenHost(widthPx) {
  const host = document.createElement('div');
  // 与主渲染路径同一宽度来源：侧栏实际宽度（280px 兜底），避免 mermaid 按
  // 猜测的画布宽度布局再被压缩变形。
  host.style.cssText = `position:fixed;left:-9999px;top:0;width:${Math.max(widthPx || 0, 280)}px;opacity:0;pointer-events:none`;
  document.body.appendChild(host);
  return host;
}

// 错误卡：parse error 只亮短句（行号 + 出错原文），完整 token 转储收进「查看
// 源码」；修图按钮把坏源码发给当前 provider（REPAIR_MERMAID），修复稿先过本地
// mermaid parse 校验，通过才就地替换错误卡——替换失败则按钮复位可重试。
function _showMermaidError(m, errDiv, pre, source, err) {
  const raw = String(err?.message || err);
  const parsed = formatMermaidParseError(raw);
  const short = parsed
    ? tSub('mermaidSyntaxErrAt', '第 $1 行语法错误：$2', parsed.line, parsed.excerpt.slice(0, 80))
    : raw;
  errDiv.innerHTML =
    `<span>⚠ Mermaid: ${escM(short)}</span>` +
    (m ? `<button type="button" class="mermaid-err-fix">${_msg('mermaidAIFix', 'AI 修复重绘')}</button>` : '') +
    `<button type="button" class="mermaid-err-copy">${_msg('mermaidCopyCode', '复制代码')}</button>` +
    `<details><summary>${_msg('mermaidViewSource', '查看源码')}</summary><pre class="mermaid-err-src">${escM(source)}</pre>${parsed ? `<pre class="mermaid-err-src">${escM(raw)}</pre>` : ''}</details>`;
  errDiv.querySelector('.mermaid-err-copy').addEventListener('click', (btn) => {
    _copyText(source).then(() => { btn.target.textContent = '✓'; setTimeout(() => { btn.target.textContent = _msg('mermaidCopyCode', '复制代码'); }, 1500); }).catch(() => {});
  });
  const fixBtn = errDiv.querySelector('.mermaid-err-fix');
  if (fixBtn) {
    fixBtn.addEventListener('click', async () => {
      if (fixBtn.disabled) return;
      fixBtn.disabled = true;
      fixBtn.textContent = _msg('mermaidFixing', '修图中…');
      try {
        const res = await sendMessage({ type: 'REPAIR_MERMAID', source, error: raw });
        const fixed = res?.data?.source;
        if (!res?.data?.ok || !fixed) throw new Error(res?.data?.error || 'empty reply');
        await m.parse(fixed); // 修复稿必须本地 parse 通过才上屏
        await _replaceWithMermaid(m, fixed, errDiv, null);
      } catch (e2) {
        console.warn('browsa: mermaid AI fix failed', e2);
        showToast(tSub('mermaidFixFailed', '修复失败：$1', String(e2?.message || e2).slice(0, 120)));
        fixBtn.disabled = false;
        fixBtn.textContent = _msg('mermaidAIFix', 'AI 修复重绘');
      }
    });
  }
  pre.replaceWith(errDiv);
}

// Shared toolbar builder for the three diagram renderers (mermaid / echarts /
// markmap). They all paint the same `.mermaid-toolbar` bar of `.mermaid-btn`
// buttons and differ only in the button list — the DOM plumbing lives here so a
// styling or interaction change happens once. `specs` is a list of
// { title, text?, html?, action(btn) }.
function _diagramToolbar(specs) {
  const bar = document.createElement('div');
  bar.className = 'mermaid-toolbar'; // shared styling class across all three
  for (const { title, text, html, action } of specs) {
    const btn = document.createElement('button');
    btn.className = 'mermaid-btn';
    btn.title = title;
    if (html) btn.innerHTML = html; else btn.textContent = text;
    btn.addEventListener('click', (e) => { e.stopPropagation(); action(btn); });
    bar.appendChild(btn);
  }
  return bar;
}

// Shared "copy diagram source" button action (identical across diagrams).
function _copyCodeAction(source) {
  return (btn) => _copyText(source)
    .then(() => { btn.textContent = '✓'; setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500); })
    .catch(() => {});
}

// Shared "export diagram to a file" button action: flash ✓ then restore `label`.
function _exportAction(label, run) {
  return (btn) => run()
    .then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = label; }, 1500); })
    .catch(() => {});
}

function _mermaidToolbar(svgWrap, source) {
  return _diagramToolbar([
    { title: _msg('mermaidZoomIn', '放大'), text: '+', action: () => _mermaidZoom(svgWrap, 0.2) },
    { title: _msg('mermaidZoomOut', '缩小'), text: '−', action: () => _mermaidZoom(svgWrap, -0.2) },
    { title: _msg('mermaidReset', '重置'), text: '⊙', action: () => _mermaidReset(svgWrap) },
    { title: _msg('mermaidCopyCode', '复制代码'), html: ICONS.copy, action: _copyCodeAction(source) },
    { title: _msg('mermaidExportSvg', '导出SVG'), text: '↓', action: _exportAction('↓', () => _mermaidExportSvg(svgWrap)) },
  ]);
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
  // Drag to pan. The window mousemove/mouseup handlers are attached ONCE at
  // module scope (below) and keyed off a single `_mermaidDrag` slot — NOT added
  // per diagram. render.js re-renders every diagram on every history
  // re-render, so per-diagram window listeners leaked: each anonymous handler
  // closed over its own svgWrap and could never be removed, growing without
  // bound (and slowing every mousemove dispatch).
  svgWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const s = _mermaidState(svgWrap);
    _mermaidDrag = { svgWrap, startX: e.clientX, startY: e.clientY, startTx: s.tx, startTy: s.ty };
    svgWrap.style.cursor = 'grabbing';
    e.preventDefault();
  });
  svgWrap.style.cursor = 'grab';
}

let _mermaidDrag = null;
if (typeof window !== 'undefined') {  window.addEventListener('mousemove', (e) => {
    if (!_mermaidDrag) return;
    const { svgWrap, startX, startY, startTx, startTy } = _mermaidDrag;
    const s = _mermaidState(svgWrap);
    s.tx = startTx + (e.clientX - startX);
    s.ty = startTy + (e.clientY - startY);
    _mermaidApply(svgWrap);
  });
  window.addEventListener('mouseup', () => {
    if (!_mermaidDrag) return;
    _mermaidDrag.svgWrap.style.cursor = 'grab';
    _mermaidDrag = null;
  });
}

// ResizeObserver registry. ECharts/markmap observe their container to re-fit on
// panel resize, but a ResizeObserver holds a strong ref to its target until
// disconnected — and renderHistory wipes and rebuilds the whole message list,
// orphaning every observer (and the chart behind it). Track them here and
// disconnect the batch at the start of each renderHistory so detached charts
// don't accumulate.
const _chartObservers = new Set();
function _observeResize(target, cb) {
  const ro = new ResizeObserver(cb);
  ro.observe(target);
  _chartObservers.add(ro);
}
export function disposeChartObservers() {
  for (const ro of _chartObservers) { try { ro.disconnect(); } catch (_) {} }
  _chartObservers.clear();
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
  const zoom = (delta) => {
    scale = Math.min(3, Math.max(0.4, scale + delta));
    const newH = Math.round(ORIG_H * scale);
    container.style.height = newH + 'px';
    // Pass explicit height so ECharts doesn't read stale DOM before reflow
    chart.resize({ height: newH });
  };
  return _diagramToolbar([
    { title: _msg('mermaidZoomIn', '放大'),    text: '+',  action: () => zoom(0.2) },
    { title: _msg('mermaidZoomOut', '缩小'),    text: '−',  action: () => zoom(-0.2) },
    { title: _msg('mermaidReset', '重置'),    text: '⊙',  action: () => { scale = 1; container.style.height = ORIG_H + 'px'; chart.resize({ height: ORIG_H }); } },
    { title: _msg('mermaidCopyCode', '复制代码'), html: ICONS.copy, action: _copyCodeAction(source) },
    { title: _msg('mermaidExportPng', '导出PNG'), text: '↓',  action: (btn) => {
        _downloadDataUrl(chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' }), 'chart.png');
        btn.textContent = '✓'; setTimeout(() => { btn.textContent = '↓'; }, 1500);
      }
    },
  ]);
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
      _observeResize(container, () => chart.resize());
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
  getSmilesDrawer();
  get3Dmol();
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
  return _diagramToolbar([
    { title: _msg('mermaidZoomIn', '放大'), text: '+', action: () => _markmapZoomBy(mm, svgEl, 1.25) },
    { title: _msg('mermaidZoomOut', '缩小'), text: '−', action: () => _markmapZoomBy(mm, svgEl, 0.8) },
    { title: _msg('mermaidReset', '重置'), text: '⊙', action: () => mm.fit() },
    { title: _msg('mermaidCopyCode', '复制代码'), html: ICONS.copy, action: _copyCodeAction(source) },
    { title: _msg('mermaidExportSvg', '导出SVG'), text: '↓', action: _exportAction('↓', () => _mermaidExportSvg(wrapper)) },
  ]);
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
      _observeResize(wrapper, () => mm.fit());
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
    btn.title = _t('copyThinkingTitle', 'Copy thinking');
    btn.setAttribute('aria-label', btn.title);
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

// The fenced-block live renderers, in fan-out order. ONE home: the bubble
// decoration pass iterates this list, and the highlight.js skip list derives
// from it (+ diff/patch, which are highlight-only). Adding a renderer = one
// entry here + its renderXxx export — the three call sites (DONE, history
// upgrade, detail-thread postRender) follow automatically via
// addRichRenderFeatures. (CAPABILITY_HINTS and AGENT_RENDER_HINT mirror this
// list as PROMPT TEXT — they are byte-stable for KV-cache reasons and are
// updated by hand, deliberately.)
export const FENCED_RENDERERS = ['mermaid', 'echarts', 'markmap', 'smiles', 'pdb', 'nn'];
const HLJS_SKIP_LANGS = new Set([...FENCED_RENDERERS, 'diff', 'patch']);
// True when `text` contains a fence in any live-rendered language — the
// trigger for speculatively warming the multi-MB diagram vendor bundles
// (see sidepanel.js's gated preloadChartVendors call sites). Built from
// FENCED_RENDERERS so the sniff and the renderer list can never drift.
const FENCE_LANG_RE = new RegExp('```[ \\t]*(?:' + FENCED_RENDERERS.join('|') + ')\\b', 'i');
export function wantsChartVendors(text) {
  return typeof text === 'string' && FENCE_LANG_RE.test(text);
}
// Function declarations hoist, so this initializer can sit above their
// definitions in the file.
const RENDERER_FNS = {
  mermaid: (el) => renderMermaid(el),
  echarts: (el) => renderEcharts(el),
  markmap: (el) => renderMarkmap(el),
  smiles: (el) => renderSmiles(el),
  pdb: (el) => renderPdb(el),
  nn: (el) => renderNn(el),
};

// highlightAuto 的语法子集——声明语言失败与用户气泡裸围栏自动检测共用一份，
// 勿两处各写一份（lockstep）。
const _HLJS_AUTO_SUBSET = ['python','javascript','typescript','java','c','cpp','go','rust','ruby','php','swift','kotlin','sql','bash','shell','json','yaml','xml','html','css'];

// autoDetect：no-lang 围栏也跑 hljs.highlightAuto（相关性 >5 才采纳）。默认关——
// 助手气泡维持原行为（只有声明语言失败才兜底检测）；用户气泡开（用户经常懒得
// 写语言标签，见 appendUser 的调用）。
export function addCodeCopyButtons(root, { autoDetect = false } = {}) {
  const scoped = root != null;
  const messagesEl = document.getElementById('messages');
  highlightDiffBlocks(scoped ? root : messagesEl);
  addThinkCopyButtons(scoped ? root : messagesEl);
  const pres = scoped ? root.querySelectorAll('pre') : messagesEl.querySelectorAll('.msg.assistant pre');
  for (const pre of pres) {
    // Add language label (from code[class*="language-xxx"])
    // 裸 code（无 language- 类）也要解析出来——no-lang 围栏要进 autoDetect 分支、
    // extractCodeText 直读 textContent；此前裸 code 下 code=null，整个高亮块被
    // 无声跳过（也是旧 catch 兜底死了多年没人发现的原因）。
    const code = pre.querySelector('code[class*="language-"]') || pre.querySelector('code');
    if (code && !pre.hasAttribute('data-lang')) {
      const cls = code.className.match(/language-(\w+)/);
      if (cls) pre.setAttribute('data-lang', cls[1]);
    }

    // Apply syntax highlighting via highlight.js (skip mermaid + diff — handled separately;
    // skip our own renderer languages — no hljs grammar exists for them and the attempt
    // logs a console warning per block)
    if (code && !code.dataset.highlighted) {
      const lang = code.className.match(/language-(\w+)/)?.[1];
      if (lang && !HLJS_SKIP_LANGS.has(lang)) {
        try {
          const result = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true });
          code.innerHTML = result.value;
          code.dataset.highlighted = '1';
        } catch (_) {
          // Language not supported — try auto-detect for unknown blocks.
          // highlightAuto 的第二参是语言数组本体（位置参数），不是选项对象——
          // 旧代码传 {subset:[...]} 一直在内部抛 m.filter is not a function
          // 且被静默吞掉，这个兜底实际从未生效过（2026-09-26 修）。
          if (lang === 'text' || lang === 'plain' || lang === 'plaintext') {
            // skip
          } else {
            try {
              const result = hljs.highlightAuto(code.textContent, _HLJS_AUTO_SUBSET);
              if (result.relevance > 5) { code.innerHTML = result.value; code.dataset.highlighted = '1'; }
            } catch (_2) {}
          }
        }
      } else if (!lang && autoDetect) {
        // 用户气泡裸围栏（没写语言标签）——自动检测，检不出就保持纯等宽
        try {
          const result = hljs.highlightAuto(code.textContent, _HLJS_AUTO_SUBSET);
          if (result.relevance > 5) { code.innerHTML = result.value; code.dataset.highlighted = '1'; }
        } catch (_3) {}
      }
    }

    if (pre.querySelector('.code-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = _msg('copy', 'Copy');
    btn.addEventListener('click', async () => {
      const text = extractCodeText(pre, code);
      try {
        await _copyText(text);
        btn.textContent = '✓';
        showToast(_msg('copied', 'Copied'), 'success');
        setTimeout(() => { btn.textContent = _msg('copy', 'Copy'); }, 2000);
      } catch (_) {}
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}

// Text a code-copy button should put on the clipboard. The button itself is
// appended INTO the <pre>, so the plain-text fallback must not read
// pre.textContent verbatim — that carries the button's own 「复制/Copy」 label
// into the clipboard (real user report: un-tagged fenced blocks — the ones
// with no `code[class*="language-"]` child — copied as `…code…复制`).
export function extractCodeText(pre, code) {
  if (code?.textContent != null) return code.textContent;
  const clone = pre.cloneNode(true);
  clone.querySelectorAll('.code-copy-btn').forEach((n) => n.remove());
  return clone.textContent || '';
}

// ─── User-bubble code rendering ─────────────────────────────────────────────
// 用户消息默认逐字纯文本（appendUser 的 textContent 快路径）。这里只加一层受限
// 渲染：识别 ``` 围栏（行首开栏；未闭合 → 代码到末尾，与流式渲染对部分围栏的
// 语义一致）与行内 `code`，其余文字保持 verbatim 文本节点。刻意不做全量
// Markdown——用户输入里的 # 注释、URL 下划线、* 等常无 Markdown 意图，全量渲染
// 会篡改原意；诉求只是「代码有代码的样子」。安全即构造：非代码段全走
// createTextNode（连转义都不需要），唯一的 innerHTML 来自 addCodeCopyButtons
// 的 hljs 输出（与助手气泡同一信任路径）。调用方（appendUser）随后跑
// addCodeCopyButtons(el, {autoDetect:true}) 补高亮+复制按钮（用户经常不写语言
// 标签，裸围栏也要能高亮）。
function _appendUserInline(container, chunk) {
  const parts = chunk.split(/`([^`\n]+)`/); // 奇数位 = 行内代码；落单的 ` 不切分
  for (let k = 0; k < parts.length; k++) {
    if (k % 2) {
      const c = document.createElement('code');
      c.textContent = parts[k];
      container.appendChild(c);
    } else if (parts[k]) {
      container.appendChild(document.createTextNode(parts[k]));
    }
  }
}

function _buildUserPre(lang, codeText) {
  const pre = document.createElement('pre');
  pre.className = 'user-code';
  const code = document.createElement('code');
  if (lang) code.className = `language-${lang}`;
  code.textContent = codeText;
  pre.appendChild(code);
  return pre;
}

export function renderUserContent(container, text) {
  const lines = String(text).split('\n');
  let buf = null;
  const flushPlain = () => {
    if (buf) { _appendUserInline(container, buf.join('\n')); buf = null; }
  };
  let fence = null; // { lang, lines: [] }
  for (const line of lines) {
    if (fence) {
      if (/^```\s*$/.test(line)) {
        container.appendChild(_buildUserPre(fence.lang, fence.lines.join('\n')));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const m = /^```([^`\n]*)\s*$/.exec(line);
    if (m) {
      flushPlain();
      fence = { lang: m[1].trim(), lines: [] };
      continue;
    }
    (buf ??= []).push(line);
  }
  if (fence) container.appendChild(_buildUserPre(fence.lang, fence.lines.join('\n')));
  else flushPlain();
}

// The per-bubble "rich content" decoration pass — the shared tail of all
// three render completion sites (main-chat DONE, history IntersectionObserver
// upgrade, detail-thread postRender): code copy buttons, the six fenced
// renderer fan-outs, math copy buttons. One home so a new renderer (or copy
// surface) can never be added to one site and forgotten in another.
export function addRichRenderFeatures(el) {
  addCodeCopyButtons(el);
  for (const renderer of FENCED_RENDERERS) RENDERER_FNS[renderer](el);
  addMathCopyButtons(el);
}

// 「收尾一个气泡」的唯一实现（C3）：此前四条完成路径（renderStream isDone、
// 主聊天 DONE 分支、renderHistory runUpgrade、detail-thread stopTurn）各持一张
// 步骤表，stopTurn 已漂移缺 linkifyTimestamps（■ 中止回复的 [mm:ss] 不可点）。
// 每步幂等（data-* 标记守卫）：多调无害、少调可见。站点差异（figs 引用还原/
// provider 铭牌/操作条）留在站点自己手里。
export function finishBubble(el) {
  decorateLinks(el);
  linkifyTimestamps(el);
  addThinkCopyButtons(el);
  addRichRenderFeatures(el);
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
// <script>/<style>/<a> and <pre>/<code> — inside a fence or inline code the
// brackets are verbatim data, not a seek affordance (real user report
// 2026-09-26: Python-slice [0:23]/[26:49] rows in a code-block ASCII diagram
// rendered as clickable stamps). The whole pass is gated on the bubble's
// stamped videoSrc — a pill with no seek target is a lie that error-toasts
// on click. Spans (not <a>) are used on purpose so decorateLinks
// can't mis-tag them as external links. The actual seek happens
// via a delegated click handler in sidepanel.js reading data-s + the bubble's
// data-video-src.
// 兼容 [mm:ss] 单点与 [mm:ss, mm:ss] / [mm:ss-mm:ss] 区间（模型会输出逗号区间——真实案例
// 2026-08-24）；区间点击跳转取起始时刻（m[1..3]），分隔符类 [-,\s] 与 ASR 归一化保持一致。
// 序列切片防线一（lookbehind）：`[` 紧跟在标识符字符后面（name[0:23]、arr[0:2][0:23]）是
// 切片不是时间戳——正文里的切片总是贴着名字，真实时间戳几乎总是行首/空格/标点之后。
// 防线二（秒位收紧 [0-5]\d）：真实时间戳秒位 ≤59，秒位>59（[0:80]、[26:99]）必是切片，
// 零误杀；分钟位不能收（[105:30] 是合法总分钟数）。这套 lookbehind/秒位与 chat-handler
// 的 _TS_PRESENT_RE（补时间戳改写门）lockstep，改一处必改另一处。
// 独立悬浮的 [0:23] 在正文里单看形状真有歧义——由第三道剪枝裁决：见函数体内的
// videoSrc 门控（无视频上下文时时间戳解释无法兑现成跳转，一律不链）。
const _TS_TEST_RE = /(?<![A-Za-z0-9_$\]\)])(?:\*Content-)?\[(?:(\d+):)?(\d{1,3}):([0-5]\d)(?:(?:\s*[-,]\s*|\s+)(?:(?:\d+):)?\d{1,3}:[0-5]\d)*\]/;
const _TS_RE = /(?<![A-Za-z0-9_$\]\)])(?:\*Content-)?\[(?:(\d+):)?(\d{1,3}):([0-5]\d)(?:(?:\s*[-,]\s*|\s+)(?:(?:\d+):)?\d{1,3}:[0-5]\d)*\]/g;
export function linkifyTimestamps(el) {
  if (!el) return;
  // 误报剪枝三（videoSrc 门控）：胶囊的唯一动作是 seek，落点全靠 .msg 上的
  // data-video-src 盖章——无盖章的气泡（非视频讨论里的独立 [26:49]、追问卡引用
  // 的选区文本）里胶囊只是样式说谎，点击还会弹「视频源已失效」toast。无盖章一律
  // 不链。前提：videoSrc 盖章先于本函数执行（renderHistory 先戳后升；主聊天 DONE
  // 分支在 await r(finalText) 前落戳——顺序勿倒，倒置=视频笔记的时间戳静默失效）。
  const msgEl = el.closest?.('.msg');
  if (!msgEl || !msgEl.dataset.videoSrc) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.includes('[')) return NodeFilter.FILTER_REJECT;
      let p = node.parentNode;
      while (p && p !== el) {
        const nn = p.nodeName;
        if (nn === 'SCRIPT' || nn === 'STYLE' || nn === 'A' || nn === 'PRE' || nn === 'CODE') return NodeFilter.FILTER_REJECT;
        if (p.classList?.contains('browsa-ts')) return NodeFilter.FILTER_REJECT; // 已是胶囊 → 幂等
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

/**
 * 从原始 markdown 剥掉 <think>/<thinking>/<antml:thinking> 段，只留正文（纯函数，
 * Node 可直接测试；首尾空白随剥除一并收掉——think 常在开头/结尾，留下空行会进
 * 剪贴板）。消息 copy 按钮用——thinking 已有专属的「Copy thinking」小按钮
 * （addThinkCopyButtons），整条消息的复制不应把思考内容夹带进去。标签词表与
 * renderSafe 的提取正则（<think|thinking|antml:thinking>）保持一致；未闭合的尾部
 * think（流式中断时 getRaw() 可能停在 think 内部）连同其后的内容一并丢弃。
 */
export function stripThinkSegments(markdown) {
  let rest = String(markdown || '');
  let out = '';
  for (;;) {
    const open = /<(?:think|thinking|antml:thinking)[^>]*>/i.exec(rest);
    if (!open) { out += rest; break; }
    out += rest.slice(0, open.index);
    rest = rest.slice(open.index + open[0].length);
    const close = /<\/(?:think|thinking|antml:thinking)>/i.exec(rest);
    if (!close) break; // 未闭合 → 剩余全是 think，丢弃
    rest = rest.slice(close.index + close[0].length);
  }
  return out.trim();
}

// ─── Blockwise incremental streaming render ─────────────────────────────────
// The old streaming path re-rendered the ENTIRE accumulated text every reveal
// frame (`el.innerHTML = renderStreamingSafe(display)` per rAF) — O(n²) over a
// stream: a 20KB reply cost ~3MB of re-parse; a long reasoning stream (think
// block included) re-parsed tens of MB. The pacer caps visible growth at
// ~1000 chars/s at 30fps, so frames are many and each one paid for the whole
// document. The vendored stream-markdown-parser has an incremental parser but
// it emits an AST for a component-tree renderer, not HTML — so instead the
// incrementalism is done at the BLOCK level with plain marked:
//
//   text ──► [committed stable blocks: parsed ONCE, appended to the DOM] ──►
//            [open tail: the last incomplete block, re-parsed per frame]
//
// A block boundary is only committed where markdown is context-free (see
// findStreamingBlockBoundary), so each committed chunk parses in isolation
// exactly as it would in the full document. The tail is bounded by one block
// (the common case: the paragraph currently being streamed), so per-frame
// parse cost is O(block), not O(document). DONE still re-renders the full
// text through renderSafe (KaTeX + think blocks), which fixes any streaming
// approximation — loose lists and reference-style links commit late rather
// than wrong.
//
// The largest position ≥ `from` where `text` can be split so that everything
// before it is a sequence of COMPLETE markdown blocks. Split points are
// blank-line boundaries, rejected when context-dependent:
//   - inside a ```/~~~ fence — an unclosed fence keeps everything after its
//     opening line in the tail, which renders as a growing code block
//     (marked auto-closes an unclosed fence at EOF, same as the old
//     whole-text parse showed);
//   - immediately followed by a list item — a blank line between two items is
//     a LOOSE list (one <ul>/<ol>); splitting there would render two lists,
//     so the whole list stays in the tail until a non-item line ends it.
// Setext underlines and GFM tables can't cross blank lines, so they never
// straddle a split. Exported for tests.
export function findStreamingBlockBoundary(text, from = 0) {
  let best = from;
  let inFence = false, fenceChar = '', fenceLen = 0;
  const len = text.length;
  let i = from;
  while (i < len) {
    let nl = text.indexOf('\n', i);
    if (nl === -1) nl = len;
    const line = text.slice(i, nl);
    if (inFence) {
      // Closing fence: only fence chars + whitespace, at least opener length.
      if (new RegExp(`^[ \\t]{0,3}\\${fenceChar}{${fenceLen},}[ \\t]*$`).test(line)) inFence = false;
    } else {
      const opener = /^([ \\t]{0,3})(`{3,}|~{3,})/.exec(line);
      if (opener) {
        inFence = true;
        fenceChar = opener[2][0];
        fenceLen = opener[2].length;
      } else if (/^[ \t]*$/.test(line) && i > from) {
        // Blank-line boundary candidate at `i`. Lookahead past the blank run:
        // commit only if the next non-blank line doesn't continue a loose list.
        let j = nl + 1;
        let nextLine = null;
        while (j < len) {
          let nl2 = text.indexOf('\n', j);
          if (nl2 === -1) nl2 = len;
          const l2 = text.slice(j, nl2);
          if (!/^[ \t]*$/.test(l2)) { nextLine = l2; break; }
          j = nl2 + 1;
        }
        if (nextLine === null || !/^[ \\t]{0,3}(?:[-*+][ \\t]|\d{1,9}[.)][ \\t])/.test(nextLine)) best = i;
      }
    }
    i = nl + 1;
  }
  return best;
}

// One incremental render target bound to a host element (the bubble content el,
// or the live think-body div). `update(text)` renders the grown text with the
// committed-prefix/tail strategy above; the committed region only ever grows
// (display text is prefix-stable — the only thing that ever disappears from it
// is a PARTIAL <think>/<thinking> tag at the buffer end, which contains no
// newline and therefore always sits after the last committed boundary).
function createStreamingTarget(host) {
  let committed = 0;  // chars of `text` already rendered as stable appended HTML
  let tailNodes = []; // top-level nodes currently representing the open tail
  let lastText = null;
  return {
    update(text) {
      if (text === lastText) return; // frozen input (closed think block; display idle while think streams) — no work
      lastText = text;
      if (text.length < committed) {
        // Defensive: the prefix-stability invariant above says this can't
        // happen; if it ever does, start over rather than render garbage.
        host.innerHTML = '';
        committed = 0;
        tailNodes = [];
      }
      const boundary = findStreamingBlockBoundary(text, committed);
      if (boundary > committed) {
        const chunkHtml = renderStreamingSafe(text.slice(committed, boundary));
        for (const n of tailNodes) n.remove();
        tailNodes = [];
        host.insertAdjacentHTML('beforeend', chunkHtml);
        committed = boundary;
      }
      for (const n of tailNodes) n.remove();
      tailNodes = [];
      const tail = text.slice(committed);
      if (tail) {
        const t = document.createElement('template');
        t.innerHTML = renderStreamingSafe(tail);
        tailNodes = [...t.content.childNodes];
        host.append(...tailNodes);
      }
    }
  };
}

// Build a streaming-render closure for a specific bubble.
// During streaming:
//   - <think>/<thinking> content shown in a live collapsible element above the bubble
//   - Non-think text rendered blockwise-incrementally (marked + DOMPurify once
//     per completed block, tail-only re-parse per frame — see the block comment
//     above findStreamingBlockBoundary)
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
  let thinkTarget = null;
  const displayTarget = createStreamingTarget(el);

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
      thinkTarget = createStreamingTarget(thinkBodyEl);
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
      if (think) { ensureThinkEl(); thinkTarget.update(think); }
      displayTarget.update(display);
      el.classList.remove('done');
      onTick?.(el);
    });
  });

  const renderStream = async function renderStream(delta, isDone) {
    if (isDone) {
      pacer.destroy();
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (thinkEl) { thinkEl.remove(); thinkEl = null; thinkBodyEl = null; thinkTarget = null; }
      el.innerHTML = await renderSafe(delta);
      el.classList.add('done');
      el.dataset.raw = delta; // raw markdown, mirrors appendUser's dataset.raw — read by openDetailThread
      finishBubble(el);
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
    // The live think block must go with the abandoned attempt too — otherwise
    // a retried/aborted turn leaves the old "Thinking…" element stranded above
    // the bubble (and a new attempt inserting its own would duplicate it).
    if (thinkEl) { thinkEl.remove(); thinkEl = null; thinkBodyEl = null; thinkTarget = null; }
  };
  return renderStream;
}

// ─── Chemistry / biostructures (smiles-drawer + 3Dmol) ──────────────────────
// Same "model emits a fenced block, the pipeline swaps it for a live render"
// pattern as mermaid/echarts/markmap, for two formats LLMs natively speak:
//
//   ```smiles          → 2D chemical structure diagram (smiles-drawer, canvas).
//                        Reaction SMILES (reactants>agents>products, contains
//                        '>') routes to the SAME library's ReactionDrawer —
//                        plain molecule SMILES can never contain '>', so the
//                        discrimination is lossless.
//   ```pdb\n1UBQ\n```  → interactive 3D viewer for an RCSB PDB structure
//                        (3Dmol WebGL; the ID is fetched from files.rcsb.org
//                        at render time — models must NEVER emit raw ATOM
//                        coordinates, they would be fabricated)
//   ```pdb\nAF-P00533-F1\n``` → the same viewer for an AlphaFold DB predicted
//                        model. The accession is resolved through the DB's
//                        API (versions advance — hardcoding model_vN 404s) to
//                        the CURRENT .pdb file, rendered with the pLDDT
//                        confidence palette (pLDDT travels in the PDB B-factor
//                        column) plus the four-band legend, AlphaFold DB's
//                        visual signature. A bare UniProt accession (P00533)
//                        is accepted too — 6+ chars, cannot collide with a
//                        4-char RCSB ID.
//
// 3Dmol's dist is a <script>-style build relying on sloppy-mode globals
// (window.$ from its bundled jQuery, window.$3Dmol) — it is RAW-copied by
// build.mjs and loaded here via a classic <script> tag, not import() (see
// build.mjs RAW_COPIES for why esbuild would break it).

let smilesDrawerPromise = null;
export function getSmilesDrawer() {
  if (!smilesDrawerPromise) {
    smilesDrawerPromise = import('../vendor/smiles-drawer.bundle.js')
      .then((m) => m.default || window.SmilesDrawer)
      .catch((e) => { smilesDrawerPromise = null; throw e; });
  }
  return smilesDrawerPromise;
}

let threeDMolPromise = null;
export function get3Dmol() {
  if (!threeDMolPromise) {
    threeDMolPromise = new Promise((resolve, reject) => {
      if (window.$3Dmol) { resolve(window.$3Dmol); return; }
      const script = document.createElement('script');
      script.src = new URL('../vendor/3Dmol-min.js', import.meta.url).href;
      script.onload = () => {
        if (window.$3Dmol) resolve(window.$3Dmol);
        else reject(new Error('3Dmol loaded but $3Dmol global missing'));
      };
      script.onerror = () => reject(new Error('3Dmol script failed to load'));
      document.head.appendChild(script);
    }).catch((e) => { threeDMolPromise = null; throw e; });
  }
  return threeDMolPromise;
}

// Pure: classify a ```pdb block's content — a bare 4-char PDB ID (fetch from
// RCSB) vs an AlphaFold model ID / bare UniProt accession (fetch from the
// AlphaFold DB API) vs an inline PDB payload (render directly) vs garbage
// (leave the block as text). Exported for tests.
export function parsePdbBlock(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^(HEADER|ATOM  |HETATM|MODEL |COMPND|CRYST1|REMARK)/m.test(t)) return { kind: 'data', value: t };
  if (/^[0-9][0-9A-Za-z]{3}$/.test(t)) return { kind: 'id', value: t.toUpperCase() };
  // AlphaFold: `AF-{UniProt accession}-F{model}`, tolerating the full
  // filename form (`...-model_v4` — the version suffix is meaningless to us,
  // the API resolves the current one) and case. The accession grammar
  // ([OPQ][0-9][A-Z0-9]{3}[0-9], optional -N isoform suffix) keeps junk like
  // AF-123456-F1 out — an unrecognized ID must stay visible as text so the
  // user can see what the model emitted, never a silent dead block.
  const af = /^AF-([OPQ][0-9][A-Z0-9]{3}[0-9](?:-\d+)?)-F(\d+)(?:-model_v\d+)?$/i.exec(t);
  if (af) return { kind: 'alphafold', value: `AF-${af[1].toUpperCase()}-F${af[2]}` };
  // A bare accession is unambiguous (6+ chars can never be a 4-char PDB ID).
  if (/^[OPQ][0-9][A-Z0-9]{3}[0-9](?:-\d+)?$/.test(t)) return { kind: 'alphafold', value: `AF-${t.toUpperCase()}-F1` };
  return null;
}

// AlphaFold DB's pLDDT confidence palette — the four bands shown on
// alphafold.ebi.ac.uk (very high / confident / low / very low). Pure,
// exported for tests.
export function plddtColor(v) {
  const x = Math.max(0, Math.min(100, Number(v) || 0));
  if (x >= 90) return '0053D6';
  if (x >= 70) return '65CBF3';
  if (x >= 50) return 'FFDB13';
  return 'FF7D45';
}

export async function renderSmiles(el) {
  const blocks = el.querySelectorAll('code.language-smiles');
  if (!blocks.length) return;
  let lib;
  try { lib = await getSmilesDrawer(); } catch (_) { return; } // vendor failed — keep the code block
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const smiles = code.textContent.trim();
    if (!smiles) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'smiles-block';
    // Hover toolbar — same affordance as mermaid/echarts/markmap: copy the
    // source and export the diagram (SVG for reactions, PNG for the canvas).
    const toolbar = _chemToolbar(wrapper, smiles);
    // Swap BEFORE drawing (like renderMarkmap's replaceWith-then-render): on
    // any failure below, the wrapper is swapped back to the original pre so
    // the raw SMILES never disappears.
    pre.replaceWith(wrapper);
    try {
      const width = Math.max(el.clientWidth || 0, 280);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const theme = isDark ? 'dark' : 'light';
      if (smiles.includes('>')) {
        // Reaction SMILES: ReactionDrawer does NOT draw on canvas — it builds
        // an inline SVG sized to the actual content (viewBox + style width
        // written on the TARGET svg from the laid-out elements; a canvas
        // target would just sit there unused at its own fixed size = the
        // huge-blank-block bug). Pass an <svg> target, then move it into the
        // wrapper as-is — its viewBox/style already fit the content.
        const drawer = new lib.ReactionDrawer({ padding: 14 });
        const svgTarget = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        lib.parseReaction.call(lib, smiles, (tree) => {
          try {
            drawer.draw(tree, svgTarget, theme);
            svgTarget.classList.add('smiles-svg');
            wrapper.replaceChildren(svgTarget, toolbar);
          } catch (_) { wrapper.replaceWith(pre); }
        }, () => wrapper.replaceWith(pre));
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = width * dpr;
        canvas.height = 240 * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = '240px';
        wrapper.append(canvas, toolbar);
        const drawer = new lib.Drawer({ width, height: 240, padding: 14, bondSpacing: 4 });
        lib.parse.call(lib, smiles, (tree) => {
          try { drawer.draw(tree, canvas, theme); }
          catch (_) { wrapper.replaceWith(pre); } // jsdom/none-canvas environments
        }, () => wrapper.replaceWith(pre));
      }
    } catch (_) {
      wrapper.replaceWith(pre);
    }
  }
}

// Vector source → PNG data URL, rasterized at up to 2x (capped to maxEdge on
// the long edge) via an offscreen canvas. Shared by the reaction-SMILES export
// and the ```nn architecture-figure export. `opts.bg` optionally paints an
// opaque backdrop first (transparent SVGs would otherwise export dark-on-
// transparent, unreadable on white viewers).
async function _rasterizeSvg(svg, opts = {}) {
  const vb = svg.viewBox?.baseVal;
  const w = Math.max((vb && vb.width) || svg.clientWidth || 600, 1);
  const h = Math.max((vb && vb.height) || svg.clientHeight || 400, 1);
  const scale = Math.min(2, (opts.maxEdge || 1600) / w);
  const pngCanvas = document.createElement('canvas');
  pngCanvas.width = Math.round(w * scale);
  pngCanvas.height = Math.round(h * scale);
  const ctx = pngCanvas.getContext('2d');
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, pngCanvas.width, pngCanvas.height);
  }
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  });
  ctx.drawImage(img, 0, 0, pngCanvas.width, pngCanvas.height);
  return pngCanvas.toDataURL('image/png');
}

// Hover toolbar for smiles/pdb blocks (reuse .mermaid-toolbar styling): copy
// the source text, and export the rendering — smiles: SVG→PNG (reactions) or
// canvas→PNG (molecules); pdb: pngURI() WebGL snapshot, when the caller
// supplies a snapshot getter.
function _chemToolbar(wrapper, source, getPngUri) {
  const specs = [
    { title: _msg('mermaidCopyCode', '复制代码'), html: ICONS.copy, action: _copyCodeAction(source) },
  ];
  if (getPngUri) {
    specs.push({
      title: _msg('chemExportPng', '导出PNG'),
      text: '↓',
      action: _exportAction('↓', async () => {
        const uri = getPngUri();
        if (!uri) throw new Error('snapshot unavailable');
        _downloadDataUrl(uri, 'structure.png');
      }),
    });
    return _diagramToolbar(specs);
  }
  specs.push({
    title: _msg('chemExportPng', '导出PNG'),
    text: '↓',
    action: _exportAction('↓', async () => {
      const svg = wrapper.querySelector('svg.smiles-svg');
      if (svg) {
        // Vector source: rasterize at 2x for a crisp PNG via an offscreen canvas.
        _downloadDataUrl(await _rasterizeSvg(svg), 'reaction.png');
      } else {
        const canvas = wrapper.querySelector('canvas');
        if (canvas && canvas.width) _downloadDataUrl(canvas.toDataURL('image/png'), 'molecule.png');
        else throw new Error('nothing to export yet');
      }
    }),
  });
  if (wrapper.querySelector('svg.smiles-svg') || !wrapper.querySelector('canvas')) {
    specs.push({
      title: _msg('mermaidExportSvg', '导出SVG'),
      text: 'SVG',
      action: _exportAction('SVG', async () => {
        const svg = wrapper.querySelector('svg.smiles-svg');
        if (!svg) throw new Error('no svg');
        const xml = new XMLSerializer().serializeToString(svg);
        _downloadBlob(new Blob([xml], { type: 'image/svg+xml' }), 'reaction.svg');
      }),
    });
  }
  return _diagramToolbar(specs);
}

function _downloadDataUrl(dataUrl, name) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

function _downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  _downloadDataUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function renderPdb(el) {
  const blocks = el.querySelectorAll('code.language-pdb');
  if (!blocks.length) return;
  let lib;
  try { lib = await get3Dmol(); } catch (_) { return; } // vendor failed — keep the code block
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const parsed = parsePdbBlock(code.textContent);
    if (!parsed) continue; // not recognizable as PDB — leave as text
    const wrapper = document.createElement('div');
    wrapper.className = 'pdb-block';
    const viewerEl = document.createElement('div');
    viewerEl.className = 'pdb-viewer';
    wrapper.appendChild(viewerEl);
    pre.replaceWith(wrapper);
    try {
      let data = parsed.value;
      let isAf = false;
      if (parsed.kind === 'id') {
        const status = document.createElement('div');
        status.className = 'pdb-status';
        status.textContent = `RCSB PDB ${parsed.value}`;
        wrapper.appendChild(status);
        const res = await fetch(`https://files.rcsb.org/download/${parsed.value}.pdb`);
        if (!res.ok) throw new Error(`RCSB HTTP ${res.status}`);
        data = await res.text();
        status.remove();
      } else if (parsed.kind === 'alphafold') {
        const status = document.createElement('div');
        status.className = 'pdb-status';
        status.textContent = `AlphaFold ${parsed.value}`;
        wrapper.appendChild(status);
        // The DB re-runs its models (model_v4 → v6 …), so the version-bearing
        // file URL can ONLY come from the API — hardcoding a version 404s.
        // The API answers with every model for the accession (F1, F2 …);
        // prefer the exact one requested, degrade to the first.
        const acc = parsed.value.slice(3).replace(/-F\d+$/, '');
        const apiRes = await fetch(`https://www.alphafold.ebi.ac.uk/api/prediction/${acc}`);
        if (!apiRes.ok) throw new Error(`AlphaFold HTTP ${apiRes.status}`);
        const entries = await apiRes.json();
        const entry = (Array.isArray(entries) ? entries : []).find((e) => e.modelEntityId === parsed.value)
          || (Array.isArray(entries) ? entries[0] : null);
        if (!entry || !entry.pdbUrl) throw new Error('AlphaFold: no prediction for this accession');
        const res = await fetch(entry.pdbUrl);
        if (!res.ok) throw new Error(`AlphaFold HTTP ${res.status}`);
        data = await res.text();
        status.remove();
        isAf = true;
      }
      // Cartoon rainbow for the protein/backbone + sticks for ligands — the
      // standard RCSB-viewer default pairing, readable on light and dark.
      // AlphaFold models instead get the pLDDT confidence coloring (the
      // palette IS the information content of an AF view) + the legend strip.
      const viewer = lib.createViewer(viewerEl, { backgroundColor: isDark ? 'black' : 'white' });
      viewer.addModel(data, 'pdb');
      if (isAf) {
        // Per-atom colorfunc, NOT a custom $3Dmol.Gradient instance — verified
        // live that the Gradient-object route renders near-black (3Dmol's
        // colorscheme/gradient plumbing doesn't honor a bare instance), while
        // colorfunc hits the palette exactly.
        viewer.setStyle({}, { cartoon: { colorfunc: (atom) => '#' + plddtColor(atom.b) } });
      } else {
        viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
      }
      viewer.addStyle({ hetflag: true }, { stick: { radius: 0.3 } });
      viewer.zoomTo();
      viewer.render();
      if (isAf) wrapper.appendChild(_plddtLegend());
      // Hover toolbar: copy the source (PDB ID or the inline payload) and
      // export the current view as a PNG snapshot (3Dmol's pngURI renders
      // the WebGL framebuffer).
      viewerEl.appendChild(_chemToolbar(wrapper, parsed.value, () => {
        try { return viewer.pngURI(); } catch (_) { return null; }
      }));
    } catch (e) {
      wrapper.replaceWith(pre); // fetch/render failure — restore the raw block
      console.warn('browsa: pdb render failed', parsed.value, e?.message);
    }
  }
}

// The AlphaFold four-band confidence key (≥90 blue / 70–90 cyan / 50–70
// yellow / <50 orange) as a compact strip under the viewer. Band labels are
// numeric — the only prose is the pLDDT label (i18n).
function _plddtLegend() {
  const bar = document.createElement('div');
  bar.className = 'pdb-legend';
  const label = document.createElement('span');
  label.textContent = _msg('pdbPlddtLegend', 'pLDDT 置信度');
  bar.appendChild(label);
  const bands = [['≥90', '#0053D6'], ['70–90', '#65CBF3'], ['50–70', '#FFDB13'], ['<50', '#FF7D45']];
  for (const [range, color] of bands) {
    const chip = document.createElement('span');
    chip.className = 'pdb-legend-chip';
    const sw = document.createElement('i');
    sw.style.background = color;
    const tx = document.createElement('span');
    tx.textContent = range;
    chip.append(sw, tx);
    bar.appendChild(chip);
  }
  return bar;
}

// ─── 神经网络架构图（```nn fence, renderNn） ──────────────────────────────────
// 模型输出紧凑 JSON（层数组），页面画成出版级架构图——调研结论：没有可 vendor
// 的专用库（Netron/TensorSpace 吃模型文件，NN-SVG 是停更 Web 工具），所以借鉴
// NN-SVG（MIT）的两种经典画法自建：stack（Keras/Netron 式层叠盒 + 残差弧）覆盖
// 一切架构，fcnn（经典神经元点阵）只适合小 MLP。无外部依赖，纯 SVG。

// Pure: classify a ```nn block's content. Exported for tests. Returns a
// normalized spec or null (block stays as code). Tolerant by design — one bad
// layer among good ones is dropped, not fatal; oversized layer lists are
// truncated with a "… +N more" pseudo-row instead of failing.
export function parseNnBlock(text) {
  const t = String(text || '').trim();
  if (!t || t[0] !== '{') return null;
  let o;
  try { o = JSON.parse(t); } catch (_) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;

  if (o.style === 'fcnn') {
    const L = Array.isArray(o.layers) ? o.layers : null;
    if (!L || L.length < 2 || L.length > 16) return null;
    if (!L.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)) return null;
    const labels = (Array.isArray(o.labels) && o.labels.length === L.length
      && o.labels.every((s) => typeof s === 'string' && s.trim() && s.length <= 40))
      ? o.labels.map((s) => s.trim()) : null;
    return { style: 'fcnn', layers: L, labels };
  }

  // stack (default — also when style is absent or unrecognized)
  const raw = Array.isArray(o.layers) ? o.layers : null;
  if (!raw || !raw.length) return null;
  const norm = (x) => {
    if (typeof x === 'string' && x.trim()) return { name: x.trim().slice(0, 60) };
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const name = (typeof x.name === 'string' && x.name.trim()) ? x.name.trim().slice(0, 60) : null;
    const out = (typeof x.out === 'string' && x.out.trim()) ? x.out.trim().slice(0, 28) : null;
    let parallel = null;
    if (Array.isArray(x.parallel) && x.parallel.length && x.parallel.length <= 6) {
      parallel = x.parallel.map(norm).filter((p) => p && p.name).map((p) => ({ name: p.name }));
      if (!parallel.length) parallel = null;
    }
    if (!name && !parallel) return null;
    const kind = (x.kind === 'input' || x.kind === 'output') ? x.kind : null;
    return { name, out, kind, parallel };
  };
  const layers = raw.map(norm).filter(Boolean);
  if (!layers.length) return null;

  // Truncate oversized nets to a bounded figure instead of failing — a 40-layer
  // model description still deserves a diagram with an honest "+N more" row.
  const MAX_LAYERS = 18;
  let dropped = 0;
  if (layers.length > MAX_LAYERS) {
    dropped = layers.length - MAX_LAYERS;
    layers.length = MAX_LAYERS;
  }
  if (dropped) layers.push({ name: `… +${dropped} more`, kind: 'more' });

  // Auto-style the first/last REAL rows as input/output when no explicit kind
  // exists (Keras-plot convention), skipping parallel groups and the more-row.
  const real = layers.filter((l) => l.kind !== 'more');
  if (real.length >= 2 && !layers.some((l) => l.kind === 'input' || l.kind === 'output')) {
    if (!real[0].parallel) real[0].autoKind = 'input';
    if (!real[real.length - 1].parallel) real[real.length - 1].autoKind = 'output';
  }

  // Skips: {from,to,label?} row indices, from<to, both inside the displayed
  // range, capped at 6 (a clean figure; skip- spaghetti is Mermaid's job).
  const kept = Math.min(layers.length - (dropped ? 1 : 0), MAX_LAYERS);
  const skips = [];
  if (Array.isArray(o.skips)) {
    for (const s of o.skips.slice(0, 8)) {
      if (!s || typeof s !== 'object') continue;
      const { from, to } = s;
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      if (from < 0 || from >= to || to >= kept) continue;
      if (skips.length >= 6) break;
      skips.push({ from, to, label: (typeof s.label === 'string' && s.label.trim()) ? s.label.trim().slice(0, 24) : null });
    }
  }
  return { style: 'stack', layers, skips };
}

// Theme palette resolved ONCE at render time and written into the SVG as
// literal colors (never var()) — the exported SVG/PNG must be self-contained
// (an <img>-decoded SVG has no document to resolve CSS variables against).
function _nnPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => ((cs.getPropertyValue(name) || '').trim() || fb);
  return {
    border: v('--border', '#999'),
    fg: v('--fg', '#333'),
    dim: v('--fg-dim', '#888'),
    bg2: v('--bg-2', '#f2f2f5'),
    accent: v('--accent', '#4a7dbe'),
    gold: v('--gold', '#c9971c'),
  };
}

function _svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val);
  return el;
}

// Keras/Netron-style layer stack: centered rounded boxes (name left, output
// shape right), arrows between rows, parallel branch groups as side-by-side
// mini boxes, skip/residual connections as gold arcs on the right margin.
function _nnStackSvg(spec, W, C) {
  const layers = spec.layers;
  const padX = 12, arcW = spec.skips.length ? 84 : 0;
  const boxW = Math.max(170, W - padX * 2 - arcW);
  let rowH = 36, gap = 10;
  const MAX_H = 640, padY = 10;
  const natural = layers.length * rowH + (layers.length - 1) * gap + padY * 2;
  if (natural > MAX_H) {
    const k = MAX_H / natural;
    rowH = Math.max(24, rowH * k);
    gap = Math.max(6, gap * k);
  }
  const H = Math.min(natural, MAX_H);
  const svg = _svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'nn-svg', 'aria-label': 'neural network architecture' });
  const defs = _svgEl('defs');
  const marker = _svgEl('marker', { id: 'nn-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.appendChild(_svgEl('path', { d: 'M 0 1 L 8 5 L 0 9 z', fill: C.dim }));
  defs.appendChild(marker);
  svg.appendChild(defs);
  const rowY = (i) => padY + i * (rowH + gap);
  const rowCy = (i) => rowY(i) + rowH / 2;

  layers.forEach((l, i) => {
    const y = rowY(i);
    const kind = l.kind || l.autoKind;
    if (l.parallel) {
      // Branch group: faint dashed container + side-by-side mini boxes.
      const n = l.parallel.length;
      const miniGap = 6;
      const miniW = (boxW - (n - 1) * miniGap) / n;
      svg.appendChild(_svgEl('rect', {
        x: padX, y, width: boxW, height: rowH, rx: 7,
        fill: 'none', stroke: C.border, 'stroke-dasharray': '4 3', 'stroke-width': 1,
      }));
      l.parallel.forEach((p, j) => {
        const mx = padX + j * (miniW + miniGap);
        const box = _svgEl('rect', {
          x: mx, y: y + 5, width: miniW, height: rowH - 10, rx: 5,
          fill: C.bg2, stroke: C.border, 'stroke-width': 1,
        });
        svg.appendChild(box);
        const label = p.name.slice(0, Math.max(4, Math.floor(boxW / n / 7.2)));
        const text = _svgEl('text', {
          x: mx + miniW / 2, y: y + rowH / 2 + 4, 'text-anchor': 'middle',
          'font-size': 11, fill: C.fg, 'font-family': 'ui-sans-serif, system-ui, sans-serif',
        });
        text.textContent = label;
        svg.appendChild(text);
      });
    } else {
      const isIo = kind === 'input' || kind === 'output';
      const box = _svgEl('rect', {
        x: padX, y, width: boxW, height: rowH, rx: 7,
        fill: kind === 'more' ? 'none' : (isIo ? `color-mix(in srgb, ${C.accent} 9%, transparent)` : C.bg2),
        stroke: kind === 'more' ? C.border : (isIo ? C.accent : C.border),
        'stroke-width': isIo ? 1.4 : 1,
        'stroke-dasharray': kind === 'more' ? '4 3' : 'none',
      });
      if (kind === 'more') box.setAttribute('fill-opacity', '0');
      svg.appendChild(box);
      const name = _svgEl('text', {
        x: padX + 12, y: y + rowH / 2 + 4.5,
        'font-size': 13, fill: kind === 'more' ? C.dim : C.fg,
        'font-family': 'ui-sans-serif, system-ui, sans-serif',
      });
      name.textContent = l.name;
      svg.appendChild(name);
      if (l.out) {
        const out = _svgEl('text', {
          x: padX + boxW - 12, y: y + rowH / 2 + 4, 'text-anchor': 'end',
          'font-size': 11.5, fill: C.dim, 'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        });
        out.textContent = l.out;
        svg.appendChild(out);
      }
    }
    if (i > 0) {
      const y0 = rowY(i - 1) + rowH, y1 = y;
      svg.appendChild(_svgEl('line', {
        x1: padX + boxW / 2, y1: y0 + 1, x2: padX + boxW / 2, y2: y1 - 2,
        stroke: C.dim, 'stroke-width': 1.2, 'marker-end': 'url(#nn-arrow)',
      }));
    }
  });

  // Skip/residual arcs along the right margin.
  spec.skips.forEach((s) => {
    const x0 = padX + boxW, cy0 = rowCy(s.from), cy1 = rowCy(s.to);
    const bulge = x0 + 34 + (s.to - s.from) * 3;
    svg.appendChild(_svgEl('path', {
      d: `M ${x0} ${cy0} C ${bulge} ${cy0}, ${bulge} ${cy1}, ${x0} ${cy1}`,
      fill: 'none', stroke: C.gold, 'stroke-width': 1.4, 'stroke-dasharray': '5 3',
    }));
    if (s.label) {
      const text = _svgEl('text', {
        x: bulge + 6, y: (cy0 + cy1) / 2, 'text-anchor': 'middle',
        'font-size': 10, fill: C.gold, 'font-family': 'ui-sans-serif, system-ui, sans-serif',
      });
      text.textContent = s.label;
      svg.appendChild(text);
    }
  });
  return svg;
}

// Classic point-neuron MLP: columns of circles, full mesh between adjacent
// layers (NN-SVG's FCNN style). Column counts above 10 display their first
// and last neurons with an ellipsis — a 784-input layer must not mean 784
// circles.
function _nnFcnnSvg(spec, C) {
  const shown = spec.layers.map((n) => Math.min(n, 10));
  const maxShown = Math.max(...shown);
  const colGap = 84, padX = 30, padTop = 36, padBottom = 16;
  const W = Math.max(280, padX * 2 + (spec.layers.length - 1) * colGap);
  const H = Math.max(170, padTop + padBottom + (maxShown - 1) * 30);
  const svg = _svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'nn-svg', 'aria-label': 'neural network architecture' });
  const spacing = maxShown > 1 ? (H - padTop - padBottom) / (maxShown - 1) : 0;
  const r = Math.min(10, spacing * 0.36, 12);
  const cx = (j) => padX + j * colGap;
  const cy = (j, i) => padTop + ((maxShown - 1) / 2 - (shown[j] - 1) / 2) * spacing + i * spacing;
  for (let j = 1; j < spec.layers.length; j++) {
    for (let a = 0; a < shown[j - 1]; a++) {
      for (let b = 0; b < shown[j]; b++) {
        svg.appendChild(_svgEl('line', {
          x1: cx(j - 1), y1: cy(j - 1, a), x2: cx(j), y2: cy(j, b),
          stroke: C.dim, 'stroke-width': 0.7, 'stroke-opacity': 0.35,
        }));
      }
    }
  }
  spec.layers.forEach((count, j) => {
    const isIo = j === 0 || j === spec.layers.length - 1;
    for (let i = 0; i < shown[j]; i++) {
      svg.appendChild(_svgEl('circle', {
        cx: cx(j), cy: cy(j, i), r,
        fill: C.bg2, stroke: isIo ? C.accent : C.fg, 'stroke-width': isIo ? 1.5 : 1,
      }));
    }
    if (count > shown[j]) {
      const text = _svgEl('text', {
        x: cx(j), y: cy(j, shown[j] - 1) + r + 14, 'text-anchor': 'middle',
        'font-size': 11, fill: C.dim, 'font-family': 'ui-sans-serif, system-ui, sans-serif',
      });
      text.textContent = `×${count}`;
      svg.appendChild(text);
    }
    if (spec.labels && spec.labels[j]) {
      const text = _svgEl('text', {
        x: cx(j), y: 20, 'text-anchor': 'middle',
        'font-size': 11.5, fill: C.dim, 'font-family': 'ui-sans-serif, system-ui, sans-serif',
      });
      text.textContent = spec.labels[j];
      svg.appendChild(text);
    }
  });
  return svg;
}

// ```nn blocks — layer-stack / point-neuron architecture figures. Sync (no
// vendor to load); a parse failure leaves the raw code block in place.
export function renderNn(el) {
  const blocks = el.querySelectorAll('code.language-nn');
  if (!blocks.length) return;
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const spec = parseNnBlock(code.textContent);
    if (!spec) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'nn-block';
    pre.replaceWith(wrapper);
    try {
      const C = _nnPalette();
      const width = Math.max(280, Math.min(640, el.clientWidth || 560));
      const svg = spec.style === 'fcnn' ? _nnFcnnSvg(spec, C) : _nnStackSvg(spec, width, C);
      const source = code.textContent.trim();
      const specs = [
        { title: _msg('mermaidCopyCode', '复制代码'), html: ICONS.copy, action: _copyCodeAction(source) },
        {
          title: _msg('mermaidExportSvg', '导出SVG'), text: 'SVG',
          action: _exportAction('SVG', () => {
            const out = wrapper.querySelector('svg.nn-svg');
            if (!out) throw new Error('no svg');
            _downloadBlob(new Blob([new XMLSerializer().serializeToString(out)], { type: 'image/svg+xml' }), 'architecture.svg');
          }),
        },
        {
          title: _msg('chemExportPng', '导出PNG'), text: '↓',
          action: _exportAction('↓', async () => {
            const out = wrapper.querySelector('svg.nn-svg');
            if (!out) throw new Error('no svg');
            _downloadDataUrl(await _rasterizeSvg(out, { bg: isDark ? '#1e1e28' : '#ffffff' }), 'architecture.png');
          }),
        },
      ];
      wrapper.append(svg, _diagramToolbar(specs));
    } catch (_) {
      wrapper.replaceWith(pre);
    }
  }
}

// ─── [图N] 内联缩略图（输出侧） ─────────────────────────────────────────────
// 输入侧：附加条目按 [图N] 锚点交错携带截图（interleaveImageParts）。
// 输出侧：模型在回答中用 [图N] 引用截图（VinQA 式引用生成），渲染时还原为
// 内联缩略图——纯 DOM 后处理，纯函数可直接测试。

/**
 * 找 history 中 idx 之前（不含 idx）最近的带 image 部件的 user 附加条目，
 * 返回其图片 URL 列表（按锚点顺序）。没有则返回 []。
 */
export function figuresBeforeEntry(list, idx) {
  for (let i = Math.min(idx, (list || []).length) - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
    const urls = m.content
      .filter((b) => b && b.type === 'image_url')
      .map((b) => (typeof b.image_url === 'string' ? b.image_url : b.image_url?.url))
      .filter(Boolean);
    if (urls.length) return urls;
  }
  return [];
}

/**
 * 把 el 内文本节点里的 [图N] 引用替换为内联缩略图（figures[N-1]）。
 * N 越界或 figures 为空时原样保留标记（纯文本降级，绝不丢内容）。
 */
export function decorateFigureRefs(el, figures) {
  if (!el || !Array.isArray(figures) || !figures.length) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue && /\[图\d+\]/.test(n.nodeValue)) targets.push(n);
  }
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    const text = node.nodeValue;
    let last = 0;
    let replaced = false;
    const re = /\[图(\d+)\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      const src = figures[n - 1];
      if (!src) continue;
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const img = document.createElement('img');
      img.src = src;
      img.className = 'inline-fig';
      img.alt = `图${n}`;
      frag.appendChild(img);
      last = m.index + m[0].length;
      replaced = true;
    }
    if (!replaced) continue;
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
