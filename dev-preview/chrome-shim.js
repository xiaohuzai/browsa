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

  // 划词内联解释预览：模拟 background 的 browsa-explain per-request 端口
  // （EXPLAIN_REQUEST → CHUNK* → DONE，~150ms/chunk——快到不拖最终态截图，
  // 又够抓一张流式中间态）。词/短语与整句两种分支都给出，演示 prompt 的
  // 词典式/概括式两种形态。返回形状对照 lib/handlers/selection-explain.js。
  const EXPLAIN_FAKE_WORD = [
    '**serendipity** /ˌserənˈdɪpəti/ n. 偶然发现美好事物的运气',
    '',
    '- 指「不期而遇的幸运发现」：机遇本身，加上发现者认出价值的眼光，缺一不可',
    '- 源自 1754 年 Horace Walpole 从波斯童话 *The Three Princes of Serendip* 杜撰而来',
    '- 常见搭配：a serendipitous encounter（不期而遇）、by pure serendipity（纯属机缘巧合）',
  ].join('\n');
  const EXPLAIN_FAKE_SENTENCE =
    '这句话的核心是「**先理解，再评判**」：反对一个立场的前提，是能把它复述到对方满意。\n\n- 学术阅读里这叫 steel-man：先写下对方论点的最强版本，再写自己的反驳\n- 和 straw-man（树靶子）相对——后者把对方观点弱化后再攻击';
  const EXPLAIN_FAKE_TRANSLATE =
    '**文档；记载；证明**\n\n- 作动词时：to document = 记载、用文件证明\n- 同源：documentary（adj. 纪实的；n. 纪录片）';
  function explainPort() {
    const listeners = [];
    return {
      name: 'browsa-explain',
      onMessage: { addListener(f) { listeners.push(f); } },
      onDisconnect: { addListener() {} },
      postMessage(msg) {
        if (!msg || msg.type !== 'EXPLAIN_REQUEST') return;
        const words = String(msg.text || '').trim().split(/\s+/).filter(Boolean).length;
        const answer = msg.mode === 'translate' ? EXPLAIN_FAKE_TRANSLATE
          : words <= 3 ? EXPLAIN_FAKE_WORD : EXPLAIN_FAKE_SENTENCE;
        const lines = answer.split('\n');
        let i = 0;
        const timer = setInterval(() => {
          if (i < lines.length) {
            const delta = lines[i++] + (i < lines.length ? '\n' : '');
            for (const f of [...listeners]) f({ type: 'EXPLAIN_CHUNK', delta });
          } else {
            clearInterval(timer);
            for (const f of [...listeners]) f({ type: 'EXPLAIN_DONE' });
          }
        }, 150);
      },
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
      // chapter row is the "live" one) + always-succeeding seek. Responses
      // mirror the REAL background envelope ({ ok, data } — data is the
      // handler's return value); unwrapped shapes here are how v0.32.1's
      // playback-follow worked in preview but pinned to line 1 on-device.
      case 'GET_VIDEO_TIME': return { ok: true, data: { ok: true, time: seedConfig.__videoTime ?? 450, paused: false } };
      case 'SEEK_VIDEO': return { ok: true, data: { ok: true } };
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
      connect(opts) {
        const name = (opts && opts.name) || 'default';
        return name === 'browsa-explain' ? explainPort() : fakePort(name);
      },
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
