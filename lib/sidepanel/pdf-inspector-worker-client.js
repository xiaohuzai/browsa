// lib/sidepanel/pdf-inspector-worker-client.js — client wrapper around
// pdf-inspector.worker.js, mirroring lib/sidepanel/katex-worker-client.js's
// ensureWorker()/sticky-workerFailed/timeout-resolves-null shape. Unlike
// KaTeX's per-message batch protocol, this is one PDF per call (no batching
// needed): the worker still EXECUTES requests one at a time in send order,
// but every reply is matched to its request BY requestId — the same fix
// katex-worker-client.js's message handler documents (its batchId match, with
// the "old blind shift() resolved the WRONG pending batch" comment). Order
// must not do the matching: the timeout path dequeues an entry and resolves
// null (pdf.js fallback), so a timed-out request's LATE reply arrives with no
// entry in send order to land on — a blind shift() would hand THAT reply to
// the NEXT queued request, resolving one PDF's call with a different PDF's
// whole parsed structure (data corruption, defect B3).

const TIMEOUT_MS = 90_000; // generous — a ~20 MiB PDF (now allowed after the
                            // MAX_PDF_BYTES bump to 30 MiB) can take a while for
                            // the wasm engine's layout+table detection, which is
                            // more expensive than pdf.js's flat text join. The
                            // outer race in sidepanel.js is 120s so a timed-out
                            // wasm call still leaves room for the pdf.js fallback.

let worker = null;
let workerFailed = false; // sticky — once worker construction fails, stop retrying
const pendingQueue = []; // send-order FIFO of {requestId, resolve} — execution
                         // order only; replies match BY ID via matchPending()
let requestSeq = 0; // correlation ids for the worker request/reply protocol

/**
 * Pure reply→request matching rule for the worker protocol (no Worker/DOM
 * deps — unit-tested in test/lib-worker-pending-match.test.mjs). Returns the
 * pending entry the reply belongs to, REMOVED from the queue, or null when
 * the reply must be dropped:
 *
 * - Reply carries a requestId → only that exact entry resolves. An id whose
 *   entry is gone (it already timed out and resolved null) finds nothing and
 *   returns null — the late reply is dropped instead of resolving the NEXT
 *   queued request with the WRONG document's result (defect B3).
 * - Reply carries NO id at all → replier predates the id protocol (the test
 *   doubles in test/lib-pdf-extractor-*.test.mjs /
 *   test/lib-pdf-inspector-worker-client.test.mjs post exactly this shape):
 *   fall back to the old FIFO order so they keep working. Cannot re-open B3
 *   for real traffic — both worker scripts echo the id on every reply.
 *
 * Shared with office-extractor.js (which imports + re-exports this exact
 * function — ONE implementation, both clients, no second copy to drift).
 */
export function matchPending(pending, requestId) {
  if (requestId == null) return pending.shift() ?? null;
  const idx = pending.findIndex((e) => e.requestId === requestId);
  if (idx === -1) return null;
  return pending.splice(idx, 1)[0];
}

// `chrome.*` is not defined inside a dedicated Worker's global scope (a real
// bug found via a live console error: "chrome is not defined" thrown from
// pdf-inspector.worker.js's ensureInit()) -- only the main thread that
// constructs the Worker has it. Resolve the wasm binary's URL HERE, where
// chrome.runtime.getURL actually exists, and pass it into the worker via the
// message payload instead of having the worker try to resolve it itself.
// Computed lazily (not at module load) -- same reason ensureWorker() below
// calls chrome.runtime.getURL inside the function rather than at the top
// level: some test harnesses' chrome mock isn't fully wired until after this
// module is imported.
function wasmUrl() {
  return chrome.runtime.getURL('lib/vendor/pdf_inspector_wasm_bg.wasm');
}

function ensureWorker() {
  if (worker) return worker;
  if (workerFailed) return null;
  try {
    worker = new Worker(chrome.runtime.getURL('lib/sidepanel/pdf-inspector.worker.js'), { type: 'module' });
    worker.addEventListener('message', (ev) => {
      const data = ev.data || {};
      // Match the reply to ITS request by id (see matchPending). A late reply
      // for an already-timed-out request finds no entry and is dropped here —
      // never shifted onto the next queued request.
      const entry = matchPending(pendingQueue, data.requestId);
      if (!entry) return;
      // Resolve the envelope WITHOUT the correlation id, so the resolved
      // shape stays exactly {ok:true,result}/{ok:false,error} — unchanged
      // export contract for processPdfViaWorker's callers.
      const { requestId: _requestId, ...payload } = data;
      entry.resolve(payload);
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
 * Pre-warms the Worker: starts it (if not already started) and sends a
 * 'warmup' message so WASM init+compile begins immediately. Fire-and-forget —
 * never awaited. Call this on panel init so the first real processPdf() call
 * finds a hot Worker instead of paying the cold-compile cost (4.84MB WASM,
 * 10-30s first-compile in Chrome) right when the user is watching the attach
 * spinner.
 */
export function warmupPdfInspector() {
  const wk = ensureWorker();
  if (wk) wk.postMessage({ type: 'warmup', wasmUrl: wasmUrl() });
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
    const requestId = ++requestSeq;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = pendingQueue.indexOf(entry);
      if (idx !== -1) pendingQueue.splice(idx, 1);
      resolve(null);
    }, TIMEOUT_MS);
    const entry = {
      requestId,
      resolve: (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(data);
      }
    };
    pendingQueue.push(entry);
    wk.postMessage({ bytes, options, wasmUrl: wasmUrl(), requestId });
  });
}
