// lib/sidepanel/katex-threshold.js — ported near-verbatim from
// markstream-vue's src/utils/katex-threshold.ts (framework-free logic,
// confirmed by reading the source directly). Decides whether a message's
// formula count is worth offloading to a Web Worker vs rendering
// synchronously on the main thread — see lib/sidepanel/katex-worker-client.js.
//
// N_threshold ≈ floor(B / (R × (1 - H)))
// - B: main-thread budget (ms), e.g. 50ms
// - R: avg render time per unique formula (ms)
// - H: cache hit rate (0~1), default 0 for first paint

export function recommendWorkerThreshold({ R, H = 0, B = 50 }) {
  const denom = R * (1 - H) || 1e-6;
  return Math.max(1, Math.floor(B / denom));
}

// A very lightweight classifier by formula length/characters to pick R ballpark.
export function estimateRByFormula(sample) {
  const len = sample.length;
  const slashes = (sample.match(/\\/g) || []).length;
  const score = len + slashes * 10;
  if (score < 10) return 'simple';
  if (score < 40) return 'medium';
  return 'complex';
}

export function defaultRByClass(cls) {
  switch (cls) {
    case 'simple': return 3;
    case 'medium': return 10;
    case 'complex': return 30;
  }
}

export function recommendNForSamples(formulas, opts) {
  // classify each and take the worst (max R) since bursts often contain mixed complexity
  let maxR = 0;
  for (const f of formulas) {
    const R = defaultRByClass(estimateRByFormula(f));
    if (R > maxR) maxR = R;
  }
  return recommendWorkerThreshold({ R: maxR, H: opts?.H ?? 0, B: opts?.B ?? 50 });
}
