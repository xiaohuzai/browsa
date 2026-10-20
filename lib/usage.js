// lib/usage.js — provider usage vocabularies in one place.
//
// Every protocol reports token counts differently:
//   chat/completions  { prompt_tokens, completion_tokens, total_tokens,
//                       prompt_tokens_details.cached_tokens }        (OpenAI)
//                     { prompt_cache_hit_tokens, prompt_cache_miss_tokens } (DeepSeek)
//   responses         { input_tokens, output_tokens,
//                       input_tokens_details.cached_tokens }
//   anthropic         { input_tokens, output_tokens, cache_read_input_tokens,
//                       cache_creation_input_tokens }   ← input_tokens EXCLUDES cache *
//   Hermes runs       { input_tokens, output_tokens, cache_read_tokens,
//                       cache_write_tokens }            ← input_tokens EXCLUDES cache
//   agent-bridge      { prompt_tokens, completion_tokens, cached_tokens?,
//                       cache_write_tokens? }           ← prompt_tokens INCLUDES cache
//   opencode          (mapped by lib/opencode-client.js from tokens.cache.read/write)
//   OpenSquilla       (mapped by lib/squilla-client.js from usage.status rows)
//
// normalizeUsage() maps all of them to { prompt, completion, total, cached,
// cacheWrite, cacheRate } so the token chip can show a cache hit rate on every
// channel that reports one. cacheRate is cached / total prompt tokens
// (0..1), where "total prompt" for Anthropic adds cache read + cache write
// back to input_tokens. mergeUsage() sums the two legs of a continuation turn
// (including the nested *_details objects the old inline merge dropped).

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const completion = num(usage.completion_tokens) ?? num(usage.output_tokens);
  const cacheRead = num(usage.prompt_cache_hit_tokens)
    ?? num(usage.prompt_tokens_details?.cached_tokens)
    ?? num(usage.input_tokens_details?.cached_tokens)
    ?? num(usage.cache_read_input_tokens)
    ?? num(usage.cached_tokens)          // agent-bridge (top-level subset)
    ?? num(usage.cache_read_tokens);     // Hermes / OpenSquilla rows
  const cacheWrite = num(usage.cache_creation_input_tokens)
    ?? num(usage.cache_write_tokens);    // Hermes / agent-bridge
  // Exclusive-input shapes report input_tokens as the NON-cached prompt:
  //   Anthropic  {input_tokens, cache_read_input_tokens, cache_creation_input_tokens}
  //   Hermes     {input_tokens, cache_read_tokens, cache_write_tokens}
  // OpenAI-style prompt_tokens (and the squilla client's explicit mapping of
  // OpenSquilla's INCLUSIVE input_tokens) already include the cache buckets.
  // The presence of prompt_tokens disambiguates; only add when it is absent.
  // A provided total_tokens settles ambiguous raw shapes: if adding the cache
  // buckets would overshoot total_tokens - completion_tokens, the input was
  // already inclusive (OpenSquilla rows), so do not add again.
  const totalNum = num(usage.total_tokens);
  const flatCacheRead = num(usage.cache_read_input_tokens) ?? num(usage.cache_read_tokens);
  const flatCacheWrite = num(usage.cache_creation_input_tokens) ?? num(usage.cache_write_tokens);
  const inclusiveByTotal = totalNum != null && input != null && completion != null
    && input + (flatCacheRead ?? 0) + (flatCacheWrite ?? 0) > totalNum - completion;
  const exclusiveInput = num(usage.prompt_tokens) == null
    && !inclusiveByTotal
    && (num(usage.cache_read_input_tokens) != null
      || num(usage.cache_creation_input_tokens) != null
      || num(usage.cache_read_tokens) != null
      || num(usage.cache_write_tokens) != null);
  const prompt = (input != null && exclusiveInput)
    ? input
      + (num(usage.cache_read_input_tokens) ?? num(usage.cache_read_tokens) ?? 0)
      + (num(usage.cache_creation_input_tokens) ?? num(usage.cache_write_tokens) ?? 0)
    : input;
  const total = num(usage.total_tokens)
    ?? (prompt != null && completion != null ? prompt + completion : null);
  if (prompt == null && completion == null && total == null) return null;
  const cacheRate = (cacheRead != null && prompt != null && prompt > 0)
    ? Math.min(1, Math.max(0, cacheRead / prompt))
    : null;
  return { prompt, completion, total, cached: cacheRead, cacheWrite, cacheRate };
}

/** Sum two usage objects (continuation legs), recursing into nested detail
 * objects so cached-token counts are added too. Null-safe both ways. */
export function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v == null) continue;
    if (typeof v === 'number' && typeof out[k] === 'number') out[k] = out[k] + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeUsage(out[k] || {}, v);
    else if (out[k] == null) out[k] = v;
  }
  return out;
}

/**
 * Turn a provider's SESSION-CUMULATIVE usage into this turn's delta.
 * Used by Hermes (`session_*` counters) so the bubble shows per-turn numbers
 * instead of the growing session total. `prev == null` (first turn of a new
 * session) treats the snapshot as the turn's usage. A decrease in any primary
 * counter means the server started a new session / reset its counters, so the
 * snapshot is used whole.
 */
const CUMULATIVE_KEYS = [
  'input_tokens', 'output_tokens', 'total_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'prompt_tokens', 'completion_tokens',
];
const PRIMARY_CUMULATIVE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

export function subtractUsage(prev, curr) {
  if (!curr || typeof curr !== 'object') return null;
  if (!prev || typeof prev !== 'object') return { ...curr };
  const reset = PRIMARY_CUMULATIVE_KEYS.some((k) =>
    typeof curr[k] === 'number' && typeof prev[k] === 'number' && curr[k] < prev[k]);
  if (reset) return { ...curr };
  const out = { ...curr };
  for (const k of CUMULATIVE_KEYS) {
    if (typeof curr[k] !== 'number') continue;
    out[k] = Math.max(0, curr[k] - (typeof prev[k] === 'number' ? prev[k] : 0));
  }
  return out;
}

/** Pure chip model — text + tooltip for buildUsageChip(). Kept DOM-free so the
 * display math (fmtK / cache % / t/s) is unit-testable.
 *
 * `scope === 'session'` is a safety net: callers convert cumulative snapshots
 * into per-turn deltas first (lib/usage-snapshots.js for Hermes, before/after
 * usage.status for OpenSquilla), so this branch should not normally trigger —
 * if it does, show NOTHING rather than a conversation total.
 * t/s = this turn's completion_tokens ÷ (first-token → DONE window); the
 * duration is a client-measured generation window, labelled as such in the
 * tooltip. */
export function usageChipModel(usage, scope = 'turn', durationMs = 0) {
  if (scope === 'session') return null;
  const u = normalizeUsage(usage);
  if (!u || (u.prompt == null && u.completion == null)) return null;
  // A delta that came back all-zero usually means the provider had not
  // persisted the counters yet (OpenSquilla) or the run recorded nothing.
  // Showing "↑0 · ↓0" is worse than showing nothing.
  if ((u.prompt == null || u.prompt === 0) && (u.completion == null || u.completion === 0)) return null;
  const dur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const tps = (dur > 200 && u.completion > 0)
    ? Math.round(u.completion / (dur / 1000)) : 0;
  const durationSec = dur > 0 ? (dur / 1000).toFixed(1) : null;
  const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  // One decimal: rounding 99.6 → 100% reads as "fully cached" when it is not.
  const fmtCachePct = (rate) => `${(rate * 100).toFixed(1)}%`;
  const parts = [];
  if (u.prompt != null) parts.push(`↑ ${fmtK(u.prompt)}`);
  if (u.completion != null) parts.push(`↓ ${fmtK(u.completion)}`);
  if (u.cacheRate != null) parts.push(`cache ${fmtCachePct(u.cacheRate)}`);
  if (tps > 0) parts.push(`${tps} t/s`);
  if (durationSec) parts.push(`${durationSec}s`);
  const title = `Prompt: ${u.prompt ?? '?'} · Completion: ${u.completion ?? '?'}`
    + (u.total != null ? ` · Total: ${u.total}` : '')
    + (u.cached != null ? ` · Cached: ${u.cached}${u.cacheRate != null ? ` (${fmtCachePct(u.cacheRate)})` : ''}` : '')
    + (u.cacheWrite ? ` · Cache write: ${u.cacheWrite}` : '')
    + (tps ? ` · ${tps} tok/s (this turn's completion)` : '')
    + (dur ? ` · Generation time: ${(dur / 1000).toFixed(2)}s (first token → done)` : '');
  return { text: parts.join(' · '), title };
}
