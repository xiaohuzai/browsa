// lib/sidepanel/office-extractor.js — Office-document (docx/pptx/xlsx/odt/
// rtf/epub/…) → Markdown conversion for the attach pipeline, via
// docling.rs-wasm running in office-inspector.worker.js. Mirrors the
// pdf-extractor.js + pdf-inspector-worker-client.js pair: one document per
// call (no batching), sticky workerFailed, timeout resolves null so the
// caller (attach-orchestrator.js) can fail-open to the placeholder text.
//
// Deliberately NOT warmed up at panel init (unlike warmupPdfInspector): the
// docling wasm is 13.4MB — compiling it costs tens of MB of RSS for the
// panel's whole lifetime, and history-resident screenshots already taught us
// panel-open cost matters. The worker starts lazily on the first office
// attach, hidden behind the attach spinner.

const TIMEOUT_MS = 60_000; // generous — the spike measured 104ms for a 648KB
                           // pptx; even a 30MB workbook stays well under this
                           // (pure Rust parsing, no ML models). The outer race
                           // in attach-orchestrator is 90s.

let worker = null;
let workerFailed = false; // sticky — once worker construction fails, stop retrying
const pendingQueue = []; // FIFO: {resolve} — one document per call, plain FIFO

function workerUrl() {
  return chrome.runtime.getURL('lib/sidepanel/office-inspector.worker.js');
}

function wasmUrl() {
  return chrome.runtime.getURL('lib/vendor/docling_wasm_bg.wasm');
}

function ensureWorker() {
  if (worker) return worker;
  if (workerFailed) return null;
  try {
    worker = new Worker(workerUrl(), { type: 'module' });
    worker.addEventListener('message', (ev) => {
      const entry = pendingQueue.shift();
      entry?.resolve(ev.data);
    });
    worker.addEventListener('error', (e) => {
      console.warn('browsa: office-inspector worker error, failing open', e);
      workerFailed = true;
    });
    return worker;
  } catch (e) {
    console.warn('browsa: office-inspector worker construction failed, failing open', e);
    workerFailed = true;
    return null;
  }
}

/**
 * Runs docling's convert() in the Worker. Resolves `{ok:true, markdown}` /
 * `{ok:false, error}` on a worker reply, or `null` on worker
 * unavailability/timeout — callers must treat null as failure (fail-open to
 * the placeholder), never as a thrown error.
 */
export function convertOfficeViaWorker(bytes, filename) {
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
    wk.postMessage({ bytes, filename, wasmUrl: wasmUrl() });
  });
}

/**
 * Entry point the attach pipeline calls (attach-orchestrator.js's
 * office-pending branch): base64 (as fetched in-tab by page-extractor.js's
 * MAIN-world probe) + original filename (docling keys format detection off
 * the extension). Returns `{text, ext}` on success or throws — the caller
 * catches and falls back to the placeholder, same contract as
 * extractPdfContent().
 */
export async function extractOfficeContent(base64, filename) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const res = await convertOfficeViaWorker(bytes, filename);
  if (!res) throw new Error('office conversion unavailable (worker missing or timed out)');
  if (!res.ok) throw new Error('office conversion failed: ' + res.error);
  const text = (res.markdown || '').trim();
  if (!text) throw new Error('office conversion produced no text');
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || 'doc').toLowerCase();
  return { text, ext };
}
