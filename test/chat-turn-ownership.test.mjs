// test/chat-turn-ownership.test.mjs — per-turn state ownership in the CHAT
// handler.
//
// A second turn can reach the handler for the same tabId (a double-send race
// in the panel before activeController is assigned, or a REASSIGN/replay
// path). Both turns write the SAME per-tab slots (chatControllers,
// streamState, idleTimerResetters, activeRunIds). Before the ownership gate,
// the FIRST turn's finally block unconditionally deleted those slots — so
// the newer turn lost its cancel handle (Esc no longer aborted it), its idle
// resetter (a long tool call got killed at 5 minutes), and its accumulated
// text (PEEK/resume showed an empty bubble).
//
// This file drives the REAL handleChat through a full stream and asserts the
// gate from the OUTSIDE: a superseded turn must persist its reply but must
// not touch the newer turn's state or push a terminal event into it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── minimal chrome + storage mock (local only, no sessions API needed) ──────
const local = {
  history: [],
  providers: {
    llm1: {
      type: 'llm', alias: 'Test', baseUrl: 'http://test', apiKey: 'k',
      model: 'm1', apiStyle: 'chat', stream: true, temperature: null, maxTokens: 0,
    },
  },
  activeProvider: 'llm1',
  activeModel: '',
  autoSummarizeAttachments: false,
};

function installChrome() {
  globalThis.chrome = {
    runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...local };
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in local) out[k] = local[k];
          return out;
        },
        set: async (obj) => { Object.assign(local, obj); },
        remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete local[key]; },
      },
      session: {
        get: async () => ({}), set: async () => {}, remove: async () => {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  };
}

installChrome();

const { handleChat } = await import('../lib/handlers/chat-handler.js');
const {
  streamState, chatControllers, idleTimerResetters, streamPorts,
  initStreamState, clearStreamState, streamEpoch,
} = await import('../lib/state.js');

// A controllable SSE body: the test decides when each turn's stream ends.
function makeSseBody(text) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(
        'data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '},"finish_reason":null}]}\n\n'
      ));
      c.close();
    },
  });
}

function stubFetch() {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: makeSseBody('ok'),
    text: async () => '',
  });
}

function posted(tabId) {
  const out = [];
  streamPorts.set(tabId, { postMessage: (m) => out.push(m) });
  return out;
}

test('a superseded turn persists its reply but does not delete the newer turn\'s controller/state', async () => {
  // Gated SSE: the turn parks inside reader.read() until releaseStream() —
  // that is the window a concurrent send lands in.
  let releaseStream;
  const enc = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(c) {
        releaseStream = () => {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
          c.close();
        };
      },
    }),
    text: async () => '',
  });
  local.history = [];
  const tabId = 7;
  const events = posted(tabId);

  // Start turn A and let it reach the point where it owns the per-tab slots.
  const turnA = handleChat({ type: 'CHAT', userText: 'from A', tabId, sessionId: '' }, '', '');
  for (let i = 0; i < 200 && !streamState.get(tabId); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(streamState.get(tabId), 'turn A must have registered its stream state');

  // Turn B arrives on the same tabId while A is still streaming: it takes
  // over every per-tab slot (exactly what the double-send race does).
  const controllerB = new AbortController();
  chatControllers.set(tabId, controllerB);
  const stateB = initStreamState(tabId, { providerLabel: 'Test', originSessionId: '' });
  const resetterB = () => {};
  idleTimerResetters.set(tabId, resetterB);

  releaseStream();
  await turnA;

  // The superseded turn must NOT push DONE into the live port (that would
  // finalize the wrong bubble) nor clear the newer turn's state.
  assert.equal(events.filter((e) => e.type === 'DONE').length, 0,
    'a superseded turn must not emit DONE into the newer turn\'s port');
  assert.equal(events.filter((e) => e.type === 'CHUNK').length, 0,
    'a superseded turn must not render its deltas into the newer turn\'s bubble');
  assert.equal(stateB.acc, '',
    'a superseded turn must not append its text to the newer accumulator');
  assert.equal(chatControllers.get(tabId), controllerB,
    'the newer turn\'s controller must survive the older turn\'s finally block');
  assert.equal(streamState.get(tabId), stateB,
    'the newer turn\'s stream state must survive');
  assert.equal(idleTimerResetters.get(tabId), resetterB,
    'the newer turn\'s idle resetter must survive');

  // …but its text is still durable: history keeps the reply (never silently
  // drop a completed turn), i.e. exactly one assistant entry landed.
  const assistants = local.history.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'the superseded turn still persists its reply');

  clearStreamState(tabId);
  streamPorts.delete(tabId);
  idleTimerResetters.delete(tabId);
  chatControllers.delete(tabId);
});

test('a live turn still finalizes when GC reaped its streamState (age > TTL)', async () => {
  // Regression (2026-10-21 release audit): the 10-minute GC deleted
  // streamState for LIVE long agent turns (tool calls / pending approval).
  // The ownership gate then compared against a missing object and suppressed
  // DONE forever, leaving the panel spinning even though the reply persisted.
  let releaseStream;
  const enc = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(c) {
        releaseStream = () => {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"late reply"},"finish_reason":"stop"}]}\n\n'));
          c.close();
        };
      },
    }),
    text: async () => '',
  });
  local.history = [];
  const tabId = 9;
  const events = posted(tabId);

  const turn = handleChat({ type: 'CHAT', userText: 'long agent turn', tabId, sessionId: '' }, '', '');
  for (let i = 0; i < 200 && !streamState.get(tabId); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(streamState.get(tabId), 'the turn registered its state');

  // Simulate gcStreamState() reaping the entry while the controller is live.
  streamState.delete(tabId);
  releaseStream();
  await turn;

  assert.equal(events.filter((e) => e.type === 'DONE').length, 1,
    'the live turn must still emit DONE after its state was reaped');
  assert.equal(local.history.filter((m) => m.role === 'assistant').length, 1,
    'the reply is persisted exactly once');
  assert.equal(chatControllers.get(tabId), undefined, 'the turn still cleans its controller');

  streamPorts.delete(tabId);
});

test('a superseded turn\'s continuation leg must not write the merged text into the newer turn\'s accumulator', async () => {
  // 2026-10-24: the continuation/retry/overflow/rewrite outer paths reset and
  // overwrote streamState.get(tabId).acc with NO identity gate. A turn
  // superseded BEFORE its continuation leg captured the slot clobbered the
  // newer turn: the pre-pass reset wrote '' over the newer acc, and the merged
  // write replaced it with the OLD turn's text — poisoning the newer turn's
  // PEEK view.
  let releaseV1;
  let call = 0;
  const enc = new TextEncoder();
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      // v1's stream parks; the test supersedes BEFORE releasing it, so the
      // continuation block's streamState.get() capture lands on turn B.
      return {
        ok: true, status: 200,
        body: new ReadableStream({
          start(c) {
            releaseV1 = () => {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"v1 text"},"finish_reason":"length"}]}\n\n'));
              c.close();
            };
          },
        }),
        text: async () => '',
      };
    }
    // Continuation stream (starts after the supersede — immediate).
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":" (cont)"},"finish_reason":"stop"}]}\n\n'));
          c.close();
        },
      }),
      text: async () => '',
    };
  };
  local.history = [];
  const tabId = 11;
  const events = posted(tabId);

  const turnA = handleChat({ type: 'CHAT', userText: 'from A', tabId, sessionId: '' }, '', '');
  for (let i = 0; i < 200 && !releaseV1; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(releaseV1, 'turn A must have parked inside its first stream');

  // Turn B supersedes while A's v1 stream is parked, with its own accumulated
  // text (what B's PEEK/deltas produced).
  const stateB = initStreamState(tabId, { providerLabel: 'Test', originSessionId: '' });
  stateB.acc = 'NEW TURN TEXT';
  chatControllers.set(tabId, new AbortController());

  // Release v1: it hit the output cap → A's continuation leg fires and (in the
  // old code) captured B's state as its accumulator.
  releaseV1();
  await turnA;

  assert.equal(streamState.get(tabId), stateB, 'the newer turn still owns the state slot');
  assert.equal(stateB.acc, 'NEW TURN TEXT',
    "the superseded turn's continuation must not reset/overwrite the newer accumulator");
  const last = local.history.filter((m) => m.role === 'assistant').pop();
  assert.equal(last?.content, 'v1 text (cont)', 'the superseded turn still persists its own merged reply');
  assert.equal(events.filter((e) => e.type === 'DONE').length, 0,
    'a superseded turn must not emit DONE into the newer turn\'s port');

  clearStreamState(tabId);
  streamPorts.delete(tabId);
  chatControllers.delete(tabId);
  idleTimerResetters.delete(tabId);
});

test('streamEpoch bumps per turn, including after the prior turn cleared its state', () => {
  const tabId = 10;
  const before = streamEpoch(tabId);
  const first = initStreamState(tabId, {});
  assert.equal(first.epoch, before + 1);
  clearStreamState(tabId);
  const second = initStreamState(tabId, {});
  assert.equal(second.epoch, first.epoch + 1,
    'a new turn must bump the epoch even though the state map was cleared');
  clearStreamState(tabId);
});

test('the owning turn does finalize normally (DONE + state cleared)', async () => {
  stubFetch();
  local.history = [];
  const tabId = 8;
  const events = posted(tabId);

  await handleChat({ type: 'CHAT', userText: 'solo', tabId, sessionId: '' }, '', '');

  assert.equal(events.filter((e) => e.type === 'DONE').length, 1, 'the owning turn emits exactly one DONE');
  assert.equal(streamState.get(tabId), undefined, 'the owning turn clears its own stream state');
  assert.equal(chatControllers.get(tabId), undefined, 'the owning turn clears its own controller');
  assert.equal(local.history.filter((m) => m.role === 'assistant').length, 1);

  streamPorts.delete(tabId);
});
