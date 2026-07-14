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

test('defaultRByClass returns increasing ms budgets for increasing complexity', () => {
  assert.ok(defaultRByClass('simple') < defaultRByClass('medium'));
  assert.ok(defaultRByClass('medium') < defaultRByClass('complex'));
});

test('recommendWorkerThreshold: higher per-formula cost yields a lower formula-count threshold', () => {
  const cheap = recommendWorkerThreshold({ R: 3 });
  const expensive = recommendWorkerThreshold({ R: 30 });
  assert.ok(cheap > expensive);
  assert.ok(expensive >= 1, 'threshold must never go below 1');
});

test('recommendWorkerThreshold: a higher cache hit rate raises the threshold', () => {
  const noCaching = recommendWorkerThreshold({ R: 10, H: 0 });
  const heavyCaching = recommendWorkerThreshold({ R: 10, H: 0.9 });
  assert.ok(heavyCaching > noCaching);
});

test('recommendNForSamples: takes the worst (max R) complexity among mixed formulas', () => {
  const allSimple = recommendNForSamples(['x', 'y', 'z']);
  const oneComplex = recommendNForSamples(['x', 'y', '\\sum_{i=0}^{n} \\frac{x_i^2}{\\sigma^2} \\cdot \\int_0^\\infty f(x)\\,dx']);
  assert.ok(oneComplex < allSimple, 'one complex formula in the batch should lower the threshold for the whole batch');
});

test('recommendNForSamples: empty formula list does not throw and returns a sane default', () => {
  assert.doesNotThrow(() => recommendNForSamples([]));
  assert.ok(recommendNForSamples([]) >= 1);
});
