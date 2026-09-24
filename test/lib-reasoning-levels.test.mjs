// test/lib-reasoning-levels.test.mjs — per-model reasoning-level engine
// (ported from ZCode's modelRules/modelApiRules technique; ADR-0003: the
// technique is portable, the registry is browsa's own).
//
// The invariants that matter:
//  - the LEVEL VOCABULARY follows the model id (toggle vs effort ladders);
//  - the same level becomes different WIRE FIELDS per apiStyle dialect;
//  - 'auto' (and unknown models) send NOTHING — picking a level is opt-in;
//  - a stale per-model pick outside the vocabulary degrades to 'auto';
//  - provider.reasoningRaw merges last (escape hatch for unknown vendors).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  reasoningSpecFor, reasoningLevelOptions, resolveReasoningLevel, reasoningFieldsFor, parseReasoningRaw,
  VOCAB_TOGGLE, VOCAB_EFFORT3, VOCAB_EFFORT6,
} = await import('../lib/reasoning-levels.js');

// --------------- vocabulary follows the model id ---------------------------

test('reasoningSpecFor: model id selects its own level vocabulary', () => {
  assert.deepEqual(reasoningSpecFor('glm-5').levels, VOCAB_TOGGLE, 'GLM-class is a {关,开} toggle');
  assert.deepEqual(reasoningSpecFor('gpt-5.6-sol').levels, VOCAB_EFFORT6, 'GPT-5-class speaks the full effort ladder');
  assert.deepEqual(reasoningSpecFor('claude-sonnet-5').levels, VOCAB_EFFORT3, 'Claude-class is a three-level ladder');
  assert.deepEqual(reasoningSpecFor('qwen3.5-plus-2026-01-01').levels, VOCAB_TOGGLE, 'dated suffixed ids still match');
});

test('reasoningLevelOptions: unknown model is inert — auto only', () => {
  assert.deepEqual(reasoningLevelOptions('totally-unknown-model'), ['auto']);
  assert.deepEqual(reasoningSpecFor('').levels, []);
});

test('reasoningLevelOptions: auto leads the model vocabulary', () => {
  assert.deepEqual(reasoningLevelOptions('gpt-5.6'), ['auto', ...VOCAB_EFFORT6]);
});

// --------------- level resolution precedence --------------------------------

test('resolveReasoningLevel: per-model override beats card default beats auto', () => {
  const provider = { reasoningDefault: 'low', reasoningByModel: { 'gpt-5.6': 'high' } };
  assert.equal(resolveReasoningLevel(provider, 'gpt-5.6'), 'high');
  assert.equal(resolveReasoningLevel(provider, 'claude-sonnet-5'), 'low');
  assert.equal(resolveReasoningLevel({}, 'claude-sonnet-5'), 'auto');
});

test('resolveReasoningLevel: a stale pick outside the vocabulary degrades to auto', () => {
  // e.g. the card default was set while a GPT-class model was listed, then the
  // model id switched to a toggle-class GLM — 'high' is not GLM vocabulary.
  const provider = { reasoningDefault: 'high' };
  assert.equal(resolveReasoningLevel(provider, 'glm-5'), 'auto');
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

test('parseReasoningRaw: invalid JSON / arrays / empty strings are ignored', () => {
  assert.equal(parseReasoningRaw(''), null);
  assert.equal(parseReasoningRaw('{nope'), null);
  assert.equal(parseReasoningRaw('[1,2]'), null);
  assert.deepEqual(parseReasoningRaw('{"a":1}'), { a: 1 });
});
