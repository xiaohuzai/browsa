// lib/sidepanel/render.js — Markdown/Mermaid/ECharts rendering pipeline for sidepanel.js.
// Extracted verbatim (Phase 3 of the sidepanel/background modularization
// refactor) from what used to be ~900 lines spread through sidepanel.js.

import marked from '../vendor/marked.bundle.js';
import DOMPurify from '../vendor/purify.bundle.js';
import katex from '../vendor/katex.bundle.js';
import hljs from '../vendor/highlight.bundle.js';
import { ICONS } from './icons.js';
import { escM, _copyText, showToast } from './ui-utils.js';

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

// ─── Mermaid ────────────────────────────────────────────────────────────────
let mermaidModule = null; // lazily loaded on first mermaid block

async function getMermaid() {
  if (mermaidModule) return mermaidModule;
  try {
    const { default: mermaid } = await import('../vendor/mermaid.bundle.js');
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // Expose KaTeX globally so Mermaid v11 can render $$...$$ math in node labels
    window.katex = katex;
    mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default', securityLevel: 'loose' });
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
  // Mermaid v10+ needs a DOM-attached container during render
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;opacity:0;pointer-events:none';
  document.body.appendChild(host);
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent;
    const errDiv = document.createElement('div');
    errDiv.className = 'mermaid-error';
    try {
      if (!m) throw new Error('mermaid 模块加载失败，请检查控制台');
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      const { svg } = await m.render(id, source, host);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      const svgWrap = document.createElement('div');
      svgWrap.className = 'mermaid-svg-wrap';
      svgWrap.innerHTML = svg;
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

export async function renderEcharts(el) {
  const blocks = el.querySelectorAll('code.language-echarts');
  if (!blocks.length) return;
  if (!echartsModule) {
    try {
      const mod = await import('../vendor/echarts.bundle.js');
      echartsModule = mod.default || mod;
    } catch (e) {
      console.warn('browsa: echarts load failed', e);
      return;
    }
  }
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent.trim();
    const errDiv = document.createElement('div');
    errDiv.className = 'echarts-error';
    try {
      const option = JSON.parse(source);
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
      if (lang && lang !== 'mermaid' && lang !== 'diff' && lang !== 'patch') {
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
      ADD_ATTR: ['target', 'rel'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|#)/
    });
  } catch (_) {
    return DOMPurify.sanitize(text || '');
  }
}

export function renderSafe(markdown) {
  try {
    const mathParts = []; // { displayMode: bool, formula: string }
    const thinkBlocks = []; // extracted <think>…</think> content

    let md = fixCjkEmphasisSpacing(markdown || '')
      // Extract <think>/<thinking> blocks before marked (handles Claude + DeepSeek).
      .replace(/<(?:think|thinking|antml:thinking)[^>]*>([\s\S]*?)<\/(?:think|thinking|antml:thinking)>/gi, (_, content) => {
        const i = thinkBlocks.push(content.trim()) - 1;
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
      ADD_ATTR: ['target', 'rel', 'data-think'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|#)/
    });

    // Restore rendered math after sanitization — KaTeX output is trusted.
    if (mathParts.length > 0) {
      html = html.replace(/BROWSAMATH(\d+)END/g, (_, idx) => {
        const { displayMode, formula } = mathParts[+idx];
        try {
          return katex.renderToString(formula, {
            output: 'mathml',
            throwOnError: false,
            displayMode,
            strict: false
          });
        } catch (_e) {
          return displayMode
            ? `<div class="math-block">${escM(formula)}</div>`
            : `<code>${escM(formula)}</code>`;
        }
      });
    }

    // Restore think blocks as collapsible <details> elements (after sanitization
    // so DOMPurify never sees the raw inner content).
    if (thinkBlocks.length > 0) {
      const openAttr = thoughtAutoCollapse ? '' : ' open';
      html = html.replace(/<div data-think="(\d+)"><\/div>/g, (_, idx) => {
        const inner = DOMPurify.sanitize(marked.parse(fixCjkEmphasisSpacing(thinkBlocks[+idx])));
        return `<details class="think-block"${openAttr}><summary>Thinking…</summary><div class="think-body">${inner}</div></details>`;
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

  return function renderStream(delta, isDone) {
    if (isDone) {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (thinkEl) { thinkEl.remove(); thinkEl = null; thinkBodyEl = null; }
      el.innerHTML = renderSafe(delta);
      el.classList.add('done');
      el.dataset.raw = delta; // raw markdown, mirrors appendUser's dataset.raw — read by openDetailThread
      addThinkCopyButtons(el);
      decorateLinks(el);
      onDone?.(el, delta);
      return;
    }
    fullAccum += delta;
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const { display, think } = splitThink(fullAccum);
      if (think) { ensureThinkEl(); thinkBodyEl.textContent = think; }
      el.innerHTML = renderStreamingSafe(display);
      el.classList.remove('done');
      onTick?.(el);
    });
  };
}
