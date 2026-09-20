// lib/sidepanel/office-inspector.worker.js — dedicated Web Worker for
// docling.rs-wasm's convert() (Office docs → Markdown), used by
// office-extractor.js. Mirrors pdf-inspector.worker.js exactly: type:'module'
// worker (worker-src 'self' CSP), wasm-bindgen /web glue imported from
// lib/vendor/, wasm URL resolved by the MAIN thread (chrome.* doesn't exist
// in a Worker's global scope — same real bug the pdf worker hit) and passed
// in via the message payload. convert() is synchronous/CPU-bound (pure Rust
// parser, no ML models for office formats), so the Worker offload keeps the
// side panel's main thread free during a big conversion.
import init, { convert } from '../vendor/docling_wasm.js';

let initPromise = null;

function ensureInit(wasmUrl) {
  if (!initPromise) {
    initPromise = init({ module_or_path: wasmUrl });
  }
  return initPromise;
}

self.addEventListener('message', async (ev) => {
  const { bytes, filename, type, wasmUrl } = ev.data || {};
  // 'warmup' pre-compiles the WASM binary so the first real convert() doesn't
  // pay cold-start. The client deliberately never sends this automatically
  // (13.4MB wasm compiled = tens of MB RSS for the panel's whole lifetime);
  // it exists for future on-demand use, mirroring the pdf worker protocol.
  if (type === 'warmup') {
    ensureInit(wasmUrl).catch((e) => console.warn('browsa: office-inspector warmup failed', e));
    return;
  }
  try {
    await ensureInit(wasmUrl);
    const markdown = convert(bytes, filename, 'md');
    self.postMessage({ ok: true, markdown });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
});
