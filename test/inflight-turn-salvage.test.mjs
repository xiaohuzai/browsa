// test/inflight-turn-salvage.test.mjs
// Regression coverage for the 2026-10-13 field report: an OpenSquilla turn,
// mid-stream, lost EVERYTHING (thinking + partial output, no error, nothing
// in history) across a side-panel close/reopen. The panel-reopen resume path
// (STREAM_PEEK → resumeInFlightStream) is provider-agnostic and was never the
// problem — the loss needs streamState to be GONE at peek time, and within a
// living SW nothing clears it mid-turn. That means the service worker itself
// died mid-stream (the 30s keepalive alarm vs Chrome's 30s idle kill is a
// race; memory pressure / extension reload kill it outright): all in-memory
// state — streamState, chatControllers, the provider socket — evaporates and
// the turn leaves no trace.
//
// Three layers of coverage here:
//   1. durable mirror lifecycle — initStreamState/appendToStreamState/
//      clearStreamState maintain a debounced chrome.storage.session record.
//   2. salvage — salvageDurableTurns() appends the partial as an interrupted
//      entry (收尸, same shape as the abort path) honoring origin/bg routing,
//      and STREAM_PEEK reports `recovered` so the panel re-renders.
//   3. zombie fix — a real error on a turn whose panel is ALREADY GONE
//      tombstones an ERROR + clears streamState (before the fix it lingered
//      inFlight: the reopened panel resumed a dead stream and spun forever).
//      With a live panel the response channel still owns the error (pinned:
//      no tombstone, streamState untouched — the panel's own STREAM_RELEASE
//      on !res.ok clears it).
//   4. squilla integration — the FULL handleChat turn through the real
//      handle(): panel "closes" (port removed) mid-stream, PEEK sees the
//      in-flight acc, the turn completes, PEEK says not-in-flight and history
//      has the reply. (The finish-while-closed path was already correct; this
//      pins it against squilla-specific drift, since that's the provider the
//      field report came from.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- in-memory chrome.storage areas (same pattern as chat-rebuild-channels)
function makeStorageArea() {
  let store = {};
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    async get(keys) {
      if (keys == null) return clone(store);
      if (typeof keys === 'string') return { [keys]: clone(store[keys]) };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = clone(store[k]);
        return out;
      }
      return clone(store);
    },
    async set(obj) { store = { ...store, ...clone(obj) }; },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
    _reset() { store = {}; },
    _store() { return store; },
  };
}

const localArea = makeStorageArea();
const sessionArea = makeStorageArea();

// MockWebSocket — mirrors test/squilla-client.test.mjs (mock the transport
// global, drive the real client).
class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  static respond = null;
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.listeners = {};
    this.sent = [];
    MockWebSocket.instances.push(this);
    // Auto-open: every socket this code constructs wants an open (the client
    // registers its 'open' listener synchronously in open(), before any
    // microtask runs). Also lets the post-DONE rename fire-and-forget finish
    // promptly instead of sitting out its 10s handshake timeout.
    queueMicrotask(() => this.serverOpen());
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
  serverOpen() { this.readyState = MockWebSocket.OPEN; queueMicrotask(() => this._emit('open')); }
  serverSend(obj) { queueMicrotask(() => this._emit('message', { data: JSON.stringify(obj) })); }
}
globalThis.WebSocket = MockWebSocket;

Object.defineProperty(globalThis, 'chrome', {
  value: {
    storage: { local: localArea, session: sessionArea, onChanged: { addListener: () => {} } },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onConnect: { addListener: () => {} }, sendMessage: () => {} },
    tabs: { onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} }, query: async () => [{ id: 1 }], get: async () => ({ id: 1 }) },
    sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
    webNavigation: {
      onHistoryStateUpdated: { addListener: () => {} },
      onCommitted: { addListener: () => {} },
      onBeforeNavigate: { addListener: () => {} },
    },
    scripting: { executeScript: async () => [{ result: {} }] },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
  },
  writable: true,
  configurable: true,
});

const tick = (n = 3) => new Promise((r) => setTimeout(r, n));
const flushDurable = () => new Promise((r) => setTimeout(r, 1100)); // > DURABLE_FLUSH_MS

const bg = await import('../background.js');
const { handle, streamState, streamPorts, chatControllers, clearTerminalTombstone, takeTerminalTombstone } = bg;
const { initStreamState, appendToStreamState, clearStreamState } = bg;
const chatMod = await import('../lib/handlers/chat-handler.js');
const { salvageDurableTurns, resetDurableSalvageForTests } = chatMod;
const stateMod = await import('../lib/state.js');
const { readDurableTurns } = stateMod;
const storageMod = await import('../lib/storage.js');

function fakePort(received) {
  const msgListeners = [];
  return {
    port: {
      name: 'browsa-chat',
      postMessage: (m) => received.push(m),
      disconnect: () => {},
      onMessage: { addListener: (cb) => msgListeners.push(cb) },
      onDisconnect: { addListener: () => {} },
    },
    deliver: (m) => { for (const cb of msgListeners) cb(m); },
  };
}

async function history() { return storageMod.getHistory(); }

// ---- 1. durable mirror lifecycle -------------------------------------------

test('durable mirror: initStreamState writes a record, deltas flush debounced, clearStreamState removes it', async () => {
  sessionArea._reset();
  streamState.clear();
  initStreamState(21, { providerLabel: 'OpenSquilla', providerKey: { name: 'sq' }, originSessionId: '' });
  await tick();
  // Immediately after init (no flush yet) the record exists with empty acc.
  let rec = (await sessionArea.get('browsa.inflightTurn.21'))['browsa.inflightTurn.21'];
  assert.ok(rec, 'initStreamState must seed the durable record');
  assert.equal(rec.acc, '');

  appendToStreamState(21, 'thinking...');
  appendToStreamState(21, 'more');
  // Debounced: nothing written yet.
  rec = (await sessionArea.get('browsa.inflightTurn.21'))['browsa.inflightTurn.21'];
  assert.equal(rec.acc, '', 'flush is debounced, not per-delta');
  await flushDurable();
  rec = (await sessionArea.get('browsa.inflightTurn.21'))['browsa.inflightTurn.21'];
  assert.equal(rec.acc, 'thinking...more', 'debounced flush mirrors the latest acc');

  const idx = (await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'];
  assert.deepEqual(idx, [21], 'index lists the in-flight tab');

  clearStreamState(21);
  await tick();
  assert.equal((await sessionArea.get('browsa.inflightTurn.21'))['browsa.inflightTurn.21'], undefined, 'terminal path deletes the record');
  assert.deepEqual((await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'], [], 'index entry removed');
});

// ---- 2. salvage -------------------------------------------------------------

test('salvage: SW death mid-turn appends the partial as an interrupted entry (live-history routing)', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  initStreamState(22, { providerLabel: 'OpenSquilla', providerKey: { name: 'sq', model: 'm1' }, originSessionId: '' });
  appendToStreamState(22, '<thinking>\n推理中\n</thinking>\n\n部分回答');
  await flushDurable();

  // The SW dies: every in-memory Map is gone on the next wake.
  streamState.clear();
  chatControllers.clear();

  const salvaged = await salvageDurableTurns();
  assert.ok(salvaged.has(22), 'the dead turn is reported as salvaged');

  const h = await history();
  const entry = h[h.length - 1];
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.content, '<thinking>\n推理中\n</thinking>\n\n部分回答');
  assert.equal(entry.interrupted, true, 'same 收尸 shape as the abort path');
  assert.equal(entry.providerLabel, 'OpenSquilla');
  assert.deepEqual(entry.providerKey, { name: 'sq', model: 'm1' });

  // Record consumed — a second sweep finds nothing.
  assert.deepEqual(await readDurableTurns(), []);
  const again = await salvageDurableTurns();
  assert.equal(again.size, 0);
});

test('salvage: a backgrounded turn routes to its origin session snapshot, not live history', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  // Seed an existing saved session (index + body key) — appendToSessionHistory
  // refuses unknown ids and would fall through to live history.
  await localArea.set({
    savedSessions: [{ id: 's1', name: 'sess', createdAt: Date.now(), pinned: false, textDigest: '' }],
    session_s1: [{ role: 'user', content: 'earlier' }],
  });

  initStreamState(23, { providerLabel: 'OpenSquilla', originSessionId: 's1' });
  streamState.get(23).bg = true; // session switched mid-turn
  appendToStreamState(23, '后台部分输出');
  await flushDurable();

  streamState.clear(); // SW death
  const salvaged = await salvageDurableTurns();
  assert.ok(salvaged.has(23));

  const h = await history();
  assert.ok(!h.some((m) => m.content === '后台部分输出'), 'must NOT leak into live history');
  const body = (await localArea.get('session_s1'))['session_s1'];
  const entry = body[body.length - 1];
  assert.equal(entry.content, '后台部分输出');
  assert.equal(entry.interrupted, true);
});

test('salvage: a turn alive in this SW is never salvaged under, and its record is kept', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  initStreamState(24, { originSessionId: '' });
  appendToStreamState(24, 'still streaming');
  await flushDurable();

  const salvaged = await salvageDurableTurns();
  assert.equal(salvaged.size, 0, 'live turn owns its outcome');
  assert.ok((await sessionArea.get('browsa.inflightTurn.24'))['browsa.inflightTurn.24'], 'record kept for the live turn to consume');
  clearStreamState(24);
  await tick();
});

test('salvage: an empty record (death before first delta) is cleaned up, nothing appended', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const before = (await history()).length;
  initStreamState(25, { originSessionId: '' });
  await flushDurable(); // flush fires; acc still ''
  streamState.clear();
  const salvaged = await salvageDurableTurns();
  assert.equal(salvaged.size, 0, 'nothing to 收尸');
  assert.deepEqual(await readDurableTurns(), [], 'empty record deleted');
  assert.equal((await history()).length, before);
});

test('STREAM_PEEK reports recovered after sweeping a dead turn\u2019s durable record', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  // Re-arm the sweep: background.js already ran it (empty) at import; this
  // test simulates a NEW SW wake after the death.
  resetDurableSalvageForTests();
  initStreamState(26, { providerLabel: 'OpenSquilla', originSessionId: '' });
  appendToStreamState(26, '重开前已生成的内容');
  await flushDurable();
  streamState.clear(); // SW death

  const peek = await handle({ type: 'STREAM_PEEK', tabId: 26 });
  assert.equal(peek.inFlight, false, 'the stream is gone — no resume, no spinner');
  assert.equal(peek.recovered, true, 'panel is told to re-render the salvaged partial');

  // The sweep is memoized: the record is consumed, a second peek is plain.
  const peek2 = await handle({ type: 'STREAM_PEEK', tabId: 26 });
  assert.deepEqual(peek2, { inFlight: false });
});

// ---- 3. zombie fix (real error, panel already gone) --------------------------

function httpError(status, text) {
  return { ok: false, status, body: null, text: async () => text, headers: { get: () => '' } };
}

test('real error with the panel gone: streamState cleared + ERROR tombstone (resume finalizes, no zombie)', async () => {
  await localArea.set({
    providers: { p1: { baseUrl: 'https://api.test/v1', apiKey: 'k', apiStyle: 'chat', alias: 'T' } },
    activeProvider: 'p1',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => httpError(500, 'provider exploded');
  streamState.clear();
  streamPorts.clear();
  clearTerminalTombstone(31);
  try {
    await assert.rejects(
      handle({ type: 'CHAT', tabId: 31, userText: 'hi', sessionId: undefined }),
      /provider exploded|500/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(streamState.has(31), false, 'no zombie: the reopened panel must not PEEK this as in-flight');
  const t = takeTerminalTombstone(31);
  assert.equal(t?.type, 'ERROR', 'tombstoned so a PEEK→HELLO resume finalizes');
  assert.match(String(t?.error), /provider exploded|500/);
  streamState.clear();
  clearTerminalTombstone(31);
});

test('real error with a LIVE panel: response channel owns it (no tombstone, no double display)', async () => {
  await localArea.set({
    providers: { p1: { baseUrl: 'https://api.test/v1', apiKey: 'k', apiStyle: 'chat', alias: 'T' } },
    activeProvider: 'p1',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => httpError(500, 'live panel error');
  streamState.clear();
  streamPorts.clear();
  clearTerminalTombstone(32);
  streamPorts.set(32, { postMessage: () => {}, disconnect: () => {} }); // panel connected
  try {
    await assert.rejects(
      handle({ type: 'CHAT', tabId: 32, userText: 'hi', sessionId: undefined }),
      /live panel error|500/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(takeTerminalTombstone(32), null, 'no ERROR chunk — the panel renders the response error itself');
  assert.ok(streamState.has(32), 'unchanged behavior: a live panel releases via STREAM_RELEASE on !res.ok');
  streamState.clear();
  streamPorts.clear();
});

// ---- 4. squilla integration: panel closed mid-stream ------------------------

// Scripted gateway (mirrors squilla-client.test.mjs): auto-answers the
// handshake/subscribe/send/rename; test pushes turn events manually so it
// can close the "panel" between deltas.
function scriptGateway() {
  MockWebSocket.instances = [];
  let accepted = false;
  MockWebSocket.respond = (ws, frame) => {
    if (frame.method === 'connect') {
      return [{ type: 'hello-ok', protocol: 4, server: { version: '0.5.4', conn_id: 'c1' }, features: { methods: [] } }];
    }
    if (frame.method === 'sessions.create') {
      return [{ type: 'res', id: frame.id, ok: true, payload: { key: 'agent:main:webchat:created1' } }];
    }
    if (frame.method === 'sessions.rename') {
      return [{ type: 'res', id: frame.id, ok: true, payload: { key: frame.params.key } }];
    }
    if (frame.method === 'sessions.messages.subscribe') {
      return [{ type: 'res', id: frame.id, ok: true, payload: { subscribed: true } }];
    }
    if (frame.method === 'sessions.send') {
      accepted = true;
      return [{ type: 'res', id: frame.id, ok: true, payload: { ok: true, task_id: 'task-1' } }];
    }
    if (accepted && frame.method === 'agent.identity.get') {
      return [{ type: 'res', id: frame.id, ok: true, payload: {} }];
    }
    return [];
  };
  const origServerOpen = MockWebSocket.prototype.serverOpen;
  MockWebSocket.prototype.serverOpen = function () {
    origServerOpen.call(this);
    queueMicrotask(() => this.serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' }, seq: 1 }));
  };
  return {
    push(ev) { MockWebSocket.instances[0].serverSend(ev); },
    restore() { MockWebSocket.prototype.serverOpen = origServerOpen; MockWebSocket.respond = null; },
  };
}

test('squilla turn, panel closed mid-stream: PEEK shows the acc, completion persists, PEEK goes quiet', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  streamPorts.clear();
  await localArea.set({
    providers: { sq: { isSquilla: true, alias: 'OpenSquilla', baseUrl: 'ws://127.0.0.1:18791/ws', apiKey: '' } },
    activeProvider: 'sq',
  });
  await storageMod.setSquillaSessionKey('sq', 'agent:main:webchat:t1');

  const gw = scriptGateway();
  const received = [];
  const { port, deliver } = fakePort(received);
  streamPorts.set(33, port.port); // onSend opens browsa-chat before CHAT
  deliver({ type: 'STREAM_HELLO', tabId: 33 });

  const chatP = handle({ type: 'CHAT', tabId: 33, userText: '讲讲这个视频', sessionId: undefined });
  for (let i = 0; i < 50 && !MockWebSocket.instances.length; i++) await tick();
  assert.ok(MockWebSocket.instances.length, 'turn socket constructed');
  for (let i = 0; i < 50 && !(MockWebSocket.instances[0]?.sent || []).some((f) => f.method === 'sessions.send'); i++) await tick();
  assert.ok((MockWebSocket.instances[0]?.sent || []).some((f) => f.method === 'sessions.send'), 'send accepted');

  gw.push({ type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: '思考过程部分 ', presentation: 'intermediate' }, seq: 2 });
  gw.push({ type: 'event', event: 'session.event.text_delta', payload: { task_id: 'task-1', text: '开始回答' }, seq: 3 });
  await tick();
  assert.ok(streamState.get(33)?.acc.length > 0, 'deltas accumulate in streamState (same onDelta as every provider)');

  // THE PANEL CLOSES: the port dies; the SW's onDisconnect removes it —
  // streamState survives (that retention is pinned by stream-resume.test.mjs).
  streamPorts.delete(33);

  // Panel reopens while still streaming: PEEK must offer a resume. The acc
  // carries the live <thinking> fold (intermediate narration) — the resumed
  // panel renders its collapsible from exactly this markup.
  const mid = await handle({ type: 'STREAM_PEEK', tabId: 33 });
  assert.equal(mid.inFlight, true);
  assert.equal(mid.acc, '<thinking>\n思考过程部分 \n</thinking>\n开始回答');
  assert.equal(mid.providerLabel, 'OpenSquilla');

  // The turn completes behind the closed panel.
  gw.push({ type: 'event', event: 'session.event.done', payload: { task_id: 'task-1' }, seq: 4 });
  await chatP;

  const end = await handle({ type: 'STREAM_PEEK', tabId: 33 });
  assert.equal(end.inFlight, false, 'DONE cleared the state (no zombie)');

  const h = await history();
  const entry = h[h.length - 1];
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.content, '<thinking>\n思考过程部分 \n</thinking>\n开始回答', 'full reply persisted — reopening now shows it via renderHistory');
  assert.equal(entry.interrupted, undefined);
  await tick();
  gw.restore();
  streamState.clear();
});
