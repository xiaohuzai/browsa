// test/lib-i18n.test.mjs — lib/i18n.js 的 t()/tSub()/applyI18n() 与 uiLang 覆盖层：
// auto 模式走 chrome.i18n（浏览器语言）；显式 en/zh 时 fetch _locales 字典覆盖；
// 无 chrome 环境（jsdom 测试）退化到内联 fallback。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><p data-i18n="hi">src</p><input data-i18n-placeholder="phHolder" placeholder="src" /></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// —— 每个 test 前重置模块（模块级单例：uiLang/overrideDict）——
async function freshModule() {
  const mod = await import('../lib/i18n.js?' + Math.random().toString(36).slice(2));
  return mod;
}

function mockChrome({ i18nMessages = {}, storage = {} } = {}) {
  globalThis.chrome = {
    i18n: { getMessage: (key, subs) => {
      let m = i18nMessages[key];
      if (m == null) return '';
      (subs || []).forEach((v, i) => { m = m.replaceAll(`$${i + 1}`, String(v)); });
      return m;
    } },
    runtime: { getURL: (p) => 'mock://' + p },
    storage: {
      local: {
        get: async (keys) => (Array.isArray(keys) || typeof keys === 'string')
          ? Object.fromEntries([].concat(keys).filter((k) => k in storage).map((k) => [k, storage[k]]))
          : { ...storage },
      },
      onChanged: { addListener: (fn) => { globalThis.__i18nStorageListener = fn; } },
    },
  };
  globalThis.__i18nFetchMap = {};
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => globalThis.__i18nFetchMap[url] ?? (() => { throw new Error('no dict ' + url); })(),
  });
}

test('auto 模式：chrome.i18n 命中，缺失回退内联 fallback', async () => {
  mockChrome({ i18nMessages: { hello: 'Bonjour' } });
  const { t, tSub, initI18n } = await freshModule();
  await initI18n();
  assert.equal(t('hello', 'src'), 'Bonjour');
  assert.equal(t('missing', 'src'), 'src');
  assert.equal(t('missing'), '');
  assert.equal(tSub('sw', 'Switched to $1', 'Ark'), 'Switched to Ark', 'chrome.i18n 缺 key → fallback 手动替换');
});

test('显式 zh：fetch zh_CN 字典覆盖 chrome.i18n', async () => {
  mockChrome({ i18nMessages: { hello: 'browser-locale' }, storage: { uiLang: 'zh' } });
  globalThis.__i18nFetchMap['mock://_locales/zh_CN/messages.json'] = { hello: { message: '字典命中' }, sw: { message: '切到 $1' } };
  const { t, tSub, initI18n, currentUiLang } = await freshModule();
  await initI18n();
  assert.equal(currentUiLang(), 'zh');
  assert.equal(t('hello', 'src'), '字典命中', '显式字典优先于浏览器语言');
  assert.equal(tSub('sw', 'Switched to $1', '方舟'), '切到 方舟');
  assert.equal(t('onlyInBrowser', 'src'), 'src', '字典缺 key 回退 chrome.i18n 也缺 → fallback');
});

test('显式 en：chrome.i18n 是中文浏览器语言时仍取英文字典', async () => {
  mockChrome({ i18nMessages: { hello: '中文浏览器' }, storage: { uiLang: 'en' } });
  globalThis.__i18nFetchMap['mock://_locales/en/messages.json'] = { hello: { message: 'Hello' } };
  const { t, initI18n, currentUiLang } = await freshModule();
  await initI18n();
  assert.equal(currentUiLang(), 'en');
  assert.equal(t('hello', 'src'), 'Hello');
});

test('显式 ja/pt：短码映射到 _locales 目录（ja、pt→pt_BR），未知码回退 auto', async () => {
  mockChrome({ i18nMessages: { hello: 'browser-locale' }, storage: { uiLang: 'ja' } });
  globalThis.__i18nFetchMap['mock://_locales/ja/messages.json'] = { hello: { message: '辞書ヒット' } };
  const m1 = await freshModule();
  await m1.initI18n();
  assert.equal(m1.currentUiLang(), 'ja');
  assert.equal(m1.t('hello', 'src'), '辞書ヒット', 'ja 短码取 ja 目录');

  const m2 = await freshModule();
  m2.watchUiLang(() => {}); // 注册 storage 监听（监听闭包绑定 m2 的模块状态）
  globalThis.__i18nFetchMap['mock://_locales/pt_BR/messages.json'] = { hello: { message: 'dicionário pt' } };
  await globalThis.__i18nStorageListener({ uiLang: { newValue: 'pt' } }, 'local');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(m2.currentUiLang(), 'pt');
  assert.equal(m2.t('hello', 'src'), 'dicionário pt', 'pt 短码取 pt_BR 目录');

  // 未知短码：回退 auto（不 fetch、不覆盖）
  await globalThis.__i18nStorageListener({ uiLang: { newValue: 'xx' } }, 'local');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(m2.currentUiLang(), 'auto');
  assert.equal(m2.t('hello', 'src'), 'browser-locale');
});

test('字典 fetch 失败：不炸、退回浏览器语言', async () => {
  mockChrome({ i18nMessages: { hello: 'browser-locale' }, storage: { uiLang: 'zh' } });
  globalThis.__i18nFetchMap = {}; // no dict → fetch json throws
  const { t, initI18n, currentUiLang } = await freshModule();
  await initI18n();
  assert.equal(currentUiLang(), 'zh');
  assert.equal(t('hello', 'src'), 'browser-locale');
});

test('watchUiLang：storage 变更换字典并回调', async () => {
  mockChrome({ i18nMessages: { hello: 'browser-locale' } });
  globalThis.__i18nFetchMap['mock://_locales/zh_CN/messages.json'] = { hello: { message: '字典命中' } };
  const { t, initI18n, watchUiLang, currentUiLang } = await freshModule();
  await initI18n();
  let fired = 0;
  watchUiLang(() => { fired++; });
  assert.ok(globalThis.__i18nStorageListener, 'listener registered');
  await globalThis.__i18nStorageListener({ uiLang: { newValue: 'zh' } }, 'local');
  await new Promise((r) => setTimeout(r, 5)); // watchUiLang 内部 setUiLangInternal().then(onChange) 异步
  assert.equal(currentUiLang(), 'zh');
  assert.equal(t('hello', 'src'), '字典命中');
  assert.equal(fired, 1);
  // 非 uiLang 变更不触发
  await globalThis.__i18nStorageListener({ other: { newValue: 1 } }, 'local');
  assert.equal(fired, 1);
});

test('applyI18n：data-i18n / data-i18n-placeholder 填充，无命中保留源文案', async () => {
  mockChrome({ i18nMessages: { hi: 'Hey', phHolder: 'Type here' } });
  const { applyI18n, initI18n } = await freshModule();
  await initI18n();
  applyI18n();
  assert.equal(document.querySelector('[data-i18n]').textContent, 'Hey');
  assert.equal(document.querySelector('[data-i18n-placeholder]').placeholder, 'Type here');
  // 缺 key：保留源文案
  document.querySelector('[data-i18n]').dataset.i18n = 'nope';
  applyI18n();
  assert.equal(document.querySelector('[data-i18n]').textContent, 'Hey', '源文案不被清掉');
});

test('无 chrome 环境：全程退化到 fallback，applyI18n no-op', async () => {
  delete globalThis.chrome;
  const { t, tSub, initI18n, applyI18n, currentUiLang } = await freshModule();
  await initI18n();
  assert.equal(currentUiLang(), 'auto');
  assert.equal(t('k', 'fb'), 'fb');
  assert.equal(tSub('k', 'a $1 b', 42), 'a 42 b');
  document.querySelector('[data-i18n]').textContent = 'untouched';
  applyI18n();
  assert.equal(document.querySelector('[data-i18n]').textContent, 'untouched');
});

test('UI locale uses all seven explicit languages and resolves auto from the browser', async () => {
  for (const [lang, locale] of Object.entries({ en: 'en', zh: 'zh-CN', ja: 'ja', ko: 'ko', es: 'es', pt: 'pt-BR', ru: 'ru' })) {
    mockChrome({ storage: { uiLang: lang } });
    const mod = await freshModule();
    await mod.initI18n();
    assert.equal(mod.uiLocale(), locale);
  }
  mockChrome();
  chrome.i18n.getUILanguage = () => 'pt-BR';
  const mod = await freshModule();
  await mod.initI18n();
  assert.equal(mod.uiLocale(), 'pt-BR');
  chrome.i18n.getUILanguage = () => 'fr-FR';
  assert.equal(mod.uiLocale(), 'en', 'unsupported browser UI languages use the extension default dictionary');
  chrome.i18n.getUILanguage = () => 'invalid_locale';
  assert.doesNotThrow(() => new Intl.RelativeTimeFormat(mod.uiLocale()));
});
