import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorageArea } from './helpers/chrome-mock.mjs';
import { sseHttpResponse } from './helpers/sse-fixtures.mjs';

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

test('bridge tool completion without a text delta updates durable and saved step outcomes', async t => {
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
  assert.equal(streamState.get(93).steps[0].toolCallId, 'call-1', 'live matching retains the original opaque ID');
  assert.equal('toolCallId' in record.steps[0], false, 'recovery snapshots do not need live matching IDs');
  assert.equal('toolCallScope' in record.steps[0], false);
  assert.equal(record.steps[0].target, 'npm test →[+" (failed)"]');

  finish();
  await chat;
  const saved = (await local.get('history')).history.findLast(entry => entry.role === 'assistant');
  assert.deepEqual(saved.steps, record.steps, 'the exact visible outcome survives final persistence');
});

test('durable title enrichment survives a silent in-progress tool update', async t => {
  local._reset();
  session._reset();
  await local.set({
    providers: { br: { isBridge: true, alias: 'agent', baseUrl: 'http://127.0.0.1:3948' } },
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
  const chat = handleChat({ tabId: 94, userText: 'search' }, '', '');
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    send({ type: 'done', full: 'partial answer' });
    sink.close();
  };
  t.after(async () => {
    try { finish(); } catch {}
    await chat.catch(() => {});
    globalThis.fetch = original;
  });

  send({ type: 'start', sessionId: 'thread-enrich', turnId: '' });
  send({ type: 'delta', text: 'partial answer' });
  send({ type: 'tool', id: 'tc1', name: 'tool', status: 'started', detail: 'tc1' });
  await waitFor(() => streamState.get(94)?.steps?.[0]?.target === 'tc1');
  await new Promise(resolve => setTimeout(resolve, 1120));
  let record = (await session.get('browsa.inflightTurn.94'))['browsa.inflightTurn.94'];
  assert.equal(record.steps[0].target, 'tc1');

  send({ type: 'tool', id: 'tc1', name: 'tool', status: 'started', detail: 'Searching files' });
  await waitFor(() => streamState.get(94)?.steps?.[0]?.target === 'Searching files');
  await new Promise(resolve => setTimeout(resolve, 1120));
  record = (await session.get('browsa.inflightTurn.94'))['browsa.inflightTurn.94'];
  assert.equal(record.acc, 'partial answer');
  assert.equal(record.steps[0].target, 'Searching files', 'the recovery snapshot must advance without another delta');

  finish();
  await chat;
});

test('timestamp rewrite keeps two wire requests separate when terminal-only tools reuse the same ID', async t => {
  local._reset();
  session._reset();
  await local.set({
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948' } },
    activeProvider: 'br',
    history: [{ role: 'user', content: 'video transcript', videoSrc: { platform: 'youtube', url: 'https://www.youtube.com/watch?v=fixture', tabId: 95 } }],
  });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async url => {
    if (!String(url).endsWith('/turns')) return new Response('{}');
    requests++;
    const events = [
      // The ACP adapter can omit a native turn ID and send only completion.
      { type: 'start', sessionId: 'same-thread', turnId: '' },
      { type: 'tool', id: 'tc1', name: 'command', status: requests === 1 ? 'completed' : 'failed', detail: requests === 1 ? 'read original transcript' : 'read timestamp transcript (failed)' },
      { type: 'done', full: requests === 1 ? 'These video summary notes contain enough text to trigger timestamp rewriting, without any timestamp yet.' : 'Final notes [00:00].' },
    ];
    return sseHttpResponse(events.map(event => `data: ${JSON.stringify(event)}\n\n`));
  };
  await handleChat({ tabId: 95, userText: '总结视频' }, '', '');
  const saved = (await local.get('history')).history.findLast(entry => entry.role === 'assistant');
  assert.equal(requests, 2, 'the real handler performed its silent timestamp rewrite');
  assert.equal(saved.content, 'Final notes [00:00].');
  assert.deepEqual(saved.steps.map(s => [s.target, s.ok]), [
    ['read original transcript', true],
    ['read timestamp transcript (failed)', false],
  ]);
  assert.ok(saved.steps.every(s => !('toolCallId' in s) && !('toolCallScope' in s)));
});

test('separate browser turns can reuse the same native ID without sharing tool records', async t => {
  local._reset();
  session._reset();
  await local.set({
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948' } },
    activeProvider: 'br',
  });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async url => {
    if (!String(url).endsWith('/turns')) return new Response('{}');
    requests++;
    const events = [
      { type: 'start', sessionId: 'same-thread', turnId: '' },
      { type: 'tool', id: 'tc1', name: 'command', status: requests === 1 ? 'completed' : 'failed', detail: `request ${requests}` },
      { type: 'done', full: `reply ${requests}` },
    ];
    return sseHttpResponse(events.map(event => `data: ${JSON.stringify(event)}\n\n`));
  };
  await handleChat({ tabId: 96, userText: 'first question' }, '', '');
  await handleChat({ tabId: 96, userText: 'second question' }, '', '');
  const saved = (await local.get('history')).history.filter(entry => entry.role === 'assistant');
  assert.equal(requests, 2);
  assert.deepEqual(saved.map(entry => entry.steps.map(s => [s.target, s.ok])), [
    [['request 1', true]], [['request 2', false]],
  ]);
});
