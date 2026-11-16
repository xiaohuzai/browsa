import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeStream } from '../lib/bridge-client.js';
import { makeTurnStep, pushTurnStep, formatStepsForTurn, prepareHistoryForModel, TURN_STEPS_MAX } from '../lib/message-builder.js';
import { sseHttpResponse } from './helpers/sse-fixtures.mjs';

const tool = (toolCallId, target, outcome) => ({
  k: 'tool', name: 'command', toolCallId, target,
  ...(outcome === undefined ? {} : { ok: outcome }),
});

test('tool IDs: normalization keeps opaque strings intact and rejects non-identities', () => {
  const id = ` native-${'x'.repeat(220)}  `;
  assert.equal(makeTurnStep({ name: 'command', toolCallId: id }).toolCallId, id);
  for (const invalid of [undefined, null, '', ' \n ', 7, {}, []]) {
    assert.equal('toolCallId' in makeTurnStep({ name: 'command', toolCallId: invalid }), false);
  }
  assert.equal('toolCallId' in makeTurnStep({ kind: 'note', text: 'checking', toolCallId: 'call-a' }), false);
});

test('bridge tool contract: native IDs reach ledger metadata while legacy events keep their shape', async () => {
  const original = globalThis.fetch;
  const events = [
    { type: 'tool', id: 'call-a', name: 'command', status: 'started', detail: 'build' },
    { type: 'tool', id: 'call-b', name: 'command', status: 'started', detail: 'test' },
    { type: 'tool', id: 'call-b', name: 'command', status: 'failed', detail: 'test (failed)' },
    { type: 'tool', id: 'call-a', name: 'command', status: 'completed', detail: 'build (exit 0)' },
    { type: 'tool', name: 'legacy', status: 'completed', detail: 'old bridge' },
    { type: 'done', full: 'done' },
  ];
  globalThis.fetch = async () => sseHttpResponse(events.map(e => `data: ${JSON.stringify(e)}\n\n`));
  const metadata = [];
  const steps = [];
  try {
    const result = await bridgeStream({ text: 'run both', onToolProgress: (_text, meta) => {
      metadata.push(meta);
      pushTurnStep(steps, makeTurnStep(meta));
    } });
    assert.equal(result.full, 'done');
    assert.deepEqual(metadata.map(m => m.toolCallId), ['call-a', 'call-b', 'call-b', 'call-a', undefined]);
    assert.deepEqual(metadata.at(-1), { name: 'legacy', target: 'old bridge', status: 'done', ok: true });
    assert.deepEqual(steps.map(s => [s.toolCallId, s.target, s.ok]), [
      ['call-a', 'build (exit 0)', true], ['call-b', 'test (failed)', false], [undefined, 'old bridge', true],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('tool IDs: same-name parallel calls finish independently across notes and in reverse order', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'build'));
  pushTurnStep(steps, tool('b', 'test'));
  pushTurnStep(steps, { k: 'note', text: 'waiting for tools' });
  assert.equal(pushTurnStep(steps, tool('b', 'test (failed)', false)), true, 'an outcome update needs a durable flush');
  pushTurnStep(steps, tool('a', 'build (exit 0)', true));
  assert.deepEqual(steps, [tool('a', 'build (exit 0)', true), tool('b', 'test (failed)', false),
    { k: 'note', text: 'waiting for tools' }]);
});

test('tool IDs: terminal-only events with a reused native ID belong to separate stream invocations', () => {
  const steps = [];
  const first = makeTurnStep({ name: 'command', toolCallId: 'tc1', target: 'first request', status: 'done', ok: true }, 1);
  const second = makeTurnStep({ name: 'command', toolCallId: 'tc1', target: 'second request', status: 'done', ok: false }, 2);
  pushTurnStep(steps, first);
  pushTurnStep(steps, second);
  assert.deepEqual(steps.map(s => [s.toolCallId, s.toolCallScope, s.target, s.ok]), [
    ['tc1', 1, 'first request', true], ['tc1', 2, 'second request', false],
  ]);
  assert.equal(pushTurnStep(steps, makeTurnStep({ name: 'command', toolCallId: 'tc1', target: 'second request', status: 'done', ok: false }, 2)), false);
  assert.equal(steps.length, 2, 'terminal replay remains idempotent inside its own invocation');
  assert.deepEqual(makeTurnStep({ name: 'command' }, 1), makeTurnStep({ name: 'command' }), 'legacy tools do not acquire identity metadata');
  assert.deepEqual(makeTurnStep({ kind: 'note', text: 'checking' }, 1), { k: 'note', text: 'checking' });
});

test('tool IDs: scoped invocations never claim old unscoped records with the same native ID', () => {
  const steps = [];
  pushTurnStep(steps, makeTurnStep({ name: 'command', toolCallId: 'tc1', target: 'legacy start', status: 'started' }));
  pushTurnStep(steps, makeTurnStep({ name: 'command', toolCallId: 'tc1', target: 'scoped result', status: 'done', ok: true }, 1));
  pushTurnStep(steps, makeTurnStep({ name: 'command', toolCallId: 'tc1', target: 'legacy start (failed)', status: 'done', ok: false }));
  assert.deepEqual(steps.map(s => [s.toolCallScope, s.target, s.ok]), [
    [undefined, 'legacy start (failed)', false], [1, 'scoped result', true],
  ]);
});

test('tool IDs: different IDs and mixed legacy/identified events are never guessed into one call', () => {
  const steps = [];
  pushTurnStep(steps, tool(' a ', 'same command'));
  pushTurnStep(steps, tool('a', 'same command'));
  pushTurnStep(steps, { k: 'tool', name: 'command', target: 'legacy' });
  pushTurnStep(steps, tool('a', 'same command', false));
  pushTurnStep(steps, { k: 'tool', name: 'command', target: 'legacy', ok: true });
  assert.equal(steps.length, 3, 'the legacy start/done can pair without touching either native ID');
  assert.equal(steps[0].ok, undefined);
  assert.equal(steps[1].ok, false);
  assert.equal(steps[2].ok, true);
  const mixed = [{ k: 'tool', name: 'command', target: 'legacy' }];
  pushTurnStep(mixed, tool('native', 'same command'));
  pushTurnStep(mixed, { k: 'tool', name: 'command', target: 'legacy', ok: true });
  assert.equal(mixed.length, 3, 'an unidentified completion cannot claim a native-ID start');
  assert.equal(mixed[0].ok, undefined);
  assert.equal(mixed[1].ok, undefined);
  assert.equal(mixed[2].ok, true);
});

test('tool IDs: repeated start/result events are idempotent and a later failure remains visible', () => {
  const steps = [];
  assert.equal(pushTurnStep(steps, tool('a', 'test')), true);
  assert.equal(pushTurnStep(steps, tool('a', 'test')), false);
  assert.equal(pushTurnStep(steps, tool('a', 'test', true)), true);
  assert.equal(pushTurnStep(steps, tool('a', 'test', true)), false);
  assert.equal(pushTurnStep(steps, tool('a', 'test (failed)', false)), true);
  assert.deepEqual(steps, [tool('a', 'test (failed)', false)]);
  assert.equal(pushTurnStep(steps, tool('a', 'test', true)), false, 'a replayed success cannot erase this invocation\'s failure');
  assert.deepEqual(steps, [tool('a', 'test (failed)', false)]);
});

test('tool IDs: a new start after completion creates a new invocation even if an agent reuses its ID', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'test'));
  pushTurnStep(steps, tool('a', 'test', true));
  pushTurnStep(steps, tool('a', 'test'));
  pushTurnStep(steps, tool('a', 'test (failed)', false));
  assert.deepEqual(steps, [tool('a', 'test', true), tool('a', 'test (failed)', false)]);
});

test('tool IDs: an evicted start cannot cause an unrelated call to be overwritten', () => {
  const steps = [];
  for (let i = 0; i <= TURN_STEPS_MAX; i++) pushTurnStep(steps, tool(`call-${i}`, `command-${i}`));
  assert.equal(steps.length, TURN_STEPS_MAX);
  pushTurnStep(steps, tool('call-0', 'command-0 (failed)', false));
  assert.equal(steps.length, TURN_STEPS_MAX);
  assert.equal(steps.at(-1).toolCallId, 'call-0');
  assert.equal(steps.at(-1).ok, false);
  assert.equal(steps.find(s => s.toolCallId === 'call-50').ok, undefined);
});

test('tool IDs: metadata never changes model-facing text or escapes the stripped steps field', () => {
  const steps = [{ ...tool('private-native-call-id', 'npm test', false), toolCallScope: 2 }];
  const history = [{ role: 'assistant', content: 'verbatim answer', steps }];
  const legacy = [{ role: 'assistant', content: 'verbatim answer', steps: [{ k: 'tool', name: 'command', target: 'npm test', ok: false }] }];
  assert.deepEqual(prepareHistoryForModel(history), prepareHistoryForModel(legacy));
  assert.doesNotMatch(JSON.stringify(prepareHistoryForModel(history)), /private-native-call-id|toolCallId|toolCallScope/);
  assert.equal(formatStepsForTurn(steps), '- command: npm test ✗');
  assert.equal(history[0].steps[0].toolCallId, 'private-native-call-id', 'storage metadata survives rendering');
});

test('tool metadata: notes and tools keep timestamps, while a later summary enriches the original call', () => {
  assert.deepEqual(makeTurnStep({ kind: 'note', text: ' checking ', ts: 17 }), { k: 'note', text: 'checking', ts: 17 });
  assert.deepEqual(makeTurnStep({ name: 'command', ts: 17 }), { k: 'tool', name: 'command', ts: 17 });
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'command', toolCallId: 'a' });
  pushTurnStep(steps, { ...tool('a', 'npm test', false), summary: 'tests failed' });
  assert.equal(steps[0].target, 'npm test');
  assert.equal(steps[0].summary, 'tests failed');
  assert.equal(pushTurnStep(steps, { k: 'note', text: 'finished' }), true);
  assert.equal(pushTurnStep(steps, { k: 'note', text: 'finished' }), false);
});

test('tool metadata: target-only and summary-only updates report changes, and omitted targets retain context', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'npm'));
  assert.equal(pushTurnStep(steps, tool('a', 'npm test')), true);
  assert.equal(steps[0].target, 'npm test');
  assert.equal(pushTurnStep(steps, { k: 'tool', name: 'command', toolCallId: 'a', summary: 'running tests' }), true);
  assert.equal(steps[0].target, 'npm test');
  assert.equal(steps[0].summary, 'running tests');
  pushTurnStep(steps, { k: 'tool', name: 'command', toolCallId: 'a', ok: false });
  assert.equal(steps[0].target, 'npm test');
  assert.equal(steps[0].ok, false);
});

test('tool metadata: clipping keeps the exact boundary and the beginning of longer labels', () => {
  const exact = 'p'.repeat(200);
  assert.equal(makeTurnStep({ name: 'command', target: exact }).target, exact);
  const longer = `prefix-${'z'.repeat(230)}`;
  assert.equal(makeTurnStep({ name: 'command', target: longer }).target, `${longer.slice(0, 200)}…`);
});
