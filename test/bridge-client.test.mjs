// test/bridge-client.test.mjs — lib/bridge-client.js against a scripted
// globalThis.fetch (locally-constructed SSE Responses; no server). Covers the
// wire contract browsa depends on: POST /turns body shape, auth header, event
// → callback mapping, session capture, heartbeat, abort, and error paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bridgeStream, pingBridge, respondBridgeApproval, normalizeBridgeUrl } = await import('../lib/bridge-client.js');

function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function captureFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(url, opts, calls);
  };
  return calls;
}

test('normalizeBridgeUrl: empty → default, path stripped, scheme filled', () => {
  assert.equal(normalizeBridgeUrl(''), 'http://127.0.0.1:3948');
  assert.equal(normalizeBridgeUrl('127.0.0.1:3948'), 'http://127.0.0.1:3948');
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:3948/'), 'http://127.0.0.1:3948');
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:3948/extra/path'), 'http://127.0.0.1:3948');
});

test('bridgeStream: POST /turns body, auth header, event → callback mapping', async () => {
  const calls = captureFetch(() => sseResponse([
    'data: {"type":"start","sessionId":"thread-9","turnId":"t1"}\n\n',
    'data: {"type":"delta","text":"HE"}\n',
    'data: {"type":"delta","text":"LLO"}\n\n',
    ': ka\n\n',
    'data: {"type":"tool","name":"command","status":"started","detail":"ls"}\n\n',
    'data: {"type":"tool","name":"command","status":"completed","detail":"ls (exit 0)"}\n\n',
    'data: {"type":"usage","prompt_tokens":10,"completion_tokens":4}\n\n',
    'data: {"type":"done","full":"HELLO"}\n\n',
  ]));
  const seen = { deltas: [], tools: [], heartbeats: 0, sessions: [] };
  const r = await bridgeStream({
    baseUrl: 'http://127.0.0.1:3948', apiKey: 'tok-1', sessionId: 'thread-8', text: 'hi',
    onDelta: (t) => seen.deltas.push(t),
    onToolProgress: (s) => seen.tools.push(s),
    onHeartbeat: () => seen.heartbeats++,
    onSessionId: (s) => seen.sessions.push(s),
  });
  const turn = calls[0];
  assert.equal(turn.url, 'http://127.0.0.1:3948/turns');
  assert.equal(turn.opts.method, 'POST');
  assert.deepEqual(JSON.parse(turn.opts.body), { text: 'hi', sessionId: 'thread-8' });
  assert.equal(turn.opts.headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(seen.deltas, ['HE', 'LLO']);
  assert.equal(seen.heartbeats, 1);
  assert.equal(seen.tools.length, 2);
  assert.match(seen.tools[0], /▶ command: ls/);
  assert.match(seen.tools[1], /✓ command/);
  assert.deepEqual(seen.sessions, ['thread-9'], 'changed session id must fire onSessionId');
  assert.equal(r.full, 'HELLO');
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 4 });
  assert.equal(r.finishReason, '');
  assert.equal(r.sessionId, 'thread-9');
});

test('bridgeStream: first turn (no sessionId) captures it from the start event', async () => {
  captureFetch(() => sseResponse([
    'data: {"type":"start","sessionId":"thread-first","turnId":"t1"}\n\n',
    'data: {"type":"done","full":"ok"}\n\n',
  ]));
  const sessions = [];
  const r = await bridgeStream({
    baseUrl: '', text: 'x', onSessionId: (s) => sessions.push(s),
  });
  assert.deepEqual(sessions, ['thread-first']);
  assert.equal(r.sessionId, 'thread-first');
  assert.equal(r.full, 'ok');
});

test('bridgeStream: approval event maps to the card payload', async () => {
  captureFetch(() => sseResponse([
    'data: {"type":"approval","requestId":"900","tool":"command","command":"rm -rf /x","cwd":"/w"}\n\n',
    'data: {"type":"aborted"}\n\n',
  ]));
  const approvals = [];
  await bridgeStream({
    baseUrl: '', text: 'x',
    onApproval: (a) => approvals.push(a),
  });
  assert.deepEqual(approvals, [{ requestId: '900', tool: 'command', command: 'rm -rf /x', choices: ['once', 'always', 'deny'] }]);
});

test('bridgeStream: error event throws with the agent message', async () => {
  captureFetch(() => sseResponse([
    'data: {"type":"start","sessionId":"s1","turnId":"t1"}\n\n',
    'data: {"type":"error","message":"Not logged in"}\n\n',
  ]));
  await assert.rejects(
    () => bridgeStream({ baseUrl: '', text: 'x' }),
    /Not logged in/,
  );
});

test('bridgeStream: stream ending without a terminal event is an error', async () => {
  captureFetch(() => sseResponse(['data: {"type":"delta","text":"partial"}\n\n']));
  await assert.rejects(
    () => bridgeStream({ baseUrl: '', text: 'x' }),
    /without a terminal event/,
  );
});

test('bridgeStream: non-200 response throws with the status', async () => {
  captureFetch(() => new Response('nope', { status: 502 }));
  await assert.rejects(
    () => bridgeStream({ baseUrl: '', text: 'x' }),
    /bridge \/turns → 502/,
  );
});

test('bridgeStream: empty turn throws without fetching', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(() => bridgeStream({ baseUrl: '', text: '  ' }), /empty turn/);
  assert.equal(called, false);
});

test('bridgeStream: outer abort rejects with AbortError (no hang on a never-ending stream)', async () => {
  // Never-ending SSE body — the client's own abort race must terminate it
  // (aborting a fetch signal does not end reads on locally-constructed
  // Response bodies — the opencode-client lesson).
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({
    start(c) { controller = c; controller.enqueue(encoder.encode('data: {"type":"delta","text":"a"}\n\n')); },
  });
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const ctrl = new AbortController();
  const p = bridgeStream({ baseUrl: '', text: 'x', signal: ctrl.signal });
  const t = setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(() => p, (e) => e?.name === 'AbortError');
  clearTimeout(t);
  try { controller.close(); } catch (_) {}
});

test('pingBridge: /health ok:true is reachable; anything else is not', async () => {
  captureFetch((url) => {
    if (String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true, agent: 'codex', version: 'x', proto: 1 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  const r = await pingBridge({ baseUrl: '127.0.0.1:3948', apiKey: 'k' });
  assert.equal(r.ok, true);
  assert.equal(r.agent, 'codex');
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 });
  const bad = await pingBridge({ baseUrl: '' });
  assert.equal(bad.ok, false);
});

test('respondBridgeApproval: POST /approvals/:id with the choice', async () => {
  const calls = captureFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await respondBridgeApproval({ baseUrl: '', apiKey: 'k', requestId: '900', choice: 'once' });
  assert.equal(calls[0].url, 'http://127.0.0.1:3948/approvals/900');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { choice: 'once' });
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k');
});
