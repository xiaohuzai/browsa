// test/lib-attach-modes.test.mjs — the attach-mode capability table's
// internal consistency. The table (lib/attach-modes.js) replaced five inline
// .includes lists in background.js's ATTACH_PAGE plus the cross-file
// deferred-dispatch duplication (background early-returns + sidepanel
// orchestrator both read the same DEFERRED_HANDOFFS rows) — these tests pin
// the invariants a new mode row must satisfy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACH_MODE_CAPS, DEFERRED_HANDOFFS, modeCaps } from '../lib/attach-modes.js';

const KNOWN_CAPS = new Set(['deepExtract', 'siteInstructions', 'inlineImages', 'skipChangeTracking', 'video', 'deferred']);

test('capability rows only declare known capabilities', () => {
  for (const [mode, caps] of Object.entries(ATTACH_MODE_CAPS)) {
    for (const key of Object.keys(caps)) {
      assert.ok(KNOWN_CAPS.has(key), `${mode} declares unknown capability "${key}"`);
    }
  }
});

test('deferred rows: DEFERRED_HANDOFFS and ATTACH_MODE_CAPS agree on (mode, field, confirm)', () => {
  for (const h of DEFERRED_HANDOFFS) {
    const caps = ATTACH_MODE_CAPS[h.mode];
    assert.ok(caps, `${h.mode} appears in DEFERRED_HANDOFFS without a capability row`);
    assert.ok(caps.deferred, `${h.mode} handoff row lacks a deferred descriptor`);
    assert.equal(caps.deferred.field, h.field, `${h.mode}: field mismatch between table and handoff list`);
    assert.equal(caps.deferred.confirm, h.confirm, `${h.mode}: confirm mismatch between table and handoff list`);
    assert.ok(h.confirm.startsWith('ATTACH_') && h.confirm.endsWith('_CONFIRM'), `${h.confirm} is not a confirm message type`);
  }
  // The handoff list is the dispatch order — screenshot first (mirrors the
  // original if-chain), no duplicate modes.
  assert.equal(DEFERRED_HANDOFFS[0].mode, 'screenshot');
  const modes = DEFERRED_HANDOFFS.map((h) => h.mode);
  assert.equal(new Set(modes).size, modes.length, 'no duplicate deferred modes');
});

test('generic modes keep their historical capability sets (regression pins for the five old inline lists)', () => {
  // Deep-extract + site-instructions used to be ['reader','dom','full','auto'].
  for (const m of ['reader', 'dom', 'full', 'auto']) {
    assert.ok(modeCaps(m).deepExtract, `${m} must keep deepExtract`);
    assert.ok(modeCaps(m).siteInstructions, `${m} must keep siteInstructions`);
  }
  // Image inlining used to be ['reader','auto','jina'] (dom/full are tree
  // text, selected is an excerpt).
  assert.deepEqual(
    Object.keys(ATTACH_MODE_CAPS).filter((m) => modeCaps(m).inlineImages).sort(),
    ['auto', 'jina', 'reader'],
  );
  // Video note + videoSrc used to be mode === 'youtube' || 'bilibili'.
  assert.deepEqual(
    Object.keys(ATTACH_MODE_CAPS).filter((m) => modeCaps(m).video).sort(),
    ['bilibili', 'youtube'],
  );
  // Change-tracker skip list used to be
  // ['selected','pdf-url','office-url','screenshot'].
  assert.deepEqual(
    Object.keys(ATTACH_MODE_CAPS).filter((m) => modeCaps(m).skipChangeTracking).sort(),
    ['office-url', 'pdf-url', 'screenshot', 'selected'],
  );
});

test('modeCaps: unknown modes degrade to an empty capability object', () => {
  assert.deepEqual(modeCaps('github-raw'), {});
  assert.deepEqual(modeCaps(undefined), {});
  assert.deepEqual(modeCaps('asr-pending'), {}, 'asr-pending is behavioral, not a table row');
});
