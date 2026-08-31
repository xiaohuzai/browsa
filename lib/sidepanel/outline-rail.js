// lib/sidepanel/outline-rail.js — 对话大纲侧栏（cherry-studio MessageAnchorLine
// 的轻量移植，2026-08-31 用户点名）：按「轮」分组——一条用户消息 + 其后的全部
// 回复/系统卡 = 一个 tick；细条贴 #messages 右缘常驻（少于 4 轮隐藏），点击滚到
// 该轮开头并闪一下，滚动跟随高亮当前轮，hover 显示该轮用户消息预览。
//
// 结构：#messages 的第一个子元素是零高度 sticky 哨兵（.outline-rail），其内部
// strip 绝对定位钉在滚动视口右缘——不用给 #messages 加包裹层，renderHistory 清空
// innerHTML 后由 MutationObserver 自愈重建。cherry 的波浪放大/分页 fade 在面板
// 这个宽度收益不大，v1 不做。
//
// 自愈注意：本模块在真实 Chrome（sidepanel 页面）运行，不涉及 MAIN-world 注入，
// 可以正常引用 chrome.i18n 与 DOM 全局。

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

let _messagesEl = null;
let _rail = null;
let _strip = null;
let _preview = null;
let _observer = null;
let _rebuildQueued = false;
let _spyQueued = false;
let _flashTimer = null;

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
  _rail.setAttribute('aria-hidden', 'true');
  _strip = document.createElement('nav');
  _strip.className = 'outline-rail-strip';
  _strip.setAttribute('aria-label', _t('outlineAria', 'Conversation outline'));
  _preview = document.createElement('div');
  _preview.className = 'outline-rail-preview';
  _preview.style.display = 'none';
  _strip.appendChild(_preview);
  _rail.appendChild(_strip);
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
  // 全量重建 ticks（数量级 ≤ 几十，代价可忽略）；preview 常驻 strip 内便于定位
  while (_strip.firstChild && _strip.firstChild !== _preview) _strip.firstChild.remove();
  turns.forEach((turn, i) => {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tick' + (i === turns.length - 1 ? ' active' : '');
    tick.title = turnPreview(turn);
    tick.dataset.turn = String(i);
    tick._turn = turn;
    _strip.insertBefore(tick, _preview);
  });
  if (!visible) return;
  updateStripHeight();
  updateActive();
}

function updateStripHeight() {
  if (!_strip || !_messagesEl) return;
  const h = _messagesEl.clientHeight;
  if (h > 0) _strip.style.height = Math.max(120, h - 24) + 'px';
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

function showPreview(tick) {
  if (!_preview || !tick?._turn) return;
  _preview.textContent = turnPreview(tick._turn) || _t('outlineEmpty', '(empty)');
  _preview.style.display = 'block';
  // tick 在 strip 内的可见位置（strip 自身可滚动）→ 预览卡贴其左侧
  const top = tick.offsetTop - _strip.scrollTop;
  _preview.style.top = Math.max(0, top - 6) + 'px';
}

function hidePreview() {
  if (_preview) _preview.style.display = 'none';
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

  _strip.addEventListener('click', (e) => {
    const tick = e.target.closest('.tick');
    if (tick) scrollToTurn(tick);
  });
  _strip.addEventListener('mouseover', (e) => {
    const tick = e.target.closest('.tick');
    if (tick) showPreview(tick);
  });
  _strip.addEventListener('mouseleave', hidePreview);
  window.addEventListener('resize', () => { updateStripHeight(); updateActive(); });

  rebuild();
}

/** 测试钩子：重置模块单例（jsdom 每个用例新建 DOM 时用）。 */
export function _resetOutlineRail() {
  if (_observer) _observer.disconnect();
  if (_flashTimer) clearTimeout(_flashTimer);
  _messagesEl = null; _rail = null; _strip = null; _preview = null;
  _observer = null; _rebuildQueued = false; _spyQueued = false; _flashTimer = null;
}
