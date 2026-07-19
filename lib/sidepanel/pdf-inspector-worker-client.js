// lib/sidepanel/pdf-inspector-worker-client.js — client wrapper around
// pdf-inspector.worker.js, mirroring lib/sidepanel/katex-worker-client.js's
// ensureWorker()/sticky-workerFailed/timeout-resolves-null shape. Unlike
// KaTeX's per-message batch protocol, this is one PDF per call (no batching
// needed), so the worker protocol here is a plain FIFO of single requests.

const TIMEOUT_MS = 45_000; // generous — large multi-hundred-page layout+table
                            // detection is more expensive than pdf.js's flat join

let worker = null;
let workerFailed = false; // sticky — once worker construction fails, stop retrying
const pendingQueue = []; // FIFO: {resolve} — worker replies in send order

function ensureWorker() {
  if (worker) return worker;
  if (workerFailed) return null;
  try {
    worker = new Worker(chrome.runtime.getURL('lib/sidepanel/pdf-inspector.worker.js'), { type: 'module' });
    worker.addEventListener('message', (ev) => {
      const entry = pendingQueue.shift();
      entry?.resolve(ev.data);
    });
    worker.addEventListener('error', (e) => {
      console.warn('browsa: pdf-inspector worker error, falling back to pdf.js', e);
      workerFailed = true;
    });
    return worker;
  } catch (e) {
    console.warn('browsa: pdf-inspector worker construction failed, falling back to pdf.js', e);
    workerFailed = true;
    return null;
  }
}

/**
 * Runs pdf-inspector-wasm's processPdf() in a Worker. Resolves with
 * `{ok:true, result}` / `{ok:false, error}` on a worker response, or `null`
 * on worker unavailability/timeout — callers must fall back to the existing
 * pdf.js path on `null`, never treat it as a thrown error.
 */
export function processPdfViaWorker(bytes, options) {
  const wk = ensureWorker();
  if (!wk) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = pendingQueue.indexOf(entry);
      if (idx !== -1) pendingQueue.splice(idx, 1);
      resolve(null);
    }, TIMEOUT_MS);
    const entry = {
      resolve: (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(data);
      }
    };
    pendingQueue.push(entry);
    wk.postMessage({ bytes, options });
  });
}
