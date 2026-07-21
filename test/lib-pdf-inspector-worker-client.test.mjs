// test/lib-pdf-inspector-worker-client.test.mjs — execution tests for
// lib/sidepanel/pdf-inspector-worker-client.js. Mocks globalThis.Worker,
// mirroring test/lib-katex-worker-client.test.mjs's approach. Neither the
// 45s timeout path nor an in-flight 'error' event is exercised here — both
// only resolve via a real (or `.unref()`-less) setTimeout that would leave a
// pending 45s timer alive for the whole test run; the underlying mechanism
// (setTimeout+resolve(null) / sticky workerFailed flag) is already covered
// by katex-worker-client's tests against a much shorter timeout. These tests
// focus on the two paths pdf-extractor.js's fallback chain actually branches
// on: a real worker response, and construction failing outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } };

function installFakeWorker(behavior) {
  let lastInstance = null;
  class FakeWorker {
    constructor(_url, _opts) {
      if (behavior === 'throw') throw new Error('worker construction failed');
      this._listeners = { message: [], error: [] };
      this.postedMessages = [];
      lastInstance = this;
    }
    addEventListener(type, fn) { this._listeners[type].push(fn); }
    postMessage(data) {
      this.postedMessages.push(data);
      if (data.type === 'warmup') return; // no reply expected
      const result = { markdown: `# doc for ${data.bytes.length} bytes`, pageCount: 1, pdfType: 'TextBased', confidence: 0.9, pagesNeedingOcr: [] };
      for (const fn of this._listeners.message) fn({ data: { ok: true, result } });
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
  return () => lastInstance;
}

async function freshModule() {
  return import('../lib/sidepanel/pdf-inspector-worker-client.js?t=' + Math.random() + Math.random());
}

test('processPdfViaWorker: successful worker response resolves {ok:true, result}', async () => {
  installFakeWorker('echo');
  const { processPdfViaWorker } = await freshModule();
  const res = await processPdfViaWorker(new Uint8Array([1, 2, 3]), { profile: 'fidelity' });
  assert.equal(res.ok, true);
  assert.match(res.result.markdown, /# doc for 3 bytes/);
});

test('processPdfViaWorker: worker construction failure resolves null (caller falls back to pdf.js)', async () => {
  installFakeWorker('throw');
  const { processPdfViaWorker } = await freshModule();
  const res = await processPdfViaWorker(new Uint8Array([1]), {});
  assert.equal(res, null);
});

// Regression: `chrome.*` is not defined inside a dedicated Worker's global
// scope. pdf-inspector.worker.js used to call `chrome.runtime.getURL(...)`
// itself to resolve the wasm binary's URL, which threw
// "ReferenceError: chrome is not defined" on every single call (warmup and
// real requests alike) -- confirmed via a live console error report. Since
// the worker's ensureInit() never actually succeeded, the wasm-based PDF
// path silently never worked at all; every PDF attach fell through to the
// plain pdf.js text-join fallback. Fixed by resolving the URL in the client
// (this file, which runs in the main thread and has chrome.runtime.getURL)
// and sending it to the worker via the message payload instead.
test('processPdfViaWorker / warmupPdfInspector: the wasm binary URL is resolved by the CLIENT and sent to the worker via postMessage, never left for the worker to resolve itself', async () => {
  const getInstance = installFakeWorker('echo');
  const { processPdfViaWorker, warmupPdfInspector } = await freshModule();

  warmupPdfInspector();
  const warmupMsg = getInstance().postedMessages.find((m) => m.type === 'warmup');
  assert.ok(warmupMsg, 'warmup message must be sent');
  assert.match(warmupMsg.wasmUrl, /^chrome-extension:\/\/fake\/lib\/vendor\/pdf_inspector_wasm_bg\.wasm$/,
    'warmup payload must carry a client-resolved wasm URL');

  await processPdfViaWorker(new Uint8Array([1, 2, 3]), {});
  const realMsg = getInstance().postedMessages.find((m) => m.bytes);
  assert.ok(realMsg, 'the real processPdf request must be sent');
  assert.match(realMsg.wasmUrl, /^chrome-extension:\/\/fake\/lib\/vendor\/pdf_inspector_wasm_bg\.wasm$/,
    'a real processPdf request must also carry the client-resolved wasm URL, not rely on the worker resolving it');
});
