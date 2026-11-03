// test/lib-katex-threshold.test.mjs — execution tests for
// lib/sidepanel/katex-threshold.js, ported near-verbatim from
// markstream-vue's src/utils/katex-threshold.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendWorkerThreshold, estimateRByFormula, defaultRByClass, recommendNForSamples
} from '../lib/sidepanel/katex-threshold.js';

test('estimateRByFormula classifies by length + backslash count', () => {
  assert.equal(estimateRByFormula('x^2'), 'simple');
  assert.equal(estimateRByFormula('\\alpha + \\beta'), 'medium');
  assert.equal(estimateRByFormula('\\sum_{i=0}^{n} \\frac{x_i^2}{\\sigma^2} \\cdot \\int_0^\\infty f(x)\\,dx'), 'complex');
});

test('defaultRByClass: exact ms budgets per class', () => {
  // Sign-only assertions (a < b < c) passed for ANY monotone implementation, e.g.
  // a placeholder returning 1/2/3. These numbers are the ported contract: the
  // budgets are what decide worker-vs-sync for every rendered message.
  assert.equal(defaultRByClass('simple'), 3);
  assert.equal(defaultRByClass('medium'), 10);
  assert.equal(defaultRByClass('complex'), 30);
  assert.equal(defaultRByClass('unknown-class'), undefined, 'unknown class yields no budget (caller falls back)');
});

test('recommendWorkerThreshold: exact thresholds from N = floor(B / (R*(1-H))), clamped to >= 1', () => {
  assert.equal(recommendWorkerThreshold({ R: 3 }), 16, 'B=50, R=3 → 16 formulas');
  assert.equal(recommendWorkerThreshold({ R: 10 }), 5);
  assert.equal(recommendWorkerThreshold({ R: 30 }), 1, 'one formula already costs 30ms of a 50ms budget');
  assert.equal(recommendWorkerThreshold({ R: 1000 }), 1, 'never below one formula');
  assert.equal(recommendWorkerThreshold({ R: 2.5, B: 10 }), 4, 'floor, not round');
  assert.equal(recommendWorkerThreshold({ R: 10, H: 0.9 }), 50, 'a 90% cache hit rate makes each new formula 1ms');
});

test('estimateRByFormula: exact score boundaries (len + 10*backslashCount)', () => {
  assert.equal(estimateRByFormula('123456789'), 'simple', 'score 9 → simple');
  assert.equal(estimateRByFormula('1234567890'), 'medium', 'score 10 → medium (boundary is exclusive on the lower class)');
  assert.equal(estimateRByFormula('123456789012345678901234567890123456789'), 'medium', 'score 39 → medium');
  assert.equal(estimateRByFormula('1234567890123456789012345678901234567890'), 'complex', 'score 40 → complex');
  assert.equal(estimateRByFormula('\\a\\b\\c'), 'medium', '6 chars + 3 backslashes = 36 → medium');
});

test('recommendNForSamples: takes the worst (max R) complexity among mixed formulas', () => {
  // Exact numbers: all-simple → R=3 → 16; one complex formula drags the batch to
  // R=30 → 1. A sign-only comparison would also pass for "always return 1".
  const allSimple = recommendNForSamples(['x', 'y', 'z']);
  assert.equal(allSimple, 16);
  const oneComplex = recommendNForSamples(['x', 'y', '\\sum_{i=0}^{n} \\frac{x_i^2}{\\sigma^2} \\cdot \\int_0^\\infty f(x)\\,dx']);
  assert.equal(oneComplex, 1, 'one complex formula in the batch lowers the threshold for the whole batch');
  assert.equal(recommendNForSamples(['x'], { H: 0.9 }), 166, 'H is forwarded: floor(50 / (3 * 0.1)) = 166');
});

test('recommendNForSamples: empty formula list is the "always offload" sentinel', () => {
  // No formulas → maxR 0 → the epsilon-denominator branch, i.e. an effectively
  // infinite threshold. Pinned exactly so a regression that offloads every
  // message shows up as a number change instead of still satisfying ">= 1".
  assert.equal(recommendNForSamples([]), 50_000_000);
  assert.equal(recommendNForSamples([], { B: 100 }), 100_000_000, 'budget scales linearly');
});
