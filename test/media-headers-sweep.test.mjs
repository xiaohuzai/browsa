// test/media-headers-sweep.test.mjs — DNR session-rule cleanup.
//
// Regression (2026-10-21 release audit): the sweep ran on EVERY service-worker
// module evaluation. The media rules belong to the side panel, which can be
// mid-download while an unrelated navigation/alarm wakes the worker — deleting
// a live rule turned the next CDN request into a 403. Sweeping is now limited
// to safe points (browser startup/install, or the last panel disconnecting),
// and must cover every deterministic browsa-owned id (including the page-image
// referer rule the SW itself registers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('sweep removes every browsa-owned DNR id and nothing else', async () => {
  let removed = null;
  globalThis.chrome = {
    declarativeNetRequest: {
      getSessionRules: async () => [
        { id: 9000001 }, { id: 9000002 }, { id: 9000003 }, { id: 42 },
      ],
      updateSessionRules: async ({ removeRuleIds }) => { removed = removeRuleIds; },
    },
  };
  const { sweepOrphanedMediaRules, MEDIA_RULE_IDS } = await import('../lib/sidepanel/media-headers.js');
  await sweepOrphanedMediaRules();
  assert.deepEqual(
    [...removed].sort((a, b) => a - b),
    [9000001, MEDIA_RULE_IDS.youtube, MEDIA_RULE_IDS.bilibili].sort((a, b) => a - b),
    'all three deterministic ids are swept'
  );
  assert.ok(!removed.includes(42), 'foreign rules must never be touched');
});

test('wiring pins: sweep only at safe points; xiaoyuzhou never removes the bilibili rule', async () => {
  const bg = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bg, /^sweepOrphanedMediaRules\(\)\.catch/m,
    'never sweep on every SW module evaluation');
  assert.match(bg, /chrome\.runtime\.onStartup\?\.addListener/,
    'browser startup is a safe sweep point');
  assert.match(bg, /chrome\.runtime\.onInstalled\.addListener\(\(details\) => \{[\s\S]{0,400}sweepOrphanedMediaRules/,
    'install/update is a safe sweep point');
  assert.match(bg, /sweepDnrIfNoPanels\(\)/,
    'the last panel disconnect is the in-session safe point');

  const orch = await readFile(
    new URL('../lib/sidepanel/attach-orchestrator.js', import.meta.url), 'utf8');
  assert.match(orch, /platform === 'bilibili' \? MEDIA_RULE_IDS\.bilibili\s*:\s*null/,
    'xiaoyuzhou must map to no rule id');
  assert.match(orch, /if \(dnrRuleId !== null\) await removeMediaHeaders\(dnrRuleId\)/,
    'the finally must only remove a rule this call registered');
});
