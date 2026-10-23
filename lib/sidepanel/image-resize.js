// lib/sidepanel/image-resize.js — 回复里的图片就地拖拽缩放（2026-10-23）。
//
// 现状：点击回复里的图片会打开 lightbox（滚轮缩放 / 放大后拖动平移 / 双击切换，
// 见 lightbox-zoom.js），但那是**查看器内部**的变换，退出即还原；回复正文里的
// 图片本身尺寸是固定的（.inline-fig 写死 max-width 260px，模型写的 <img> 跟气泡
// 同宽）。用户要的是「在回复里直接把图拖大/拖小」。
//
// 交互：悬停到一张可缩放的图上，右下角浮出一个小手柄；拖它改图片宽度。
// 松手即定格，值随图片留着。
//
// 三条不许回退的约束：
// - **点击仍归 lightbox**：拖拽在 pointerdown 之后位移超过 deadzone 才算 resize，
//   且松手后吞掉尾随的那次 click（否则一拖完就弹出查看器）。
// - **尺寸是数据不是 DOM 状态**：流式渲染、DONE 重渲、retry、历史重载都会
//   innerHTML 重建气泡，<img> 是新元素。所以宽度按**图片 src 的指纹**存进
//   size map（chrome.storage.local，fail-open；local 而非 session：重开浏览器
//   后「我把这张图调大过」仍应成立），新 DOM 上由
//   `applyStoredImageSizes(root)` 重放。用百分比而非像素：侧栏宽度可变，
//   像素值在窄栏会溢出、宽栏又偏小。
// - **只给值得缩放的图**：图标/头像级小图不给手柄（拖大只会把排版弄乱），
//   它们点开看更合适。
//
// 纯函数（clamp / 位移换算 / 指纹）全部导出以便单测——jsdom 没有布局，
// clientWidth 恒 0，DOM 装配只做「把纯函数接起来」这一件事。

import { t as _t } from '../i18n.js';

export const RESIZE_MIN_RATIO = 0.15;  // 最窄到气泡内容宽度的 15%
export const RESIZE_MAX_RATIO = 1;     // 最宽到气泡内容宽度（不横向溢出）
export const MIN_RESIZABLE_PX = 64;    // 显示宽度小于此值的图不给手柄
export const RESIZE_DEADZONE_PX = 3;   // 起手抖动容差
export const HANDLE_HIDE_DELAY_MS = 260; // 指针离开图/手柄后延迟收起（留给移动过程）
export const KEYBOARD_STEP_PX = 24;    // ←/→ 每次调整的像素
export const SIZES_MAX_ENTRIES = 240;  // size map 上限（session 配额友好）
const RATIO_DECIMALS = 3;

/** 比例 → 夹在 [RESIZE_MIN_RATIO, RESIZE_MAX_RATIO] 内；非法输入按 1 处理。 */
export function clampResizeRatio(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return 1;
  return Math.min(RESIZE_MAX_RATIO, Math.max(RESIZE_MIN_RATIO, n));
}

/** 比例 → 定长字符串（避免长小数进 DOM/存储）。 */
export function formatResizeRatio(ratio) {
  return clampResizeRatio(ratio).toFixed(RATIO_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * 拖拽位移 → 目标比例。以拖动前的像素宽度为基准，向右拉大、向左拉小；
 * `containerWidth` 是百分比的分母（图片父块的内容宽度）。容器宽为 0（jsdom）
 * 时原样返回，不做假缩放。
 */
export function ratioFromDrag({ startRatio, startWidthPx, dx, containerWidth }) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return clampResizeRatio(startRatio);
  if (!Number.isFinite(startWidthPx) || startWidthPx <= 0) return clampResizeRatio(startRatio);
  return clampResizeRatio((startWidthPx + (Number(dx) || 0)) / containerWidth);
}

/** 键盘 ←/→（或 ↑/↓）方向 → 位移量。纯函数，便于和拖拽共用一条换算。 */
export function keyboardDelta(key, stepPx = KEYBOARD_STEP_PX) {
  if (key === 'ArrowRight' || key === 'ArrowUp') return stepPx;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return -stepPx;
  return 0;
}

/**
 * 图片的内容指纹（src 的 FNV-1a + 长度）。尺寸按指纹存，不按元素存——
 * innerHTML 重建后元素换了，指纹不变，宽度才跟得住。data: URL 可能很长，
 * 只留哈希不存原文。
 */
export function imageSizeKey(img) {
  const src = img?.currentSrc || img?.getAttribute?.('src') || img?.src || '';
  if (!src) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + src.length;
}

/**
 * 这张图值不值得给缩放手柄。只看**当前显示宽度**：图标/头像拖大了只会毁排版，
 * 而用户更可能想点开看。jsdom 里 clientWidth 恒 0，退回 naturalWidth
 * （测试直接用带这两个字段的普通对象验证谓词）。
 */
export function isResizableImage(img, minPx = MIN_RESIZABLE_PX) {
  const shown = Number(img?.clientWidth) || Number(img?.naturalWidth) || 0;
  return shown >= minPx;
}

/**
 * 缩略条（.imagepreview：composer 待发图 / 用户气泡贴图 / 追问卡引用图）不在
 * 这个面——它们是固定尺寸 + object-fit 裁切的快照，不是正文图。引用图与正文
 * [图N] 是同一个 src：重放不排除的话，正文里调过的比例会被套到缩略图上（宽度
 * 百分比 + max-width:none 直接顶穿 44/58px 的格子）；反过来在缩略图上拿到手柄
 * 拖一下，又会经同一指纹污染正文那张图。手柄与重放共用这一道门。
 */
function inResizeScope(img) {
  return !img.closest?.('.imagepreview');
}

// ─── size map（内存 + chrome.storage.local 持久化，fail-open）────────────────
// 用 local 而非 session：拖动后的图片尺寸是「我把这张图调大看了一眼」的显示
// 偏好，浏览器重启后重开会话仍应保持。键是 src 的指纹（不是 data URL 原文），
// 值是一个小数，240 条上限——体积可忽略，且与图片像素无关。
const STORE_KEY = 'browsa.imageSizes.v1';
/** @type {Map<string, number>} imageSizeKey → ratio */
const sizeMap = new Map();
let persistTimer = null;
let readyPromise = null;

function storageArea() {
  try {
    if (typeof chrome === 'undefined') return null;
    return chrome?.storage?.local || null;
  } catch (_) {
    return null;
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const area = storageArea();
    if (!area) return;
    try {
      // 超上限时丢最早写入的（Map 插入序即写入序）。
      while (sizeMap.size > SIZES_MAX_ENTRIES) {
        sizeMap.delete(sizeMap.keys().next().value);
      }
      area.set({ [STORE_KEY]: Object.fromEntries(sizeMap) })?.catch?.(() => {});
    } catch (_) { /* 持久化失败不影响本次显示 */ }
  }, 400);
}

/** 读取持久化的尺寸表（只读一次，之后走内存）。Never rejects。 */
export function loadImageSizes() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const area = storageArea();
    if (!area) return sizeMap;
    try {
      const got = await area.get(STORE_KEY);
      const saved = got?.[STORE_KEY];
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved)) {
          const r = Number(v);
          if (Number.isFinite(r)) sizeMap.set(k, clampResizeRatio(r));
        }
      }
    } catch (_) { /* fail-open */ }
    return sizeMap;
  })();
  return readyPromise;
}

/** 首屏渲染前等待尺寸表就绪（布局前重放才有意义）。 */
export function imageSizesReady() {
  return loadImageSizes();
}

/** 记录一张图的尺寸（内存立即生效，落盘防抖）。 */
export function storeImageSize(img, ratio) {
  const key = imageSizeKey(img);
  if (!key) return;
  sizeMap.set(key, clampResizeRatio(ratio));
  schedulePersist();
}

/** 取一张图已保存的尺寸；没有则 null。 */
export function storedImageSize(img) {
  const key = imageSizeKey(img);
  if (!key) return null;
  const r = sizeMap.get(key);
  return r == null ? null : clampResizeRatio(r);
}

/** 把尺寸直接写到图片的内联样式上（纯展示，不碰记录）。 */
export function applyRatioToImage(img, ratio) {
  if (!img?.style) return;
  img.style.width = `${(clampResizeRatio(ratio) * 100).toFixed(2)}%`;
  // .inline-fig 的 260px 上限会把「拉大」吃掉；高度交给 auto 保比例。
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.height = 'auto';
}

/**
 * 在新 DOM 上重放已保存的尺寸。所有 innerHTML 重建气泡的路径都要调
 * （finishBubble / decorateFigureRefs / 首屏渲染）；幂等。
 *
 * innerHTML 重建会把「手柄正对着的那张图」一起换掉——手柄是 fixed 单例，
 * 不收拾就会孤零零留在旧坐标上（真机复现）。所以重放时若活动图已脱离文档，
 * 顺手把手柄收起。
 */
export function applyStoredImageSizes(root) {
  if (!root?.querySelectorAll) return 0;
  let applied = 0;
  for (const img of root.querySelectorAll('img')) {
    if (!inResizeScope(img)) continue; // 缩略条不在这个面（见 inResizeScope）
    const ratio = storedImageSize(img);
    if (ratio == null) continue;
    applyRatioToImage(img, ratio);
    applied++;
  }
  if (activeImg) {
    // 重放意味着 DOM 被重建过：手柄是 fixed 单例，位置参照已经变了，留在原地
    // 就是一个无主圆点（真机复现）。一律收起，用户再悬停会重新出现——
    // 简单且绝不会留孤儿；重放只发生在 DONE/重渲这类收尾时刻。
    hideHandle({ immediate: true });
  }
  return applied;
}

/** 测试/换会话用：清空内存表（不写盘）。 */
export function resetImageSizesForTest() {
  sizeMap.clear();
  readyPromise = null;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
}

// ─── DOM 装配：一个共享的悬浮手柄 ────────────────────────────────────────────
let handleEl = null;
let activeImg = null;
let hideTimer = null;
let drag = null;      // { img, startX, startRatio, containerWidth, moved }
let suppressClickUntil = 0;

function handleLabel() {
  return _t('imageResizeHint', '拖动缩放图片');
}

function placeHandle(img) {
  if (!handleEl || !img?.isConnected) return;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 手柄中心压在图片右下角，热区一半在外、一半在图内（不盖住画面主体）。
  handleEl.style.left = `${Math.round(rect.right - 8)}px`;
  handleEl.style.top = `${Math.round(rect.bottom - 8)}px`;
}

function showHandle(img) {
  if (!img || !img.isConnected) return;
  activeImg = img;
  if (!handleEl) return;
  handleEl.classList.add('visible');
  handleEl.tabIndex = 0; // 只在可见时可聚焦，静止时不占据 Tab 顺序
  handleEl.title = handleLabel();
  handleEl.setAttribute('aria-label', handleLabel());
  placeHandle(img);
}

function hideHandle({ immediate = false } = {}) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const run = () => {
    if (!handleEl) return;
    if (drag) return; // 拖拽中不收起
    handleEl.classList.remove('visible');
    handleEl.tabIndex = -1;
    activeImg = null;
  };
  if (immediate) run();
  else hideTimer = setTimeout(run, HANDLE_HIDE_DELAY_MS);
}

function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function ensureHandle() {
  if (handleEl || typeof document === 'undefined') return handleEl;
  handleEl = document.createElement('div');
  handleEl.className = 'img-resize-handle';
  handleEl.tabIndex = -1;
  handleEl.setAttribute('role', 'separator');
  handleEl.setAttribute('aria-orientation', 'horizontal');
  document.body.appendChild(handleEl);

  handleEl.addEventListener('pointerenter', cancelHide);
  handleEl.addEventListener('pointerleave', () => hideHandle());

  handleEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !activeImg) return;
    e.preventDefault();
    e.stopPropagation(); // 别让按下落到图片上（选中/拖图）
    const container = activeImg.parentElement;
    const containerWidth = container?.clientWidth || 0;
    const startWidthPx = activeImg.getBoundingClientRect().width || containerWidth;
    drag = {
      img: activeImg,
      startX: e.clientX,
      startRatio: storedImageSize(activeImg) ?? (containerWidth ? startWidthPx / containerWidth : 1),
      startWidthPx,
      containerWidth,
      moved: false,
    };
    try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}
  });

  handleEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < RESIZE_DEADZONE_PX) return;
    drag.moved = true;
    const next = ratioFromDrag({
      startRatio: drag.startRatio,
      startWidthPx: drag.startWidthPx,
      dx,
      containerWidth: drag.containerWidth,
    });
    applyRatioToImage(drag.img, next);
    placeHandle(drag.img); // 手柄跟着新角落走
    handleEl.dataset.ratio = formatResizeRatio(next);
  });

  const endDrag = (commit) => {
    if (!drag) return;
    const { img, moved, startRatio } = drag;
    const finalRatio = moved ? Number(handleEl?.dataset?.ratio) : startRatio;
    drag = null;
    // 拖过一次就吞掉尾随 click，否则松手会立刻弹出 lightbox。
    if (moved) {
      suppressClickUntil = Date.now() + 400;
      storeImageSize(img, Number.isFinite(finalRatio) ? finalRatio : 1);
    }
    hideHandle({ immediate: true });
    void commit;
  };
  handleEl.addEventListener('pointerup', () => endDrag(true));
  handleEl.addEventListener('pointercancel', () => endDrag(false));
  handleEl.addEventListener('lostpointercapture', () => { if (drag) endDrag(true); });

  handleEl.addEventListener('keydown', (e) => {
    if (!activeImg) return;
    const delta = keyboardDelta(e.key);
    if (!delta) return;
    e.preventDefault();
    const container = activeImg.parentElement;
    const containerWidth = container?.clientWidth || 0;
    const currentPx = activeImg.getBoundingClientRect().width || 0;
    const next = ratioFromDrag({
      startRatio: storedImageSize(activeImg) ?? 1,
      startWidthPx: currentPx,
      dx: delta,
      containerWidth,
    });
    applyRatioToImage(activeImg, next);
    storeImageSize(activeImg, next);
    placeHandle(activeImg);
    hideHandle();
  });

  return handleEl;
}

/**
 * 在消息区装配拖拽缩放：悬停显示手柄、拖拽改宽度、拖拽后吞掉尾随 click。
 * 只在回复（.msg.assistant）里的图片上生效——用户贴图缩略条有自己的固定尺寸，
 * 不在这个面里。
 *
 * `root` 只是事件委托的宿主（#messages）：图片本身不挂监听，
 * 所以流式/重渲新生成的图自动可用。
 */
export function initImageResize({ root } = {}) {
  if (!root || typeof document === 'undefined') return null;
  ensureHandle();
  void loadImageSizes().then(() => applyStoredImageSizes(root));

  root.addEventListener('pointerover', (e) => {
    const img = e.target?.closest?.('img');
    if (!img || !root.contains(img)) return;
    if (!img.closest('.msg.assistant')) return; // 只服务回复里的图
    if (!inResizeScope(img)) { hideHandle(); return; } // 缩略条不在这个面
    if (!isResizableImage(img)) { hideHandle(); return; }
    cancelHide();
    showHandle(img);
  });
  root.addEventListener('pointerout', (e) => {
    const img = e.target?.closest?.('img');
    if (!img || img !== activeImg) return;
    // 指针移到手柄上时不清（手柄自己会维护）。
    if (e.relatedTarget === handleEl) return;
    hideHandle();
  });
  // 滚动/换内容都会让固定定位的手柄脱离原位，直接收起。
  root.addEventListener('scroll', () => hideHandle({ immediate: true }), { passive: true });
  // 点开灯箱、切会话、面板失焦等任何「用户已经不在看这张图」的情形，都不能
  // 让固定定位的手柄留在原位（真机复现：打开 lightbox 后旧图不再收到
  // pointerout，圆点孤零零挂在页面上）。这三条是兜底门，不依赖指针路径。
  root.addEventListener('click', () => hideHandle({ immediate: true }), true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hideHandle({ immediate: true });
  });
  window.addEventListener('blur', () => hideHandle({ immediate: true }));

  // 拖拽结束后的尾随 click：在捕获阶段拦一次，避免弹出 lightbox。
  // （正常情况下松手落在手柄上，click 的 target 不是 img，本就不会开查看器；
  //   这道守卫兜住手柄恰好被收起/指针捕获异常的情形。）
  document.addEventListener('click', (e) => {
    if (Date.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  return { hide: () => hideHandle({ immediate: true }) };
}