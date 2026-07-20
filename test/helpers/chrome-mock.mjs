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
