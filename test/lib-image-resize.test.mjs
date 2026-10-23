// test/lib-image-resize.test.mjs — 回复里的图片就地拖拽缩放
// （lib/sidepanel/image-resize.js，2026-10-23）。
//
// jsdom 没有布局（clientWidth 恒 0、getBoundingClientRect 全是 0），所以：
// 纯函数在这里直接测全；DOM 装配部分只断言「接线形状 + 拖拽后的数据落点」，
// 真实拖拽手感由 headless Chromium 的扩展真机探针验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main id="messages"></main></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const storageData = {};
globalThis.chrome = {
  storage: { local: {
    async get(keys) { return typeof keys === 'string' ? { [keys]: storageData[keys] } : { ...storageData }; },
    async set(obj) { Object.assign(storageData, obj); return undefined; },
  } },
};

const mod = await import('../lib/sidepanel/image-resize.js');
const {
  RESIZE_MIN_RATIO, RESIZE_MAX_RATIO, MIN_RESIZABLE_PX,
  clampResizeRatio, formatResizeRatio, ratioFromDrag, keyboardDelta,
  imageSizeKey, isResizableImage, applyRatioToImage,
  storeImageSize, storedImageSize, applyStoredImageSizes,
  loadImageSizes, resetImageSizesForTest, initImageResize,
} = mod;

const doc = dom.window.document;

// ─── 纯函数 ────────────────────────────────────────────────────────────────
test('clampResizeRatio：夹在 [15%, 100%]，非法输入按 1', () => {
  assert.equal(clampResizeRatio(0.5), 0.5);
  assert.equal(clampResizeRatio(0), RESIZE_MIN_RATIO);
  assert.equal(clampResizeRatio(-3), RESIZE_MIN_RATIO);
  assert.equal(clampResizeRatio(9), RESIZE_MAX_RATIO);
  assert.equal(clampResizeRatio(NaN), 1);
  assert.equal(clampResizeRatio('abc'), 1);
  // Number(null) === 0 → 落到下限（不是 1）；undefined 才是「没给值」
  assert.equal(clampResizeRatio(null), RESIZE_MIN_RATIO);
  assert.equal(clampResizeRatio(undefined), 1);
});

test('formatResizeRatio：定长、去尾零（存储与 DOM 都短）', () => {
  assert.equal(formatResizeRatio(0.5), '0.5');
  assert.equal(formatResizeRatio(1), '1');
  // 0.1234 低于 15% 下限，先夹再格式化
  assert.equal(formatResizeRatio(0.1234), '0.15');
  assert.equal(formatResizeRatio(0.6789), '0.679');
  assert.equal(formatResizeRatio(2), '1', '超上限先夹');
});

test('ratioFromDrag：以拖动前像素宽为基准，右拉变大、左拉变小', () => {
  // 容器 600、初始 300（=0.5），右拖 150 → 450/600 = 0.75
  assert.equal(ratioFromDrag({ startRatio: 0.5, startWidthPx: 300, dx: 150, containerWidth: 600 }), 0.75);
  // 左拖 150 → 150/600 = 0.25
  assert.equal(ratioFromDrag({ startRatio: 0.5, startWidthPx: 300, dx: -150, containerWidth: 600 }), 0.25);
  // 拖到超出容器上限即夹住
  assert.equal(ratioFromDrag({ startRatio: 0.5, startWidthPx: 300, dx: 9999, containerWidth: 600 }), 1);
  // 拖到极小也保留 15% 下限
  assert.equal(ratioFromDrag({ startRatio: 0.5, startWidthPx: 300, dx: -9999, containerWidth: 600 }), RESIZE_MIN_RATIO);
});

test('ratioFromDrag：容器宽为 0（jsdom / 未布局）时原样返回，不做假缩放', () => {
  assert.equal(ratioFromDrag({ startRatio: 0.4, startWidthPx: 200, dx: 100, containerWidth: 0 }), 0.4);
  assert.equal(ratioFromDrag({ startRatio: 0.4, startWidthPx: 0, dx: 100, containerWidth: 600 }), 0.4);
});

test('keyboardDelta：→/↑ 放大，←/↓ 缩小，其余键无动作', () => {
  assert.ok(keyboardDelta('ArrowRight') > 0);
  assert.ok(keyboardDelta('ArrowUp') > 0);
  assert.ok(keyboardDelta('ArrowLeft') < 0);
  assert.ok(keyboardDelta('ArrowDown') < 0);
  assert.equal(keyboardDelta('Enter'), 0);
  assert.equal(keyboardDelta('a'), 0);
});

test('isResizableImage：小图标不给手柄，正常图给', () => {
  assert.equal(isResizableImage({ naturalWidth: 32 }), false);
  assert.equal(isResizableImage({ naturalWidth: MIN_RESIZABLE_PX }), true);
  // 有布局时以显示宽度为准（naturalWidth 可能是 2000px 的高清图但显示成 40px）
  assert.equal(isResizableImage({ clientWidth: 40, naturalWidth: 2000 }), false);
  assert.equal(isResizableImage({ clientWidth: 300, naturalWidth: 2000 }), true);
  assert.equal(isResizableImage(null), false);
});

test('imageSizeKey：同 src → 同键，不同 src → 不同键，空 src → 空串', () => {
  const a = { getAttribute: () => 'https://x/a.png' };
  const a2 = { getAttribute: () => 'https://x/a.png' };
  const b = { getAttribute: () => 'https://x/b.png' };
  assert.equal(imageSizeKey(a), imageSizeKey(a2));
  assert.notEqual(imageSizeKey(a), imageSizeKey(b));
  assert.equal(imageSizeKey({ getAttribute: () => '' }), '');
  assert.equal(imageSizeKey(null), '');
});

// ─── 尺寸记录与重放 ────────────────────────────────────────────────────────
test('storeImageSize / applyStoredImageSizes：宽度按 src 指纹跨元素重放', () => {
  resetImageSizesForTest();
  const src = 'data:image/png;base64,AAA';
  const first = doc.createElement('img');
  first.setAttribute('src', src);
  doc.getElementById('messages').appendChild(first);
  storeImageSize(first, 0.5);

  // innerHTML 重建后的新元素（同 src，不同节点）必须拿回同一个宽度
  const rebuilt = doc.createElement('img');
  rebuilt.setAttribute('src', src);
  doc.getElementById('messages').appendChild(rebuilt);
  // 两个同 src 的元素都会命中（#messages 里既有 first 也有 rebuilt）
  assert.equal(applyStoredImageSizes(doc.getElementById('messages')), 2);
  assert.equal(rebuilt.style.width, '50%');
  assert.equal(rebuilt.style.maxWidth, 'none', '必须盖掉 .inline-fig 的 260px 上限');
  assert.equal(rebuilt.style.height, 'auto');

  first.remove(); rebuilt.remove();
});

test('applyStoredImageSizes：没记录过的图一字不动（旧行为零变化）', () => {
  resetImageSizesForTest();
  const img = doc.createElement('img');
  img.setAttribute('src', 'https://x/untouched.png');
  const box = doc.createElement('div');
  box.appendChild(img);
  assert.equal(applyStoredImageSizes(box), 0);
  assert.equal(img.style.width, '', '不能给没调过的图写内联宽度');
  assert.equal(img.style.maxWidth, '', '也不能动它的 max-width');
});

// ─── 缩略条排除（2026-10-23 0.45.1 审计修复）────────────────────────────────
// 引用图缩略条与正文 [图N] 是同一个 src：重放不排除 .imagepreview 的话，正文里
// 调过的比例（宽度百分比 + max-width:none）会顶穿 44/58px 的缩略格子；用户气泡
// 贴图条 / composer 待发条同理。手柄侧（pointerover）共用同一道门——lockstep
// 断言源码里两处都在（拆任一处这个用例就要跟着改）。
test('applyStoredImageSizes：.imagepreview 缩略条不被重放（与正文同 src 也不行）', () => {
  resetImageSizesForTest();
  const src = 'data:image/png;base64,BBB';
  // 正文图：调过、有记录
  const bodyFig = doc.createElement('img');
  bodyFig.setAttribute('src', src);
  doc.getElementById('messages').appendChild(bodyFig);
  storeImageSize(bodyFig, 0.4);
  // 追问卡引用缩略条：同一 src，.imagepreview 包装
  const strip = doc.createElement('div');
  strip.className = 'imagepreview';
  const quoted = doc.createElement('img');
  quoted.setAttribute('src', src);
  strip.appendChild(quoted);
  doc.getElementById('messages').appendChild(strip);

  assert.equal(applyStoredImageSizes(doc.getElementById('messages')), 1, '只重放正文那张');
  assert.equal(bodyFig.style.width, '40%');
  assert.equal(quoted.style.width, '', '缩略条不能被套上百分比宽度');
  assert.equal(quoted.style.maxWidth, '', '更不能被解锁 max-width');

  bodyFig.remove(); strip.remove();
});

test('缩略条排除是手柄与重放共用的门（源码 lockstep）', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/sidepanel/image-resize.js', import.meta.url)), 'utf8');
  assert.match(src, /function inResizeScope\(img\) \{\s*\n\s*return !img\.closest\?\.\('\.imagepreview'\);/,
    'inResizeScope 谓词必须在（缩略条不在这个面）');
  assert.match(src, /if \(!inResizeScope\(img\)\) \{ hideHandle\(\); return; \}/,
    'pointerover 悬停判定要过这道门');
  assert.match(src, /if \(!inResizeScope\(img\)\) continue;/,
    'applyStoredImageSizes 重放循环要过这道门');
});

test('storedImageSize：未记录返回 null，记录后取出夹住的值', () => {
  resetImageSizesForTest();
  const img = { getAttribute: () => 'https://x/c.png' };
  assert.equal(storedImageSize(img), null);
  storeImageSize(img, 0.05);
  assert.equal(storedImageSize(img), RESIZE_MIN_RATIO, '存进来就夹在下限');
});

test('loadImageSizes：从 local storage 恢复，且只读一次（幂等）', async () => {
  resetImageSizesForTest();
  const key = imageSizeKey({ getAttribute: () => 'https://x/saved.png' });
  storageData['browsa.imageSizes.v1'] = { [key]: 0.6 };
  await loadImageSizes();
  const img = { getAttribute: () => 'https://x/saved.png' };
  assert.equal(storedImageSize(img), 0.6);

  // 第二次调用不再覆盖内存（避免把运行期新存的值冲掉）
  storeImageSize(img, 0.9);
  await loadImageSizes();
  assert.equal(storedImageSize(img), 0.9);
  delete storageData['browsa.imageSizes.v1'];
  resetImageSizesForTest();
});

test('applyRatioToImage：写百分比宽度并解除两个尺寸上限', () => {
  const img = doc.createElement('img');
  applyRatioToImage(img, 0.8);
  // jsdom 会把 80.00% 规整成 80%
  assert.equal(img.style.width, '80%');
  assert.equal(img.style.maxWidth, 'none');
  assert.equal(img.style.maxHeight, 'none');
  assert.equal(img.style.height, 'auto');
});

// ─── DOM 装配 ──────────────────────────────────────────────────────────────
test('initImageResize：只服务回复里的图，小图不给手柄', async () => {
  resetImageSizesForTest();
  const root = doc.getElementById('messages');
  root.innerHTML = '';
  const inst = initImageResize({ root });
  assert.ok(inst, 'init 必须返回句柄');
  const handle = doc.querySelector('.img-resize-handle');
  assert.ok(handle, '单例手柄应挂到 body');

  // 小图（显示 32px）——不显示手柄
  const small = doc.createElement('img');
  small.setAttribute('src', 'https://x/small.png');
  Object.defineProperty(small, 'clientWidth', { value: 32 });
  const bubble = doc.createElement('div');
  bubble.className = 'msg assistant';
  bubble.appendChild(small);
  root.appendChild(bubble);
  small.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(handle.classList.contains('visible'), false, '图标级小图不给缩放手柄');

  // 正常尺寸图——显示手柄
  const big = doc.createElement('img');
  big.setAttribute('src', 'https://x/big.png');
  Object.defineProperty(big, 'clientWidth', { value: 320 });
  Object.defineProperty(big, 'getBoundingClientRect', {
    value: () => ({ left: 10, top: 10, right: 330, bottom: 190, width: 320, height: 180 }),
  });
  bubble.appendChild(big);
  big.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  assert.equal(handle.classList.contains('visible'), true);
  assert.equal(handle.tabIndex, 0, '可见时可聚焦（键盘可调）');
  assert.match(handle.title, /拖动缩放图片/);

  inst.hide?.();
  assert.equal(handle.classList.contains('visible'), false);
});

test('initImageResize：用户贴图（.msg.user 缩略条）不在缩放面里', async () => {
  resetImageSizesForTest();
  const root = doc.getElementById('messages');
  root.innerHTML = '';
  initImageResize({ root });
  const handle = doc.querySelector('.img-resize-handle');
  const img = doc.createElement('img');
  img.setAttribute('src', 'https://x/user-paste.png');
  Object.defineProperty(img, 'clientWidth', { value: 180 });
  const userBubble = doc.createElement('div');
  userBubble.className = 'msg user';
  userBubble.appendChild(img);
  root.appendChild(userBubble);
  img.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(handle.classList.contains('visible'), false,
    '用户自己的贴图缩略有固定尺寸，不参与正文图片缩放');
});

test('source pins：finishBubble 重放尺寸；侧栏 init 装配 resize 与 lightbox 共存', () => {
  const render = readFileSync(fileURLToPath(new URL('../lib/sidepanel/render.js', import.meta.url)), 'utf8');
  assert.match(render, /import \{ applyStoredImageSizes \} from '\.\/image-resize\.js';/);
  const finish = render.slice(render.indexOf('export function finishBubble'));
  const body = finish.slice(0, finish.indexOf('\n}') + 2);
  assert.match(body, /applyStoredImageSizes\(el\)/,
    'finishBubble 是四条完成路径的唯一收尾，尺寸重放必须挂在这里');

  const sidepanel = readFileSync(fileURLToPath(new URL('../sidepanel.js', import.meta.url)), 'utf8');
  assert.match(sidepanel, /import \{ initImageResize \} from '\.\/lib\/sidepanel\/image-resize\.js';/);
  assert.match(sidepanel, /initImageResize\(\{ root: messagesEl \}\)/, '必须在 init 里挂到消息区');
  // lightbox 点击委托必须仍在（拖拽不能吃掉普通点击放大）
  assert.match(sidepanel, /showImageLightbox\(img\.src, img\.alt\)/);
});

test('CSS lockstep：手柄可见性靠 .visible，热区外扩且不参与布局', () => {
  const css = readFileSync(fileURLToPath(new URL('../sidepanel.css', import.meta.url)), 'utf8');
  const i = css.indexOf('.img-resize-handle {');
  assert.ok(i > 0, '手柄样式必须存在');
  const block = css.slice(i, css.indexOf('\n}', i));
  assert.match(block, /position: fixed/, '手柄跟图片坐标走，必须是 fixed');
  assert.match(block, /pointer-events: none/, '静止时不挡点击（否则点图放大会被吃掉）');
  assert.match(css, /\.img-resize-handle\.visible \{[^}]*pointer-events: auto/,
    '可见时才接收指针');
  assert.match(css, /\.img-resize-handle::after \{[^}]*inset: -9px/,
    '热区靠伪元素外扩，不放大视觉尺寸');
});
test('applyStoredImageSizes：活动图被 innerHTML 换掉后，手柄不留旧坐标', async () => {
  resetImageSizesForTest();
  const root = doc.getElementById('messages');
  root.innerHTML = '';
  const inst = initImageResize({ root });
  const handle = doc.querySelector('.img-resize-handle');

  const bubble = doc.createElement('div');
  bubble.className = 'msg assistant';
  const img = doc.createElement('img');
  img.setAttribute('src', 'https://x/stale.png');
  Object.defineProperty(img, 'clientWidth', { value: 300 });
  Object.defineProperty(img, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }),
  });
  bubble.appendChild(img);
  root.appendChild(bubble);
  img.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  assert.equal(handle.classList.contains('visible'), true, '前置：手柄已显示');

  // 模拟 renderSafe 重建气泡：整块 DOM 换新，旧 <img> 脱离文档
  bubble.innerHTML = `<img src="https://x/stale.png">`;
  assert.equal(img.isConnected, false);
  applyStoredImageSizes(bubble);

  assert.equal(handle.classList.contains('visible'), false,
    '旧图脱离文档后手柄必须收起，不能孤零零留在旧坐标（真机复现）');
  inst.hide?.();
});
