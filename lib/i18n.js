// lib/i18n.js — UI 语言层：默认跟随浏览器界面语言（chrome.i18n，default_locale
// 'en' 兜底），用户可在设置里显式选 English / 中文（uiLang 存 chrome.storage.local，
// 'auto' | 'en' | 'zh'）。字典单一来源是 _locales/<lang>/messages.json：显式语言
// 时 fetch 加载，不在 JS 里养第二份副本。jsdom 测试无 chrome 时全程退化到
// t(key, fallback) 的 fallback——调用点一律带当前源文案作 fallback，保证无字典
// 环境下 UI 仍完整可断言。

const UI_LANG_KEY = 'uiLang';
let uiLang = 'auto';
let overrideDict = null; // key → { message }，仅显式选择语言时加载

async function setUiLangInternal(lang) {
  uiLang = (lang === 'en' || lang === 'zh') ? lang : 'auto';
  overrideDict = null;
  if (uiLang === 'auto') return;
  try {
    const url = chrome.runtime.getURL(`_locales/${uiLang === 'zh' ? 'zh_CN' : 'en'}/messages.json`);
    const res = await fetch(url);
    overrideDict = await res.json();
  } catch {
    overrideDict = null; // 字典加载失败：退回浏览器语言，不阻塞 UI
  }
}

// 页面初始化时调用一次：读回 uiLang 偏好并预载字典。任何失败都保持 auto。
export async function initI18n() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) return;
    const saved = await chrome.storage.local.get(UI_LANG_KEY);
    await setUiLangInternal(saved?.[UI_LANG_KEY] || 'auto');
  } catch {
    /* 保持 auto */
  }
}

// 订阅设置页里的语言切换：字典换好后回调（页面负责重跑 applyI18n + 重渲染
// 动态文案；toast 等一次性文案自然用新语言）。
export function watchUiLang(onChange) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.uiLang) return;
    setUiLangInternal(changes.uiLang.newValue).then(onChange);
  });
}

export function currentUiLang() {
  return uiLang;
}

// 解析顺序：显式字典 → chrome.i18n（浏览器语言）→ fallback。fallback 缺省
// 返回 ''——applyI18n 靠空值判断「不要覆盖标记里的源文案」。
export function t(key, fallback) {
  if (overrideDict && overrideDict[key]?.message) return overrideDict[key].message;
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    const v = chrome.i18n.getMessage(key);
    if (v) return v;
  }
  return fallback ?? '';
}

// 动态文案带占位：tSub('switchedTo', 'Switched to $1', name)。$1/$2/… 依次替换。
// 显式字典手动替换；auto 模式把 subs 交给 chrome.i18n.getMessage（同一约定）。
export function tSub(key, fallback, ...subs) {
  const strSubs = subs.map((v) => String(v));
  if (overrideDict && overrideDict[key]?.message) {
    let s = overrideDict[key].message;
    strSubs.forEach((v, i) => { s = s.replaceAll(`$${i + 1}`, v); });
    return s;
  }
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    const v = chrome.i18n.getMessage(key, strSubs);
    if (v) return v;
  }
  let s = fallback || '';
  strSubs.forEach((v, i) => { s = s.replaceAll(`$${i + 1}`, v); });
  return s;
}

// data-i18n* 属性静态文案填充（sidepanel/options 共用；root 也可以传单个卡片
// 元素）。data-i18n-html 用于富文本气泡——字典内容是仓库内受控 HTML。
export function applyI18n(root = (typeof document !== 'undefined' ? document : undefined)) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const v = t(el.dataset.i18n);
    if (v) el.textContent = v;
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const v = t(el.dataset.i18nTitle);
    if (v) el.title = v;
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    const v = t(el.dataset.i18nAria);
    if (v) el.setAttribute('aria-label', v);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const v = t(el.dataset.i18nPlaceholder);
    if (v) el.placeholder = v;
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const v = t(el.dataset.i18nHtml);
    if (v) el.innerHTML = v;
  }
}
