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
//   Hermes runs       { input_tokens, output_tokens } (no cache fields today)
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
    ?? num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  // Anthropic is the one protocol whose input_tokens excludes cached tokens;
  // OpenAI-style prompt_tokens/input_tokens already include them.
  const anthropicShape = num(usage.cache_read_input_tokens) != null || cacheWrite != null;
  const prompt = (input != null && anthropicShape)
    ? input + (num(usage.cache_read_input_tokens) ?? 0) + (cacheWrite ?? 0)
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

/** Pure chip model — text + tooltip + timing for buildUsageChip(). Kept DOM-free
 * so the display math (fmtK / t/s / cache %) is unit-testable. */
export function usageChipModel(usage, startedAtMs, nowMs = Date.now()) {
  const u = normalizeUsage(usage);
  if (!u || (u.prompt == null && u.completion == null)) return null;
  const durationMs = startedAtMs ? Math.max(0, nowMs - startedAtMs) : 0;
  const tps = (durationMs > 200 && u.completion > 0)
    ? Math.round(u.completion / (durationMs / 1000)) : 0;
  const durationSec = durationMs > 0 ? (durationMs / 1000).toFixed(1) : null;
  const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const parts = [];
  if (u.prompt != null) parts.push(`↑ ${fmtK(u.prompt)}`);
  if (u.completion != null) parts.push(`↓ ${fmtK(u.completion)}`);
  if (u.cacheRate != null) parts.push(`cache ${Math.round(u.cacheRate * 100)}%`);
  if (tps > 0) parts.push(`${tps} t/s`);
  if (durationSec) parts.push(`${durationSec}s`);
  const title = `Prompt: ${u.prompt ?? '?'} · Completion: ${u.completion ?? '?'}`
    + (u.total != null ? ` · Total: ${u.total}` : '')
    + (u.cached != null ? ` · Cached: ${u.cached}${u.cacheRate != null ? ` (${Math.round(u.cacheRate * 100)}%)` : ''}` : '')
    + (u.cacheWrite ? ` · Cache write: ${u.cacheWrite}` : '')
    + (tps ? ` · ${tps} tok/s` : '')
    + (durationMs ? ` · ${(durationMs / 1000).toFixed(2)}s` : '');
  return { text: parts.join(' · '), title, tps, durationMs };
}
