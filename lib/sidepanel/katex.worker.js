// lib/sidepanel/katex.worker.js — dedicated Web Worker for KaTeX rendering,
// used by lib/sidepanel/katex-worker-client.js to offload main-thread work
// for messages with many/large formulas. Loaded as a `type: 'module'` worker
// (Chrome MV3's `worker-src 'self'` CSP already permits this — see
// manifest.json), so it can `import` the same-origin vendor bundle directly.
//
// Batch-oriented (one message → one array of jobs → one array of results),
// matching render.js's renderSafe() which extracts ALL of a message's
// formulas up front, unlike markstream-vue's per-formula-per-component
// worker protocol (see the plan's Phase 9 context for why).
import katex from '../vendor/katex.bundle.js';

self.addEventListener('message', (ev) => {
  const jobs = ev.data?.jobs || [];
  const batchId = ev.data?.batchId;
  const results = jobs.map(({ id, formula, displayMode }) => {
    try {
      // Same options render.js's synchronous path already used — a Web
      // Worker changes only where this runs, never how.
      const html = katex.renderToString(formula, {
        output: 'mathml',
        throwOnError: false,
        displayMode,
        strict: false
      });
      return { id, html };
    } catch (e) {
      return { id, error: String(e?.message ?? e) };
    }
  });
  self.postMessage({ jobs: results, batchId });
});
