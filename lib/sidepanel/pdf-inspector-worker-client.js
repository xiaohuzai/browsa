// lib/sidepanel/pdf-inspector-worker-client.js — client wrapper around
// pdf-inspector.worker.js. The ensureWorker()/sticky-workerFailed/
// timeout-resolves-null state machine is shared with the office client and
// lives in worker-rpc.js (createWorkerRpc) — this file keeps only what is
// pdf-specific: the worker URL, the timeout, the payload shape and the
// fallback hint. Reply matching is match-pending.js (re-exported below so
// existing import paths stay put); like katex-worker-client.js's batch
// protocol vs this one-document-per-call protocol, every reply is matched to
// its request BY requestId — never by queue position. Order must not do the
// matching: the timeout path dequeues an entry and resolves null (pdf.js
// fallback), so a timed-out request's LATE reply arrives with no entry in
// send order to land on — a blind shift() would hand THAT reply to the NEXT
// queued request, resolving one PDF's call with a different PDF's whole
// parsed structure (data corruption, defect B3).

import { createWorkerRpc } from './worker-rpc.js';

export { matchPending } from './match-pending.js';

const TIMEOUT_MS = 90_000; // generous — a ~20 MiB PDF (now allowed after the
                            // MAX_PDF_BYTES bump to 30 MiB) can take a while for
                            // the wasm engine's layout+table detection, which is
                            // more expensive than pdf.js's flat text join. The
                            // outer race in sidepanel.js is 120s so a timed-out
                            // wasm call still leaves room for the pdf.js fallback.

// `chrome.*` is not defined inside a dedicated Worker's global scope (a real
// bug found via a live console error: "chrome is not defined" thrown from
// pdf-inspector.worker.js's ensureInit()) -- only the main thread that
// constructs the Worker has it. Resolve the wasm binary's URL HERE, where
// chrome.runtime.getURL actually exists, and pass it into the worker via the
// message payload instead of having the worker try to resolve it itself.
// Computed lazily (not at module load) -- same reason the factory calls
// workerUrl() inside ensure() rather than at creation time: some test
// harnesses' chrome mock isn't fully wired until after this module is
// imported.
function wasmUrl() {
  return chrome.runtime.getURL('lib/vendor/pdf_inspector_wasm_bg.wasm');
}

const rpc = createWorkerRpc({
  label: 'pdf-inspector',
  failHint: 'falling back to pdf.js',
  timeoutMs: TIMEOUT_MS,
  workerUrl: () => chrome.runtime.getURL('lib/sidepanel/pdf-inspector.worker.js'),
});

/**
 * Pre-warms the Worker: starts it (if not already started) and sends a
 * 'warmup' message so WASM init+compile begins immediately. Fire-and-forget —
 * never awaited. Call this on panel init so the first real processPdf() call
 * finds a hot Worker instead of paying the cold-compile cost (4.84MB WASM,
 * 10-30s first-compile in Chrome) right when the user is watching the attach
 * spinner.
 */
export function warmupPdfInspector() {
  rpc.post({ type: 'warmup', wasmUrl: wasmUrl() });
}

/**
 * Runs pdf-inspector-wasm's processPdf() in a Worker. Resolves with
 * `{ok:true, result}` / `{ok:false, error}` on a worker response, or `null`
 * on worker unavailability/timeout — callers must fall back to the existing
 * pdf.js path on `null`, never treat it as a thrown error.
 */
export function processPdfViaWorker(bytes, options, { transfer = false } = {}) {
  // `transfer` moves the byte buffer instead of structured-cloning it (a
  // 30MB PDF is copied twice otherwise). The caller must hand us a buffer
  // nobody else needs — extractPdfContent passes a throwaway copy.
  return rpc.call({ bytes, options, wasmUrl: wasmUrl() }, { transfer });
}
