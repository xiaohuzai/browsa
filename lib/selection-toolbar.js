// lib/selection-toolbar.js
//
// Injects a floating mini-toolbar on any https page. When the user
// selects text, the toolbar appears above the selection with 4 actions:
//   Ask · Explain · Translate → 中 · Summarize
//
// Uses Shadow DOM so the toolbar's styles are fully isolated from the
// host page. Communicates with the background via chrome.runtime.sendMessage;
// the background relays to the side panel through the existing nav port.

(function () {
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime) return;
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
        background: #1c1c2e;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 9px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3);
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
        border-top-color: #1c1c2e;
        pointer-events: none;
      }
      .bar.below::after {
        top: auto;
        bottom: 100%;
        border-top-color: transparent;
        border-bottom-color: #1c1c2e;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 5px 9px;
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
      .btn-ask { color: #58a6ff; }
      .btn-ask:hover { background: rgba(88,166,255,0.15); color: #79b8ff; }
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
        background: #1c1c2e;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 9px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3);
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
      .confirm-msg span { display: block; color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 400; margin-top: 3px; }
      .confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }
      .cbtn {
        padding: 5px 13px; border: none; border-radius: 6px;
        font-size: 12px; font-weight: 500; cursor: pointer;
        font-family: inherit; transition: background 0.1s, color 0.1s;
      }
      .cbtn.cancel { background: transparent; color: #c9d1d9; }
      .cbtn.cancel:hover { background: rgba(255,255,255,0.08); color: #fff; }
      .cbtn.ok { background: #58a6ff; color: #fff; }
      .cbtn.ok:hover { background: #79b8ff; }
      @media (prefers-color-scheme: light) {
        .bar { background: #fff; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.14); }
        .bar::after { border-top-color: #fff; }
        .bar.below::after { border-bottom-color: #fff; border-top-color: transparent; }
        .btn { color: #24292f; }
        .btn:hover { background: rgba(0,0,0,0.06); color: #000; }
        .btn-ask { color: #0969da; }
        .btn-ask:hover { background: rgba(9,105,218,0.08); }
        .btn-close { color: rgba(0,0,0,0.3); }
        .btn-close:hover { background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.6); }
        .sep { background: rgba(0,0,0,0.1); }
        .confirm { background: #fff; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.14); }
        .confirm-msg { color: #24292f; }
        .confirm-msg span { color: rgba(0,0,0,0.5); }
        .cbtn.cancel { color: #24292f; }
        .cbtn.cancel:hover { background: rgba(0,0,0,0.06); color: #000; }
        .cbtn.ok { background: #0969da; }
        .cbtn.ok:hover { background: #0a78e8; }
      }
    </style>
    <div class="bar" id="bar" role="toolbar" aria-label="browsa quick actions">
      <img class="logo" src="${chrome.runtime.getURL('icons/icon16.png')}" alt="browsa" />
      <div class="sep"></div>
      <button class="btn btn-ask" data-action="chat"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>Ask</button>
      <div class="sep"></div>
      <button class="btn" data-action="explain">Explain</button>
      <button class="btn" data-action="translate">→ 中文</button>
      <button class="btn" data-action="summarize">Summarize</button>
      <div class="sep"></div>
      <button class="btn-close" id="close-btn" aria-label="Hide on this page" title="Hide on this page (reload restores)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="confirm" id="confirm" role="dialog" aria-label="Confirm hide on this page">
      <div class="confirm-msg">Hide toolbar on this page?<span>It won't show again until you reload.</span></div>
      <div class="confirm-actions">
        <button class="cbtn cancel" id="confirm-cancel">Cancel</button>
        <button class="cbtn ok" id="confirm-ok">Hide</button>
      </div>
    </div>
  `;

  const bar = shadow.querySelector('#bar');
  const confirmBox = shadow.querySelector('#confirm');
  document.documentElement.appendChild(host);

  // ── State ─────────────────────────────────────────────────────────────────
  let pendingShow = null;
  let currentText = '';
  // Set when the user confirms the ✕ dialog - suppresses the toolbar on this
  // page until reload (a fresh content script instance resets it). The
  // right-click context menu and 📎 attach are unaffected, so the user is
  // never stuck.
  let suppressedForPage = false;

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
    // Ignore clicks inside our own toolbar
    if (e.composedPath().some((el) => el === host)) return;

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
      // Visually collapse the toolbar without clearing currentText.
      clearTimeout(pendingShow);
      pendingShow = null;
      bar.classList.remove('vis');
      setTimeout(() => { if (!bar.classList.contains('vis')) bar.classList.remove('on'); }, 130);
      return;
    }
    if (!e.composedPath().some((el) => el === host)) {
      if (confirmOpen) hideConfirm();
      hide();
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
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirmOpen) { cancelConfirm(); return; }
    hide();
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
    const text = currentText;
    hide();
    try {
      chrome.runtime.sendMessage({ type: 'SELECTION_ACTION', action, text });
    } catch (_) {}
  });
})();
