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

const { handleChat } = await import('../lib/handlers/chat-handler.js');
const { streamState } = await import('../lib/state.js');

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the scripted tool event did not reach the real handler');
}

test('bridge tool completion without a text delta updates durable and saved steps with its original ID', async t => {
  await local.set({
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948' } },
    activeProvider: 'br',
  });
  let sink;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({ start(controller) { sink = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/turns') ? response : new Response('{}');
  const send = event => sink.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const chat = handleChat({ tabId: 93, userText: 'run the command' }, '', '');
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    send({ type: 'done', full: 'command failed' });
    sink.close();
  };
  t.after(async () => {
    try { finish(); } catch {}
    await chat.catch(() => {});
    globalThis.fetch = original;
  });

  send({ type: 'start', sessionId: 'thread-durable-tool', turnId: 'turn-1' });
  send({ type: 'tool', id: 'call-1', name: 'command', status: 'started', detail: 'npm test' });
  await waitFor(() => streamState.get(93)?.steps?.length === 1);
  await new Promise(resolve => setTimeout(resolve, 1120));
  let record = (await session.get('browsa.inflightTurn.93'))['browsa.inflightTurn.93'];
  assert.equal(record.steps[0].name, 'command');
  assert.equal(record.steps[0].ok, undefined);
  assert.equal(record.acc, '', 'no token delta can schedule a later flush');

  send({ type: 'tool', id: 'call-1', name: 'command', status: 'failed', detail: 'npm test (failed)' });
  await waitFor(() => streamState.get(93)?.steps?.[0]?.ok === false);
  await new Promise(resolve => setTimeout(resolve, 1120));
  record = (await session.get('browsa.inflightTurn.93'))['browsa.inflightTurn.93'];
  assert.equal(record.steps[0].ok, false, 'an in-place outcome update must reach the durable record');
  assert.equal(record.steps[0].toolCallId, 'call-1');
  assert.equal(record.steps[0].target, 'npm test (failed)');

  finish();
  await chat;
  const saved = (await local.get('history')).history.findLast(entry => entry.role === 'assistant');
  assert.deepEqual(saved.steps, record.steps, 'the ID and exact outcome survive final persistence');
});
