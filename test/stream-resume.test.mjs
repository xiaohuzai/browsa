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
const { handle, streamState, streamPorts, initStreamState, appendToStreamState, clearStreamState, pushChunk } = bg;

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

  // Find the chatStream call and check that initStreamState(tabId)
  // appears earlier in the file.
  const chatIdx = src.indexOf('chatStream({');
  const initIdx = src.lastIndexOf('initStreamState(tabId)', chatIdx);
  assert.ok(chatIdx > 0, 'chat-handler.js should call chatStream');
  assert.ok(initIdx > 0 && initIdx < chatIdx,
    'initStreamState(tabId) must be called before chatStream() in the CHAT handler');
});

test('CHAT handler clears streamState after appendToHistory (no leaks)', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // Find the chatStream call and check that clearStreamState(tabId)
  // appears AFTER appendToHistory in the CHAT handler.
  const persistIdx = src.indexOf('await storage.appendToHistory({ role: \'assistant\'');
  const clearIdx = src.indexOf('clearStreamState(tabId)', persistIdx);
  assert.ok(persistIdx > 0, 'background.js should persist assistant turn');
  assert.ok(clearIdx > 0,
    'clearStreamState(tabId) must be called after appendToHistory so PEEK stops returning in-flight for a finished reply');
});

test('handle accepts new STREAM_PEEK and STREAM_RELEASE case labels', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(src, /case 'STREAM_PEEK'/, 'handle() must handle STREAM_PEEK');
  assert.match(src, /case 'STREAM_RELEASE'/, 'handle() must handle STREAM_RELEASE');
});
