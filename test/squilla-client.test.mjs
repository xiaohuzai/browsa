// test/squilla-client.test.mjs
// Unit tests for the OpenSquilla gateway WebSocket client
// (lib/squilla-client.js) — squillaStream() + createSquillaSession() +
// pingSquilla() + normalizeSquillaUrl(). The gateway's frame protocol is
// scripted with a MockWebSocket: challenge → connect → hello-ok →
// sessions.messages.subscribe → sessions.send → session.event.* stream.
// Mirrors the approach of test/runs-api.test.mjs (mock the transport
// globals, drive the real client).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome stub: squilla-client.js itself never touches chrome, but
// importing buildSquillaTurn from chat-handler.js pulls in storage.js
// et al., which are import-safe but are kept honest by the same convention
// as the rest of this suite (mock chrome before import).
Object.defineProperty(globalThis, 'chrome', {
  value: { storage: { session: { get: async () => ({}), set: async () => {} } } },
  writable: true,
  configurable: true,
});

class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  static respond = null; // (ws, frame) => [frames to push back]

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.listeners = {};
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  _emit(type, ev = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(ev); }

  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (MockWebSocket.respond) {
      for (const reply of MockWebSocket.respond(this, frame) || []) this.serverSend(reply);
    }
  }

  close() {
    if (this.readyState >= MockWebSocket.CLOSING) return;
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this._emit('close'));
  }

  // ---- server-side helpers (drive the fake gateway) ----
  serverOpen() { this.readyState = MockWebSocket.OPEN; queueMicrotask(() => this._emit('open')); }
  serverSend(obj) { queueMicrotask(() => this._emit('message', { data: JSON.stringify(obj) })); }
  serverFail() { queueMicrotask(() => this._emit('error')); }
}

const flush = () => new Promise(r => setTimeout(r, 0));

// Install the mock as the global WebSocket BEFORE any client call — the
// client resolves `new WebSocket` at call time. Without this the tests would
// silently hit the developer's real local gateway.
globalThis.WebSocket = MockWebSocket;

// A scripted gateway: auto-answers connect/subscribe/send and pushes
// `events` (frames) after the send is accepted.
function scriptGateway({ events = [], taskId = 'task-1', helloVersion = '0.5.4' } = {}) {
  MockWebSocket.instances = [];
  let accepted = false;
  MockWebSocket.respond = (ws, frame) => {
    if (frame.method === 'connect') {
      return [{ type: 'hello-ok', protocol: 4, server: { version: helloVersion, conn_id: 'c1' }, features: { methods: ['sessions.send'] } }];
    }
    if (frame.method === 'sessions.create') {
      return [{ type: 'res', id: frame.id, ok: true, payload: { key: 'agent:main:cli:deadbeef', sessionId: 'deadbeef' } }];
    }
    if (frame.method === 'sessions.messages.subscribe') {
      return [{ type: 'res', id: frame.id, ok: true, payload: { subscribed: true, current_stream_seq: 1 } }];
    }
    if (frame.method === 'sessions.send') {
      accepted = true;
      return [{ type: 'res', id: frame.id, ok: true, payload: { ok: true, status: 'accepted', task_id: taskId } }];
    }
    if (frame.method === 'chat.abort') {
      return [{ type: 'res', id: frame.id, ok: true, payload: { aborted: true } }];
    }
    if (accepted && frame.method === 'agent.identity.get') {
      return [{ type: 'res', id: frame.id, ok: true, payload: {} }]; // keepalive reply — must be ignored
    }
    return [];
  };
  // Push the challenge the moment the socket opens.
  const origServerOpen = MockWebSocket.prototype.serverOpen;
  MockWebSocket.prototype.serverOpen = function () {
    origServerOpen.call(this);
    queueMicrotask(() => this.serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' }, seq: 1 }));
  };
  // Deferred event push: the test calls pushEvents() once the send landed.
  return {
    pushEvents() {
      const ws = MockWebSocket.instances[0];
      for (const ev of events) ws.serverSend(ev);
    },
    restore() { MockWebSocket.prototype.serverOpen = origServerOpen; MockWebSocket.respond = null; },
  };
}

function lastSocket() { return MockWebSocket.instances[MockWebSocket.instances.length - 1]; }

test('normalizeSquillaUrl: http→ws / https→wss, bare hosts get ws:// and the /ws path', async () => {
  const { normalizeSquillaUrl } = await import('../lib/squilla-client.js');
  assert.equal(normalizeSquillaUrl('ws://127.0.0.1:18791/ws'), 'ws://127.0.0.1:18791/ws');
  assert.equal(normalizeSquillaUrl('http://127.0.0.1:18791'), 'ws://127.0.0.1:18791/ws');
  assert.equal(normalizeSquillaUrl('https://gw.example'), 'wss://gw.example/ws');
  assert.equal(normalizeSquillaUrl('127.0.0.1:18791'), 'ws://127.0.0.1:18791/ws');
  assert.equal(normalizeSquillaUrl('ws://127.0.0.1:18792/gateway'), 'ws://127.0.0.1:18792/gateway');
});

test('squillaStream: full handshake + turn — connect frame shape, delta stream, terminal resolution', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({
    events: [
      { type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: 'hello ' }, seq: 2 },
      { type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: 'world' }, seq: 3 },
      { type: 'event', event: 'session.event.done', payload: { task_id: 'task-1' }, seq: 4 },
    ],
  });

  const deltas = [];
  let seenTaskId = null;
  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', apiKey: '', message: 'hi', sessionKey: 'agent:main:cli:s1',
    attachments: [{ type: 'image/jpeg', mime: 'image/jpeg', name: 'page-figure-1.jpg', data: '/9j/4AAQ' }],
    onDelta: (d) => deltas.push(d),
    onTaskId: (t) => { seenTaskId = t; },
  });

  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();

  const result = await resultP;
  const ws = lastSocket();
  const methods = ws.sent.filter(f => f.type === 'req').map(f => f.method);

  // Handshake: connect first (with protocol bounds), then subscribe, then send.
  assert.deepEqual(methods, ['connect', 'sessions.messages.subscribe', 'sessions.send']);
  const connect = ws.sent[0];
  assert.equal(connect.id, 'connect');
  assert.equal(connect.params.minProtocol, 1);
  assert.ok(connect.params.maxProtocol >= 4, 'must offer the gateway protocol version');

  const subscribe = ws.sent[1];
  assert.equal(subscribe.params.key, 'agent:main:cli:s1');

  const send = ws.sent[2];
  assert.equal(send.method, 'sessions.send');
  assert.equal(send.params.message, 'hi');
  assert.equal(send.params.key, 'agent:main:cli:s1');
  assert.ok(send.params.clientRequestId, 'clientRequestId required for idempotency');
  // The cli source declaration is load-bearing: without it the gateway
  // classifies browsa as a web caller and rewrites large pastes (>=8k chars
  // with page-dump markers) into a preview-only attachment — the model then
  // never sees the attached page content.
  assert.deepEqual(send.params._source, { caller_kind: 'cli', channel_kind: 'cli' });
  // Figure images ride along as inline base64 attachments (gateway ingest
  // decodes data with base64.b64decode and routes image/* as rendered family).
  assert.deepEqual(send.params.attachments,
    [{ type: 'image/jpeg', mime: 'image/jpeg', name: 'page-figure-1.jpg', data: '/9j/4AAQ' }]);

  // Delta + terminal bookkeeping.
  assert.equal(seenTaskId, 'task-1');
  assert.deepEqual(deltas, ['hello ', 'world']);
  assert.equal(result.full, 'hello world');
  assert.equal(result.finishReason, 'completed');

  // Keepalive replies (agent.identity.get) must not have confused the event
  // loop — asserted implicitly by the clean resolution above.
  gw.restore();
});

test('squillaStream: apiKey is sent as auth.token in the connect params', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({ events: [{ type: 'event', event: 'session.event.done', payload: {} }] });

  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', apiKey: 'sk-secret', message: 'hi', sessionKey: 'k',
  });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();
  await resultP;

  const connect = lastSocket().sent[0];
  assert.deepEqual(connect.params.auth, { token: 'sk-secret' });
  gw.restore();
});

test('squillaStream: events of another task in the same session are ignored', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({
    events: [
      { type: 'event', event: 'session.event.text_delta', payload: { task_id: 'other-task', text: 'NOT MINE' }, seq: 2 },
      { type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: 'mine' }, seq: 3 },
      { type: 'event', event: 'session.event.done', payload: { task_id: 'task-1' }, seq: 4 },
    ],
  });

  const deltas = [];
  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k', onDelta: (d) => deltas.push(d),
  });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();
  const result = await resultP;

  assert.deepEqual(deltas, ['mine']);
  assert.equal(result.full, 'mine');
  gw.restore();
});

test('squillaStream: thinking deltas are wrapped in a <thinking> block that closes on text', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({
    events: [
      { type: 'event', event: 'thinking', payload: { task_id: 'task-1', text: 'let me think' } },
      { type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: 'answer' } },
      { type: 'event', event: 'session.event.done', payload: { task_id: 'task-1' } },
    ],
  });

  const deltas = [];
  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k', onDelta: (d) => deltas.push(d),
  });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();
  const result = await resultP;

  assert.ok(result.full.includes('<thinking>\nlet me think\n</thinking>\n'), JSON.stringify(result.full));
  assert.ok(result.full.endsWith('answer'));
  gw.restore();
});

test('squillaStream: sessions.changed task_terminal(status succeeded) is a terminal', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({
    events: [
      { type: 'event', event: 'sessions.changed', payload: { reason: 'task_terminal', status: 'done', last_task: { task_id: 'task-1', status: 'succeeded' } } },
    ],
  });

  const resultP = squillaStream({ baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k' });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();
  const result = await resultP;
  assert.equal(result.finishReason, 'completed');
  gw.restore();
});

test('squillaStream: task.failed / failed terminal reject with ProviderAPIError', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');

  for (const events of [
    [{ type: 'event', event: 'task.failed', payload: { task_id: 'task-1', error: 'provider exploded' } }],
    [{ type: 'event', event: 'sessions.changed', payload: { reason: 'task_terminal', last_task: { task_id: 'task-1', status: 'failed' } } }],
  ]) {
    const gw = scriptGateway({ events });
    const resultP = squillaStream({ baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k' });
    await flush();
    lastSocket().serverOpen();
    await flush();
    await flush();
    gw.pushEvents();
    await assert.rejects(() => resultP, /provider exploded|task failed/i);
    gw.restore();
  }
});

test('squillaStream: task.cancelled rejects with AbortError', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({
    events: [{ type: 'event', event: 'task.cancelled', payload: { task_id: 'task-1' } }],
  });
  const resultP = squillaStream({ baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k' });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();
  await assert.rejects(() => resultP, (e) => e.name === 'AbortError');
  gw.restore();
});

test('squillaStream: user abort sends chat.abort over the socket, then rejects with AbortError (no phantom history)', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({
    events: [
      { type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: 'partial' }, seq: 2 },
    ],
  });

  const controller = new AbortController();
  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'agent:main:cli:s9', signal: controller.signal,
  });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  gw.pushEvents();
  await flush(); // let the first delta land
  await flush();

  controller.abort('user-cancel');

  await assert.rejects(() => resultP, (e) => e.name === 'AbortError');
  const abortFrames = lastSocket().sent.filter(f => f.method === 'chat.abort');
  assert.equal(abortFrames.length, 1, 'exactly one server-side chat.abort must be sent');
  assert.equal(abortFrames[0].params.sessionKey, 'agent:main:cli:s9');
  gw.restore();
});

test('squillaStream: gateway error res on sessions.send rejects with ProviderAPIError', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  MockWebSocket.instances = [];
  MockWebSocket.respond = (ws, frame) => {
    if (frame.method === 'connect') {
      return [{ type: 'hello-ok', protocol: 4, server: { version: '0.5.4', conn_id: 'c' }, features: {} }];
    }
    if (frame.method === 'sessions.messages.subscribe') {
      return [{ type: 'res', id: frame.id, ok: true, payload: {} }];
    }
    if (frame.method === 'sessions.send') {
      return [{ type: 'res', id: frame.id, ok: false, error: { code: 'QUEUE_FULL', message: 'queue full' } }];
    }
    return [];
  };
  const origServerOpen = MockWebSocket.prototype.serverOpen;
  MockWebSocket.prototype.serverOpen = function () {
    origServerOpen.call(this);
    queueMicrotask(() => this.serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' }, seq: 1 }));
  };

  const resultP = squillaStream({ baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k' });
  // Attach the rejection expectation immediately: the rejection fires while
  // the test is still driving the socket, and a late handler would trip
  // Node's unhandled-rejection detection.
  const rejectionP = assert.rejects(() => resultP, (e) => e.name === 'ProviderAPIError' && /QUEUE_FULL/.test(e.message));
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();

  await rejectionP;
  MockWebSocket.prototype.serverOpen = origServerOpen;
  MockWebSocket.respond = null;
});

test('squillaStream: rejected WebSocket handshake (origin guard 403) rejects with ProviderNetworkError', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  MockWebSocket.instances = [];
  MockWebSocket.respond = null;
  const resultP = squillaStream({ baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k' });
  await flush();
  lastSocket().serverFail();
  await assert.rejects(() => resultP, (e) => e.name === 'ProviderNetworkError' && /handshake failed/.test(e.message));
});

test('pingSquilla: returns a version summary after a successful handshake', async () => {
  const { pingSquilla } = await import('../lib/squilla-client.js');
  const gw = scriptGateway({ helloVersion: '0.5.4' });
  const resultP = pingSquilla({ baseUrl: 'ws://127.0.0.1:18791/ws' });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  const reply = await resultP;
  assert.match(reply, /ok — gateway v0\.5\.4/);
  gw.restore();
});

test('squillaStream: image_input_unsupported failure retries once without attachments', async () => {
  const { squillaStream } = await import('../lib/squilla-client.js');
  MockWebSocket.instances = [];
  let sendCount = 0;
  MockWebSocket.respond = (ws, frame) => {
    if (frame.method === 'connect') {
      return [{ type: 'hello-ok', protocol: 4, server: { version: '0.5.4', conn_id: 'c' }, features: {} }];
    }
    if (frame.method === 'sessions.messages.subscribe') {
      return [{ type: 'res', id: frame.id, ok: true, payload: {} }];
    }
    if (frame.method === 'sessions.send') {
      sendCount += 1;
      const taskId = sendCount === 1 ? 't-img' : 't-text';
      return [{ type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', task_id: taskId } }];
    }
    return [];
  };
  const origServerOpen = MockWebSocket.prototype.serverOpen;
  MockWebSocket.prototype.serverOpen = function () {
    origServerOpen.call(this);
    queueMicrotask(() => this.serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' }, seq: 1 }));
  };

  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k',
    attachments: [{ type: 'image/png', mime: 'image/png', name: 'red.png', data: 'iVBOR' }],
  });
  const drive = (async () => {
    await flush(); lastSocket().serverOpen(); await flush(); await flush();
    const ws = lastSocket();
    // 第一轮：模型拒绝图片输入（gateway 的干净失败）
    ws.serverSend({ type: 'event', event: 'sessions.changed', payload: { reason: 'task_terminal', last_task: { task_id: 't-img', status: 'failed', error_message: 'image_input_unsupported: The selected model cannot process image input.' } } });
    await flush(); await flush();
    // 第二轮：纯文字成功
    ws.serverSend({ type: 'event', event: 'session.event.text_delta', payload: { task_id: 't-text', text: 'text answer' } });
    ws.serverSend({ type: 'event', event: 'session.event.done', payload: { task_id: 't-text' } });
  })();
  const result = await resultP;
  await drive;

  const sendFrames = lastSocket().sent.filter(f => f.method === 'sessions.send');
  assert.equal(sendFrames.length, 2, 'exactly one retry');
  assert.ok(sendFrames[0].params.attachments?.length, 'first attempt carries the images');
  assert.equal(sendFrames[1].params.attachments, undefined, 'retry goes out text-only');
  assert.equal(result.full, 'text answer');
  MockWebSocket.prototype.serverOpen = origServerOpen;
  MockWebSocket.respond = null;
});

test('squillaStream: attachments + failure WITHOUT a reason string still retries text-only (field case)', async () => {
  // 2026-09-01 field report: the gateway's terminal event carried NO reason
  // (details only in its server log), so the reason-string matcher missed
  // and a text-only model surfaced a bare "OpenSquilla task failed". The
  // retry must key on "images sent + zero deltas", not on the reason text.
  const { squillaStream } = await import('../lib/squilla-client.js');
  MockWebSocket.instances = [];
  let sendCount = 0;
  MockWebSocket.respond = (ws, frame) => {
    if (frame.method === 'connect') {
      return [{ type: 'hello-ok', protocol: 4, server: { version: '0.5.4', conn_id: 'c' }, features: {} }];
    }
    if (frame.method === 'sessions.messages.subscribe') {
      return [{ type: 'res', id: frame.id, ok: true, payload: {} }];
    }
    if (frame.method === 'sessions.send') {
      sendCount += 1;
      const taskId = sendCount === 1 ? 't-img' : 't-text';
      return [{ type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', task_id: taskId } }];
    }
    return [];
  };
  const origServerOpen = MockWebSocket.prototype.serverOpen;
  MockWebSocket.prototype.serverOpen = function () {
    origServerOpen.call(this);
    queueMicrotask(() => this.serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' }, seq: 1 }));
  };

  const resultP = squillaStream({
    baseUrl: 'ws://127.0.0.1:18791/ws', message: 'hi', sessionKey: 'k',
    attachments: [{ type: 'image/png', mime: 'image/png', name: 'red.png', data: 'iVBOR' }],
  });
  const drive = (async () => {
    await flush(); lastSocket().serverOpen(); await flush(); await flush();
    const ws = lastSocket();
    // 失败事件不带任何原因字段（正是现场形态）
    ws.serverSend({ type: 'event', event: 'sessions.changed', payload: { reason: 'task_terminal', last_task: { task_id: 't-img', status: 'failed' } } });
    await flush(); await flush();
    ws.serverSend({ type: 'event', event: 'session.event.text_delta', payload: { task_id: 't-text', text: 'text answer' } });
    ws.serverSend({ type: 'event', event: 'session.event.done', payload: { task_id: 't-text' } });
  })();
  const result = await resultP;
  await drive;

  const sendFrames = lastSocket().sent.filter(f => f.method === 'sessions.send');
  assert.equal(sendFrames.length, 2, 'one text-only retry');
  assert.equal(sendFrames[1].params.attachments, undefined);
  assert.equal(result.full, 'text answer');
  MockWebSocket.prototype.serverOpen = origServerOpen;
  MockWebSocket.respond = null;
});

test('uploadSquillaFile: posts multipart to the HTTP origin and returns file_uuid', async () => {
  const { uploadSquillaFile } = await import('../lib/squilla-client.js');
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ file_uuid: 'u-123', filename: 'page-context.md' }) };
  };
  try {
    const uuid = await uploadSquillaFile({
      baseUrl: 'wss://gw.example/ws', apiKey: 'tk',
      name: 'page-context.md', mime: 'text/markdown', content: '# hello',
    });
    assert.equal(uuid, 'u-123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gw.example/api/v1/files/upload', 'ws(s) must map to http(s) and drop the /ws path');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tk');
    const file = calls[0].opts.body.get('file');
    assert.equal(file.name, 'page-context.md');
    assert.equal(await file.text(), '# hello');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('createSquillaSession: returns the gateway-assigned cli session key', async () => {
  const { createSquillaSession } = await import('../lib/squilla-client.js');
  const gw = scriptGateway();
  const resultP = createSquillaSession({ baseUrl: 'ws://127.0.0.1:18791/ws' });
  await flush();
  lastSocket().serverOpen();
  await flush();
  await flush();
  const key = await resultP;
  assert.equal(key, 'agent:main:cli:deadbeef', 'the gateway-assigned session key must be returned');
  const create = lastSocket().sent.find(f => f.method === 'sessions.create');
  assert.equal(create.params.agentId, 'main');
  assert.equal(create.params.kind, 'cli');
  gw.restore();
});

test('buildSquillaTurn: prepends the language directive, trims, and joins', async () => {
  const { buildSquillaTurn } = await import('../lib/handlers/chat-handler.js');
  assert.equal(buildSquillaTurn({ userText: 'hi' }, '', []).message, 'hi');
  assert.equal(buildSquillaTurn({ userText: 'hi' }, '请始终用中文回答。', []).message, '请始终用中文回答。\n\nhi');
  assert.equal(buildSquillaTurn({ userText: '  padded  ' }, '', []).message, 'padded');
  assert.equal(buildSquillaTurn({}, '', []).message, '');
  assert.deepEqual(buildSquillaTurn({ userText: 'hi' }, '', []).attachments, []);
});

test('buildSquillaTurn: forwards page context exactly when the attach is the latest turn', async () => {
  const { buildSquillaTurn } = await import('../lib/handlers/chat-handler.js');
  const { PAGE_CONTEXT_PREFIX } = await import('../lib/constants.js');
  const ctx = PAGE_CONTEXT_PREFIX + '# Page\n\nSome page content.';
  const ask = { userText: '总结这一页' };

  // Attach directly before the question → context is forwarded (gateway has
  // never seen it; this is the one chance to hand it over).
  const { message: withCtx } = buildSquillaTurn(ask, '', [{ role: 'user', content: ctx }]);
  assert.ok(withCtx.startsWith(ctx), 'page context must be forwarded');
  assert.ok(withCtx.endsWith('总结这一页'));

  // Array-part shape (text + images turn) is recognized too.
  const { message: arrCtx } = buildSquillaTurn(ask, '', [
    { role: 'user', content: [{ type: 'text', text: ctx }, { type: 'image_url', image_url: { url: 'data:...' } }] },
  ]);
  assert.ok(arrCtx.startsWith(ctx));

  // REGRESSION (2026-09-01): interleaved figure entries split the text into
  // MULTIPLE text parts ([图N] anchors) — every segment must be forwarded,
  // not just the first (which is only title + figure-1 caption).
  const seg1 = PAGE_CONTEXT_PREFIX + '# 章节标题\n\n开头段落。\n\n[图1] 某图注';
  const seg2 = '中段正文，讨论数据重力。';
  const seg3 = '结尾正文，讨论数据债务。';
  const redJpeg = 'data:image/jpeg;base64,/9j/4AAQ';
  const { message: inter, attachments: interAtt } = buildSquillaTurn(ask, '', [
    { role: 'user', content: [
      { type: 'text', text: seg1 },
      { type: 'image_url', image_url: { url: redJpeg } },
      { type: 'text', text: seg2 },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
      { type: 'text', text: seg3 },
    ] },
  ]);
  assert.ok(inter.includes('开头段落') && inter.includes('中段正文') && inter.includes('结尾正文'),
    'all text segments of an interleaved attach must be forwarded');
  assert.ok(!inter.includes('image_url'), 'image parts stay out of the message');
  assert.ok(inter.includes('不要重新访问或抓取'), 'anti-fetch directive present');
  assert.deepEqual(interAtt, [
    { type: 'image/jpeg', mime: 'image/jpeg', name: 'page-figure-1.jpg', data: '/9j/4AAQ' },
    { type: 'image/png', mime: 'image/png', name: 'page-figure-2.png', data: 'iVBORw0K' },
  ], 'figure images ride along as base64 attachments');

  // A question that follows earlier Q&A (context no longer the latest turn)
  // must NOT re-send the page — the gateway retained it in its own transcript.
  const { message: later } = buildSquillaTurn(ask, '', [
    { role: 'user', content: ctx },
    { role: 'assistant', content: '好的' },
  ]);
  assert.equal(later, '总结这一页');
  assert.ok(!later.includes('Some page content'));

  // Language directive sits between context and question.
  const { message: both } = buildSquillaTurn(ask, '请始终用中文回答。', [{ role: 'user', content: ctx }]);
  assert.ok(both.indexOf(ctx) < both.indexOf('请始终用中文回答。') && both.indexOf('请始终用中文回答。') < both.indexOf('总结'));

  // Two attaches back-to-back before the question → both forwarded in order.
  const ctxB = PAGE_CONTEXT_PREFIX + '# Page B\n\nSecond page.';
  const { message: two } = buildSquillaTurn(ask, '', [
    { role: 'user', content: ctx },
    { role: 'user', content: ctxB },
  ]);
  assert.ok(two.includes('Some page content') && two.includes('Second page'), 'consecutive attaches must all be forwarded');
  assert.ok(two.indexOf('Some page content') < two.indexOf('Second page'), 'order preserved');

  // A plain user turn between attach and question: the walk stops there —
  // that turn's own send already flushed the context to the gateway.
  const { message: flushed } = buildSquillaTurn(ask, '', [
    { role: 'user', content: ctx },
    { role: 'user', content: '随便聊聊' },
    { role: 'assistant', content: '好的' },
  ]);
  assert.equal(flushed, '总结这一页');
  assert.ok(!flushed.includes('Some page content'));
});
