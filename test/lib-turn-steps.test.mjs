// test/lib-turn-steps.test.mjs
// MUTATION FLOOR for the turn step ledger (2026-10-23, Orca study).
//
// The ledger answers "what did that turn DO", which the stored assistant entry
// otherwise never records (browsa had no equivalent of Orca's `worker_done
// --files-modified`). Two invariants make or break it:
//
//   1. It must NEVER reach a model as a field. `prepareHistoryForModel` strips
//      it from every request body — the LLM legs would pay tokens for it and
//      strict-schema providers 400 on the unknown key. Reverting the delete
//      turns the first group red.
//   2. It must be VISIBLE where continuity actually breaks: prior agent
//      ledgers ride the new user message for LLM legs (情形 4), and the
//      provider-switch backfill carries each turn's steps for agent legs
//      (情形 2/3). Removing either turns its group red.
//
// A third, quieter invariant: rendering steps must not rewrite stored history
// (the 2026-10-14 KV-cache ruling) — it is appended to the CURRENT turn only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeTurnStep, pushTurnStep, formatStepsForTurn, stepsNoteForEntry,
  prepareHistoryForModel, buildMessages, buildResponsesInput, buildAnthropicMessages,
  buildRunsConversationHistory, buildHermesTurn,
  TURN_STEPS_FIELD, TURN_STEPS_MAX, TURN_STEP_TEXT_MAX, TURN_STEPS_NOTE_MAX_CHARS,
} from '../lib/message-builder.js';
import { buildAgentBackfill } from '../lib/agent-turn.js';

const ledger = [
  { k: 'tool', name: 'edit', target: 'src/app.ts', ok: true },
  { k: 'tool', name: 'bash', summary: 'npm test', ok: false },
];

// ─── Normalization ───────────────────────────────────────────────────────────

test('makeTurnStep: a started event carries no outcome (never guesses success)', () => {
  const s = makeTurnStep({ name: 'edit', target: 'a.ts', status: 'started' });
  assert.deepEqual(s, { k: 'tool', name: 'edit', target: 'a.ts' });
  assert.equal('ok' in s, false, 'an unfinished step must not claim an outcome');
});

test('makeTurnStep: a done event records the real outcome, including failure', () => {
  assert.deepEqual(makeTurnStep({ name: 'bash', status: 'done', ok: true }), { k: 'tool', name: 'bash', ok: true });
  assert.deepEqual(makeTurnStep({ name: 'bash', status: 'done', ok: false }), { k: 'tool', name: 'bash', ok: false });
});

test('makeTurnStep: note events (agent interim narration) are kept as notes', () => {
  assert.deepEqual(makeTurnStep({ kind: 'note', text: 'I will check the tests' }), { k: 'note', text: 'I will check the tests' });
});

test('makeTurnStep: empty / shapeless meta yields null (no junk entries)', () => {
  assert.equal(makeTurnStep(null), null);
  assert.equal(makeTurnStep({}), null);
  assert.equal(makeTurnStep({ name: '', target: 'x' }), null);
  assert.equal(makeTurnStep({ kind: 'note', text: '   ' }), null);
});

test('makeTurnStep: text is clipped and whitespace collapsed', () => {
  const long = 'a'.repeat(TURN_STEP_TEXT_MAX + 50);
  const s = makeTurnStep({ name: 'write', target: `x\n\n  ${long}` });
  assert.ok(s.target.length <= TURN_STEP_TEXT_MAX + 1, 'clipped to the cap (+ ellipsis)');
  assert.ok(s.target.endsWith('…'));
  assert.equal(/\s{2,}/.test(s.target), false, 'whitespace collapsed');
});

test('makeTurnStep: summary equal to target is not duplicated', () => {
  const s = makeTurnStep({ name: 'read', target: 'a.ts', summary: 'a.ts', status: 'started' });
  assert.equal(s.summary, undefined);
});

// ─── Ledger discipline ───────────────────────────────────────────────────────

test('pushTurnStep: consecutive duplicates collapse, outcome upgrades in place', () => {
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts' });         // started
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts', ok: true }); // done, same step
  assert.equal(steps.length, 1, 'start+done of one step is ONE ledger entry');
  assert.equal(steps[0].ok, true, 'the outcome upgraded in place');
});

test('pushTurnStep: a second COMPLETED call is a real second step (failure not swallowed)', () => {
  // npm test run twice, the second failing. Collapsing these would keep ok:true
  // and hide the failure — the one outcome a handoff reader must not lose.
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'bash', target: 'npm test', ok: true });
  pushTurnStep(steps, { k: 'tool', name: 'bash', target: 'npm test', ok: false });
  assert.equal(steps.length, 2);
  assert.equal(steps[1].ok, false, 'the later failure survives');
});

test('pushTurnStep: start-without-target then done still collapses to ONE step', () => {
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'edit' });                     // started, no target
  pushTurnStep(steps, { k: 'tool', name: 'edit', ok: false });          // done, failed
  assert.equal(steps.length, 1);
  assert.equal(steps[0].ok, false);
});

test('pushTurnStep: bridge started/failed pair is ONE step (target relabelled on the done leg)', () => {
  // Real-Chromium regression (2026-10-23): the bridge emits started with
  // detail 'npm run deploy' and failed with 'npm run deploy (failed)'. Gating
  // the dedup on target equality split one invocation into a phantom
  // "(in progress)" row plus a failed row.
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'command', target: 'npm run deploy' });
  pushTurnStep(steps, { k: 'tool', name: 'command', target: 'npm run deploy (failed)', ok: false });
  assert.equal(steps.length, 1, 'started + failed is ONE invocation');
  assert.equal(steps[0].ok, false);
  assert.equal(steps[0].target, 'npm run deploy (failed)', 'the done leg\'s clearer label wins');
});

test('pushTurnStep: two different targets, each start+done, stay two steps', () => {
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts' });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts', ok: true });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'b.ts' });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'b.ts', ok: true });
  assert.deepEqual(steps.map((s) => s.target), ['a.ts', 'b.ts']);
});

test('pushTurnStep: interleaved starts resolve independently', () => {
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts' });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'b.ts' });
  // b.ts completes first, then a.ts: the open b row is last, so a.ts's done
  // appends rather than merging into the wrong entry.
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'b.ts', ok: true });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts', ok: true });
  assert.equal(steps.length, 2);
  assert.equal(steps.every((s) => s.ok === true || s.ok === undefined), true);
});

test('pushTurnStep: alternating targets and notes are never merged', () => {
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts', ok: true });
  pushTurnStep(steps, { k: 'note', text: 'thinking' });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts', ok: true });
  assert.equal(steps.length, 3, 'order is the story; non-adjacent repeats are kept');
});

test('pushTurnStep: distinct steps are all kept', () => {
  const steps = [];
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'a.ts', ok: true });
  pushTurnStep(steps, { k: 'tool', name: 'edit', target: 'b.ts', ok: true });
  assert.equal(steps.length, 2);
});

test(`pushTurnStep: caps at ${TURN_STEPS_MAX}, keeping the NEWEST`, () => {
  const steps = [];
  for (let i = 0; i < TURN_STEPS_MAX + 20; i++) {
    pushTurnStep(steps, { k: 'tool', name: `tool${i}`, target: `f${i}`, ok: true });
  }
  assert.equal(steps.length, TURN_STEPS_MAX);
  assert.equal(steps[0].name, `tool20`, 'the head was dropped, not the tail');
  assert.equal(steps.at(-1).name, `tool${TURN_STEPS_MAX + 19}`);
});

test('pushTurnStep: a non-array ledger is a no-op (defensive)', () => {
  assert.equal(pushTurnStep(null, { k: 'tool', name: 'x' }), false);
  assert.equal(pushTurnStep(undefined, { k: 'tool', name: 'x' }), false);
});

// ─── Rendering ───────────────────────────────────────────────────────────────

test('formatStepsForTurn: one line per step, failure marked, unknown outcome explicit', () => {
  const text = formatStepsForTurn(ledger);
  assert.match(text, /^- edit: src\/app\.ts$/m);
  assert.match(text, /^- bash: npm test ✗$/m);
  const pending = formatStepsForTurn([{ k: 'tool', name: 'grep', target: 'foo' }]);
  assert.match(pending, /\(in progress\)/, 'an outcome-less step is not silently shown as success');
});

test('formatStepsForTurn: empty / missing ledger yields empty string', () => {
  assert.equal(formatStepsForTurn([]), '');
  assert.equal(formatStepsForTurn(null), '');
  assert.equal(formatStepsForTurn([{ k: 'tool' }]), '', 'a nameless step renders nothing');
});

test('stepsNoteForEntry: renders the note deterministically from the stored entry', () => {
  const entry = { role: 'assistant', content: 'done', providerLabel: 'codex', steps: ledger };
  const a = stepsNoteForEntry(entry);
  const b = stepsNoteForEntry(entry);
  assert.equal(a, b, 'same entry must always produce the same bytes (KV prefix)');
  assert.match(a, /该回合执行过/);
  assert.match(a, /edit: src\/app\.ts/);
});

test('stepsNoteForEntry: no ledger → empty string', () => {
  assert.equal(stepsNoteForEntry({ role: 'assistant', content: 'hi' }), '');
  assert.equal(stepsNoteForEntry(null), '');
});

test('stepsNoteForEntry: the note is bounded per entry (it rides every request)', () => {
  const big = [];
  for (let i = 0; i < TURN_STEPS_MAX; i++) big.push({ k: 'tool', name: `tool${i}`, target: 'src/a-reasonably-long-file-name.ts', ok: true });
  const note = stepsNoteForEntry({ role: 'assistant', content: 'x', steps: big });
  assert.ok(note.length <= TURN_STEPS_NOTE_MAX_CHARS + 120, `note stays bounded (got ${note.length})`);
  assert.match(note, /较早步骤已省略/, 'the trim is disclosed, not silent');
  assert.match(note, /tool49/, 'the RECENT steps survive the trim');
});

test('stepsNoteForEntry: the bound depends only on the entry, never its position', () => {
  // A position-dependent window would slide as turns append and break the
  // prefix chain the KV ruling depends on.
  const big = [];
  for (let i = 0; i < TURN_STEPS_MAX; i++) big.push({ k: 'tool', name: `t${i}`, target: 'x/.y', ok: true });
  const entry = { role: 'assistant', content: 'x', steps: big };
  const a = stepsNoteForEntry(entry);
  const b = stepsNoteForEntry(JSON.parse(JSON.stringify(entry)));
  assert.equal(a, b);
});

// ─── Invariant 1: the field NEVER reaches a model ────────────────────────────
// Restored 2026-10-23 after an audit found the strip assertions had been
// dropped during a rewrite: the file header still claimed the invariant while
// nothing pinned it, so `delete copy[TURN_STEPS_FIELD]` could be removed with
// the suite fully green. These are the tests that make that line load-bearing.

test('prepareHistoryForModel: strips the step ledger from the entry', () => {
  const history = [{ role: 'assistant', content: 'done', [TURN_STEPS_FIELD]: ledger }];
  const out = prepareHistoryForModel(history);
  assert.equal(TURN_STEPS_FIELD in out[0], false, 'the ledger must not ride as a field');
  assert.equal(out[0].content.startsWith('done'), true, 'the reply text is preserved');
});

test('prepareHistoryForModel: strips steps and the legacy image stamp together', () => {
  const history = [{ role: 'assistant', content: 'x', imagesSeen: true, [TURN_STEPS_FIELD]: ledger }];
  const out = prepareHistoryForModel(history);
  assert.equal('imagesSeen' in out[0], false);
  assert.equal(TURN_STEPS_FIELD in out[0], false);
});

test('no channel serializes a `steps` key onto the wire', () => {
  const history = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'fixed', providerLabel: 'codex', [TURN_STEPS_FIELD]: ledger },
  ];
  const wires = {
    chat: buildMessages({ history, userText: 'q', userImages: null, systemPrompt: 'sys' }),
    responses: buildResponsesInput({ userText: 'q' }, history),
    anthropic: buildAnthropicMessages({ userText: 'q' }, history),
    runs: buildRunsConversationHistory(history),
    hermes: buildHermesTurn({ userText: 'q' }, history).conversationHistory,
  };
  for (const [name, wire] of Object.entries(wires)) {
    assert.equal(/"steps"\s*:/.test(JSON.stringify(wire)), false,
      `${name}: the steps field must never appear in a request body`);
  }
});

test('empty steps: field stripped, and no note is emitted', () => {
  const out = prepareHistoryForModel([{ role: 'assistant', content: 'x', [TURN_STEPS_FIELD]: [] }]);
  assert.equal(TURN_STEPS_FIELD in out[0], false);
  assert.equal(out[0].content, 'x', 'an empty ledger adds nothing');
});

test('user / system entries never get a note even if they carry steps', () => {
  const out = prepareHistoryForModel([
    { role: 'user', content: 'u', [TURN_STEPS_FIELD]: ledger },
    { role: 'system', content: 's', [TURN_STEPS_FIELD]: ledger },
  ]);
  assert.equal(out[0].content, 'u');
  assert.equal(out[1].content, 's');
});

test('prepareHistoryForModel is idempotent (no doubled note)', () => {
  const once = prepareHistoryForModel([
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a', [TURN_STEPS_FIELD]: ledger },
  ]);
  const twice = prepareHistoryForModel(once);
  assert.equal(once[1].content, twice[1].content);
  assert.equal((once[1].content.match(/该回合执行过/g) || []).length, 1);
});

test('an image-only assistant entry gains a text part carrying the note', () => {
  const out = prepareHistoryForModel([{
    role: 'assistant',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
    [TURN_STEPS_FIELD]: ledger,
  }]);
  const parts = out[0].content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.some(p => p.type === 'image_url'), true, 'the image part is preserved');
  assert.equal(parts.some(p => p.type === 'text' && /src\/app\.ts/.test(p.text)), true);
});

test('building a request never mutates the stored history', () => {
  const history = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a', [TURN_STEPS_FIELD]: ledger },
  ];
  const snapshot = JSON.parse(JSON.stringify(history));
  buildMessages({ history, userText: 'next', userImages: null });
  assert.deepEqual(history, snapshot);
});

// ─── Invariant 2a: 情形 4 — LLM legs inherit prior agent work ────────────────

test('buildMessages: the note rides the STORED ASSISTANT entry, not the user turn', () => {
  const history = [
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: 'done', providerLabel: 'codex', steps: ledger },
  ];
  const msgs = buildMessages({ history, userText: 'which file did you touch?', userImages: null });
  const assistant = msgs.find(m => m.role === 'assistant');
  assert.match(assistant.content, /edit: src\/app\.ts/, 'the LLM can now name the file');
  assert.equal(msgs.at(-1).content, 'which file did you touch?', 'the user turn stays EXACTLY the user text');
});

test('KV-PREFIX: turn N is a strict prefix of turn N+1 (the regression this guards)', () => {
  // The first implementation injected the note into the outgoing user message,
  // so the user's earlier line went out WITH a note in turn N and BARE in
  // turn N+1 — re-prefilling everything after it. This test walks REAL
  // consecutive turns; a per-turn-varying injection turns it red.
  const steps = ledger;
  let history = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1', providerLabel: 'codex', steps },
  ];
  const t1 = buildMessages({ history, userText: 'q1', userImages: null });
  history = [...history, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'r1' }];
  const t2 = buildMessages({ history, userText: 'q2', userImages: null });
  history = [...history, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'r2' }];
  const t3 = buildMessages({ history, userText: 'q3', userImages: null });

  assert.deepEqual(t2.slice(0, t1.length), t1, 'turn 1 must be a byte-identical prefix of turn 2');
  assert.deepEqual(t3.slice(0, t2.length), t2, 'turn 2 must be a byte-identical prefix of turn 3');
  assert.equal(t1[1].content, t3[1].content, 'the noted entry is byte-stable across turns');
});

test('KV-PREFIX: an entry with steps is byte-identical in every later request', () => {
  const entry = { role: 'assistant', content: 'a1', steps: ledger };
  const history = [{ role: 'user', content: 'u1' }, entry];
  const first = buildMessages({ history, userText: 'q1', userImages: null })[1];
  const later = buildMessages({
    history: [...history, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'r1' }],
    userText: 'q2', userImages: null,
  })[1];
  assert.deepEqual(first, later);
});

test('buildMessages: a plain history (no ledgers) is byte-for-byte unchanged in shape', () => {
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const msgs = buildMessages({ history, userText: 'c', userImages: null });
  assert.equal(msgs.at(-1).content, 'c', 'no stray note when there is nothing to report');
  assert.deepEqual(msgs.map(m => m.content), ['a', 'b', 'c']);
});

// ─── Invariant 2b: 情形 2/3 — agent backfill carries the work done ───────────

test('buildAgentBackfill: each turn carries what it executed', () => {
  const text = buildAgentBackfill([
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: 'fixed it', providerLabel: 'codex', steps: ledger },
  ]);
  assert.match(text, /助手（codex）：fixed it/);
  assert.match(text, /\[该回合执行过\]/);
  assert.match(text, /edit: src\/app\.ts/);
  assert.match(text, /bash: npm test ✗/);
});

test('buildAgentBackfill: turns without a ledger render exactly as before', () => {
  const text = buildAgentBackfill([{ role: 'assistant', content: 'plain reply' }]);
  assert.match(text, /^助手：plain reply$/m);
  assert.equal(/\[该回合执行过\]/.test(text), false);
});

// ─── Invariant 3: history is never rewritten to make this work ──────────────

test('KV-prefix: the ledger note lives on the CURRENT turn, stored history is untouched', () => {
  const history = [
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: 'done', steps: ledger },
  ];
  const snapshot = JSON.parse(JSON.stringify(history));
  buildMessages({ history, userText: 'next', userImages: null });
  assert.deepEqual(history, snapshot, 'building a request must not mutate stored history');
});

// NOTE: the first version of this file had a "prefix" test that passed the
// SAME history array to both builds and only changed userText — it could never
// fail, and the real regression (per-turn injection) shipped green. It was
// replaced above by 'KV-PREFIX: turn N is a strict prefix of turn N+1', which
// walks genuinely consecutive turns. Do not reintroduce the weak form.