// test/lib-reasoning-levels.test.mjs — per-model reasoning-level engine
// (ported from ZCode's modelRules/modelApiRules technique; ADR-0003: the
// technique is portable, the registry is browsa's own).
//
// The invariants that matter:
//  - the LEVEL VOCABULARY follows the model id (toggle vs effort ladders);
//  - the same level becomes different WIRE FIELDS per apiStyle dialect;
//  - 'auto' (and unknown models) send NOTHING — picking a level is opt-in;
//  - a stale per-model pick outside the vocabulary SNAPS to the nearest rung
//    the model speaks (ties go up; 'none' only on an explicit off pick);
//  - provider.reasoningRaw merges last (escape hatch for unknown vendors).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  reasoningSpecFor, reasoningLevelOptions, reasoningLevelsFor, resolveReasoningLevel, reasoningFieldsFor,
  parseReasoningRaw, fitReasoningLevel, REASONING_LADDER,
  VOCAB_TOGGLE, VOCAB_EFFORT3, VOCAB_EFFORT4, VOCAB_EFFORT6,
} = await import('../lib/reasoning-levels.js');

// --------------- vocabulary follows the model id ---------------------------

test('reasoningSpecFor: model id selects its own level vocabulary', () => {
  assert.deepEqual(reasoningSpecFor('glm-5').levels, VOCAB_TOGGLE, 'GLM-class is a {关,开} toggle');
  assert.deepEqual(reasoningSpecFor('gpt-5.6-sol').levels, VOCAB_EFFORT6, 'GPT-5-class speaks the full effort ladder');
  assert.deepEqual(reasoningSpecFor('claude-sonnet-5').levels, VOCAB_EFFORT3, 'Claude-class is a three-level ladder');
  assert.deepEqual(reasoningSpecFor('qwen3.5-plus-2026-01-01').levels, VOCAB_TOGGLE, 'dated suffixed ids still match');
});

// 2026-10-24 audit regression: the qwen3.8 rule sat BEFORE the bare /qwen/
// toggle rule in a last-match-wins table — every qwen3.8-* id also matches
// /qwen/, so the specific rule was fully shadowed (picker showed 开/关 and
// picks sent enable_thinking instead of reasoning_effort). Specific rules
// must come AFTER the broad ones.
test('reasoningSpecFor: qwen3.8 beats the bare /qwen/ toggle rule (rule order)', () => {
  assert.deepEqual(reasoningSpecFor('qwen3.8-max').levels, VOCAB_EFFORT4, 'qwen3.8 speaks the effort ladder, not the toggle');
  assert.deepEqual(reasoningSpecFor('qwen3.8-flash').levels, VOCAB_EFFORT4);
  assert.deepEqual(reasoningSpecFor('qwen3.8-omni-flash').levels, VOCAB_EFFORT4);
  // ...while the rest of the qwen family stays a toggle.
  assert.deepEqual(reasoningSpecFor('qwen3.5-plus').levels, VOCAB_TOGGLE);

  const provider = { reasoningDefault: 'high' };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'qwen3.8-max', apiStyle: 'chat' }),
    { reasoning_effort: 'high' }, 'qwen3.8 chat sends reasoning_effort, not enable_thinking');
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'qwen3.8-max', apiStyle: 'responses' }),
    { reasoning: { effort: 'high' } });
  // A stale toggle-shaped pick snaps to the nearest rung this model speaks
  // (2026-11-09: 就近拟合 replaces the old silent degrade to 'auto' —
  // 'enabled' canonises to 'high').
  assert.equal(resolveReasoningLevel({ reasoningDefault: 'enabled' }, 'qwen3.8-max'), 'high',
    "'enabled' canonises to 'high' and fits the qwen3.8 effort ladder");
  assert.deepEqual(reasoningFieldsFor({ provider: { reasoningDefault: 'enabled' }, modelId: 'qwen3.8-max', apiStyle: 'chat' }),
    { reasoning_effort: 'high' }, 'the fitted level reaches the wire');
});

test('reasoningLevelOptions: unknown model is inert — auto only', () => {
  assert.deepEqual(reasoningLevelOptions('totally-unknown-model'), ['auto']);
  assert.deepEqual(reasoningSpecFor('').levels, []);
});

test('reasoningLevelOptions: auto leads the model vocabulary', () => {
  assert.deepEqual(reasoningLevelOptions('gpt-5.6'), ['auto', ...VOCAB_EFFORT6]);
});

// --------------- nearest-rung fitting ---------------------------------------
// Vocabularies differ per family, so a pick made on one model (or a hand-typed
// alias like 'enabled') can be outside the next model's list. Instead of
// silently sending nothing, the pick snaps to the nearest rung of the one
// canonical ladder — ties go UP (更用力 is the safer reading of an ambiguous
// pick). An off position is only ever reached explicitly.

test('fitReasoningLevel: nearest rung, ties up the ladder, off stays explicit', () => {
  assert.deepEqual(REASONING_LADDER, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(fitReasoningLevel('high', ['disabled', 'enabled']), 'enabled', "'high' is the toggle's on position");
  assert.equal(fitReasoningLevel('xhigh', ['low', 'high', 'max']), 'max', 'tie high/xhigh → the higher rung');
  assert.equal(fitReasoningLevel('medium', ['low', 'high']), 'high', 'tie low/high → the higher rung');
  assert.equal(fitReasoningLevel('max', ['low', 'high', 'max']), 'max', 'an exact hit comes back verbatim');
  assert.equal(fitReasoningLevel('none', ['none', 'high']), 'none', "'none' lands only on an explicit off rung");
  assert.equal(fitReasoningLevel('none', ['low', 'high']), 'auto', 'no off rung in the vocabulary → send nothing');
  assert.equal(fitReasoningLevel('low', ['none']), 'auto', 'off is never a fitting target for a non-off pick');
  assert.equal(fitReasoningLevel('auto', ['low', 'high']), 'auto', "'auto' means send nothing");
  assert.equal(fitReasoningLevel('zzz', ['low']), 'auto', 'a word outside the ladder cannot be fitted');
});

// 2026-11-09 review regression: the alias table was an object literal, so
// inherited keys (constructor/__proto__/toString) read as ladder rungs and a
// free-typed per-model level fitted to 'low' — a real level sent on the wire.
test('fitReasoningLevel: Object.prototype keys are not ladder rungs', () => {
  for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(fitReasoningLevel(word, ['low', 'high']), 'auto', `${word} must not fit to a real rung`);
  }
  assert.equal(resolveReasoningLevel({ reasoningDefault: 'constructor' }, 'gpt-5.6'), 'auto');
  assert.deepEqual(reasoningFieldsFor({
    provider: { reasoningDefault: 'constructor' }, modelId: 'gpt-5.6', apiStyle: 'chat',
  }), null, 'no wire fields may be produced from an inherited key');
});

test('reasoningLevelOptions dedupes an override that names auto or repeats a level', () => {
  assert.deepEqual(reasoningLevelOptions('mystery', { overrideLevels: ['auto', 'low', 'low'] }), ['auto', 'low']);
});

// --------------- level resolution precedence --------------------------------

test('resolveReasoningLevel: per-model pick beats the card default; an explicit auto means send nothing', () => {
  const provider = { reasoningDefault: 'low', reasoningByModel: { 'gpt-5.6': 'high' } };
  assert.equal(resolveReasoningLevel(provider, 'gpt-5.6'), 'high', 'the per-model pick wins');
  assert.equal(resolveReasoningLevel(provider, 'claude-sonnet-5'), 'low', 'other models keep the card default');
  assert.equal(resolveReasoningLevel({ reasoningDefault: 'low', reasoningByModel: { 'gpt-5.6': 'auto' } }, 'gpt-5.6'),
    'auto', "an explicit 'auto' override does not fall back to the card default");
  assert.equal(resolveReasoningLevel({}, 'claude-sonnet-5'), 'auto');
});

test('resolveReasoningLevel: a stale pick outside the vocabulary snaps to the nearest rung it speaks', () => {
  // e.g. the card default was set while a GPT-class model was listed, then the
  // model id switched to a toggle-class GLM — 'high' canonises to the toggle's
  // on position rather than sending nothing.
  const provider = { reasoningDefault: 'high' };
  assert.equal(resolveReasoningLevel(provider, 'glm-5'), 'enabled');
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'glm-5', apiStyle: 'anthropic' }),
    { thinking: { type: 'enabled' } });
});

// --------------- vocabulary precedence --------------------------------------
// per-model override > built-in rule > catalog (only when no rule matches).
// A non-array value at the single-model seam is IGNORED, never silently
// applied: `overrideLevels` (an array for ONE model) and the record-shaped
// `modelLevelsById` exist side by side, so a mis-routed Record must not become
// a one-item level list.

test('reasoningSpecFor: per-model overrideLevels replaces the rule vocabulary', () => {
  assert.deepEqual(reasoningSpecFor('gpt-5.6', { overrideLevels: ['disabled', 'enabled'] }).levels, VOCAB_TOGGLE);
  // Record handed to the array-shaped seam → ignored, the rule still speaks.
  assert.deepEqual(reasoningSpecFor('gpt-5.6', { overrideLevels: { 'gpt-5.6': ['disabled', 'enabled'] } }).levels,
    VOCAB_EFFORT6, 'non-array overrideLevels falls back to the rule vocabulary');
});

test('reasoningFieldsFor: provider.modelLevels shapes the fit end to end', () => {
  // Distinguishable: without the override the rule's effort ladder accepts
  // 'low' verbatim and chat sends reasoning_effort:'low'. With the override the
  // toggle vocabulary fits 'low' to 'enabled', which maps to 'high'.
  const provider = { reasoningDefault: 'low', modelLevels: { 'gpt-5.6': ['disabled', 'enabled'] } };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'gpt-5.6', apiStyle: 'chat' }),
    { reasoning_effort: 'high' });
});

test('reasoningSpecFor: a rule outranks the catalog; the catalog applies only when no rule matches', () => {
  assert.deepEqual(reasoningSpecFor('glm-5', { catalogLevels: ['low', 'medium', 'high'] }).levels, VOCAB_TOGGLE,
    'a built-in rule outranks the catalog');
  assert.deepEqual(reasoningSpecFor('mystery-llm', { catalogLevels: ['low', 'medium', 'high'] }).levels,
    ['low', 'medium', 'high'], 'the catalog is the fallback for a model with no rule');
  // The catalog carries a vocabulary only — no dialect map comes with it, so
  // chat falls back to the shotgun default.
  assert.deepEqual(reasoningFieldsFor({
    provider: { reasoningDefault: 'medium' }, modelId: 'mystery-llm', apiStyle: 'chat',
    catalogLevels: ['low', 'medium', 'high'],
  }), {
    thinking: { type: 'enabled' }, enable_thinking: true, reasoning_effort: 'medium', reasoning: { effort: 'medium' },
  });
});

test('reasoningSpecFor: no rule, no override, no catalog → inert', () => {
  assert.deepEqual(reasoningSpecFor('mystery-llm').levels, []);
  assert.deepEqual(reasoningSpecFor('mystery-llm').maps, {});
  assert.equal(reasoningFieldsFor({ provider: { reasoningDefault: 'high' }, modelId: 'mystery-llm', apiStyle: 'chat' }), null);
});

test('reasoningLevelsFor: auto + the deduped union of the listed models’ vocabularies', () => {
  assert.deepEqual(reasoningLevelsFor(['glm-5', 'gpt-5.6']),
    ['auto', 'disabled', 'enabled', 'none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'first-seen order, auto up front');
  assert.deepEqual(reasoningLevelsFor(['glm-5'], { modelLevelsById: { 'glm-5': ['low', 'max'] } }),
    ['auto', 'low', 'max'], 'the per-model record override reaches the union');
  assert.deepEqual(reasoningLevelsFor([]), ['auto']);
});

// --------------- dialect maps: one level, different wire fields -------------

test('reasoningFieldsFor: auto and unknown models send nothing', () => {
  assert.equal(reasoningFieldsFor({ provider: {}, modelId: 'glm-5', apiStyle: 'chat' }), null);
  assert.equal(reasoningFieldsFor({ provider: { reasoningDefault: 'enabled' }, modelId: 'mystery-model', apiStyle: 'chat' }), null);
});

test('reasoningFieldsFor: toggle-class level becomes enable_thinking on chat (Qwen dialect)', () => {
  const provider = { reasoningDefault: 'enabled' };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'qwen3.5-plus', apiStyle: 'chat' }), { enable_thinking: true });
  assert.deepEqual(reasoningFieldsFor({ provider: { reasoningDefault: 'disabled' }, modelId: 'qwen3.5-plus', apiStyle: 'chat' }), { enable_thinking: false });
});

test('reasoningFieldsFor: toggle-class level becomes thinking.type on anthropic', () => {
  const provider = { reasoningDefault: 'enabled' };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'glm-5', apiStyle: 'anthropic' }), { thinking: { type: 'enabled' } });
  assert.deepEqual(reasoningFieldsFor({ provider: { reasoningDefault: 'disabled' }, modelId: 'glm-5', apiStyle: 'anthropic' }), { thinking: { type: 'disabled' } });
});

test('reasoningFieldsFor: effort ladder becomes reasoning.effort on responses', () => {
  const provider = { reasoningDefault: 'xhigh' };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'gpt-5.6', apiStyle: 'responses' }), { reasoning: { effort: 'xhigh' } });
});

test('reasoningFieldsFor: Claude-class anthropic map is adaptive + output_config.effort', () => {
  const provider = { reasoningDefault: 'high' };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'claude-sonnet-5', apiStyle: 'anthropic' }), {
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
  });
});

test('reasoningFieldsFor: deepseek chat map is thinking.type + reasoning_effort', () => {
  const provider = { reasoningDefault: 'low' };
  assert.deepEqual(reasoningFieldsFor({ provider, modelId: 'deepseek-v4-flash', apiStyle: 'chat' }), {
    thinking: { type: 'enabled' }, reasoning_effort: 'low',
  });
  assert.deepEqual(reasoningFieldsFor({ provider: { reasoningDefault: 'disabled' }, modelId: 'deepseek-v4-flash', apiStyle: 'chat' }), {
    thinking: { type: 'disabled' },
  });
});

// --------------- escape hatch -----------------------------------------------

test('reasoningRaw merges last and overrides the mapped fields', () => {
  const provider = { reasoningDefault: 'high', reasoningRaw: '{"reasoning_effort":"max","vendor_x":1}' };
  const fields = reasoningFieldsFor({ provider, modelId: 'gpt-5.6', apiStyle: 'chat' });
  assert.equal(fields.reasoning_effort, 'max', 'raw override wins');
  assert.equal(fields.vendor_x, 1, 'unknown vendor fields ride along');
});

test('reasoningRaw still merges last when the level is auto (nothing mapped)', () => {
  assert.deepEqual(reasoningFieldsFor({
    provider: { reasoningRaw: '{"reasoning":{"effort":"low"}}' }, modelId: 'glm-5', apiStyle: 'chat',
  }), { reasoning: { effort: 'low' } }, 'raw alone is the payload');
});

test('parseReasoningRaw: invalid JSON / arrays / empty strings are ignored', () => {
  assert.equal(parseReasoningRaw(''), null);
  assert.equal(parseReasoningRaw('{nope'), null);
  assert.equal(parseReasoningRaw('[1,2]'), null);
  assert.deepEqual(parseReasoningRaw('{"a":1}'), { a: 1 });
});
