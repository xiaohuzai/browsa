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

import { test, after, afterEach } from 'node:test';
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
const confirmations = [];

// Keep the real extractors and mock only the browser Worker boundary. A held
// reply lets the timeout test exercise the fallback without waiting minutes.
let holdWorkerReplies = false;
const heldWorkerReplies = [];
globalThis.Worker = class {
  constructor(url) { this.url = url; this.listeners = {}; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  postMessage(msg) {
    if (msg.type === 'warmup') return;
    const reply = () => this.listeners.message({ data: this.url.includes('office-inspector')
      ? { requestId: msg.requestId, ok: true, markdown: 'Converted office document' }
      : { requestId: msg.requestId, ok: true, result: {
          markdown: 'Extracted PDF document', pageCount: 1, pdfType: 'Text',
          confidence: 1, pagesNeedingOcr: [], title: '', layout: {}, hasEncodingIssues: false,
        } } });
    if (holdWorkerReplies) heldWorkerReplies.push(reply);
    else setTimeout(reply, 15);
  }
};

// Observe native timer lifetime, rather than unref'ing or shortening the
// production deadline. Cleanup after each test keeps a red run bounded.
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const extractionTimers = [];
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = nativeSetTimeout(callback, ms, ...args);
  if (ms >= 90_000 && /at file:.*\/attach-orchestrator\.js:\d/.test(new Error().stack)) {
    extractionTimers.push({ timer, ms, callback, cleared: false });
  }
  return timer;
};
globalThis.clearTimeout = (timer) => {
  const entry = extractionTimers.find((candidate) => candidate.timer === timer);
  if (entry) entry.cleared = true;
  nativeClearTimeout(timer);
};
afterEach(() => {
  for (const entry of extractionTimers) nativeClearTimeout(entry.timer);
  extractionTimers.length = 0;
  holdWorkerReplies = false;
  while (heldWorkerReplies.length) heldWorkerReplies.shift()();
});
after(() => {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  dom.window.close();
});

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/', title: 'Example' }],
    get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  runtime: {
    getURL: (path) => `http://localhost/${path}`,
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
      if (msg.type === 'ATTACH_PDF_CONFIRM' || msg.type === 'ATTACH_OFFICE_CONFIRM') {
        confirmations.push(msg);
        cb({ ok: false }); return; // don't need history storage for this test
      }
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
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => nativeSetTimeout(resolve, 5));
  }
  assert.fail('attach pipeline did not reach the expected state');
};

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
  // right up to its own extraction await. Inspect it before the Worker reply.
  await Promise.resolve();
  await Promise.resolve();

  const progressEl = document.getElementById('attach-progress');
  assert.ok(progressEl, 'progress pill must still be present while PDF extraction is attempted');
  assert.match(progressEl.textContent, /解析 PDF 中/, 'progress pill text must switch to the PDF-specific stage message');

  // Let the extraction finish and confirm cleanup still happens.
  await waitFor(() => !attachBtn.disabled);
  assert.equal(document.getElementById('attach-progress'), null, 'progress pill must be cleared once the PDF flow (success or fallback) finishes');

  // restore for any subsequent tests
  nextAttachResult = { ok: true, data: { ok: true, ctx: { articleTitle: 'Test Page', text: 'hello world', truncated: { textLength: 11 } } } };
});

for (const kind of ['pdf', 'office']) {
  const ctxFor = (bytes) => ({
    mode: `${kind}-pending`, [`${kind}Base64`]: bytes, filename: 'document.docx',
    meta: { url: `https://example.com/document.${kind}`, title: 'Document' },
  });

  for (const outcome of ['success', 'failure']) {
    test(`${kind} extraction cancels its deadline after an early ${outcome}`, async () => {
      nextAttachResult = { ok: true, data: { ok: true, ctx: ctxFor(outcome === 'success' ? 'aGVsbG8=' : '?') } };
      const confirmCount = confirmations.length;
      pendingAttachResolve = null;
      attachBtn.click();
      await waitFor(() => pendingAttachResolve);
      pendingAttachResolve();
      await waitFor(() => confirmations.length > confirmCount && !attachBtn.disabled);

      assert.equal(confirmations.at(-1).type, `ATTACH_${kind.toUpperCase()}_CONFIRM`);
      assert.match(confirmations.at(-1).text, outcome === 'success'
        ? /(?:Extracted PDF|Converted office) document/
        : /agent should fetch and read directly/);
      // Observe only deadlines owned by this pipeline, not Worker deadlines.
      assert.ok(extractionTimers.length > 0, 'the pipeline must enforce a deadline');
      assert.ok(extractionTimers.every((entry) => entry.cleared), 'a completed extraction must leave no live deadline timer');
    });
  }

  test(`${kind} extraction still falls back when its deadline expires`, async () => {
    holdWorkerReplies = true;
    nextAttachResult = { ok: true, data: { ok: true, ctx: ctxFor('aGVsbG8=') } };
    const confirmCount = confirmations.length;
    pendingAttachResolve = null;
    attachBtn.click();
    await waitFor(() => pendingAttachResolve);
    pendingAttachResolve();
    await waitFor(() => heldWorkerReplies.length > 0 && extractionTimers.length > 0);
    const deadline = extractionTimers.at(-1);
    nativeClearTimeout(deadline.timer);
    deadline.callback();
    await waitFor(() => confirmations.length > confirmCount && !attachBtn.disabled);

    assert.match(confirmations.at(-1).text, /agent should fetch and read directly/);
    assert.equal(document.getElementById('attach-progress'), null);
  });
}
