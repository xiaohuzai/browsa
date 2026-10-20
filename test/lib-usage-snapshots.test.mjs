// test/lib-usage-snapshots.test.mjs — per-turn deltas for session-cumulative
// providers (Hermes). The provider reports session totals; browsa persists the
// last snapshot and subtracts it so the bubble shows this turn's numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorageArea } from './helpers/chrome-mock.mjs';

globalThis.chrome = { storage: { local: makeStorageArea() } };

const { subtractUsage } = await import('../lib/usage.js');
const { takeTurnUsage } = await import('../lib/usage-snapshots.js');

test('subtractUsage: first snapshot (new session) is the turn usage', () => {
  assert.deepEqual(
    subtractUsage(null, { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60 }),
    { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60 },
  );
});

test('subtractUsage: normal cumulative delta', () => {
  assert.deepEqual(
    subtractUsage(
      { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 60, cache_write_tokens: 5 },
      { input_tokens: 260, output_tokens: 70, total_tokens: 330, cache_read_tokens: 160, cache_write_tokens: 8 },
    ),
    { input_tokens: 160, output_tokens: 50, total_tokens: 210, cache_read_tokens: 100, cache_write_tokens: 3 },
  );
});

test('subtractUsage: counters going down means a server-side reset → use the snapshot whole', () => {
  assert.deepEqual(
    subtractUsage(
      { input_tokens: 5000, output_tokens: 900, cache_read_tokens: 3000 },
      { input_tokens: 120, output_tokens: 30, cache_read_tokens: 80 },
    ),
    { input_tokens: 120, output_tokens: 30, cache_read_tokens: 80 },
  );
});

test('takeTurnUsage: a resumed session with no baseline hides one turn, then deltas', async () => {
  const hidden = await takeTurnUsage(
    'hermes:ctx-upgrade',
    { input_tokens: 900, output_tokens: 300, cache_read_tokens: 0 },
    { allowFirstAsWhole: false },
  );
  assert.equal(hidden, null, 'never show the session total on an unknown baseline');
  const next = await takeTurnUsage(
    'hermes:ctx-upgrade',
    { input_tokens: 1100, output_tokens: 380, cache_read_tokens: 0 },
    { allowFirstAsWhole: false },
  );
  assert.deepEqual(next, { input_tokens: 200, output_tokens: 80, cache_read_tokens: 0 });
});

test('takeTurnUsage: session-authority per-turn snapshots (no cache keys) are passed through', async () => {
  // Hermes's run_turn_runner stores per-turn {input/output/total} with no cache
  // keys; subtracting that again would corrupt it.
  const u = { input_tokens: 500, output_tokens: 80, total_tokens: 580 };
  assert.deepEqual(await takeTurnUsage('hermes:authority', u), u);
  // No baseline was stored, so a later cumulative snapshot is treated as unknown.
  assert.equal(
    await takeTurnUsage(
      'hermes:authority',
      { input_tokens: 900, output_tokens: 120, cache_read_tokens: 400 },
      { allowFirstAsWhole: false },
    ),
    null,
  );
});

test('takeTurnUsage: persists the baseline and returns per-turn deltas', async () => {
  const first = await takeTurnUsage('hermes:ctx-1', {
    input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 60, cache_write_tokens: 2,
  });
  assert.deepEqual(first, {
    input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 60, cache_write_tokens: 2,
  });

  const second = await takeTurnUsage('hermes:ctx-1', {
    input_tokens: 260, output_tokens: 70, total_tokens: 330, cache_read_tokens: 160, cache_write_tokens: 5,
  });
  assert.deepEqual(second, {
    input_tokens: 160, output_tokens: 50, total_tokens: 210, cache_read_tokens: 100, cache_write_tokens: 3,
  });

  // Independent conversations have independent baselines.
  const other = await takeTurnUsage('hermes:ctx-2', { input_tokens: 40, output_tokens: 10, cache_read_tokens: 0 });
  assert.deepEqual(other, { input_tokens: 40, output_tokens: 10, cache_read_tokens: 0 });

  // A reset session is reported whole, then its new baseline takes over.
  const reset = await takeTurnUsage('hermes:ctx-1', { input_tokens: 7, output_tokens: 3, cache_read_tokens: 0 });
  assert.deepEqual(reset, { input_tokens: 7, output_tokens: 3, cache_read_tokens: 0 });
  const afterReset = await takeTurnUsage('hermes:ctx-1', { input_tokens: 20, output_tokens: 9, cache_read_tokens: 0 });
  assert.deepEqual(afterReset, { input_tokens: 13, output_tokens: 6, cache_read_tokens: 0 });
});
