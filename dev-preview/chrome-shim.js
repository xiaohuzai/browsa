// dev-preview/chrome-shim.js — browser chrome.* API shim so sidepanel.html /
// options.html render standalone over plain HTTP (no extension context).
// Preview/dev only; never shipped or imported by the extension.
(function () {
  const seedConfig = window.__BROWSA_PREVIEW_SEED || {};

  // ── storage.local ────────────────────────────────────────────────────────
  const mem = { ...seedConfig };
  const storageListeners = [];
  async function storageGet(keys) {
    if (keys === null) return { ...mem };
    if (typeof keys === 'string') return keys in mem ? { [keys]: mem[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in mem) out[k] = mem[k];
      return out;
    }
    const out = {};
    for (const k of Object.keys(keys)) out[k] = k in mem ? mem[k] : keys[k];
    return out;
  }
  const storageLocal = {
    get: storageGet,
    set(obj) { Object.assign(mem, obj); for (const l of storageListeners) l(obj, 'local'); },
    remove(k) { delete mem[k]; },
    clear() { for (const k of Object.keys(mem)) delete mem[k]; },
  };

  // ── runtime port ─────────────────────────────────────────────────────────
  function fakePort(name) {
    return {
      name,
      onMessage: { addListener() {} },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    };
  }

  // ── sendMessage envelope ({ok, data}) by msg.type ───────────────────────
  // Supports BOTH the callback form (ui-utils.js style) and the promise form.
  const pageMeta = seedConfig.__pageMeta || { id: 7, title: '示例页面 — browsa 预览', url: 'https://www.bilibili.com/video/BV1preview' };
  async function handle(msg) {
    switch (msg && msg.type) {
      case 'GET_CONFIG': return { ok: true, data: configData() };
      case 'GET_PAGE_CONTEXT': return { ok: true, data: { mode: msg.mode || 'reader', meta: pageMeta, text: '(预览环境无页面正文)' } };
      case 'STREAM_PEEK': return { ok: true, data: { inFlight: false } };
      case 'GET_SESSIONS': return { ok: true, data: [] };
      default: return { ok: true, data: {} };
    }
  }
  function sendMessage(msg, cb) {
    const p = handle(msg);
    if (typeof cb === 'function') { p.then(cb, () => cb(undefined)); return; }
    return p;
  }
  function configData() {
    return {
      providers: {
        hermes: { type: 'agent', alias: 'Hermes Agent', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
        llm1: { type: 'llm', alias: 'My OpenAI', baseUrl: 'https://api.openai.com', apiKey: 'sk-***', model: 'gpt-4o', apiStyle: 'chat' },
        ...(seedConfig.providers || {}),
      },
      activeProvider: seedConfig.activeProvider || 'llm1',
      pingStates: seedConfig.pingStates || { llm1: 'reachable', hermes: 'unreachable' },
      contextMode: 'auto',
      sendShortcut: 'enter',
      replyLanguage: '',
      llmsTxtEnabled: true,
      history: undefined,
    };
  }

  const tab = () => ({ ...pageMeta });
  const noop = () => {};

  window.chrome = {
    runtime: {
      id: 'browsa-preview',
      connect(opts) { return fakePort((opts && opts.name) || 'default'); },
      sendMessage,
      getURL(p) { return new URL(p, document.baseURI).href; },
      openOptionsPage: noop,
      lastError: undefined,
    },
    storage: {
      local: storageLocal,
      session: { get: async () => ({}), set: noop, remove: noop },
      onChanged: { addListener(l) { storageListeners.push(l); }, removeListener() {} },
    },
    tabs: {
      query: async () => [tab()],
      get: async () => tab(),
      create: noop,
      onActivated: { addListener: noop },
      onUpdated: { addListener: noop },
    },
    cookies: { getAll: async () => [] },
    action: { setBadgeText: noop },
    scripting: { executeScript: async () => [{ result: null }] },
  };
})();
