// test/lib-image-budget.test.mjs — the shared per-turn image limits
// (lib/image-budget.js) and the composer's attach-time gate built on them.
//
// The gate exists because a send-time drop is invisible: the composer clears
// the thumbnail strip the moment a turn starts, so an image refused later (by
// pickTurnImages inside handleChat) leaves the user with no trace at all —
// which reads as "pasting an image does nothing". imageRejectReason lets the
// composer refuse at attach time using the SAME rules, so the thumbnails the
// user sees are exactly the images that ship. The parity test below is the
// guard that the two can never drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AGENT_TURN_MAX_IMAGES,
  AGENT_TURN_IMAGE_BUDGET_CHARS,
  imageRejectReason,
  pickTurnImages,
  isAgentImageUrl,
} from '../lib/image-budget.js';

// Small data-URL-shaped strings — never real images, and never tens of MB:
// the budget is compared against string length, so a padded stub is exact.
const small = 'data:image/png;base64,' + 'A'.repeat(1000);
const half = 'data:image/png;base64,' + 'A'.repeat(AGENT_TURN_IMAGE_BUDGET_CHARS / 2);
const tooBig = 'data:image/png;base64,' + 'A'.repeat(AGENT_TURN_IMAGE_BUDGET_CHARS + 1);

test('imageRejectReason: accepts a fitting image, reports nothing', () => {
  assert.equal(imageRejectReason([], small), null);
  assert.equal(imageRejectReason([small, small], small), null);
});

test('imageRejectReason: count, size and cumulative-budget rejections', () => {
  const full = Array.from({ length: AGENT_TURN_MAX_IMAGES }, () => small);
  assert.equal(imageRejectReason(full, small), 'count', 'the 9th image is over the per-turn cap');
  assert.equal(imageRejectReason([], tooBig), 'size', 'a single over-budget image is refused on its own');
  assert.equal(imageRejectReason([half], half), 'budget', 'the cumulative total is what overflows');
  // Two halves each fit alone; appending is judged per candidate, so a small
  // image after an accepted one is still fine.
  assert.equal(imageRejectReason([], half), null);
  assert.equal(imageRejectReason([small], small), null);
});

test('imageRejectReason: non-image shapes are refused', () => {
  assert.equal(imageRejectReason([], 'javascript:alert(1)'), 'shape');
  assert.equal(imageRejectReason([], ''), 'shape');
  assert.equal(imageRejectReason([], null), 'shape');
  // http(s) is a legitimate carrier (history figures), so it must pass.
  assert.equal(imageRejectReason([], 'https://example.com/a.png'), null);
  assert.ok(isAgentImageUrl('https://example.com/a.png'));
});

test('imageRejectReason mirrors pickTurnImages exactly — attach-time gate cannot drift', () => {
  // Feed the same mixed list through both: attaching one at a time through the
  // gate must keep precisely the images pickTurnImages sends.
  const samples = [small, small, tooBig, half, small, 'not-a-url', half, small, small, small, small, small, 'data:text/plain;base64,QQ=='];
  const kept = [];
  for (const s of samples) {
    if (imageRejectReason(kept, s) === null) kept.push(s);
  }
  assert.deepEqual(kept, pickTurnImages(samples).images);
  assert.ok(kept.length > 0 && kept.length < samples.length, 'the fixture must exercise both keep and drop');
});

test('the composer enforces the gate at attach time (paste / drop / picker all funnel through it)', async () => {
  const src = await readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function handleDroppedFiles'), src.indexOf('function removeImage'));
  assert.match(fn, /imageRejectReason\(images\.map/, 'handleDroppedFiles must consult the shared gate');
  assert.match(fn, /appendError\(imageNotAttachedText\(/, 'and tell the user, visibly, when it refuses');
  // Both refusal wordings must have a dict entry in both locales.
  for (const key of ['imageBudgetExceeded', 'imageCountExceeded']) {
    assert.ok(src.includes(`'${key}'`), `sidepanel must call tSub('${key}', …)`);
  }
  const en = JSON.parse(await readFile(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
  for (const key of ['imageBudgetExceeded', 'imageCountExceeded']) {
    assert.ok(en[key]?.message, `_locales/en must define ${key}`);
    assert.ok(zh[key]?.message, `_locales/zh_CN must define ${key}`);
  }
});
