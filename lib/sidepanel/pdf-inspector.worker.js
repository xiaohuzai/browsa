// lib/sidepanel/pdf-inspector.worker.js — dedicated Web Worker for
// pdf-inspector-wasm's processPdf(), used by pdf-inspector-worker-client.js.
// Mirrors katex.worker.js's pattern (type:'module' worker, same-origin
// import via manifest.json's `worker-src 'self'` CSP). processPdf() is
// synchronous/CPU-bound (its own README recommends a Worker for large
// documents), so this offloads it from the main thread the same way
// katex.worker.js offloads KaTeX's synchronous render.
import init, { processPdf } from '../vendor/pdf_inspector_wasm.js';

let initPromise = null;

// `chrome.*` is not defined inside a Worker's global scope -- a real bug
// found via a live "chrome is not defined" console error, meaning this
// worker's WASM init has never actually succeeded; every real request fell
// through to the try/catch below and reported {ok:false}, silently
// downgrading every PDF attach to the plain pdf.js text-join fallback. Fixed
// by having the caller (pdf-inspector-worker-client.js, which runs in the
// main thread and does have chrome.runtime.getURL) resolve the wasm URL and
// pass it in via the message payload instead.
function ensureInit(wasmUrl) {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl });
  }
  return initPromise;
}

self.addEventListener('message', async (ev) => {
  const { bytes, options, type, wasmUrl } = ev.data || {};
  // A 'warmup' message pre-compiles the WASM binary so the first real
  // processPdf() call doesn't pay the cold-start cost. No reply needed.
  if (type === 'warmup') {
    // Not silently swallowed -- if init genuinely fails here, initPromise
    // caches the rejection forever (ensureInit() never retries), so a real
    // request later would fail identically anyway. Logging now, at the
    // point it actually happened, matches every other failure path in this
    // file/pdf-extractor.js instead of being the one silent exception.
    ensureInit(wasmUrl).catch((e) => console.warn('browsa: pdf-inspector warmup failed', e));
    return;
  }
  try {
    await ensureInit(wasmUrl);
    const result = processPdf(bytes, options);
    self.postMessage({ ok: true, result });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
});
