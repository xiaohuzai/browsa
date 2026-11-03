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

  const st = initStreamState(32, { providerLabel: 'bridge', providerKey: { name: 'bridge' } });
  st.steps = [];
  appendToStreamState(32, 'partial reply');
  pushTurnStep(st.steps, makeTurnStep({ name: 'bash', target: 'npm test', status: 'done', ok: false }));
  scheduleDurableTurnFlush(32);
  await flushDurable();

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
