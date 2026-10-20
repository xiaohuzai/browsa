// test/bridge-client.test.mjs — lib/bridge-client.js against a scripted
// globalThis.fetch (locally-constructed SSE Responses; no server). Covers the
// wire contract browsa depends on: POST /turns body shape, auth header, event
// → callback mapping, session capture, heartbeat, abort, and error paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bridgeStream, pingBridge, respondBridgeApproval, renameBridgeSession, normalizeBridgeUrl } = await import('../lib/bridge-client.js');

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
    'data: {"type":"usage","prompt_tokens":10,"completion_tokens":4,"cached_tokens":6,"cache_write_tokens":2}\n\n',
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
  assert.deepEqual(r.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 6 },
    cache_write_tokens: 2,
  });
  assert.equal(r.finishReason, '');
  assert.equal(r.sessionId, 'thread-9');
});

test('bridgeStream: usage on done (the real adapter shape) is adopted with cache fields', async () => {
  captureFetch(() => sseResponse([
    'data: {"type":"start","sessionId":"thread-9","turnId":"t1"}\n\n',
    'data: {"type":"done","full":"OK","usage":{"prompt_tokens":100,"completion_tokens":20,"cached_tokens":80,"cache_write_tokens":5}}\n\n',
  ]));
  const r = await bridgeStream({
    baseUrl: 'http://127.0.0.1:3948', apiKey: 'tok-1', sessionId: 'thread-8', text: 'hi',
  });
  assert.deepEqual(r.usage, {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 80 },
    cache_write_tokens: 5,
  });
});

test('bridgeStream: note events ride the tool-progress line; done.full overrides the delta concat', async () => {
  // The 2026-10-06 codex narration leak: interim messages ("I'm using the X
  // skill…") stream as deltas like any other text, so the client-side concat
  // contains them; the daemon's note events surface them as agent process and
  // done.full (the agent's final message, commentary excluded) is what the
  // reply body must keep.
  const calls = captureFetch(() => sseResponse([
    'data: {"type":"start","sessionId":"thread-n","turnId":"t1"}\n\n',
    'data: {"type":"delta","text":"I\'m using the skill "}', '\n',
    'data: {"type":"delta","text":"to check workflows.\\n"}\n\n',
    'data: {"type":"tool","name":"command","status":"started","detail":"skill"}\n\n',
    'data: {"type":"note","text":"I\'m using the skill to check workflows.","phase":"commentary"}\n\n',
    'data: {"type":"delta","text":"Hi!"}\n\n',
    'data: {"type":"done","full":"Hi!"}\n\n',
  ]));
  const seen = { deltas: [], tools: [] };
  const r = await bridgeStream({
    baseUrl: 'http://127.0.0.1:3948', text: 'hi',
    onDelta: (t) => seen.deltas.push(t),
    onToolProgress: (s) => seen.tools.push(s),
  });
  assert.deepEqual(seen.tools, [
    '▶ command: skill',
    '💬 I\'m using the skill to check workflows.',
  ], 'note must ride the tool-progress surface with a 💬 marker');
  assert.equal(r.full, 'Hi!', 'done.full (final message) must replace the narration-polluted concat');
});

test('bridgeStream: empty done.full keeps the client concat (no-message turns)', async () => {
  captureFetch(() => sseResponse([
    'data: {"type":"delta","text":"partial "}\n\n',
    'data: {"type":"delta","text":"text"}\n\n',
    'data: {"type":"done","full":""}\n\n',
  ]));
  const r = await bridgeStream({ baseUrl: 'http://127.0.0.1:3948', text: 'hi', onDelta: () => {} });
  assert.equal(r.full, 'partial text');
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

// ─── image forwarding (wire v1: /turns {text, sessionId?, images?}) ──────────

test('bridgeStream: images ride in the POST body; junk filtered; wire-bound sliced; omitted when empty', async () => {
  const streamOk = () => sseResponse(['data: {"type":"done","full":"ok"}\n\n']);
  const IMG = (n) => `data:image/png;base64,${n}`;
  const capture = () => captureFetch(() => streamOk());

  // happy path: https + data URLs pass, junk dropped, wire bound (18, AGENT_TURN_MAX_IMAGES) applied
  let calls = capture();
  await bridgeStream({
    baseUrl: 'http://127.0.0.1:3948', text: 'q',
    images: [
      IMG('A'), 'https://example.com/x.jpg', 'not-a-url', '', 42,
      ...Array.from({ length: 20 }, (_, i) => IMG(i)),
    ],
  });
  let body = JSON.parse(calls[0].opts.body);
  assert.equal(body.images.length, 18); // 2 valid + first 16 of the overflow batch
  assert.deepEqual(body.images.slice(0, 2), [IMG('A'), 'https://example.com/x.jpg']);
  assert.ok(!body.images.includes('not-a-url'));

  // no images / empty array → no images key (pre-images body shape intact)
  calls = capture();
  await bridgeStream({ baseUrl: 'http://127.0.0.1:3948', text: 'q' });
  body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { text: 'q' });

  calls = capture();
  await bridgeStream({ baseUrl: 'http://127.0.0.1:3948', text: 'q', images: [] });
  body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { text: 'q' });
});

// ─── 跨入口接力：renameBridgeSession（2026-10-01） ──────────────────────────────

test('renameBridgeSession: POSTs /threads/:id/title with the bearer key, returns {ok,status}', async () => {
  let calls;
  calls = captureFetch((url, opts) => new Response('{}', { status: 200 }));
  const r = await renameBridgeSession({ baseUrl: 'http://127.0.0.1:3948', apiKey: 'sk-b', sessionId: 'thr-1', title: 'browsa：你好' });
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(calls[0].url, 'http://127.0.0.1:3948/threads/thr-1/title');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-b');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { title: 'browsa：你好' });
});

test('renameBridgeSession: 501 (agent without a rename channel) is a PERMANENT answer, not a throw', async () => {
  captureFetch(() => new Response('unsupported', { status: 501 }));
  const r = await renameBridgeSession({ baseUrl: 'http://127.0.0.1:3948', sessionId: 'thr-1', title: 'x' });
  assert.deepEqual(r, { ok: false, status: 501 });
});

test('renameBridgeSession: transport failure → status 0 (caller retries next turn); missing args → no call', async () => {
  captureFetch(() => { throw new Error('down'); });
  assert.deepEqual(await renameBridgeSession({ baseUrl: 'http://127.0.0.1:3948', sessionId: 't', title: 'x' }), { ok: false, status: 0 });
  let calls;
  calls = captureFetch(() => new Response('{}', { status: 200 }));
  await renameBridgeSession({ baseUrl: 'http://127.0.0.1:3948', sessionId: '', title: 'x' });
  await renameBridgeSession({ baseUrl: 'http://127.0.0.1:3948', sessionId: 't', title: '' });
  assert.equal(calls.length, 0, 'no fetch without sessionId AND title');
});

// ── 老桥降级重试（agent-bridge <0.8.0 对 >8 张图整轮 400）────────────────────

test('bridgeStream: >8 images against an OLD bridge (≤8 bound) → one fallback retry with first 8 + a text note', async () => {
  const calls = captureFetch((url, opts, cs) => {
    if (cs.length === 1) {
      return new Response(JSON.stringify({ ok: false, error: 'images must be an array of ≤8 URL strings' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return sseResponse([
      'data: {"type":"start","sessionId":"th","turnId":"t1"}\n\n',
      'data: {"type":"done","full":"收到8张"}\n\n',
    ]);
  });
  const imgs = Array.from({ length: 12 }, (_, i) => `data:image/jpeg;base64,IMG${String(i).padStart(2, '0')}`);
  const r = await bridgeStream({ baseUrl: 'http://127.0.0.1:3948', text: '看图', images: imgs });
  assert.equal(calls.length, 2, '恰好一次重试');
  const first = JSON.parse(calls[0].opts.body);
  assert.equal(first.images.length, 12, '首轮按新上限全量发送');
  const second = JSON.parse(calls[1].opts.body);
  assert.equal(second.images.length, 8, '重试只送前 8 张');
  assert.deepEqual(second.images, imgs.slice(0, 8));
  assert.match(second.text, /agent-bridge 版本较旧/, ' shortfall 以模型可见注记随行');
  assert.match(second.text, /其余 4 张未随行/);
  assert.equal(r.full, '收到8张');
});

test('bridgeStream: 400 without the images-bound message does NOT retry (genuine error surfaces)', async () => {
  const calls = captureFetch(() => new Response(JSON.stringify({ ok: false, error: 'text required' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }));
  const imgs = Array.from({ length: 12 }, (_, i) => `data:image/jpeg;base64,IMG${i}`);
  await assert.rejects(
    bridgeStream({ baseUrl: 'http://127.0.0.1:3948', text: '看图', images: imgs }),
    /bridge \/turns → 400/
  );
  assert.equal(calls.length, 1, '非图片上限的 400 不重试');
});
