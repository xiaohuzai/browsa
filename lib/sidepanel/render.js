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

// Wide tables must scroll WITHIN the bubble: `pre` and block math already get
// overflow-x containment, tables didn't — a 6+ column comparison table (a
// common LLM output) at side-panel width exceeded the bubble's min-content
// width and dragged the ENTIRE messages area sideways (`.messages` computes
// overflow-x:auto from its overflow-y:auto). Wrapping at the marked layer
// covers every consumer (streaming block commits + final render) with no DOM
// post-pass.
// WHY hooks.postprocess and not a renderer override: the committed vendor
// bundle predates marked v13 and calls renderer extensions with the OLD
// (headerHTML, bodyHTML) string signature, while package-lock resolves
// marked 16.4.2 — a renderer.table override is therefore bundle-version
// dependent (a future vendor rebuild would silently break it). postprocess's
// string-level contract is stable across both APIs. Only real <table> tags
// are wrapped: fenced-code occurrences are already &lt;-escaped at this
// point, and a model's raw-HTML table gets the same containment (desired).
marked.use({
  hooks: {
    postprocess(html) {
      return html
        .replace(/<table(\s[^>]*)?>/g, '<div class="table-scroll"><table$1>')
        .replace(/<\/table>/g, '</table></div>');
    },
  },
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

// Mermaid 主题只在该 helper 换挡（2026-10-01）：主题快照若随 initialize 只跑
// 一次，OS 暗色热切换后新图沿用旧主题（echarts/markmap/dot/rdkit 都是每次
// 渲染现读 matchMedia，mermaid 是唯一例外——第一轮审计的搁置疑点，实锤）。
// 每次渲染前调用：主题没变 = 一次 matchMedia 读 + 比较；变了才重新 initialize
// ——mermaid v11 允许运行期重初始化，已渲染的 SVG 不受影响。导出供单测。
let mermaidTheme = null;
export function initMermaidTheme(mermaid) {
  const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
  if (mermaidTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'loose',
    flowchart: { nodeSpacing: 30, rankSpacing: 40 },
    themeVariables: { fontSize: '18px' },
  });
  mermaidTheme = theme;
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
    // Expose KaTeX globally so Mermaid v11 can render $$...$$ math in node labels
    window.katex = katex;
    // Legibility in the narrow side panel: the SVG gets scaled down to the
    // bubble width via `max-width:100%`, so a wide layout means tiny text.
    // Tighter default flowchart spacing shrinks the natural width (bigger
    // effective scale), and a bumped base font keeps labels readable after
    // that scale. Layout-only — no semantic change to user diagrams.
    // （配置本体在 initMermaidTheme——主题与布局必须同处一个 initialize。）
    initMermaidTheme(mermaid);
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
  // OS 主题热切换跟手（见 initMermaidTheme 注释）——与其余五个渲染器对齐。
  initMermaidTheme(m);
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
    // mermaid 也能产出带链接的节点（clickCallback/linkUrl）——与正文锚点同一
    // 外链加固（target=_blank + rel），避免点击把扩展页自身导航走。
    decorateLinks(wrapper);
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

// Shared "render failed" card for the JSON/text-source renderers (echarts,
// markmap): styled chip + copy-source button + the raw source in a <details>,
// so a failed block NEVER destroys the model's source (it stays readable,
// copyable, re-askable — the contract mermaid/dot/smiles all follow; echarts
// used to be the one renderer that replaced the fence with a bare unstyled
// message and lost the JSON). Reuses the .mermaid-error class family — same
// precedent as .mermaid-toolbar being shared across all six renderers.
// Mermaid keeps its own richer card (AI-fix + parse-error formatting are
// mermaid-parser-specific).
function _diagramErrorCard(label, source, err) {
  const errDiv = document.createElement('div');
  errDiv.className = 'mermaid-error';
  errDiv.innerHTML =
    `<span>⚠ ${label}: ${escM(String(err?.message || err))}</span>` +
    `<button type="button" class="mermaid-err-copy">${_msg('mermaidCopyCode', '复制代码')}</button>` +
    `<details><summary>${_msg('mermaidViewSource', '查看源码')}</summary><pre class="mermaid-err-src">${escM(source)}</pre></details>`;
  errDiv.querySelector('.mermaid-err-copy').addEventListener('click', (e) => {
    const btn = e.target;
    _copyText(source).then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = _msg('mermaidCopyCode', '复制代码'); }, 1500);
    }).catch(() => {});
  });
  return errDiv;
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
    { title: _msg('mermaidExportPng', '导出PNG'), text: '↓', action: _exportAction('↓', () => _exportSvgWrapAsPng(svgWrap, 'diagram.png')) },
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

// ONE export contract for every SVG-rendering diagram (mermaid / dot /
// markmap): PNG at 2x with the CURRENT theme's backdrop baked in — the same
// contract echarts (getDataURL backgroundColor) and smiles/pdb (_rasterizeSvg
// opts.bg) already follow. (Before the 2026-09-30 unification the same ↓
// glyph exported SVG here but PNG on the other three renderers — and a
// transparent-background SVG opens black-on-black in viewers outside the
// extension. Theme constants match the smiles export's.)
async function _exportSvgWrapAsPng(svgWrap, name) {
  const svgEl = svgWrap.querySelector('svg');
  if (!svgEl) throw new Error('no svg');
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  _downloadDataUrl(await _rasterizeSvg(svgEl, { bg: dark ? '#16181d' : '#ffffff' }), name);
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
// Per-element disposer registry (2026-09-30 批C): element -> Set of cleanup
// callbacks (ResizeObserver disconnect, echarts instance dispose, Mol* viewer
// dispose). Before this, disposal ONLY happened in renderHistory's global
// sweep — the per-message delete paths (single delete, multiselect,
// regenerate, detail-thread close) dropped subtrees with live instances: a
// deleted ```pdb bubble left a detached WebGL context whose rAF render loop
// kept burning CPU/GPU and occupied one of the browser's ~16 context slots,
// and echarts instances stayed in echarts' own module-level registry forever.
// Callers removing a bubble/card call disposeRenderInstancesIn(el) first;
// renderHistory's global sweep now runs every registered disposer too.
const _renderDisposers = new Map(); // el -> Set<() => void> (entries deleted on dispose; bounded by live diagrams)

function _addDisposer(el, fn) {
  let set = _renderDisposers.get(el);
  if (!set) { set = new Set(); _renderDisposers.set(el, set); }
  set.add(fn);
}

/** Dispose every live render instance (charts, viewers, observers) whose
 * registered element is `scope` itself or lives inside it. Call BEFORE
 * removing a bubble/card from the DOM. */
export function disposeRenderInstancesIn(scope) {
  if (!scope) return;
  for (const [el, set] of [..._renderDisposers]) {
    if (el === scope || (scope.contains && scope.contains(el))) {
      _renderDisposers.delete(el);
      for (const fn of set) { try { fn(); } catch (_) {} }
    }
  }
}

function _observeResize(target, cb) {
  const ro = new ResizeObserver(cb);
  ro.observe(target);
  _chartObservers.add(ro);
  // Targeted disposal must also drop the observer from the global set —
  // otherwise the disconnected RO (holding a strong ref to its target) stays
  // parked there until the next renderHistory sweep, leaking the detached
  // subtree it was watching.
  _addDisposer(target, () => { ro.disconnect(); _chartObservers.delete(ro); });
}
export function disposeChartObservers() {
  for (const ro of _chartObservers) { try { ro.disconnect(); } catch (_) {} }
  _chartObservers.clear();
  // Run every registered disposer (echarts instances on the wiped DOM would
  // otherwise stay in echarts' internal registry; observer entries are
  // idempotent after the sweep above) and drop the registry — renderHistory
  // replaces the whole DOM right after, so pinned elements must go with it.
  for (const [, set] of _renderDisposers) {
    for (const fn of set) { try { fn(); } catch (_) {} }
  }
  _renderDisposers.clear();
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
        // Bake the CURRENT theme's backdrop (same constants as the smiles
        // export) — the chart canvas is transparent, and a dark-theme chart
        // exported onto white flips readability of nothing but looks broken;
        // a light-theme chart exported onto #16181d likewise.
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        _downloadDataUrl(chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: dark ? '#16181d' : '#ffffff' }), 'chart.png');
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
    let wrapper = null; // 提升到 try 外：catch 要在 pre 已脱挂后换 wrapper
    let chart = null;
    try {
      const option = sanitizeEchartsText(JSON.parse(source));
      wrapper = document.createElement('div');
      wrapper.className = 'echarts-diagram';
      const container = document.createElement('div');
      container.style.cssText = 'width:100%;height:100%;'; // 填满可拖拽 wrapper
      wrapper.appendChild(container);
      pre.replaceWith(wrapper);
      // Dark theme: echarts ships a built-in 'dark' theme — without it the
      // default theme's #333/#6E7079 title/axis/legend text renders ~2:1 on
      // the dark wrapper (all five sibling renderers adapt; echarts was the
      // odd one out). Canvas stays transparent so the wrapper's themed
      // --bg-2 shows through, unless the model's option picks its own bg.
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      chart = echartsModule.init(container, isDark ? 'dark' : undefined);
      if (option && typeof option === 'object' && !('backgroundColor' in option)) option.backgroundColor = 'transparent';
      chart.setOption(option);
      wrapper.appendChild(_echartsToolbar(source, chart, container));
      // Re-render when container width changes (e.g. panel resize)
      _observeResize(container, () => chart.resize());
      // The instance must be DISPOSED, not just unwatched: echarts keeps
      // every instance in its own module-level registry keyed by the DOM
      // node, so an undisposed chart on a deleted bubble never GCs (canvas
      // + listeners + the whole option tree stay reachable).
      _addDisposer(wrapper, () => { try { chart.dispose(); } catch (_) {} });
    } catch (e) {
      console.warn('browsa: echarts render failed', e);
      try { chart?.dispose?.(); } catch (_) {}
      // 原始 JSON 必须活过渲染失败（可拷贝、可拿去追问）——此前 echarts 是
      // 六个渲染器里唯一把源码块销毁成一行无样式文本的。
      // 失败可能发生在 pre.replaceWith(wrapper) 之后（合法 JSON 但非法 option，
      // init/setOption 抛错）——那时 pre 已脱挂、对其 replaceWith 是规范定义的
      // 无操作，错误卡会静默丢失且 disposer 未注册。换已入 DOM 的 wrapper，
      // 两种失败时序（JSON.parse 失败 / init·setOption 失败）都成立。
      (wrapper || pre).replaceWith(_diagramErrorCard('ECharts', source, e));
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
  getViz();
  getEcharts();
  getMarkmapLib();
  getMarkmapView();
  // RDKit/Mol* 的 getter 失败会 rethrow（失败清缓存保重试语义），而预热是
  // fire-and-forget——吞掉拒绝，否则预热撞上加载失败时每次都抛 unhandledrejection。
  getRDKit().catch(() => {});
  getMolstar().catch(() => {});
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
    { title: _msg('mermaidExportPng', '导出PNG'), text: '↓', action: _exportAction('↓', () => _exportSvgWrapAsPng(wrapper, 'mindmap.png')) },
  ]);
}

// markmap 节点内容消毒（2026-10-01）：markmap-lib 以 html:true 解析围栏，节点
// HTML 经 markmap-view 的 d3 innerHTML 直入扩展页 DOM——六渲染器里唯一不过
// 消毒的路径（mermaid 有 sanitizeMermaidSvg 对照）。script/iframe/object/
// embed/form 等结构由 DOMPurify 剥除（CSP 挡得住 script 执行，挡不住结构注入
// 的资源加载/表单），URI 属性由 render.js 的全局 uponSanitizeAttribute 钩子
// 一并把关；锚点的 target/rel 由 renderMarkmap 里的 decorateLinks 补。
// 导出以便 jsdom 直接单测（Markmap.create 依赖真实布局，jsdom 测不了整条链）。
export function sanitizeMarkmapNodeHtml(html) {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style', 'link', 'meta', 'base'],
  });
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
    // markmap-view ships a full `.markmap-dark .markmap { … }` palette
    // override (node text #333 → light) in its injected globalCSS, but
    // nothing ever activated it — mind maps rendered ~1.7:1 node text on
    // the dark wrapper. Same matchMedia read the other renderers use.
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) wrapper.classList.add('markmap-dark');
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'markmap-svg');
    wrapper.appendChild(svgEl);
    pre.replaceWith(wrapper);
    try {
      if (!lib || !view) throw new Error(_msg('markmapLoadFailed', 'markmap 模块加载失败，请检查控制台'));
      const { root } = new lib.Transformer().transform(source);
      const mm = view.Markmap.create(svgEl, {}, root);
      // 节点内容消毒 + 锚点外链加固（见 sanitizeMarkmapNodeHtml 注释）。
      for (const fo of svgEl.querySelectorAll('foreignObject')) {
        fo.innerHTML = sanitizeMarkmapNodeHtml(fo.innerHTML);
      }
      decorateLinks(wrapper);
      wrapper.appendChild(_markmapToolbar(mm, source, svgEl, wrapper));
      // Re-fit when the container width changes (e.g. side panel resize),
      // same rationale as renderEcharts's ResizeObserver -> chart.resize().
      _observeResize(wrapper, () => mm.fit());
    } catch (e) {
      console.warn('browsa: markmap render failed', e);
      wrapper.replaceWith(_diagramErrorCard('Markmap', source, e));
    }
  }
}

// ─── Diff syntax highlighting ─────────────────────────────────────────────────
// highlight.js's own `diff` grammar (already in the common bundle, `patch` is
// its alias) — the standard tokenizer for +/-/@@ lines. Before 2026-09-29 this
// was a hand-rolled per-line classifier, exactly the "self-rolled where an
// industry-standard exists" pattern the Mol*/viz-js swaps closed; the grammar
// was sitting unused in the vendor the whole time. Theme CSS carries the
// hljs-addition/deletion/meta colors (diff-scoped green override in
// sidepanel.css keeps the +/- green/red the hand-rolled version showed).
export function highlightDiffBlocks(el) {
  for (const code of el.querySelectorAll('code.language-diff, code.language-patch')) {
    if (code.dataset.diffDone) continue;
    code.dataset.diffDone = '1';
    code.innerHTML = hljs.highlight(code.textContent, { language: 'diff' }).value;
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
export const FENCED_RENDERERS = ['mermaid', 'echarts', 'markmap', 'smiles', 'pdb', 'dot'];
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
  dot: (el) => renderDot(el),
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
const PUNCT_RE = /[\p{P}\p{S}]/u;
const BOLD_SPAN_RE = /\*\*([^\n*]*?)\*\*/g;
// Marked's emphasis flanking rules treat ANY letter/digit (CJK 汉字 ⊂ \p{L}, but
// also ASCII words like "MRR") before a punctuation-opening `**` the same way —
// and its punctuation class includes \p{S} symbols ($, ×, +, %, |…) that plain
// \p{P} misses. Both classes must mirror that, or `从**$8K**` / `**2.5×**涨到`
// stay literal asterisks (2026-09-30 field report, found via a 810-case fuzz).
const LETTERLIKE_RE = /[\p{L}\p{N}]/u;
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
    const openPad = (LETTERLIKE_RE.test(before) && PUNCT_RE.test(inner[0])) ? ' ' : '';
    const closePad = (LETTERLIKE_RE.test(after) && PUNCT_RE.test(inner[inner.length - 1])) ? ' ' : '';
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

// 数学提取的代码围栏护栏（2026-10-01）：```/~~~ 围栏与行内 `code` 里的 $…$/$$
// 是逐字数据不是公式——LaTeX 教程恰恰把原始 LaTeX 放进围栏防渲染，shell/awk
// 文档的 `echo $$` 还会跨围栏配对成一个大"公式"。与 fixCjkEmphasisSpacing 同款
// split，只在正文段（偶数位）跑两条提取；mathParts 由调用方持有以便渲染回填，
// 两套正则与护栏语义（\\、\$ 先吃 / 行内 $ 的 Pandoc 紧凑规则）自 renderSafe
// 原样迁入，逐字节未变。
const _MATH_CODE_SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;
function _extractMathOutsideCode(text, mathParts) {
  return text.split(_MATH_CODE_SPLIT_RE).map((part, seg) => {
    if (seg % 2 === 1) return part; // fenced/inline code — verbatim data, never touched
    return part
      // Block math: $$...$$ or \[...\]. The two leading alternatives consume
      // the markdown escapes \\ and \$ verbatim FIRST — a price like \$8K in a
      // table must reach marked as \$ (→ literal $), never lose its $ to the
      // math scanner (2026-09-30 field report: \$8K | \$20K in one table row
      // paired into the invalid formula "8K | \" → red katex-error echo).
      .replace(/\\\\|\\\$|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (m, a, b) => {
        if (a === undefined && b === undefined) return m; // \\ or \$ — markdown escape, left for marked
        const k = mathParts.push({ displayMode: true,  formula: (a ?? b).trim() }) - 1;
        return `\n\nBROWSAMATH${k}END\n\n`;
      })
      // Inline math: $...$ or \(...\) — same \\ / \$ escape guard as block math
      // (leftmost-match wins, so a \\ INSIDE $...$ still rides within the formula),
      // plus Pandoc's inline-$ delimiter rules (battle-tested against prose full
      // of dollar amounts): tight opening/closing (no space right after the
      // opener / right before the closer) and the closer must not be followed
      // by a digit. Field report 2026-09-30: 从**$8K**、**$20K** paired the two
      // bare $ into the "formula" 8K**、** — KaTeX rendered the *s as ∗ (U+2217)
      // and the bubble showed the ∗∗、∗∗ wreckage. A rejected candidate returns
      // m verbatim — marked keeps seeing plain text.
      .replace(/\\\\|\\\$|\$([^$\n]+?)\$|\\\(([^)]+?)\\\)/g, (m, a, b, offset, str) => {
        if (a === undefined && b === undefined) return m; // \\ or \$ — markdown escape, left for marked
        if (a !== undefined && (/^\s|\s$/.test(a) || /\d/.test(str[offset + m.length] || ''))) return m;
        const k = mathParts.push({ displayMode: false, formula: (a ?? b).trim() }) - 1;
        return `BROWSAMATH${k}END`;
      });
  }).join('');
}

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
      });
    // 数学提取走 _extractMathOutsideCode：```/~~~ 围栏与行内 code 让出、只跑
    // 正文段（此前围栏里的 $…$ 与跨围栏配对的 echo $$ 会被吞成公式占位符，
    // 流式正常、DONE/历史渲染一过就损坏）。两条正则与护栏语义原样迁入 helper。
    md = _extractMathOutsideCode(md, mathParts);

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

// 追问卡引用块的公式补渲染（2026-09-26 用户报告：选中的公式在追问卡引用里
// 显示为 LaTeX 源码/纯文本）。引用文本由 math-copy 的 selectionTextWithMath
// 生成——公式已是 $…$ / $$…$$（与原始 markdown 同形），这里只把成对的公式段
// 换成 KaTeX，其余文字保持逐字文本节点。刻意不走 renderSafe（那是全量
// Markdown，会把引用里的普通文本——标题井号、下划线、星号——再解释一遍，
// 篡改选区原意）；delimiters 只认我们自己的提取产物，代码/价格里的落单 $ 不受
// 影响（成对字面 $ 的假阳性理论存在，属可接受小代价）。
export async function renderMathInPlainText(el) {
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.includes('$')) targets.push(n);
  }
  const parts = []; // { displayMode, formula } — 传给 renderMathBatch（内部自带归一化）
  const plan = [];  // per node: { node, segments: [{type:'text',text} | {type:'math',idx}] }
  for (const node of targets) {
    const text = node.nodeValue;
    const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
    const segments = [];
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) segments.push({ type: 'text', text: text.slice(last, m.index) });
      const displayMode = m[1] !== undefined;
      const formula = (displayMode ? m[1] : m[2]).trim();
      segments.push({ type: 'math', idx: parts.push({ displayMode, formula }) - 1 });
      last = m.index + m[0].length;
    }
    if (!segments.length) continue;
    if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
    plan.push({ node, segments });
  }
  if (!plan.length) return;
  const results = await renderMathBatch(parts);
  for (const { node, segments } of plan) {
    if (!node.parentNode) continue; // 引用块被流式重渲染整体换掉时静默让位
    const frag = document.createDocumentFragment();
    for (const seg of segments) {
      if (seg.type === 'text') {
        frag.appendChild(document.createTextNode(seg.text));
      } else {
        const part = parts[seg.idx];
        const result = results?.[seg.idx];
        const holder = document.createElement(part.displayMode ? 'div' : 'span');
        holder.className = part.displayMode ? 'math-block' : 'qtex-inline';
        // KaTeX 输出受信（与 renderSafe 同一信任路径）；失败回落源码形态
        holder.innerHTML = result?.ok
          ? result.html
          : part.displayMode ? escM(part.formula) : `<code>${escM(part.formula)}</code>`;
        frag.appendChild(holder);
      }
    }
    node.parentNode.replaceChild(frag, node);
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
      span.title = tSub('tsJumpTo', '跳转到 $1', m[0].replace(/^\*Content-/, ''));
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
// Closing-fence test WITHOUT per-line regex compilation. The boundary scan
// re-runs on every reveal frame over the whole open tail, and while a fence
// streams that tail IS the fence — the `new RegExp(...)` this replaces was
// compiled once per fence line per frame (a 300-line block at ~30fps =
// ~9000 compilations/s), the residual O(lines×frames) hot spot the blockwise
// commit was built to remove. Same semantics as the old
// /^[ \t]{0,3}\`{N,}[ \t]*$/ pattern: ≤3 leading blanks, ≥minLen fence
// chars, then only blanks to end of line.
function _isCloseFence(line, ch, minLen) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i > 3) return false;
  let n = 0;
  while (i < line.length && line[i] === ch) { i++; n++; }
  if (n < minLen) return false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

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
      if (_isCloseFence(line, fenceChar, fenceLen)) inFence = false;
    } else {
      // 缩进上限刻意只认 ≤3 空格（2026-10-01 取舍，勿「修」成列表感知）：列表
      // 项内 ≥4 空格缩进的围栏（CommonMark 合法）流式中不被识别，围栏体内的
      // 空行会被当边界提交——仅瞬态观感（DONE 全量 renderSafe 自愈，marked
      // 那边处理正确）。真修需要容器感知的列表缩进测量，误修成「任意 ≥4 空格
      // 即围栏」反而会把普通缩进代码块从中间错切。
      // （[ \t] 必须单反斜杠——09-22 初版曾写成 [ \\t]，字符类退化为「反斜杠
      // 或字母 t」，1-3 空格缩进的围栏/列表行在流式中全部识别失效，DONE 自愈
      // 故长期无人察觉。改双反斜杠 = 回归这个 bug。）
      const opener = /^([ \t]{0,3})(`{3,}|~{3,})/.exec(line);
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
        if (nextLine === null || !/^[ \t]{0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t])/.test(nextLine)) best = i;
      }
    }
    i = nl + 1;
  }
  return best;
}

// When the ENTIRE open tail is one unclosed fenced code block, return
// { lang, body } so createStreamingTarget can paint it directly instead of
// re-parsing it. Returns null for anything else (no opener, closed fence,
// content after the fence). `lang` is the opener info string's first word
// (marked's language-class convention), '' when bare.
function _openFenceTail(tail) {
  // The committed boundary sits at the START of the blank-line run that
  // ended the previous block, so the tail usually begins with '\n' — skip
  // leading blank lines (they render as nothing) before matching the opener.
  let start = 0;
  while (start < tail.length) {
    const nl0 = tail.indexOf('\n', start);
    const line0 = nl0 === -1 ? tail.slice(start) : tail.slice(start, nl0);
    if (line0.trim() !== '') break;
    if (nl0 === -1) return null; // tail is ALL blank — no fence
    start = nl0 + 1;
  }
  const rest = tail.slice(start);
  const nl = rest.indexOf('\n');
  const firstLine = nl === -1 ? rest : rest.slice(0, nl);
  const opener = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(firstLine);
  if (!opener) return null;
  const ch = opener[1][0];
  const minLen = opener[1].length;
  // Scan the rest for a closing fence — a closed fence (even without a
  // following blank line) is NOT fast-path material: it commits through the
  // normal marked path on the next boundary.
  let i = nl === -1 ? rest.length : nl + 1;
  while (i < rest.length) {
    let nl2 = rest.indexOf('\n', i);
    if (nl2 === -1) nl2 = rest.length;
    if (_isCloseFence(rest.slice(i, nl2), ch, minLen)) return null;
    i = nl2 + 1;
  }
  const info = firstLine.slice(opener[0].length).trim();
  const lang = (info.match(/^\S+/) || [''])[0];
  return { lang, body: nl === -1 ? '' : rest.slice(nl + 1) };
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
  // Reused <pre><code> element while the tail stays one open fence (see
  // _openFenceTail) — per-frame cost drops from a full marked+DOMPurify
  // re-parse of the whole fence to one textContent assignment.
  let fenceTail = null; // { pre, code, lang }
  return {
    update(text) {
      if (text === lastText) return; // frozen input (closed think block; display idle while think streams) — no work
      lastText = text;
      // CRLF 归一化：空行（"\r"）与闭栏（"```\r"）判定只认 \n——含 \r\n 的回复
      // 会让所有边界失效，整段停在全量重解析路径（每帧对全部累计文本跑
      // marked+DOMPurify，批C 专门消灭的 O(n²) 回归）。整串归一化是前缀稳定
      // 的（\r\n→\n 只删 \r），已提交边界在后续帧仍指向同一内容位置。
      if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
      if (text.length < committed) {
        // Defensive: the prefix-stability invariant above says this can't
        // happen; if it ever does, start over rather than render garbage.
        host.innerHTML = '';
        committed = 0;
        tailNodes = [];
        fenceTail = null;
      }
      const boundary = findStreamingBlockBoundary(text, committed);
      if (boundary > committed) {
        const chunkHtml = renderStreamingSafe(text.slice(committed, boundary));
        for (const n of tailNodes) n.remove();
        tailNodes = [];
        fenceTail = null; // a committed chunk may have absorbed the fence — never resurrect a stale element
        host.insertAdjacentHTML('beforeend', chunkHtml);
        committed = boundary;
      }
      for (const n of tailNodes) n.remove();
      tailNodes = [];
      const tail = text.slice(committed);
      if (!tail) { fenceTail = null; return; }
      // Fast path: an open fence is the ONE unbounded tail block — streaming
      // a 300-line code block used to re-parse the entire fence through
      // marked+DOMPurify every frame (~300KB/s of re-parse at 30fps), the
      // exact O(n²)-over-the-stream class the blockwise commit exists to
      // prevent (paragraphs are bounded, fences are not). Paint it directly:
      // textContent can't execute, so skipping sanitize is safe by
      // construction; the shape mirrors marked's <pre><code class=language-*>
      // output. Transient by design — DONE's full renderSafe re-render is the
      // definitive one (hljs + copy buttons only exist post-DONE anyway).
      const f = _openFenceTail(tail);
      if (f) {
        if (!fenceTail || fenceTail.lang !== f.lang) {
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          if (f.lang) code.className = `language-${f.lang}`;
          pre.appendChild(code);
          fenceTail = { pre, code, lang: f.lang };
        }
        fenceTail.code.textContent = f.body;
        tailNodes = [fenceTail.pre];
        host.append(fenceTail.pre);
        return;
      }
      fenceTail = null;
      const t = document.createElement('template');
      t.innerHTML = renderStreamingSafe(tail);
      tailNodes = [...t.content.childNodes];
      host.append(...tailNodes);
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
  // splitThink memo (2026-09-30 批C): rAF frames that fire with no newly
  // revealed text (pacer tick cadence > delta cadence, e.g. the resume seed's
  // catch-up frames) skip the O(buffer) regex split + string rebuilds.
  // Growth frames still rebuild both strings — unavoidable, the downstream
  // freeze-checks compare full strings — so an incremental tag state machine
  // was evaluated and NOT warranted (the scan is µs at typical sizes; the
  // memo kills the repeated-identical-frame case, which is the real waste).
  let lastSplitInput = null;
  let lastSplitResult = null;
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
      if (fullAccum !== lastSplitInput) {
        lastSplitInput = fullAccum;
        lastSplitResult = splitThink(fullAccum);
      }
      const { display, think } = lastSplitResult;
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
  // Reveal everything enqueued so far at once (no pacing). The mid-stream
  // resume path seeds the renderer with the PEEK's already-accumulated text
  // in ONE enqueue — without this it would fake-type that whole backlog at
  // the pacer's ~1000 chars/s default (a 30KB reply = ~30s of re-typing text
  // the user is returning to, not watching arrive). Live deltas after the
  // seed keep normal pacing.
  renderStream.flush = () => pacer.flush();
  return renderStream;
}

// ─── Chemistry / biostructures (RDKit + Mol*) ────────────────────────────────
// Same "model emits a fenced block, the pipeline swaps it for a live render"
// pattern as mermaid/echarts/markmap, for two formats LLMs natively speak:
//
//   ```smiles          → 2D chemical structure diagram, drawn by RDKit
//                        (render.js renderSmiles, SVG with viewBox). Reaction
//                        SMILES (reactants>agents>products, contains '>')
//                        routes to get_rxn — plain molecule SMILES can never
//                        contain '>', so the discrimination is lossless.
//                        RDKit is also the VALIDATOR: get_mol/get_rxn return
//                        null for chemically impossible input → an explicit
//                        error note with the raw text kept (renderDot's
//                        pattern), never a silently-wrong drawing. Molecules
//                        get a descriptor property line (MW/logP/TPSA/HBD/HBA
//                        — the small-molecule analog of the pLDDT legend).
//   ```pdb\n1UBQ\n```  → interactive 3D viewer for an RCSB PDB structure
//                        (Mol* WebGL; the ID is fetched from files.rcsb.org
//                        at render time — models must NEVER emit raw ATOM
//                        coordinates, they would be fabricated)
//   ```pdb\nAF-P00533-F1\n``` → the same viewer for an AlphaFold DB predicted
//                        model. The accession is resolved through the DB's
//                        API (versions advance — hardcoding model_vN 404s) to
//                        the CURRENT .pdb file. AlphaFold models render with
//                        molstar's BUILT-IN pLDDT-confidence preset
//                        (preset-structure-representation-ma-quality-assessment-
//                        plddt) — its four bands are byte-identical to AlphaFold
//                        DB's palette (pLDDT travels in the PDB B-factor
//                        column); our own compact .pdb-legend strip stays as the
//                        visible key because molstar's legend lives in the
//                        controls panel we hide.
//
// Mol* (2026-09-29, replacing 3Dmol.js — user call: "业内都用 Mol*") is what
// RCSB PDB / PDBe / AlphaFold DB themselves embed, and it natively ships the
// information layer 3Dmol lacked: hover residue tooltips, click highlight, and
// the sequence strip. It's an IIFE assigning the `molstar` global — RAW-copied
// by build.mjs and loaded here via a classic <script> tag plus a <link> for
// molstar.css (the plugin layout is styles, not inline). Zero worker spawns in
// the bundle; its only wasm (h264-mp4-encoder, snapshot video export) is never
// invoked by browsa.

let rdkitPromise = null;
export function getRDKit() {
  if (!rdkitPromise) {
    rdkitPromise = new Promise((resolve, reject) => {
      if (window.initRDKitModule) { resolve(window.initRDKitModule()); return; }
      const script = document.createElement('script');
      script.src = new URL('../vendor/RDKit_minimal.js', import.meta.url).href;
      script.onload = () => {
        try {
          if (window.initRDKitModule) resolve(window.initRDKitModule());
          else reject(new Error('RDKit loaded but initRDKitModule missing'));
        } catch (e) { reject(e); } // factory can throw synchronously on wasm failure
      };
      script.onerror = () => reject(new Error('RDKit script failed to load'));
      document.head.appendChild(script);
    }).catch((e) => { rdkitPromise = null; throw e; });
  }
  return rdkitPromise;
}

let molstarPromise = null;
export function getMolstar() {
  if (!molstarPromise) {
    molstarPromise = new Promise((resolve, reject) => {
      if (window.molstar?.Viewer) { resolve(window.molstar); return; }
      // Inject the stylesheet BEFORE the script so the first paint after init
      // is already laid out (idempotent via the data attribute).
      if (!document.querySelector('link[data-molstar]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.molstar = '';
        link.href = new URL('../vendor/molstar.css', import.meta.url).href;
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      script.src = new URL('../vendor/molstar.js', import.meta.url).href;
      script.onload = () => {
        if (window.molstar?.Viewer) resolve(window.molstar);
        else reject(new Error('molstar loaded but molstar global missing'));
      };
      script.onerror = () => reject(new Error('molstar script failed to load'));
      document.head.appendChild(script);
    }).catch((e) => { molstarPromise = null; throw e; });
  }
  return molstarPromise;
}

// Every live Mol* Viewer holds a WebGL context. renderHistory wipes and
// re-renders the whole conversation, and browsers cap active WebGL contexts
// (~16) — without an explicit dispose, enough pdb blocks across re-renders
// would starve the cap and silently kill older viewers' contexts. Disposed
// alongside the chart ResizeObservers from renderHistory.
const _molstarViewers = new Set();
export function disposeMolstarViewers() {
  for (const v of _molstarViewers) { try { v.dispose(); } catch (_) {} }
  _molstarViewers.clear();
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

// AlphaFold DB's pLDDT confidence palette (the four bands shown on
// alphafold.ebi.ac.uk) is owned by molstar's built-in 'plddt-confidence' color
// theme since the Mol* swap — the legend strip below repeats the same hex
// values, do not let them drift apart.

export async function renderSmiles(el) {
  const blocks = el.querySelectorAll('code.language-smiles');
  if (!blocks.length) return;
  let rdk;
  try { rdk = await getRDKit(); } catch (_) { return; } // vendor failed — keep the code block
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const smiles = code.textContent.trim();
    if (!smiles) continue;
    // RDKit IS the validator: get_mol/get_rxn return null for chemically
    // impossible input (pentavalent carbon, broken ring closures, garbage) —
    // surface that as an explicit error note with the raw text kept readable
    // (renderDot's invalid-DOT pattern). Never draw chemistry silently wrong.
    const isReaction = smiles.includes('>');
    const parsed = isReaction ? rdk.get_rxn(smiles) : rdk.get_mol(smiles);
    if (!parsed) {
      if (code.dataset.smilesInvalid) continue; // 双渲染防重（DONE + 历史升级各跑一次）
      code.dataset.smilesInvalid = '1';
      const note = document.createElement('div');
      note.className = 'smiles-error';
      note.textContent = _msg('smilesInvalid', '不是有效的化学结构，已保留原文');
      pre.parentNode.insertBefore(note, pre);
      continue;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'smiles-block';
    // Hover toolbar — same affordance as mermaid/echarts/markmap: copy the
    // source and export the diagram (both PNG and SVG — everything is vector
    // now, molecules and reactions alike).
    const toolbar = _chemToolbar(wrapper, smiles);
    // Swap BEFORE rendering (like renderMarkmap's replaceWith-then-render): on
    // any failure below, the wrapper is swapped back to the original pre so
    // the raw SMILES never disappears.
    pre.replaceWith(wrapper);
    try {
      const width = Math.min(Math.max(el.clientWidth || 0, 280), 460);
      const height = Math.round(width * 0.72);
      let svg, desc = null;
      try {
        svg = parsed.get_svg(width, height);
        if (!isReaction) {
          // Property line (the small-molecule analog of the pLDDT legend):
          // RDKit descriptors — exactmw, CrippenClogP, tpsa, NumHBD/NumHBA.
          try { desc = JSON.parse(parsed.get_descriptors()); } catch (_) {}
        }
      } finally {
        try { parsed.delete(); } catch (_) {} // free the WASM-heap Mol/Reaction
      }
      svg = rethemeRdkitSvg(svg, isDark);
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      const svgEl = holder.firstElementChild;
      svgEl.classList.add('smiles-svg');
      wrapper.append(svgEl);
      if (desc) wrapper.appendChild(_smilesCaption(desc));
      wrapper.appendChild(toolbar);
    } catch (_) {
      wrapper.replaceWith(pre);
    }
  }
}

// RDKit inlines a white background <rect> and black ink via style attributes.
// Bubble-native theming: drop the background in both themes (the bubble's own
// background shows through, same as mermaid/dot SVGs); dark mode rewrites the
// black ink to light gray. CPK heteroatom colors (O red, N blue, S yellow…)
// are chemistry semantics — deliberately kept, never CSS-inverted.
// Pure, exported for tests.
export function rethemeRdkitSvg(svg, isDark) {
  let out = svg.replace('fill:#FFFFFF', 'fill:none');
  if (isDark) out = out.replaceAll('#000000', '#E1E1E6');
  return out.slice(out.indexOf('<svg')); // strip the <?xml?> prolog for innerHTML
}

// Molecular property line under a rendered structure. Chip visual is shared
// with the pLDDT legend (.pdb-legend CSS); labels are universal chemistry
// abbreviations — no translation needed. MW = average molecular weight (amw,
// the textbook value; exactmw is the monoisotopic mass-spec number).
function _smilesCaption(desc) {
  const bar = document.createElement('div');
  bar.className = 'smiles-caption';
  const chips = [
    ['MW', Number(desc.amw ?? desc.exactmw ?? 0).toFixed(2)],
    ['logP', Number(desc.CrippenClogP ?? 0).toFixed(2)],
    ['TPSA', Number(desc.tpsa ?? 0).toFixed(1)],
    ['HBD/HBA', `${desc.NumHBD ?? 0}/${desc.NumHBA ?? 0}`],
  ];
  for (const [label, value] of chips) {
    const chip = document.createElement('span');
    chip.className = 'smiles-caption-chip';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    chip.append(l, v);
    bar.appendChild(chip);
  }
  return bar;
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
      if (!svg) throw new Error('nothing to export yet');
      // Vector source: rasterize at 2x for a crisp PNG via an offscreen
      // canvas. The rethemed RDKit SVG is background-transparent — bake the
      // current theme's backdrop or dark-mode ink exports unreadable.
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      _downloadDataUrl(await _rasterizeSvg(svg, { bg: dark ? '#16181d' : '#ffffff' }), 'structure.png');
    }),
  });
  // One ↓ = one PNG, on all six renderers (2026-09-30 export unification):
  // smiles' extra "SVG" text button is gone — same glyph, same format, same
  // themed-backdrop contract everywhere. (The raw source stays one click away
  // via the copy button, which is what an editable vector export was for.)
  return _diagramToolbar(specs);
}

function _downloadDataUrl(dataUrl, name) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

export async function renderPdb(el) {
  const blocks = el.querySelectorAll('code.language-pdb');
  if (!blocks.length) return;
  let lib;
  try { lib = await getMolstar(); } catch (_) { return; } // vendor failed — keep the code block
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
    let viewer = null;
    try {
      let data = parsed.value;
      let isAf = false;
      if (parsed.kind === 'id') {
        const status = document.createElement('div');
        status.className = 'pdb-status';
        status.textContent = `RCSB PDB ${parsed.value}`;
        // Inside viewerEl: .pdb-viewer is the positioned ancestor, so the
        // chip overlays the (still empty, fixed-height) viewer box during
        // the fetch instead of drifting to the bubble bottom.
        viewerEl.appendChild(status);
        const res = await fetch(`https://files.rcsb.org/download/${parsed.value}.pdb`);
        if (!res.ok) throw new Error(`RCSB HTTP ${res.status}`);
        data = await res.text();
        status.remove();
      } else if (parsed.kind === 'alphafold') {
        const status = document.createElement('div');
        status.className = 'pdb-status';
        status.textContent = `AlphaFold ${parsed.value}`;
        viewerEl.appendChild(status);
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
      // Mol* viewer, embedded-app config: viewport + top sequence strip only.
      // NOTE the gating quirk (molstar-ui plugin.js): layoutShowControls gates
      // the TOP region too — sequence strip dies with controls off — so keep
      // it on and hide each other region individually (left panel component
      // 'none', right collapsed, log off).
      viewer = await lib.Viewer.create(viewerEl, {
        layoutIsExpanded: false,
        layoutShowControls: true,
        layoutShowLeftPanel: false,
        layoutShowRemoteState: false,
        layoutShowSequence: true,
        layoutShowLog: false,
        collapseRightPanel: true,
        viewportShowExpand: false,
        viewportShowControls: false,
        viewportShowSelectionMode: false,
        viewportShowAnimation: false,
        viewportShowTrajectoryControls: false,
        viewportBackgroundColor: isDark ? 'black' : 'white',
        pdbProvider: 'rcsb',
        emdbProvider: 'rcsb'
      });
      _molstarViewers.add(viewer);
      // The model/data → trajectory → model/structure/representation chain in
      // ONE call: the 'default' trajectory-hierarchy preset takes a
      // representationPreset id resolved against the REPRESENTATION registry
      // (hierarchy.applyPreset's own string lookup only knows the hierarchy
      // presets — passing the representation id there silently no-ops, found
      // live: the state tree stopped at trajectory-from-pdb with no error).
      // AlphaFold models get molstar's built-in pLDDT-confidence preset
      // (B-factor = pLDDT there), plain structures the standard auto preset.
      const molData = await viewer.plugin.builders.data.rawData({ data, label: parsed.value });
      const trajectory = await viewer.plugin.builders.structure.parseTrajectory(molData, 'pdb');
      await viewer.plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default', {
        representationPreset: isAf
          ? 'preset-structure-representation-ma-quality-assessment-plddt'
          : 'preset-structure-representation-auto'
      });
      // The plugin's canvas follows WINDOW resizes but not its own container —
      // drive it when the user drags the viewer's resize handle (CSS
      // resize:vertical). Registered via _observeResize so BOTH the global
      // sweep (disposeChartObservers before renderHistory wipes) and the
      // targeted path (disposeRenderInstancesIn before a bubble delete)
      // disconnect it.
      _observeResize(viewerEl, () => {
        try { viewer.plugin.canvas3d?.requestResize?.(); } catch (_) {}
      });
      // Targeted disposal for the WebGL viewer itself: deleting a ```pdb
      // bubble used to leave a detached Mol* plugin running its continuous
      // rAF render loop — burning CPU/GPU and holding one of the browser's
      // ~16 WebGL context slots until the next full renderHistory.
      _addDisposer(viewerEl, () => {
        try { viewer.dispose(); } catch (_) {}
        _molstarViewers.delete(viewer);
      });
      if (isAf) wrapper.appendChild(_plddtLegend());
      // Hover toolbar (copy source + PNG export), appended AFTER Viewer.create
      // so molstar's init can't wipe it; PNG via the plugin's own canvas —
      // molstar renders continuously with preserveDrawingBuffer, toDataURL
      // captures the last frame.
      viewerEl.appendChild(_chemToolbar(wrapper, parsed.value, () => {
        try {
          const c = viewerEl.querySelector('canvas');
          return c ? c.toDataURL('image/png') : null;
        } catch (_) { return null; }
      }));
    } catch (e) {
      if (viewer) {
        try { viewer.dispose(); } catch (_) {}
        _molstarViewers.delete(viewer);
      }
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

// ─── Graphviz DOT（```dot fence, renderDot） ──────────────────────────────────
// 模型发 ```dot（Graphviz DOT 文本），viz-js（Graphviz 的 WASM 构建）渲染成
// SVG。2026-09-28 起取代手写的 ```nn 渲染器成为架构图主路径（用户拍板）：
// 自定义 JSON 规格对模型是零训练先验——字段全靠猜，猜错就被容错解析丢掉；
// 而 DOT 是 torchview/torchviz 的导出格式，模型见过海量「神经架构 → DOT」
// 样本，viz-js 顺带覆盖依赖图/数据流/状态机等一切通用图。dist 的 JS 把
// .wasm base64 内联成单文件（~1.5MB，懒加载），WebAssembly.instantiate 走
// 既有 'wasm-unsafe-eval' CSP；Node/jsdom 里也能真执行（测试跑真渲染）。
let vizModule = null;
let vizInstance = null;

async function getViz() {
  if (vizModule) return vizModule;
  try {
    vizModule = await import('../vendor/viz.bundle.js');
  } catch (e) {
    console.warn('browsa: viz load failed', e);
  }
  return vizModule;
}

async function getVizInstance() {
  if (vizInstance) return vizInstance;
  const mod = await getViz();
  if (!mod) return null;
  try {
    vizInstance = await mod.instance();
  } catch (e) {
    console.warn('browsa: viz wasm init failed', e);
    return null;
  }
  return vizInstance;
}

// Graphviz 自身从不出 <script>/事件处理器/foreignObject，但 DOT 的 href/URL
// 属性会变成 <a xlink:href=…>（实测）——剥掉 javascript: 目标与 on* 属性，
// 其余交还给 SVG 的原生安全面。
function _sanitizeDotSvg(svgEl) {
  svgEl.querySelectorAll('script').forEach((n) => n.remove());
  for (const el of svgEl.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      else if ((attr.name === 'href' || attr.name === 'xlink:href') && /^\s*javascript:/i.test(attr.value || '')) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

// Relative luminance of a fill color — hex (#rgb/#rrggbb) plus the small set
// of color names viz-js emits by default. Unknown names → undefined (skip).
function _fillLuminance(fill) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(fill || '');
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('').slice(0, 6);
    return 0.2126 * (parseInt(h.slice(0, 2), 16) / 255)
         + 0.7152 * (parseInt(h.slice(2, 4), 16) / 255)
         + 0.0722 * (parseInt(h.slice(4, 6), 16) / 255);
  }
  const names = { black: 0, white: 1, lightgrey: 0.83, lightgray: 0.83, grey: 0.5, gray: 0.5 };
  return names[String(fill || '').toLowerCase()];
}

// viz-js emits default-black ink over a white canvas polygon. Theme it the
// same way rethemeRdkitSvg themes RDKit: drop the white background both
// themes (bubble bg shows through); dark mode remaps DEFAULT-black
// ink/strokes to light while keeping colors the model chose deliberately.
// Plus a contrast rescue working in BOTH themes: models love
// `style=filled, fillcolor=black` without a matching fontcolor — dark shape
// + black label = unreadable — so any node filled darker than ~0.35
// luminance gets its label flipped to a light ink. Pure, exported for tests.
export function rethemeDotSvg(svgEl, isDark) {
  const INK_DARK = '#E1E1E6';
  for (const poly of svgEl.querySelectorAll('g.graph > polygon[fill="white"]')) {
    poly.setAttribute('fill', 'none');
  }
  if (isDark) {
    for (const t of svgEl.querySelectorAll('text')) {
      const f = t.getAttribute('fill');
      if (!f || f === 'black' || /^#0{3,6}$/i.test(f)) t.setAttribute('fill', INK_DARK);
    }
    for (const el of svgEl.querySelectorAll('path, polygon, ellipse, line')) {
      const s = el.getAttribute('stroke');
      if (!s || s === 'black' || /^#0{3,6}$/i.test(s)) el.setAttribute('stroke', '#9A9AA5');
      // arrowheads: black-filled polygons inside an edge group
      const fl = el.getAttribute('fill');
      if (el.closest('g.edge') && fl && (fl === 'black' || /^#0{3,6}$/i.test(fl))) {
        el.setAttribute('fill', '#9A9AA5');
      }
    }
  }
  for (const g of svgEl.querySelectorAll('g.node')) {
    const shape = g.querySelector('path, polygon, ellipse');
    const lum = _fillLuminance(shape?.getAttribute('fill'));
    if (lum !== undefined && lum < 0.35) {
      for (const t of g.querySelectorAll('text')) t.setAttribute('fill', isDark ? INK_DARK : '#F8F9FA');
    }
  }
}

export async function renderDot(el) {
  const blocks = el.querySelectorAll('code.language-dot');
  if (!blocks.length) return;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent;
    try {
      const viz = await getVizInstance();
      if (!viz) throw new Error('viz module load failed');
      const svgEl = viz.renderSVGElement(source);
      _sanitizeDotSvg(svgEl);
      rethemeDotSvg(svgEl, window.matchMedia('(prefers-color-scheme: dark)').matches);
      const wrapper = document.createElement('div');
      wrapper.className = 'dot-diagram';
      const svgWrap = document.createElement('div');
      svgWrap.className = 'mermaid-svg-wrap';
      svgWrap.appendChild(svgEl);
      wrapper.appendChild(svgWrap);
      // mermaid 的工具条/缩放/拖拽/导出全部是对 viewBox 的通用操作，直接复用。
      wrapper.appendChild(_mermaidToolbar(svgWrap, source));
      _mermaidInteractions(wrapper, svgWrap);
      pre.replaceWith(wrapper);
    } catch (e) {
      console.warn('browsa: dot render failed', e);
      // 无效 DOT：错误提示插在代码块前，原块保留（源码可读可复制、可让模型改）。
      const errDiv = document.createElement('div');
      errDiv.className = 'dot-error';
      errDiv.textContent = '⚠ DOT: ' + (e?.message || e);
      pre.parentNode.insertBefore(errDiv, pre);
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
      img.alt = tSub('figureAlt', '图$1', n);
      frag.appendChild(img);
      last = m.index + m[0].length;
      replaced = true;
    }
    if (!replaced) continue;
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
