// test/abort.test.mjs
// Regression test for the v0.20.4 → v0.20.5 cancel-doesn't-actually-cancel bug.
//
// Before: cancelStream() in the side panel only sent STREAM_RELEASE,
// which cleared streamState but did NOT stop the in-flight LLM fetch.
// The fetch kept running, eventually wrote a half-baked assistant turn
// to history, and the user saw a "cancelled" toast plus a phantom reply
// next time they opened the side panel.
//
// After: STREAM_ABORT triggers an AbortController that's threaded
// through the fetch and the SSE reader loop. The fetch throws
// AbortError, the catch block returns {cancelled: true} without
// appending to history, and pushes an ERROR {code: 'ABORTED'} chunk
// so the side panel can render a "cancelled" indicator.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => ({
      name: 'browsa-chat',
      postMessage: () => {},
      disconnect: () => {},
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} }
    }),
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

const bg = await import('../background.js');
const { handle, streamState, streamPorts, chatControllers, initStreamState, appendToStreamState, clearStreamState } = bg;

// --------------- tests -------------------------------------------------------

test('STREAM_ABORT handler is registered', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(src, /case 'STREAM_ABORT'/, 'background.js must handle STREAM_ABORT');
});

test('STREAM_ABORT triggers the AbortController stored for the tab', async () => {
  streamState.clear();
  streamPorts.clear();
  chatControllers.clear();

  // Simulate a chat in flight: store a controller and observe whether
  // abort() gets called.
  let abortCalled = false;
  let abortReason = null;
  const controller = new AbortController();
  const origAbort = controller.abort.bind(controller);
  controller.abort = (reason) => {
    abortCalled = true;
    abortReason = reason;
    return origAbort(reason);
  };
  chatControllers.set(7, controller);
  initStreamState(7);
  appendToStreamState(7, 'partial reply before cancel');

  const r = await handle({ type: 'STREAM_ABORT', tabId: 7 });
  assert.equal(r.aborted, true, 'handler must report abort happened');
  assert.equal(abortCalled, true, 'controller.abort() must be called');
  assert.equal(abortReason, 'user-cancel', 'abort reason should be user-cancel for UX distinguishability');

  // streamState should be cleared (the handler clears it defensively
  // even if the CHAT handler's catch block will do it too).
  assert.equal(streamState.has(7), false, 'streamState must be cleared after abort');
});

test('STREAM_ABORT with no live controller is a safe no-op', async () => {
  streamState.clear();
  chatControllers.clear();

  const r = await handle({ type: 'STREAM_ABORT', tabId: 9999 });
  assert.equal(r.aborted, false, 'handler must report no-op when no controller exists');
});

test('CHAT handler stores AbortController in chatControllers before stream', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // The order must be: controller created → set in chatControllers →
  // passed as signal to chatStream. If the set happens AFTER chatStream
  // returns, a synchronous abort between them is lost.
  const ctrlIdx = src.indexOf('chatControllers.set(tabId, controller)');
  const streamIdx = src.indexOf('chatStream({', ctrlIdx);
  assert.ok(ctrlIdx > 0, 'controller must be set in chatControllers');
  assert.ok(streamIdx > 0 && ctrlIdx < streamIdx,
    'chatControllers.set must be called before chatStream()');
});

test('CHAT handler clears chatControllers in finally (no leaks)', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // chatControllers.delete(tabId) must appear inside a finally block
  // to avoid leaks when the LLM throws a real error.
  const deleteIdx = src.indexOf('chatControllers.delete(tabId)');
  assert.ok(deleteIdx > 0, 'chatControllers must be deleted');
  // Verify it's inside a finally: find the nearest `finally {` opening
  // brace BEFORE deleteIdx.
  const finallyIdx = src.lastIndexOf('finally {', deleteIdx);
  assert.ok(finallyIdx > 0 && finallyIdx < deleteIdx,
    'chatControllers.delete must be inside a finally block to run on errors too');
});

test('CHAT handler catches AbortError and does NOT append to history', async () => {
  // We can't easily run the full CHAT handler here (it calls out to
  // an LLM). Instead, verify the source has a catch that detects
  // AbortError and returns early without reaching the
  // `appendToHistory(tabId, { role: 'assistant'...})` line.
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // The AbortError catch block must (a) detect the abort, (b) push
  // an ERROR {code: 'ABORTED'} chunk, (c) clearStreamState, (d) return
  // before the appendToHistory assistant line.
  const abortMatch = src.match(/e\?\.name === 'AbortError'[\s\S]{0,800}?return \{ ok: true, cancelled: true \}/);
  assert.ok(abortMatch, 'CHAT handler must have a catch block for AbortError that returns cancelled');
  const block = abortMatch[0];
  assert.match(block, /clearStreamState\(tabId\)/, 'catch must clear streamState');
  assert.match(block, /ABORTED/, 'catch must push ERROR with code ABORTED');
  // The appendToHistory assistant line must be AFTER the abort-return
  // in the source — abort returns early, so the line after it only
  // runs on the success path. The check: catch-return's index is
  // strictly less than the next appendToHistory assistant index.
  const catchReturnIdx = src.indexOf('return { ok: true, cancelled: true }');
  const appendIdx = src.indexOf("await storage.appendToHistory({ role: 'assistant'", catchReturnIdx);
  assert.ok(appendIdx > catchReturnIdx,
    'appendToHistory for assistant must appear AFTER the abort-return; abort returns early, skipping it');
});

// --------------- llm-client reader cancellation ----------------------------

test('llm-client reader loop respects the AbortSignal', async () => {
  // Simulate an SSE stream that hangs after the first chunk. The
  // chatStream() promise must resolve (or reject) within tens of ms
  // after we abort, not block forever on reader.read().
  const { chatStream, ProviderNetworkError } = await import('../lib/llm-client.js');

  // Build a fake fetch that returns a ReadableStream we control.
  const encoder = new TextEncoder();
  const ac = new AbortController();
  let pullResolve;
  const chunks = [
    encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
    // Then nothing — reader.read() will block on the next pull.
  ];
  let i = 0;
  const fakeStream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
        return;
      }
      // Block until the abort calls reader.cancel() (handled below).
      pullResolve = () => controller.close();
      // Hold the chunk open indefinitely
    },
    cancel(reason) {
      // reader.cancel() from llm-client's abort listener lands here.
      // This is what unblocks the pending pull().
      if (pullResolve) pullResolve();
    }
  });

  const fakeRes = {
    ok: true,
    status: 200,
    body: fakeStream,
    text: async () => ''
  };
  globalThis.fetch = async (url, opts) => {
    // Verify the signal is passed in
    assert.ok(opts && opts.signal, 'fetch must be called with a signal');
    return fakeRes;
  };

  const deltas = [];
  const streamPromise = chatStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => deltas.push(d),
    signal: ac.signal
  });

  // Let the first chunk be consumed, then abort
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(deltas.length, 1, 'first chunk should have been delivered');
  assert.equal(deltas[0], 'hi');

  ac.abort('user-cancel');
  // The promise should reject with AbortError within a small window
  const t0 = Date.now();
  let rejected = false;
  let err = null;
  try {
    await streamPromise;
  } catch (e) {
    rejected = true;
    err = e;
  }
  const dt = Date.now() - t0;
  assert.ok(rejected, 'chatStream must reject after abort');
  assert.equal(err?.name, 'AbortError', `expected AbortError, got ${err?.name}: ${err?.message}`);
  assert.ok(dt < 200, `abort should unblock reader within 200ms, took ${dt}ms`);
});

test('llm-client reader loop: pre-aborted signal throws AbortError immediately', async () => {
  const { chatStream } = await import('../lib/llm-client.js');

  const encoder = new TextEncoder();
  const fakeStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
    }
  });
  const fakeRes = { ok: true, status: 200, body: fakeStream, text: async () => '' };
  globalThis.fetch = async () => fakeRes;

  const ac = new AbortController();
  ac.abort('pre-aborted');

  let rejected = false;
  let err = null;
  try {
    await chatStream({
      baseUrl: 'http://test',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: () => {},
      signal: ac.signal
    });
  } catch (e) {
    rejected = true;
    err = e;
  }
  assert.ok(rejected, 'pre-aborted signal must reject');
  assert.equal(err?.name, 'AbortError');
});
