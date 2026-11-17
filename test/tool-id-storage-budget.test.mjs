import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorageArea } from './helpers/chrome-mock.mjs';

const local = makeStorageArea({}, { clone: true });
const session = makeStorageArea({}, { clone: true });
globalThis.chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  runtime: { onMessage: { addListener() {} }, sendMessage() {} },
};

const { handleChat, persistTurnEntry } = await import('../lib/handlers/chat-handler.js');
const { streamState } = await import('../lib/state.js');
const { stepsWithoutLiveToolIdentity } = await import('../lib/tool-call-id.js');

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the scripted event did not reach the real handler');
}

test('long native IDs do not crowd a recovery snapshot, while live calls still pair exactly', async t => {
  local._reset();
  session._reset();
  await local.set({
    providers: { br: { isBridge: true, alias: 'agent', baseUrl: 'http://127.0.0.1:3948' } },
    activeProvider: 'br',
  });
  // A deliberately scaled-down quota models a session store close to its real
  // Chrome limit without allocating large buffers. All reads/writes still use
  // the shared structuredClone storage mock.
  const realSet = session.set;
  const rejected = [];
  session.set = async obj => {
    const bytes = Buffer.byteLength(JSON.stringify({ ...session._dump(), ...obj }));
    if (bytes > 2000) { rejected.push(bytes); throw new Error('QUOTA_BYTES'); }
    await realSet(obj);
  };
  let sink;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({ start(controller) { sink = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/turns') ? response : new Response('{}');
  const send = event => sink.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const chat = handleChat({ tabId: 120, userText: 'run both tools' }, '', '');
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    send({ type: 'done', full: 'before tool. after tool' });
    sink.close();
  };
  t.after(async () => {
    try { finish(); } catch {}
    await chat.catch(() => {});
    session.set = realSet;
    globalThis.fetch = originalFetch;
  });

  send({ type: 'start', sessionId: 'quota-thread', turnId: '' });
  send({ type: 'delta', text: 'before tool. ' });
  await waitFor(() => streamState.get(120)?.acc === 'before tool. ');
  await new Promise(resolve => setTimeout(resolve, 1120));
  assert.equal((await session.get('browsa.inflightTurn.120'))['browsa.inflightTurn.120'].acc, 'before tool. ');

  // The IDs share a 3 KB prefix. Truncating them for matching would merge two
  // different invocations, so live state must keep both exact identities.
  const idA = `${'x'.repeat(3000)}A`;
  const idB = `${'x'.repeat(3000)}B`;
  for (const event of [
    { type: 'tool', id: idA, name: 'command', status: 'started', detail: 'build' },
    { type: 'tool', id: idB, name: 'command', status: 'started', detail: 'test' },
    { type: 'tool', id: idB, name: 'command', status: 'failed', detail: 'test (failed)' },
    { type: 'tool', id: idA, name: 'command', status: 'completed', detail: 'build (exit 0)' },
    { type: 'delta', text: 'after tool' },
  ]) send(event);
  await waitFor(() => streamState.get(120)?.steps?.length === 2 && streamState.get(120)?.acc === 'before tool. after tool');
  const liveSteps = streamState.get(120).steps;
  assert.deepEqual(new Set(liveSteps.map(step => step.toolCallId)), new Set([idA, idB]));
  await new Promise(resolve => setTimeout(resolve, 1120));
  const record = (await session.get('browsa.inflightTurn.120'))['browsa.inflightTurn.120'];
  assert.deepEqual(rejected, [], 'optional native IDs must not exhaust the recovery budget');
  assert.equal(record.acc, 'before tool. after tool');
  assert.deepEqual(Object.fromEntries(record.steps.map(step => [step.target, step.ok])), {
    'test →[+" (failed)"]': false, 'build →[+" (exit 0)"]': true,
  });
  assert.ok(record.steps.every(step => !('toolCallId' in step) && !('toolCallScope' in step) && !('toolTargetIsId' in step)));

  finish();
  await chat;
  const saved = (await local.get('history')).history.findLast(entry => entry.role === 'assistant');
  assert.deepEqual(saved.steps, record.steps, 'saved history retains the complete visible step outcomes');
});

test('persisting a new turn removes only live identity fields and never rewrites prior history', async () => {
  local._reset();
  session._reset();
  const prior = { role: 'assistant', content: 'old answer', steps: [{ k: 'tool', name: 'read', toolCallId: 'historical-id', target: 'old.txt' }] };
  const fresh = { role: 'assistant', content: 'new answer', steps: [{ k: 'tool', name: 'edit', target: 'new.txt', ok: true, toolCallId: 'live-id', toolCallScope: 2, toolTargetIsId: true, futureField: 'keep me' }] };
  await local.set({ history: [prior] });
  await persistTurnEntry(121, fresh);
  const stored = (await local.get('history')).history;
  assert.deepEqual(stored[0], prior, 'earlier history stays byte-for-byte equivalent');
  assert.deepEqual(stored[1].steps, [{ k: 'tool', name: 'edit', target: 'new.txt', ok: true, futureField: 'keep me' }]);
  assert.equal(fresh.steps[0].toolCallId, 'live-id', 'the active step is not mutated by persistence');
});

test('storage projection leaves unusual old step values intact', () => {
  const unusual = [null, 'legacy', ['nested'], { k: 'tool', name: 'read', futureField: 7, toolCallId: 'live' }];
  const stored = stepsWithoutLiveToolIdentity(unusual);
  assert.deepEqual(stored, [null, 'legacy', ['nested'], { k: 'tool', name: 'read', futureField: 7 }]);
  assert.equal(unusual[3].toolCallId, 'live');
});
