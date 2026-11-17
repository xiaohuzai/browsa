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
//   3. zombie fix — a real error on an owned turn ALWAYS pushes an ERROR
//      chunk (tombstoned) + clears streamState and its durable mirror
//      (2026-11-03 sw-4: the old live-panel exemption depended on the panel's
//      STREAM_RELEASE arriving — a panel destroyed in that window left a
//      controller-less zombie whose durable record was later salvaged as a
//      late, out-of-order interrupted entry). The {ok:false} response still
//      rides; the panel's ERROR-chunk branch finalizes the partial text.
//   4. squilla integration — the FULL handleChat turn through the real
//      handle(): panel "closes" (port removed) mid-stream, PEEK sees the
//      in-flight acc, the turn completes, PEEK says not-in-flight and history
//      has the reply. (The finish-while-closed path was already correct; this
//      pins it against squilla-specific drift, since that's the provider the
//      field report came from.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorageArea } from './helpers/chrome-mock.mjs';

// ---- in-memory chrome.storage areas (same pattern as chat-rebuild-channels)

const localArea = makeStorageArea({}, { clone: true });
const sessionArea = makeStorageArea({}, { clone: true });

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

const alarmListeners = [];
Object.defineProperty(globalThis, 'chrome', {
  value: {
    storage: { local: localArea, session: sessionArea, onChanged: { addListener: () => {} } },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: (fn) => alarmListeners.push(fn) } },
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
const { handle, streamState, streamPorts, chatControllers, clearTerminalTombstone, takeTerminalTombstone, recordTerminalTombstone } = bg;
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
const recoveryMeta = entry => entry?.steps?.find(s => s?.recovery?.kind === 'browsa.interrupted-step-only')?.recovery;
const isInterruptedEntry = entry => entry?.interrupted === true || recoveryMeta(entry)?.interrupted === true;

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

test('readDurableTurns never deletes a LIVE turn’s empty-acc record (SW-wake race guard)', async () => {
  // 2026-11-03 审计：SW 醒来即发的新回合刚 durableTurnBegin 写入 acc='' 记录，
  // 收尸扫描曾把空 acc 记录就地 durableTurnEnd 删掉（活回合守卫在下游来得太晚）；
  // scheduleDurableTurnFlush 只重写记录键不重写索引→索引条目一旦被删，该回合
  // 的 SW-death 收尸永久失效。readDurableTurns 必须跳过 streamState 里的活回合。
  sessionArea._reset();
  streamState.clear();
  initStreamState(41, { providerLabel: 'bridge', providerKey: { name: 'bridge' } });
  await tick();
  let rec = (await sessionArea.get('browsa.inflightTurn.41'))['browsa.inflightTurn.41'];
  assert.ok(rec, 'sanity: live turn seeded an empty-acc record');
  assert.equal(rec.acc, '');

  const salvaged = await readDurableTurns();
  assert.deepEqual(salvaged, [], 'a live turn is not salvaged');
  rec = (await sessionArea.get('browsa.inflightTurn.41'))['browsa.inflightTurn.41'];
  assert.ok(rec, 'live turn record must survive the sweep');
  const idx = (await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'];
  assert.deepEqual(idx, [41], 'live turn index entry must survive');
  clearStreamState(41);
  await tick();
});

test('a late STREAM_RELEASE after SW death cannot delete the only durable mirror before recovery', async () => {
  for (const epoch of [undefined, 1]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    chatControllers.clear();
    resetDurableSalvageForTests();
    await localArea.set({ history: [{ role: 'user', content: 'original' }], historyGeneration: 'release-generation' });
    await sessionArea.set({ 'browsa.inflightTurns': [107], 'browsa.inflightTurn.107': {
      acc: '', startedAt: 1, epoch: 1, recoveryId: 'release-107', originSessionId: '', originHistoryGeneration: 'release-generation',
      steps: [{ k: 'tool', name: 'read', target: 'must survive release' }] } });
    const realClear = chrome.alarms.clear;
    const cleared = [];
    chrome.alarms.clear = name => cleared.push(name);
    try {
      const release = await handle({ type: 'STREAM_RELEASE', tabId: 107, ...(epoch == null ? {} : { epoch }) });
      assert.equal(release.released, true, 'release remains an idempotent acknowledgement');
      assert.ok(cleared.includes(stateMod.GC_ALARM_NAME), 'an empty worker still stops the GC alarm');
    } finally {
      chrome.alarms.clear = realClear;
    }
    await tick(20); // let the release cleanup attempt finish before the sweep
    const peek = await handle({ type: 'STREAM_PEEK', tabId: 107 });
    assert.equal(peek.recovered, true, 'the restarted worker must still recover the mirror');
    assert.equal((await history()).at(-1).steps?.[0]?.target, 'must survive release');
  }
});

test('a failed session mirror read during the sweep never deletes the unseen record or its index', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const key = 'browsa.inflightTurn.113';
  const record = { acc: '', startedAt: 1, epoch: 1, recoveryId: 'read-failure',
    steps: [{ k: 'tool', name: 'read', target: 'valuable file' }] };
  await sessionArea.set({ 'browsa.inflightTurns': [113], [key]: record });
  const realGet = sessionArea.get.bind(sessionArea);
  let failed = false;
  sessionArea.get = async keys => {
    if (!failed && keys === key) { failed = true; throw new Error('temporary session read failure'); }
    return realGet(keys);
  };
  try { assert.equal((await salvageDurableTurns()).size, 0); }
  finally { sessionArea.get = realGet; }
  assert.equal(failed, true);
  assert.deepEqual((await sessionArea.get(key))[key], record);
  assert.deepEqual((await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'], [113]);
});

test('an old durable cleanup cannot delete a newer mirror when its identity read fails', async () => {
  sessionArea._reset();
  streamState.clear();
  const key = 'browsa.inflightTurn.114';
  const newer = { acc: 'new turn', startedAt: 2, epoch: 2, recoveryId: 'new-owner' };
  await sessionArea.set({ 'browsa.inflightTurns': [114], [key]: newer });
  const realGet = sessionArea.get.bind(sessionArea);
  let failed = false;
  sessionArea.get = async keys => {
    if (!failed && keys === key) { failed = true; throw new Error('temporary identity read failure'); }
    return realGet(keys);
  };
  try { await stateMod.durableTurnEnd(114, 1, { recoveryId: 'old-owner' }); }
  finally { sessionArea.get = realGet; }
  assert.equal(failed, true);
  assert.deepEqual((await sessionArea.get(key))[key], newer);
  assert.deepEqual((await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'], [114]);
});

test('a failed mirror removal retains its index for a later retry', async () => {
  sessionArea._reset();
  streamState.clear();
  const key = 'browsa.inflightTurn.115';
  const record = { acc: 'surviving text', startedAt: 1, epoch: 1, recoveryId: 'turn-115' };
  await sessionArea.set({ 'browsa.inflightTurns': [115], [key]: record });
  const realRemove = sessionArea.remove.bind(sessionArea);
  sessionArea.remove = async () => { throw new Error('session remove failed'); };
  try { await stateMod.durableTurnEnd(115, 1, { recoveryId: 'turn-115' }); }
  finally { sessionArea.remove = realRemove; }
  assert.deepEqual((await sessionArea.get(key))[key], record);
  assert.deepEqual((await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'], [115]);
});

function fakeChatStreamResponse() {
  return new Response('data: {"choices":[{"delta":{"content":"new answer"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function seedPendingRecoveryForChat(tabId) {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  resetDurableSalvageForTests();
  await localArea.set({ history: [{ role: 'user', content: 'old question' }], historyGeneration: 'chat-gen',
    agentSessionState: { contextId: 'chat-context', ids: {} },
    providers: { p1: { type: 'llm', alias: 'LLM', baseUrl: 'https://api.test/v1', apiKey: 'x', apiStyle: 'chat' } },
    activeProvider: 'p1' });
  const key = `browsa.inflightTurn.${tabId}`;
  await sessionArea.set({ 'browsa.inflightTurns': [tabId], [key]: { acc: '', startedAt: 1, epoch: 1,
    recoveryId: `chat-pending-${tabId}`, originHistoryGeneration: 'chat-gen', originContextId: 'chat-context',
    steps: [{ k: 'tool', name: 'read', target: 'old file' }] } });
  return key;
}

test('CHAT waits for its old recovery before appending the next user message', async () => {
  const key = await seedPendingRecoveryForChat(116);
  const realGet = sessionArea.get.bind(sessionArea);
  const realFetch = globalThis.fetch;
  let count = 0, release, notify, chatP, sweepP;
  const gate = new Promise(r => { release = r; });
  const entered = new Promise(r => { notify = r; });
  sessionArea.get = async keys => {
    const value = await realGet(keys);
    if (keys === key && ++count === 2) { notify(); await gate; }
    return value;
  };
  globalThis.fetch = async () => fakeChatStreamResponse();
  try {
    sweepP = chatMod.ensureDurableSalvage();
    await entered;
    chatP = handle({ type: 'CHAT', tabId: 116, userText: 'new question' });
    await tick(50);
    assert.deepEqual(await history(), [{ role: 'user', content: 'old question' }], 'no new user is stored before old recovery');
    release();
    await Promise.all([sweepP, chatP]);
    const h = await history();
    assert.equal(h[1].steps?.[0]?.target, 'old file');
    assert.equal(h[2].content, 'new question');
    assert.equal(h[3].content, 'new answer');
  } finally {
    release?.();
    if (sweepP) await Promise.allSettled([sweepP]);
    if (chatP) await Promise.allSettled([chatP]);
    sessionArea.get = realGet;
    globalThis.fetch = realFetch;
  }
});

test('CHAT refuses to overwrite a same-tab mirror when recovery keeps failing', async () => {
  const key = await seedPendingRecoveryForChat(117);
  const realSet = localArea.set.bind(localArea);
  const realFetch = globalThis.fetch;
  let fetches = 0;
  localArea.set = async obj => {
    if (obj.history?.some(m => m.steps?.some(s => s.target === 'old file'))) throw new Error('local recovery write failed');
    return realSet(obj);
  };
  globalThis.fetch = async () => { fetches++; return fakeChatStreamResponse(); };
  try {
    await assert.rejects(handle({ type: 'CHAT', tabId: 117, userText: 'new question' }), /recover/i);
    assert.equal(fetches, 0, 'no provider request starts when the prior turn cannot be saved');
    assert.deepEqual(await history(), [{ role: 'user', content: 'old question' }]);
    assert.equal((await sessionArea.get(key))[key]?.recoveryId, 'chat-pending-117');
  } finally {
    localArea.set = realSet;
    globalThis.fetch = realFetch;
  }
});

test('CHAT does not treat a failed same-tab session read as an absent mirror', async () => {
  const key = await seedPendingRecoveryForChat(118);
  const realGet = sessionArea.get.bind(sessionArea);
  const realFetch = globalThis.fetch;
  let fetches = 0;
  sessionArea.get = async keys => {
    if (keys === key || (Array.isArray(keys) && keys.includes(key))) throw new Error('session read failed');
    return realGet(keys);
  };
  globalThis.fetch = async () => { fetches++; return fakeChatStreamResponse(); };
  try {
    await assert.rejects(handle({ type: 'CHAT', tabId: 118, userText: 'new question' }), /recover|storage/i);
    assert.equal(fetches, 0);
    assert.deepEqual(await history(), [{ role: 'user', content: 'old question' }]);
  } finally {
    sessionArea.get = realGet;
    globalThis.fetch = realFetch;
  }
  assert.equal((await sessionArea.get(key))[key]?.recoveryId, 'chat-pending-118');
});

test('a stalled recovery on another tab does not block CHAT on this tab', async () => {
  const key = await seedPendingRecoveryForChat(119);
  const realGet = sessionArea.get.bind(sessionArea);
  const realFetch = globalThis.fetch;
  let count = 0, release, notify, sweepP, chatP;
  const gate = new Promise(r => { release = r; });
  const entered = new Promise(r => { notify = r; });
  sessionArea.get = async keys => {
    const value = await realGet(keys);
    if (keys === key && ++count === 2) { notify(); await gate; }
    return value;
  };
  globalThis.fetch = async () => fakeChatStreamResponse();
  try {
    sweepP = chatMod.ensureDurableSalvage();
    await entered;
    chatP = handle({ type: 'CHAT', tabId: 120, userText: 'other tab question' });
    const result = await Promise.race([chatP, new Promise((_, reject) => setTimeout(() => reject(new Error('unrelated tab blocked')), 500))]);
    assert.equal(result.full, 'new answer');
  } finally {
    release?.();
    if (sweepP) await Promise.allSettled([sweepP]);
    if (chatP) await Promise.allSettled([chatP]);
    sessionArea.get = realGet;
    globalThis.fetch = realFetch;
  }
});

test('DROP with the old turn token wins against a startup recovery even during its write', async () => {
  for (const phase of ['read', 'write']) {
    const key = await seedPendingRecoveryForChat(122);
    const realGet = sessionArea.get.bind(sessionArea);
    const realSet = localArea.set.bind(localArea);
    let count = 0, release, notify, sweepP, dropP;
    const gate = new Promise(r => { release = r; });
    const entered = new Promise(r => { notify = r; });
    sessionArea.get = async keys => {
      const result = await realGet(keys);
      if (phase === 'read' && keys === key && ++count === 2) { notify(); await gate; }
      return result;
    };
    localArea.set = async obj => {
      if (phase === 'write' && obj.history?.some(m => m.steps?.some(s => s.target === 'old file'))) { notify(); await gate; }
      return realSet(obj);
    };
    try {
      sweepP = chatMod.ensureDurableSalvage();
      await entered;
      dropP = handle({ type: 'STREAM_ABORT', tabId: 122, salvage: false, turnId: 'chat-pending-122' });
      await tick(10);
      release();
      const result = await dropP;
      assert.equal(result.durableDiscarded, true, `${phase}: the exact old turn was durably discarded`);
      await sweepP;
      const all = await localArea.get(null);
      const entries = [all.history || [], ...Object.entries(all).filter(([k, v]) => k.startsWith('session_') && Array.isArray(v)).map(([, v]) => v)];
      assert.equal(entries.some(h => h.some(m => m.steps?.some(s => s.target === 'old file'))), false);
    } finally {
      release?.();
      if (dropP) await Promise.allSettled([dropP]);
      if (sweepP) await Promise.allSettled([sweepP]);
      sessionArea.get = realGet;
      localArea.set = realSet;
    }
  }
});

test('an old DROP token cannot abort or discard a newer owner on the same tab', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  const controller = new AbortController();
  const st = initStreamState(123, { ownerController: controller });
  chatControllers.set(123, controller);
  await tick(20);
  const result = await handle({ type: 'STREAM_ABORT', tabId: 123, salvage: false, turnId: 'old-token' });
  assert.equal(result.aborted, false);
  assert.equal(controller.signal.aborted, false);
  assert.equal(streamState.get(123), st);
  assert.equal((await sessionArea.get('browsa.inflightTurn.123'))['browsa.inflightTurn.123']?.recoveryId, st.recoveryId);
  chatControllers.delete(123);
  clearStreamState(123);
  await tick(20);
});

test('CHAT refuses a stale prepared history before appending or contacting the provider', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  await localArea.set({ history: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'inserted during setup' }],
    activeSessionId: '', historyGeneration: 'gen', agentSessionState: { contextId: 'ctx', ids: {} },
    providers: { p1: { type: 'llm', baseUrl: 'https://api.test/v1', apiKey: 'x', apiStyle: 'chat' } }, activeProvider: 'p1' });
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return fakeChatStreamResponse(); };
  try {
    await assert.rejects(handle({ type: 'CHAT', tabId: 121, userText: 'new question',
      expectedHistoryState: { activeSessionId: '', historyGeneration: 'gen', historyLen: 1 } }), { name: 'HistoryChangedError' });
    assert.equal(fetches, 0);
    assert.deepEqual((await history()).map(m => m.content), ['old', 'inserted during setup']);
  } finally { globalThis.fetch = realFetch; }
});

test('old RELEASE with a colliding epoch cannot delete a new active or finalizing turn', async () => {
  for (const phase of ['active', 'persisting']) for (const token of [undefined, 'old-worker-token', 'current']) {
    sessionArea._reset();
    streamState.clear();
    chatControllers.clear();
    const controller = new AbortController();
    const st = initStreamState(112, { ownerController: controller });
    st.epoch = 1; // a fresh SW restarts its in-memory epoch sequence
    if (phase === 'active') chatControllers.set(112, controller);
    else st.persisting = true; // controller is gone, final history write still pending
    await tick(20);
    const release = await handle({ type: 'STREAM_RELEASE', tabId: 112, epoch: 1,
      ...(token ? { turnId: token === 'current' ? st.recoveryId : token } : {}) });
    assert.equal(release.released, false, `${phase}: old client cannot release a newer owner`);
    assert.equal(streamState.get(112), st);
    const mirror = (await sessionArea.get('browsa.inflightTurn.112'))['browsa.inflightTurn.112'];
    assert.equal(mirror?.recoveryId, st.recoveryId);
    chatControllers.delete(112);
    clearStreamState(112);
    await tick(20);
  }
});

// Turn step ledger ↔ durable mirror (2026-10-23). The chat-handler's
// onToolProgress schedules a durable flush when a step lands, because a long
// tool call can run for minutes with no text delta — a SW death in that window
// used to salvage the text but lose exactly the tool lines that explain what
// the turn was doing. This pins BOTH layers:
//   (a) the mirror itself carries `steps` (state.js durableRecordOf), and
//   (b) the handler really schedules the flush on a tool event, not only on a
//       delta — the gap the completion audit found uncovered.

test('durable mirror: a tool step is mirrored after the debounce, even with no delta', async () => {
  sessionArea._reset();
  streamState.clear();
  const { scheduleDurableTurnFlush } = await import('../lib/state.js');
  const { makeTurnStep, pushTurnStep } = await import('../lib/message-builder.js');

  const st = initStreamState(31, { providerLabel: 'bridge', providerKey: { name: 'bridge' } });
  st.steps = [];
  // No appendToStreamState at all: acc stays empty, only the ledger advances.
  pushTurnStep(st.steps, makeTurnStep({ name: 'edit', target: 'src/app.ts', status: 'done', ok: true }));
  scheduleDurableTurnFlush(31);

  let rec = (await sessionArea.get('browsa.inflightTurn.31'))['browsa.inflightTurn.31'];
  assert.equal(rec && rec.steps, undefined, 'flush is debounced, not per-step');

  await flushDurable();
  rec = (await sessionArea.get('browsa.inflightTurn.31'))['browsa.inflightTurn.31'];
  assert.ok(Array.isArray(rec.steps), 'the ledger rides the durable record');
  assert.equal(rec.steps.length, 1);
  assert.equal(rec.steps[0].name, 'edit');
  assert.equal(rec.steps[0].target, 'src/app.ts');
  assert.equal(rec.steps[0].ok, true);
  assert.equal(rec.acc, '', 'sanity: no text delta was involved');

  clearStreamState(31);
  await tick();
});

test('durable mirror: a salvaged turn keeps its steps (SW death mid-tool-call)', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const { scheduleDurableTurnFlush } = await import('../lib/state.js');
  const { makeTurnStep, pushTurnStep } = await import('../lib/message-builder.js');

  await localArea.set({ historyGeneration: 'live-32' });
  const st = initStreamState(32, { providerLabel: 'bridge', providerKey: { name: 'bridge' },
    originContextId: await storageMod.getAgentSessionContextId(), originHistoryGeneration: 'live-32' });
  st.steps = [];
  appendToStreamState(32, 'partial reply');
  pushTurnStep(st.steps, makeTurnStep({ name: 'bash', toolCallId: 'call-32', target: 'npm test', status: 'done', ok: false }, 1));
  scheduleDurableTurnFlush(32);
  await flushDurable();

  const mirror = (await sessionArea.get('browsa.inflightTurn.32'))['browsa.inflightTurn.32'];
  assert.equal(st.steps[0].toolCallId, 'call-32', 'live correlation keeps the native ID');
  assert.deepEqual(mirror.steps, [{ k: 'tool', name: 'bash', target: 'npm test', ok: false }]);

  // Simulate SW death: the live state evaporates, only the durable record stays.
  streamState.delete(32);
  resetDurableSalvageForTests();

  const salvaged = await salvageDurableTurns();
  assert.ok(salvaged.has(32), 'the turn was salvaged');

  const h = await history();
  const entry = h.filter((m) => m.role === 'assistant' && m.interrupted).at(-1);
  assert.ok(entry, 'an interrupted entry was appended');
  assert.equal(entry.content, 'partial reply');
  assert.ok(Array.isArray(entry.steps), 'the salvage carried the ledger, not just the text');
  assert.equal(entry.steps[0].name, 'bash');
  assert.equal(entry.steps[0].ok, false, 'the failure survives the salvage');
  assert.deepEqual(entry.steps, mirror.steps, 'salvage preserves visible fields without live-only identity');
});

test('SW death before the first text delta recovers tool steps once and reports them through PEEK', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  resetDurableSalvageForTests();
  await localArea.set({ history: [{ role: 'user', content: 'inspect the file' }] });
  const { makeTurnStep, pushTurnStep } = await import('../lib/message-builder.js');
  await localArea.set({ historyGeneration: 'live-71' });
  const st = initStreamState(71, { providerLabel: 'codex', providerKey: { name: 'bridge' },
    originContextId: await storageMod.getAgentSessionContextId(), originHistoryGeneration: 'live-71' });
  st.steps = [];
  pushTurnStep(st.steps, makeTurnStep({ name: 'read', target: 'src/app.ts', status: 'started', toolCallId: 'call-71' }, 1));
  stateMod.scheduleDurableTurnFlush(71);
  await flushDurable();
  streamState.delete(71); // SW death: the durable mirror is the only copy

  const peek = await handle({ type: 'STREAM_PEEK', tabId: 71 });
  assert.equal(peek.recovered, true);
  const h = await history();
  assert.equal(h.length, 2);
  assert.equal(h[1].role, 'assistant');
  assert.equal(h[1].content, '');
  assert.deepEqual(Object.keys(h[1]).sort(), ['content', 'role', 'steps']);
  assert.equal(recoveryMeta(h[1]).interrupted, true);
  assert.equal(recoveryMeta(h[1]).providerLabel, 'codex');
  assert.deepEqual(recoveryMeta(h[1]).providerKey, { name: 'bridge' });
  assert.equal(h[1].steps[0].name, 'read');
  assert.equal(h[1].steps[0].target, 'src/app.ts');
  assert.equal('ok' in h[1].steps[0], false, 'a started tool has no known result');
  assert.deepEqual(await handle({ type: 'STREAM_PEEK', tabId: 71 }), { inFlight: false });
  assert.equal((await salvageDurableTurns()).size, 0);
  assert.deepEqual(await history(), h, 'a later sweep must not append a second copy');
});

test('a recovered steps-only turn is accepted by a strict chat-completions provider', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({ history: [{ role: 'user', content: 'inspect' }], historyGeneration: 'strict-gen' });
  await sessionArea.set({ 'browsa.inflightTurns': [111], 'browsa.inflightTurn.111': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'strict-turn', originHistoryGeneration: 'strict-gen',
    providerLabel: 'source agent', providerKey: { name: 'source', model: 'agent-1' },
    steps: [{ k: 'tool', name: 'read', target: 'src/app.ts' }] } });
  assert.ok((await salvageDurableTurns()).has(111));
  const h = await history();
  const { buildMessages } = await import('../lib/message-builder.js');
  const { chatStream } = await import('../lib/llm-client.js');
  const messages = buildMessages({ history: h, userText: 'what happened?' });
  let captured;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    const bad = captured.messages.some(m => Object.keys(m).some(k => k !== 'role' && k !== 'content'));
    if (bad) return new Response('unknown message field', { status: 400 });
    return new Response('data: {"choices":[{"delta":{"content":"accepted"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await chatStream({ baseUrl: 'https://strict.example/v1', apiKey: 'test', model: 'strict', messages, onDelta() {} });
    assert.equal(result.full, 'accepted');
  } finally { globalThis.fetch = realFetch; }
  const recovered = h.at(-1);
  assert.deepEqual(Object.keys(recovered).sort(), ['content', 'role', 'steps']);
  assert.match(captured.messages.find(m => m.role === 'assistant').content, /read: src\/app\.ts \(outcome unknown\)/);
  assert.doesNotMatch(JSON.stringify(captured), /recoveryId|strict-turn|providerLabel|providerKey|"interrupted"/);
});

test('steps-only SW death routes to the original saved conversation and rescues a deleted origin', async () => {
  for (const originExists of [true, false]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const live = [{ role: 'user', content: 'other conversation' }];
    await localArea.set({
      history: live,
      savedSessions: originExists ? [{ id: 'origin', name: 'origin', createdAt: 1, textDigest: '' }] : [],
      ...(originExists ? { session_origin: [{ role: 'user', content: 'original request' }] } : {}),
    });
    await sessionArea.set({
      'browsa.inflightTurns': [72],
      'browsa.inflightTurn.72': { acc: '', bg: true, originSessionId: 'origin', epoch: 1,
        steps: [{ k: 'tool', name: 'write', target: 'src/app.ts', ok: false }] },
    });
    assert.ok((await salvageDurableTurns()).has(72));
    assert.deepEqual(await history(), live, 'the other live conversation must not receive this entry');
    const origin = (await localArea.get('session_origin')).session_origin;
    const entry = origin.at(-1);
    assert.equal(entry.content, '');
    assert.equal(recoveryMeta(entry)?.interrupted, true);
    assert.equal(entry.steps[0].name, 'write');
    assert.equal(entry.steps[0].target, 'src/app.ts');
    assert.equal(entry.steps[0].ok, false);
    assert.equal((await salvageDurableTurns()).size, 0);
  }
});

test('recreated origin keeps its generation and deduplicates after another SW death, including after load', async () => {
  for (const loadBeforeRetry of [false, true]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const live = [{ role: 'user', content: 'unrelated B' }];
    await localArea.set({ history: live, activeSessionId: 'B', historyGeneration: 'generation-B',
      agentSessionState: { contextId: 'agent-B', ids: { unrelated: 'must-not-copy' } },
      savedSessions: [{ id: 'B', name: 'B', createdAt: 1, historyGeneration: 'generation-B', agentContextId: 'agent-B', agentSessions: {} }], session_B: live });
    const key = 'browsa.inflightTurn.108';
    await sessionArea.set({ 'browsa.inflightTurns': [108], [key]: {
      acc: '', startedAt: 1, epoch: 1, recoveryId: 'turn-108', originSessionId: 'A', originHistoryGeneration: 'generation-A',
      steps: [{ k: 'tool', name: 'read', target: 'A file' }] } });
    const realSet = sessionArea.set.bind(sessionArea);
    const realRemove = sessionArea.remove.bind(sessionArea);
    sessionArea.set = async obj => {
      if ('browsa.inflightTurns' in obj) throw new Error('simulated death before mirror cleanup');
      return realSet(obj);
    };
    sessionArea.remove = async () => { throw new Error('simulated death before mirror cleanup'); };
    try { assert.ok((await salvageDurableTurns()).has(108)); }
    finally { sessionArea.set = realSet; sessionArea.remove = realRemove; }
    const firstIndex = (await localArea.get('savedSessions')).savedSessions;
    const a = firstIndex.find(s => s.id === 'A');
    assert.equal(a?.historyGeneration, 'generation-A', 'a recreated origin retains its own generation');
    assert.equal(a?.agentContextId, undefined, 'it must not borrow the visible B agent identity');
    if (loadBeforeRetry) await storageMod.loadSession('A');
    assert.ok((await salvageDurableTurns()).has(108));
    const index = (await localArea.get('savedSessions')).savedSessions;
    assert.deepEqual(index.map(s => s.id).sort(), ['A', 'B'], 'no second recovery session is created');
    const body = loadBeforeRetry ? await history() : (await localArea.get('session_A')).session_A;
    assert.equal(body.filter(m => recoveryMeta(m)?.id === 'turn-108').length, 1);
  }
});

test('two distinct recovered turns for the same deleted origin share that origin without losing either', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({ history: [{ role: 'user', content: 'unrelated B' }], activeSessionId: 'B', historyGeneration: 'generation-B',
    agentSessionState: { contextId: 'agent-B', ids: {} },
    savedSessions: [{ id: 'B', name: 'B', createdAt: 1, historyGeneration: 'generation-B', agentContextId: 'agent-B', agentSessions: {} }] });
  await sessionArea.set({ 'browsa.inflightTurns': [109, 110],
    'browsa.inflightTurn.109': { acc: '', startedAt: 1, epoch: 1, recoveryId: 'turn-109', originSessionId: 'A', originHistoryGeneration: 'generation-A',
      steps: [{ k: 'tool', name: 'read', target: 'first file' }] },
    'browsa.inflightTurn.110': { acc: '', startedAt: 2, epoch: 1, recoveryId: 'turn-110', originSessionId: 'A', originHistoryGeneration: 'generation-A',
      steps: [{ k: 'tool', name: 'read', target: 'second file' }] } });
  assert.equal((await salvageDurableTurns()).size, 2);
  const index = (await localArea.get('savedSessions')).savedSessions;
  assert.deepEqual(index.map(s => s.id).sort(), ['A', 'B']);
  const body = (await localArea.get('session_A')).session_A;
  assert.deepEqual(body.map(m => m.steps?.[0]?.target), ['first file', 'second file']);
  assert.notEqual(recoveryMeta(body[0]).id, recoveryMeta(body[1]).id);
});

async function raceSalvageWithSessionSwitch({ tabId, rec, from, to }) {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const a = [{ role: 'user', content: 'A private question' }];
  const b = [{ role: 'user', content: 'B unrelated question' }];
  await localArea.set({ history: from === 'A' ? a : b, activeSessionId: from, historyGeneration: `gen${from}`,
    agentSessionState: { contextId: `ctx${from}`, ids: {} },
    savedSessions: [
      { id: 'A', name: 'A', createdAt: 1, historyGeneration: 'genA', agentContextId: 'ctxA', agentSessions: {} },
      { id: 'B', name: 'B', createdAt: 2, historyGeneration: 'genB', agentContextId: 'ctxB', agentSessions: {} },
    ], session_A: a, session_B: b,
  });
  const key = `browsa.inflightTurn.${tabId}`;
  await sessionArea.set({ 'browsa.inflightTurns': [tabId], [key]: {
    acc: '', startedAt: 1, epoch: 1, recoveryId: `recover-${tabId}`,
    steps: [{ k: 'tool', name: 'read', target: 'A-private-file' }], ...rec,
  } });
  const realGet = sessionArea.get.bind(sessionArea);
  let reads = 0, release, notify;
  const entered = new Promise(r => { notify = r; });
  const gate = new Promise(r => { release = r; });
  sessionArea.get = async (requested) => {
    const result = await realGet(requested);
    if (requested === key && ++reads === 2) { notify(); await gate; }
    return result;
  };
  try {
    const sweep = salvageDurableTurns();
    await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('recovery did not reach identity gate')), 500))]);
    await storageMod.updateSessionHistory(from);
    await storageMod.loadSession(to);
    release();
    await sweep;
  } finally {
    release?.();
    sessionArea.get = realGet;
  }
  return { a, b };
}

test('durable recovery routes to A even when the user switches from A to B during salvage', async () => {
  const { b } = await raceSalvageWithSessionSwitch({ tabId: 91, from: 'A', to: 'B',
    rec: { originSessionId: 'A', bg: false } });
  assert.deepEqual(await history(), b, 'A must not leak into B live history');
  const a = (await localArea.get('session_A')).session_A;
  assert.equal(a.at(-1).steps[0].target, 'A-private-file');
});

test('a backgrounded durable turn writes to live A after switching back, so autosave cannot erase it', async () => {
  await raceSalvageWithSessionSwitch({ tabId: 92, from: 'B', to: 'A',
    rec: { originSessionId: 'A', bg: true } });
  assert.equal((await history()).at(-1).steps?.[0]?.target, 'A-private-file');
  await storageMod.updateSessionHistory('A');
  assert.equal((await localArea.get('session_A')).session_A.at(-1).steps[0].target, 'A-private-file');
});

test('an unflushed empty origin routes by its saved history generation after a switch', async () => {
  const { b } = await raceSalvageWithSessionSwitch({ tabId: 93, from: 'A', to: 'B',
    rec: { originSessionId: '', originContextId: 'ctxA', originHistoryGeneration: 'genA', bg: false } });
  assert.deepEqual(await history(), b);
  assert.equal((await localArea.get('session_A')).session_A.at(-1).steps[0].target, 'A-private-file');
});

test('an empty-origin turn writes to live A after switching back to the uniquely matching generation', async () => {
  await raceSalvageWithSessionSwitch({ tabId: 106, from: 'B', to: 'A',
    rec: { originSessionId: '', originContextId: 'ctxA', originHistoryGeneration: 'genA', bg: true } });
  assert.equal((await history()).at(-1).steps?.[0]?.target, 'A-private-file');
  await storageMod.updateSessionHistory('A');
  assert.equal((await localArea.get('session_A')).session_A.at(-1).steps?.[0]?.target, 'A-private-file');
});

test('legacy mirrors with no origin identity recover separately without guessing the active conversation', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'B unrelated question' }];
  await localArea.set({ history: live, activeSessionId: 'B', agentSessionState: { contextId: 'ctxB', ids: {} },
    savedSessions: [{ id: 'B', name: 'B', createdAt: 2, agentContextId: 'ctxB', agentSessions: {} }], session_B: live });
  await sessionArea.set({ 'browsa.inflightTurns': [94],
    'browsa.inflightTurn.94': { acc: '', startedAt: 1, epoch: 1, recoveryId: 'legacy-94',
      bg: false, originSessionId: '', steps: [{ k: 'tool', name: 'read', target: 'unknown-origin' }] } });
  assert.ok((await salvageDurableTurns()).has(94));
  assert.deepEqual(await history(), live);
  const sessions = (await localArea.get('savedSessions')).savedSessions;
  const rescued = sessions.find(s => s.id !== 'B');
  assert.ok(rescued, 'an unowned recovery must be placed in its own session');
  assert.equal((await localArea.get(`session_${rescued.id}`))[`session_${rescued.id}`].at(-1).steps[0].target, 'unknown-origin');
});

test('two legacy mirrors without IDs recover independently, including a text-only record', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'unrelated' }];
  await localArea.set({ history: live, activeSessionId: 'B', agentSessionState: { contextId: 'ctxB', ids: {} },
    savedSessions: [{ id: 'B', name: 'B', createdAt: 2, agentContextId: 'ctxB', agentSessions: {} }], session_B: live });
  await sessionArea.set({ 'browsa.inflightTurns': [95, 96],
    'browsa.inflightTurn.95': { acc: 'old partial text', startedAt: 1, epoch: 1 },
    'browsa.inflightTurn.96': { acc: '', startedAt: 2, epoch: 1, steps: [{ k: 'tool', name: 'read', target: 'old file' }] } });
  const realSet = sessionArea.set.bind(sessionArea);
  const realRemove = sessionArea.remove.bind(sessionArea);
  sessionArea.set = async obj => {
    if ('browsa.inflightTurns' in obj) throw new Error('simulated death before cleanup');
    return realSet(obj);
  };
  sessionArea.remove = async () => { throw new Error('simulated death before cleanup'); };
  try {
    assert.equal((await salvageDurableTurns()).size, 2);
  } finally {
    sessionArea.set = realSet;
    sessionArea.remove = realRemove;
  }
  assert.equal((await salvageDurableTurns()).size, 2, 'the same mirrors can be replayed safely');
  assert.deepEqual(await history(), live);
  const sessions = (await localArea.get('savedSessions')).savedSessions.filter(s => s.id !== 'B');
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, sessions[1].id);
  const bodies = await Promise.all(sessions.map(async s => (await localArea.get(`session_${s.id}`))[`session_${s.id}`]));
  assert.ok(bodies.some(h => h.at(-1).content === 'old partial text'));
  assert.ok(bodies.some(h => h.at(-1).steps?.[0]?.target === 'old file'));
  assert.ok(bodies.every(h => h.filter(isInterruptedEntry).length === 1), 'each recovery is appended only once');
  assert.equal((await salvageDurableTurns()).size, 0);
});

test('empty-origin recovery does not guess a saved live session sharing its context', async () => {
  for (const includeOtherSnapshot of [true, false]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const live = [{ role: 'user', content: 'B fork' }];
    const liveGeneration = includeOtherSnapshot ? 'shared-generation' : 'different-generation';
    await localArea.set({ history: live, activeSessionId: 'B', historyGeneration: liveGeneration, agentSessionState: { contextId: 'shared', ids: {} },
      savedSessions: [{ id: 'B', name: 'B', createdAt: 2, historyGeneration: liveGeneration, agentContextId: 'shared', agentSessions: {} },
        ...(includeOtherSnapshot ? [{ id: 'A', name: 'A', createdAt: 1, historyGeneration: 'shared-generation', agentContextId: 'shared', agentSessions: {} }] : [])],
      session_B: live, ...(includeOtherSnapshot ? { session_A: [{ role: 'user', content: 'A fork' }] } : {}) });
    await sessionArea.set({ 'browsa.inflightTurns': [97], 'browsa.inflightTurn.97': {
      acc: '', startedAt: 1, epoch: 1, recoveryId: 'fork-97', originSessionId: '', originContextId: 'shared', originHistoryGeneration: 'shared-generation',
      steps: [{ k: 'tool', name: 'read', target: 'uncertain origin' }] } });
    assert.ok((await salvageDurableTurns()).has(97));
    assert.deepEqual(await history(), live, 'the shared context does not prove that B owns this turn');
    const sessions = (await localArea.get('savedSessions')).savedSessions;
    const rescued = sessions.find(s => s.id !== 'A' && s.id !== 'B');
    assert.ok(rescued, 'ambiguous recovery has its own session');
    assert.equal((await localArea.get(`session_${rescued.id}`))[`session_${rescued.id}`].at(-1).steps[0].target, 'uncertain origin');
  }
});

test('conflicting origin id and context do not write into the active session', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'replacement A' }];
  await localArea.set({ history: live, activeSessionId: 'A', agentSessionState: { contextId: 'replacement', ids: {} },
    savedSessions: [{ id: 'A', name: 'replacement', createdAt: 1, agentContextId: 'replacement', agentSessions: {} }], session_A: live });
  await sessionArea.set({ 'browsa.inflightTurns': [100], 'browsa.inflightTurn.100': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'conflict-100', originSessionId: 'A', originContextId: 'original',
    steps: [{ k: 'tool', name: 'read', target: 'original-only' }] } });
  assert.ok((await salvageDurableTurns()).has(100));
  assert.deepEqual(await history(), live);
  assert.deepEqual((await localArea.get('session_A')).session_A, live);
  const recovered = (await localArea.get('savedSessions')).savedSessions.find(s => s.id !== 'A');
  assert.ok(recovered);
  assert.equal((await localArea.get(`session_${recovered.id}`))[`session_${recovered.id}`].at(-1).steps[0].target, 'original-only');
});

test('a stale live context cannot route into an active snapshot that autosave would overwrite', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'A history' }];
  await localArea.set({ history: live, activeSessionId: 'A', agentSessionState: { contextId: 'stale-B', ids: {} },
    savedSessions: [{ id: 'A', name: 'A', createdAt: 1, agentContextId: 'ctxA', agentSessions: {} }], session_A: live });
  await sessionArea.set({ 'browsa.inflightTurns': [102], 'browsa.inflightTurn.102': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'stale-context-102', originSessionId: 'A', originContextId: 'ctxA',
    steps: [{ k: 'tool', name: 'read', target: 'A-only' }] } });
  assert.ok((await salvageDurableTurns()).has(102));
  assert.deepEqual(await history(), live);
  assert.deepEqual((await localArea.get('session_A')).session_A, live, 'do not write the active snapshot behind stale live history');
  const recovered = (await localArea.get('savedSessions')).savedSessions.find(s => s.id !== 'A');
  assert.ok(recovered, 'conflicting live identity requires an isolated recovery session');
  await storageMod.updateSessionHistory('A');
  assert.equal((await localArea.get(`session_${recovered.id}`))[`session_${recovered.id}`].at(-1).steps[0].target, 'A-only');
});

test('clearing the last message and starting a new unsaved conversation cannot reuse the old recovery origin', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({ history: [{ role: 'user', content: 'old request' }], activeSessionId: '',
    historyGeneration: 'old-generation', agentSessionState: { contextId: 'shared-old-context', ids: {} } });
  await sessionArea.set({ 'browsa.inflightTurns': [103], 'browsa.inflightTurn.103': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'old-turn-103', originSessionId: '', originContextId: 'shared-old-context', originHistoryGeneration: 'old-generation',
    steps: [{ k: 'tool', name: 'read', target: 'old-private-file' }] } });
  await storageMod.removeHistoryEntryByIndex(0); // setHistory([]) clears the saved-session pointer
  assert.notEqual((await localArea.get('historyGeneration')).historyGeneration, 'old-generation');
  await storageMod.appendToHistory({ role: 'user', content: 'new unrelated request' });
  assert.ok((await salvageDurableTurns()).has(103));
  assert.deepEqual(await history(), [{ role: 'user', content: 'new unrelated request' }]);
  const recovered = (await localArea.get('savedSessions')).savedSessions?.find(s => s.id !== '');
  assert.ok(recovered, 'old turn needs its own recovery session');
  assert.equal((await localArea.get(`session_${recovered.id}`))[`session_${recovered.id}`].at(-1).steps[0].target, 'old-private-file');
});

test('history generation survives save and load, but rotates on clear without changing the saved history', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({ history: [{ role: 'user', content: 'original' }], activeSessionId: '',
    historyGeneration: 'generation-original', agentSessionState: { contextId: 'agent-original', ids: { sample: 'kept' } } });
  const saved = await storageMod.saveCurrentSession('original');
  const meta = (await localArea.get('savedSessions')).savedSessions.find(s => s.id === saved.id);
  assert.equal(meta.historyGeneration, 'generation-original');
  await storageMod.clearHistory();
  const afterClear = (await localArea.get(['historyGeneration', 'agentSessionState']));
  assert.notEqual(afterClear.historyGeneration, 'generation-original');
  await storageMod.loadSession(saved.id);
  const afterLoad = await localArea.get(['history', 'historyGeneration', 'agentSessionState']);
  assert.equal(afterLoad.historyGeneration, 'generation-original');
  assert.deepEqual(afterLoad.history, [{ role: 'user', content: 'original' }]);
  assert.equal(afterLoad.agentSessionState.contextId, 'agent-original');
  assert.equal((await storageMod.getAll()).historyGeneration, undefined, 'recovery-only identity is a targeted read, not part of getAll');
});

test('saving an existing session as a new session creates a distinct history generation', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const h = [{ role: 'user', content: 'same starting history' }];
  await localArea.set({ history: h, activeSessionId: '', historyGeneration: 'original-generation',
    agentSessionState: { contextId: 'same-agent', ids: {} } });
  const first = await storageMod.saveCurrentSession('identical name');
  assert.equal(first.historyGeneration, 'original-generation', 'first save preserves the unsaved source');
  const fork = await storageMod.saveCurrentSession('identical name');
  assert.notEqual(fork.historyGeneration, first.historyGeneration, 'a new saved branch needs a different source identity');
  const stored = await localArea.get(['history', 'historyGeneration', 'savedSessions']);
  assert.equal(stored.historyGeneration, fork.historyGeneration);
  assert.equal(stored.savedSessions.find(s => s.id === first.id).historyGeneration, first.historyGeneration);
  assert.equal(stored.savedSessions.find(s => s.id === first.id).agentContextId, stored.savedSessions.find(s => s.id === fork.id).agentContextId);
  assert.deepEqual(stored.history, h);
  await storageMod.loadSession(first.id);
  assert.equal((await localArea.get('historyGeneration')).historyGeneration, first.historyGeneration);
});

test('a failed save-as write cannot split snapshot identity from the live pointer and generation', async () => {
  for (const crash of ['before', 'after']) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const historyA = [{ role: 'user', content: 'original' }];
    await localArea.set({ history: historyA, activeSessionId: 'A', historyGeneration: 'generation-A',
      agentSessionState: { contextId: 'same-agent', ids: {} },
      savedSessions: [{ id: 'A', name: 'same', createdAt: 1, historyGeneration: 'generation-A', agentContextId: 'same-agent', agentSessions: {} }],
      session_A: historyA });
    const realSet = localArea.set.bind(localArea);
    let intercepted = false;
    localArea.set = async obj => {
      if (!intercepted && 'savedSessions' in obj && Object.keys(obj).some(k => k.startsWith('session_'))) {
        intercepted = true;
        if (crash === 'after') await realSet(obj);
        throw new Error('simulated save-as interruption');
      }
      return realSet(obj);
    };
    try { await assert.rejects(storageMod.saveCurrentSession('same'), /simulated save-as interruption/); }
    finally { localArea.set = realSet; }
    const current = await localArea.get(['history', 'activeSessionId', 'historyGeneration', 'savedSessions']);
    assert.deepEqual(current.history, historyA);
    const active = current.savedSessions.find(s => s.id === current.activeSessionId);
    assert.ok(active, 'live pointer always names an existing snapshot');
    assert.equal(active.historyGeneration, current.historyGeneration, 'live generation matches that snapshot');
    if (crash === 'before') assert.equal(current.activeSessionId, 'A');
    else assert.notEqual(current.activeSessionId, 'A');
  }
});

test('loading a legacy snapshot assigns a generation without changing its history or agent identity', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const oldHistory = [{ role: 'user', content: 'legacy question' }];
  await localArea.set({ history: [{ role: 'user', content: 'other' }], historyGeneration: 'other-generation',
    activeSessionId: '', agentSessionState: { contextId: 'other-agent', ids: {} },
    savedSessions: [{ id: 'old', name: 'old', createdAt: 1, agentContextId: 'legacy-agent', agentSessions: { key: 'value' } }],
    session_old: oldHistory });
  assert.equal(await storageMod.loadSession('old'), 1);
  const state = await localArea.get(['history', 'historyGeneration', 'agentSessionState', 'savedSessions', 'session_old']);
  const meta = state.savedSessions.find(s => s.id === 'old');
  assert.ok(meta.historyGeneration);
  assert.equal(state.historyGeneration, meta.historyGeneration);
  assert.notEqual(state.historyGeneration, 'other-generation');
  assert.deepEqual(state.history, oldHistory);
  assert.deepEqual(state.session_old, oldHistory);
  assert.equal(state.agentSessionState.contextId, 'legacy-agent');
  assert.deepEqual(state.agentSessionState.ids, { key: 'value' });
});

test('legacy context alone cannot identify an unsaved live conversation', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'new request' }];
  await localArea.set({ history: live, activeSessionId: '', historyGeneration: 'new-generation',
    agentSessionState: { contextId: 'same-agent', ids: {} } });
  await sessionArea.set({ 'browsa.inflightTurns': [104], 'browsa.inflightTurn.104': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'legacy-context-104', originSessionId: '', originContextId: 'same-agent',
    steps: [{ k: 'tool', name: 'read', target: 'old file' }] } });
  assert.ok((await salvageDurableTurns()).has(104));
  assert.deepEqual(await history(), live);
  const recovered = (await localArea.get('savedSessions')).savedSessions?.[0];
  assert.ok(recovered);
  assert.equal((await localArea.get(`session_${recovered.id}`))[`session_${recovered.id}`].at(-1).steps[0].target, 'old file');
});

test('a saved history generation remains authoritative if SW death interrupts the later agent-identity write', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'A history' }];
  await localArea.set({ history: live, activeSessionId: 'A', historyGeneration: 'generation-A',
    agentSessionState: { contextId: 'stale-agent-B', ids: {} },
    savedSessions: [{ id: 'A', name: 'A', createdAt: 1, historyGeneration: 'generation-A', agentContextId: 'agent-A', agentSessions: {} }], session_A: live });
  await sessionArea.set({ 'browsa.inflightTurns': [105], 'browsa.inflightTurn.105': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'half-write-105', originSessionId: 'A',
    originContextId: 'agent-A', originHistoryGeneration: 'generation-A',
    steps: [{ k: 'tool', name: 'read', target: 'A file' }] } });
  assert.ok((await salvageDurableTurns()).has(105));
  assert.equal((await history()).at(-1).steps?.[0]?.target, 'A file');
  await storageMod.updateSessionHistory('A');
  assert.equal((await localArea.get('session_A')).session_A.at(-1).steps?.[0]?.target, 'A file');
});

test('a crash after the history write cannot leave clear or load with a mismatched generation', async () => {
  for (const operation of ['clear', 'load']) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const b = [{ role: 'user', content: 'B history' }];
    const a = [{ role: 'user', content: 'A history' }];
    await localArea.set({ history: b, activeSessionId: 'B', historyGeneration: 'generation-B',
      agentSessionState: { contextId: 'agent-B', ids: {} },
      savedSessions: [{ id: 'A', name: 'A', createdAt: 1, historyGeneration: 'generation-A', agentContextId: 'agent-A', agentSessions: {} }], session_A: a });
    const realSet = localArea.set.bind(localArea);
    let crashed = false;
    localArea.set = async obj => {
      if (!crashed && 'history' in obj) {
        crashed = true;
        await realSet(obj);
        throw new Error('simulated SW death after the history write');
      }
      return realSet(obj);
    };
    try {
      await assert.rejects(operation === 'clear' ? storageMod.clearHistory() : storageMod.loadSession('A'), /simulated SW death/);
    } finally {
      localArea.set = realSet;
    }
    const state = await localArea.get(['history', 'activeSessionId', 'historyGeneration']);
    if (operation === 'clear') {
      assert.deepEqual(state.history, []);
      assert.equal(state.activeSessionId, '');
      assert.notEqual(state.historyGeneration, 'generation-B');
    } else {
      assert.deepEqual(state.history, a);
      assert.equal(state.activeSessionId, 'A');
      assert.equal(state.historyGeneration, 'generation-A');
    }
  }
});

test('recovery chooses its destination after an in-flight history clear releases the history lock', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const a = [{ role: 'user', content: 'original A' }];
  await localArea.set({ history: a, activeSessionId: 'A', agentSessionState: { contextId: 'ctxA', ids: {} },
    savedSessions: [{ id: 'A', name: 'A', createdAt: 1, agentContextId: 'ctxA', agentSessions: {} }], session_A: a });
  await sessionArea.set({ 'browsa.inflightTurns': [99], 'browsa.inflightTurn.99': {
    acc: '', startedAt: 1, epoch: 1, recoveryId: 'clear-99', originSessionId: 'A', originContextId: 'ctxA',
    steps: [{ k: 'tool', name: 'read', target: 'A file' }] } });
  let release, notify;
  const gate = new Promise(r => { release = r; });
  const held = new Promise(r => { notify = r; });
  const clear = storageMod.mutateHistory(async () => { notify(); await gate; return []; });
  await held;
  const sweep = salvageDurableTurns();
  await tick(30); // let the sweep contend with the held history lock
  release();
  await clear;
  assert.ok((await sweep).has(99));
  assert.deepEqual(await history(), [], 'the freshly cleared live history stays empty');
  assert.equal((await localArea.get('session_A')).session_A.at(-1).steps[0].target, 'A file');
});

test('steps-only recovery is idempotent if the mirror survives a successful history write', async () => {
  for (const origin of ['live', 'saved', 'deleted']) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const live = [{ role: 'user', content: 'live request' }];
    const original = [{ role: 'user', content: 'original request' }];
    await localArea.set({ history: live, ...(origin === 'live' ? { historyGeneration: 'genLive', agentSessionState: { contextId: 'ctxLive', ids: {} } } : {}),
      savedSessions: origin === 'saved' ? [{ id: 'origin', name: 'origin', createdAt: 1, textDigest: '' }] : [],
      ...(origin === 'saved' ? { session_origin: original } : {}),
    });
    const rec = { acc: '', startedAt: 1700000000000, epoch: 2,
      bg: origin !== 'live', originSessionId: origin === 'live' ? '' : 'origin',
      ...(origin === 'live' ? { originContextId: 'ctxLive', originHistoryGeneration: 'genLive' } : {}),
      steps: [{ k: 'tool', name: 'edit', target: 'src/a.ts' }] };
    await sessionArea.set({ 'browsa.inflightTurns': [76], 'browsa.inflightTurn.76': rec });
    const realSet = sessionArea.set.bind(sessionArea);
    const realRemove = sessionArea.remove.bind(sessionArea);
    sessionArea.set = async (obj) => {
      if ('browsa.inflightTurns' in obj) throw new Error('simulated worker death before cleanup');
      return realSet(obj);
    };
    sessionArea.remove = async () => { throw new Error('simulated worker death before cleanup'); };
    try {
      assert.ok((await salvageDurableTurns()).has(76));
    } finally {
      sessionArea.set = realSet;
      sessionArea.remove = realRemove;
    }
    // A fresh wake finds the same mirror, but the first write already landed.
    assert.ok((await salvageDurableTurns()).has(76));
    const result = origin === 'live' ? await history() : (await localArea.get('session_origin')).session_origin;
    assert.equal(result.filter(isInterruptedEntry).length, 1, `${origin}: exactly one recovered turn`);
    if (origin !== 'live') assert.deepEqual(await history(), live, 'no cross-session write');
    assert.deepEqual(await readDurableTurns(), []);
  }
});

test('a legacy steps-only mirror is retained when assigning its stable recovery identity fails', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({ historyGeneration: 'legacy-generation', agentSessionState: { contextId: 'legacy-context', ids: {} } });
  await sessionArea.set({ 'browsa.inflightTurns': [77],
    'browsa.inflightTurn.77': { acc: '', startedAt: 1700000000001, epoch: 1,
      originContextId: 'legacy-context', originHistoryGeneration: 'legacy-generation', steps: [{ k: 'tool', name: 'read', target: 'file' }] } });
  const realSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async (obj) => {
    if (obj['browsa.inflightTurn.77']) throw new Error('storage unavailable');
    return realSet(obj);
  };
  try {
    assert.equal((await salvageDurableTurns()).size, 0);
    assert.deepEqual(await history(), [], 'must not write an entry that cannot be deduplicated');
    assert.ok((await sessionArea.get('browsa.inflightTurn.77'))['browsa.inflightTurn.77']);
  } finally {
    sessionArea.set = realSet;
  }
  assert.ok((await salvageDurableTurns()).has(77), 'the next wake can safely retry');
  assert.equal((await history()).length, 1);
});

test('a legacy text mirror also remains recoverable when its identity cannot be saved', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  const live = [{ role: 'user', content: 'unrelated' }];
  await localArea.set({ history: live, activeSessionId: 'B', agentSessionState: { contextId: 'ctxB', ids: {} },
    savedSessions: [{ id: 'B', name: 'B', createdAt: 1, agentContextId: 'ctxB', agentSessions: {} }], session_B: live });
  await sessionArea.set({ 'browsa.inflightTurns': [101],
    'browsa.inflightTurn.101': { acc: 'unowned text', startedAt: 1, epoch: 1 } });
  const realSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async obj => {
    if (obj['browsa.inflightTurn.101']) throw new Error('identity write failed');
    return realSet(obj);
  };
  try {
    assert.equal((await salvageDurableTurns()).size, 0);
    assert.ok((await sessionArea.get('browsa.inflightTurn.101'))['browsa.inflightTurn.101']);
    assert.deepEqual(await history(), live);
  } finally {
    sessionArea.set = realSet;
  }
  assert.ok((await salvageDurableTurns()).has(101));
  const recovered = (await localArea.get('savedSessions')).savedSessions.find(s => s.id !== 'B');
  assert.ok(recovered);
  assert.equal((await localArea.get(`session_${recovered.id}`))[`session_${recovered.id}`].at(-1).content, 'unowned text');
  assert.deepEqual(await history(), live);
});

test('steps-only recovery keeps the mirror when writing the original saved or deleted session fails', async () => {
  for (const originExists of [true, false]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    const live = [{ role: 'user', content: 'other session' }];
    await localArea.set({ history: live,
      savedSessions: originExists ? [{ id: 'origin', name: 'origin', createdAt: 1, textDigest: '' }] : [],
      ...(originExists ? { session_origin: [{ role: 'user', content: 'original request' }] } : {}),
    });
    await sessionArea.set({ 'browsa.inflightTurns': [83],
      'browsa.inflightTurn.83': { acc: '', startedAt: 1700000000003, epoch: 1, bg: true,
        originSessionId: 'origin', steps: [{ k: 'tool', name: 'read', target: 'file' }] } });
    const realSet = localArea.set.bind(localArea);
    localArea.set = async (obj) => {
      if ('session_origin' in obj) throw new Error('session write failed');
      return realSet(obj);
    };
    try {
      assert.equal((await salvageDurableTurns()).size, 0);
      assert.ok((await sessionArea.get('browsa.inflightTurn.83'))['browsa.inflightTurn.83']);
      assert.deepEqual(await history(), live);
    } finally {
      localArea.set = realSet;
    }
    assert.ok((await salvageDurableTurns()).has(83));
    assert.equal((await localArea.get('session_origin')).session_origin.filter(isInterruptedEntry).length, 1);
    assert.deepEqual(await history(), live);
  }
});

test('concurrent mirror begins on different tabs do not lose an index entry', async () => {
  sessionArea._reset();
  streamState.clear();
  const realGet = sessionArea.get.bind(sessionArea);
  let release;
  const gate = new Promise(r => { release = r; });
  let blocked = true;
  sessionArea.get = async (key) => {
    const result = await realGet(key);
    if (key === 'browsa.inflightTurns' && blocked) await gate;
    return result;
  };
  try {
    initStreamState(81);
    initStreamState(82);
    await tick(20);
    blocked = false;
    release();
    await tick(20);
    const ids = (await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'];
    assert.deepEqual([...ids].sort(), [81, 82]);
    clearStreamState(81);
    clearStreamState(82);
    await tick(20);
  } finally {
    blocked = false;
    release();
    sessionArea.get = realGet;
  }
});

test('a mirror end racing a different tab begin leaves only the new tab indexed', async () => {
  sessionArea._reset();
  streamState.clear();
  await sessionArea.set({ 'browsa.inflightTurns': [81],
    'browsa.inflightTurn.81': { acc: 'old', startedAt: 1, epoch: 1 } });
  const realGet = sessionArea.get.bind(sessionArea);
  let release;
  const gate = new Promise(r => { release = r; });
  let blocked = true;
  sessionArea.get = async (key) => {
    const result = await realGet(key);
    if (key === 'browsa.inflightTurns' && blocked) await gate;
    return result;
  };
  try {
    const ending = stateMod.durableTurnEnd(81, 1);
    initStreamState(82);
    await tick(20);
    blocked = false;
    release();
    await ending;
    await tick(20);
    assert.deepEqual((await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'], [82]);
    clearStreamState(82);
    await tick(20);
  } finally {
    blocked = false;
    release();
    sessionArea.get = realGet;
  }
});

test('a new live turn is not overwritten while a legacy mirror receives a recovery identity', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await sessionArea.set({ 'browsa.inflightTurns': [78],
    'browsa.inflightTurn.78': { acc: '', startedAt: 1700000000002, epoch: 1,
      steps: [{ k: 'tool', name: 'read', target: 'old file' }] } });
  const realSet = sessionArea.set.bind(sessionArea);
  let release, notify;
  const blocked = new Promise(r => { notify = r; });
  const gate = new Promise(r => { release = r; });
  sessionArea.set = async (obj) => {
    if (obj['browsa.inflightTurn.78']?.steps?.[0]?.target === 'old file') {
      notify();
      await gate;
    }
    return realSet(obj);
  };
  try {
    const sweep = salvageDurableTurns();
    await Promise.race([blocked, new Promise((_, reject) => setTimeout(() => reject(new Error('identity write was not attempted')), 500))]);
    const current = initStreamState(78, { providerLabel: 'new turn' });
    release();
    await sweep;
    await tick(20);
    const record = (await sessionArea.get('browsa.inflightTurn.78'))['browsa.inflightTurn.78'];
    assert.equal(record.epoch, current.epoch, 'the active turn retains its own mirror');
    assert.equal(record.providerLabel, 'new turn');
    assert.deepEqual(await history(), [], 'the interrupted sweep must not write under the live turn');
    clearStreamState(78);
    await tick();
  } finally {
    release?.();
    sessionArea.set = realSet;
  }
});

async function startCancelableToolTurn(tabId, acc = '') {
  const controller = new AbortController();
  chatControllers.set(tabId, controller);
  const st = initStreamState(tabId, { ownerController: controller, providerLabel: 'old turn' });
  st.steps = [{ k: 'tool', name: 'read', target: 'file' }];
  if (acc) appendToStreamState(tabId, acc);
  else stateMod.scheduleDurableTurnFlush(tabId);
  await flushDurable();
  return { controller, st };
}

test('handled tool-only stop or explicit drop cannot resurrect on the next SW wake', async () => {
  for (const salvage of [true, false]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    chatControllers.clear();
    const { controller } = await startCancelableToolTurn(84, salvage ? '' : 'partial text');
    const result = await handle({ type: 'STREAM_ABORT', tabId: 84, salvage });
    assert.equal(controller.signal.aborted, true, 'the underlying request stops immediately');
    assert.equal(result.durableDiscarded, true, 'the discard is durable before the message completes');
    stateMod.scheduleDurableTurnFlush(84); // a late callback must not revive the mirror
    await flushDurable();
    streamState.delete(84);
    chatControllers.delete(84);
    assert.equal((await salvageDurableTurns()).size, 0);
    assert.deepEqual(await history(), []);
  }
});

test('a failed durable discard reports failure and retains the old mirror', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  const { controller } = await startCancelableToolTurn(85);
  const realSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async (obj) => {
    if (obj['browsa.inflightTurn.85']?.discarded) throw new Error('storage unavailable');
    return realSet(obj);
  };
  try {
    const result = await handle({ type: 'STREAM_ABORT', tabId: 85, salvage: false });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.durableDiscarded, false, 'the response must not claim the discard was saved');
    const rec = (await sessionArea.get('browsa.inflightTurn.85'))['browsa.inflightTurn.85'];
    assert.ok(rec);
    assert.notEqual(rec.discarded, true, 'the original evidence remains when the write fails');
  } finally {
    sessionArea.set = realSet;
    clearStreamState(85);
    chatControllers.delete(85);
    await tick(20);
  }
});

test('discard after abort cleanup never recreates the old mirror', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  const { controller } = await startCancelableToolTurn(86);
  controller.signal.addEventListener('abort', () => clearStreamState(86), { once: true });
  const result = await handle({ type: 'STREAM_ABORT', tabId: 86, salvage: false });
  assert.equal(result.durableDiscarded, true);
  assert.equal((await sessionArea.get('browsa.inflightTurn.86'))['browsa.inflightTurn.86'], undefined);
  chatControllers.delete(86);
});

test('discarding an old turn never overwrites a newer turn mirror', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  await startCancelableToolTurn(87);
  const realSet = sessionArea.set.bind(sessionArea);
  let notify, release;
  const entered = new Promise(r => { notify = r; });
  const gate = new Promise(r => { release = r; });
  sessionArea.set = async (obj) => {
    if (obj['browsa.inflightTurn.87']?.discarded) { notify(); await gate; }
    return realSet(obj);
  };
  try {
    const abort = handle({ type: 'STREAM_ABORT', tabId: 87, salvage: false });
    await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('discard write not attempted')), 500))]);
    const next = initStreamState(87, { providerLabel: 'new turn' });
    chatControllers.set(87, new AbortController());
    release();
    await abort;
    await tick(20);
    const rec = (await sessionArea.get('browsa.inflightTurn.87'))['browsa.inflightTurn.87'];
    assert.equal(rec.recoveryId, next.recoveryId);
    assert.equal(rec.providerLabel, 'new turn');
    assert.notEqual(rec.discarded, true);
    clearStreamState(87);
    chatControllers.delete(87);
    await tick(20);
  } finally {
    release();
    sessionArea.set = realSet;
  }
});

test('a controller in setup cannot discard another live turn’s mirror', async () => {
  sessionArea._reset();
  streamState.clear();
  chatControllers.clear();
  const previousController = new AbortController();
  const old = initStreamState(89, { ownerController: previousController, providerLabel: 'old turn' });
  await tick(20);
  const setupController = new AbortController();
  chatControllers.set(89, setupController);
  await handle({ type: 'STREAM_ABORT', tabId: 89, salvage: false });
  assert.equal(setupController.signal.aborted, true);
  assert.notEqual(old.durableSuppressed, true);
  const rec = (await sessionArea.get('browsa.inflightTurn.89'))['browsa.inflightTurn.89'];
  assert.equal(rec.recoveryId, old.recoveryId);
  assert.notEqual(rec.discarded, true);
  clearStreamState(89);
  chatControllers.delete(89);
  await tick(20);
});

test('empty, malformed, and note-only durable records do not create a recovered assistant turn', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await sessionArea.set({
    'browsa.inflightTurns': [73, 74, 75],
    'browsa.inflightTurn.73': { acc: '   ', steps: [] },
    'browsa.inflightTurn.74': { acc: '', steps: [null, {}, { k: 'tool', name: '  ' }] },
    'browsa.inflightTurn.75': { acc: '', steps: [{ k: 'note', text: 'thinking' }] },
  });
  assert.equal((await salvageDurableTurns()).size, 0);
  assert.deepEqual(await history(), []);
  assert.deepEqual(await readDurableTurns(), []);
});


// ---- 2. salvage -------------------------------------------------------------

test('salvage: SW death mid-turn appends the partial as an interrupted entry (live-history routing)', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  await localArea.set({ historyGeneration: 'live-22' });
  initStreamState(22, { providerLabel: 'OpenSquilla', providerKey: { name: 'sq', model: 'm1' }, originSessionId: '',
    originContextId: await storageMod.getAgentSessionContextId(), originHistoryGeneration: 'live-22' });
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

// ─── 2026-11-05 audit: REASSIGN/PEEK routing changes must reach the mirror ────
// The durable record only flushed on delta/tool-step. A turn backgrounded
// during a QUIET window (waiting on approval / long tool) kept bg:false,
// origin:'' in storage.session — SW death then salvaged the partial into
// LIVE history, the exact cross-conversation leak REASSIGN exists to prevent.

test('REASSIGN mid-turn flushes bg/origin into the durable record (silent window)', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({
    savedSessions: [{ id: 's9', name: 'origin', createdAt: Date.now(), pinned: false, textDigest: '' }],
    session_s9: [{ role: 'user', content: 'earlier' }],
  });
  initStreamState(26, { providerLabel: 'X', originSessionId: '' });
  appendToStreamState(26, '部分输出');
  await flushDurable();

  // Session switch with NO further deltas: only the routing flags change.
  const r = await handle({ type: 'REASSIGN_STREAM_SESSION', tabId: 26, sessionId: 's9' });
  assert.equal(r.reassigned, true);
  await flushDurable();

  const rec = (await sessionArea.get('browsa.inflightTurn.26'))['browsa.inflightTurn.26'];
  assert.equal(rec.bg, true, 'the durable mirror must carry the backgrounded flag');
  assert.equal(rec.originSessionId, 's9', 'the durable mirror must carry the origin session');

  // SW death: salvage routes by the MIRRORED flags, not the dead Maps.
  streamState.clear();
  const salvaged = await salvageDurableTurns();
  assert.ok(salvaged.has(26));
  assert.ok(!(await history()).some((m) => m.content === '部分输出'), 'must not leak into live history');
  const body = (await localArea.get('session_s9'))['session_s9'];
  assert.equal(body[body.length - 1].content, '部分输出');
  clearStreamState(26);
  await tick();
});

test('PEEK un-backgrounding flushes bg:false into the durable record', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  initStreamState(27, { providerLabel: 'X', originSessionId: 's9' });
  streamState.get(27).bg = true;
  appendToStreamState(27, 'x');
  await flushDurable();

  await handle({ type: 'STREAM_PEEK', tabId: 27, sessionId: 's9' });
  await flushDurable();
  const rec = (await sessionArea.get('browsa.inflightTurn.27'))['browsa.inflightTurn.27'];
  assert.equal(rec.bg, false, 'switching back must reach the mirror too');
  clearStreamState(27);
  await tick();
});

test('salvage: a failed persist keeps the durable record for the next wake (no evidence destroyed)', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  await localArea.set({ historyGeneration: 'live-28' });
  initStreamState(28, { providerLabel: 'X', originSessionId: '', originContextId: await storageMod.getAgentSessionContextId(), originHistoryGeneration: 'live-28' });
  appendToStreamState(28, '不能丢的残片');
  await flushDurable();
  streamState.clear(); // SW death

  // Quota/lock failure on the salvage write: storage.local.set rejects once.
  const realSet = localArea.set.bind(localArea);
  let failed = false;
  localArea.set = async (obj) => {
    if (!failed && obj && 'history' in obj) { failed = true; throw new Error('quota exceeded'); }
    return realSet(obj);
  };
  try {
    const first = await salvageDurableTurns();
    assert.equal(first.size, 0, 'the failed write is not reported as salvaged');
    assert.ok((await sessionArea.get('browsa.inflightTurn.28'))['browsa.inflightTurn.28'],
      'the only copy of the partial must survive a failed persist');
  } finally {
    localArea.set = realSet;
  }

  // Next wake retries and succeeds.
  const second = await salvageDurableTurns();
  assert.ok(second.has(28), 'the retry salvages the turn');
  assert.equal((await history()).pop().content, '不能丢的残片');
  assert.deepEqual(await readDurableTurns(), [], 'consumed only after a successful write');
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

test('real error with a LIVE panel: ERROR chunk + state/durable cleared, tombstone replayable (no RELEASE dependency)', async () => {
  // sw-4（2026-11-03）：旧代码在端口仍在时不清态、不 tombstone，指望面板的
  // STREAM_RELEASE 收尾。面板恰在该窗口被销毁 → RELEASE 永不来 → 无 controller
  // 的僵尸活到 10 分钟 GC 被裸删，durable 记录残留，下次 SW 醒来被当 interrupted
  // 条目追加进当时的 live history（迟到且乱序）。现在真实错误一律 ERROR+清态。
  sessionArea._reset();
  await localArea.set({
    providers: { p1: { baseUrl: 'https://api.test/v1', apiKey: 'k', apiStyle: 'chat', alias: 'T' } },
    activeProvider: 'p1',
  });
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  let pulls = 0;
  // 先流出一段文本再真实错误：durable 镜像里有可收尸的 acc，断言才有分量。
  globalThis.fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    body: new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial before error"}}]}\n\n'));
        else c.error(new Error('live panel error'));
      },
    }),
  });
  streamState.clear();
  streamPorts.clear();
  clearTerminalTombstone(32);
  const received = [];
  streamPorts.set(32, { postMessage: (m) => received.push(m), disconnect: () => {} }); // panel connected
  try {
    await assert.rejects(
      handle({ type: 'CHAT', tabId: 32, userText: 'hi', sessionId: undefined }),
      /live panel error/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(streamState.has(32), false, 'state cleared even with a live panel — no dependence on STREAM_RELEASE arriving');
  const errs = received.filter((m) => m.type === 'ERROR');
  assert.equal(errs.length, 1, 'the live panel receives the ERROR chunk (finalizes the partial text)');
  assert.match(String(errs[0].error), /live panel error/);
  const t = takeTerminalTombstone(32);
  assert.equal(t?.type, 'ERROR', 'tombstoned too — a panel dying before reading the chunk still finalizes via resume replay');
  await tick(20);
  const recs = await readDurableTurns();
  assert.ok(!recs.some((r) => r.tabId === 32), 'the durable mirror must be gone — no late salvage of a terminally-errored turn');
  assert.equal((await sessionArea.get('browsa.inflightTurn.32'))['browsa.inflightTurn.32'], undefined, 'durable record removed');
  streamState.clear();
  streamPorts.clear();
  clearTerminalTombstone(32);
});

test('GC reaping a zombie streamState also clears its durable record (no late interrupted entry)', async () => {
  // sw-4 兜底层：gcStreamState 曾裸 Map.delete，绕过 clearStreamState 的
  // durableTurnEnd——被回收僵尸的 durable 记录留在索引里，下次 SW 醒来
  // salvage 把早已终结的残片当 interrupted 条目追加进 live history。
  sessionArea._reset();
  streamState.clear();
  chatControllers.clear();
  const st = initStreamState(51);
  appendToStreamState(51, 'zombie partial');
  await flushDurable();
  assert.ok((await sessionArea.get('browsa.inflightTurn.51'))['browsa.inflightTurn.51'], 'sanity: durable record on disk');
  // 无 controller/run 且超 TTL → GC 可回收。
  st.startedAt = Date.now() - 11 * 60 * 1000;
  st.lastDeltaAt = st.startedAt;
  for (const fn of alarmListeners) fn({ name: 'browsa-stream-gc' });
  assert.equal(streamState.has(51), false, 'GC reaped the zombie');
  await tick(20); // durableTurnEnd 是 fire-and-forget
  assert.equal((await sessionArea.get('browsa.inflightTurn.51'))['browsa.inflightTurn.51'], undefined,
    'GC must go through clearStreamState — the durable record must not survive the reap');
  const idx = (await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'] || [];
  assert.ok(!idx.includes(51), 'the durable index must not keep the reaped tab');
  const recs = await readDurableTurns();
  assert.ok(!recs.some((r) => r.tabId === 51), 'nothing left to salvage');
  streamState.clear();
});

test('durableTurnEnd from an old turn must not delete a newer turn\'s mirror (epoch compare, sw-3)', async () => {
  // 旧回合的异步尾巴（clearStreamState/salvage 的 durableTurnEnd）落地时，
  // 新回合可能已写入自己的镜像——读出的记录 epoch 与被清回合一致才删。
  sessionArea._reset();
  streamState.clear();
  const st1 = initStreamState(61);
  appendToStreamState(61, 'old partial');
  await flushDurable();
  const st2 = initStreamState(61); // 取代：新 epoch、新镜像
  appendToStreamState(61, 'new partial');
  await flushDurable();
  assert.ok(st2.epoch > st1.epoch, 'sanity: epoch bumped');

  await stateMod.durableTurnEnd(61, st1.epoch); // 旧回合迟到的清理
  const rec = (await sessionArea.get('browsa.inflightTurn.61'))['browsa.inflightTurn.61'];
  assert.ok(rec, 'the newer turn\'s durable record must survive the old turn\'s late cleanup');
  assert.equal(rec.acc, 'new partial');
  const idx = (await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'] || [];
  assert.ok(idx.includes(61), 'the index entry must survive too');

  await stateMod.durableTurnEnd(61, st2.epoch); // 本回合的清理正常删除
  assert.equal((await sessionArea.get('browsa.inflightTurn.61'))['browsa.inflightTurn.61'], undefined);
  const idx2 = (await sessionArea.get('browsa.inflightTurns'))['browsa.inflightTurns'] || [];
  assert.ok(!idx2.includes(61));
  streamState.clear();
});

// ---- 3b. THE handler call site: a tool event schedules the durable flush ----
// The state-layer tests above prove the mirror carries `steps`. They do NOT
// prove chat-handler's onToolProgress ASKS for the flush — deleting that call
// left them green (verified by mutation). This walks a real `handle()` bridge
// turn whose stream emits a tool event and NO text delta, then asserts the
// durable record gained the step.

test('chat-handler: a tool event alone (no delta) mirrors the step durably', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  streamPorts.clear();
  await localArea.set({
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948', apiKey: '', model: '' } },
    activeProvider: 'br',
  });

  const enc = new TextEncoder();
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    async pull(c) {
      c.enqueue(enc.encode('data: {"type":"tool","name":"edit","status":"started","detail":"src/app.ts"}\n\n'));
      await gate;                       // hold the stream open across the assertion
      c.enqueue(enc.encode('data: {"type":"done","full":"ok"}\n\n'));
      c.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  const received = [];
  const { port, deliver } = fakePort(received);
  streamPorts.set(41, port.port);
  deliver({ type: 'STREAM_HELLO', tabId: 41 });

  const chatP = handle({ type: 'CHAT', tabId: 41, userText: 'fix it', sessionId: undefined });

  // Wait for the tool event to be consumed by the handler.
  for (let i = 0; i < 100 && !(streamState.get(41)?.steps?.length); i++) await tick();
  assert.equal(streamState.get(41)?.steps?.length, 1, 'the handler recorded the step');
  assert.equal(streamState.get(41).acc, '', 'no text delta arrived — this is the long-tool-call window');

  await flushDurable();
  const rec = (await sessionArea.get('browsa.inflightTurn.41'))['browsa.inflightTurn.41'];
  assert.ok(rec, 'durable record exists');
  assert.ok(Array.isArray(rec.steps) && rec.steps.length === 1,
    'the tool step reached the durable mirror WITHOUT any delta — deleting the flush call turns this red');
  assert.equal(rec.steps[0].name, 'edit');
  assert.equal(rec.acc, '', 'still no text');

  release();
  await chatP;
  globalThis.fetch = undefined;
});

test('real bridge tool event survives a simulated SW death before any reply text', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  streamPorts.clear();
  await localArea.set({
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948', apiKey: '', model: '' } },
    activeProvider: 'br',
  });
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"type":"tool","name":"edit","status":"started","detail":"src/app.ts"}\n\n'));
      opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason), { once: true });
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  let controller;
  let chatP;
  try {
    chatP = handle({ type: 'CHAT', tabId: 79, userText: 'fix it' });
    for (let i = 0; i < 100 && !streamState.get(79)?.steps?.length; i++) await tick();
    assert.equal(streamState.get(79)?.acc, '');
    assert.equal(streamState.get(79)?.steps?.[0]?.target, 'src/app.ts');
    await flushDurable();
    controller = chatControllers.get(79);
    streamState.delete(79);
    chatControllers.delete(79); // the dead worker's Maps no longer exist
    assert.ok((await salvageDurableTurns()).has(79));
    const recovered = (await history()).at(-1);
    assert.equal(recovered.content, '');
    assert.equal(recoveryMeta(recovered)?.interrupted, true);
    assert.equal(recovered.steps[0].name, 'edit');
    assert.equal(recovered.steps[0].target, 'src/app.ts');
    assert.equal(recovered.steps[0].ok, undefined);
  } finally {
    controller?.abort('drop'); // terminate the simulated old worker's held socket
    if (chatP) await chatP;
    globalThis.fetch = realFetch;
  }
});

test('a real unsaved turn retains its source when switched before reassignment reaches the mirror', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  const b = [{ role: 'user', content: 'unrelated B' }];
  await localArea.set({
    agentSessionState: { contextId: 'origin-context', ids: {} },
    savedSessions: [{ id: 'B', name: 'B', createdAt: 1, agentContextId: 'other-context', agentSessions: {} }],
    session_B: b,
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948', apiKey: '', model: '' } },
    activeProvider: 'br',
  });
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"tool","name":"read","status":"started","detail":"origin-file"}\n\n'));
      opts.signal.addEventListener('abort', () => c.error(opts.signal.reason), { once: true });
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  let chatP, controller;
  try {
    chatP = handle({ type: 'CHAT', tabId: 98, userText: 'original request' });
    for (let i = 0; i < 100 && !streamState.get(98)?.steps?.length; i++) await tick();
    await flushDurable();
    const mirror = (await sessionArea.get('browsa.inflightTurn.98'))['browsa.inflightTurn.98'];
    assert.equal(mirror.originSessionId, '');
    assert.equal(mirror.originContextId, 'origin-context');
    assert.ok(mirror.originHistoryGeneration, 'the original history generation is captured before streaming');
    const saved = await storageMod.saveCurrentSession('original');
    assert.equal(saved.historyGeneration, mirror.originHistoryGeneration);
    await storageMod.loadSession('B');
    // The SW dies before REASSIGN_STREAM_SESSION flushes origin/bg flags.
    controller = chatControllers.get(98);
    streamState.delete(98);
    chatControllers.delete(98);
    assert.ok((await salvageDurableTurns()).has(98));
    assert.deepEqual(await history(), b);
    const original = (await localArea.get(`session_${saved.id}`))[`session_${saved.id}`];
    assert.equal(original.at(-1).steps[0].target, 'origin-file');
  } finally {
    (controller || chatControllers.get(98))?.abort('drop');
    if (chatP) await chatP;
    globalThis.fetch = realFetch;
  }
});

test('user cancel and explicit drop do not later recover a tool-only live turn', async () => {
  for (const salvage of [true, false]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    streamPorts.clear();
    await localArea.set({
      providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948', apiKey: '', model: '' } },
      activeProvider: 'br',
    });
    const realFetch = globalThis.fetch;
    const enc = new TextEncoder();
    globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('data: {"type":"tool","name":"read","status":"started","detail":"file"}\n\n'));
        opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason), { once: true });
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    let chatP;
    try {
      chatP = handle({ type: 'CHAT', tabId: 80, userText: 'inspect' });
      for (let i = 0; i < 100 && !streamState.get(80)?.steps?.length; i++) await tick();
      assert.equal(streamState.get(80)?.acc, '');
      await flushDurable();
      await handle({ type: 'STREAM_ABORT', tabId: 80, salvage });
      await chatP;
      await tick(20);
      assert.equal((await salvageDurableTurns()).size, 0);
      assert.equal((await history()).filter(m => m.role === 'assistant').length, 0);
      assert.equal((await sessionArea.get('browsa.inflightTurn.80'))['browsa.inflightTurn.80'], undefined);
    } finally {
      chatControllers.get(80)?.abort('drop');
      if (chatP) await chatP;
      globalThis.fetch = realFetch;
    }
  }
});

test('user cancel with streamed text still saves the partial interrupted reply', async () => {
  sessionArea._reset();
  localArea._reset();
  streamState.clear();
  chatControllers.clear();
  await localArea.set({
    providers: { br: { isBridge: true, alias: 'codex', baseUrl: 'http://127.0.0.1:3948', apiKey: '', model: '' } },
    activeProvider: 'br',
  });
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"type":"tool","name":"read","status":"started","detail":"file"}\n\n'));
      controller.enqueue(enc.encode('data: {"type":"delta","text":"partial reply"}\n\n'));
      opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason), { once: true });
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  let chatP;
  try {
    chatP = handle({ type: 'CHAT', tabId: 88, userText: 'inspect' });
    for (let i = 0; i < 100 && !streamState.get(88)?.acc; i++) await tick();
    assert.equal(streamState.get(88)?.acc, 'partial reply');
    await handle({ type: 'STREAM_ABORT', tabId: 88, salvage: true });
    await chatP;
    const entry = (await history()).at(-1);
    assert.equal(entry.content, 'partial reply');
    assert.equal(entry.interrupted, true);
    assert.equal(entry.steps[0].name, 'read');
  } finally {
    chatControllers.get(88)?.abort('drop');
    if (chatP) await chatP;
    globalThis.fetch = realFetch;
  }
});

test('stopping silent continuation or timestamp rewrite preserves visible text; explicit drop skips it', async () => {
  for (const [mode, salvage] of [['continuation', true], ['continuation', false],
    ['timestamp', true], ['timestamp', false], ['continuationDelta', true]]) {
    sessionArea._reset();
    localArea._reset();
    streamState.clear();
    chatControllers.clear();
    const visible = 'ALREADY VISIBLE TEXT '.repeat(4).trim();
    await localArea.set({ providers: { p1: { type: 'llm', alias: 'llm', baseUrl: 'https://api.test/v1', apiKey: 'x', apiStyle: 'chat' } }, activeProvider: 'p1',
      ...(mode === 'timestamp' ? { history: [{ role: 'user', content: 'video transcript', videoSrc: { tabId: 130, url: 'https://youtu.be/x' } }] } : {}) });
    let firstReady, releaseFirst, secondReady, writeStarted, releaseWrite;
    const firstSeen = new Promise(r => { firstReady = r; });
    const firstGate = new Promise(r => { releaseFirst = r; });
    const secondSeen = new Promise(r => { secondReady = r; });
    const writeSeen = new Promise(r => { writeStarted = r; });
    const writeGate = new Promise(r => { releaseWrite = r; });
    const enc = new TextEncoder();
    const realFetch = globalThis.fetch;
    const realSet = localArea.set.bind(localArea);
    let calls = 0, chatP, silentStream;
    globalThis.fetch = async (_url, opts) => {
      if (++calls === 1) return new Response(new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: visible } }] })}\n\n`));
          firstReady();
          await firstGate;
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: mode === 'timestamp' ? 'stop' : 'length' }] })}\n\ndata: [DONE]\n\n`));
          c.close();
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(new ReadableStream({
        start(c) { silentStream = c; secondReady(); opts.signal.addEventListener('abort', () => c.error(opts.signal.reason), { once: true }); },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    localArea.set = async (obj) => {
      if (obj.history?.some(m => m.role === 'assistant')) { writeStarted(); await writeGate; }
      return realSet(obj);
    };
    try {
      chatP = handle({ type: 'CHAT', tabId: 130, userText: mode === 'timestamp' ? 'summarize video' : 'hello' });
      await firstSeen;
      for (let i = 0; i < 100 && !streamState.get(130)?.acc; i++) await tick();
      await flushDurable();
      const mirrorBeforeContinue = (await sessionArea.get('browsa.inflightTurn.130'))['browsa.inflightTurn.130'];
      const liveContext = (await localArea.get('agentSessionState')).agentSessionState.contextId;
      assert.equal(mirrorBeforeContinue.originContextId, liveContext, 'stateless turns persist their actual source identity');
      assert.equal(mirrorBeforeContinue.originHistoryGeneration, (await localArea.get('historyGeneration')).historyGeneration);
      releaseFirst();
      await secondSeen;
      if (mode === 'continuationDelta') {
        silentStream.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"NOT YET VISIBLE"}}]}\n\n'));
        for (let i = 0; i < 100 && !streamState.get(130)?.acc; i++) await tick();
        await flushDurable();
        assert.equal((await sessionArea.get('browsa.inflightTurn.130'))['browsa.inflightTurn.130'].acc, visible,
          'a silent delta cannot replace the answer the user already saw in the recovery mirror');
      } else {
        assert.equal(streamState.get(130).acc, '', 'the silent leg uses a separate accumulator');
      }
      const result = await handle({ type: 'STREAM_ABORT', tabId: 130, salvage });
      if (salvage) {
        assert.notEqual(result.durableDiscarded, true, 'previously visible text cannot be marked discarded');
        await writeSeen;
        const rec = (await sessionArea.get('browsa.inflightTurn.130'))['browsa.inflightTurn.130'];
        assert.notEqual(rec?.discarded, true);
        assert.equal(rec?.acc, visible);
      }
      releaseWrite();
      await chatP;
      const replies = (await history()).filter(m => m.role === 'assistant');
      if (salvage) assert.equal(replies.at(-1)?.content, visible);
      else assert.equal(replies.length, 0, 'explicit drop must not persist the earlier text');
    } finally {
      releaseFirst?.();
      releaseWrite?.();
      chatControllers.get(130)?.abort('drop');
      if (chatP) await chatP;
      globalThis.fetch = realFetch;
      localArea.set = realSet;
    }
  }
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
    if (frame.method === 'usage.status') {
      // This mock doesn't model usage accounting — fail fast so the
      // best-effort snapshot resolves to null instead of waiting 3s.
      return [{ type: 'res', id: frame.id, ok: false, error: { code: 'UNAVAILABLE', message: 'no usage' } }];
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

// ---- 5. finish-inside-reopen-window (2026-10-14 field report) ----------------
// A turn that COMPLETES while the panel document is being recreated: init's
// renderHistory reads history BEFORE the DONE persists, STREAM_PEEK answers
// after clearStreamState — the reply is in history but rendered nowhere
// (field report: streaming close→reopen showed nothing; thinking-reopen
// worked because the turn was still running and resumed live). PEEK must
// flag a live terminal tombstone (non-consuming!) so the panel re-renders once.
test('STREAM_PEEK reports justFinished when the turn completed inside the reopen window', async () => {
  localArea._reset();
  streamState.clear();
  clearTerminalTombstone(27);
  // The chat-handler DONE tail: terminal tombstone recorded + streamState cleared.
  recordTerminalTombstone(27, { type: 'DONE', full: '完整回复' });
  const peek = await handle({ type: 'STREAM_PEEK', tabId: 27 });
  assert.equal(peek.inFlight, false, 'stream is gone — no resume, no spinner');
  assert.equal(peek.justFinished, true, 'panel is told to re-render (reply persisted behind init render)');

  // No tombstone → a plain not-in-flight peek stays flag-free (no extra render).
  clearTerminalTombstone(27);
  const peek2 = await handle({ type: 'STREAM_PEEK', tabId: 27 });
  assert.deepEqual(peek2, { inFlight: false });

  // PEEK must NOT consume the tombstone — the resume-HELLO replay keeps its one-shot.
  recordTerminalTombstone(27, { type: 'DONE', full: 'x' });
  await handle({ type: 'STREAM_PEEK', tabId: 27 });
  assert.ok(takeTerminalTombstone(27), 'peekTerminalTombstone is read-only; take still delivers');
});
