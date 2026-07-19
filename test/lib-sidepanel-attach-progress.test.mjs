// test/lib-sidepanel-attach-progress.test.mjs — real execution test for the
// "attaching page" visible progress indicator (spinning button icon +
// .tool-progress pill above the composer). Ported after a user reported that
// slow attaches (large pages, PDFs) gave almost no visible feedback -- only
// a disabled/dimmed button and a hover-only tooltip.
//
// Same jsdom-load-the-real-sidepanel.js harness pattern as
// test/lib-sidepanel-screenshot-undo.test.mjs, kept in its own file to avoid
// GET_CONFIG/sendMessage mock collisions with other sidepanel test files'
// shared module state.

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

// Controllable ATTACH_PAGE response: the test holds the resolve function so
// it can inspect the "in-flight" DOM state before letting the mock respond,
// exactly the moment a real slow extraction would leave the UI in.
let pendingAttachResolve = null;
let nextAttachResult = { ok: true, data: { ok: true, ctx: { articleTitle: 'Test Page', text: 'hello world', truncated: { textLength: 11 } } } };

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
      if (msg.type === 'GET_CONFIG') { cb({ data: {} }); return; }
      if (msg.type === 'STREAM_PEEK') { cb({ inFlight: false }); return; }
      if (msg.type === 'ATTACH_PAGE') {
        // Held open until the test explicitly resolves it, simulating a slow extraction.
        pendingAttachResolve = () => cb(nextAttachResult);
        return;
      }
      if (msg.type === 'ATTACH_PDF_CONFIRM') { cb({ ok: false }); return; } // don't need history storage for this test
      cb({ ok: true });
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

test('clicking attach shows a spinning icon on the button and a visible "正在读取页面…" progress pill', async () => {
  const origIconHtml = attachBtn.innerHTML;
  attachBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(attachBtn.classList.contains('is-attaching'), 'button must get the is-attaching class while in flight');
  assert.equal(attachBtn.disabled, true, 'button must be disabled while in flight');
  assert.notEqual(attachBtn.innerHTML, origIconHtml, 'button icon must be swapped while in flight');

  const progressEl = document.getElementById('attach-progress');
  assert.ok(progressEl, 'a visible progress pill must appear');
  assert.match(progressEl.textContent, /正在读取页面/, 'progress pill must show a real status message, not just a tooltip');
  assert.equal(progressEl.className, 'tool-progress', 'progress pill must reuse the existing .tool-progress styling');

  // Let the (held-open) ATTACH_PAGE response resolve
  pendingAttachResolve();
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(!attachBtn.classList.contains('is-attaching'), 'is-attaching class must be removed once the attach completes');
  assert.equal(attachBtn.disabled, false, 'button must be re-enabled once the attach completes');
  assert.equal(attachBtn.innerHTML, origIconHtml, 'button icon must be restored to the original paperclip once done');
  assert.equal(document.getElementById('attach-progress'), null, 'progress pill must be removed once the attach completes');
});

test('a failed ATTACH_PAGE response still cleans up the icon/class/progress pill (finally block runs on the error path too)', async () => {
  nextAttachResult = { ok: true, data: { ok: false, error: 'boom' } };
  const origIconHtml = attachBtn.innerHTML;

  attachBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(attachBtn.classList.contains('is-attaching'));
  assert.ok(document.getElementById('attach-progress'));

  pendingAttachResolve();
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(!attachBtn.classList.contains('is-attaching'), 'is-attaching class must be removed even after a failed attach');
  assert.equal(attachBtn.disabled, false);
  assert.equal(attachBtn.innerHTML, origIconHtml, 'icon must be restored even after a failed attach');
  assert.equal(document.getElementById('attach-progress'), null, 'progress pill must be removed even after a failed attach');

  // restore for any subsequent tests
  nextAttachResult = { ok: true, data: { ok: true, ctx: { articleTitle: 'Test Page', text: 'hello world', truncated: { textLength: 11 } } } };
});

test('the PDF-pending branch updates the progress pill text to "解析 PDF 中…" before attempting extraction', async () => {
  nextAttachResult = {
    ok: true,
    data: { ok: true, ctx: { mode: 'pdf-pending', pdfBase64: 'ZmFrZS1wZGYtYnl0ZXM=', meta: { url: 'https://example.com/doc.pdf', title: 'A PDF' } } }
  };

  attachBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  pendingAttachResolve();
  // Check via a microtask flush only (not a macrotask/setTimeout) -- the
  // pdf-pending branch's progress-text update is synchronous code running
  // right up to its own `await Promise.race(...)`, so one microtask tick
  // after the ATTACH_PAGE response resolves is the precise moment to catch
  // it. extractPdfContent fails fast in jsdom (no real Worker/DOMMatrix) and
  // falls through to the placeholder text within a macrotask tick or two, so
  // a setTimeout-based wait here would already miss this transient state.
  await Promise.resolve();
  await Promise.resolve();

  const progressEl = document.getElementById('attach-progress');
  assert.ok(progressEl, 'progress pill must still be present while PDF extraction is attempted');
  assert.match(progressEl.textContent, /解析 PDF 中/, 'progress pill text must switch to the PDF-specific stage message');

  // Let the (fast-failing) PDF extraction finish and confirm cleanup still happens.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('attach-progress'), null, 'progress pill must be cleared once the PDF flow (success or fallback) finishes');

  // restore for any subsequent tests
  nextAttachResult = { ok: true, data: { ok: true, ctx: { articleTitle: 'Test Page', text: 'hello world', truncated: { textLength: 11 } } } };
});
