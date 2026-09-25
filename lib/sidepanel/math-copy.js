// lib/sidepanel/math-copy.js — 选中公式复制得到 LaTeX 源码，而不是 MathML 碎片。
//
// 背景：公式用 KaTeX 的 output:'mathml' 渲染（见 render.js），浏览器把 <math>
// 序列化成纯文本时会在每个记号之间插换行——"Attention\n(\nQ\n,\nK\n,\nV\n)..."
// ——粘进别的文档完全不可用。LaTeX 源码其实一直在 DOM 里（KaTeX 输出自带的
// <annotation encoding="application/x-tex">），只是原生复制路径从不读它。
//
// 做法：拦截 copy 事件，只在「选区真的碰到公式」时接管（其余复制保持浏览器
// 原生行为一字不改）；把选区克隆一份、把每个 <math> 换成它的 LaTeX 源码
// （行内 $…$ / 块级 $$…$$，与原始 markdown 同形），再放进一个离屏容器读
// innerText 得到保留段落/表格/代码块结构的纯文本。选区只盖到公式一部分时
// （在公式内部起止拖拽）吸附到整个公式——半个公式的碎片本来就没意义。
// 任何一步出错都原样放行原生复制（fail-open）。

const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';
// 面板自己的交互件/元数据，复制正文时不该出现（原生复制也会漏进 code-copy-btn
// 的「复制」二字——顺手一并去掉）。
const CHROME_SELECTORS = [
  '.msg-actions', '.msg-time', '.token-usage', '.tool-history',
  '.code-copy-btn', '.think-copy-btn', '.mermaid-toolbar',
  '.mermaid-err-copy', '.markmap-err-copy', '.err-more summary',
  '.think-block > summary',
];

import { ICONS } from './icons.js';
import { _copyText } from './ui-utils.js';
import { t } from '../i18n.js';

// .katex 元素 → { tex, displayMode } | null（没有 annotation 的不换，原样保留）。
export function texSourceOf(katexEl) {
  const math = katexEl?.querySelector?.('math');
  if (!math) return null;
  const tex = (math.querySelector(TEX_ANNOTATION)?.textContent || '').trim();
  if (!tex) return null;
  return { tex, displayMode: math.getAttribute('display') === 'block' };
}

export function formatTex({ tex, displayMode }) {
  return displayMode ? `$$${tex}$$` : `$${tex}$`;
}

// 克隆片段里的每个 <math> 换成 LaTeX 文本节点；返回替换数量。
export function replaceMathWithTex(fragment) {
  let count = 0;
  for (const math of [...fragment.querySelectorAll('math')]) {
    const tex = texSourceOf(math.closest('.katex') || math);
    if (!tex) continue;
    (math.closest('.katex') || math).replaceWith(
      fragment.ownerDocument.createTextNode(formatTex(tex)));
    count++;
  }
  return count;
}

// 与选区相交的公式吸附为完整包含（只扩边界，不动用户可见选区）。
export function expandRangeToFormulas(range, katexEls) {
  const R = range.startContainer.ownerDocument.defaultView.Range;
  for (const k of katexEls) {
    if (!range.intersectsNode(k)) continue;
    const kr = range.startContainer.ownerDocument.createRange();
    kr.selectNode(k);
    if (range.compareBoundaryPoints(R.START_TO_START, kr) > 0) {
      range.setStart(kr.startContainer, kr.startOffset);
    }
    if (range.compareBoundaryPoints(R.END_TO_END, kr) < 0) {
      range.setEnd(kr.endContainer, kr.endOffset);
    }
  }
  return range;
}

export function stripCopyChrome(root) {
  root.querySelectorAll(CHROME_SELECTORS.join(',')).forEach((n) => n.remove());
}

// 离屏容器 + innerText：段落/列表/表格/代码块的换行由浏览器排版给出，
// 软换行不进文本。jsdom 没有 innerText，退回 textContent（仅测试路径）。
export function serializeNode(node, doc) {
  const host = doc.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:-99999px;width:800px;';
  host.setAttribute('aria-hidden', 'true');
  host.appendChild(node);
  doc.body.appendChild(host);
  try {
    let text = host.innerText;
    if (typeof text !== 'string' || !text.trim()) text = host.textContent || '';
    return { text: text.trim(), html: host.innerHTML };
  } finally {
    host.remove();
  }
}

// 选区 → 公式化片段（内部共享内核）：与选区相交的公式（含只盖到一部分的，
// 公共祖先落在 .katex 内的用 closest 补上）吸附为完整包含、换成 LaTeX 文本
// 节点、剥面板交互件。没碰到公式返回 null（调用方走各自的非公式路径）。
function mathifiedSelectionFragment(range, rootEl) {
  const self = rootEl.closest?.('.katex');
  const scope = self ? [self, ...self.querySelectorAll('.katex')] : [...rootEl.querySelectorAll('.katex')];
  const touched = scope.filter((k) => range.intersectsNode(k));
  if (!touched.length) return null;
  const work = range.cloneRange();
  expandRangeToFormulas(work, touched);
  const fragment = work.cloneContents();
  if (replaceMathWithTex(fragment) === 0) return null;
  stripCopyChrome(fragment);
  return fragment;
}

// 选区 → { text, html }；选区没碰到公式时返回 null（不接管）。
export function buildMathCopyPayload(messagesEl) {
  const doc = messagesEl.ownerDocument;
  const sel = doc.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const rootEl = root.nodeType === 1 ? root : root.parentElement;
  if (!rootEl || !messagesEl.contains(rootEl)) return null;

  const fragment = mathifiedSelectionFragment(range, rootEl);
  if (!fragment) return null;
  return serializeNode(fragment, doc);
}

// 选区 → 追问卡引用文本：碰到公式时公式吸附为整体并写成 LaTeX（$…$ / $$…$$，
// 与原始 markdown 同形——模型引用上下文里看到的也是干净 LaTeX 而不是 MathML
// 碎片），其余文本保持选区原生 toString；没碰到公式时逐字等于 sel.toString()
// （旧行为不变）。任何一步出错 fail-open 回 toString。
export function selectionTextWithMath(sel) {
  try {
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const fallback = sel.toString();
    const range = sel.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const rootEl = root.nodeType === 1 ? root : root.parentElement;
    if (!rootEl) return fallback;
    const fragment = mathifiedSelectionFragment(range, rootEl);
    if (!fragment) return fallback;
    return serializeNode(fragment, rootEl.ownerDocument).text || fallback;
  } catch (_) {
    try { return sel?.toString?.() ?? null; } catch (_2) { return null; }
  }
}

export function initMathCopy({ messagesEl } = {}) {
  if (!messagesEl) return;
  messagesEl.ownerDocument.addEventListener('copy', (e) => {
    try {
      if (!e.clipboardData) return;
      const payload = buildMathCopyPayload(messagesEl);
      if (!payload) return;
      e.clipboardData.setData('text/plain', payload.text);
      e.clipboardData.setData('text/html', payload.html);
      e.preventDefault();
    } catch (err) {
      // fail-open：拦截出错绝不能弄坏普通复制。
      console.warn('browsa: math copy interception failed, falling back to native copy', err);
    }
  });
}

// 公式悬浮「复制 LaTeX」按钮——与 mermaid/echarts 等图的 .mermaid-toolbar 同款
// 交互（hover 显现、点击 ✓ 反馈）。行内/块级公式都给；覆盖定位差异见 CSS
// （.katex 行内浮在公式上方，块级同 mermaid 落在角落）。
export function addMathCopyButtons(root) {
  if (!root) return;
  const doc = root.ownerDocument || document;
  for (const katex of root.querySelectorAll('.katex')) {
    if (katex.dataset.texCopy) continue;
    const src = texSourceOf(katex);
    if (!src) continue; // katex-error：显示的就是源码本身
    katex.dataset.texCopy = '1';
    const bar = doc.createElement('div');
    bar.className = 'mermaid-toolbar math-toolbar';
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'mermaid-btn';
    btn.title = t('mathCopyLatex', '复制 LaTeX');
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = ICONS.copy;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 点击时重读 annotation：流式重渲染会整体换 DOM，别信闭包里的旧值
      _copyText(formatTex(texSourceOf(katex) || src))
        .then(() => { btn.textContent = '✓'; setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500); })
        .catch(() => {});
    });
    bar.appendChild(btn);
    katex.appendChild(bar);
  }
}
