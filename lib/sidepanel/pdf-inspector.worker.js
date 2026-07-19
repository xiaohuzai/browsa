// lib/sidepanel/pdf-inspector.worker.js — dedicated Web Worker for
// pdf-inspector-wasm's processPdf(), used by pdf-inspector-worker-client.js.
// Mirrors katex.worker.js's pattern (type:'module' worker, same-origin
// import via manifest.json's `worker-src 'self'` CSP). processPdf() is
// synchronous/CPU-bound (its own README recommends a Worker for large
// documents), so this offloads it from the main thread the same way
// katex.worker.js offloads KaTeX's synchronous render.
import init, { processPdf } from '../vendor/pdf_inspector_wasm.js';

let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    initPromise = init(chrome.runtime.getURL('lib/vendor/pdf_inspector_wasm_bg.wasm'));
  }
  return initPromise;
}

self.addEventListener('message', async (ev) => {
  const { bytes, options } = ev.data || {};
  try {
    await ensureInit();
    const result = processPdf(bytes, options);
    self.postMessage({ ok: true, result });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
});
