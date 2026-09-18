// promo page-shim — 给模拟网页（article.html）用的最小 chrome.* 桩，
// 让真实内容脚本 lib/content-scripts/selection-toolbar.js 原样跑起来。
// 只实现浮条用到的 API 面；explain 端口的内容投递由驱动脚本逐帧控制。
(function () {
  if (window.__promoPageShim) return;
  window.__promoPageShim = true;

  let i18nCache = null;
  function loadI18n() {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', '/repo/_locales/zh_CN/messages.json', false);
      x.send();
      i18nCache = JSON.parse(x.responseText);
    } catch (_) { i18nCache = {}; }
  }

  window.chrome = {
    runtime: {
      id: 'browsa-promo',
      getURL(p) { return '/repo/' + String(p || '').replace(/^\//, ''); },
      sendMessage(msg, cb) {
        const r = { ok: true, data: {} };
        if (typeof cb === 'function') cb(r);
        return Promise.resolve(r);
      },
      onMessage: { addListener() {}, removeListener() {} },
      connect(opts) {
        const name = (opts && opts.name) || '';
        const ls = [];
        const fire = (m) => { for (const f of [...ls]) f(m); };
        const port = {
          name,
          onMessage: {
            addListener(f) { ls.push(f); },
            removeListener(f) { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
          },
          onDisconnect: { addListener() {}, removeListener() {} },
          postMessage(msg) {
            // EXPLAIN_REQUEST：不自动投递内容——注册 push 句柄，
            // 由驱动脚本每帧调 window.__promoExplainPort.push({type:'EXPLAIN_CHUNK',delta})。
            if (msg && msg.type === 'EXPLAIN_REQUEST') {
              window.__promoExplainPort = { push: fire };
            }
          },
          disconnect() {},
        };
        return port;
      },
    },
    i18n: {
      getUILanguage() { return 'zh-CN'; },
      getMessage(key) {
        if (!i18nCache) loadI18n();
        return (i18nCache[key] || {}).message || '';
      },
    },
    storage: {
      // 浮条开关 + 字典语言解析（uiLang:'zh' 让浮条拉中文词典，按钮保持中文）
      local: {
        get(keys, cb) {
          const o = {};
          const k = typeof keys === 'string' ? keys : (Array.isArray(keys) ? keys[0] : '');
          if (k === 'showSelectionToolbar') o.showSelectionToolbar = true;
          if (k === 'uiLang') o.uiLang = 'zh';
          if (typeof cb === 'function') cb(o);
          return Promise.resolve(o);
        },
        set() {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
})();
