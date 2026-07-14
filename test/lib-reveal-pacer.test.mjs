// test/lib-reveal-pacer.test.mjs — execution tests for lib/sidepanel/reveal-pacer.js,
// a thin wrapper around markstream-core's createSmoothMarkdownStream used to
// smooth bursty streaming deltas before they reach the render pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// markstream-core's controller falls back to a synchronous flush() when
// requestAnimationFrame isn't a function (see smooth-stream-controller.ts's
// ensureLoop) — polyfill it so pacing actually paces in this test env.
// Unlike the other lib/sidepanel/*.test.mjs files' rAF polyfills (which only
// need to fire, not carry a real timestamp), markstream-core's tick() does
// real arithmetic on the timestamp it's called with — an undefined
// timestamp makes several of its calculations evaluate to NaN, which (via
// NaN's "always false" comparisons) breaks its per-tick char-count cap
// entirely and reveals everything in one tick. Must pass a real clock value.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { createRevealPacer } = await import('../lib/sidepanel/reveal-pacer.js');

test('createRevealPacer: enqueueing a large chunk does not necessarily reveal it all synchronously', () => {
  let revealed = '';
  const pacer = createRevealPacer((delta) => { revealed += delta; });
  pacer.enqueue('a'.repeat(5000));
  // Paced reveal happens via rAF callbacks, not synchronously within enqueue().
  assert.equal(revealed, '');
  pacer.destroy();
});

test('createRevealPacer: eventually reveals everything enqueued if never destroyed', async () => {
  let revealed = '';
  const pacer = createRevealPacer((delta) => { revealed += delta; });
  const text = 'hello world, this is a streamed reply.';
  pacer.enqueue(text);
  // Default minCharsPerSecond is 40 — a 39-char string needs ~1s at the
  // slowest, plus startDelayMs(80ms); give it comfortable headroom.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(revealed, text);
  pacer.destroy();
});

test('createRevealPacer: destroy() stops further onReveal calls', async () => {
  let revealed = '';
  const pacer = createRevealPacer((delta) => { revealed += delta; });
  pacer.enqueue('a'.repeat(5000));
  await new Promise((r) => setTimeout(r, 20)); // let a partial reveal happen
  const revealedAtDestroy = revealed;
  assert.ok(revealedAtDestroy.length < 5000, 'should not have fully caught up yet at 20ms with default pacing');
  pacer.destroy();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(revealed, revealedAtDestroy, 'no further reveals should land after destroy()');
});

test('createRevealPacer: multiple enqueue() calls concatenate in order', async () => {
  let revealed = '';
  const pacer = createRevealPacer((delta) => { revealed += delta; });
  pacer.enqueue('hello ');
  pacer.enqueue('world');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(revealed, 'hello world');
  pacer.destroy();
});
