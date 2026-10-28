// lib/sidepanel/office-extractor.js — Office-document (docx/pptx/xlsx/odt/
// rtf/epub/…) → Markdown conversion for the attach pipeline, via
// docling.rs-wasm running in office-inspector.worker.js. Mirrors the
// pdf-extractor.js + pdf-inspector-worker-client.js pair: one document per
// call (no batching), sticky workerFailed, timeout resolves null so the
// caller (attach-orchestrator.js) can fail-open to the placeholder text.
//
// The worker request/reply state machine is shared with the pdf client and
// lives in worker-rpc.js (createWorkerRpc) — this file keeps only what is
// office-specific: the worker URL, the 60s timeout, the payload shape and
// the 5-minute idle release (the pdf worker stays warm instead — see
// warmupPdfInspector).
//
// Deliberately NOT warmed up at panel init (unlike warmupPdfInspector): the
// docling wasm is 13.4MB — compiling it costs tens of MB of RSS for the
// panel's whole lifetime, and history-resident screenshots already taught us
// panel-open cost matters. The worker starts lazily on the first office
// attach, hidden behind the attach spinner.

// Reply→request matching is the shared worker-protocol rule owned by
// match-pending.js (ONE implementation for both clients — the re-export lets
// test/lib-worker-pending-match.test.mjs pin that this file routes through it
// rather than drifting to its own copy). Same B3 rule as the pdf twin:
// replies match BY requestId, never by queue position — a timed-out request's
// late reply must not resolve the NEXT queued request, or one document's
// markdown would answer a different document's call.
import { createWorkerRpc } from './worker-rpc.js';
import { matchPending } from './match-pending.js';

export { matchPending };

const TIMEOUT_MS = 60_000; // generous — the spike measured 104ms for a 648KB
                           // pptx; even a 30MB workbook stays well under this
                           // (pure Rust parsing, no ML models). The outer race
                           // in attach-orchestrator is 90s.

const rpc = createWorkerRpc({
  label: 'office-inspector',
  failHint: 'failing open',
  timeoutMs: TIMEOUT_MS,
  workerUrl: () => chrome.runtime.getURL('lib/sidepanel/office-inspector.worker.js'),
});

function wasmUrl() {
  return chrome.runtime.getURL('lib/vendor/docling_wasm_bg.wasm');
}

// The docling wasm is ~13.4MB compiled plus its heap; the module comment above
// notes it stays resident "for the panel's whole lifetime" — that is the tax
// this timer removes. After a quiet period with no in-flight request the
// worker is terminated; the NEXT attach pays a cold compile behind the same
// spinner the first attach always did. A request arriving during the idle
// window cancels the pending release.
const WORKER_IDLE_RELEASE_MS = 5 * 60_000;

let releaseTimer = null; // idle-release countdown (see scheduleIdleRelease)

function scheduleIdleRelease() {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (!rpc.isIdle()) { scheduleIdleRelease(); return; } // still busy
    rpc.reset(); // the NEXT attach gets a fresh worker (and a fresh chance)
  }, WORKER_IDLE_RELEASE_MS);
  releaseTimer?.unref?.();
}

/**
 * Runs docling's convert() in the Worker. Resolves `{ok:true, markdown}` /
 * `{ok:false, error}` on a worker reply, or `null` on worker
 * unavailability/timeout — callers must treat null as failure (fail-open to
 * the placeholder), never as a thrown error.
 */
export function convertOfficeViaWorker(bytes, filename) {
  const wk = rpc.ensure();
  if (!wk) return Promise.resolve(null);
  scheduleIdleRelease();
  return rpc.call({ bytes, filename, wasmUrl: wasmUrl() });
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
