// lib/usage-snapshots.js — persistent cumulative-usage baselines.
//
// Hermes reports SESSION-CUMULATIVE counters on every run.completed (it has no
// per-turn usage field). To show this reply's numbers we keep the last snapshot
// per browsa conversation and subtract it. The map lives in storage.local (tiny,
// capped) so a service-worker sleep / browser restart does not lose the
// baseline; without it the next turn would show the whole session total.
//
// OpenSquilla has a live usage.status query, so its stream takes before/after
// snapshots inline and does not use this module.

import * as storage from './storage.js';
import { subtractUsage } from './usage.js';

const KEY = 'usageSnapshots';
const CAP = 200;

// Serialize read-modify-write cycles: two tabs/turns can finish concurrently,
// and an interleaved map write would lose the other snapshot.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * Hermes deployments differ:
 *  - native /v1/runs path (`_run_usage(agent)`): session-cumulative, and it
 *    ALWAYS carries cache_read_tokens/cache_write_tokens (0 when unused).
 *  - session-authority path (run_turn_runner): the stored per-admission usage
 *    is already this turn's delta and has only input/output/total tokens.
 * The cache keys are therefore the discriminator: present → cumulative, absent
 * → per-turn (do NOT subtract again).
 */
export function isCumulativeUsage(usage) {
  return Boolean(usage)
    && (typeof usage.cache_read_tokens === 'number' || typeof usage.cache_write_tokens === 'number');
}

/**
 * Compute this turn's delta for a cumulative provider snapshot and persist the
 * new snapshot. `key` identifies the server-side session (stable across turns).
 * Per-turn snapshots (no cache keys) are returned as-is and are NOT stored.
 * `allowFirstAsWhole` is for a genuinely NEW session (no prior assistant turn):
 * the cumulative snapshot then equals this turn's usage. For a resumed session
 * with a missing baseline (e.g. first run after an upgrade), pass false — the
 * turn shows nothing rather than the conversation total, and the baseline is
 * stored for the next turn.
 */
export async function takeTurnUsage(key, cumulative, { allowFirstAsWhole = true } = {}) {
  if (!key || !cumulative || typeof cumulative !== 'object') return null;
  if (!isCumulativeUsage(cumulative)) return { ...cumulative };
  return serial(async () => {
    let map = {};
    try {
      map = (await storage.get(KEY)) || {};
    } catch (_) {
      map = {};
    }
    if (typeof map !== 'object' || Array.isArray(map)) map = {};
    const prev = map[key] || null;
    const delta = prev ? subtractUsage(prev, cumulative) : (allowFirstAsWhole ? { ...cumulative } : null);
    map[key] = cumulative;
    const keys = Object.keys(map);
    if (keys.length > CAP) {
      for (const k of keys.slice(0, keys.length - CAP)) delete map[k];
    }
    try {
      await storage.set(KEY, map);
    } catch (_) {
      // Best-effort: the turn still shows its delta; the next turn falls back
      // to the whole snapshot if the write never lands.
    }
    return delta;
  });
}
