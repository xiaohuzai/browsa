// test/lib-katex-worker-script.test.mjs — execution test for the actual
// lib/sidepanel/katex.worker.js script (not a mock). Every other katex
// worker test (test/lib-katex-worker-client.test.mjs) mocks globalThis.Worker
// entirely, so this file's own message-handler logic — the code that
// genuinely runs inside the real Worker in production — had zero direct
// execution coverage until now.
//
// Worker scripts use `self.addEventListener`/`self.postMessage`, not
// `globalThis.*` — define `self` before importing so the top-level
// `self.addEventListener('message', ...)` registration in the real file
// actually attaches to something we can drive and observe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
const posted = [];
globalThis.self = {
  addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  postMessage: (data) => { posted.push(data); },
};

await import('../lib/sidepanel/katex.worker.js');

function dispatch(jobs) {
  posted.length = 0;
  for (const fn of listeners) fn({ data: { jobs } });
  return posted[0];
}

test('katex.worker.js registers exactly one message listener on import', () => {
  assert.equal(listeners.length, 1);
});

test('katex.worker.js renders a batch of formulas and posts back one message with all results', () => {
  const response = dispatch([
    { id: 0, formula: 'x^2', displayMode: false },
    { id: 1, formula: 'y^2', displayMode: true },
  ]);
  assert.ok(response);
  assert.equal(response.jobs.length, 2);
  assert.equal(response.jobs[0].id, 0);
  assert.match(response.jobs[0].html, /<math/, 'must be real KaTeX MathML output');
  assert.equal(response.jobs[1].id, 1);
  assert.match(response.jobs[1].html, /<math/);
});

test('katex.worker.js reports a per-job error without failing the whole batch', () => {
  // KaTeX's throwOnError:false (used here, matching render.js's sync path)
  // renders malformed LaTeX as inline error markup rather than throwing —
  // it only actually throws for inputs it can't process at all, like a
  // non-string formula. That's the realistic case this handler's catch is
  // guarding against (e.g. a malformed job object slipping through).
  const response = dispatch([
    { id: 0, formula: 'x^2', displayMode: false },
    { id: 1, formula: null, displayMode: false },
    { id: 2, formula: 'z^2', displayMode: false },
  ]);
  assert.equal(response.jobs.length, 3);
  assert.ok(response.jobs[0].html, 'job 0 (valid formula) must still succeed');
  assert.ok(response.jobs[1].error, 'job 1 (non-string formula) must report an error, not throw out of the handler');
  assert.equal(response.jobs[1].html, undefined);
  assert.ok(response.jobs[2].html, 'job 2 (valid formula) must still succeed despite job 1 failing');
});

test('katex.worker.js handles an empty jobs array without throwing', () => {
  const response = dispatch([]);
  assert.deepEqual(response.jobs, []);
});

test('katex.worker.js tolerates a message with no jobs field at all', () => {
  posted.length = 0;
  for (const fn of listeners) fn({ data: {} });
  assert.deepEqual(posted[0].jobs, []);
});
