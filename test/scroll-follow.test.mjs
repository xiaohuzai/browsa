// test/scroll-follow.test.mjs — the streaming scroll follower's decisions
// (lib/sidepanel/scroll-follow.js) + the sidepanel.js wiring contract.
//
// Pure-function half: the 150ms active-scroll cooldown, the 80px scrolled-up
// tolerance, and the edge-feather class decisions. jsdom can't simulate
// layout, so the wiring half is a source-contract pin (same style as
// test/scroll-snap.test.mjs): scrollToBottom must gate on shouldFollowStream,
// and the cooldown must be fed by wheel/touch/key input, NOT by the scroll
// event (programmatic scrolls fire that event too — pinning the listener list
// is what keeps the cooldown meaningful).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SCROLL_FOLLOW_COOLDOWN_MS,
  SCROLL_UP_TOLERANCE_PX,
  EDGE_FADE_GUARD_PX,
  shouldFollowStream,
  isUserScrolledUp,
  edgeFadeClasses,
  distanceFromBottom,
} from '../lib/sidepanel/scroll-follow.js';

const geom = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });

test('shouldFollowStream: force always follows, bypassing every gate', () => {
  assert.equal(shouldFollowStream({ force: true, isUserScrolledUp: true, lastUserScrollInputAt: 1000, now: 1001 }), true);
  assert.equal(shouldFollowStream({ force: true, isUserScrolledUp: false, lastUserScrollInputAt: 1000, now: 1001 }), true);
});

test('shouldFollowStream: scrolled up blocks unless forced', () => {
  assert.equal(shouldFollowStream({ isUserScrolledUp: true, lastUserScrollInputAt: -Infinity, now: 99999 }), false);
  assert.equal(shouldFollowStream({ isUserScrolledUp: false, lastUserScrollInputAt: -Infinity, now: 99999 }), true);
});

test('shouldFollowStream: cooldown suppresses follow only inside the 150ms window', () => {
  const base = { isUserScrolledUp: false };
  // user flicked the wheel 100ms ago → hold off
  assert.equal(shouldFollowStream({ ...base, lastUserScrollInputAt: 1000, now: 1000 + SCROLL_FOLLOW_COOLDOWN_MS - 1 }), false);
  // 150ms settled → follow resumes
  assert.equal(shouldFollowStream({ ...base, lastUserScrollInputAt: 1000, now: 1000 + SCROLL_FOLLOW_COOLDOWN_MS }), true);
});

test('shouldFollowStream: -Infinity default means the first follow is never blocked', () => {
  // Fresh document, performance.now() near 0 — the pre-cooldown bug shape.
  assert.equal(shouldFollowStream({ isUserScrolledUp: false, now: 5 }), true);
  assert.equal(shouldFollowStream({ isUserScrolledUp: false }), true);
});

test('isUserScrolledUp keeps the historical 80px threshold (strictly greater)', () => {
  // 1000 content, 300 viewport → max scroll 700; distance 80 == tolerance → NOT up
  assert.equal(isUserScrolledUp(geom(1000, 620, 300)), false);
  // distance 81 → up
  assert.equal(isUserScrolledUp(geom(1000, 619, 300)), true);
  assert.equal(distanceFromBottom(geom(1000, 620, 300)), 80);
  assert.equal(SCROLL_UP_TOLERANCE_PX, 80);
});

test('edgeFadeClasses: feather only the edge you are NOT pinned to', () => {
  // at both edges (short content / fresh open) → no feather at all
  assert.deepEqual(edgeFadeClasses(geom(500, 0, 500)), { fadeT: false, fadeB: false });
  // pinned to bottom → only the top feather
  assert.deepEqual(edgeFadeClasses(geom(2000, 1000, 1000)), { fadeT: true, fadeB: false });
  // pinned to top → only the bottom feather
  assert.deepEqual(edgeFadeClasses(geom(2000, 0, 1000)), { fadeT: false, fadeB: true });
  // middle → both
  assert.deepEqual(edgeFadeClasses(geom(3000, 1000, 1000)), { fadeT: true, fadeB: true });
  // the ±2px guard: distance 2 counts as "at the edge", 3 does not
  assert.deepEqual(edgeFadeClasses(geom(1000, 498, 500)), { fadeT: true, fadeB: false });
  assert.deepEqual(edgeFadeClasses(geom(1000, 495, 500)), { fadeT: true, fadeB: true });
  assert.equal(EDGE_FADE_GUARD_PX, 2);
});

test('wiring contract: sidepanel.js gates scrollToBottom on shouldFollowStream and feeds it real input', async () => {
  const src = await readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');

  assert.match(src, /from '\.\/lib\/sidepanel\/scroll-follow\.js'/,
    'sidepanel.js must import the scroll-follow helpers');

  const fnMatch = src.match(/function scrollToBottom\(force = false\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'scrollToBottom must exist');
  assert.match(fnMatch[1], /shouldFollowStream\(\{ force, isUserScrolledUp, lastUserScrollInputAt, now: performance\.now\(\) \}\)/,
    'scrollToBottom must gate on shouldFollowStream (force gate + 80px gate + 150ms cooldown in one decision)');

  // The cooldown must be fed by REAL input listeners — pinning all three names
  // next to lastUserScrollInputAt proves the mark is not on the scroll event.
  const listenerBlock = src.match(/const markScrollInput = \(\) => \{ lastUserScrollInputAt = performance\.now\(\); \};[^]*?keydown/);
  assert.ok(listenerBlock, 'wheel/touchstart/keydown must mark the cooldown timestamp');
  assert.match(src, /let lastUserScrollInputAt = -Infinity;/,
    'no input yet must mean -Infinity (first follow never blocked by the doc clock)');
});
