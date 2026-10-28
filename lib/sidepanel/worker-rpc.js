// lib/sidepanel/worker-rpc.js — the shared request/reply state machine for
// the side panel's wasm worker clients. The pdf-inspector and office clients
// (pdf-inspector-worker-client.js / office-extractor.js) used to carry
// byte-twin copies of ensureWorker + sticky-workerFailed + send-order queue +
// timeout bookkeeping; this factory is now the ONE implementation and the
// clients keep only their worker URL, timeout, payload shape and fail hints.
// (katex-worker-client.js predates this and batches per message — different
// protocol, deliberately not migrated.)
//
// Protocol invariants (defect B3, pinned by test/lib-worker-pending-match.test.mjs
// and test/lib-worker-rpc.test.mjs):
//   - Every call gets a correlation id; the worker scripts echo it. Replies
//     match BY id, never by queue position — a timed-out request's late reply
//     must not resolve the NEXT queued request.
//   - The reply envelope is resolved WITHOUT the id, so callers keep the exact
//     {ok:true,…}/{ok:false,error} contract they had before the factory.
//   - Unavailability and timeout both resolve null (callers fail-open); the
//     resolved-vs-null distinction is the caller's fallback trigger.
//   - worker construction failure is STICKY per instance — no retry storm
//     against a broken worker-src — until reset() (the office idle-release
//     policy uses it to grant a fresh worker after a quiet period).

import { matchPending } from './match-pending.js';

export function createWorkerRpc({ workerUrl, timeoutMs, label, failHint = 'failing open' }) {
  let worker = null;
  let workerFailed = false; // sticky — once worker construction fails, stop retrying
  const pendingQueue = []; // send-order FIFO of {requestId, resolve} — execution
                           // order only; replies match BY ID via matchPending()
  let requestSeq = 0; // correlation ids for the worker request/reply protocol

  function ensure() {
    if (worker) return worker;
    if (workerFailed) return null;
    try {
      worker = new Worker(workerUrl(), { type: 'module' });
      worker.addEventListener('message', (ev) => {
        const data = ev.data || {};
        // Match the reply to ITS request by id (see matchPending). A late reply
        // for an already-timed-out request finds no entry and is dropped here —
        // never shifted onto the next queued request.
        const entry = matchPending(pendingQueue, data.requestId);
        if (!entry) return;
        const { requestId: _requestId, ...payload } = data;
        entry.resolve(payload);
      });
      worker.addEventListener('error', (e) => {
        console.warn(`browsa: ${label} worker error, ${failHint}`, e);
        workerFailed = true;
      });
      return worker;
    } catch (e) {
      console.warn(`browsa: ${label} worker construction failed, ${failHint}`, e);
      workerFailed = true;
      return null;
    }
  }

  /**
   * Run one request. Posts `{...message, requestId}` (with a transfer list
   * only when `transfer` is set and `message.bytes` is a view over an
   * ArrayBuffer), resolves the reply minus the correlation id, or null on
   * unavailability/timeout — callers treat null as failure (fail-open),
   * never as a thrown error.
   */
  function call(message, { transfer = false } = {}) {
    const wk = ensure();
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
      }, timeoutMs);
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
      const xfer = transfer && message.bytes?.buffer instanceof ArrayBuffer ? [message.bytes.buffer] : [];
      wk.postMessage({ ...message, requestId }, xfer);
    });
  }

  /** Fire-and-forget message outside the request/reply protocol (pdf warmup):
   * no correlation id, no queue entry, no timeout. */
  function post(message) {
    const wk = ensure();
    if (wk) wk.postMessage(message); // warmup — protocol-external, no id
  }

  /** True when no request is in flight (idle-release policies key off this). */
  function isIdle() {
    return pendingQueue.length === 0;
  }

  /** Terminate the worker and clear the sticky failure — the next ensure()
   * builds a fresh one. No-op when no worker exists. */
  function reset() {
    if (!worker) return;
    try { worker.terminate(); } catch (_) {}
    worker = null;
    workerFailed = false;
  }

  return { ensure, call, post, isIdle, reset };
}
