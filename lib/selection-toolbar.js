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
      .sep { width: 1px; height: 16px; background: rgba(255,255,255,0.1); margin: 0 1px; flex-shrink: 0; }
      @media (prefers-color-scheme: light) {
        .bar { background: #fff; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.14); }
        .bar::after { border-top-color: #fff; }
        .bar.below::after { border-bottom-color: #fff; border-top-color: transparent; }
        .btn { color: #24292f; }
        .btn:hover { background: rgba(0,0,0,0.06); color: #000; }
        .btn-ask { color: #0969da; }
        .btn-ask:hover { background: rgba(9,105,218,0.08); }
        .sep { background: rgba(0,0,0,0.1); }
      }
    </style>
    <div class="bar" id="bar" role="toolbar" aria-label="browsa quick actions">
      <button class="btn btn-ask" data-action="chat">💬 Ask</button>
      <div class="sep"></div>
      <button class="btn" data-action="explain">Explain</button>
      <button class="btn" data-action="translate">→ 中文</button>
      <button class="btn" data-action="summarize">Summarize</button>
    </div>
  `;

  const bar = shadow.getElementById('bar');
  document.documentElement.appendChild(host);

  // ── State ─────────────────────────────────────────────────────────────────
  let pendingShow = null;
  let currentText = '';

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
    if (!e.composedPath().some((el) => el === host)) hide();
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

  document.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  // ── Button clicks ─────────────────────────────────────────────────────────
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
