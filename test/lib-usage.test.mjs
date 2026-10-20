// test/lib-usage.test.mjs — provider usage normalization + token-chip model.
// The chip used to know only prompt/completion; cache hit rates arrive in a
// different field per protocol (OpenAI prompt_tokens_details, DeepSeek
// prompt_cache_hit_tokens, Anthropic cache_read_input_tokens) and were
// silently dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, mergeUsage, usageChipModel } from '../lib/usage.js';

test('normalizeUsage: OpenAI chat-completions cached_tokens', () => {
  const u = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 800 },
  });
  assert.equal(u.prompt, 1000);
  assert.equal(u.completion, 100);
  assert.equal(u.total, 1100);
  assert.equal(u.cached, 800);
  assert.equal(u.cacheRate, 0.8);
});

test('normalizeUsage: DeepSeek prompt_cache_hit_tokens (subset of prompt_tokens)', () => {
  const u = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 50,
    prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400,
  });
  assert.equal(u.prompt, 1000, 'hit+miss must not be added on top of prompt_tokens');
  assert.equal(u.cached, 600);
  assert.equal(u.cacheRate, 0.6);
});

test('normalizeUsage: Anthropic input_tokens excludes cache read/write', () => {
  const u = normalizeUsage({
    input_tokens: 200, output_tokens: 50,
    cache_read_input_tokens: 800, cache_creation_input_tokens: 100,
  });
  assert.equal(u.prompt, 1100, 'total prompt = input + cache read + cache write');
  assert.equal(u.cached, 800);
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.total, 1150);
  assert.ok(Math.abs(u.cacheRate - 800 / 1100) < 1e-9);
});

test('normalizeUsage: Responses input_tokens_details.cached_tokens', () => {
  const u = normalizeUsage({
    input_tokens: 1000, output_tokens: 50,
    input_tokens_details: { cached_tokens: 400 },
  });
  assert.equal(u.prompt, 1000);
  assert.equal(u.cached, 400);
  assert.equal(u.cacheRate, 0.4);
  assert.equal(u.total, 1050);
});

test('normalizeUsage: Hermes-style input_tokens EXCLUDES cache read/write', () => {
  // Hermes CanonicalUsage: input_tokens is non-cached; prompt_tokens is the
  // derived total (not serialized on every path), so the client adds them.
  const u = normalizeUsage({
    input_tokens: 200, output_tokens: 50, total_tokens: 1150,
    cache_read_tokens: 800, cache_write_tokens: 100,
  });
  assert.equal(u.prompt, 1100);
  assert.equal(u.cached, 800);
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.total, 1150);
  assert.ok(Math.abs(u.cacheRate - 800 / 1100) < 1e-9);
});

test('normalizeUsage: an inclusive input_tokens shape is detected by total_tokens', () => {
  // OpenSquilla rows: input_tokens is the normalized TOTAL and already
  // includes cache; adding the cache bucket again would double-count.
  const u = normalizeUsage({
    input_tokens: 1000, output_tokens: 100, total_tokens: 1100,
    cache_read_tokens: 800,
  });
  assert.equal(u.prompt, 1000);
  assert.equal(u.cached, 800);
  assert.equal(u.cacheRate, 0.8);
});

test('normalizeUsage: agent-bridge/OpenSquilla inclusive prompt_tokens + top-level cached_tokens', () => {
  const u = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 50,
    cached_tokens: 800, cache_write_tokens: 100,
  });
  assert.equal(u.prompt, 1000, 'inclusive prompt_tokens must not add the cache buckets again');
  assert.equal(u.cached, 800);
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.cacheRate, 0.8);
});

test('normalizeUsage: Hermes prompt_tokens (when present) wins over the exclusive derivation', () => {
  const u = normalizeUsage({
    prompt_tokens: 1100, input_tokens: 200, output_tokens: 50,
    cache_read_tokens: 800, cache_write_tokens: 100,
  });
  assert.equal(u.prompt, 1100);
  assert.equal(u.cacheRate, 800 / 1100);
});

test('normalizeUsage: Hermes-style usage has no cache fields', () => {
  const u = normalizeUsage({ input_tokens: 100, output_tokens: 20 });
  assert.equal(u.prompt, 100);
  assert.equal(u.completion, 20);
  assert.equal(u.cached, null);
  assert.equal(u.cacheRate, null);
  assert.equal(u.total, 120);
});

test('normalizeUsage: garbage / empty input returns null', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage(undefined), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ foo: 1 }), null);
});

test('mergeUsage: sums continuation legs including nested cache details', () => {
  const a = {
    prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 800 },
  };
  const b = {
    prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400,
    prompt_tokens_details: { cached_tokens: 1000 },
  };
  const m = mergeUsage(a, b);
  assert.equal(m.prompt_tokens, 2200);
  assert.equal(m.completion_tokens, 300);
  assert.equal(m.total_tokens, 2500);
  assert.equal(m.prompt_tokens_details.cached_tokens, 1800,
    'the old inline merge only summed top-level numbers and dropped this');
  assert.equal(normalizeUsage(m).cacheRate, 1800 / 2200);
});

test('mergeUsage: anthropic cache fields sum; null-safe both ways', () => {
  const m = mergeUsage(
    { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 },
    { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 },
  );
  assert.equal(m.input_tokens, 300);
  assert.equal(m.cache_read_input_tokens, 1100);
  assert.equal(m.cache_creation_input_tokens, 50);
  assert.deepEqual(mergeUsage(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeUsage({ a: 1 }, null), { a: 1 });
});

test('usageChipModel: provider numbers + cache hit rate + a turn-scoped decode rate', () => {
  const m = usageChipModel({
    prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100,
    prompt_tokens_details: { cached_tokens: 1600 },
  }, 'turn', 2000);
  assert.match(m.text, /↑ 2\.0k/);
  assert.match(m.text, /↓ 100/);
  assert.match(m.text, /cache 80%/);
  assert.match(m.text, /50 t\/s/); // 100 completion / 2s — this turn's tokens only
  assert.match(m.text, /2\.0s/);
  assert.match(m.title, /Cached: 1600 \(80%\)/);
  assert.match(m.title, /this turn's completion/);
  assert.match(m.title, /Generation time: 2\.00s \(first token → done\)/);
});

test('usageChipModel: cumulative channels render NO chip at all', () => {
  assert.equal(usageChipModel({
    input_tokens: 20000, output_tokens: 3400, cache_read_tokens: 100000,
  }, 'session', 2000), null, 'session totals (even cache %) must not be displayed');
  assert.equal(usageChipModel({ input_tokens: 20000, output_tokens: 3400 }, 'session', 2000), null);
});

test('usageChipModel: an all-zero usage produces no chip (lagging counters)', () => {
  assert.equal(usageChipModel({ prompt_tokens: 0, completion_tokens: 0 }), null);
  assert.equal(usageChipModel({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }, 'turn', 2000), null);
});

test('usageChipModel: no cache fields -> no cache fragment (no fake 0%)', () => {
  const m = usageChipModel({ input_tokens: 500, output_tokens: 50 });
  assert.ok(!m.text.includes('cache'), 'providers without cache telemetry must not show a rate');
  assert.equal(m.title, 'Prompt: 500 · Completion: 50 · Total: 550');
});

test('usageChipModel: a real 0 cached value still renders 0%', () => {
  const m = usageChipModel({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
  assert.match(m.text, /cache 0%/);
});
