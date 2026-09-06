// lib/content-scripts/selection-toolbar.js
//
// Injects a floating mini-toolbar on any https page. When the user
// selects text, the toolbar appears above the selection with 4 actions
// (Ask / Explain / Translate / Summarize), localized via chrome.i18n
// (browser language) with the settings-page uiLang override applied on top.
//
// 「解释」和「翻译」stream their answers into an inline popover anchored next
// to the selection (second closed shadow host below) over a one-shot
// browsa-explain port — no side panel round-trip. The other two actions
// (Ask / Summarize) send SELECTION_ACTION and still deliver through the side
// panel: Ask starts a conversation and needs typing, Summarize precedes one.
//
// Uses Shadow DOM so the toolbar's styles are fully isolated from the
// host page. Communicates with the background via chrome.runtime.sendMessage;
// the background relays to the side panel through the existing nav port.

(function () {
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  // chrome.i18n resolves against the browser UI language (this script runs in
  // the ISOLATED world, where chrome.* exists). Falls back to English strings.
  const M = (key, fallback) => {
    try { return chrome.i18n.getMessage(key) || fallback; } catch (_) { return fallback; }
  };
  if (window.__browsaSelectionToolbarInstalled) return;
  window.__browsaSelectionToolbarInstalled = true;

  const MIN_CHARS = 3;         // ignore tiny selections
  const MAX_PREVIEW = 2000;    // cap text sent to avoid huge messages
  const DEBOUNCE_MS = 220;

  // Respect the "show floating toolbar" toggle from Settings.
  // Default: enabled. Cached in memory; updated live via storage.onChanged
  // so toggling in Settings takes effect without reloading the page.
  let toolbarEnabled = true;
  chrome.storage.local.get('showSelectionToolbar', ({ showSelectionToolbar }) => {
    toolbarEnabled = showSelectionToolbar !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'showSelectionToolbar' in changes) {
      toolbarEnabled = changes.showSelectionToolbar.newValue !== false;
      if (!toolbarEnabled) hide();
    }
  });

  // ── Shadow DOM setup ──────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'browsa-sel-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        position: fixed;
        display: none;
        align-items: center;
        gap: 1px;
        padding: 3px 4px;
        background: #14171f;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3);
        pointer-events: all;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        opacity: 0;
        transform: translateY(-4px) scale(0.97);
        transition: opacity 0.12s ease, transform 0.12s ease;
      }
      .bar.on { display: flex; }
      .bar.vis { opacity: 1; transform: translateY(0) scale(1); }
      .bar::after {
        content: '';
        position: absolute;
        top: 100%;
        left: var(--arrow-x, 50%);
        transform: translateX(-50%);
        border: 5px solid transparent;
        border-top-color: #14171f;
        pointer-events: none;
      }
      .bar.below::after {
        top: auto;
        bottom: 100%;
        border-top-color: transparent;
        border-bottom-color: #14171f;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 10px;
        border: none;
        background: transparent;
        color: #c9d1d9;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 6px;
        white-space: nowrap;
        transition: background 0.1s, color 0.1s;
        letter-spacing: 0.1px;
      }
      .btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .btn svg { flex-shrink: 0; }
      .btn-ico { padding: 5px 8px; font-weight: 600; letter-spacing: 0; }
      .logo { width: 14px; height: 14px; margin: 0 2px 0 4px; opacity: 0.85; flex-shrink: 0; pointer-events: none; }
      .sep { width: 1px; height: 16px; background: rgba(255,255,255,0.1); margin: 0 1px; flex-shrink: 0; }
      .btn-close {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; padding: 0; margin-left: 2px;
        border: none; background: transparent;
        color: rgba(255,255,255,0.35); font-size: 14px; line-height: 1;
        cursor: pointer; border-radius: 4px; flex-shrink: 0;
        transition: background 0.1s, color 0.1s;
      }
      .btn-close:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7); }
      .confirm {
        position: fixed;
        display: none;
        flex-direction: column;
        gap: 9px;
        padding: 11px 13px;
        background: #14171f;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3);
        pointer-events: all;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        opacity: 0;
        transform: translateY(-4px) scale(0.97);
        transition: opacity 0.12s ease, transform 0.12s ease;
        white-space: nowrap;
        z-index: 2;
      }
      .confirm.on { display: flex; }
      .confirm.vis { opacity: 1; transform: translateY(0) scale(1); }
      .confirm-msg { color: #c9d1d9; font-size: 12px; font-weight: 500; line-height: 1.35; }
      .confirm-msg .sub { display: block; color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 400; margin-top: 3px; }
      .confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }
      .cbtn {
        padding: 5px 13px; border: none; border-radius: 6px;
        font-size: 12px; font-weight: 500; cursor: pointer;
        font-family: inherit; transition: background 0.1s, color 0.1s;
      }
      .cbtn.cancel { background: transparent; color: #c9d1d9; }
      .cbtn.cancel:hover { background: rgba(255,255,255,0.08); color: #fff; }
      .cbtn.ok { background: #e0542c; color: #fff; }
      .cbtn.ok:hover { background: #ef5f35; }
      @media (prefers-color-scheme: light) {
        .bar { background: #fff; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.14); }
        .bar::after { border-top-color: #fff; }
        .bar.below::after { border-bottom-color: #fff; border-top-color: transparent; }
        .btn { color: #24292f; }
        .btn:hover { background: rgba(0,0,0,0.06); color: #000; }
        .btn-close { color: rgba(0,0,0,0.3); }
        .btn-close:hover { background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.6); }
        .sep { background: rgba(0,0,0,0.1); }
        .confirm { background: #fff; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.14); }
        .confirm-msg { color: #24292f; }
        .confirm-msg .sub { color: rgba(0,0,0,0.5); }
        .cbtn.cancel { color: #24292f; }
        .cbtn.cancel:hover { background: rgba(0,0,0,0.06); color: #000; }
        .cbtn.ok { background: #c2410c; }
        .cbtn.ok:hover { background: #a93a0b; }
      }
    </style>
    <div class="bar" id="bar" role="toolbar" aria-label="${M('toolbarAria', 'browsa quick actions')}" data-i18n-aria="toolbarAria">
      <img class="logo" src="${chrome.runtime.getURL('icons/icon16.png')}" alt="browsa" />
      <div class="sep"></div>
      <button class="btn btn-ask" data-action="chat" title="${M('toolbarAsk', 'Ask')}" data-i18n-title="toolbarAsk"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg><span data-i18n="toolbarAsk">${M('toolbarAsk', 'Ask')}</span></button>
      <div class="sep"></div>
      <button class="btn" data-action="explain" title="${M('toolbarExplain', 'Explain')}" data-i18n-title="toolbarExplain"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/></svg><span data-i18n="toolbarExplain">${M('toolbarExplain', 'Explain')}</span></button>
      <button class="btn btn-ico" data-action="translate" aria-label="${M('toolbarTranslate', 'Translate')}" title="${M('toolbarTranslate', 'Translate')}" data-i18n-aria="toolbarTranslate" data-i18n-title="toolbarTranslate"><svg width="15" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg></button>
      <button class="btn" data-action="summarize" title="${M('toolbarSummarize', 'Summarize')}" data-i18n-title="toolbarSummarize"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h12"/></svg><span data-i18n="toolbarSummarize">${M('toolbarSummarize', 'Summarize')}</span></button>
      <div class="sep"></div>
      <button class="btn-close" id="close-btn" aria-label="${M('toolbarHide', 'Hide on this page')}" title="${M('toolbarHide', 'Hide on this page')}" data-i18n-aria="toolbarHide" data-i18n-title="toolbarHide"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="confirm" id="confirm" role="dialog" aria-label="${M('toolbarHideConfirm', 'Confirm')}" data-i18n-aria="toolbarHideConfirm">
      <div class="confirm-msg"><span class="main" data-i18n="toolbarHideConfirm">${M('toolbarHideConfirm', 'Hide toolbar on this page?')}</span><span class="sub" data-i18n="toolbarHideHint">${M('toolbarHideHint', "It won't show again until you reload.")}</span></div>
      <div class="confirm-actions">
        <button class="cbtn cancel" id="confirm-cancel">${M('toolbarCancel', 'Cancel')}</button>
        <button class="cbtn ok" id="confirm-ok">${M('toolbarConfirmHide', 'Hide')}</button>
      </div>
    </div>
  `;

  const bar = shadow.querySelector('#bar');
  const confirmBox = shadow.querySelector('#confirm');
  document.documentElement.appendChild(host);

  // ── Inline explain popover (second closed shadow host) ───────────────────
  // 「解释」的答案就地流式展示在选区旁，不再绕道 side panel。独立 host 独立
  // 定位（bar 与浮层分别 place），同一个 closed-shadow 隔离样式；语言与配色
  // 沿用 bar 的设计（深色卡 + prefers-color-scheme 亮色变体）。
  const popHost = document.createElement('div');
  popHost.id = 'browsa-sel-pop-host';
  popHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;';
  const popShadow = popHost.attachShadow({ mode: 'closed' });
  popShadow.innerHTML = `
    <style>
      :host { all: initial; }
      .pop {
        position: fixed;
        display: none;
        flex-direction: column;
        width: min(420px, calc(100vw - 24px));
        background: #14171f;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3);
        pointer-events: all;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        opacity: 0;
        transform: translateY(-4px) scale(0.98);
        transition: opacity 0.12s ease, transform 0.12s ease;
        overflow: hidden;
      }
      .pop.on { display: flex; }
      .pop.vis { opacity: 1; transform: translateY(0) scale(1); }
      .pop-body {
        padding: 12px 14px 10px;
        max-height: 260px;
        overflow-y: auto;
        font-size: 13px;
        line-height: 1.6;
        color: #c9d1d9;
        user-select: text;
        cursor: text;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.18) transparent;
      }
      .pop-body .pl { min-height: 4px; }
      .pop-body .pl.li { padding-left: 14px; position: relative; }
      .pop-body .pl.li::before {
        content: '';
        position: absolute; left: 3px; top: 0.72em;
        width: 4px; height: 4px; border-radius: 50%;
        background: rgba(255,255,255,0.45);
      }
      .pop-body b { color: #f0f3f7; font-weight: 600; }
      .pop-body code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; padding: 0 4px; border-radius: 4px;
        background: rgba(255,255,255,0.08);
      }
      .pop-wait { display: inline-flex; align-items: center; gap: 8px; color: rgba(255,255,255,0.45); font-size: 12.5px; }
      .pop-wait .dots { display: inline-flex; gap: 3px; }
      .pop-wait .dots i {
        width: 4px; height: 4px; border-radius: 50%;
        background: rgba(255,255,255,0.5);
        animation: bpulse 1.2s ease-in-out infinite;
      }
      .pop-wait .dots i:nth-child(2) { animation-delay: 0.2s; }
      .pop-wait .dots i:nth-child(3) { animation-delay: 0.4s; }
      @keyframes bpulse { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
      .pop-err { color: #f28b6b; font-size: 12.5px; line-height: 1.5; }
      .pop-foot {
        display: flex; align-items: center; gap: 2px;
        padding: 5px 8px;
        border-top: 1px solid rgba(255,255,255,0.07);
      }
      .fbtn {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 4px 8px;
        border: none; background: transparent;
        color: rgba(255,255,255,0.5);
        font-size: 11.5px; font-weight: 500;
        cursor: pointer; border-radius: 6px;
        font-family: inherit;
        transition: background 0.1s, color 0.1s;
        white-space: nowrap;
      }
      .fbtn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }
      .fbtn.ok { color: #7dc383; }
      .fbtn.gap { flex: 1; pointer-events: none; }
      @media (prefers-color-scheme: light) {
        .pop { background: #fff; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.14); }
        .pop-body { color: #24292f; }
        .pop-body b { color: #000; }
        .pop-body code { background: rgba(0,0,0,0.06); }
        .pop-body .pl.li::before { background: rgba(0,0,0,0.35); }
        .pop-wait { color: rgba(0,0,0,0.45); }
        .pop-wait .dots i { background: rgba(0,0,0,0.4); }
        .pop-err { color: #c2410c; }
        .pop-foot { border-top-color: rgba(0,0,0,0.07); }
        .fbtn { color: rgba(0,0,0,0.45); }
        .fbtn:hover { background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.85); }
        .fbtn.ok { color: #1a7f37; }
      }
    </style>
    <div class="pop" id="pop" role="dialog" aria-label="${M('inlineExplainAria', 'Explanation')}" data-i18n-aria="inlineExplainAria">
      <div class="pop-body" id="pop-body"></div>
      <div class="pop-foot" id="pop-foot">
        <button class="fbtn" id="pop-copy" data-i18n="inlineExplainCopy">${M('inlineExplainCopy', 'Copy')}</button>
        <button class="fbtn" id="pop-retry" data-i18n="inlineExplainRetry">${M('inlineExplainRetry', 'Retry')}</button>
        <span class="fbtn gap"></span>
        <button class="fbtn" id="pop-side" data-i18n="inlineExplainSide">${M('inlineExplainSide', 'Open in panel')}</button>
        <button class="fbtn" id="pop-close" aria-label="${M('inlineExplainClose', 'Close')}" data-i18n-aria="inlineExplainClose">✕</button>
      </div>
    </div>
  `;
  const pop = popShadow.querySelector('#pop');
  const popBody = popShadow.querySelector('#pop-body');
  document.documentElement.appendChild(popHost);

  // UI 语言覆盖：设置里显式选了 English/中文时，用 _locales 字典覆盖浏览器语言。
  // 初始渲染先用 chrome.i18n（同步、无闪占），字典到位后原位刷新——只改
  // textContent/title/aria，不重建 DOM，事件监听与元素引用全部保持有效。
  (async () => {
    try {
      const { uiLang } = await new Promise((res) => chrome.storage.local.get('uiLang', (v) => res(v || {})));
      if (uiLang !== 'en' && uiLang !== 'zh') return;
      activeUiLang = uiLang;
      const url = chrome.runtime.getURL(`_locales/${uiLang === 'zh' ? 'zh_CN' : 'en'}/messages.json`);
      const dict = await (await fetch(url)).json();
      const m = (key) => dict?.[key]?.message || '';
      for (const root of [shadow, popShadow]) {
        for (const el of root.querySelectorAll('[data-i18n]')) { const v = m(el.dataset.i18n); if (v) el.textContent = v; }
        for (const el of root.querySelectorAll('[data-i18n-title]')) { const v = m(el.dataset.i18nTitle); if (v) el.title = v; }
        for (const el of root.querySelectorAll('[data-i18n-aria]')) { const v = m(el.dataset.i18nAria); if (v) el.setAttribute('aria-label', v); }
      }
    } catch (_) { /* 字典加载失败保持浏览器语言 */ }
  })();

  // ── State ─────────────────────────────────────────────────────────────────
  let pendingShow = null;
  let currentText = '';
  // Set when the user confirms the ✕ dialog - suppresses the toolbar on this
  // page until reload (a fresh content script instance resets it). The
  // right-click context menu and 📎 attach are unaffected, so the user is
  // never stuck.
  let suppressedForPage = false;
  // Selection Range captured when the bar is placed — the explain popover
  // re-anchors to it on scroll (Range.getBoundingClientRect stays
  // viewport-accurate as the page moves).
  let lastRange = null;
  // Resolved UI language ('en'|'zh') when explicitly set in Settings; the
  // explain request threads it so the answer's language follows the UI.
  let activeUiLang = null;

  function resolveLang() {
    if (activeUiLang === 'en' || activeUiLang === 'zh') return activeUiLang;
    try {
      return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    } catch (_) { return 'zh'; }
  }

  // ── Positioning ───────────────────────────────────────────────────────────
  function place(selRect) {
    // Measure bar after making it visible (display:flex) but not yet opaque
    bar.classList.add('on');
    bar.classList.remove('vis', 'below');

    const barW = bar.offsetWidth || 320;
    const barH = bar.offsetHeight || 36;
    const margin = 10;
    const arrowH = 7;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Center over selection horizontally
    let left = selRect.left + selRect.width / 2 - barW / 2;
    left = Math.max(margin, Math.min(left, vw - barW - margin));

    // Arrow should point to center of selection (clamped to bar bounds)
    const arrowX = Math.max(16, Math.min(selRect.left + selRect.width / 2 - left, barW - 16));
    bar.style.setProperty('--arrow-x', arrowX + 'px');

    // Prefer above, fall back to below
    let top = selRect.top - barH - arrowH - margin;
    if (top < margin) {
      top = selRect.bottom + arrowH + margin;
      bar.classList.add('below');
    }

    bar.style.top = top + 'px';
    bar.style.left = left + 'px';

    // Trigger animation next frame
    requestAnimationFrame(() => bar.classList.add('vis'));
  }

  function hide() {
    clearTimeout(pendingShow);
    pendingShow = null;
    bar.classList.remove('vis');
    setTimeout(() => { if (!bar.classList.contains('vis')) bar.classList.remove('on'); }, 130);
    currentText = '';
  }

  // Confirmation dialog shown when the user clicks ✕. The bar is hidden
  // while the dialog is up (position + currentText preserved so Cancel can
  // restore it); only "Hide" actually suppresses the toolbar on this page.
  let confirmOpen = false;
  function showConfirm(anchorRect) {
    clearTimeout(pendingShow);
    pendingShow = null;
    bar.classList.remove('vis', 'on');   // hide bar without clearing currentText
    confirmBox.classList.add('on');
    confirmBox.classList.remove('vis');
    const cw = confirmBox.offsetWidth || 240;
    const ch = confirmBox.offsetHeight || 78;
    const margin = 10;
    let left = anchorRect.left + anchorRect.width / 2 - cw / 2;
    let top = anchorRect.top + anchorRect.height / 2 - ch / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - cw - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - ch - margin));
    confirmBox.style.left = left + 'px';
    confirmBox.style.top = top + 'px';
    requestAnimationFrame(() => confirmBox.classList.add('vis'));
    confirmOpen = true;
  }
  function hideConfirm() {
    confirmBox.classList.remove('vis');
    setTimeout(() => { if (!confirmBox.classList.contains('vis')) confirmBox.classList.remove('on'); }, 130);
    confirmOpen = false;
  }
  // Cancel: close the dialog and put the bar back exactly where it was.
  function cancelConfirm() {
    hideConfirm();
    bar.classList.add('on', 'vis');
  }

  // ── Inline explain session ────────────────────────────────────────────────
  // 「解释」的就地流式回答。每次点击开一条一次性 browsa-explain 端口（per-turn
  // 模式，见 background.js 的 onConnect），CHUNK 增量追加渲染；用户关浮层 =
  // port.disconnect，background 侧据此 abort 上游请求。解释文本只经
  // createTextNode/textContent 上屏——模型输出永不走 innerHTML。
  let explain = null; // { port, text, range, full, done }

  // 极简安全渲染：**加粗** 与 `code` 两种行内记号 + - 分点 + 换行。prompt 已
  // 约束模型别用表格/标题，超出的记号按字面显示（不解析 = 不伪造结构）。
  function renderExplainBody(raw) {
    popBody.textContent = '';
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    for (const line of String(raw).split('\n')) {
      const div = document.createElement('div');
      div.className = 'pl';
      const li = /^\s*(?:[-•]|\d+[.)])\s+/.test(line);
      if (li) {
        div.classList.add('li');
      }
      const rest = li ? line.replace(/^\s*(?:[-•]|\d+[.)])\s+/, '') : line;
      let last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(rest))) {
        if (m.index > last) div.appendChild(document.createTextNode(rest.slice(last, m.index)));
        const tok = m[0];
        if (tok.charCodeAt(0) === 0x2A) { // '**'
          const b = document.createElement('b');
          b.textContent = tok.slice(2, -2);
          div.appendChild(b);
        } else {
          const c = document.createElement('code');
          c.textContent = tok.slice(1, -1);
          div.appendChild(c);
        }
        last = m.index + tok.length;
      }
      if (last < rest.length) div.appendChild(document.createTextNode(rest.slice(last)));
      popBody.appendChild(div);
    }
    popBody.scrollTop = popBody.scrollHeight;
  }

  function showExplainError(message, mode) {
    popBody.textContent = '';
    const div = document.createElement('div');
    div.className = 'pop-err';
    div.textContent = `${M(mode === 'translate' ? 'inlineTranslateError' : 'inlineExplainError', mode === 'translate' ? 'Translation failed' : 'Explanation failed')}: ${message}`;
    popBody.appendChild(div);
  }

  // 锚定到选区（bar 的对侧）：bar 常驻选区上方，浮层就放选区下方——不遮住
  // 被选中的原文；bar 翻到下方时浮层换到上方。两侧都没地方就贴边收进视口。
  function placePopover() {
    if (!explain) return;
    const wasOn = pop.classList.contains('on');
    if (!wasOn) pop.classList.add('on');
    pop.classList.remove('vis');
    let rect = null;
    try { rect = explain.range?.getBoundingClientRect?.() || null; } catch (_) {}
    if (!rect || (!rect.width && !rect.height)) { closeExplain(); return; }
    const pw = pop.offsetWidth || 420;
    const ph = pop.offsetHeight || 140;
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(margin, Math.min(rect.left, vw - pw - margin));
    const roomBelow = vh - rect.bottom - margin;
    const roomAbove = rect.top - margin;
    const need = Math.min(ph + 8, 180);
    const barBelow = bar.classList.contains('below');
    let top;
    if (!barBelow && roomBelow >= need) top = rect.bottom + 8;
    else if (roomAbove >= need) top = rect.top - ph - 8;
    else if (roomBelow >= 80) top = Math.max(margin, Math.min(rect.bottom + 8, vh - ph - margin));
    else top = margin;
    top = Math.max(margin, Math.min(top, vh - ph - margin));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    if (!wasOn) {
      requestAnimationFrame(() => { if (pop.classList.contains('on')) pop.classList.add('vis'); });
    } else {
      pop.classList.add('vis');
    }
  }

  function closeExplain() {
    const s = explain;
    explain = null;
    // 先置空再 disconnect：onDisconnect 里靠 explain 判别「异常断开」，
    // 主动关闭不能触发那条错误提示。
    if (s && s.port) { try { s.port.disconnect(); } catch (_) {} }
    pop.classList.remove('vis');
    setTimeout(() => { if (!pop.classList.contains('vis')) pop.classList.remove('on'); }, 130);
  }

  function openInlineExplain(text, mode = 'explain') {
    closeExplain();
    explain = { port: null, text, mode, range: lastRange, full: '', done: false };
    pop.setAttribute('aria-label', M(mode === 'translate' ? 'toolbarTranslate' : 'inlineExplainAria', mode === 'translate' ? 'Translate' : 'Explanation'));
    popBody.innerHTML = `<span class="pop-wait"><span class="dots"><i></i><i></i><i></i></span>${M(mode === 'translate' ? 'inlineTranslateWaiting' : 'inlineExplainWaiting', mode === 'translate' ? 'Translating…' : 'Explaining…')}</span>`;
    placePopover();

    let port = null;
    try { port = chrome.runtime.connect({ name: 'browsa-explain' }); } catch (_) {}
    if (!port) {
      showExplainError(M(mode === 'translate' ? 'inlineTranslateError' : 'inlineExplainError', mode === 'translate' ? 'Translation failed' : 'Explanation failed'), mode);
      return;
    }
    explain.port = port;
    port.onMessage.addListener((msg) => {
      if (!explain || explain.port !== port || !msg) return;
      if (msg.type === 'EXPLAIN_CHUNK') {
        explain.full += String(msg.delta || '');
        renderExplainBody(explain.full);
      } else if (msg.type === 'EXPLAIN_DONE') {
        explain.done = true;
        if (!explain.full.trim()) showExplainError('(empty reply)', mode);
        // 回合已结束，主动放手；bg 侧对已完成的 abort 是无害 no-op。
        try { port.disconnect(); } catch (_) {}
      } else if (msg.type === 'EXPLAIN_ERROR') {
        showExplainError(String(msg.message || 'unknown error'), mode);
      }
    });
    port.onDisconnect.addListener(() => {
      // 非 用户主动关闭 的断开（SW 重启等）且没拿到完整回复 → 提示。
      if (explain && explain.port === port && !explain.done) {
        showExplainError(M(mode === 'translate' ? 'inlineTranslateError' : 'inlineExplainError', mode === 'translate' ? 'Translation failed' : 'Explanation failed'), mode);
      }
    });
    try {
      port.postMessage({ type: 'EXPLAIN_REQUEST', text, lang: resolveLang(), mode });
    } catch (_) {}
  }

  popShadow.querySelector('#pop-copy').addEventListener('click', async () => {
    if (!explain) return;
    const btn = popShadow.querySelector('#pop-copy');
    const value = explain.full.trim() || explain.text;
    const markCopied = () => {
      btn.classList.add('ok');
      btn.textContent = M('inlineExplainCopied', 'Copied');
      setTimeout(() => {
        btn.classList.remove('ok');
        btn.textContent = M('inlineExplainCopy', 'Copy');
      }, 1200);
    };
    try {
      await navigator.clipboard.writeText(value);
      markCopied();
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        markCopied();
      } catch (_2) { /* 剪贴板不可用就安静放弃 */ }
    }
  });
  popShadow.querySelector('#pop-retry').addEventListener('click', () => {
    if (!explain) return;
    const { text, mode } = explain;
    openInlineExplain(text, mode);
  });
  popShadow.querySelector('#pop-side').addEventListener('click', () => {
    const text = explain ? explain.text : '';
    closeExplain();
    hide();
    if (!text) return;
    try {
      chrome.runtime.sendMessage({ type: 'SELECTION_ACTION', action: 'chat', text });
    } catch (_) {}
  });
  popShadow.querySelector('#pop-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeExplain();
  });

  // ── Selection listener ────────────────────────────────────────────────────
  // Cache selection in background whenever it changes so the side panel
  // can read it even after focus has shifted away from the page.
  document.addEventListener('selectionchange', () => {
    const text = (window.getSelection()?.toString() || '').trim();
    try {
      chrome.runtime.sendMessage({ type: 'SELECTION_CACHE', text });
    } catch (_) {}
  });

  document.addEventListener('mouseup', (e) => {
    if (!toolbarEnabled || suppressedForPage || confirmOpen) return;
    // Ignore clicks inside our own toolbar / explain popover
    if (e.composedPath().some((el) => el === host || el === popHost)) return;

    // Ignore text inputs / editable areas
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
              t.isContentEditable || t.contentEditable === 'true')) {
      hide();
      return;
    }

    clearTimeout(pendingShow);
    pendingShow = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (!text || text.length < MIN_CHARS || sel.isCollapsed) { hide(); return; }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { hide(); return; }

      currentText = text.slice(0, MAX_PREVIEW);
      lastRange = range;
      place(rect);
    }, DEBOUNCE_MS);
  });

  // Hide on mousedown outside toolbar.
  // Exception: right-click (button=2). On Mac, a two-finger trackpad tap
  // fires mousedown BEFORE contextmenu, and the browser immediately resets
  // the selection to the word under the cursor. We hide the toolbar UI but
  // deliberately keep currentText so the contextmenu handler below can
  // re-send the ORIGINAL selection to the background cache before
  // contextMenus.onClicked fires.
  document.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
      // Right-click inside the popover (e.g. to copy via the browser menu)
      // must not kill the explanation.
      if (e.composedPath().some((el) => el === popHost)) return;
      // Visually collapse the toolbar without clearing currentText.
      clearTimeout(pendingShow);
      pendingShow = null;
      bar.classList.remove('vis');
      setTimeout(() => { if (!bar.classList.contains('vis')) bar.classList.remove('on'); }, 130);
      return;
    }
    if (!e.composedPath().some((el) => el === host || el === popHost)) {
      if (confirmOpen) hideConfirm();
      hide();
      closeExplain();
    }
  });

  // After mousedown resets the selection to a single word, contextmenu fires.
  // Re-send the original (pre-right-click) selection to the cache so the
  // background's contextMenus.onClicked can retrieve the full paragraph.
  document.addEventListener('contextmenu', () => {
    if (!currentText) return;
    try {
      chrome.runtime.sendMessage({ type: 'SELECTION_CACHE', text: currentText });
    } catch (_) {}
  });

  document.addEventListener('scroll', () => {
    if (confirmOpen) hideConfirm();
    hide();
    // 浮层不跟着 bar 一起消失：长解释需要滚动阅读。选区 Range 的
    // getBoundingClientRect 随页面移动保持视口准确，原地重锚即可。
    if (explain) placePopover();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (explain) placePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirmOpen) { cancelConfirm(); return; }
    hide();
    closeExplain();
  });

  // ── Button clicks ─────────────────────────────────────────────────────────
  shadow.querySelector('#close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    // ✕ asks for confirmation before suppressing the toolbar on this page.
    // The bar hides behind the dialog; only "Hide" actually suppresses.
    if (confirmOpen) return;
    showConfirm(bar.getBoundingClientRect());
  });

  // Hide = confirm: suppress on this page (until reload) and close everything.
  shadow.querySelector('#confirm-ok').addEventListener('click', (e) => {
    e.stopPropagation();
    suppressedForPage = true;
    hideConfirm();
    hide();
    closeExplain();
  });

  // Cancel: close the dialog, restore the bar exactly as it was.
  shadow.querySelector('#confirm-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    cancelConfirm();
  });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !currentText) return;
    const action = btn.dataset.action;
    if (action === 'explain' || action === 'translate') {
      // 解释/翻译走内联浮层：答案就地流式展示，不打断阅读、不打开 side panel。
      // bar 留在原地，用户可以接着点其他动作。提问/总结仍走老路。
      e.stopPropagation();
      openInlineExplain(currentText, action);
      return;
    }
    const text = currentText;
    hide();
    try {
      chrome.runtime.sendMessage({ type: 'SELECTION_ACTION', action, text });
    } catch (_) {}
  });
})();
