// sidepanel.js — UI logic
// Talks to background.js via chrome.runtime messages. Streaming responses come back
// via a long-lived Port (chrome.runtime.connect) for low-latency chunk delivery.

import { PAGE_CONTEXT_PREFIX } from './lib/constants.js';
import { ICONS } from './lib/sidepanel/icons.js';
import { $, escM, _copyText, showToast, showConfirmDialog, sendMessage, _findCard, _insertCard } from './lib/sidepanel/ui-utils.js';
import {
  renderSafe, renderMermaid, renderEcharts, renderMarkmap, preloadChartVendors,
  addCodeCopyButtons, decorateLinks, linkifyTimestamps,
  makeStreamRenderer, setThoughtAutoCollapse
} from './lib/sidepanel/render.js';
import { initMsgSearch, openMsgSearch, closeMsgSearch } from './lib/sidepanel/msg-search.js';
import {
  initSessionsUI, getSessionsDrawer, openSessionsDrawer, onSessionSearch,
  closeSessionsDrawer, clearAllSessions
} from './lib/sidepanel/sessions-ui.js';
import {
  initMultiselect, isInMultiSelectMode, enterMultiSelect, exitMultiSelect,
  deleteSelectedMessages
} from './lib/sidepanel/multiselect.js';
import './lib/sidepanel/detail-thread.js'; // wires its own mouseup/scroll listeners on import
// smd removed: <thinking> tags from Claude confused its HTML parser, breaking markdown rendering.

// Shared makeStreamRenderer() callbacks: addMsgActions/scrollToBottom are
// sidepanel.js-owned UI concerns that lib/render.js deliberately doesn't
// import (would create a cross-module cycle) — passed in per call instead.
const streamRendererOpts = {
  onTick: () => {
    if (isUserScrolledUp && scrollToBottomBtn) scrollToBottomBtn.classList.add('has-new');
    scrollToBottom();
  },
  onDone: (el, delta) => {
    addMsgActions(el, () => delta);
    scrollToBottom(true);
  }
};

const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const providerSel = $('provider');
const charCountEl = $('charcount');
const tokCountEl = $('tokcount');
const composerInfoEl = $('composerinfo');
const attachBtn = $('attach');
if (composerInfoEl) composerInfoEl.style.display = 'none'; // hidden until user types
const settingsBtn = $('settings');
const ctxRadios = document.querySelectorAll('input[name="ctx"]');
const pagemetaEl = $('pagemeta');
const diagnosticsEl = $('diagnostics');
const imagePreviewsEl = $('imagepreviews');
const imageInfoEl = $('imageinfo');
const imagePicker = $('imagepicker');

let currentTabId = null;
let activeController = null; // for cancelling in-flight stream
let lastPageMeta = null;
let slashSuggestIdx = -1;  // keyboard-nav index in slash autocomplete
let lastSentRaw = '';   // raw input text of last user send, used by Retry
let nextHistoryIdx = 0; // mirrors history.length; used to assign data-hidx to new bubbles
let deleteLock = false; // serialises message-delete operations to prevent index races
let isUserScrolledUp = false; // true when user has manually scrolled up during streaming
let scrollToBottomBtn = null; // lazy-created scroll-to-bottom button
let navPort = null;             // long-lived port for SPA navigation pushes
let lastXhsNote = null;         // most-recent XHR-intercepted 小红书 note
const images = [];             // { dataUrl, name } — attached for this turn

// ─── Feature state ────────────────────────────────────────────────────────────
let sendShortcut = 'enter';       // 'enter' | 'ctrl-enter'
let streamStartAt = 0;            // timestamp of first CHUNK (for tokens/sec)
// Per-tab conversation DOM snapshot. When the user switches tabs, we save
// the current messagesEl.innerHTML here and restore it when they switch back.
// This preserves in-flight streaming replies that haven't been persisted to
// storage yet — the v0.20.1 "switch tab → reply vanishes" bug.
// tabStates removed — single global session, no per-tab DOM snapshots needed.
const clearBtn = $('clear');
const slashSuggestEl = $('slash-suggest');

init();

async function init() {
  // Get current tab id (used for per-tab history)
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTabId = tab?.id;

  initSessionsUI({
    cancelActiveStream: () => { if (activeController && !activeController.cancelled) cancelStream(); },
    renderHistory,
    scrollToBottom,
    clearPendingImages: () => { images.length = 0; refreshImageStrip(); }
  });
  initMultiselect({
    decrementNextHistoryIdx: () => { nextHistoryIdx = Math.max(0, nextHistoryIdx - 1); }
  });

  // Load config
  const cfgRes = await sendMessage({ type: 'GET_CONFIG' });
  const cfg = cfgRes.data || cfgRes; // unwrap { ok, data } envelope
  populateProviderSelect(cfg);
  applyContextMode(cfg.contextMode || 'auto');
  // Quickbar collapse: purely a user preference, no auto-hide heuristic —
  // same "user decides, we don't guess" principle as the message fold button.
  $('quickbar')?.classList.toggle('collapsed', !!cfg.quickbarCollapsed);

  // Load chat preferences
  sendShortcut = cfg.sendShortcut || 'enter';
  setThoughtAutoCollapse(cfg.thoughtAutoCollapse);
  if (cfg.fontSize) applyFontSize(cfg.fontSize);

  // Load history
  await renderHistory();

  // Wire UI
  providerSel.addEventListener('change', onProviderChange);


  $('sessions-btn')?.addEventListener('click', openSessionsDrawer);
  document.getElementById('sessions-close')?.addEventListener('click', closeSessionsDrawer);
  $('sessions-new')?.addEventListener('click', newSession);
  // Sessions drawer: search and clear-all wired once here to avoid stacking listeners
  document.querySelector('.sessions-search')?.addEventListener('input', onSessionSearch);
  $('sessions-clear-all')?.addEventListener('click', clearAllSessions);
  settingsBtn.addEventListener('click', openSettingsPage);
  clearBtn.addEventListener('click', clearChatHistory);
  ctxRadios.forEach((r) => r.addEventListener('change', onContextModeChange));
  sendBtn.addEventListener('click', () => {
    if (activeController && !activeController.cancelled) cancelStream();
    else onSend();
  });
  attachBtn?.addEventListener('click', onAttachPage);
  document.querySelectorAll('.qa-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      inputEl.value = btn.dataset.cmd || '';
      inputEl.focus();
      onSend();
    });
  });
  $('quickbar-toggle')?.addEventListener('click', () => {
    const collapsed = $('quickbar').classList.toggle('collapsed');
    chrome.storage.local.set({ quickbarCollapsed: collapsed });
  });
  inputEl.addEventListener('input', () => { updateComposerInfo(); updateSlashSuggest(); });
  inputEl.addEventListener('blur', () => setTimeout(() => hideSlashSuggest(), 150));
  inputEl.addEventListener('keydown', (e) => {
    // Slash autocomplete navigation
    if (slashSuggestEl && !slashSuggestEl.hidden) {
      const items = slashSuggestEl.querySelectorAll('.slash-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashSuggestIdx = Math.min(slashSuggestIdx + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle('active', i === slashSuggestIdx));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashSuggestIdx = Math.max(slashSuggestIdx - 1, 0);
        items.forEach((it, i) => it.classList.toggle('active', i === slashSuggestIdx));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && slashSuggestIdx >= 0)) {
        e.preventDefault();
        const active = slashSuggestIdx >= 0 ? items[slashSuggestIdx] : items[0];
        if (active) inputEl.value = active.dataset.cmd;
        hideSlashSuggest();
        if (e.key === 'Enter') onSend();
        return;
      }
      if (e.key === 'Escape') { hideSlashSuggest(); return; }
    }
    // Send shortcut: Enter (default) or Shift+Enter
    if (sendShortcut === 'shift-enter') {
      if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
        e.preventDefault(); onSend();
      }
    } else {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault(); onSend();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      clearChatHistory();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      cycleContextMode();
    }
    // Ctrl+F / Cmd+F — open in-conversation search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openMsgSearch();
    }
  });

  // Global shortcuts (Esc = cancel stream or close drawer/search, Ctrl+F = search)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('msg-search-bar')?.hidden) { closeMsgSearch(); return; }
      if (isInMultiSelectMode()) { exitMultiSelect(); return; }
      if (!getSessionsDrawer()?.hidden) { closeSessionsDrawer(); return; }
      if (activeController && !activeController.cancelled) { e.preventDefault(); cancelStream(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && document.activeElement !== inputEl) {
      e.preventDefault();
      openMsgSearch();
    }
  });

  // Show current page meta
  if (tab) {
    pagemetaEl.textContent = tab.title || tab.url || '';
    pagemetaEl.href = tab.url || '#';
    pagemetaEl.title = tab.url || '';
  }

  // Update page meta when tab changes — save/restore conversation DOM
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    // The side panel document stays alive across tab switches (Chrome does NOT
    // tear it down). So we never touch the DOM here — no renderHistory(), no
    // stream resume. The chat UI, in-flight bubbles, and system messages all
    // remain exactly as the user left them. We only update:
    //   1. currentTabId  — so the next ATTACH_PAGE / CHAT targets the right tab
    //   2. page-meta bar — cosmetic, shows which page 📎 will attach
    //   3. nav port      — so SPA nav events route to the new tab
    currentTabId = tabId;

    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t) {
      pagemetaEl.textContent = t.title || t.url || '';
      pagemetaEl.href = t.url || '#';
      pagemetaEl.title = t.url || '';
    }
    if (navPort) {
      try { navPort.postMessage({ type: 'NAV_FOLLOW', tabId }); } catch (_) {}
    }
  });
  chrome.tabs.onUpdated.addListener(async (tabId, _info, t) => {
    if (tabId === currentTabId) {
      pagemetaEl.textContent = t.title || t.url || '';
      pagemetaEl.href = t.url || '#';
      pagemetaEl.title = t.url || '';
    }
  });

  // Long-lived nav port. The background pushes NAVIGATED events for ANY
  // tab (it's a firehose). We filter to our current tab so SPAs like
  // 小红书 update the side panel's page-meta UI in real time when the
  // user clicks from one note to another. Without this, chrome.tabs.onUpdated
  // never fires (SPA pushState is invisible to it), and the side panel
  // would keep showing the title of the first note the user opened.
  // Extract navPort message handler as a named function so we can
  // re-attach it every time the port reconnects (after SW restart, a new
  // port object is created — the old listener is lost and must be re-bound).
  function onNavPortMessage(msg) {
    if (!msg) return;
    if (msg.type === 'SELECTION_ACTION') {
      handleSelectionAction(msg.action, msg.text);
      return;
    }

    if (msg.type === 'XHS_XHR_NOTE') {
      // Real XHR data from the content script. The most authoritative
      // source — the browser's own signed fetch, with cookies. We
      // always accept it (overwriting any prior note for this tab).
      if (msg.tabId !== currentTabId) return;
      lastXhsNote = msg.note;
      // Re-probe the diagnostics banner so the user sees the
      // "extraction is healthy" state if desc is now populated.
      if (/^https?:\/\/(www\.)?xiaohongshu\.com\/explore\//.test(pagemetaEl.href)) {
        renderDiagnosticsFromXhr(lastXhsNote);
      }
      return;
    }
    if (msg.type !== 'NAVIGATED') return;
    if (msg.tabId !== currentTabId) return; // firehose filter
    if (msg.closed) {
      pagemetaEl.textContent = '(tab closed)';
      pagemetaEl.href = '#';
      pagemetaEl.title = '';
      diagnosticsEl.hidden = true;
      diagnosticsEl.innerHTML = '';
      lastXhsNote = null;
      return;
    }
    if (msg.url) {
      pagemetaEl.href = msg.url;
      pagemetaEl.title = msg.url;
    }
    if (msg.title) {
      pagemetaEl.textContent = msg.title;
    } else if (msg.url) {
      // Title comes from webNavigation as empty; show the URL path so the
      // user at least sees something change.
      try {
        const u = new URL(msg.url);
        pagemetaEl.textContent = u.pathname + u.search;
      } catch (_) {
        pagemetaEl.textContent = msg.url;
      }
    }
    // Re-probe the new URL. If it's a 小红书 explore page, the
    // diagnostics banner needs to update. We don't await — the new
    // banner will appear when the probe finishes (a few hundred ms).
    if (msg.url && /^https?:\/\/(www\.)?xiaohongshu\.com\/explore\//.test(msg.url)) {
      // New note — clear the prior XHR cache so we don't send
      // stale data. The content script will deliver the new note's
      // XHR within a few hundred ms.
      lastXhsNote = null;
      sendMessage({ type: 'GET_PAGE_CONTEXT', mode: 'reader', tabId: currentTabId })
        .then((ctx) => renderDiagnostics(ctx))
        .catch(() => {});
    } else {
      // Not a 小红书 note — clear the banner and cache.
      diagnosticsEl.hidden = true;
      diagnosticsEl.innerHTML = '';
      lastXhsNote = null;
    }
  }

  function connectNavPort() {
    navPort = chrome.runtime.connect({ name: 'browsa-nav' });
    navPort.postMessage({ type: 'NAV_HELLO', tabId: currentTabId });
    // Re-attach message listener on every new port object.
    navPort.onMessage.addListener(onNavPortMessage);
    navPort.onDisconnect.addListener(() => {
      navPort = null;
      // Read session storage DIRECTLY — no SW roundtrip needed, no 1-second
      // wait. If a selection action was stored while the SW was restarting,
      // the sidepanel can read and deliver it immediately by itself.
      chrome.storage.session.get(['pendingSelectionAction']).then((sess) => {
        if (sess.pendingSelectionAction) {
          chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
          const { action, text } = sess.pendingSelectionAction;
          handleSelectionAction(action, text);
        }
      }).catch(() => {});
      // Also reconnect the nav port after a short delay so future events work.
      setTimeout(() => {
        if (!navPort) {
          try { connectNavPort(); } catch (_) {}
        }
      }, 1000);
    });
  }

  connectNavPort();

  // Diagnostics: on init, do a one-shot XHS page-context probe so we
  // can render a warning banner if extraction looks suspect (e.g. the
  // user isn't logged in to 小红书, or x-s signing was rejected, etc.).
  // We don't need to do this for every page — only when the user is on
  // a 小红书 explore page. The result is purely informational.
  try {
    const live = await chrome.tabs.get(currentTabId);
    if (live && /^https?:\/\/(www\.)?xiaohongshu\.com\/explore\//.test(live.url || '')) {
      const ctxRes = await sendMessage({ type: 'GET_PAGE_CONTEXT', mode: 'reader', tabId: currentTabId });
      renderDiagnostics(ctxRes.data || ctxRes);
    }
  } catch (_) { /* tab closed or not yet ready */ }

  // Listen for config changes (from options page)
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local') {
      if (changes.providers || changes.activeProvider || changes.pingStates) {
        const cfg2Res = await sendMessage({ type: 'GET_CONFIG' });
        populateProviderSelect(cfg2Res.data || cfg2Res);
      }
      if (changes.fontSize?.newValue != null) applyFontSize(changes.fontSize.newValue);
      if (changes.sendShortcut?.newValue != null) sendShortcut = changes.sendShortcut.newValue;
      if (changes.thoughtAutoCollapse != null) setThoughtAutoCollapse(changes.thoughtAutoCollapse.newValue);
      return;
    }
    // Session storage: pick up pending selection actions written by the
    // background when the navPort relay failed (SW just woke up, navPorts
    // empty). This fires even when the SW restarts because storage.onChanged
    // is delivered to the side panel directly, not through the SW.
    if (area === 'session' && changes.pendingSelectionAction?.newValue) {
      const { action, text } = changes.pendingSelectionAction.newValue;
      chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
      handleSelectionAction(action, text);
    }
  });

  // Image paste / drop / picker
  inputEl.addEventListener('paste', onPaste);
  const composer = document.querySelector('.composer');
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('dragover'); });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('dragover');
    handleDroppedFiles(e.dataTransfer.files);
  });
  imagePicker.addEventListener('change', () => {
    if (imagePicker.files) handleDroppedFiles(imagePicker.files);
    imagePicker.value = ''; // reset so re-pick works
  });

  refreshImageStrip();

  // After history is rendered, peek the background for any in-flight
  // stream on this tab. If the user switched tabs mid-reply and then
  // came back, this is what re-attaches the live chunk feed to the
  // freshly-rendered (history-only) DOM — without it the panel would
  // sit on a "▍" placeholder forever even though the LLM had already
  // produced the reply.
  if (currentTabId != null) {
    await resumeInFlightStream(currentTabId).catch((e) =>
      console.warn('browsa: init resumeInFlightStream failed', e)
    );
  }
  // Snap to the bottom of the rendered history. renderHistory() does
  // call scrollToBottom, but Chrome may not have finished the first
  // layout pass by the time we read scrollHeight (the side panel
  // iframe was just constructed, fonts are still loading, etc.). A
  // rAF ensures the layout is done and the snap sticks.
  requestAnimationFrame(() => scrollToBottom());

  // Deliver any pending selection action (toolbar/right-click that opened
  // the panel). Read session storage directly — no SW roundtrip needed.
  try {
    const sess = await chrome.storage.session.get(['pendingSelectionAction']);
    if (sess.pendingSelectionAction) {
      chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
      const { action, text } = sess.pendingSelectionAction;
      setTimeout(() => handleSelectionAction(action, text), 150);
    }
  } catch (_) {}

  // Show a one-time notice when the extension was just updated.
  // Clears the badge and storage flag so it only appears once.
  try {
    const { pendingUpdateNotice } = await chrome.storage.local.get('pendingUpdateNotice');
    if (pendingUpdateNotice) {
      appendSystem(`🔄 browsa updated to v${pendingUpdateNotice} — if the floating toolbar doesn't respond on a page, refresh it once.`);
      await chrome.storage.local.remove('pendingUpdateNotice');
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) {}

  // Scroll-to-bottom button: show when user scrolls up, hide at bottom
  scrollToBottomBtn = document.createElement('button');
  scrollToBottomBtn.className = 'scroll-to-bottom-btn';
  scrollToBottomBtn.hidden = true;
  scrollToBottomBtn.title = 'Jump to bottom';
  scrollToBottomBtn.textContent = '↓';
  scrollToBottomBtn.addEventListener('click', () => {
    isUserScrolledUp = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    scrollToBottomBtn.hidden = true;
    scrollToBottomBtn.classList.remove('has-new');
  });
  document.querySelector('.composer').insertAdjacentElement('beforebegin', scrollToBottomBtn);

  messagesEl.addEventListener('scroll', () => {
    const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    isUserScrolledUp = dist > 80;
    scrollToBottomBtn.hidden = !isUserScrolledUp;
  }, { passive: true });

  // Image lightbox — delegate click on all img inside messages
  messagesEl.addEventListener('click', (e) => {
    const ts = e.target.closest('.browsa-ts');
    if (ts) { onTimestampClick(ts); return; }
    const img = e.target.closest('img');
    if (img && img.src && !img.closest('.msg-images')) {
      showImageLightbox(img.src, img.alt);
    }
  });

  // Wire search bar
  initMsgSearch();
  $('search-btn')?.addEventListener('click', openMsgSearch);

  // Wire multi-select toggle
  $('multiselect-toggle')?.addEventListener('click', () => {
    if (isInMultiSelectMode()) exitMultiSelect(); else enterMultiSelect();
  });
  $('multiselect-delete')?.addEventListener('click', deleteSelectedMessages);
  $('multiselect-cancel')?.addEventListener('click', exitMultiSelect);

  inputEl.focus();
}

/**
 * Handle a selection action triggered by the floating toolbar.
 * 'chat'      → pre-fills the textarea for the user to add a question.
 * 'explain'   → auto-sends an explain prompt.
 * 'translate' → auto-sends a translate prompt.
 * 'summarize' → auto-sends a summarize prompt.
 */
async function handleSelectionAction(action, text) {
  if (!text) return;

  if (action === 'chat') {
    // Attach the selected text as context (selection mode), then focus input.
    // Pass text explicitly as fallback — the selectionchange cache in the
    // background may be empty if the SW was sleeping when the user selected.
    const res = await sendMessage({ type: 'ATTACH_PAGE', tabId: currentTabId, mode: 'selected', text }).catch(() => null);
    if (res?.data?.ok) {
      nextHistoryIdx++; // selected-text context stored to history
      const preview = text.length > 80
        ? text.slice(0, 50) + ' … ' + text.slice(-25)
        : text;
      appendAttachSystem(`📎 已附加：「${preview}」`);
    } else {
      appendError(res?.data?.error || '没有获取到选中文字，请重新选择');
    }
    inputEl.focus();
    updateComposerInfo();
    return;
  }

  const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
  const quoted = `"${preview}"`;
  const prompts = {
    explain:   `Explain the following:\n\n${quoted}`,
    translate: `Translate the following to Chinese:\n\n${quoted}`,
    summarize: `Summarize the following:\n\n${quoted}`
  };
  const prompt = prompts[action];
  if (!prompt) return;

  inputEl.value = prompt;
  updateComposerInfo();
  onSend();
}



function populateProviderSelect(cfg) {
  const pingStates = cfg.pingStates || {};
  // Reachable providers first (stable sort — ties keep their original
  // relative order), so a provider you've actually verified works doesn't
  // get buried below ones that are merely configured-but-unverified or
  // unconfigured. "Configured" (has a baseUrl) isn't a strong enough signal
  // on its own — Hermes ships with a non-empty default baseUrl, so it would
  // always sort first even if you never intended to use it.
  const providers = Object.keys(cfg.providers || {})
    .map((name, i) => ({ name, i }))
    .sort((a, b) => {
      const ar = pingStates[a.name] === 'reachable' ? 0 : 1;
      const br = pingStates[b.name] === 'reachable' ? 0 : 1;
      return ar - br || a.i - b.i;
    })
    .map(({ name }) => name);
  providerSel.innerHTML = '';
  for (const name of providers) {
    const opt = document.createElement('option');
    opt.value = name;
    const configured = !!(cfg.providers[name]?.baseUrl?.trim());
    let status;
    if (!configured)               status = 'not set';
    else if (pingStates[name] === 'reachable')   status = '● reachable';
    else if (pingStates[name] === 'unreachable') status = '○ unreachable';
    else                           status = 'not pinged';
    opt.textContent = `${prettyProviderName(name)} — ${status}`;
    if (name === cfg.activeProvider) opt.selected = true;
    providerSel.appendChild(opt);
  }
}

function prettyProviderName(name) {
  const map = { hermes: 'Hermes', 'claude-code': 'Claude Code', compatible: 'OpenAI-compatible' };
  return map[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── Timestamps ──────────────────────────────────────────────────────────────
function nowTimeStr() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function nowDateStr() { return new Date().toLocaleString(); }
function addTimestamp(el) {
  const span = document.createElement('span');
  span.className = 'msg-time';
  span.textContent = nowTimeStr();
  span.title = nowDateStr();
  el.appendChild(span);
}

// ─── Slash autocomplete ───────────────────────────────────────────────────────
function updateSlashSuggest() {
  if (!slashSuggestEl) return;
  const val = inputEl.value;
  if (!val.startsWith('/') || val.includes(' ')) { hideSlashSuggest(); return; }
  const q = val.toLowerCase();
  const matches = Object.keys(SLASH_COMMANDS).filter(k => k.toLowerCase().startsWith(q));
  if (!matches.length) { hideSlashSuggest(); return; }
  slashSuggestEl.innerHTML = '';
  slashSuggestIdx = -1;
  for (const cmd of matches) {
    const item = document.createElement('div');
    item.className = 'slash-item';
    item.dataset.cmd = cmd;
    const desc = SLASH_COMMANDS[cmd];
    const shortDesc = desc.length > 55 ? desc.slice(0, 55) + '…' : desc;
    item.innerHTML = `<span class="slash-cmd">${cmd}</span><span class="slash-desc">${shortDesc}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      inputEl.value = cmd;
      hideSlashSuggest();
      inputEl.focus();
      onSend();
    });
    slashSuggestEl.appendChild(item);
  }
  slashSuggestEl.hidden = false;
}
function hideSlashSuggest() {
  if (slashSuggestEl) slashSuggestEl.hidden = true;
  slashSuggestIdx = -1;
}

// Render a yellow banner above the chat when the active page is 小红书
// and the extraction result looks suspicious (too-short desc, no images,
// no title, etc.). We DO NOT silence the result — it still gets sent to
// the LLM — but we tell the user "this might not be the full note, you
// may want to log in to 小红书 in this browser."
function renderDiagnostics(ctx) {
  if (!ctx || ctx.error) {
    diagnosticsEl.hidden = false;
    diagnosticsEl.innerHTML =
      `Couldn't read this page: <code>${escM(ctx?.error || 'unknown')}</code>. ` +
      `If this is 小红书, try logging in or opening the note in a regular tab.`;
    return;
  }
  if (!ctx.xhsSource) {
    // Non-小红书 page — no diagnostics needed.
    diagnosticsEl.hidden = true;
    diagnosticsEl.innerHTML = '';
    return;
  }
  if (!ctx.xhsDegraded) {
    diagnosticsEl.hidden = true;
    diagnosticsEl.innerHTML = '';
    return;
  }
  // Build the warning. The reasons array gives specific signals.
  const reasons = (ctx.xhsDegradeReasons || []).map((r) => `<code>${escM(r)}</code>`).join(', ');
  diagnosticsEl.hidden = false;
  diagnosticsEl.innerHTML =
    `小红书 content may be incomplete (${reasons}). ` +
    `If you're not logged in to <code>xiaohongshu.com</code> in this browser, ` +
    `the XHR often returns a different note or a skeleton. ` +
    `Login there, reload this page, then re-send. ` +
    `<em>Sent content still includes whatever was read; this is just a heads-up.</em>`;
}

// Like renderDiagnostics but driven directly by a live XHR note we
// just intercepted. We don't have to wait for the round-trip to the
// background to re-probe the DOM. This is the post-v0.19.0 fast path.
function renderDiagnosticsFromXhr(note) {
  if (!note) {
    // No XHR yet — fall through to the existing probe-based render.
    sendMessage({ type: 'GET_PAGE_CONTEXT', mode: 'reader', tabId: currentTabId })
      .then((res) => renderDiagnostics(res.data || res))
      .catch(() => {});
    return;
  }
  const descLen = (note.desc || '').length;
  const titleLen = (note.title || '').length;
  const reasons = [];
  if (titleLen === 0) reasons.push('title empty (XHR)');
  if (descLen < 20) reasons.push(`desc too short (${descLen} chars, XHR)`);
  if (note.imageCount === 0 && descLen < 30) reasons.push('no images, near-empty desc (XHR)');
  if (reasons.length > 0) {
    diagnosticsEl.hidden = false;
    diagnosticsEl.innerHTML =
      `小红书 content may be incomplete (${reasons.map((r) => `<code>${escM(r)}</code>`).join(', ')}). ` +
      `The XHR returned, but it looks thin. If this doesn't match the page, ` +
      `try a hard refresh (Ctrl+Shift+R).`;
  } else {
    // Healthy XHR. The DOM may still be stale, but the data source
    // is good — clear the warning.
    diagnosticsEl.hidden = true;
    diagnosticsEl.innerHTML = '';
  }
}

function applyContextMode(mode) {
  // Legacy modes (reader/full/dom/selected) all map to 'auto' now
  const effective = ['auto', 'screenshot'].includes(mode) ? mode : 'auto';
  for (const r of ctxRadios) r.checked = r.value === effective;
}

/** Cycle: auto → screenshot → auto */
function cycleContextMode() {
  const modes = ['auto', 'screenshot'];
  const cur = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  const idx = modes.indexOf(cur);
  const next = modes[(idx + 1) % modes.length];
  applyContextMode(next);
  onContextModeChange(); // persist
}

async function onAttachPage() {
  if (!currentTabId) return;
  const mode = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  attachBtn.disabled = true;
  attachBtn.style.opacity = '0.5';
  const origTitle = attachBtn.title;
  attachBtn.title = 'Reading page…';

  try {
    const res = await sendMessage({ type: 'ATTACH_PAGE', tabId: currentTabId, mode });
    if (!res?.ok || !res.data?.ok) {
      appendError(res?.data?.error || res?.error || 'Failed to read page');
      return;
    }
    const ctx = res.data?.ctx;
    const title = ctx?.articleTitle || ctx?.meta?.title || 'Page';

    // Screenshot mode: show crop UI before storing. User can select a region
    // or use the full image. Storing to history happens only on confirm.
    if (mode === 'screenshot' && ctx?.imageDataUrl) {
      showScreenshotCropUI({
        imageDataUrl: ctx.imageDataUrl,
        metaUrl: ctx.meta?.url || '',
        metaTitle: title,
      }, async (finalDataUrl) => {
        // Confirmed (full or cropped image) — await so nextHistoryIdx only
        // increments if the storage write actually succeeded.
        const res = await sendMessage({ type: 'ATTACH_SCREENSHOT_CONFIRM',
          imageDataUrl: finalDataUrl,
          metaUrl: ctx.meta?.url || '',
          metaTitle: title }).catch(() => null);
        if (res?.ok) nextHistoryIdx++;
        const screenshotEl = appendScreenshot(finalDataUrl);
        appendAttachSystem(`📎 已附加截图："${title}"`, screenshotEl);
      });
      return; // crop UI takes over; nothing else to do here
    }

    nextHistoryIdx++; // page context stored in ATTACH_PAGE handler
    const charCount = ctx?.truncated?.textLength ?? (ctx?.text?.length || 0);
    const charLabel = charCount > 0 ? `，${charCount.toLocaleString()} 字符` : '，内容为空';
    // For auto mode, show which sub-mode was actually used
    const modeLabel = mode === 'auto' ? `auto/${ctx?.autoMode || 'reader'}` : mode;
    appendAttachSystem(`📎 已附加："${title}"（${modeLabel}${charLabel}）`);
  } catch (e) {
    appendError('Page attach failed: ' + e.message);
  } finally {
    attachBtn.disabled = false;
    attachBtn.style.opacity = '';
    attachBtn.title = origTitle;
  }
}

async function newSession() {
  // Auto-save current conversation if it has messages, then clear
  const { history } = await chrome.storage.local.get('history');
  const hasMessages = Array.isArray(history) && history.some(m => m.role === 'user' || m.role === 'assistant');
  if (hasMessages) {
    const res = await sendMessage({ type: 'SAVE_SESSION' });
    if (res?.ok && res.data?.session) {
      showToast(`Session saved: "${res.data.session.name}"`, 'success');
    }
  }
  await sendMessage({ type: 'CLEAR_HISTORY' });
  messagesEl.innerHTML = '';
  nextHistoryIdx = 0;
  deleteLock = false;
  isUserScrolledUp = false;
  if (scrollToBottomBtn) scrollToBottomBtn.hidden = true;
  images.length = 0; refreshImageStrip(); // clear any pending image attachments
  closeSessionsDrawer();
  inputEl.focus();
}

async function clearChatHistory() {
  const ok = await showConfirmDialog({
    title: 'Clear conversation',
    message: 'Delete all messages? This cannot be undone.',
    confirmLabel: 'Clear',
    danger: true
  });
  if (!ok) return;
  await sendMessage({ type: 'CLEAR_HISTORY' });
  messagesEl.innerHTML = '';
  nextHistoryIdx = 0;
  deleteLock = false;
  isUserScrolledUp = false;
  if (scrollToBottomBtn) scrollToBottomBtn.hidden = true;
  images.length = 0; refreshImageStrip();
  showToast('Conversation cleared', 'success');
}

/**
 * Reconcile nextHistoryIdx with the actual storage length.
 * Called after every DONE event to catch auto-trim (history capped at 60
 * entries / 300K chars): if storage trimmed old entries off the front,
 * nextHistoryIdx and all data-hidx values drift high by the same amount.
 * Fire-and-forget (no await needed at call sites).
 */
async function reconcileHistoryIdx() {
  try {
    const { history: h } = await chrome.storage.local.get('history');
    const actualLen = Array.isArray(h) ? h.length : nextHistoryIdx;
    const drift = nextHistoryIdx - actualLen;
    if (drift <= 0) return; // no trim, nothing to do
    // Shift every visible bubble's data-hidx down by the trim count.
    // Bubbles whose index goes below 0 are no longer in storage; their
    // delete buttons will be no-ops (REMOVE_HISTORY_ENTRY_BY_INDEX returns
    // false for out-of-range indices), so they degrade safely.
    messagesEl.querySelectorAll('[data-hidx]').forEach(b => {
      const bidx = parseInt(b.dataset.hidx, 10);
      if (!isNaN(bidx)) b.dataset.hidx = bidx - drift;
    });
    nextHistoryIdx = actualLen;
  } catch (_) { /* storage unavailable — leave as-is */ }
}

const SEND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/></svg>`;
const STOP_ICON  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

function setStreamingUI(on) {
  if (on) {
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.classList.add('is-stopping');
    sendBtn.disabled = false;
    sendBtn.title = 'Stop (Esc)';
  } else {
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.classList.remove('is-stopping');
    sendBtn.disabled = false;
    sendBtn.title = '';
  }
}

function cancelStream() {
  if (!activeController) return;
  activeController.cancelled = true;
  const wasResumed = activeController.resumed === true;
  const port = activeController.port;
  // Capture these BEFORE touching the port below — port.disconnect() can
  // synchronously fire this same port's onDisconnect listener (jsdom's fake
  // port does; real chrome.runtime.Port normally fires it on a later tick,
  // but nothing guarantees that), and that listener sets activeController
  // to null. Reading activeController.el/.renderStream after disconnect()
  // would then throw.
  const cancelledEl = activeController.el;
  const cancelledRenderStream = activeController.renderStream;
  // Send STREAM_ABORT first (best-effort). The background's CHAT handler
  // is awaiting chatStream() with the matching AbortController; calling
  // .abort() throws AbortError on the next read(), which the catch
  // block catches and turns into a clean "no history write" return.
  // Then GOODBYE tells the background to drop the port entry. We do
  // NOT send STREAM_RELEASE — the CHAT handler's abort catch already
  // calls clearStreamState, and a second release would just be a
  // harmless no-op, but skipping it keeps the wire clean.
  if (currentTabId != null) {
    sendMessage({ type: 'STREAM_ABORT', tabId: currentTabId }).catch(() => {});
  }
  if (port) {
    try { port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
    try { port.disconnect(); } catch (_) {}
  }
  // Disconnecting the port above means the background's ERROR/ABORTED
  // message (which normally finalizes the bubble via renderStream(..., true)
  // — see the ERROR handlers elsewhere in onSend/resumeInFlightStream) will
  // never arrive for a user-initiated cancel. Without this, the cancelled
  // bubble's ::after blinking-cursor pseudo-element keeps animating forever,
  // since nothing else ever adds .done to it — a real bug: cancel, then send
  // a new message, and the OLD bubble's cursor is still blinking alongside
  // the new one's.
  if (cancelledEl) {
    cancelledEl.classList.add('done');
    // Clear any transient tool-progress / TS_STATUS indicator so a cancel
    // mid-rewrite (or mid-tool-call) doesn't leave the status lingering
    // above the now-finalized bubble.
    clearToolProgress(cancelledEl);
    cancelledRenderStream?.destroy?.();
  }
  activeController = null;
  setStreamingUI(false);
  // Distinguish user-initiated cancel (wasResumed=false) from cancel
  // of a resumed stream (wasResumed=true). A resumed stream's "cancel"
  // is closer to "stop watching" — the LLM is still running for the
  // tab. Same UX though: the local assistant bubble is dropped.
  appendSystem(wasResumed ? '⚠ Stopped watching resumed stream' : '⚠ Stream cancelled');
}

let outputTokens = 0;
function updateOutputTokenCount(delta) {
  const cjk = (delta.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const rest = delta.length - cjk;
  outputTokens += Math.round(cjk + rest / 4);
  tokCountEl.textContent = `~${outputTokens}`;
}

// Approximate character / token counter. We avoid bundling gpt-tokenizer
// (~1MB BPE table) because:
//   1. The exact count is non-critical — users just need a sense of size.
//   2. Each LLM tokenizes differently (o200k_base, cl100k_base, etc.) and
//      we have no way to know which the active provider uses.
//   3. Token count for a "feel" is good enough: 1 CJK char ≈ 0.5-1.0 token,
//      1 English word ≈ 1.0-1.3 tokens. We use a simple heuristic:
//        cjk chars  : 1.0 token each
//        non-cjk    : ceil(length / 4)  (rough word+punctuation count)
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.round(cjk + rest / 4);
}

function updateComposerInfo() {
  if (!charCountEl || !tokCountEl) return;
  const t = inputEl.value;
  const est = estimateTokens(t);
  charCountEl.textContent = t.length.toLocaleString();
  tokCountEl.textContent = '~' + est.toLocaleString();
  // Hide when empty, show and color when there's content
  composerInfoEl.style.display = t.length === 0 ? 'none' : '';
  composerInfoEl.classList.remove('warn', 'danger');
  if (est > 50_000) composerInfoEl.classList.add('danger');
  else if (est > 10_000) composerInfoEl.classList.add('warn');
}

async function openSettingsPage() {
  // chrome.runtime.openOptionsPage() is unreliable when invoked from a side
  // panel context (Chromium 41294020). Workaround: ask the service worker
  // to open a new tab pointing at our options.html. The extension URL is
  // chrome.runtime.getURL('options.html').
  try {
    const url = chrome.runtime.getURL('options.html');
    await sendMessage({ type: 'OPEN_OPTIONS_TAB', url });
  } catch (e) {
    // Fallback: try the direct API
    try {
      chrome.runtime.openOptionsPage();
    } catch (e2) {
      appendError('Cannot open settings: ' + e2.message);
    }
  }
}

async function onProviderChange() {
  const name = providerSel.value;
  await sendMessage({ type: 'SET_ACTIVE_PROVIDER', name });
  showToast(`Switched to ${prettyProviderName(name)}`, 'success');
}

async function onContextModeChange() {
  const mode = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  await sendMessage({ type: 'SET_CONTEXT_MODE', mode });
}

// --- Image attachment helpers ---

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleDroppedFiles(fileList) {
  const maxSize = 20 * 1024 * 1024; // 20 MB
  for (const f of fileList) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > maxSize) { appendError(`Image too large: ${f.name}`); continue; }
    const dataUrl = await fileToDataUrl(f);
    images.push({ dataUrl, name: f.name });
  }
  refreshImageStrip();
}

function removeImage(idx) {
  images.splice(idx, 1);
  refreshImageStrip();
}

function refreshImageStrip() {
  imagePreviewsEl.innerHTML = '';
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const div = document.createElement('div');
    div.className = 'imagepreview';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name; // textContent-safe; avoids innerHTML attribute injection

    const rmBtn = document.createElement('button');
    rmBtn.className = 'rm';
    rmBtn.title = 'Remove image';
    rmBtn.textContent = '×';
    rmBtn.addEventListener('click', () => removeImage(i));
    div.appendChild(imgEl);
    div.appendChild(rmBtn);
    imagePreviewsEl.appendChild(div);
  }
  imageInfoEl.textContent = images.length ? `+${images.length} image${images.length > 1 ? 's' : ''}` : '';
  updateComposerInfo();
}

async function onPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      imageItems.push(item.getAsFile());
    }
  }
  if (imageItems.length > 0) {
    e.preventDefault(); // don't paste file name text
    await handleDroppedFiles(imageItems);
  }
}

// --- </Image> ---

const SLASH_COMMANDS = {
  '/summarize':  'Summarize the page content in 3-5 bullet points. Be concise.',
  '/translate':  'Translate the page content to 中文 (Chinese).',
  '/rewrite':    'Rewrite the page content in a more concise and direct style. Keep all key facts.',
  '/explain':    'Explain the page content as if teaching a beginner. Use simple language.',
  '/outline':    'List the structure of the page as a nested outline (headings only).',
  '/keypoints':  'Extract the 5 most important takeaways from the page.',
  '/prompt':     '__SHOW_PROMPT__',  // special: intercepted before sending to LLM
};

function expandSlash(text) {
  if (!text.startsWith('/')) return null;
  const space = text.indexOf(' ');
  const cmd = space > 0 ? text.slice(0, space) : text;
  const rest = space > 0 ? text.slice(space + 1).trim() : '';
  const template = SLASH_COMMANDS[cmd];
  if (!template) return null; // unknown command, treat as normal text
  return rest ? `${template}\n\nAdditional instruction: ${rest}` : template;
}

async function onSend() {
  if (!currentTabId) {
    appendError('No active tab.');
    return;
  }
  const rawText = inputEl.value.trim();

  if (!rawText) return;

  // Fire-and-forget: warm up the mermaid/echarts/markmap vendor bundles now,
  // during the request/inference latency, so if this reply contains a
  // diagram it's already cached by the time DONE arrives instead of paying
  // a multi-MB cold import right when the user is waiting to see it render.
  preloadChartVendors();

  // Slash commands: expand `/summarize` etc. into full prompts. The original
  // slash text is shown in the user bubble; the expanded prompt is what the
  // LLM receives. Unknown commands pass through as-is.
  // /prompt is handled locally — show effective system prompt modal
  if (rawText.trim() === '/prompt') {
    inputEl.value = '';
    showEffectivePrompt();
    return;
  }

  const slashExpanded = expandSlash(rawText);
  const text = slashExpanded || rawText;

  // Re-read the active tab RIGHT before sending. This is the defense-in-depth
  // for SPA navigation: even if a webNavigation push was missed (background
  // service worker was sleeping, port was re-establishing, etc.), we still
  // have the right tab here. The user perceives a small extra delay
  // (<10ms in practice) but gains correctness.
  if (typeof currentTabId === 'number') {
    try {
      const live = await chrome.tabs.get(currentTabId);
      if (live) {
        pagemetaEl.textContent = live.title || live.url || '';
        pagemetaEl.href = live.url || '#';
        pagemetaEl.title = live.url || '';
        lastPageMeta = { url: live.url, title: live.title };
      }
    } catch (_) {
      // tab gone or permission denied — keep going with what we have
    }
  }

  const mode = [...ctxRadios].find((r) => r.checked)?.value || 'reader';

  // User bubble — show the original slash command, not the expanded prompt
  lastSentRaw = rawText;
  const pendingImageUrls = images.length > 0 ? images.map(i => i.dataUrl) : null;
  const userBubble = appendUser(rawText || (pendingImageUrls ? '(image)' : '(page only)'), pendingImageUrls);
  userBubble.dataset.hidx = nextHistoryIdx++;  // user turn stored in background CHAT handler
  inputEl.value = '';
  setStreamingUI(true);

  // Placeholder assistant bubble
  const assistantEl = appendAssistant('');
  let acc = '';
  let toolEvents = [];   // accumulate TOOL_PROGRESS events for post-stream history panel
  let renderStream = makeStreamRenderer(assistantEl, streamRendererOpts);
  streamStartAt = 0; // reset for tokens/sec calculation

  // Open streaming port FIRST so the background can push CHUNKs as they
  // arrive. We pass the port's name to the background via msg.port; the
  // background matches it to the connected port and pushes deltas back.
  const port = chrome.runtime.connect({ name: 'browsa-chat' });
  activeController = { port, cancelled: false, el: assistantEl, renderStream };

  // Keep the SW alive during streaming by pinging it every 20s.
  // Chrome's MV3 SW can be killed for idleness when the SSE stream goes
  // silent (e.g. while an agent is executing a tool call server-side),
  // which aborts the in-flight fetch and shows _(cancelled)_.
  let _swPingInterval = setInterval(() => {
    try { port.postMessage({ type: 'SW_PING' }); } catch (_) {}
  }, 20_000);

  // Hand the tabId to the background so it knows which port serves which tab.
  // The background stores the port in a Map keyed by tabId; when the CHAT
  // handler emits a delta, it looks up the port via this tabId.
  // We wait for an ACK before sending the CHAT message, to avoid a race
  // where the first chunk fires before the background has registered us.
  await new Promise((resolve) => {
    const ackTimeout = setTimeout(resolve, 500); // safety net
    port.onMessage.addListener(function once(m) {
      if (m.type === 'STREAM_HELLO_ACK') {
        clearTimeout(ackTimeout);
        port.onMessage.removeListener(once);
        // Re-attach the chunk listener that we just shadowed.
        attachChunkListener();
        resolve();
      }
    });
    port.postMessage({ type: 'STREAM_HELLO', tabId: currentTabId });
  });

  function attachChunkListener() {
    port.onMessage.addListener(async (m) => {
      if (m.type === 'CHUNK') {
        if (!streamStartAt) streamStartAt = Date.now(); // mark first-token time
        acc += m.delta;
        renderStream(m.delta, false); // pass delta, not accumulated text
        updateOutputTokenCount(m.delta);

      } else if (m.type === 'TOOL_PROGRESS') {
        toolEvents.push(m.text);
        showToolProgress(assistantEl, m.text);

      } else if (m.type === 'TS_STATUS') {
        // Transient status from the background's auto timestamp-rewrite
        // (video notes whose first reply lacked [mm:ss]). Shown like
        // tool-progress but NOT recorded into toolEvents, so DONE's
        // renderToolHistory won't render it as a tool event; DONE's
        // existing clearToolProgress removes it.
        showToolProgress(assistantEl, m.text, 'warn');

      } else if (m.type === 'APPROVAL') {
        showApprovalCard(assistantEl, m.data);

      } else if (m.type === 'CLARIFY') {
        showClarifyCard(assistantEl, m.data);

      } else if (m.type === 'RETRY') {
        // Background is retrying. Reset accumulator and renderer so the bubble
        // shows only the new attempt's content, not stale content from the failed one.
        acc = '';
        toolEvents = [];
        outputTokens = 0;
        // Remove any stale live-think block from the previous attempt.
        // thinkEl is inserted BEFORE assistantEl (as a sibling), so innerHTML='' won't catch it.
        const prevSib = assistantEl.previousElementSibling;
        if (prevSib?.classList.contains('live-think')) prevSib.remove();
        assistantEl.innerHTML = '';
        renderStream.destroy?.(); // stop the abandoned attempt's paced reveal
        renderStream = makeStreamRenderer(assistantEl, streamRendererOpts);
        if (activeController) activeController.renderStream = renderStream;
        showToolProgress(assistantEl, `⟳ Retrying… (attempt ${m.attempt}/${m.maxAttempts})`, 'warn');

      } else if (m.type === 'DONE') {
        clearToolProgress(assistantEl);
        _findCard(assistantEl, 'approval-card')?.remove();
        _findCard(assistantEl, 'clarify-card')?.remove();
        if (toolEvents.length > 0) {
          renderToolHistory(assistantEl, toolEvents);
          toolEvents = [];
        }
        const finalText = m.full || acc;
        assistantEl.dataset.hidx = nextHistoryIdx++; // assistant turn stored in background
        await renderStream(finalText, true);
        // linkifyTimestamps already ran inside renderStream's isDone path;
        // stamp the video source (carried in the DONE chunk by the chat
        // handler) so the clickable [mm:ss] markers know which tab/URL to seek.
        if (m.videoSrc) assistantEl.dataset.videoSrc = JSON.stringify(m.videoSrc);
        addCodeCopyButtons();
        renderMermaid(assistantEl); renderEcharts(assistantEl); renderMarkmap(assistantEl);
        outputTokens = 0;
        // Show token usage if the provider returned it
        if (m.usage) showTokenUsage(assistantEl, m.usage);
        if (m.choiceRequest) renderChoiceRequest(assistantEl, m.choiceRequest);
        // Detect max-turns: agent hit the tool-call ceiling and is asking
        // the user to continue. Show a one-click Continue button.
        if (/reached.*max.*turns|maximum.*turns|max_turns|已达上限|工具调用.*上限|继续.*完成/i.test(finalText)) {
          appendMsgAction(assistantEl, '→ 继续', () => { inputEl.value = '继续'; onSend(); });
        }
        clearInterval(_swPingInterval);
        try { port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
        try { port.disconnect(); } catch (_) {}
        // port.disconnect() does NOT fire this side's own onDisconnect listener
        // (only the other end's), so activeController must be cleared here —
        // otherwise it stays set until the async round trip settles, and a
        // Send click in that window is misrouted to cancelStream() instead.
        activeController = null;
        sendMessage({ type: 'STREAM_RELEASE', tabId: currentTabId }).catch(() => {});
        reconcileHistoryIdx(); // detect + correct auto-trim drift (fire-and-forget)
      } else if (m.type === 'ERROR') {
        // Only ABORTED reaches here — real errors are re-thrown by background
        // and handled via the !res.ok block below (no pushChunk for real errors).
        clearInterval(_swPingInterval);
        if (m.code === 'ABORTED') {
          await renderStream(acc ? acc + '\n\n_(cancelled)_' : '_(cancelled)_', true);
        }
      }
    });
  }
  port.onDisconnect.addListener(() => {
    clearInterval(_swPingInterval);
    setStreamingUI(false);
    activeController = null;
    if (acc === '' && assistantEl.textContent === '▍') {
      // No chunks received AND the assistant bubble still shows the
      // placeholder. The background reported an error before any delta
      // was emitted. Show a clear hint.
      assistantEl.textContent = '(no chunks received — check Service Worker DevTools)';
    }
  });

  try {
    const imageDataUrls = images.length > 0 ? images.map(i => i.dataUrl) : null;
    // Clear thumbnails immediately — the LLM may take seconds to respond
    images.length = 0;
    refreshImageStrip();

    const res = await sendMessage({
      type: 'CHAT',
      tabId: currentTabId,
      userText: text,
      stream: true,
      portName: 'browsa-chat',
      images: imageDataUrls
    });
    if (!res.ok) {
      // Real error (re-thrown by background, port receives nothing).
      // Preserve any partial streaming content; append the error inline.
      const errMsg = res.error || 'Unknown error';
      if (acc) {
        await renderStream(acc + `\n\n---\n❌ **${errMsg}**`, true);
      } else {
        assistantEl.textContent = `❌ ${errMsg}`;
      }
      appendMsgAction(assistantEl, '重试', () => {
        if (lastSentRaw) { inputEl.value = lastSentRaw; onSend(); }
      }, ICONS.retry);
      if (res.hint) appendSystem(res.hint);
      // Resync counter — user turn may or may not have been stored.
      reconcileHistoryIdx();
    }
  } catch (e) {
    // sendMessage itself threw (SW restart, no receiver, etc.).
    // The CHAT handler never ran, so the user turn was likely NOT stored.
    if (acc) {
      await renderStream(acc + `\n\n---\n❌ **${e.message}**`, true);
    } else {
      assistantEl.textContent = `❌ ${e.message}`;
    }
    appendMsgAction(assistantEl, '重试', () => {
      if (lastSentRaw) { inputEl.value = lastSentRaw; onSend(); }
    }, ICONS.retry);
    reconcileHistoryIdx();
  } finally {
    setStreamingUI(false);
  }
}

// Re-attach a streaming port for a tab whose LLM reply is still in
// flight on the background. Called on:
//   - init() after history is rendered (catches the case where the
//     user just opened the side panel during a stream)
//   - chrome.tabs.onActivated when the user switches back to a tab
//     that had an active stream when the panel was torn down.
//
// The background's STREAM_HELLO handler will drain any accumulated
// reply text into our new port as one synthetic CHUNK, so we rehydrate
// the assistant bubble from the same starting state the old panel had,
// then continue receiving live deltas through the same listener.
// Without this, the panel would only ever see storage (which doesn't
// update until the reply is DONE) and would sit on an empty bubble
// for the entire duration of a slow reply.
async function resumeInFlightStream(tabId) {
  if (tabId == null) return;
  // If this panel session is already the owner of an in-flight stream,
  // don't open a second port. This can happen if onActivated fires
  // before the panel's own onSend's port fully wired up.
  if (activeController && activeController.tabId === tabId && !activeController.cancelled) {
    return;
  }
  // Ask the background: is there a stream for this tab, and if so,
  // what do you have so far?
  const peek = await sendMessage({ type: 'STREAM_PEEK', tabId });
  if (!peek?.inFlight) {
    // No stream running. The "switch tab and come back" path lands
    // here for the common case where the stream finished while the
    // user was away — storage already has the reply, renderHistory
    // (called by onActivated / init) has shown it. Nothing to do.
    return;
  }
  // Seed streamStartAt from the real stream origin so tokens/sec in
  // showTokenUsage() reflects total stream duration, not just the
  // post-resume portion.
  streamStartAt = peek.startedAt || Date.now();
  // From here, the background is still streaming. The DOM is whatever
  // the previous panel session left behind (or just renderHistory()
  // output if the panel was opened fresh). We need to:
  //   1. Open a new browsa-chat port
  //   2. STREAM_PEEK gave us the accumulated text already — pre-render
  //      it into an assistant bubble so the user sees something
  //      immediately (not just "▍" for seconds).
  //   3. HELLO the background so it knows our port is the new owner
  //   4. Wire the chunk listener for any deltas that arrive from now on
  //   5. Re-resolve the assistant bubble on every chunk because the
  //      DOM node identity can change (innerHTML restore in
  //      onActivated replaces the whole subtree).
  const port = chrome.runtime.connect({ name: 'browsa-chat' });
  // Same SW keep-alive as the onSend path — resumed streams face identical risk.
  let _swPingInterval = setInterval(() => {
    try { port.postMessage({ type: 'SW_PING' }); } catch (_) {}
  }, 20_000);
  let acc = peek.acc || '';
  let resumedToolEvents = [];
  const initialBubble = getOrCreateAssistantBubble();
  let renderStream = makeStreamRenderer(initialBubble, streamRendererOpts);
  let assistantEl = initialBubble;
  function getOrCreateAssistantBubble() {
    let el = messagesEl.querySelector('.msg.assistant:last-of-type');
    if (!el) el = appendAssistant('');
    return el;
  }
  function ensureAssistantEl() {
    // The DOM node identity may have changed (innerHTML restore
    // replaces the whole subtree). Re-resolve on every chunk.
    let el = messagesEl.querySelector('.msg.assistant:last-of-type');
    if (!el) el = appendAssistant('');
    if (el !== assistantEl) {
      // Switch the stream renderer's target. makeStreamRenderer
      // holds a closure over the original el — that one's renderStream
      // function is now stale. Build a new renderer for the fresh el.
      assistantEl = el;
      renderStream.destroy?.(); // stop the stale-el renderer's paced reveal
      renderStream = makeStreamRenderer(el, streamRendererOpts);
      if (activeController) { activeController.el = assistantEl; activeController.renderStream = renderStream; }
    }
    return renderStream;
  }
  // Pre-render the accumulated text from the PEEK. This is the only
  // place this initial text is rendered — the background's STREAM_HELLO
  // does NOT push a drain chunk (see background.js for why). Subsequent
  // CHUNKs are pure new deltas; acc += m.delta in the listener is
  // correct because we start acc at peek.acc, not at ''.
  if (acc) renderStream(acc, false);
  // HELLO the background so it knows this port owns the stream now.
  // Wait for ACK so any in-flight delta that's about to fire from the
  // LLM (after the PEEK/HELLO race window) goes to a port that's
  // already wired with a listener.
  await new Promise((resolve) => {
    const ackTimeout = setTimeout(resolve, 500);
    port.onMessage.addListener(function once(m) {
      if (m.type === 'STREAM_HELLO_ACK') {
        clearTimeout(ackTimeout);
        port.onMessage.removeListener(once);
        resolve();
      }
    });
    port.postMessage({ type: 'STREAM_HELLO', tabId });
  });
  port.onMessage.addListener(async (m) => {
    if (m.type === 'CHUNK') {
      const r = ensureAssistantEl();
      acc += m.delta;
      r(m.delta, false); // pass delta, not accumulated text
      updateOutputTokenCount(m.delta);

    } else if (m.type === 'TOOL_PROGRESS') {
      resumedToolEvents.push(m.text);
      showToolProgress(assistantEl, m.text);

    } else if (m.type === 'TS_STATUS') {
      // Mirrors the onSend listener: transient timestamp-rewrite status,
      // shown but not recorded into resumedToolEvents.
      showToolProgress(assistantEl, m.text, 'warn');

    } else if (m.type === 'APPROVAL') {
      showApprovalCard(assistantEl, m.data);

    } else if (m.type === 'CLARIFY') {
      showClarifyCard(assistantEl, m.data);

    } else if (m.type === 'RETRY') {
      showToolProgress(assistantEl, `⟳ Retrying… (attempt ${m.attempt}/${m.maxAttempts})`, 'warn');

    } else if (m.type === 'DONE') {
      const r = ensureAssistantEl();
      clearToolProgress(assistantEl);
      _findCard(assistantEl, 'approval-card')?.remove();
      _findCard(assistantEl, 'clarify-card')?.remove();
      if (resumedToolEvents.length > 0) {
        renderToolHistory(assistantEl, resumedToolEvents);
        resumedToolEvents = [];
      }
      assistantEl.dataset.hidx = nextHistoryIdx++; // assistant turn stored in background
      await r(m.full || acc, true);
      addCodeCopyButtons();
      renderMermaid(assistantEl); renderEcharts(assistantEl); renderMarkmap(assistantEl);
      outputTokens = 0;
      if (m.usage) showTokenUsage(assistantEl, m.usage);

      clearInterval(_swPingInterval);
      try { port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
      try { port.disconnect(); } catch (_) {}
      sendMessage({ type: 'STREAM_RELEASE', tabId }).catch(() => {});
      activeController = null;
      setStreamingUI(false);
      reconcileHistoryIdx();
    } else if (m.type === 'ERROR') {
      // Only ABORTED reaches here (same reasoning as onSend path).
      clearInterval(_swPingInterval);
      const el = messagesEl.querySelector('.msg.assistant:last-of-type') || appendAssistant('');
      if (m.code === 'ABORTED') {
        el.textContent = acc ? acc + '\n\n_(cancelled)_' : '_(cancelled)_';
      }
      try { port.disconnect(); } catch (_) {}
    }
  });
  port.onDisconnect.addListener(() => {
    clearInterval(_swPingInterval);
    setStreamingUI(false);
    // If the port died with no chunks at all, show the same hint as
    // onSend (the user has nothing to look at otherwise).
    const el = messagesEl.querySelector('.msg.assistant:last-of-type');
    if (acc === '' && el && el.textContent === '▍') {
      el.textContent = '(no chunks received — check Service Worker DevTools)';
    }
  });
  // Track this stream on the activeController slot so Esc-to-cancel
  // and the early-return guard above work. cancelled is false (this
  // is a resume, not a user-initiated stream). If the user hits Esc
  // during a resumed stream, cancelStream() disconnects the port and
  // sends STREAM_RELEASE; the background keeps streaming but no chunks
  // reach us, and PEEK stops returning in-flight. Reasonable trade-off
  // for v0.20.4; v0.20.5 will plumb an AbortController through.
  activeController = { port, cancelled: false, tabId, resumed: true, el: assistantEl, renderStream };
}

/**
 * Show a full-panel crop UI over the sidepanel.
 * The user can drag to select a rectangular region or use the full image.
 * onConfirm(dataUrl) is called with the final (possibly cropped) JPEG data URL.
 */
function showScreenshotCropUI({ imageDataUrl, metaUrl, metaTitle }, onConfirm) {
  const modal = document.createElement('div');
  modal.className = 'crop-modal';

  modal.innerHTML = `
    <div class="crop-header">
      <span class="crop-hint">拖动选择区域</span>
      <div class="crop-actions">
        <button class="crop-cancel">取消</button>
        <button class="crop-use-full">使用完整截图</button>
        <button class="crop-confirm" disabled>裁剪并使用</button>
      </div>
    </div>
    <div class="crop-body">
      <canvas class="crop-canvas"></canvas>
    </div>
  `;
  document.body.appendChild(modal);

  const canvas   = modal.querySelector('.crop-canvas');
  const body     = modal.querySelector('.crop-body');
  const confirmBtn = modal.querySelector('.crop-confirm');
  const fullBtn  = modal.querySelector('.crop-use-full');
  const cancelBtn = modal.querySelector('.crop-cancel');

  const img = new Image();
  img.onload = () => {
    // Scale image to fit the crop body area
    const maxW = body.clientWidth  || 380;
    const maxH = body.clientHeight || 480;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    canvas.width  = Math.round(img.naturalWidth  * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx2d = canvas.getContext('2d');

    function redraw(sel) {
      ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (!sel || sel.w < 2 || sel.h < 2) return;
      // dim outside selection
      ctx2d.fillStyle = 'rgba(0,0,0,0.5)';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      // clear selection hole + redraw image inside
      ctx2d.clearRect(sel.x, sel.y, sel.w, sel.h);
      ctx2d.drawImage(img,
        sel.x / scale, sel.y / scale, sel.w / scale, sel.h / scale,
        sel.x, sel.y, sel.w, sel.h);
      // selection border
      ctx2d.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx2d.lineWidth = 1.5;
      ctx2d.strokeRect(sel.x + 0.75, sel.y + 0.75, sel.w - 1.5, sel.h - 1.5);
      // corner handles
      const hs = 6;
      ctx2d.fillStyle = '#fff';
      [[sel.x, sel.y], [sel.x + sel.w, sel.y],
       [sel.x, sel.y + sel.h], [sel.x + sel.w, sel.y + sel.h]].forEach(([hx, hy]) => {
        ctx2d.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      });
    }
    redraw(null);

    let startX = 0, startY = 0, dragging = false, selection = null;

    canvas.addEventListener('mousedown', (e) => {
      const r = canvas.getBoundingClientRect();
      startX = e.clientX - r.left;
      startY = e.clientY - r.top;
      dragging = true;
      selection = null;
      confirmBtn.disabled = true;
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      const cx = Math.max(0, Math.min(canvas.width,  e.clientX - r.left));
      const cy = Math.max(0, Math.min(canvas.height, e.clientY - r.top));
      selection = {
        x: Math.round(Math.min(startX, cx)),
        y: Math.round(Math.min(startY, cy)),
        w: Math.round(Math.abs(cx - startX)),
        h: Math.round(Math.abs(cy - startY)),
      };
      redraw(selection);
    });
    canvas.addEventListener('mouseup', () => {
      dragging = false;
      if (selection && selection.w > 5 && selection.h > 5) {
        confirmBtn.disabled = false;
      } else {
        selection = null;
        redraw(null);
      }
    });

    function close() { modal.remove(); }

    cancelBtn.addEventListener('click', close);

    fullBtn.addEventListener('click', () => {
      close();
      onConfirm(imageDataUrl);
    });

    confirmBtn.addEventListener('click', () => {
      if (!selection || selection.w < 2 || selection.h < 2) return;
      // Crop at original resolution
      const oc = document.createElement('canvas');
      oc.width  = Math.round(selection.w / scale);
      oc.height = Math.round(selection.h / scale);
      oc.getContext('2d').drawImage(img,
        selection.x / scale, selection.y / scale,
        oc.width, oc.height,
        0, 0, oc.width, oc.height);
      close();
      onConfirm(oc.toDataURL('image/jpeg', 0.85));
    });
  };
  img.src = imageDataUrl;
}

function appendUser(text, imageDataUrls) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.dataset.raw = text;
  if (imageDataUrls?.length) {
    const strip = document.createElement('div');
    strip.className = 'msg-images';
    for (const url of imageDataUrls) {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'msg-image';
      img.alt = 'attached image';
      strip.appendChild(img);
    }
    el.appendChild(strip);
  }
  const span = document.createElement('span');
  span.className = 'msg-text';
  span.textContent = text;
  el.appendChild(span);
  addTimestamp(el);
  addMsgActions(el, () => el.dataset.raw || text);
  messagesEl.appendChild(el);
  scrollToBottom(true);
  return el;
}
// Click a [mm:ss] marker in a video-note reply -> seek the source video tab's
// <video> in place; fall back to opening the original video at ?t=N when the
// tab is gone or has no <video> (user closed/navigated away from it).
async function onTimestampClick(ts) {
  const seconds = Number(ts.dataset.s) || 0;
  const msgEl = ts.closest('.msg');
  let vs = null;
  try { vs = msgEl ? JSON.parse(msgEl.dataset.videoSrc || 'null') : null; } catch (_) {}
  if (vs?.tabId) {
    try {
      const res = await sendMessage({ type: 'SEEK_VIDEO', tabId: vs.tabId, seconds });
      if (res?.ok) return;
    } catch (_) {}
  }
  if (vs?.url) {
    chrome.tabs.create({ url: appendTimeParam(vs.url, seconds) });
  } else {
    showToast('视频源已失效，无法跳转');
  }
}

// Append/replace a seek-to-time param on a video URL. YouTube (watch?v=…&t=N)
// and Bilibili (video/BV…?t=N) both accept a bare integer seconds value.
function appendTimeParam(url, seconds) {
  try {
    const u = new URL(url);
    u.searchParams.set('t', String(seconds));
    return u.toString();
  } catch (_) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}t=${seconds}`;
  }
}

function appendAssistant(initial, done = false) {
  const el = document.createElement('div');
  el.className = 'msg assistant' + (done ? ' done' : '');
  el.textContent = initial;
  addTimestamp(el);
  // Actions are added by the caller once raw markdown content is available.
  messagesEl.appendChild(el);
  scrollToBottom(true);
  return el;
}

/**
 * Add a hoverable action bar (reply + delete) to a message bubble.
 * getRaw() must return the original un-rendered text (raw markdown for
 * assistant, plain text for user) — used for history content matching.
 */
function addMsgActions(el, getRaw) {
  if (el.querySelector('.msg-actions')) return; // idempotent
  const wrap = document.createElement('div');
  wrap.className = 'msg-actions';

  // Reply / quote
  const replyBtn = document.createElement('button');
  replyBtn.className = 'msg-action-icon';
  replyBtn.title = 'Quote';
  replyBtn.innerHTML = ICONS.reply;
  replyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const raw = (getRaw() || '').trim();
    if (!raw) return;
    const preview = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
    const quoted = preview.split('\n').map(l => `> ${l}`).join('\n');
    inputEl.value = quoted + '\n\n' + inputEl.value;
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
  });

  // Delete
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-action-icon delete-icon';
  delBtn.title = 'Delete message';
  delBtn.innerHTML = ICONS.trash;
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Serialise: ignore rapid concurrent clicks to prevent index races.
    if (deleteLock) return;
    deleteLock = true;
    const idx = parseInt(el.dataset.hidx, 10);
    el.remove(); // optimistic DOM removal
    try {
      if (!isNaN(idx)) {
        const res = await sendMessage({ type: 'REMOVE_HISTORY_ENTRY_BY_INDEX', index: idx }).catch(() => null);
        if (res?.ok) {
          // Confirmed: shift indices of all remaining bubbles after the deleted slot.
          messagesEl.querySelectorAll('[data-hidx]').forEach(b => {
            const bidx = parseInt(b.dataset.hidx, 10);
            if (bidx > idx) b.dataset.hidx = bidx - 1;
          });
          nextHistoryIdx--;
        } else {
          // Removal failed (index out of range or storage error) — resync.
          reconcileHistoryIdx();
        }
      }
    } finally {
      deleteLock = false;
    }
  });

  const buttons = [replyBtn, delBtn];

  // Edit — only for user messages
  if (el.classList.contains('user')) {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-icon';
    editBtn.title = 'Edit & resend';
    editBtn.innerHTML = ICONS.edit;
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startMsgEdit(el);
    });
    buttons.push(editBtn);
  }

  // Copy — only for assistant messages
  if (el.classList.contains('assistant')) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-icon copy-icon';
    copyBtn.title = 'Copy response';
    copyBtn.innerHTML = ICONS.copy;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = getRaw() || el.innerText || '';
      try {
        await _copyText(text);
        copyBtn.textContent = '✓';
        showToast('Copied', 'success');
        setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 2000);
      } catch (_) {
        copyBtn.textContent = '✗';
        setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1500);
      }
    });
    buttons.push(copyBtn);

    // Collapse/expand — manual, per-message, purely visual (never persisted
    // to history/storage; resets on reload/session-switch since renderHistory
    // rebuilds the DOM fresh each time). No auto-length heuristic: the user
    // decides which long replies to fold, so there's no "how long is long"
    // guessing to get wrong.
    const foldBtn = document.createElement('button');
    foldBtn.className = 'msg-action-icon fold-btn';
    foldBtn.title = 'Collapse/expand';
    foldBtn.innerHTML = ICONS.chevron;
    foldBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.toggle('collapsed');
    });
    buttons.push(foldBtn);
  }

  wrap.append(...buttons);
  el.appendChild(wrap);
}

/**
 * Put a user bubble into edit mode: replace the text span with a textarea.
 * On save: update history in background, then re-run CHAT from that point.
 */
function startMsgEdit(el) {
  if (el.querySelector('.msg-edit-textarea')) return; // already editing
  const msgText = el.querySelector('.msg-text');
  if (!msgText) return;
  const originalText = el.dataset.raw || msgText.textContent;

  // Hide the text span (don't remove — keeps layout stable)
  const textarea = document.createElement('textarea');
  textarea.className = 'msg-edit-textarea';
  textarea.value = originalText;

  const bar = document.createElement('div');
  bar.className = 'msg-edit-bar';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'msg-edit-save';
  saveBtn.textContent = 'Send';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'msg-edit-cancel';
  cancelBtn.textContent = 'Cancel';

  bar.append(saveBtn, cancelBtn);

  msgText.replaceWith(textarea);
  el.appendChild(bar);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

  cancelBtn.addEventListener('click', () => {
    textarea.replaceWith(msgText);
    bar.remove();
  });

  saveBtn.addEventListener('click', async () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    // Update the bubble
    el.dataset.raw = newText;
    const newSpan = document.createElement('span');
    newSpan.className = 'msg-text';
    newSpan.textContent = newText;
    textarea.replaceWith(newSpan);
    bar.remove();

    const idx = parseInt(el.dataset.hidx, 10);
    if (!isNaN(idx)) {
      // Cancel any in-flight stream before truncating history — otherwise
      // the old port's CHUNK/DONE events would land on the new turn and
      // corrupt history indices.
      if (activeController && !activeController.cancelled) cancelStream();
      // Truncate history from this point onward, then re-send
      await sendMessage({ type: 'TRUNCATE_HISTORY_FROM_INDEX', index: idx }).catch(() => null);
      // Remove all DOM bubbles after this one (assistant reply + any following)
      let sib = el.nextElementSibling;
      while (sib) {
        const next = sib.nextElementSibling;
        sib.remove();
        sib = next;
      }
      nextHistoryIdx = idx; // will be re-assigned when CHAT handler stores new turns
    }
    // Re-send as new turn
    lastSentRaw = newText;
    inputEl.value = newText;
    onSend();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
    if (e.key === 'Escape') cancelBtn.click();
  });
}

// Classify tool-progress text into a visual tier (icon + CSS hook) so the
// user can tell at a glance whether the agent is thinking, running a tool,
// or waiting — mirrors personal_ai_assistant's event-type display. Shared by
// showToolProgress (live) and renderToolHistory (folded, post-hoc) so the
// classification regexes only live in one place.
function classifyToolTier(text) {
  const t = text.toLowerCase();
  if (/think|reason|analyz|consid/.test(t))           return { tier: 'thinking',  icon: ICONS.think };
  if (/search|fetch|web|http|url/.test(t))            return { tier: 'searching', icon: ICONS.search };
  if (/read|open|load|file|path/.test(t))             return { tier: 'reading',   icon: ICONS.book };
  if (/write|edit|creat|sav|updat/.test(t))           return { tier: 'writing',   icon: ICONS.edit };
  if (/run|exec|bash|shell|cmd|command/.test(t))      return { tier: 'running',   icon: ICONS.terminal };
  return { tier: '', icon: ICONS.gear };
}

/** Show a faint "tool progress" line above a streaming bubble, alongside thinking. */
function showToolProgress(bubbleEl, text, tierOverride) {
  if (!bubbleEl) return;
  // Positioned before the bubble (grouped with the live-think box, which
  // uses the same insertBefore pattern in render.js's ensureThinkEl()) so
  // "process" indicators (thinking, tool calls) sit together above the
  // final answer, instead of thinking above and tool-progress below.
  // Whichever of {thinkEl, tool-progress} was most recently created/updated
  // ends up closest to the bubble — not a full arrival-order timeline, but
  // a reasonable approximation without redesigning the streaming DOM
  // structure (tool-progress events have no position info the way <think>
  // tags carry their own position in the reply markdown).
  let el = bubbleEl.previousElementSibling;
  if (!el || !el.classList.contains('tool-progress')) {
    el = document.createElement('div');
    el.className = 'tool-progress';
    bubbleEl.parentNode.insertBefore(el, bubbleEl);
  }
  const { tier, icon } = tierOverride ? { tier: tierOverride, icon: ICONS.gear } : classifyToolTier(text);
  el.dataset.tier = tier;
  el.innerHTML = `<span class="tp-icon">${icon}</span><span class="tp-text">${escM(text)}</span>`;
}
/** Remove the tool progress indicator once the reply is done. */
function clearToolProgress(bubbleEl) {
  const el = bubbleEl?.previousElementSibling;
  if (el?.classList.contains('tool-progress')) el.remove();
}

/**
 * Show an approval request card below the streaming bubble.
 * The agent has paused and needs the user to allow/deny a dangerous action.
 */
function showApprovalCard(bubbleEl, data) {
  _findCard(bubbleEl, 'approval-card')?.remove();
  const card = document.createElement('div');
  card.className = 'approval-card';
  const tool = escM(data.tool || data.function_name || 'unknown');
  const cmd  = data.command ? `<div class="approval-cmd"><code>${escM(data.command)}</code></div>` : '';
  const desc = data.description ? `<div class="approval-desc">${escM(data.description)}</div>` : '';
  const risk = String(data.risk_level || 'high').toLowerCase();
  const choices = Array.isArray(data.choices) && data.choices.length ? data.choices : ['once', 'deny'];
  const btnLabels = { once: 'Allow once', session: 'Allow for session', always: 'Always allow', deny: 'Deny' };
  const btns = choices.map(c => {
    const label = btnLabels[c] || c;
    const cls   = c === 'deny' ? 'approval-btn-deny' : 'approval-btn-allow';
    return `<button class="approval-btn ${cls}" data-choice="${escM(c)}">${escM(label)}</button>`;
  }).join('');
  card.innerHTML =
    `<div class="approval-header">` +
      `<span class="approval-icon">⚠️</span>` +
      `<span class="approval-title">Approval required: <strong>${tool}</strong></span>` +
      `<span class="approval-risk approval-risk-${escM(risk)}">${escM(risk)}</span>` +
    `</div>` +
    cmd + desc +
    `<div class="approval-actions">${btns}</div>`;
  card.querySelectorAll('.approval-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sendMessage({ type: 'APPROVAL_RESPOND', tabId: currentTabId, choice: btn.dataset.choice });
      card.remove();
    });
  });
  _insertCard(bubbleEl, card);
}

/** Show an agent clarification question card below the streaming bubble. */
function showClarifyCard(bubbleEl, data) {
  _findCard(bubbleEl, 'clarify-card')?.remove();
  const card = document.createElement('div');
  card.className = 'clarify-card';
  const question = escM(data.question || data.text || 'Please clarify:');
  card.innerHTML =
    `<div class="clarify-question">${question}</div>` +
    `<div class="clarify-input-row">` +
      `<input type="text" class="clarify-input" placeholder="Your response…" />` +
      `<button class="clarify-submit">Send</button>` +
    `</div>`;
  const input  = card.querySelector('.clarify-input');
  const submit = card.querySelector('.clarify-submit');
  const respond = () => {
    const response = input.value.trim();
    if (!response) return;
    sendMessage({ type: 'CLARIFY_RESPOND', tabId: currentTabId, response });
    card.remove();
  };
  submit.addEventListener('click', respond);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') respond(); });
  _insertCard(bubbleEl, card);
  setTimeout(() => input.focus(), 50);
}

/**
 * Show a small token usage chip below the assistant bubble.
 * usage = { prompt_tokens, completion_tokens, total_tokens }
 * For Hermes /v1/responses: may use input_tokens / output_tokens field names.
 */
function showTokenUsage(bubbleEl, usage) {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? null;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? null;
  if (prompt == null && completion == null) return;
  // Deduplicate: remove any existing token-usage chip for this bubble
  bubbleEl.nextElementSibling?.classList.contains('token-usage') &&
    bubbleEl.nextElementSibling.remove();

  // Tokens/sec: calculated from streamStartAt set when first CHUNK arrived
  const durationMs = streamStartAt ? Date.now() - streamStartAt : 0;
  const tps = (durationMs > 200 && completion > 0)
    ? Math.round(completion / (durationMs / 1000)) : 0;
  const durationSec = durationMs > 0 ? (durationMs / 1000).toFixed(1) : null;

  const el = document.createElement('div');
  el.className = 'token-usage';
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const parts = [];
  if (prompt != null) parts.push(`↑ ${fmtK(prompt)}`);
  if (completion != null) parts.push(`↓ ${fmtK(completion)}`);
  if (tps > 0) parts.push(`${tps} t/s`);
  if (durationSec) parts.push(`${durationSec}s`);
  el.textContent = parts.join(' · ');
  el.title = `Prompt: ${prompt ?? '?'} · Completion: ${completion ?? '?'}` +
             (usage.total_tokens ? ` · Total: ${usage.total_tokens}` : '') +
             (tps ? ` · ${tps} tok/s` : '') +
             (durationMs ? ` · ${(durationMs/1000).toFixed(2)}s` : '');

  bubbleEl.insertAdjacentElement('afterend', el);

  streamStartAt = 0; // reset for next turn
}

function appendScreenshot(dataUrl) {
  const el = document.createElement('div');
  el.className = 'msg screenshot-preview';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Screenshot';
  img.title = 'Click to open full size';
  img.addEventListener('click', () => window.open(dataUrl));
  el.appendChild(img);
  messagesEl.appendChild(el);
  scrollToBottom(true);
  return el;
}
function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom(true);
  return el;
}

function appendAttachSystem(text, relatedEl) {
  const el = document.createElement('div');
  el.className = 'msg system attach-msg';
  const span = document.createElement('span');
  span.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'undo-attach';
  btn.textContent = '撤销';
  btn.title = '从会话中移除此次附加的页面内容';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const res = await sendMessage({ type: 'UNDO_ATTACH' }).catch(() => null);
    if (res?.ok) {
      const removedIdx = res.removedIdx ?? -1;
      if (removedIdx >= 0) {
        // Shift data-hidx on every DOM bubble that came after the removed entry.
        messagesEl.querySelectorAll('[data-hidx]').forEach(b => {
          const bidx = parseInt(b.dataset.hidx, 10);
          if (bidx > removedIdx) b.dataset.hidx = bidx - 1;
        });
      }
      nextHistoryIdx--;
      span.textContent = text + '（已撤销）';
      span.style.opacity = '0.45';
      btn.remove();
      // The undone attachment (e.g. the screenshot preview bubble) must
      // disappear too — leaving it visible after "撤销" reads as if the
      // undo only touched the label text, not the actual attached content.
      relatedEl?.remove();
    } else {
      btn.disabled = false;
    }
  });
  el.appendChild(span);
  el.appendChild(btn);
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

/**
 * After streaming ends, render accumulated tool-call events as a collapsible
 * <details> panel *above* the assistant bubble — mirrors personal_ai_assistant's
 * "completed events → folded panels" pattern.
 */
function renderToolHistory(bubbleEl, events) {
  if (!events.length) return;
  const details = document.createElement('details');
  details.className = 'tool-history';
  const summary = document.createElement('summary');
  summary.innerHTML = `${ICONS.gear} ${events.length} step${events.length > 1 ? 's' : ''}`;
  details.appendChild(summary);
  const ul = document.createElement('ul');
  for (const ev of events) {
    const li = document.createElement('li');
    // Re-use the same icon classification as showToolProgress
    const { icon } = classifyToolTier(ev);
    li.innerHTML = `${icon} ${escM(ev)}`;
    ul.appendChild(li);
  }
  details.appendChild(ul);
  bubbleEl.insertAdjacentElement('beforebegin', details);
}

/**
 * Render CHOICE_REQUEST interactive buttons after the assistant bubble.
 * The agent outputs: CHOICE_REQUEST:{"question":"...","choices":["A","B"]}
 */
function renderChoiceRequest(bubbleEl, req) {
  const { question, choices } = req || {};
  if (!Array.isArray(choices) || !choices.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'choice-request';
  if (question) {
    const q = document.createElement('p');
    q.className = 'choice-question';
    q.textContent = question;
    wrap.appendChild(q);
  }
  const row = document.createElement('div');
  row.className = 'choice-buttons';
  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = choice;
    btn.addEventListener('click', () => {
      wrap.remove();
      inputEl.value = choice;
      onSend();
    });
    row.appendChild(btn);
  }
  wrap.appendChild(row);
  bubbleEl.insertAdjacentElement('afterend', wrap);
}

/** Append a small action button row directly after a message bubble. */
function appendMsgAction(bubbleEl, label, onClick, icon) {
  // Remove any existing action row on this bubble first (avoid stacking).
  bubbleEl.nextElementSibling?.classList.contains('msg-action-row') &&
    bubbleEl.nextElementSibling.remove();
  const row = document.createElement('div');
  row.className = 'msg-action-row';
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  btn.innerHTML = (icon || '') + `<span>${escM(label)}</span>`;
  btn.addEventListener('click', () => { row.remove(); onClick(); });
  row.appendChild(btn);
  bubbleEl.insertAdjacentElement('afterend', row);
}

function appendError(text) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = '⚠ ' + text;
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

// force=true: always scroll (user action, new message).
// force=false (default): respect user scroll position during streaming.
function scrollToBottom(force = false) {
  if (force || !isUserScrolledUp) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (scrollToBottomBtn) { scrollToBottomBtn.hidden = true; scrollToBottomBtn.classList.remove('has-new'); }
    isUserScrolledUp = false;
  }
}

// ─── Effective system prompt inspector (/prompt command) ─────────────────────
async function showEffectivePrompt() {
  const cfg = await chrome.storage.local.get(null);
  const tabUrl = lastPageMeta?.url || '';

  // Replicate the same logic as background.js buildEffectivePrompt
  const base = cfg.systemPrompt || '';
  const domainRules = cfg.domainRules || [];
  const matchedRule = domainRules.find(r => r.pattern && tabUrl.includes(r.pattern));
  const domainExtra = matchedRule ? `[Domain rule for "${matchedRule.pattern}"]\n${matchedRule.prompt}` : '';
  const langMap = { en: 'Please always respond in English.', zh: '请始终用中文回答。', ja: '常に日本語で回答してください。', ko: '항상 한국어로 답변해 주세요.', de: 'Bitte antworte immer auf Deutsch.', fr: 'Veuillez toujours répondre en français.', es: 'Por favor, responde siempre en español.' };
  const langExtra = langMap[cfg.replyLanguage] || '';

  const sections = [
    base && { label: 'Base system prompt', text: base },
    domainExtra && { label: `Domain rule (${matchedRule.pattern})`, text: matchedRule.prompt },
    langExtra && { label: 'Language instruction', text: langExtra },
  ].filter(Boolean);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const modal = document.createElement('div');
  modal.className = 'prompt-inspector-modal';
  // Build modal with safe DOM APIs (textContent) to avoid XSS from user-configured prompts
  const titleEl = document.createElement('div');
  titleEl.className = 'confirm-title';
  titleEl.textContent = 'Effective System Prompt';
  const urlEl = document.createElement('div');
  urlEl.className = 'prompt-inspector-url';
  urlEl.textContent = tabUrl || '(no page)';
  modal.appendChild(titleEl);
  modal.appendChild(urlEl);
  if (sections.length) {
    for (const s of sections) {
      const labelEl = document.createElement('div');
      labelEl.className = 'prompt-section-label';
      labelEl.textContent = s.label;
      const bodyEl = document.createElement('pre');
      bodyEl.className = 'prompt-section-body';
      bodyEl.textContent = s.text;
      modal.appendChild(labelEl);
      modal.appendChild(bodyEl);
    }
  } else {
    const emptyEl = document.createElement('p');
    emptyEl.style.cssText = 'color:var(--muted);font-size:13px';
    emptyEl.textContent = 'No system prompt configured.';
    modal.appendChild(emptyEl);
  }
  const actionsEl = document.createElement('div');
  actionsEl.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'pi-copy';
  copyBtn.innerHTML = `${ICONS.copy}<span>Copy full prompt</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pi-close confirm-ok';
  closeBtn.textContent = 'Close';
  actionsEl.appendChild(copyBtn);
  actionsEl.appendChild(closeBtn);
  modal.appendChild(actionsEl);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const fullPrompt = sections.map(s => s.text).join('\n\n');
  copyBtn.addEventListener('click', async () => {
    await _copyText(fullPrompt).catch(() => {});
    showToast('Copied', 'success');
  });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } }
  document.addEventListener('keydown', onKey);
}


async function renderHistory() {
  messagesEl.innerHTML = '';
  const { history } = await chrome.storage.local.get('history');
  const list = Array.isArray(history) ? history : [];
  nextHistoryIdx = list.length; // keep local mirror in sync with storage
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        // Message with attached images: extract text part and image URLs
        const textPart = m.content.find(p => p.type === 'text')?.text || '';
        if (textPart.startsWith(PAGE_CONTEXT_PREFIX)) continue;
        const imgUrls = m.content
          .filter(p => p.type === 'image_url')
          .map(p => p.image_url?.url || p.image_url)
          .filter(Boolean);
        const el = appendUser(textPart || '(image)', imgUrls.length ? imgUrls : null);
        el.dataset.hidx = i;
        continue;
      }
      if (m.content.startsWith(PAGE_CONTEXT_PREFIX)) continue;
      const el = appendUser(m.content);
      el.dataset.hidx = i;
    } else if (m.role === 'assistant') {
      const rawContent = m.content;
      const el = appendAssistant('', true);
      el.innerHTML = await renderSafe(rawContent);
      el.dataset.raw = rawContent; // mirrors appendUser's dataset.raw — read by openDetailThread
      decorateLinks(el);
      linkifyTimestamps(el);
      if (m.videoSrc) el.dataset.videoSrc = JSON.stringify(m.videoSrc); // enables [mm:ss] seek links
      addMsgActions(el, () => rawContent);
      renderMermaid(el); renderEcharts(el); renderMarkmap(el);
      el.dataset.hidx = i;
    }
  }
  addCodeCopyButtons();
  scrollToBottom(true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Feature: Font size ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function applyFontSize(px) {
  document.documentElement.style.setProperty('--msg-font-size', px + 'px');
}


// ═══════════════════════════════════════════════════════════════════════════════
// ─── Feature: Image lightbox ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function showImageLightbox(src, alt) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = alt || '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'lightbox-close';
  closeBtn.innerHTML = ICONS.close;
  closeBtn.addEventListener('click', () => overlay.remove());
  overlay.appendChild(img);
  overlay.appendChild(closeBtn);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  // Keyboard close
  const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

