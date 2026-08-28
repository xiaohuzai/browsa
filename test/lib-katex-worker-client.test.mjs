// test/lib-katex-worker-client.test.mjs — execution tests for
// lib/sidepanel/katex-worker-client.js. Mocks globalThis.Worker (same
// mocking approach already used for chrome.runtime.connect fake ports in
// test/lib-detail-thread.test.mjs) so the batching/threshold/cache/fallback
// logic runs against a controllable stand-in instead of a real worker.
//
// Each test gets a FRESH module instance via a cache-busting query string —
// the module has real singleton state (lazily-constructed worker, sticky
// workerFailed flag, render cache), and sharing one instance across tests
// would let an earlier test's successful worker construction (or cached
// formula) silently short-circuit a later test's fallback/failure scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } };

function installFakeWorker(behavior) {
  let lastInstance = null;
  class FakeWorker {
    constructor(_url, _opts) {
      if (behavior === 'throw') throw new Error('worker construction failed');
      this._listeners = { message: [], error: [] };
      lastInstance = this;
    }
    addEventListener(type, fn) { this._listeners[type].push(fn); }
    postMessage(data) {
      if (behavior === 'silent') return; // simulate a hung/never-responding worker
      if (behavior === 'manual') return; // test fires replies itself
      // Echo back: a fake "html" distinguishable from real KaTeX/sync output,
      // so tests can tell worker results apart from cache/sync results. A
      // job whose formula is exactly 'FAIL' simulates a per-job render error.
      const jobs = data.jobs.map(j => j.formula === 'FAIL'
        ? { id: j.id, error: 'bad formula' }
        : { id: j.id, html: `<worker-html len="${j.formula.length}">` });
      for (const fn of this._listeners.message) fn({ data: { jobs, batchId: data.batchId } });
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
  return () => lastInstance;
}

async function freshModule() {
  return import('../lib/sidepanel/katex-worker-client.js?t=' + Math.random() + Math.random());
}

test('normalizeKaTeXRenderInput replaces the interpunct (·) and degree-Celsius (℃) glyphs KaTeX cannot render correctly', async () => {
  installFakeWorker('echo');
  const { normalizeKaTeXRenderInput } = await freshModule();
  assert.equal(normalizeKaTeXRenderInput('5\\,\\text{kg·℃}'), '5\\,\\text{kg⋅°C}');
});

test('renderMathBatch normalizes · and ℃ before rendering, so KaTeX never sees the raw glyphs', async () => {
  installFakeWorker('echo');
  const { renderMathBatch } = await freshModule();
  const results = await renderMathBatch([{ formula: '5\\,\\text{kg·℃}', displayMode: false }]);
  assert.equal(results[0].ok, true, 'KaTeX must not choke on the pre-normalized formula');
});

// A batch small enough to stay under threshold uses the sync katex path
// directly (real katex.bundle.js, no worker involved) — these are simple
// short formulas, well under any reasonable per-formula-cost threshold.
test('renderMathBatch: small batches render synchronously (no worker constructed)', async () => {
  const getLastInstance = installFakeWorker('echo');
  const { renderMathBatch } = await freshModule();
  const results = await renderMathBatch([
    { formula: 'x^2', displayMode: false },
    { formula: 'y^2', displayMode: false },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.match(results[0].html, /<math/, 'must be real KaTeX MathML output, not a worker stand-in');
  assert.equal(getLastInstance(), null, 'small batches must not construct a worker at all');
});

test('renderMathBatch: a batch large enough to cross the threshold uses the worker', async () => {
  const getLastInstance = installFakeWorker('echo');
  const { renderMathBatch } = await freshModule();
  // Many simple formulas — recommendNForSamples for 'simple' (R=3, B=50) is
  // floor(50/3)=16, so 20 distinct short formulas crosses it.
  const parts = Array.from({ length: 20 }, (_, i) => ({ formula: `q${i}`, displayMode: false }));
  const results = await renderMathBatch(parts);
  assert.equal(results.length, 20);
  assert.ok(getLastInstance(), 'a worker must have been constructed for an over-threshold batch');
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.match(r.html, /<worker-html/, 'results must come from the (fake) worker, not a sync fallback');
  }
});

test('renderMathBatch: a per-job worker error falls through to {ok:false} for just that formula', async () => {
  installFakeWorker('echo');
  const { renderMathBatch } = await freshModule();
  const parts = Array.from({ length: 20 }, (_, i) => ({ formula: i === 5 ? 'FAIL' : `q${i}`, displayMode: false }));
  const results = await renderMathBatch(parts);
  assert.equal(results[5].ok, false);
  assert.equal(results[0].ok, true);
});

test('renderMathBatch: worker construction failure falls back to sync for the whole batch', async () => {
  installFakeWorker('throw');
  const { renderMathBatch } = await freshModule();
  const parts = Array.from({ length: 20 }, (_, i) => ({ formula: `q${i}`, displayMode: false }));
  const results = await renderMathBatch(parts);
  assert.equal(results.length, 20);
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.match(r.html, /<math/, 'must fall back to real sync KaTeX rendering, not stay unresolved');
  }
});

test('renderMathBatch: a worker that never responds times out and falls back to sync', { timeout: 5000 }, async () => {
  installFakeWorker('silent');
  const { renderMathBatch } = await freshModule();
  const parts = Array.from({ length: 20 }, (_, i) => ({ formula: `q${i}`, displayMode: false }));
  const results = await renderMathBatch(parts);
  assert.equal(results.length, 20);
  for (const r of results) assert.equal(r.ok, true);
});

test('renderMathBatch: repeated identical formulas hit the cache and skip re-rendering', async () => {
  installFakeWorker('echo');
  const { renderMathBatch } = await freshModule();
  const first = await renderMathBatch([{ formula: 'cache-me', displayMode: true }]);
  assert.equal(first[0].ok, true);
  // Second call with the exact same formula must resolve from cache — verified
  // indirectly: even after the fake Worker constructor starts throwing, a
  // cache hit still succeeds because it never needs to reach the
  // worker/sync-fallback path at all.
  installFakeWorker('throw');
  const second = await renderMathBatch([{ formula: 'cache-me', displayMode: true }]);
  assert.equal(second[0].ok, true);
  assert.equal(second[0].html, first[0].html);
});

test('renderMathBatch: a reply whose batchId matches resolves; an unknown batchId is ignored (no cross-batch contamination)', async () => {
  const getWorker = (() => {
    let lastInstance = null;
    class ManualWorker {
      constructor() {
        this._listeners = { message: [], error: [] };
        lastInstance = this;
      }
      addEventListener(type, fn) { this._listeners[type].push(fn); }
      postMessage() {} // test fires replies manually
      terminate() {}
    }
    globalThis.Worker = ManualWorker;
    return () => lastInstance;
  })();
  getWorker();

  const { renderMathBatch } = await freshModule();
  // Enough (long) formulas to clear the worker threshold — a small batch
  // would take the synchronous path and never construct a worker.
  const formulas = Array.from({ length: 12 }, (_, i) => `x_{${i}}^{2} + ${i} \\frac{a${i}}{b${i}} ` + 'y'.repeat(40 + i * 10));
  const pending = renderMathBatch(formulas.map((f, i) => ({ formula: f, displayMode: i === 0 })));
  // Give the module a tick to construct the worker + queue the batch (batchId 1).
  await new Promise((r) => setTimeout(r, 0));

  const worker = getWorker();
  const fire = (payload) => worker._listeners.message.forEach((fn) => fn({ data: payload }));

  // A late reply for a batch id that was never issued (or already timed out)
  // must be dropped, not blindly shifted onto the pending batch.
  fire({ jobs: [{ id: 0, html: '<stale-html>' }], batchId: 999 });
  // The genuine reply for batchId 1 (ids are per-batch job indices).
  const jobs = formulas.map((f, i) => ({ id: i, html: `<worker-good-${i}>` }));
  fire({ jobs, batchId: 1 });

  const results = await pending;
  assert.equal(results[0]?.html, '<worker-good-0>', 'the pending batch resolves from ITS OWN reply only');
});
