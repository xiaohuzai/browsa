// Unit tests for lib/opencode-client.js — the opencode agent-provider
// protocol client. All HTTP is mocked with a scripted fetch router (no
// chrome.* and no real server): global /api/event SSE is a ReadableStream,
// /api/session/active polls are scripted, and every test asserts on the
// recorded fetch calls (endpoint + body). Behavioral ground truth for the
// wire contract was established by live probing opencode 1.18.29 (see the
// module comment in opencode-client.js).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpencodeUrl,
  buildOpencodeTurn,
  pingOpencode,
  createOpencodeSession,
  respondOpencodePermission,
  respondOpencodeQuestion,
  opencodeStream,
} from '../lib/opencode-client.js';

const SES = 'ses_test123';
const now = Date.now();
const PCP = '[Page context attached by browsa]';
const ev = (type, data) => `data: ${JSON.stringify({ id: 'evt_x', type, data: { timestamp: now, sessionID: SES, ...data } })}\n\n`;

function sseResponse(lines, { holdOpen = true } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      if (!holdOpen) c.close();
    },
    cancel() {},
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** Install a scripted fetch. `routes` maps an url-match substring → handler
 * (url, opts) => Response. Every call is recorded in `calls`. Returns
 * { calls, restore }. */
function installFetch(routes) {
  const orig = globalThis.fetch;
  const calls = [];
  const impl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? String(opts.body) : null, headers: opts.headers || {} });
    for (const [match, handler] of Object.entries(routes)) {
      if (u.includes(match)) return handler(u, opts, calls);
    }
    return new Response('not found', { status: 404 });
  };
  globalThis.fetch = impl;
  return {
    calls,
    restore() { globalThis.fetch = orig; },
  };
}

test('normalizeOpencodeUrl', () => {
  assert.equal(normalizeOpencodeUrl(''), 'http://127.0.0.1:4096');
  assert.equal(normalizeOpencodeUrl(null), 'http://127.0.0.1:4096');
  assert.equal(normalizeOpencodeUrl('127.0.0.1:4096/'), 'http://127.0.0.1:4096');
  assert.equal(normalizeOpencodeUrl('http://localhost:5555/'), 'http://localhost:5555');
  assert.equal(normalizeOpencodeUrl('https://oc.example.com/some/path?x=1'), 'https://oc.example.com');
});

test('buildOpencodeTurn — plain user turn only, never full history', () => {
  const history = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ];
  assert.equal(buildOpencodeTurn({ userText: 'third question' }, history), 'third question');
});

test('buildOpencodeTurn — forwards trailing page-context run + user text', () => {
  // The NEW user turn is NOT in history yet (handleChat appends it after
  // building the request) — the trailing run here is the attach turn(s).
  const history = [
    { role: 'user', content: 'earlier chat the agent already knows' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '[Page context attached by browsa] page A text' },
    { role: 'user', content: '[Page context attached by browsa] page B text' },
  ];
  const out = buildOpencodeTurn({ userText: '现在总结一下' }, history);
  assert.match(out, /page A text/);
  assert.match(out, /page B text/);
  assert.match(out, /现在总结一下/);
  assert.ok(!out.includes('earlier chat'));
  // suppress-refetch directive rides along
  assert.match(out, /不要重新访问/);
});

test('buildOpencodeTurn — interleaved array parts are fully joined', () => {
  const history = [
    { role: 'user', content: [
      { type: 'text', text: '[Page context attached by browsa] title' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: '[图1] caption' },
    ] },
  ];
  const out = buildOpencodeTurn({ userText: '讲讲' }, history);
  assert.match(out, /title/);
  assert.match(out, /\[图1\] caption/);
  assert.ok(!out.includes('data:image')); // images not forwarded in v1
});

test('pingOpencode — healthy true/false', async () => {
  const ff = installFetch({
    '/api/health': () => jsonResponse({ healthy: true }),
  });
  try {
    assert.deepEqual(await pingOpencode({ baseUrl: 'http://127.0.0.1:4096' }), { ok: true, url: 'http://127.0.0.1:4096' });
    assert.equal(ff.calls[0].url, 'http://127.0.0.1:4096/api/health');
  } finally { ff.restore(); }

  const f2 = installFetch({
    '/api/health': () => new Response('nope', { status: 503 }),
  });
  try {
    const r = await pingOpencode({ baseUrl: 'http://127.0.0.1:4096' });
    assert.equal(r.ok, false);
    assert.match(r.error, /503/);
  } finally { f2.restore(); }
});

test('createOpencodeSession — returns server-assigned id', async () => {
  const ff = installFetch({
    '/api/session': (u, o) => {
      assert.equal(o.method, 'POST');
      return jsonResponse({ data: { id: 'ses_new456' } });
    },
  });
  try {
    const id = await createOpencodeSession({ baseUrl: 'http://127.0.0.1:4096', title: 'hello' });
    assert.equal(id, 'ses_new456');
    assert.match(ff.calls[0].body, /"title":"hello"/);
  } finally { ff.restore(); }
});

test('opencodeStream — happy path: prompt, deltas, active-poll completion, final message', async () => {
  const seen = [];
  const ff = installFetch({
    '/prompt': () => jsonResponse({ data: { id: 'msg_u' } }),
    '/api/event': () => sseResponse([
      ev('session.next.prompted'),
      ev('session.next.text.delta', { delta: '你好' }),
      ev('session.next.text.delta', { delta: '，世界' }),
      ev('session.next.step.ended', { finish: 'stop' }),
    ]),
    '/api/session/active': () => {
      seen.push(1);
      // first poll: still running; afterwards: gone
      return jsonResponse({ data: seen.length === 1 ? { [SES]: { type: 'running' } } : {} });
    },
    "/message": () => jsonResponse({ data: [
      { type: 'user', content: [{ type: 'text', text: 'q' }] },
      { type: 'assistant', content: [{ type: 'text', text: '你好，世界' }], tokens: { input: 10, output: 5 }, finish: 'stop' },
    ] }),
  });
  const deltas = [];
  try {
    const r = await opencodeStream({
      baseUrl: 'http://127.0.0.1:4096', sessionId: SES, text: 'q',
      onDelta: (d) => deltas.push(d),
      signal: new AbortController().signal,
      _pollIntervalMs: 5,
    });
    assert.deepEqual(deltas, ['你好', '，世界']);
    assert.equal(r.full, '你好，世界');   // final message is authoritative
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.sessionId, SES);
    assert.ok(ff.calls.some(c => c.url.includes('/prompt') && c.body.includes('"text":"q"')));
  } finally { ff.restore(); }
});

test('opencodeStream — permission.asked surfaces as approval payload', async () => {
  let approval = null;
  const ff = installFetch({
    '/prompt': () => jsonResponse({ data: {} }),
    '/api/event': () => sseResponse([
      ev('permission.v2.asked', { id: 'per_1', action: 'bash', resources: ['echo hi'], save: ['echo hi'] }),
      ev('session.next.step.ended', { finish: 'stop' }),
    ]),
    '/api/session/active': () => jsonResponse({ data: (++polls < 3 ? { [SES]: { type: 'running' } } : {}) }),
    '/message': () => jsonResponse({ data: [{ type: 'assistant', content: [{ type: 'text', text: 'ran' }], finish: 'stop' }] }),
  });
  let polls = 0;
  try {
    await opencodeStream({
      baseUrl: 'http://127.0.0.1:4096', sessionId: SES, text: 'q',
      onApproval: (d) => { approval = d; },
      signal: new AbortController().signal,
      _pollIntervalMs: 5,
    });
    assert.equal(approval.requestId, 'per_1');
    assert.equal(approval.tool, 'bash');
    assert.equal(approval.command, 'echo hi');
    assert.deepEqual(approval.choices, ['once', 'always', 'deny']);
  } finally { ff.restore(); }
});

test('opencodeStream — question.asked surfaces as clarify payload', async () => {
  let clarify = null;
  const ff = installFetch({
    '/prompt': () => jsonResponse({ data: {} }),
    '/api/event': () => sseResponse([
      ev('question.v2.asked', { id: 'que_1', questions: [{ header: 'Scope', question: 'Which files?', options: [{ label: 'A' }, { label: 'B' }] }] }),
      ev('session.next.step.ended', { finish: 'stop' }),
    ]),
    '/api/session/active': () => jsonResponse({ data: (++polls < 3 ? { [SES]: { type: 'running' } } : {}) }),
    '/message': () => jsonResponse({ data: [{ type: 'assistant', content: [{ type: 'text', text: 'done' }], finish: 'stop' }] }),
  });
  let polls = 0;
  try {
    await opencodeStream({
      baseUrl: 'http://127.0.0.1:4096', sessionId: SES, text: 'q',
      onClarify: (d) => { clarify = d; },
      signal: new AbortController().signal,
      _pollIntervalMs: 5,
    });
    assert.equal(clarify.requestId, 'que_1');
    assert.match(clarify.question, /Scope：Which files\?/);
  } finally { ff.restore(); }
});

test('opencodeStream — session.error rejects with the message', async () => {
  const ff = installFetch({
    '/prompt': () => jsonResponse({ data: {} }),
    '/api/event': () => sseResponse([
      ev('session.error', { error: { type: 'ProviderAuthError', message: 'bad api key' } }),
    ]),
    '/api/session/active': () => jsonResponse({ data: {} }),
  });
  try {
    await assert.rejects(
      opencodeStream({
        baseUrl: 'http://127.0.0.1:4096', sessionId: SES, text: 'q',
        signal: new AbortController().signal,
        _pollIntervalMs: 5,
      }),
      /bad api key/,
    );
  } finally { ff.restore(); }
});

test('opencodeStream — replayed (stale timestamp) events are ignored', async () => {
  let deltas = 0;
  const stale = `data: ${JSON.stringify({ id: 'evt_old', type: 'session.next.text.delta', data: { timestamp: now - 60_000, sessionID: SES, delta: 'OLD' } })}\n\n`;
  const ff = installFetch({
    '/prompt': () => jsonResponse({ data: {} }),
    '/api/event': () => sseResponse([stale, ev('session.next.step.ended', { finish: 'stop' })]),
    '/api/session/active': () => jsonResponse({ data: (++polls < 2 ? { [SES]: { type: 'running' } } : {}) }),
    '/message': () => jsonResponse({ data: [{ type: 'assistant', content: [{ type: 'text', text: 'fresh only' }], finish: 'stop' }] }),
  });
  let polls = 0;
  try {
    const r = await opencodeStream({
      baseUrl: 'http://127.0.0.1:4096', sessionId: SES, text: 'q',
      onDelta: () => { deltas++; },
      signal: new AbortController().signal,
      _pollIntervalMs: 5,
    });
    assert.equal(deltas, 0);
    assert.equal(r.full, 'fresh only');
  } finally { ff.restore(); }
});

test('opencodeStream — outer abort fires server interrupt and rejects AbortError', async () => {
  const ac = new AbortController();
  const ff = installFetch({
    '/prompt': () => jsonResponse({ data: {} }),
    '/api/event': () => sseResponse([]), // silent stream
    '/api/session/active': () => jsonResponse({ data: { [SES]: { type: 'running' } } }),
    '/interrupt': (u, o, calls) => { ac.abort(); return jsonResponse({}); },
  });
  try {
    setTimeout(() => { if (!ac.signal.aborted) ac.abort(); }, 120);
    await assert.rejects(
      opencodeStream({
        baseUrl: 'http://127.0.0.1:4096', sessionId: SES, text: 'q',
        signal: ac.signal,
        _pollIntervalMs: 10,
      }),
      (e) => e?.name === 'AbortError',
    );
    assert.ok(ff.calls.some(c => c.url.includes('/interrupt')), 'interrupt endpoint called');
  } finally { ff.restore(); }
});

test('respond helpers hit the reply endpoints with the right bodies', async () => {
  const ff = installFetch({
    '/permission/per_9/reply': (u, o) => { assert.equal(o.method, 'POST'); assert.match(o.body, /"reply":"once"/); return jsonResponse({}); },
    '/question/que_9/reply': (u, o) => { assert.match(o.body, /"answers":\[\["自定义"\]\]/); return jsonResponse({}); },
  });
  try {
    await respondOpencodePermission({ baseUrl: 'http://127.0.0.1:4096', sessionId: SES, requestId: 'per_9', reply: 'once' });
    await respondOpencodeQuestion({ baseUrl: 'http://127.0.0.1:4096', sessionId: SES, requestId: 'que_9', answers: [['自定义']] });
    assert.equal(ff.calls.length, 2);
    assert.match(ff.calls[0].url, /\/api\/session\/ses_test123\/permission\/per_9\/reply/);
    assert.match(ff.calls[1].url, /\/api\/session\/ses_test123\/question\/que_9\/reply/);
  } finally { ff.restore(); }
});
