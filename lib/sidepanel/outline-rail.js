// lib/sidepanel/outline-rail.js — 对话大纲侧栏（cherry-studio MessageAnchorLine
// 的轻量移植，2026-08-31 用户点名）：按「轮」分组——一条用户消息 + 其后的全部
// 回复/系统卡 = 一个 tick；细条贴 #messages 右缘常驻（少于 4 轮隐藏），点击滚到
// 该轮开头并闪一下，滚动跟随高亮当前轮，hover 在左侧浮出该轮用户消息预览。
//
// 结构：#messages 的第一个子元素是零高度 sticky 哨兵（.outline-rail），内部
// strip（仅 ticks）与 preview 卡（strip 的兄弟节点）都绝对定位——preview 不能
// 放进 strip：strip 为容纳超多轮有 overflow-y: auto，定位到 strip 左侧的
// preview 会被整块裁掉（0.35.3 事故之一）。strip 垂直位置由 layoutStrip() 按
// 滚动视口高度居中。
//
// 自愈注意：renderHistory 清空 innerHTML 会把 rail 连带拆掉，MutationObserver
// 触发 rebuild() 时检测脱挂并整体重建。**事件必须挂在 buildRail() 新建的
// strip 上，而不是只在 init 挂一次**——init 时 #messages 还是空的，真正的消息
// 渲染必然先拆掉初版 rail 再走自愈重建；监听若只挂 init 那份，重建后的 strip
// 就是死的（0.35.3 事故之二：tick 看得见但 hover/click 全无）。window resize
// 监听引用模块级变量、与 strip 实例无关，仍在 init 挂一次。

const MIN_TURNS = 4;
// jsdom 测试挂具未必注入 MutationObserver / requestAnimationFrame——缺失时
// 分别退化为「不自愈重建」与 setTimeout，真实 sidepanel 环境两者恒在。
const hasObserver = typeof MutationObserver !== 'undefined';
const raf = (cb) => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(cb)
  : setTimeout(cb, 0));
const FLASH_MS = 1600;
const READING_LINE_OFFSET = 72;
const PREVIEW_MAX_CHARS = 180;
const RAIL_INSET = 12; // strip 距滚动视口上/下的最小留白

let _messagesEl = null;
let _rail = null;
let _strip = null;
let _preview = null;
let _observer = null;
let _rebuildQueued = false;
let _spyQueued = false;
let _flashTimer = null;
let _lastTop = -1;
let _lastDense = false;

function _t(key, fallback) {
  return (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
}

/** 一轮的预览文本：用户消息原文优先（dataset.raw），无用户消息时用首条内容。 */
function turnPreview({ userEl, firstEl }) {
  const raw = userEl?.dataset?.raw || firstEl?.dataset?.raw || firstEl?.textContent || '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) + '…' : text;
}

/** 扫描 #messages 子元素 → 轮数组 [{ anchorEl, preview }]。rail 自身跳过。 */
function collectTurns() {
  const turns = [];
  for (const el of _messagesEl.children) {
    if (el === _rail) continue;
    if (!(el.classList.contains('msg'))) continue;
    if (el.classList.contains('user')) {
      turns.push({ anchorEl: el, userEl: el, firstEl: el });
    } else if (!turns.length) {
      // 会话开头没有用户消息（attach 系统卡直接出现）——系统卡自成一轮锚点
      turns.push({ anchorEl: el, userEl: null, firstEl: el });
    }
  }
  return turns;
}

function buildRail() {
  _rail = document.createElement('div');
  _rail.className = 'outline-rail';
  _strip = document.createElement('nav');
  _strip.className = 'outline-rail-strip';
  _strip.setAttribute('aria-label', _t('outlineAria', 'Conversation outline'));
  _preview = document.createElement('div');
  _preview.className = 'outline-rail-preview';
  _rail.appendChild(_strip);
  _rail.appendChild(_preview);
  // 事件挂在本轮新建的 strip 上——重建后必须重新接线，见文件头「自愈注意」
  _strip.addEventListener('click', (e) => {
    const tick = e.target.closest('.tick');
    if (!tick) return;
    scrollToTurn(tick);
    hidePreview();
  });
  _strip.addEventListener('mouseover', (e) => {
    const tick = e.target.closest('.tick');
    if (tick) showPreview(tick);
    else hidePreview();
  });
  _strip.addEventListener('mouseleave', hidePreview);
}

/** 重建 ticks（MutationObserver 触发；渲染层无需感知）。 */
function rebuild() {
  if (!_messagesEl) return;
  // renderHistory 清空 innerHTML 会连带清掉 rail 节点——检测脱挂即重建（自愈）
  if (!_rail?.isConnected) {
    buildRail();
    _messagesEl.insertBefore(_rail, _messagesEl.firstChild);
  }
  const turns = collectTurns();
  const visible = turns.length >= MIN_TURNS;
  _rail.classList.toggle('visible', visible);
  // 全量重建 ticks（数量级 ≤ 几十，代价可忽略）
  while (_strip.firstChild) _strip.firstChild.remove();
  turns.forEach((turn, i) => {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tick' + (i === turns.length - 1 ? ' active' : '');
    tick.setAttribute('aria-label', turnPreview(turn) || _t('outlineEmpty', '(empty)'));
    tick.dataset.turn = String(i);
    tick._turn = turn;
    _strip.appendChild(tick);
  });
  if (!visible) {
    _lastTop = -1;
    return;
  }
  layoutStrip();
  updateActive();
}

/** strip 垂直居中 + 高度封顶；轮数挤爆封顶时切 dense（更小的命中区、可滚）。 */
function layoutStrip() {
  if (!_strip || !_messagesEl) return;
  const H = _messagesEl.clientHeight;
  if (H <= 0) return;
  const maxH = Math.max(120, H - RAIL_INSET * 2);
  _strip.style.maxHeight = maxH + 'px';
  const dense = _strip.scrollHeight > maxH;
  if (dense !== _lastDense) {
    _lastDense = dense;
    _strip.classList.toggle('dense', dense);
  }
  const sh = Math.min(_strip.offsetHeight, maxH);
  const top = Math.round(Math.max(RAIL_INSET, Math.min((H - sh) / 2, H - sh - RAIL_INSET)));
  if (top === _lastTop) return;
  _lastTop = top;
  _strip.style.top = top + 'px';
}

/** 滚动跟随：阅读线（视口顶部下方 72px）以上最近的轮 = 当前轮。 */
function updateActive() {
  if (!_messagesEl || !_rail || !_rail.classList.contains('visible')) return;
  const ticks = [..._strip.querySelectorAll('.tick')];
  if (!ticks.length) return;
  const readingLine = _messagesEl.scrollTop + READING_LINE_OFFSET;
  let activeIdx = 0;
  ticks.forEach((tick, i) => {
    const top = tick._turn.anchorEl.offsetTop;
    if (top <= readingLine) activeIdx = i;
  });
  ticks.forEach((tick, i) => tick.classList.toggle('active', i === activeIdx));
}

function scrollToTurn(tick) {
  const turn = tick._turn;
  if (!turn?.anchorEl) return;
  turn.anchorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  turn.anchorEl.classList.add('outline-flash');
  if (_flashTimer) clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => turn.anchorEl?.classList.remove('outline-flash'), FLASH_MS);
}

/** 预览卡贴被 hover 的 tick 左侧（rail 坐标系），上下都夹在滚动视口内。 */
function showPreview(tick) {
  if (!_preview || !_messagesEl || !tick?._turn) return;
  _preview.textContent = turnPreview(tick._turn) || _t('outlineEmpty', '(empty)');
  _preview.classList.add('show');
  const H = _messagesEl.clientHeight;
  const stripTop = parseFloat(_strip.style.top) || 0;
  const top = stripTop + tick.offsetTop - _strip.scrollTop - 8;
  const ph = _preview.offsetHeight;
  _preview.style.top = Math.round(Math.max(4, Math.min(top, H - ph - 4))) + 'px';
}

function hidePreview() {
  if (_preview) _preview.classList.remove('show');
}

/**
 * 初始化。messagesEl 即滚动容器；rail 以零高度 sticky 子元素形式钉在视口顶部，
 * 不改任何既有布局。重复调用安全（幂等）。
 */
export function initOutlineRail({ messagesEl }) {
  if (!messagesEl) return;
  if (_messagesEl === messagesEl && _rail?.isConnected) return;
  _messagesEl = messagesEl;
  buildRail();
  messagesEl.insertBefore(_rail, messagesEl.firstChild);

  if (hasObserver) {
    _observer = new MutationObserver(() => {
      // renderHistory 清空重灌 / 追加新气泡 → 下一帧统一重建
      if (_rebuildQueued) return;
      _rebuildQueued = true;
      raf(() => { _rebuildQueued = false; rebuild(); });
    });
    _observer.observe(messagesEl, { childList: true });
  }

  messagesEl.addEventListener('scroll', () => {
    if (_spyQueued) return;
    _spyQueued = true;
    raf(() => { _spyQueued = false; updateActive(); });
  }, { passive: true });

  window.addEventListener('resize', () => { _lastTop = -1; layoutStrip(); updateActive(); });

  rebuild();
}

/** 测试钩子：重置模块单例（jsdom 每个用例新建 DOM 时用）。 */
export function _resetOutlineRail() {
  if (_observer) _observer.disconnect();
  if (_flashTimer) clearTimeout(_flashTimer);
  _messagesEl = null; _rail = null; _strip = null; _preview = null;
  _observer = null; _rebuildQueued = false; _spyQueued = false; _flashTimer = null;
  _lastTop = -1; _lastDense = false;
}
