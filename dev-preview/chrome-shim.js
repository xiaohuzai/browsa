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
  // Mock saved sessions for the drawer preview: one pinned, one content-only
  // search hit candidate ("时间戳" lives in a message body), buckets across
  // today / yesterday / this-week dates.
  const __now = Date.now();
  const previewSessions = [
    ...(seedConfig.sessions || []),
    { id: 'pin1', name: 'browsa 上线清单', createdAt: __now - 2 * 3600e3, pinned: true, history: [] },
    { id: 'tdy1', name: 'B站视频要点', createdAt: __now - 30 * 60e3, history: [{ role: 'user', content: '总结这个视频' }, { role: 'assistant', content: '…可点击时间戳 [02:14] …' }] },
    { id: 'ysd1', name: '昨天：论文阅读', createdAt: __now - 26 * 3600e3, history: [] },
    { id: 'wk1', name: '竞品调研记录', createdAt: __now - 4 * 86400e3, history: [] },
    { id: 'old1', name: '一个月前的草稿', createdAt: __now - 40 * 86400e3, history: [] },
  ];
  async function handle(msg) {
    switch (msg && msg.type) {
      case 'GET_CONFIG': return { ok: true, data: configData() };
      case 'GET_PAGE_CONTEXT': return { ok: true, data: { mode: msg.mode || 'reader', meta: pageMeta, text: '(预览环境无页面正文)' } };
      case 'STREAM_PEEK': return { ok: true, data: { inFlight: false } };
      // Sessions drawer: contract matches lib/storage.js — query filters name
      // OR content (case-insensitive), pinned sessions sort first, rows are
      // metadata-only. PIN_SESSION flips the mock in place so the drawer UI
      // can be driven end-to-end in the preview.
      case 'GET_SESSIONS': {
        const q = String((msg && msg.q) || '').trim().toLowerCase();
        let list = [...previewSessions];
        if (q) {
          list = list.map(s => {
            const nameMatch = s.name.toLowerCase().includes(q);
            const contentMatch = !nameMatch && (s.history || []).some(
              m => typeof m?.content === 'string' && m.content.toLowerCase().includes(q));
            return nameMatch || contentMatch ? { ...s, contentMatch } : null;
          }).filter(Boolean);
        }
        const pinned = list.filter(s => s.pinned);
        return { ok: true, data: { sessions: [...pinned, ...list.filter(s => !s.pinned)] } };
      }
      case 'PIN_SESSION': {
        const s = previewSessions.find(x => x.id === msg.id);
        if (s) s.pinned = !!msg.pinned;
        return { ok: true, data: {} };
      }
      // Transcript drawer: scripted playback position (7:30 → the [07:42]
      // chapter row is the "live" one) + always-succeeding seek.
      case 'GET_VIDEO_TIME': return { ok: true, time: seedConfig.__videoTime ?? 450, paused: false };
      case 'SEEK_VIDEO': return { ok: true };
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
    // i18n: resolve against the REAL _locales files so the preview shows what a
    // real browser would. Default zh-CN; add ?lang=en to preview the English UI.
    i18n: {
      getUILanguage() { return new URLSearchParams(location.search).get('lang') === 'en' ? 'en-US' : 'zh-CN'; },
      getMessage(key) {
        if (!i18nCache) {
          try {
            const lang = this.getUILanguage().startsWith('zh') ? 'zh_CN' : 'en';
            const x = new XMLHttpRequest();
            x.open('GET', `../_locales/${lang}/messages.json`, false); // sync OK in preview
            x.send();
            i18nCache = JSON.parse(x.responseText);
          } catch (_) { i18nCache = {}; }
        }
        return (i18nCache[key] || {}).message || '';
      },
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
  let i18nCache = null;
})();
