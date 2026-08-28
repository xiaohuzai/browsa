// lib/sidepanel/katex-worker-client.js — simplified port of markstream-vue's
// katexWorkerClient.ts, reshaped for browsa's architecture: ONE renderSafe()
// call extracts ALL of a message's formulas up front and needs them all
// rendered before it can finish sanitizing/assembling that message's HTML.
// Markstream's original targets many independently-mounted Vue components
// (one per formula) and needs concurrency caps/backpressure/retry to keep
// them from starving each other — browsa has no such contention (it's one
// batch per message), so none of that machinery is ported. See the plan's
// Phase 9 context for the full reasoning.
import katex from '../vendor/katex.bundle.js';
import { recommendNForSamples } from './katex-threshold.js';

// Ported near-verbatim from markstream-vue's src/utils/normalizeKaTeXRenderInput.ts.
// U+00B7 (·) breaks inside KaTeX \text{...} (maps to \cdotp there, not a
// plain interpunct); U+2103 (℃) has no KaTeX glyph metrics. Both are common
// in Chinese text (e.g. "kg·℃" unit/temperature notation), so this runs on
// every formula before rendering, caching, or dispatch — cache keys and
// worker input are both normalized, never the raw LLM-supplied text.
export function normalizeKaTeXRenderInput(content) {
  return content.replace(/·/g, '⋅').replace(/℃/g, '°C');
}

const CACHE_MAX = 200;
const cache = new Map(); // `${d|i}:${formula}` -> html
const BATCH_TIMEOUT_MS = 2000;

function cacheKey(formula, displayMode) {
  return `${displayMode ? 'd' : 'i'}:${formula}`;
}

function cacheGet(formula, displayMode) {
  return cache.get(cacheKey(formula, displayMode));
}

function cacheSet(formula, displayMode, html) {
  const key = cacheKey(formula, displayMode);
  cache.set(key, html);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function renderSync(formula, displayMode) {
  try {
    const html = katex.renderToString(formula, {
      output: 'mathml',
      throwOnError: false,
      displayMode,
      strict: false
    });
    cacheSet(formula, displayMode, html);
    return { ok: true, html };
  } catch {
    return { ok: false };
  }
}

let worker = null;
let workerFailed = false; // sticky — once worker construction fails, stop retrying construction
const pendingQueue = []; // FIFO: {resolve} — worker replies in the order messages were sent

function ensureWorker() {
  if (worker) return worker;
  if (workerFailed) return null;
  try {
    worker = new Worker(chrome.runtime.getURL('lib/sidepanel/katex.worker.js'), { type: 'module' });
    worker.addEventListener('message', (ev) => {
      // Match the reply to ITS batch by id. The old blind shift() resolved
      // the WRONG pending batch when a timed-out batch's late reply arrived,
      // contaminating the next message's formulas with the previous
      // message's results (results are indexed from 0 in both).
      const entry = pendingQueue.find((e) => e.batchId === ev.data?.batchId);
      if (!entry) return; // late reply for an already-timed-out batch — drop
      pendingQueue.splice(pendingQueue.indexOf(entry), 1);
      entry.resolve(ev.data?.jobs || []);
    });
    worker.addEventListener('error', (e) => {
      console.warn('browsa: katex worker error, falling back to sync render', e);
      workerFailed = true;
      // Reject nothing here — renderBatchViaWorker's own timeout covers any
      // requests already in flight; new calls will see workerFailed and skip
      // straight to sync.
    });
    return worker;
  } catch (e) {
    console.warn('browsa: katex worker construction failed, falling back to sync render', e);
    workerFailed = true;
    return null;
  }
}

// Sends one batch, resolves with the worker's job results, or `null` on
// timeout/unavailability (caller falls back to sync for the whole batch —
// never a partial worker/sync mix within one message).
let batchSeq = 0;

function renderBatchViaWorker(jobs) {
  const wk = ensureWorker();
  if (!wk) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const batchId = ++batchSeq;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = pendingQueue.indexOf(entry);
      if (idx !== -1) pendingQueue.splice(idx, 1);
      resolve(null);
    }, BATCH_TIMEOUT_MS);
    const entry = {
      batchId,
      resolve: (jobResults) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(jobResults);
      }
    };
    pendingQueue.push(entry);
    wk.postMessage({ jobs, batchId });
  });
}

// mathParts: {formula, displayMode}[] -> Promise<Array<{ok:true,html}|{ok:false}>>
// Always resolves (never rejects) so renderSafe() never needs its own
// worker-specific error handling.
export async function renderMathBatch(mathParts) {
  const results = new Array(mathParts.length);
  const uncached = []; // {origIndex, formula, displayMode}

  mathParts.forEach((rawPart, i) => {
    const p = { ...rawPart, formula: normalizeKaTeXRenderInput(rawPart.formula) };
    const cached = cacheGet(p.formula, p.displayMode);
    if (cached != null) results[i] = { ok: true, html: cached };
    else uncached.push({ origIndex: i, ...p });
  });

  if (uncached.length === 0) return results;

  const threshold = recommendNForSamples(uncached.map(p => p.formula));
  if (uncached.length <= threshold || workerFailed) {
    for (const p of uncached) results[p.origIndex] = renderSync(p.formula, p.displayMode);
    return results;
  }

  const jobs = uncached.map(p => ({ id: p.origIndex, formula: p.formula, displayMode: p.displayMode }));
  const jobResults = await renderBatchViaWorker(jobs);
  if (jobResults == null) {
    // Worker unavailable/timed out — fall back to sync for the whole batch.
    for (const p of uncached) results[p.origIndex] = renderSync(p.formula, p.displayMode);
    return results;
  }

  const byId = new Map(jobResults.map(r => [r.id, r]));
  for (const p of uncached) {
    const r = byId.get(p.origIndex);
    if (r && r.html != null) {
      cacheSet(p.formula, p.displayMode, r.html);
      results[p.origIndex] = { ok: true, html: r.html };
    } else {
      results[p.origIndex] = { ok: false };
    }
  }
  return results;
}
