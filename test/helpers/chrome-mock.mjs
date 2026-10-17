// test/helpers/chrome-mock.mjs — shared building blocks for the
// `test/lib-sidepanel-*.test.mjs` execution tests (sidepanel.js loaded into
// jsdom, chrome.* mocked, driven via simulated DOM events). Four of those
// files (lib-sidepanel-streaming, lib-sidepanel-status-dot,
// lib-sidepanel-resume-streaming, lib-sidepanel-ui-prefs) had hand-rolled,
// byte-for-byte identical `makeFakePort()` plus `chrome.tabs`/
// `chrome.storage`/`chrome.action`/`chrome.downloads` mocks — only
// `chrome.runtime.sendMessage`'s per-message routing genuinely differs
// between them, which stays in each test file.
//
// Not used by test/chat-handler-internals.test.mjs, test/subchat.test.mjs,
// or test/lib-detail-thread.test.mjs — those mock a different message
// protocol shape (single-listener background-side ports, SUBCHAT_HELLO
// instead of STREAM_HELLO) and were deliberately left alone rather than
// forced into one over-parameterized "does everything" mock.

/**
 * A fake chrome.runtime.Port. Auto-ACKs a `{type: ackType}` postMessage with
 * a `{type: ackReplyType}` emitted message on the next microtask, mirroring
 * how fast the real background responds to onSend()'s/resumeInFlightStream()'s
 * STREAM_HELLO handshake — without this, tests would fall through to the
 * 500ms safety-net timeout instead of resolving immediately.
 *
 * `trackDisconnect: false` makes `onDisconnect.addListener` a no-op (the
 * listener is registered but never invoked, even by this port's own
 * `disconnect()`) — test/lib-sidepanel-resume-streaming.test.mjs relies on
 * this exact shape and must keep it to avoid changing its test's behavior.
 */
export function makeFakePort(name, { trackDisconnect = true, ackType = 'STREAM_HELLO', ackReplyType = 'STREAM_HELLO_ACK' } = {}) {
  const listeners = [];
  const disconnectListeners = [];
  const port = {
    name,
    sent: [],
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    },
    onDisconnect: {
      addListener: trackDisconnect ? (fn) => disconnectListeners.push(fn) : () => {},
    },
    postMessage: (msg) => {
      port.sent.push(msg);
      if (msg.type === ackType) {
        queueMicrotask(() => port.emit({ type: ackReplyType }));
      }
    },
    disconnect: () => { for (const fn of disconnectListeners) fn(); },
    emit: (msg) => { for (const fn of [...listeners]) fn(msg); },
  };
  return port;
}

/**
 * Builds the chrome.* global surface sidepanel.js's init() needs. Every
 * field here is identical boilerplate across the 4 files this replaces;
 * the two genuine per-test customization points are passed in:
 *   - `sendMessage(msg, cb)`: full control over chrome.runtime.sendMessage,
 *     since each test file's routing logic (GET_CONFIG/STREAM_PEEK/CHAT/...)
 *     is the one thing that's actually different between them. Pass a thin
 *     wrapper like `(msg, cb) => sendMessageHandler(msg).then(cb)` if the
 *     test file wants to keep reassigning an outer `let sendMessageHandler`
 *     mid-test (the wrapper's closure over that `let` picks up reassignment
 *     correctly; passing the `let`'s value directly would not).
 *   - `onConnect(name, port)`: called for every chrome.runtime.connect() —
 *     use it to capture e.g. `if (name === 'browsa-chat') lastChatPort = port`.
 * `tabId`/`portOptions`/`storageLocalSet` cover the remaining small
 * variations (resume-streaming uses tabId 7; resume-streaming also needs
 * `trackDisconnect: false`; ui-prefs asserts on storage.local.set calls).
 */
export function makeSidepanelChromeMock({
  tabId = 1,
  sendMessage,
  onConnect,
  portOptions,
  storageLocalSet = async () => {},
} = {}) {
  return {
    tabs: {
      query: async () => [{ id: tabId, url: 'https://example.com/', title: 'Example' }],
      get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }),
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    runtime: {
      connect: ({ name }) => {
        const port = makeFakePort(name, portOptions);
        onConnect?.(name, port);
        return port;
      },
      sendMessage,
      lastError: undefined,
    },
    storage: {
      local: { get: async () => ({}), set: storageLocalSet, remove: async () => {} },
      session: { get: async () => ({}), remove: async () => {} },
      onChanged: { addListener: () => {} },
    },
    action: { setBadgeText: () => {} },
    downloads: { download: async () => {} },
  };
}

/**
 * Wraps a `(msg) => Promise<response>` handler into the `(msg, cb)` shape
 * chrome.runtime.sendMessage actually uses, with the same error-to-{ok:false}
 * conversion all 4 original test files hand-rolled identically.
 */
export function wireSendMessage(handler) {
  return (msg, cb) => {
    Promise.resolve(handler(msg)).then((res) => cb(res)).catch((e) => cb({ ok: false, error: e.message }));
  };
}

// ─── Why there is no single "makeEverythingChromeMock" here (2026-10-17) ─────
// A sweep of the 118 test files that build their own chrome mock produced the
// comparison table below. The remaining mocks are NOT copies: each collapses
// when parameterized, because the DIFFERENCES are the protocol under test.
//
//   surfaces | shape                          | count | examples
//   ---------|--------------------------------|-------|-----------------------------
//   7        | jsdom + Port + downloads        |   3   | lib-sidepanel-asr-video/-youtube/attach-hint
//   5        | jsdom + Port                    |   5   | lib-sidepanel-asr/attach-progress/bridge-endpoint-ping/multimodel/screenshot-undo
//   5        | background-shaped (no jsdom)    |   2   | agentic-extract, lib-page-extract-frame-gone
//   2-3      | storage-only or runtime-only    |  ~20  | history-compactor, composer-state, pdf/katex/office worker clients
//   0        | bare `globalThis.chrome = {}`   |   4   | abort, background-handler, subchat, stream-resume
//
// The three 7-surface files DO share `makeSidepanelChromeMock` above and
// already use it. Everything below that line differs in its port ACK protocol
// (STREAM_HELLO vs SUBCHAT_HELLO vs none), its sendMessage routing table, or
// its storage seeding — the exact things a test exists to pin. Forcing them
// into one factory would add a parameter per axis and make a failure message
// point at the factory instead of the test.
//
// RULE for new tests: use `makeSidepanelChromeMock` when you are driving
// sidepanel.js; use `makeStorageArea` for any storage-shaped mock; build a
// bespoke object only when the protocol itself is what you are testing, and
// delete the parts you do not use (a mock that defines a surface the code
// under test never touches hides dead paths).

/**
 * A stateful chrome.storage.local area backed by one in-memory object.
 *
 * 21 test files had hand-rolled this (only the `remove` array handling and a
 * couple of `_dump`/`_set` conveniences differed), so a change to Chrome's
 * storage semantics had to be mirrored 21 times. This one is a superset:
 * `get(null | string | string[] | object)` with Chrome's shapes, `set` merging,
 * `remove` accepting either a key or an array, plus `_dump()` / `_set()` /
 * `_reset()` for assertions, seeding and per-test isolation.
 *
 * `{ clone: true }` deep-copies on every read/write — real chrome.storage
 * serializes, so a test that mutates a returned object and expects storage to
 * be unaffected needs it (chat-rebuild-channels relies on exactly that to
 * prove the rebuild passes don't reuse request objects).
 */
export function makeStorageArea(initial = {}, { clone = false } = {}) {
  let store = clone ? structuredClone(initial) : { ...initial };
  const cp = clone ? (v) => (v === undefined ? v : structuredClone(v)) : (v) => v;
  return {
    async get(keys) {
      if (keys == null) return cp({ ...store });
      if (typeof keys === 'string') return { [keys]: cp(store[keys]) };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = cp(store[k]);
        return out;
      }
      // Object form: defaults for absent keys (Chrome's documented behavior).
      const out = {};
      for (const [k, fallback] of Object.entries(keys)) out[k] = k in store ? cp(store[k]) : fallback;
      return out;
    },
    async set(obj) { store = { ...store, ...cp(obj) }; },
    async remove(keyOrKeys) {
      for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) delete store[k];
    },
    _set(obj) { store = { ...store, ...cp(obj) }; },
    _reset() { store = {}; },
    _dump() { return store; },
  };
}
