// test/lib-sidepanel-image-gate.test.mjs — execution test for the composer's
// attach-time image gate (sidepanel.js's handleDroppedFiles + appendError).
//
// Why this exists: the per-turn image limits are applied by handleChat at SEND
// time, where a dropped image is invisible (the composer clears the thumbnail
// strip the moment a turn starts). Users read that as "pasting an image does
// nothing". The gate now refuses at ATTACH time with a visible notice, so this
// test drives a real paste through the real sidepanel.js in jsdom and asserts
// both halves: the image is not added, and the user can see why.
//
// jsdom has no DataTransfer/ClipboardEvent, and onPaste only reads
// `e.clipboardData.items[].type/getAsFile()`, so a plain Event carrying that
// shape is enough — no browser-only constructor needed. Same black-box
// approach as test/lib-sidepanel-status-dot.test.mjs (sidepanel.js has zero
// exports), its own file/JSDOM instance so module state isn't shared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { makeSidepanelChromeMock, wireSendMessage } from './helpers/chrome-mock.mjs';

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
// sidepanel.js's fileToDataUrl() calls the bare `FileReader` — jsdom has it on
// the window, so it must be globalized like the other DOM classes above.
globalThis.FileReader = dom.window.FileReader;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

globalThis.chrome = makeSidepanelChromeMock({
  sendMessage: wireSendMessage(async (msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    return { ok: true };
  }),
});

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const inputEl = document.getElementById('input');
const messagesEl = document.getElementById('messages');

// FileReader is a real async hop (plus the await in handleDroppedFiles), so a
// couple of macrotask turns is what it takes to observe the result.
const settle = () => new Promise((r) => setTimeout(r, 40));

function pasteFiles(files) {
  const ev = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { items: files.map((f) => ({ type: f.type, getAsFile: () => f })) };
  inputEl.dispatchEvent(ev);
  return ev;
}

const makeFile = (bytes, name = 'img.png') =>
  new dom.window.File([new Uint8Array(bytes)], name, { type: 'image/png' });

const notices = () => [...messagesEl.querySelectorAll('.msg.error')];
const previews = () => document.querySelectorAll('.imagepreview');

test('an image that fits is attached and shows a thumbnail', async () => {
  pasteFiles([makeFile(64 * 1024, 'diagram.png')]);
  await settle();
  assert.equal(previews().length, 1, 'a fitting image must be attached');
  assert.equal(notices().length, 0, 'and must not produce a notice');
});

test('an over-budget image is refused at attach time, with a visible one-line notice', async () => {
  // 3 MB of bytes → ~4 MB as a data URL, past the 3 MB-of-chars per-message
  // budget (≈2.25 MB of image bytes).
  pasteFiles([makeFile(3 * 1024 * 1024, 'screenshot-4k.png')]);
  await settle();

  assert.equal(previews().length, 1, 'the over-budget image must NOT be attached (the first one stays)');
  const [notice] = notices();
  assert.ok(notice, 'the refusal must be visible in the conversation');
  assert.equal(notice.classList.contains('has-detail'), false,
    'a local refusal stays a one-line ⚠ notice — not the provider-failure card ("Something went wrong" + Raw error + Copy)');
  assert.match(notice.textContent, /screenshot-4k\.png/, 'the notice must name the file');
  assert.match(notice.textContent, /2\.2 MB/, 'and state the real per-message limit (floored, never overstated)');
  assert.equal(document.getElementById('status-dot')?.dataset.state, 'error', 'the status dot still flags a refused attachment');
});

test('the per-message image count cap is enforced the same way', async () => {
  // 1 preview is already attached; fill up to the cap, then one more.
  for (let i = 0; i < 7; i++) pasteFiles([makeFile(1024, `pad-${i}.png`)]);
  await settle();
  assert.equal(previews().length, 8, 'eight small images fit');

  const before = notices().length;
  pasteFiles([makeFile(1024, 'ninth.png')]);
  await settle();
  assert.equal(previews().length, 8, 'the ninth image must NOT be attached');
  const all = notices();
  assert.equal(all.length, before + 1, 'the refusal must be visible');
  assert.match(all[all.length - 1].textContent, /ninth\.png/);
  assert.equal(all[all.length - 1].classList.contains('has-detail'), false, 'count refusals are one-liners too');
});
