// test/lib-sidepanel-screenshot-undo.test.mjs — real execution test for the
// screenshot-attach "撤销" (undo) flow. Kept in its own file (same convention
// as test/lib-sidepanel-ui-prefs.test.mjs) to avoid GET_CONFIG/sendMessage
// mock collisions with other sidepanel test files' shared module state.
//
// Regression: clicking "撤销" on a screenshot attachment used to only fade
// the "📎 已附加截图..." label text -- the screenshot image itself stayed
// visible in the chat. appendAttachSystem() now accepts the screenshot
// preview element and removes it too when the undo actually succeeds.
//
// jsdom does not decode image data (no `canvas` package installed, and this
// project deliberately has no such native-dependency build step), so
// showScreenshotCropUI()'s real <img>.onload never fires -- its "使用完整
// 截图"/"取消" button listeners are bound INSIDE that onload callback. We
// stub window.Image to fire onload synchronously via a microtask so the
// crop UI wires up exactly as it would after a real image decode, without
// needing real canvas support.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/sidepanel.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.location = dom.window.location;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Stub Image so showScreenshotCropUI's onload-gated listener wiring runs
// without real image decoding.
class FakeImage extends dom.window.EventTarget {
  set src(v) {
    this._src = v;
    this.naturalWidth = 400;
    this.naturalHeight = 300;
    queueMicrotask(() => this.onload && this.onload());
  }
  get src() { return this._src; }
}
dom.window.Image = FakeImage;
globalThis.Image = FakeImage;

// jsdom's canvas has no real 2D context (getContext('2d') returns null
// without the native `canvas` package, which this project deliberately
// doesn't depend on) -- stub just enough of the drawing API as no-ops so
// showScreenshotCropUI's redraw()/crop logic runs without crashing.
const fake2dContext = {
  drawImage() {}, fillRect() {}, clearRect() {}, strokeRect() {},
  set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {},
};
dom.window.HTMLCanvasElement.prototype.getContext = () => fake2dContext;

const sentMessages = [];
let undoShouldSucceed = true;

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/', title: 'Example' }],
    get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  runtime: {
    connect: () => ({
      name: '', sent: [],
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: (msg, cb) => {
      sentMessages.push(msg);
      let res = { ok: true };
      if (msg.type === 'GET_CONFIG') res = { data: {} };
      if (msg.type === 'STREAM_PEEK') res = { inFlight: false };
      if (msg.type === 'ATTACH_PAGE' && msg.mode === 'screenshot') {
        res = { ok: true, data: { ok: true, ctx: { imageDataUrl: 'data:image/png;base64,fake', meta: { url: 'https://example.com/', title: 'Example Page' } } } };
      }
      if (msg.type === 'ATTACH_SCREENSHOT_CONFIRM') res = { ok: true };
      if (msg.type === 'UNDO_ATTACH') res = undoShouldSucceed ? { ok: true, removedIdx: 0 } : { ok: false };
      cb(res);
    },
    lastError: undefined,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const attachBtn = document.getElementById('attach');
const screenshotRadio = document.querySelector('input[name="ctx"][value="screenshot"]');
const messagesEl = document.getElementById('messages');

async function attachScreenshotAndConfirmFull() {
  screenshotRadio.checked = true;
  screenshotRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  attachBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  const modal = document.querySelector('.crop-modal');
  assert.ok(modal, 'crop modal must appear after a screenshot ATTACH_PAGE response');
  const fullBtn = modal.querySelector('.crop-use-full');
  fullBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
}

test('confirming a screenshot attachment shows both the attach-system message and the screenshot preview', async () => {
  await attachScreenshotAndConfirmFull();
  assert.ok(messagesEl.querySelector('.attach-msg'), 'attach system message must appear');
  assert.ok(messagesEl.querySelector('.screenshot-preview'), 'screenshot preview bubble must appear');
});

test('clicking 撤销 on a screenshot attachment removes the screenshot preview from the chat, not just fades the label', async () => {
  undoShouldSucceed = true;
  const undoBtn = messagesEl.querySelector('.attach-msg .undo-attach');
  assert.ok(undoBtn, 'undo button must exist on the attach-system message');

  undoBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(messagesEl.querySelector('.screenshot-preview'), null,
    'the screenshot image must be removed from the chat once the undo succeeds');
  assert.match(messagesEl.querySelector('.attach-msg span').textContent, /已撤销/);
});

test('a failed UNDO_ATTACH leaves both the label and the screenshot preview intact', async () => {
  await attachScreenshotAndConfirmFull();
  undoShouldSucceed = false;
  const previews = messagesEl.querySelectorAll('.screenshot-preview');
  const preview = previews[previews.length - 1];
  const undoBtns = messagesEl.querySelectorAll('.attach-msg .undo-attach');
  const undoBtn = undoBtns[undoBtns.length - 1];

  undoBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(preview.isConnected, 'a failed undo must not remove the screenshot preview');
  assert.equal(undoBtn.disabled, false, 'the undo button must be re-enabled after a failed attempt');
});
