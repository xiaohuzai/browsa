import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeStream } from '../lib/bridge-client.js';
import { makeTurnStep, pushTurnStep, clearEvictedToolCalls, formatStepsForTurn, prepareHistoryForModel, TURN_STEPS_MAX } from '../lib/message-builder.js';
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
      ['call-b', 'test →[+" (failed)"]', false], ['call-a', 'build →[+" (exit 0)"]', true], [undefined, 'old bridge', true],
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
  assert.deepEqual(steps, [tool('b', 'test →[+" (failed)"]', false), tool('a', 'build →[+" (exit 0)"]', true),
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
    [1, 'scoped result', true], [undefined, 'legacy start →[+" (failed)"]', false],
  ]);
});

test('tool IDs: different IDs and mixed legacy/identified events are never guessed into one call', () => {
  const steps = [];
  pushTurnStep(steps, tool(' a ', 'same command'));
  pushTurnStep(steps, tool('a', 'same command'));
  pushTurnStep(steps, { k: 'tool', name: 'command', target: 'legacy' });
  pushTurnStep(steps, tool('a', 'same command', false));
  pushTurnStep(steps, { k: 'tool', name: 'command', target: 'legacy', ok: true });
  assert.equal(steps.length, 3, 'the existing trailing legacy start/done pair remains intact');
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

test('an identified start and completion between legacy events do not make the legacy events adjacent', () => {
  const steps = [{ k: 'tool', name: 'legacy', target: 'old bridge' }];
  pushTurnStep(steps, tool('native', 'build'));
  pushTurnStep(steps, tool('native', 'build', true));
  pushTurnStep(steps, { k: 'tool', name: 'legacy', target: 'old bridge', ok: true });
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map(step => [step.name, step.ok]), [['legacy', undefined], ['command', true], ['legacy', true]]);
});

test('a raw title change that clips identically still protects the active call from eviction', () => {
  const steps = [];
  const prefix = 'x'.repeat(200);
  const id = `${prefix}-native-id`;
  pushTurnStep(steps, makeTurnStep({ name: 'read', toolCallId: id, target: id, status: 'started' }, 1));
  for (let i = 0; i < TURN_STEPS_MAX - 1; i++) pushTurnStep(steps, tool(`done-${i}`, `file-${i}`, true));
  assert.equal(pushTurnStep(steps, makeTurnStep({ name: 'read', toolCallId: id, target: `${prefix}-actual-title`, status: 'started' }, 1)), true);
  pushTurnStep(steps, { k: 'note', text: 'latest note' });
  assert.ok(steps.some(step => step.toolCallId === id), 'the recent title update must not be evicted');
});

test('duplicate terminals do not reorder unchanged calls or refresh old work', () => {
  const steps = [tool('a', 'first', false), tool('b', 'second', true)];
  assert.equal(pushTurnStep(steps, tool('a', 'first', false)), false);
  assert.deepEqual(steps, [tool('a', 'first', false), tool('b', 'second', true)]);
});

test('updating an older identified tool preserves trailing note deduplication', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'test'));
  pushTurnStep(steps, { k: 'note', text: 'waiting' });
  pushTurnStep(steps, tool('a', 'test (failed)', false));
  assert.equal(pushTurnStep(steps, { k: 'note', text: 'waiting' }), false);
  assert.deepEqual(steps, [tool('a', 'test →[+" (failed)"]', false), { k: 'note', text: 'waiting' }]);
});

test('a stale success replay cannot rename, replace, or reorder an already failed call', () => {
  const steps = [tool('a', 'actual failure', false), tool('b', 'more recent', true)];
  assert.equal(pushTurnStep(steps, { k: 'tool', name: 'older name', toolCallId: 'a', target: 'older title', ok: true }), false);
  assert.deepEqual(steps, [tool('a', 'actual failure', false), tool('b', 'more recent', true)]);
});

test('tool IDs: repeated start/result events are idempotent and a later failure remains visible', () => {
  const steps = [];
  assert.equal(pushTurnStep(steps, tool('a', 'test')), true);
  assert.equal(pushTurnStep(steps, tool('a', 'test')), false);
  assert.equal(pushTurnStep(steps, tool('a', 'test', true)), true);
  assert.equal(pushTurnStep(steps, tool('a', 'test', true)), false);
  assert.equal(pushTurnStep(steps, tool('a', 'test (failed)', false)), true);
  assert.deepEqual(steps, [tool('a', 'test →[+" (failed)"]', false)]);
  assert.equal(pushTurnStep(steps, tool('a', 'test', true)), false, 'a replayed success cannot erase this invocation\'s failure');
  assert.deepEqual(steps, [tool('a', 'test →[+" (failed)"]', false)]);
});

test('tool IDs: a new start after completion creates a new invocation even if an agent reuses its ID', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'test'));
  pushTurnStep(steps, tool('a', 'test', true));
  pushTurnStep(steps, tool('a', 'test'));
  pushTurnStep(steps, tool('a', 'test (failed)', false));
  assert.deepEqual(steps, [tool('a', 'test', true), tool('a', 'test →[+" (failed)"]', false)]);
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

test('a new tool does not evict a recent failure in favor of old pending calls', () => {
  const steps = [];
  for (let i = 0; i < 49; i++) pushTurnStep(steps, tool(`long-${i}`, `long task ${i}`));
  pushTurnStep(steps, tool('recent', 'important test'));
  pushTurnStep(steps, tool('recent', 'important test (failed)', false));
  pushTurnStep(steps, tool('new', 'new task'));
  assert.equal(steps.length, TURN_STEPS_MAX);
  assert.ok(steps.some(step => step.toolCallId === 'recent' && step.ok === false));
  assert.ok(!steps.some(step => step.toolCallId === 'long-0'));
});

test('an evicted pending call returns on its own scoped result without splitting the trailing legacy call', () => {
  const steps = [];
  const native = (id, title, status, scope = 1) => makeTurnStep({ name: 'command', toolCallId: id, target: title, status, ok: false }, scope);
  pushTurnStep(steps, native('long', 'npm test', 'started'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, native(`other-${i}`, `file-${i}`, 'done'));
  assert.equal(pushTurnStep(steps, native('long', 'npm test', 'started')), false, 'an unchanged replay does not reorder recent work');
  assert.ok(!steps.some(step => step.toolCallScope === 1 && step.toolCallId === 'long'));
  pushTurnStep(steps, native('long', 'long (failed)', 'done', 2));
  assert.ok(steps.some(step => step.toolCallScope === 2 && step.target === 'long (failed)'));
  pushTurnStep(steps, { k: 'tool', name: 'legacy', target: 'old bridge' });
  pushTurnStep(steps, native('long', 'long (failed)', 'done'));
  pushTurnStep(steps, makeTurnStep({ name: 'command', toolCallId: 'long', target: 'older success', status: 'done', ok: true }, 1));
  pushTurnStep(steps, { k: 'tool', name: 'legacy', target: 'old bridge', ok: true });
  assert.equal(steps.length, TURN_STEPS_MAX);
  assert.ok(steps.some(step => step.toolCallScope === 1 && step.target === 'npm test' && step.ok === false));
  assert.equal(steps.filter(step => step.name === 'legacy').length, 1);
  assert.equal(steps.find(step => step.name === 'legacy').ok, true);
});

test('restoring an evicted call retains its previous title history without duplicating the latest title', () => {
  const steps = [];
  const update = (target, status) => makeTurnStep({ name: 'read', toolCallId: 'a', target, status, ok: true }, 1);
  pushTurnStep(steps, update('first file', 'started'));
  pushTurnStep(steps, update('second file', 'started'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, { k: 'note', text: `event ${i}` });
  pushTurnStep(steps, update('second file', 'done'));
  const restored = steps.find(step => step.toolCallId === 'a');
  assert.equal(restored.target, 'first file → second file');
  assert.equal(restored.ok, true);
  assert.equal(pushTurnStep(steps, { k: 'note', text: 'event 49' }), false, 'the trailing note remains the adjacent deduplication candidate');
});

test('the evicted pending cache is bounded and never claims an unrelated invocation', () => {
  const steps = [];
  for (let i = 0; i <= TURN_STEPS_MAX * 2; i++) pushTurnStep(steps, tool(`pending-${i}`, `task-${i}`));
  pushTurnStep(steps, tool('pending-1', '', false));
  assert.ok(steps.some(step => step.toolCallId === 'pending-1' && step.target === 'task-1' && step.ok === false));
  pushTurnStep(steps, tool('pending-0', '', false));
  assert.equal(steps.length, TURN_STEPS_MAX);
  assert.ok(steps.some(step => step.toolCallId === 'pending-0' && step.target === '' && step.ok === false));
  assert.ok(steps.some(step => step.toolCallId === 'pending-100' && step.target === 'task-100'));
});

test('oversized evicted IDs are not truncated into another invocation', () => {
  const steps = [];
  const longId = `${'x'.repeat(65_536)}A`;
  const otherId = `${'x'.repeat(65_536)}B`;
  pushTurnStep(steps, tool(longId, 'original command'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, tool(`other-${i}`, `file-${i}`, true));
  pushTurnStep(steps, tool(otherId, 'other command', false));
  assert.ok(steps.some(step => step.toolCallId === otherId && step.target === 'other command'));
  assert.ok(!steps.some(step => step.toolCallId === longId), 'the bounded cache declines an oversized ID');
});

test('an oversized evicted ID does not discard another cached pending call', () => {
  const steps = [];
  pushTurnStep(steps, tool('short', 'npm test'));
  pushTurnStep(steps, tool('x'.repeat(65_537), 'oversized call'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, tool(`other-${i}`, `file-${i}`, true));
  pushTurnStep(steps, tool('short', '', false));
  assert.ok(steps.some(step => step.toolCallId === 'short' && step.target === 'npm test' && step.ok === false));
});

test('the pending ID budget retains exact-limit entries and evicts oldest entries only when exceeded', () => {
  const exactId = 'x'.repeat(65_536);
  const exact = [];
  pushTurnStep(exact, tool(exactId, 'exact budget'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(exact, tool(`done-${i}`, `file-${i}`, true));
  pushTurnStep(exact, tool(exactId, '', false));
  assert.ok(exact.some(step => step.toolCallId === exactId && step.target === 'exact budget' && step.ok === false));

  const steps = [];
  const ids = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(4, '0')}${'p'.repeat(2044)}`);
  for (const [i, id] of ids.entries()) pushTurnStep(steps, tool(id, `task-${i}`));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, tool(`done-${i}`, `file-${i}`, true));
  pushTurnStep(steps, tool(ids[0], '', false));
  assert.ok(steps.some(step => step.toolCallId === ids[0] && step.target === ''), 'the oldest ID exceeded the shared budget');
  pushTurnStep(steps, tool(ids[39], '', false));
  assert.ok(steps.some(step => step.toolCallId === ids[39] && step.target === 'task-39'), 'recent pending calls still restore');
});

test('restoring one evicted call leaves other pending calls and later ID reuse independent', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'first command'));
  pushTurnStep(steps, tool('b', 'second command'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, tool(`done-${i}`, `file-${i}`, true));
  assert.equal(pushTurnStep(steps, tool('a', '', false)), true);
  assert.equal(pushTurnStep(steps, tool('b', '', false)), true);
  assert.ok(steps.some(step => step.toolCallId === 'b' && step.target === 'second command' && step.ok === false));
  pushTurnStep(steps, tool('a', 'fresh command'));
  const reused = steps.filter(step => step.toolCallId === 'a');
  assert.equal(reused.length, 2);
  assert.deepEqual(reused.map(step => [step.target, step.ok]), [['first command', false], ['fresh command', undefined]]);
});

test('ending a wire request releases its evicted pending correlation state', () => {
  const steps = [];
  pushTurnStep(steps, tool('a', 'old command'));
  for (let i = 0; i < TURN_STEPS_MAX; i++) pushTurnStep(steps, tool(`other-${i}`, `file-${i}`, true));
  clearEvictedToolCalls(steps);
  pushTurnStep(steps, tool('a', '', false));
  assert.ok(steps.some(step => step.toolCallId === 'a' && step.target === '' && step.ok === false));
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
  assert.equal(steps[0].target, 'npm →[+" test"]');
  assert.equal(pushTurnStep(steps, { k: 'tool', name: 'command', toolCallId: 'a', summary: 'running tests' }), true);
  assert.equal(steps[0].target, 'npm →[+" test"]');
  assert.equal(steps[0].summary, 'running tests');
  pushTurnStep(steps, { k: 'tool', name: 'command', toolCallId: 'a', ok: false });
  assert.equal(steps[0].target, 'npm →[+" test"]');
  assert.equal(steps[0].ok, false);
});

test('tool metadata: clipping keeps the exact boundary and the beginning of longer labels', () => {
  const exact = 'p'.repeat(200);
  assert.equal(makeTurnStep({ name: 'command', target: exact }).target, exact);
  const longer = `prefix-${'z'.repeat(230)}`;
  assert.equal(makeTurnStep({ name: 'command', target: longer }).target, `${longer.slice(0, 200)}…`);
});
