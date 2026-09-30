// test/stream-resume.test.mjs
// Regression test for the "switch tab mid-stream → reply appears stuck" bug.
//
// Before the fix, switching tabs tore down the side panel iframe, which
// killed the streaming port. The background had no record that a stream
// was in flight, so when the user switched back, the new panel only
// saw the "▍" placeholder forever — storage doesn't update until DONE.
//
// After the fix, background.js keeps a streamState Map<tabId, { acc, ... }>
// that survives port churn. A freshly-arriving side panel can PEEK it
// and pre-render the accumulated text, then keep receiving live deltas
// through a brand-new port.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --------------- chrome mock -------------------------------------------------
// Minimal mock: just enough to import background.js without crashing.
// We don't actually exercise the full CHAT path here — we just check
// the new STREAM_PEEK / STREAM_RELEASE message types and the
// streamState retention behavior across port disconnects.

const portListeners = []; // collected for later inspection
const ports = new Map(); // tabId -> { port, onMessage, onDisconnect, postMessage, disconnect }

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onConnect: {
      addListener: (cb) => {
        // Stash so a test can simulate connect() if it wants
        chromeMock.runtime._onConnect = cb;
      }
    },
    sendMessage: () => {},
    connect: (opts) => {
      // Return a no-op port; real testing of the port would need a
      // harness that runs background.js inside a service worker.
      return {
        name: opts?.name,
        postMessage: () => {},
        disconnect: () => {},
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} }
      };
    },
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com', title: 'Test' }),
  },
  sidePanel: {
    setOptions: () => {},
    setPanelBehavior: async () => {},
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => [{ result: { text: '# Mock page\n\nMock.', articleTitle: 'Mock', wasCapped: false, rawTextLength: 20 } }],
  },
  storage: {
    onChanged: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

// --------------- import ------------------------------------------------------
// Dynamic import so the mock is in place before background.js evaluates.
const bg = await import('../background.js');
const { handle, streamState, streamPorts, initStreamState, appendToStreamState, clearStreamState } = bg;
const { pushChunk } = await import('../lib/state.js'); // same module instance bg uses (not re-exported)

// --------------- tests -------------------------------------------------------

test('STREAM_PEEK returns inFlight: false when no stream is active', async () => {
  // Reset state for isolation
  streamState.clear();
  streamPorts.clear();

  const r = await handle({ type: 'STREAM_PEEK', tabId: 99 });
  assert.equal(r.inFlight, false, 'no streamState → PEEK must say not in flight');
});

test('STREAM_PEEK returns inFlight: true + acc after a stream starts', async () => {
  streamState.clear();
  streamPorts.clear();

  initStreamState(7);
  appendToStreamState(7, 'Hello, ');
  appendToStreamState(7, 'world!');

  const r = await handle({ type: 'STREAM_PEEK', tabId: 7 });
  assert.equal(r.inFlight, true);
  assert.equal(r.acc, 'Hello, world!');
  assert.ok(r.startedAt > 0, 'startedAt should be a positive timestamp');
  assert.ok(r.lastDeltaAt >= r.startedAt, 'lastDeltaAt should be >= startedAt');
});

test('STREAM_RELEASE clears streamState', async () => {
  streamState.clear();
  initStreamState(7);
  appendToStreamState(7, 'partial reply');

  const r = await handle({ type: 'STREAM_RELEASE', tabId: 7 });
  assert.equal(r.released, true);

  // PEEK now should report not in flight
  const peek = await handle({ type: 'STREAM_PEEK', tabId: 7 });
  assert.equal(peek.inFlight, false);
});

test('STREAM_RELEASE is idempotent (safe to call when no state exists)', async () => {
  streamState.clear();
  const r = await handle({ type: 'STREAM_RELEASE', tabId: 9999 });
  assert.equal(r.released, true);
});

test('streamState survives the streaming port disconnecting (the actual bug)', async () => {
  streamState.clear();
  streamPorts.clear();

  // Simulate the start of a stream
  initStreamState(42);
  appendToStreamState(42, 'partial');
  // A port is registered for tab 42 (we just use a fake port object
  // because pushChunk is gated on streamPorts.get()).
  const fakePort = { postMessage: () => {}, disconnect: () => {} };
  streamPorts.set(42, fakePort);

  // PEEK while connected: should return in-flight + acc
  const peek1 = await handle({ type: 'STREAM_PEEK', tabId: 42 });
  assert.equal(peek1.inFlight, true);
  assert.equal(peek1.acc, 'partial');

  // Now simulate the side panel being torn down: the port disconnects.
  // The background's onDisconnect handler deletes the port from
  // streamPorts — but it must NOT touch streamState. The LLM is still
  // running and accumulating into streamState.acc.
  streamPorts.delete(42);

  // More deltas stream in (they get pushed to nowhere because no port
  // is connected, but the streamState still grows).
  appendToStreamState(42, ' reply');

  // User switches back to this tab, a NEW side panel session asks PEEK.
  // Without this fix, PEEK would return {inFlight: false} and the new
  // panel would render nothing. With the fix, the new panel sees
  // everything the LLM produced during the user's absence.
  const peek2 = await handle({ type: 'STREAM_PEEK', tabId: 42 });
  assert.equal(peek2.inFlight, true, 'PEEK must return inFlight even when no port is connected');
  assert.equal(peek2.acc, 'partial reply', 'PEEK must return the full accumulated text');
});

test('STREAM_HELLO does not push a drain CHUNK (would double-count acc)', async () => {
  // The design decision: the side panel pre-renders the peek.acc itself
  // before opening the port. If the background also pushed the same
  // text as a CHUNK on STREAM_HELLO, the side panel's acc += m.delta
  // would double the reply. We verify the no-drain invariant by
  // inspecting the source for the absence of a drain push in the
  // STREAM_HELLO branch (the comment that documents the decision is
  // the contract).
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
  // STREAM_HELLO is an `if` branch (not a switch case) — find the
  // branch and verify no CHUNK postMessage appears between the HELLO
  // block and the STREAM_GOODBYE branch.
  const helloStart = src.indexOf("msg.type === 'STREAM_HELLO'");
  const goodbyeStart = src.indexOf("msg.type === 'STREAM_GOODBYE'", helloStart);
  assert.ok(helloStart > 0, 'STREAM_HELLO branch must exist');
  assert.ok(goodbyeStart > 0, 'STREAM_GOODBYE branch must exist');
  const helloBranch = src.slice(helloStart, goodbyeStart);
  assert.ok(
    !/postMessage\([^)]*CHUNK/.test(helloBranch),
    'STREAM_HELLO must NOT push a drain CHUNK; side panel pre-renders from PEEK'
  );
  // Positive control: STREAM_HELLO_ACK IS posted, that's how the
  // side panel knows the background registered the port.
  assert.ok(
    /postMessage\([^)]*STREAM_HELLO_ACK/.test(helloBranch),
    'STREAM_HELLO must post STREAM_HELLO_ACK so the side panel can race-free wire up listeners'
  );
});

test('CHAT handler initializes streamState BEFORE first delta (no lost window)', async () => {
  // Read the source and verify the order: initStreamState(tabId) must
  // appear before the onDelta callback in the CHAT handler. If the
  // init ran after the first delta, a fast LLM could fire a delta
  // before streamState existed, and PEEK would return inFlight:false
  // for that one chunk. (Real bug class — easy to regress.)
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // Find the stream dispatch and check that initStreamState(tabId, …)
  // appears earlier in the file. (Prefix match: the call now also carries
  // the reply-source stamp {providerLabel, providerKey} — the no-lost-window
  // invariant is about the ORDER, not the exact argument list. The LLM legs
  // dispatch through lib/handlers/stream-dispatch.js.)
  const chatIdx = src.indexOf('dispatchStyleStream({');
  const initIdx = src.lastIndexOf('initStreamState(tabId', chatIdx);
  assert.ok(chatIdx > 0, 'chat-handler.js should dispatch the chat stream');
  assert.ok(initIdx > 0 && initIdx < chatIdx,
    'initStreamState(tabId, …) must be called before the stream dispatch in the CHAT handler');
});

test('CHAT handler clears streamState after appendToHistory (no leaks)', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // Find the chatStream call and check that clearStreamState(tabId)
  // appears AFTER appendToHistory in the CHAT handler.
  const persistIdx = src.indexOf('await persistTurnEntry(tabId, { role: \'assistant\'');
  const clearIdx = src.indexOf('clearStreamState(tabId)', persistIdx);
  assert.ok(persistIdx > 0, 'chat-handler should persist assistant turn (via persistTurnEntry — session-scoped)');
  assert.ok(clearIdx > 0,
    'clearStreamState(tabId) must be called after the persist so PEEK stops returning in-flight for a finished reply');
});

test('handle accepts new STREAM_PEEK and STREAM_RELEASE case labels', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(src, /case 'STREAM_PEEK'/, 'handle() must handle STREAM_PEEK');
  assert.match(src, /case 'STREAM_RELEASE'/, 'handle() must handle STREAM_RELEASE');
});

// ─── PEEK→HELLO resume race (2026-09-30 批A) ─────────────────────────────────
// The resume handshake is two steps (PEEK snapshot, then connect+HELLO). A
// turn finishing INSIDE that window pushes its DONE to the old/absent port —
// lost — and streamState is already cleared by HELLO time, so the resuming
// panel used to spin forever. pushChunk now tombstones terminal events and
// the HELLO handler replays them for resume-flagged hellos only.

function fakeChatPort(received) {
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

test('resume HELLO replays the tombstoned DONE when the turn finished inside the PEEK→HELLO window', async () => {
  streamState.clear();
  streamPorts.clear();

  // Stream in flight; the panel PEEKs it (inFlight:true).
  initStreamState(7);
  appendToStreamState(7, 'partial');
  const peek = await handle({ type: 'STREAM_PEEK', tabId: 7 });
  assert.equal(peek.inFlight, true, 'sanity: PEEK sees the stream');

  // The turn completes before the panel's HELLO registers: DONE goes to no
  // port (the old one is gone) and streamState is cleared right after.
  pushChunk(7, { type: 'DONE', full: 'final text', usage: { completion_tokens: 3 }, providerLabel: 'test' });
  clearStreamState(7);

  // The resuming panel connects and HELLOs with resume:true.
  const received = [];
  const { port, deliver } = fakeChatPort(received);
  chromeMock.runtime._onConnect(port);
  deliver({ type: 'STREAM_HELLO', tabId: 7, resume: true });

  assert.equal(received[0]?.type, 'STREAM_HELLO_ACK', 'ACK still comes first');
  assert.equal(received[1]?.type, 'DONE', 'the lost terminal event is replayed onto the new port');
  assert.equal(received[1].full, 'final text', 'replay carries the FULL payload, not a synthetic stub');
  assert.deepEqual(received[1].usage, { completion_tokens: 3 });
  assert.equal(received[1].providerLabel, 'test');

  // Read-once: a second resume HELLO must not replay the same DONE twice —
  // it falls to the synthetic safety net (stream truly gone, nothing to replay).
  received.length = 0;
  deliver({ type: 'STREAM_HELLO', tabId: 7, resume: true });
  assert.equal(received[1]?.type, 'DONE');
  assert.equal(received[1]?.full, null, 'synthetic net: panel finalizes with its PEEK-seeded acc');
  assert.equal(received[1]?.synthetic, true);
});

test('a fresh-send HELLO (no resume flag) NEVER picks up a stale tombstone', async () => {
  streamState.clear();
  streamPorts.clear();

  // A previous turn's DONE left a tombstone…
  initStreamState(7);
  pushChunk(7, { type: 'DONE', full: 'previous turn' });
  clearStreamState(7);

  // …then the user sends a NEW message: onSend's HELLO arrives BEFORE its
  // CHAT even started (no streamState). Replaying the stale DONE here would
  // finalize the fresh empty bubble with the previous turn's text.
  const received = [];
  const { port, deliver } = fakeChatPort(received);
  chromeMock.runtime._onConnect(port);
  deliver({ type: 'STREAM_HELLO', tabId: 7 });

  assert.equal(received.length, 1, 'only the ACK — no tombstone replay without resume:true');
  assert.equal(received[0].type, 'STREAM_HELLO_ACK');
});

test('a resume HELLO while the stream is still live does NOT replay anything', async () => {
  streamState.clear();
  streamPorts.clear();
  initStreamState(7);
  appendToStreamState(7, 'still going');
  // Seed a tombstone from an OLDER turn to prove liveness wins over it.
  const received = [];
  const { port, deliver } = fakeChatPort(received);
  chromeMock.runtime._onConnect(port);
  deliver({ type: 'STREAM_HELLO', tabId: 7, resume: true });
  assert.equal(received.length, 1, 'live stream → ACK only, normal chunk flow continues');
  assert.equal(received[0].type, 'STREAM_HELLO_ACK');
  clearStreamState(7);
});

// ─── REASSIGN empty-origin refusal (2026-09-30 批A) ──────────────────────────

test('REASSIGN_STREAM_SESSION refuses an empty origin (no cross-session leak)', async () => {
  streamState.clear();
  initStreamState(7);

  const refused = await handle({ type: 'REASSIGN_STREAM_SESSION', tabId: 7, sessionId: '' });
  assert.equal(refused.reassigned, false, 'no origin session → refuse to background');
  assert.equal(streamState.get(7).bg, false,
    'bg without origin would make persistTurnEntry fall through to LIVE history — the reply would land in the session the user switched TO');

  const ok = await handle({ type: 'REASSIGN_STREAM_SESSION', tabId: 7, sessionId: 's1' });
  assert.equal(ok.reassigned, true);
  assert.equal(streamState.get(7).bg, true);
  assert.equal(streamState.get(7).originSessionId, 's1');
  clearStreamState(7);
});

test('REASSIGN_STREAM_SESSION for an unknown tab reports reassigned:false', async () => {
  streamState.clear();
  const r = await handle({ type: 'REASSIGN_STREAM_SESSION', tabId: 9999, sessionId: 's1' });
  assert.equal(r.reassigned, false);
});
