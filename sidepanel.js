// sidepanel.js — UI logic
// Talks to background.js via chrome.runtime messages. Streaming responses come back
// via a long-lived Port (chrome.runtime.connect) for low-latency chunk delivery.

import { PAGE_CONTEXT_PREFIX } from './lib/constants.js';
import { getActiveSessionId } from './lib/storage.js';
import { ICONS } from './lib/sidepanel/icons.js';
import { $, escM, _copyText, showToast, showConfirmDialog, sendMessage, _findCard, _insertCard } from './lib/sidepanel/ui-utils.js';
import {
  renderSafe, renderStreamingSafe, renderMermaid, renderEcharts, renderMarkmap, preloadChartVendors,
  addCodeCopyButtons, decorateLinks, linkifyTimestamps, disposeChartObservers,
  makeStreamRenderer, setThoughtAutoCollapse, stripThinkSegments, decorateFigureRefs, figuresBeforeEntry
} from './lib/sidepanel/render.js';
import { initMsgSearch, openMsgSearch, closeMsgSearch } from './lib/sidepanel/msg-search.js';
import { classifyErrorText } from './lib/sidepanel/error-classifier.js';
import {
  initFollowups, enqueueFollowup, takeFirstFollowup, hasQueuedFollowups
} from './lib/sidepanel/followups.js';
import {
  attachDraftPersistence, restoreComposerState, pushInputHistory,
  handleHistoryNav, resetHistoryNav, clearPersistedDraft
} from './lib/sidepanel/composer-state.js';
import {
  initSessionsUI, getSessionsDrawer, openSessionsDrawer, onSessionSearch,
  closeSessionsDrawer, clearAllSessions
} from './lib/sidepanel/sessions-ui.js';
import {
  initTranscriptDrawer, refreshTranscriptSource, openTranscriptDrawer,
  closeTranscriptDrawer, isOpenTranscriptDrawer, formatTs
} from './lib/sidepanel/transcript-drawer.js';
import { initOutlineRail } from './lib/sidepanel/outline-rail.js';
import { planHistoryReconcile } from './lib/sidepanel/history-reconcile.js';
import {
  initMultiselect, isInMultiSelectMode, enterMultiSelect, exitMultiSelect,
  deleteSelectedMessages
} from './lib/sidepanel/multiselect.js';
import './lib/sidepanel/detail-thread.js'; // wires its own mouseup/scroll listeners on import
import { providerModelList } from './lib/handlers/provider-resolver.js';
import { initAttachOrchestrator, onAttachPage } from './lib/sidepanel/attach-orchestrator.js';
import { warmupPdfInspector } from './lib/sidepanel/pdf-inspector-worker-client.js';
import { videoUrlMatches, resolveMatchingTabId } from './lib/video-url.js';
import { applyI18n, initI18n, watchUiLang, t, tSub } from './lib/i18n.js';
import { providerDisplayName as displayProviderName, providerEntrySuffix } from './lib/provider-display.js';
import { agentSwitchNeedsPrompt } from './lib/agent-turn.js';
// smd removed: <thinking> tags from Claude confused its HTML parser, breaking markdown rendering.

// i18n convenience — existing call sites keep the short alias. t() resolves
// explicit-language dict → chrome.i18n (browser language) → inline fallback,
// so jsdom tests without chrome.i18n keep seeing the source strings.
const _t = t;

// Shared makeStreamRenderer() callbacks: addMsgActions/scrollToBottom are
// sidepanel.js-owned UI concerns that lib/render.js deliberately doesn't
// import (would create a cross-module cycle) — passed in per call instead.
const streamRendererOpts = {
  onTick: () => {
    if (isUserScrolledUp && scrollToBottomBtn) scrollToBottomBtn.classList.add('has-new');
    scrollToBottom();
  },
  onDone: (el, delta) => {
    // 回复里的 [图N] 引用还原为内联缩略图（图片来自其上方最近的带图附加条目）。
    // 异步读 history，fire-and-forget：失败只影响缩略图，不影响正文渲染。
    (async () => {
      try {
        const { history } = await chrome.storage.local.get('history');
        decorateFigureRefs(el, figuresBeforeEntry(Array.isArray(history) ? history : [], (history || []).length));
      } catch (_) {}
    })();
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

// 空状态提示在 CSS ::after content 里——CSS 无法走 chrome.i18n，按当前 UI 语言
// 把文案写进 --empty-hint（语言切换时重跑）。引号转义防注入样式值。
function applyEmptyHint() {
  // 空态背景中央这一行是「先附加再提问」循环的唯一教学位——有消息即消失
  // （.messages:not(:has(.msg))::after），无需任何显隐维护。
  const text = _t('emptyHint', 'Click 📎 to attach the current page').replaceAll("'", "\\'");
  document.documentElement.style.setProperty('--empty-hint', `'${text}'`);
}

async function init() {
  // 静态文案填充前先就绪语言偏好（显式选择过语言时要先加载覆盖字典）。
  await initI18n();
  applyI18n();
  applyEmptyHint();
  // 设置里切换语言：静态文案重填 + provider 下拉按新语言重建（状态随 GET_CONFIG 刷新）。
  watchUiLang(async () => {
    applyI18n();
    applyEmptyHint();
    try {
      const res = await sendMessage({ type: 'GET_CONFIG' });
      const cfg = res?.data || res;
      if (cfg?.providers) populateProviderSelect(cfg);
    } catch { /* 重建下拉失败不打扰用户 */ }
  });
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
    decrementNextHistoryIdx: () => { nextHistoryIdx = Math.max(0, nextHistoryIdx - 1); },
    // 批量删除与单条删除共用同一把锁，避免两边的 hidx 平移互相踩。
    tryLock: () => { if (deleteLock) return false; deleteLock = true; return true; },
    releaseLock: () => { deleteLock = false; },
    reconcile: () => { reconcileHistoryIdx(); },
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
  // 默认折叠（undefined = 从未设置过 → 折叠）；只有显式存过 false（设置页取消
  // 勾选）的用户保持展开。
  setThoughtAutoCollapse(cfg.thoughtAutoCollapse !== false);
  if (cfg.fontSize) applyFontSize(cfg.fontSize);

  // Load history
  await renderHistory();

  // Wire UI
  providerSel.addEventListener('change', onProviderChange);


  $('sessions-btn')?.addEventListener('click', () => { closeTranscriptDrawer(); openSessionsDrawer(); });
  document.getElementById('sessions-close')?.addEventListener('click', closeSessionsDrawer);
  $('sessions-new')?.addEventListener('click', newSession);
  // Sessions drawer: search and clear-all wired once here to avoid stacking listeners
  document.querySelector('.sessions-search')?.addEventListener('input', onSessionSearch);
  $('sessions-clear-all')?.addEventListener('click', clearAllSessions);
  // Transcript drawer — same right-side slot as the sessions drawer, so the
  // two are mutually exclusive. No backdrop by design (usable while watching).
  $('transcript-btn')?.addEventListener('click', () => {
    if (isOpenTranscriptDrawer()) { closeTranscriptDrawer(); return; }
    closeSessionsDrawer();
    openTranscriptDrawer();
  });
  initOutlineRail({ messagesEl });
  initTranscriptDrawer({
    sendMessage,
    onSeek: (seconds, vs) => seekVideo(vs, seconds),
    onNote: noteFromTranscript,
    getSource: getVideoTranscriptSource,
  });
  // renderHistory() ran before the drawer's deps existed, so its own
  // refresh was a no-op — rescan now that getSource is wired.
  refreshTranscriptSource();
  settingsBtn.addEventListener('click', openSettingsPage);
  clearBtn.addEventListener('click', clearChatHistory);
  ctxRadios.forEach((r) => r.addEventListener('change', onContextModeChange));
  sendBtn.addEventListener('click', () => {
    if (activeController && !activeController.cancelled) cancelStream();
    else onSend();
  });
  // Wire the extracted 📎 attach pipelines (lib/sidepanel/attach-orchestrator.js).
  // Inject sidepanel-owned state/helpers — the getters stay live (currentTabId,
  // ctxRadios change over the panel's lifetime) and bumpHistoryIdx keeps this
  // file's history-index counter in sync with the module's increments.
  initAttachOrchestrator({
    getTabId: () => currentTabId,
    getCtxRadios: () => ctxRadios,
    bumpHistoryIdx: (n = 1) => { nextHistoryIdx += n; },
    inputEl, messagesEl, attachBtn,
    appendAttachSystem, appendError, appendScreenshot,
    clearAttachProgress, compactArkErrorText, refreshAsrStreams,
    refreshTranscriptSource, showAttachProgress, showScreenshotCropUI,
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
        _syncSlashAria(items);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashSuggestIdx = Math.max(slashSuggestIdx - 1, 0);
        _syncSlashAria(items);
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
    // ↑/↓ input-history recall (blocked while the slash panel is open)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        handleHistoryNav(e, () => slashSuggestEl && !slashSuggestEl.hidden)) {
      e.preventDefault();
      updateComposerInfo();
      return;
    }
    // Send shortcut: Enter (default) or Shift+Enter. `!e.repeat` guards
    // against held-key double-fire — repeats would now stack queued
    // follow-ups instead of just re-sending.
    if (sendShortcut === 'shift-enter') {
      if (e.key === 'Enter' && e.shiftKey && !e.isComposing && !e.repeat) {
        e.preventDefault(); onSend();
      }
    } else {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) {
        e.preventDefault(); onSend();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      cancelStream(); // 流没停就清空，回复结束后会写进新会话开头（孤儿回复）
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
      if (isOpenTranscriptDrawer()) { closeTranscriptDrawer(); return; }
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

    if (msg.type === 'DEEP_EXTRACT_PROGRESS') {
      // Live progress from background's deep-extraction pass, which runs
      // inside the still-pending ATTACH_PAGE round trip; surface it on the
      // same fixed pill the attach flow uses (cleared when attach lands).
      if (msg.tabId === currentTabId && msg.text) showAttachProgress(msg.text);
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
        .then((res) => renderDiagnostics(res?.data))
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
      if (changes.thoughtAutoCollapse) setThoughtAutoCollapse(changes.thoughtAutoCollapse.newValue !== false);
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
  // Pre-warm the pdf-inspector WASM Worker so the first real PDF attach
  // doesn't pay the cold-compile cost (~10-30s in Chrome) at click time.
  // Fire-and-forget: never awaited, silently no-ops if worker construction
  // fails — same pattern as preloadChartVendors().
  warmupPdfInspector();
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

  // Keyboard activation for focusable timestamp links. .browsa-ts carries
  // role="button" tabindex="0" but Enter/Space don't synthesize a click on a
  // <span> — so it was focusable yet unusable by keyboard (worse than not
  // being in the tab order).
  messagesEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const ts = e.target.closest?.('.browsa-ts');
    if (!ts) return;
    e.preventDefault();
    onTimestampClick(ts);
  });

  // Wire search bar
  initMsgSearch();
  $('search-btn')?.addEventListener('click', openMsgSearch);

  // Wire multi-select toggle
  $('multiselect-toggle')?.addEventListener('click', () => {
    if (isInMultiSelectMode()) exitMultiSelect(); else enterMultiSelect();
  });
  $('multiselect-delete')?.addEventListener('click', async () => {
    await deleteSelectedMessages();
    refreshTranscriptSource(); // 删的可能正是字幕附件条目
  });
  $('multiselect-cancel')?.addEventListener('click', exitMultiSelect);

  // Queued follow-ups dock (mounted just above the composer) + draft
  // persistence so unsent text survives the panel being torn down.
  initFollowups({
    mountEl: document.querySelector('.composer'),
    sendNow: (text) => { resetHistoryNav(inputEl); inputEl.value = text; updateComposerInfo(); onSend(); },
  });
  attachDraftPersistence(inputEl);
  restoreComposerState(inputEl).catch(() => {});

  // Scroll anchoring across disclosure toggles (think blocks, folded
  // replies): remember the toggling element's viewport position at
  // pointerdown, compare after the toggle lands, compensate scrollTop —
  // content the user was reading doesn't jump (Cherry Studio's
  // useScrollAnchor pattern).
  let disclosureAnchor = null;
  const _disclosureTarget = (e) => {
    const t = e.target.closest('.think-block > summary, .fold-btn');
    if (!t) return null;
    const el = t.closest('.think-block') || t.closest('.msg') || t;
    return { t, el };
  };
  messagesEl.addEventListener('pointerdown', (e) => {
    const hit = _disclosureTarget(e);
    disclosureAnchor = hit ? { ...hit, top: hit.el.getBoundingClientRect().top } : null;
  }, true);
  messagesEl.addEventListener('click', (e) => {
    if (!disclosureAnchor) return;
    const hit = _disclosureTarget(e);
    const anchor = disclosureAnchor;
    disclosureAnchor = null;
    if (!hit || hit.t !== anchor.t) return;
    const rect = hit.el.getBoundingClientRect();
    if (!rect.height) return; // fully collapsed away — nothing sensible to anchor to
    const delta = rect.top - anchor.top;
    if (Math.abs(delta) >= 2) messagesEl.scrollTop += delta;
  });

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
      appendAttachSystem(`📎 已附加：「${preview}」`, null, text, undefined, undefined, res.data?.attachId);
    } else {
      appendError(res?.data?.error || _t('noSelectionText', '没有获取到选中文字，请重新选择'));
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



let cachedProviders = {};
// 一次性自愈标记：activeProvider 未配置时的自动切换只发一次（见 populateProviderSelect）。
let _activeProviderRepairSent = false;

function populateProviderSelect(cfg) {
  cachedProviders = cfg.providers || {};
  const pingStates = cfg.pingStates || {};
  // 只列「已配置」的 provider（2026-09-09 用户要求）：Hermes / OpenCode / Agent
  // Bridge 出厂就带着空 baseUrl 的卡，未配置时留在下拉里只是噪音——选中它只会
  // 以「Base URL is not set」失败。bridge 卡的 baseUrl = 首个端点，同一判据。
  const isConfigured = (name) => !!String(cfg.providers?.[name]?.baseUrl || '').trim();
  // Reachable providers first (stable sort — ties keep their original
  // relative order), so a provider you've actually verified works doesn't
  // get buried below ones that are merely configured-but-unverified.
  const providers = Object.keys(cfg.providers || {})
    .filter(isConfigured)
    .map((name, i) => ({ name, i }))
    .sort((a, b) => {
      const ar = pingStates[a.name] === 'reachable' ? 0 : 1;
      const br = pingStates[b.name] === 'reachable' ? 0 : 1;
      return ar - br || a.i - b.i;
    })
    .map(({ name }) => name);
  providerSel.innerHTML = '';
  if (!providers.length) {
    // 一个都没配置：留一个禁用的占位项。空 <select> 看起来像坏了，而且不告诉
    // 用户下一步该做什么。
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = _t('providerNoneConfigured', '未设置');
    providerSel.appendChild(opt);
    return;
  }
  // LLM 卡（卡上 Model ID 逗号分隔多个）：每个模型一个选项，按「Alias · model」
  // 展示——一张网关卡（方舟 Coding / 兼容网关动辄几十个模型）不用为每个模型建卡；
  // 单模型卡同样带 Model ID 后缀，一眼看到当前用的模型。bridge 卡同构地按端点
  // 展开（models 槽存 URL，后缀是 /health 发现的 agent 名）。其余 Agent 卡没有
  // Model ID，保持纯 Alias 展示。
  let activeFallback = null;
  let anySelected = false;
  for (const name of providers) {
    const pcfg = cfg.providers[name];
    const display = displayProviderName(name, pcfg);
    const isBridgeCard = !!pcfg?.isBridge;
    const models = providerModelList(pcfg);
    // bridge 卡：models 槽存的是端点 URL（一地址一 agent），同样逐个展开；
    // 展示名用 Ping 时 /health 发现的 agent 名（alias），未 Ping 过用 host:port 兜底。
    const modelList = ((pcfg.type || 'llm') === 'llm' || isBridgeCard) && models.length ? models : [''];
    let status;
    if (pingStates[name] === 'reachable')   status = _t('statusReachable', '● reachable');
    else if (pingStates[name] === 'unreachable') status = _t('statusUnreachable', '○ unreachable');
    else                           status = _t('statusNotPinged', 'not pinged');
    for (const model of modelList) {
      const suffix = providerEntrySuffix(pcfg, model);
      const opt = document.createElement('option');
      opt.value = name;
      opt.dataset.model = model;
      opt.dataset.display = suffix ? `${display} · ${suffix}` : display;
      opt.textContent = suffix ? `${display} · ${suffix} — ${status}` : `${display} — ${status}`;
      // 窄侧栏里原生 select 会把长标签截断，title 让悬停能看到全名。
      opt.title = opt.textContent;
      if (name === cfg.activeProvider) {
        if ((model || '') === String(cfg.activeModel || '')) { opt.selected = true; anySelected = true; }
        else if (!activeFallback) activeFallback = opt;
      }
      providerSel.appendChild(opt);
    }
  }
  if (!anySelected && activeFallback) activeFallback.selected = true;
  // 存储里的 activeProvider 未配置（出厂默认 hermes，或它的 baseUrl 刚被清空）：
  // 它本来就用不了，落到第一个已配置项并写回存储——否则下拉显示 A 而实际请求走
  // B，每轮都以「Base URL is not set」失败。这是修复无效状态（ping 通首项时
  // pingCard 也会做同样的自动切换），不是替用户改偏好。
  if (providers.includes(cfg.activeProvider)) {
    _activeProviderRepairSent = false; // 状态恢复合法：下次再失配仍可自愈
  } else {
    const first = providerSel.options[0];
    if (first) {
      first.selected = true;
      if (!_activeProviderRepairSent) {
        _activeProviderRepairSent = true;
        const oldLabel = displayProviderName(cfg.activeProvider, cfg.providers?.[cfg.activeProvider]);
        sendMessage({ type: 'SET_ACTIVE_PROVIDER', name: first.value, model: first.dataset.model || '' })
          .then((res) => { if (!res?.ok) _activeProviderRepairSent = false; });
        showToast(tSub('providerSwitchedUnconfigured', '「$1」未配置，已切换到「$2」', oldLabel, first.dataset.display), 'info');
      }
    }
  }
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
// ARIA listbox wiring: the panel is role=listbox (sidepanel.html), each row is
// role=option, and the textarea points at the active row via
// aria-activedescendant — so a screen reader can follow ↑/↓ selection
// (previously keyboard nav worked but was invisible to assistive tech).
function _syncSlashAria(items) {
  items.forEach((it, i) => {
    const active = i === slashSuggestIdx;
    it.classList.toggle('active', active);
    it.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const activeEl = slashSuggestIdx >= 0 ? items[slashSuggestIdx] : null;
  if (activeEl && activeEl.id) inputEl.setAttribute('aria-activedescendant', activeEl.id);
  else inputEl.removeAttribute('aria-activedescendant');
}

function updateSlashSuggest() {
  if (!slashSuggestEl) return;
  const val = inputEl.value;
  if (!val.startsWith('/') || val.includes(' ')) { hideSlashSuggest(); return; }
  const q = val.toLowerCase();
  const matches = Object.keys(SLASH_COMMANDS).filter(k => k.toLowerCase().startsWith(q));
  if (!matches.length) { hideSlashSuggest(); return; }
  slashSuggestEl.innerHTML = '';
  slashSuggestIdx = -1;
  matches.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = 'slash-item';
    item.dataset.cmd = cmd;
    item.id = `slash-opt-${i}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
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
  });
  slashSuggestEl.hidden = false;
  inputEl.setAttribute('aria-expanded', 'true');
  inputEl.setAttribute('aria-controls', 'slash-suggest');
}
function hideSlashSuggest() {
  if (slashSuggestEl) slashSuggestEl.hidden = true;
  slashSuggestIdx = -1;
  inputEl.setAttribute('aria-expanded', 'false');
  inputEl.removeAttribute('aria-activedescendant');
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

// 方舟把可读错误放在 JSON body 里（upload HTTP 401: {"error":{"message":...}}），
// 整串进 toast 又长又难读（还有无空格的 Request id 长 token）。抽出 error.message
// 让 toast 保持一行可读；解析不出 JSON 原样返回。console.warn 仍记全文。
function compactArkErrorText(msg) {
  const s = String(msg || '');
  const i = s.indexOf('{"');
  if (i === -1) return s;
  try {
    const j = JSON.parse(s.slice(i));
    const inner = j?.error?.message || j?.message || '';
    return inner ? s.slice(0, i) + inner : s;
  } catch (_) {
    return s;
  }
}

// Session DNR rule：给 ASR 媒体下载注入平台 CDN 要求的头（Referer/Origin/Cookie），
// 音频/视频两条管线共用（配方实现见 lib/sidepanel/media-headers.js，每条头为什么
// 必须注入的完整论证在该文件注释里）。
// 播放地址过期（deadline 签名 URL → CDN 无条件 403）的自愈：让页面重拉 playurl
// 换全新签名 URL。want='audio' 只刷音频流（纯 ASR）；'all' 连 video/muxed 一起刷
//（视频解析管线用）。返回流数组；失败返回 null（调用方走现有兜底），不抛错。
async function refreshAsrStreams(platform, want = 'audio') {
  try {
    const r = await sendMessage({ type: 'ASR_FRESH_URLS', tabId: currentTabId, platform, want, videoUrl: '' }).catch(() => null);
    // envelope：background 的 onMessage 把 handle() 返回值包成 {ok, data: result}，
    // ASR_FRESH_URLS 返回扁平 {ok, streams}——判 data.ok（曾嵌套读错层导致永远
    // 解析不到，2026-08-25 实机教训）。
    if (r?.data?.ok && Array.isArray(r.data.streams) && r.data.streams.length) return r.data.streams;
    console.warn('[ASR] playurl refresh failed:', r?.data?.error || r?.error || 'refresh failed');
  } catch (e) {
    console.warn('[ASR] playurl refresh failed:', String((e && e.message) || e));
  }
  return null;
}

// 视频精读管线（v1，当前暂时只支持 B 站）：下载视频流（+ 独立音频流）→ 分别上传方舟 Files API
// → 轮询至 active → Responses API 单请求以 input_video(+input_audio) 引用，产出
// 带 [mm:ss] 时间戳的「视听精读」文档。产物格式与字幕 ASR 完全一致，下游共用。
// durl 合一流（音画合一）走单文件（audioFileId=null）；DASH 分离流走双文件组合
//（input_video + input_audio 共享同一条时间线，均从 0:00 开始）——该组合是设计
// 推演路线，若方舟拒绝，错误原样抛给调用方走回退，用户可退回音频模式。
// 返回 { transcriptText, audioBytes, videoBytes }。
// ── 📎 attach pipelines moved to lib/sidepanel/attach-orchestrator.js ──
// (onAttachPage / runVideoAnalysisPipeline / runAudioTranscribePipeline /
//  downloadAndTranscodeAudioBest / showAsrModeCard). Wired up via
// initAttachOrchestrator() in init(); onAttachPage is imported back in.

/** Show a visible "attaching…" status pill above the composer, reusing the
 * same .tool-progress styling as the chat tool-progress indicator. Unlike
 * showToolProgress (anchored relative to a streaming message bubble), this
 * has a fixed anchor: right before .composer-box, inside <footer class="composer">. */
function showAttachProgress(text) {
  let el = document.getElementById('attach-progress');
  if (!el) {
    const composerBox = document.querySelector('.composer-box');
    if (!composerBox) return;
    el = document.createElement('div');
    el.id = 'attach-progress';
    el.className = 'tool-progress';
    el.dataset.tier = 'reading';
    composerBox.parentNode.insertBefore(el, composerBox);
  }
  el.innerHTML = `<span class="tp-icon">${ICONS.book}</span><span class="tp-text">${escM(text)}</span>`;
}

/** Remove the attach-progress pill, if present. */
function clearAttachProgress() {
  document.getElementById('attach-progress')?.remove();
}

/** Same fixed-anchor pill pattern as showAttachProgress, shown while
 * renderHistory()'s background KaTeX/mermaid/echarts upgrade pass is still
 * running, so a long history with several formulas reads as "still working"
 * rather than looking like the extension is broken/unresponsive. */
function showHistoryUpgradeIndicator() {
  let el = document.getElementById('history-upgrade-progress');
  if (!el) {
    const composerBox = document.querySelector('.composer-box');
    if (!composerBox) return;
    el = document.createElement('div');
    el.id = 'history-upgrade-progress';
    el.className = 'tool-progress';
    el.dataset.tier = 'reading';
    composerBox.parentNode.insertBefore(el, composerBox);
  }
  el.innerHTML = `<span class="tp-icon">${ICONS.book}</span><span class="tp-text">正在渲染历史消息…</span>`;
}

function hideHistoryUpgradeIndicator() {
  document.getElementById('history-upgrade-progress')?.remove();
}

async function newSession() {
  cancelStream(); // 先停流：否则在途回复会在清空后落进新会话
  // Auto-save current conversation if it has messages, then clear
  const { history } = await chrome.storage.local.get('history');
  const hasMessages = Array.isArray(history) && history.some(m => m.role === 'user' || m.role === 'assistant');
  if (hasMessages) {
    // 会话归属同 loadSession：已归属的对话原地写回，全新对话才新建条目。
    // 之后的 CLEAR_HISTORY 会把归属指针一并清掉（storage.clearHistory）。
    const activeId = await getActiveSessionId();
    const res = await sendMessage({ type: 'SAVE_SESSION', id: activeId || undefined });
    if (res?.ok && res.data?.session) {
      showToast(tSub('sessionSaved', 'Session saved: "$1"', res.data.session.name), 'success');
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
  refreshTranscriptSource(); // 会话切走了，字幕按钮隐藏、抽屉复位
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
  cancelStream(); // 确认后再停流：取消确认不应误杀进行中的回复
  await sendMessage({ type: 'CLEAR_HISTORY' });
  messagesEl.innerHTML = '';
  nextHistoryIdx = 0;
  deleteLock = false;
  isUserScrolledUp = false;
  if (scrollToBottomBtn) scrollToBottomBtn.hidden = true;
  images.length = 0; refreshImageStrip();
  refreshTranscriptSource(); // 字幕随历史一起清掉了
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
    // Anchor on the LOWEST-hidx bubble (attach bubbles are never rendered, so
    // that isn't necessarily index 0) and let the pure planner decide whether
    // the drift is a real front-trim (shift DOM down) or a failed append
    // (counter was just too high — shifting here desynced every subsequent
    // delete; the pre-0.33.0 code always assumed trim).
    let anchor = null, anchorH = Infinity;
    messagesEl.querySelectorAll('[data-hidx]').forEach(b => {
      const v = parseInt(b.dataset.hidx, 10);
      if (!isNaN(v) && v < anchorH) { anchorH = v; anchor = b; }
    });
    const plan = planHistoryReconcile({
      entries: Array.isArray(h) ? h : [],
      nextHistoryIdx,
      anchorH: anchor ? anchorH : -1,
      anchorRaw: anchor?.dataset?.raw || '',
    });
    if (plan.action === 'none') return;
    if (plan.action === 'shift') {
      // Bubbles whose index goes below 0 are no longer in storage; their
      // delete buttons will be no-ops (REMOVE_HISTORY_ENTRY_BY_INDEX returns
      // ok:false and the UI now honors that), so they degrade safely.
      messagesEl.querySelectorAll('[data-hidx]').forEach(b => {
        const bidx = parseInt(b.dataset.hidx, 10);
        if (!isNaN(bidx)) b.dataset.hidx = bidx - plan.drift;
      });
    }
    nextHistoryIdx = plan.actualLen;
  } catch (_) { /* storage unavailable — leave as-is */ }
}

const SEND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/></svg>`;
const STOP_ICON  = ICONS.stop;

// Drives the topbar status dot's live state (idle / streaming / error) —
// see the .status-dot rules in sidepanel.css. A short-lived 'error' state
// auto-reverts to idle (or streaming, if a stream is still active) so a
// single failed request doesn't leave the dot stuck red.
let statusDotErrorTimer = null;
function setStatusDotState(state) {
  const dot = document.getElementById('status-dot');
  if (!dot) return;
  if (statusDotErrorTimer) { clearTimeout(statusDotErrorTimer); statusDotErrorTimer = null; }
  dot.dataset.state = state;
  if (state === 'error') {
    statusDotErrorTimer = setTimeout(() => {
      dot.dataset.state = activeController ? 'streaming' : 'idle';
      statusDotErrorTimer = null;
    }, 1600);
  }
}

function setStreamingUI(on) {
  if (on) {
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.classList.add('is-stopping');
    sendBtn.disabled = false;
    sendBtn.title = _t('cancelStream', 'Stop (Esc)');
    setStatusDotState('streaming');
    // #messages is aria-live=polite; the streaming bubble rewrites innerHTML
    // every frame, which would make a screen reader re-announce a mutating
    // subtree many times per second. Suspend announcements while streaming and
    // restore them when the reply settles.
    messagesEl.setAttribute('aria-live', 'off');
    messagesEl.setAttribute('aria-busy', 'true');
  } else {
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.classList.remove('is-stopping');
    sendBtn.disabled = false;
    sendBtn.title = '';
    setStatusDotState('idle');
    messagesEl.setAttribute('aria-live', 'polite');
    messagesEl.removeAttribute('aria-busy');
    stopWaitingIndicator(); // catch-all: cancel / resume-end / error teardown
  }
}

/**
 * Auto-drain one queued follow-up when a turn finishes normally (DONE).
 * Runs a tick late so DONE's DOM cleanup settles first, and is guarded
 * against clobbering newer user intent: skipped while the composer holds
 * text (retry/edit flows park content there) or a new turn already started.
 * User-canceled streams never reach DONE, so Esc-to-stop keeps the queue.
 */
function maybeDrainFollowups() {
  setTimeout(() => {
    if (!hasQueuedFollowups() || activeController) return;
    if (inputEl.value.trim()) return;
    const next = takeFirstFollowup();
    if (!next) return;
    inputEl.value = next;
    updateComposerInfo();
    onSend();
  }, 50);
}

function cancelStream() {
  if (!activeController) return;  activeController.cancelled = true;
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
    stopWaitingIndicator();
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
    const res = await sendMessage({ type: 'OPEN_OPTIONS_TAB', url });
    // ui-utils 的 sendMessage 不 reject（lastError 也走 resolve），catch 是
    // 死代码——回退判断必须看返回值本身。
    if (!res?.ok) throw new Error(res?.error || 'OPEN_OPTIONS_TAB failed');
  } catch (e) {
    // Fallback: try the direct API
    try {
      chrome.runtime.openOptionsPage();
    } catch (e2) {
      appendError(tSub('cannotOpenSettings', 'Cannot open settings: $1', e2.message));
    }
  }
}

async function onProviderChange() {
  const name = providerSel.value;
  const opt = providerSel.selectedOptions[0];
  // 多模型 provider：选项按 Alias · model 展示，选中的具体模型随 provider 一起落存储
  const model = opt?.dataset?.model || '';
  await sendMessage({ type: 'SET_ACTIVE_PROVIDER', name, model });
  showToast(tSub('switchedTo', 'Switched to $1', opt?.dataset?.display || displayProviderName(name)), 'success');
  // 背填是一次性意图，绑定「切过去后的下一轮」——换目标（含切回）即作废
  pendingAgentBackfill = false;
  await maybeProviderSwitchCard();
}

// 切到 agent 类 provider 时询问当前对话的去留（仿 ASR 模式选择卡）：上下文对
// agent 天然不延续（agent 自己持有 transcript，browsa 只发单轮），跨 provider
// 切换后它对之前聊过的内容一无所知。切回原 provider 卡片自动消失（= 撤销）；
// 两个选项：带上当前对话继续（背填）或新建会话。切到 LLM 不问——LLM 每轮
// 全量重发历史，上下文天然连续。
async function maybeProviderSwitchCard() {
  document.querySelectorAll('.provider-switch-card').forEach((c) => c.remove());
  const name = providerSel.value;
  const pcfg = cachedProviders[name];
  if (!pcfg) return;
  const opt = providerSel.selectedOptions[0];
  const model = opt?.dataset?.model || '';
  const needs = agentSwitchNeedsPrompt({
    currentIsAgent: (pcfg.type || 'llm') === 'agent',
    currentKey: { name, model },
    lastKey: lastReplyKey,
  });
  if (!needs) return;
  showProviderSwitchCard(opt?.dataset?.display || displayProviderName(name, pcfg));
}

function showProviderSwitchCard(label) {
  const card = document.createElement('div');
  card.className = 'msg system asr-mode-card provider-switch-card';
  const title = document.createElement('div');
  title.className = 'asr-mode-title';
  title.textContent = tSub('providerSwitchTitle', '已切换到 $1。当前对话怎么处理？', label);
  card.appendChild(title);
  const row = document.createElement('div');
  row.className = 'asr-mode-row';
  const mkBtn = (main, sub, onClick) => {
    const b = document.createElement('button');
    b.className = 'asr-mode-btn';
    b.type = 'button';
    const m1 = document.createElement('span');
    m1.className = 'asr-mode-main';
    m1.textContent = main;
    const m2 = document.createElement('span');
    m2.className = 'asr-mode-sub';
    m2.textContent = sub;
    b.appendChild(m1);
    b.appendChild(m2);
    b.addEventListener('click', () => { card.remove(); onClick(); });
    return b;
  };
  row.appendChild(mkBtn(
    _t('providerSwitchCarry', '带上当前对话继续'),
    _t('providerSwitchCarrySub', '对话记录作为第一条消息发给它'),
    () => {
      pendingAgentBackfill = true;
      showToast(tSub('providerSwitchCarryToast', '下一条消息会把当前对话带给 $1', label), 'success');
    }
  ));
  row.appendChild(mkBtn(
    _t('providerSwitchFresh', '新建会话'),
    _t('providerSwitchFreshSub', '当前对话归档，从零开始'),
    () => { newSession(); }
  ));
  card.appendChild(row);
  const note = document.createElement('div');
  note.className = 'provider-switch-note';
  note.textContent = _t('providerSwitchDirectHint', '不选择直接发送，则不带上下文继续');
  card.appendChild(note);
  // 卡片在用户选择前被移除（会话切换/newSession 重渲染消息流）→ 静默消失，
  // 与 ASR 模式卡同一防挂起语义；重新弹出由下次 onProviderChange 决定。
  const obs = new MutationObserver(() => {
    if (!card.isConnected) obs.disconnect();
  });
  obs.observe(messagesEl, { childList: true });
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
    if (f.size > maxSize) { appendError(tSub('imageTooLarge', 'Image too large: $1', f.name)); continue; }
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
    rmBtn.setAttribute('aria-label', _t('removeImage', 'Remove image'));
    rmBtn.title = _t('removeImage', 'Remove image');
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

// Starts a 20s SW keep-alive ping loop — shared by onSend() and
// resumeInFlightStream(). Returns the interval id so the caller can
// clear it via clearInterval(id), which is what stopKeepAlive() does in
// wireChatStreamPort and what port.onDisconnect does in both functions.
function startSwPingKeepAlive(port) {
  return setInterval(() => {
    try { port.postMessage({ type: 'SW_PING' }); } catch (_) {}
  }, 20_000);
}

// Shown in port.onDisconnect when the port dies before any chunks arrived —
// a real hint vs a silent empty bubble. Shared by onSend() and
// resumeInFlightStream() (same message, same guard: acc === '' && text '▍').
function showNoChunkHint(el, state) {
  if (state.acc === '' && el && el.textContent === '▍') {
    el.textContent = '(no chunks received — check Service Worker DevTools)';
  }
}

// Shared `browsa-chat` port message handler, used by BOTH onSend() (a fresh
// send) and resumeInFlightStream() (reconnecting to a stream already running
// on the background). These two call sites used to each hand-roll their own
// near-identical `port.onMessage.addListener(async (m) => {...})` body; a
// real bug sweep (see test/lib-sidepanel-resume-streaming.test.mjs) found
// four places where a feature added to onSend()'s copy was never mirrored
// into resumeInFlightStream()'s (videoSrc stamp, CHOICE_REQUEST buttons, the
// max-turns "→ 继续" button, and ERROR/ABORTED rendering). Extracting the
// CHUNK/TOOL_PROGRESS/APPROVAL/CLARIFY/DONE/ERROR handling into one function
// removes the possibility of that class of drift going forward — only the
// genuinely different bits (RETRY behavior, and what to do right after DONE)
// stay as caller-supplied hooks.
//
//   getEl()        — returns the CURRENT assistant bubble element. For
//                    onSend() this is just the fixed bubble it created; for
//                    resumeInFlightStream() it re-resolves on every call
//                    since a prior panel session's DOM can have been replaced.
//   getRenderer()  — returns the CURRENT renderStream() closure (may be
//                    swapped by onRetry/DOM-identity-change).
//   state          — mutable { acc, toolEvents } shared with the caller.
//   stopKeepAlive()— clears the caller's SW_PING setInterval.
//   onRetry(m)     — RETRY handling differs: onSend() wipes the bubble and
//                    starts a fresh renderer; resume just shows a toast.
//   afterDone(el)  — extra caller-specific cleanup once DONE has already run
//                    the shared handling (onSend has none; resume also calls
//                    setStreamingUI(false)).
//   onAborted()    — extra caller-specific cleanup on ERROR/ABORTED (resume
//                    also disconnects its port; onSend does not).
// Sends STREAM_HELLO on `port` and waits for STREAM_HELLO_ACK, with a 500ms
// safety-net timeout that resolves unconditionally so we never hang. Shared
// by onSend() (which also calls `onAck` — the `attachChunkListener` wiring
// that must happen right as the ACK arrives, before the outer `await` returns
// so no in-flight chunks miss the listener) and resumeInFlightStream() (which
// needs no onAck since it wires wireChatStreamPort() after the await returns).
function waitForStreamHelloAck(port, tabId, { onAck } = {}) {
  return new Promise((resolve) => {
    const ackTimeout = setTimeout(resolve, 500);
    port.onMessage.addListener(function once(m) {
      if (m.type === 'STREAM_HELLO_ACK') {
        clearTimeout(ackTimeout);
        port.onMessage.removeListener(once);
        onAck?.();
        resolve();
      }
    });
    port.postMessage({ type: 'STREAM_HELLO', tabId });
  });
}

function wireChatStreamPort({ port, tabId, getEl, getRenderer, state, stopKeepAlive, onRetry, afterDone, onAborted }) {
  startWaitingIndicator(getEl);
  port.onMessage.addListener(async (m) => {
    if (m.type === 'CHUNK') {
      stopWaitingIndicator();
      if (!streamStartAt) streamStartAt = Date.now(); // mark first-token time
      state.acc += m.delta;
      getRenderer()(m.delta, false); // pass delta, not accumulated text
      updateOutputTokenCount(m.delta);

    } else if (m.type === 'TOOL_PROGRESS') {
      stopWaitingIndicator();
      state.toolEvents.push(m.text);
      showToolProgress(getEl(), m.text);

    } else if (m.type === 'TS_STATUS') {
      stopWaitingIndicator();
      // Transient status from the background's auto timestamp-rewrite
      // (video notes whose first reply lacked [mm:ss]). Shown like
      // tool-progress but NOT recorded into toolEvents, so DONE's
      // renderToolHistory won't render it as a tool event; DONE's
      // existing clearToolProgress removes it.
      showToolProgress(getEl(), m.text, 'warn');

    } else if (m.type === 'APPROVAL') {
      stopWaitingIndicator();
      showApprovalCard(getEl(), m.data);

    } else if (m.type === 'CLARIFY') {
      stopWaitingIndicator();
      showClarifyCard(getEl(), m.data);

    } else if (m.type === 'RETRY') {
      onRetry(m);

    } else if (m.type === 'DONE') {
      const el = getEl();
      const r = getRenderer();
      stopWaitingIndicator();
      clearToolProgress(el);
      _findCard(el, 'approval-card')?.remove();
      _findCard(el, 'clarify-card')?.remove();
      if (state.toolEvents.length > 0) {
        renderToolHistory(el, state.toolEvents);
        state.toolEvents = [];
      }
      const finalText = m.full || state.acc;
      el.dataset.hidx = nextHistoryIdx++; // assistant turn stored in background
      el.classList.add('done'); // stream over → content-visibility 恢复生效（CSS 豁免条件）
      await r(finalText, true);
      // linkifyTimestamps already ran inside renderStream's isDone path;
      // stamp the video source (carried in the DONE chunk by the chat
      // handler) so the clickable [mm:ss] markers know which tab/URL to seek.
      if (m.videoSrc) el.dataset.videoSrc = JSON.stringify(m.videoSrc);
      addCodeCopyButtons();
      renderMermaid(el); renderEcharts(el); renderMarkmap(el);
      if (m.providerLabel) addProviderLabel(el, m.providerLabel);
      if (m.providerKey) lastReplyKey = m.providerKey;
      outputTokens = 0;
      // Show token usage if the provider returned it
      if (m.usage) showTokenUsage(el, m.usage);
      // 输出被模型长度上限截断（finish_reason=length）——明示，别让用户以为是
      // browsa 吞了内容（真实用户反馈 2026-08-24：回复分几截，只能喊“继续”）。
      if (m.outputTruncated) {
        // 背景端已自动续写一次；走到这里说明续写后仍被上限截断。
        showToast(_t('outputTruncatedToast', '回复仍被模型输出上限截断，可点「继续生成」或回复「继续」'), 'info');
        appendMsgAction(el, _t('continueGenerate', '→ 继续生成'), () => { inputEl.value = '继续'; onSend(); });
      }
      if (m.choiceRequest) renderChoiceRequest(el, m.choiceRequest);
      // Detect max-turns: agent hit the tool-call ceiling and is asking
      // the user to continue. Show a one-click Continue button.
      if (/reached.*max.*turns|maximum.*turns|max_turns|已达上限|工具调用.*上限|继续.*完成/i.test(finalText)) {
        appendMsgAction(el, '→ 继续', () => { inputEl.value = '继续'; onSend(); });
      }
      stopKeepAlive();
      try { port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
      try { port.disconnect(); } catch (_) {}
      // port.disconnect() does NOT fire this side's own onDisconnect listener
      // (only the other end's), so activeController must be cleared here —
      // otherwise it stays set until the async round trip settles, and a
      // Send click in that window is misrouted to cancelStream() instead.
      activeController = null;
      sendMessage({ type: 'STREAM_RELEASE', tabId }).catch(() => {});
      reconcileHistoryIdx(); // detect + correct auto-trim drift (fire-and-forget)
      maybeDrainFollowups();
      afterDone?.(el);

    } else if (m.type === 'ERROR') {
      // Only ABORTED reaches here — real errors are re-thrown by background
      // and handled via the !res.ok block below (no pushChunk for real errors).
      stopWaitingIndicator();
      stopKeepAlive();
      getEl().classList.add('done'); // 流结束（错误/中止）→ content-visibility 恢复生效
      if (m.code === 'ABORTED') {
        const r = getRenderer();
        await r(state.acc ? state.acc + '\n\n_(cancelled)_' : '_(cancelled)_', true);
      }
      // The background never disconnects the port after pushing ERROR —
      // without this cleanup activeController leaks, and every later send
      // gets silently routed into the followups queue (which never drains
      // because DONE can never run again). Port self-disconnect() does NOT
      // fire our own onDisconnect, so do the full cleanup here.
      activeController = null;
      setStreamingUI(false);
      try { port.disconnect(); } catch (_) {}
      onAborted?.();
    }
  });
}

async function onSend() {
  if (!currentTabId) {
    appendError(_t('noActiveTab', 'No active tab.'));
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

  // Mid-stream send (Enter/quick chip while a reply is still streaming):
  // starting a second parallel CHAT would put two ports on the same tabId —
  // the two replies fight over one chunk feed and corrupt history indices.
  // Queue it instead; the dock above the composer drains automatically when
  // this turn finishes (maybeDrainFollowups in the DONE branch).
  if (activeController && !activeController.cancelled) {
    enqueueFollowup(rawText);
    resetHistoryNav(inputEl); // 同 onSend：先复位召回态再清空
    inputEl.value = '';
    clearPersistedDraft();
    updateComposerInfo();
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
      }
    } catch (_) {
      // tab gone or permission denied — keep going with what we have
    }
  }

  // User bubble — show the original slash command, not the expanded prompt
  lastSentRaw = rawText;
  pushInputHistory(rawText); // ↑ recall list
  const pendingImageUrls = images.length > 0 ? images.map(i => i.dataUrl) : null;
  const userBubble = appendUser(rawText || (pendingImageUrls ? '(image)' : '(page only)'), pendingImageUrls);
  userBubble.dataset.hidx = nextHistoryIdx++;  // user turn stored in background CHAT handler
  // 复位 ↑ 召回态——不复位的话 _navIdx 保持武装，发送后敲的第一个字会被旧
  // 草稿顶掉。resetHistoryNav 会把召回前的草稿写回 value，所以必须先复位、
  // 再清空。
  resetHistoryNav(inputEl);
  inputEl.value = '';
  clearPersistedDraft();
  updateComposerInfo();
  setStreamingUI(true);

  // Placeholder assistant bubble
  const assistantEl = appendAssistant('');
  const state = { acc: '', toolEvents: [] };   // toolEvents accumulate TOOL_PROGRESS events for post-stream history panel
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
  const _swPingInterval = startSwPingKeepAlive(port);

  // Hand the tabId to the background so it knows which port serves which tab.
  // The background stores the port in a Map keyed by tabId; when the CHAT
  // handler emits a delta, it looks up the port via this tabId.
  // We wait for an ACK before sending the CHAT message, to avoid a race
  // where the first chunk fires before the background has registered us.
  await waitForStreamHelloAck(port, currentTabId, { onAck: attachChunkListener });

  function attachChunkListener() {
    wireChatStreamPort({
      port,
      tabId: currentTabId,
      getEl: () => assistantEl,
      getRenderer: () => renderStream,
      state,
      stopKeepAlive: () => clearInterval(_swPingInterval),
      onRetry: (m) => {
        // Background is retrying. Reset accumulator and renderer so the bubble
        // shows only the new attempt's content, not stale content from the failed one.
        state.acc = '';
        state.toolEvents = [];
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
      },
    });
  }
  port.onDisconnect.addListener(() => {
    clearInterval(_swPingInterval);
    setStreamingUI(false);
    activeController = null;
    // No chunks received AND bubble still shows the placeholder: background
    // reported an error before any delta was emitted — show a clear hint.
    showNoChunkHint(assistantEl, state);
  });

  try {
    const imageDataUrls = images.length > 0 ? images.map(i => i.dataUrl) : null;
    // Clear thumbnails immediately — the LLM may take seconds to respond
    images.length = 0;
    refreshImageStrip();

    // 切换卡还没选就直接发送 = 「不带上下文继续」（今天的默认行为），卡撤销
    document.querySelectorAll('.provider-switch-card').forEach((c) => c.remove());
    const backfill = pendingAgentBackfill;
    pendingAgentBackfill = false; // 一次性：无论本轮是否 agent，意图已消费
    const res = await sendMessage({
      type: 'CHAT',
      tabId: currentTabId,
      userText: text,
      stream: true,
      portName: 'browsa-chat',
      images: imageDataUrls,
      backfill
    });
    if (!res.ok) {
      // Real error (re-thrown by background, port receives nothing).
      // Clean up NOW: the port will never receive DONE/ERROR, so without
      // this activeController leaks and the retry button below would
      // route into the followups queue instead of re-sending.
      clearInterval(_swPingInterval);
      activeController = null;
      try { port.disconnect(); } catch (_) {}
      // Preserve any partial streaming content; append the error inline.
      const errMsg = res.error || 'Unknown error';
      if (state.acc) {
        await renderStream(state.acc + `\n\n---\n❌ **${errMsg}**`, true);
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
    clearInterval(_swPingInterval);
    activeController = null;
    try { port.disconnect(); } catch (_) {}
    if (state.acc) {
      await renderStream(state.acc + `\n\n---\n❌ **${e.message}**`, true);
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
  // what do you have so far? The bridge envelopes every reply as
  // { ok, data } — the payload fields live under .data.
  const peekRes = await sendMessage({ type: 'STREAM_PEEK', tabId });
  const peek = peekRes?.data || {};
  if (!peek.inFlight) {
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
  const _swPingInterval = startSwPingKeepAlive(port);
  const state = { acc: peek.acc || '', toolEvents: [] };
  const initialBubble = getOrCreateAssistantBubble();
  let renderStream = makeStreamRenderer(initialBubble, streamRendererOpts);
  let assistantEl = initialBubble;
  function getOrCreateAssistantBubble() {
    // Reuse the tail assistant bubble only when it is the very last `.msg`.
    // Deliberately NOT `.msg.assistant:last-of-type` — that pseudo-class
    // requires the element to be the last DIV among its siblings BY TAG NAME,
    // and trailing non-`.msg` siblings (renderChoiceRequest's .choice-request
    // wrap, appendMsgAction's .msg-actions row) silently un-qualify it.
    //
    // The reuse-or-append decision matters: the assistant turn is persisted
    // only at DONE (chat-handler), so on a FRESH panel open mid-stream
    // renderHistory() renders storage as […, assistant(prev), user(cur)]. The
    // last `.msg.assistant` is then the PREVIOUS reply — reusing it streams
    // this reply into the old bubble and wipes the previous answer. Only when
    // the tail is itself an assistant (a leftover in-flight bubble, or a
    // genuine resume) is reuse correct; a tail user/system bubble means a new
    // assistant bubble is required.
    const msgs = messagesEl.querySelectorAll('.msg');
    const tail = msgs.length ? msgs[msgs.length - 1] : null;
    const el = (tail && tail.classList.contains('assistant')) ? tail : appendAssistant('');
    return el;
  }
  function ensureAssistantEl() {
    // The DOM node identity may have changed (innerHTML restore
    // replaces the whole subtree). Re-resolve on every chunk.
    let el = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
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
  // CHUNKs are pure new deltas; state.acc += m.delta inside
  // wireChatStreamPort is correct because we seed state.acc from
  // peek.acc, not ''.
  if (state.acc) renderStream(state.acc, false);
  if (peek.providerLabel) addProviderLabel(assistantEl, peek.providerLabel);
  // HELLO the background so it knows this port owns the stream now.
  // Wait for ACK so any in-flight delta that's about to fire from the
  // LLM (after the PEEK/HELLO race window) goes to a port that's
  // already wired with a listener.
  await waitForStreamHelloAck(port, tabId);
  // The DONE/ERROR/CHUNK/TOOL_PROGRESS/APPROVAL/CLARIFY handling itself is
  // shared with onSend() via wireChatStreamPort — see its doc comment. Only
  // the genuinely different bits stay here: RETRY is just a toast (no bubble
  // reset, unlike onSend()'s), afterDone also calls setStreamingUI(false)
  // (onSend()'s own port.onDisconnect already does that; this path's
  // onDisconnect fires on user-Esc/cleanup, not on a normal DONE), and
  // onAborted additionally disconnects the port (onSend()'s ABORTED branch
  // relies on the background having already disconnected first).
  wireChatStreamPort({
    port,
    tabId,
    getEl: () => { ensureAssistantEl(); return assistantEl; },
    getRenderer: () => ensureAssistantEl(),
    state,
    stopKeepAlive: () => clearInterval(_swPingInterval),
    onRetry: (m) => {
      showToolProgress(assistantEl, `⟳ Retrying… (attempt ${m.attempt}/${m.maxAttempts})`, 'warn');
    },
    afterDone: () => {
      setStreamingUI(false);
    },
    onAborted: () => {
      try { port.disconnect(); } catch (_) {}
    },
  });
  port.onDisconnect.addListener(() => {
    clearInterval(_swPingInterval);
    setStreamingUI(false);
    activeController = null;
    // Same no-chunks hint as onSend's onDisconnect handler.
    showNoChunkHint([...messagesEl.querySelectorAll('.msg.assistant')].pop(), state);
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
  // <dialog>（top-layer）：Esc（cancel 事件）此前不关闭裁剪界面，现免费获得。
  // jsdom 无 showModal → open 属性兜底。
  const modal = document.createElement('dialog');
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
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');

  const canvas   = modal.querySelector('.crop-canvas');
  const body     = modal.querySelector('.crop-body');
  const confirmBtn = modal.querySelector('.crop-confirm');
  const fullBtn  = modal.querySelector('.crop-use-full');
  const cancelBtn = modal.querySelector('.crop-cancel');

  // Escape hatches wired BEFORE the image loads — cancel, the native dialog
  // 'close' event, and onerror below. These used to live inside img.onload, so
  // a failed/slow image load left a modal with no operable button at all.
  function closeCrop() {
    try { modal.close?.(); } catch (_) {} // close 事件统一收尾；remove 兜底 jsdom
    modal.remove();
  }
  modal.addEventListener('close', () => modal.remove());
  cancelBtn.addEventListener('click', closeCrop);

  const img = new Image();
  img.onerror = () => {
    closeCrop();
    showToast(_t('screenshotFailed', '截图加载失败，请重试'), 'error');
  };
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

    // Keyboard region selection — the drag path above is mouse-only, so a
    // keyboard user could not pick a crop region at all. Arrow keys move the
    // selection, Shift+arrows resize it, Enter confirms, Escape cancels (the
    // native dialog's cancel event already handles Escape).
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', _t('cropCanvasLabel', '拖拽或用方向键选择截图区域'));
    const NUDGE = 6;
    const ensureSelection = () => {
      if (selection) return;
      const w = Math.round(canvas.width * 0.6), h = Math.round(canvas.height * 0.6);
      selection = { x: Math.round((canvas.width - w) / 2), y: Math.round((canvas.height - h) / 2), w, h };
    };
    const commitSelection = () => {
      selection.w = Math.max(4, Math.min(selection.w, canvas.width));
      selection.h = Math.max(4, Math.min(selection.h, canvas.height));
      selection.x = Math.max(0, Math.min(selection.x, canvas.width - selection.w));
      selection.y = Math.max(0, Math.min(selection.y, canvas.height - selection.h));
      redraw(selection);
      confirmBtn.disabled = !(selection.w > 5 && selection.h > 5);
    };
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { if (!confirmBtn.disabled) confirmBtn.click(); return; }
      const dx = e.key === 'ArrowLeft' ? -NUDGE : e.key === 'ArrowRight' ? NUDGE : 0;
      const dy = e.key === 'ArrowUp' ? -NUDGE : e.key === 'ArrowDown' ? NUDGE : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      ensureSelection();
      if (e.shiftKey) { selection.w += dx; selection.h += dy; } else { selection.x += dx; selection.y += dy; }
      commitSelection();
    });
    canvas.addEventListener('focus', () => { if (!selection) { ensureSelection(); commitSelection(); } });

    // Downscale a JPEG data URL to at most maxWidth px wide (proportional).
    // Retina / 4K screenshots can be 2560-3840px wide — most vision models
    // perform equally well at 1400px and the token cost drops significantly.
    // Returns a Promise<string> resolving to the (possibly smaller) data URL.
    function resizeScreenshot(dataUrl, maxWidth = 1400, quality = 0.85) {
      return new Promise((resolve) => {
        const src = new Image();
        src.onload = () => {
          if (src.naturalWidth <= maxWidth) { resolve(dataUrl); return; }
          const ratio = maxWidth / src.naturalWidth;
          const rc = document.createElement('canvas');
          rc.width  = maxWidth;
          rc.height = Math.round(src.naturalHeight * ratio);
          rc.getContext('2d').drawImage(src, 0, 0, rc.width, rc.height);
          resolve(rc.toDataURL('image/jpeg', quality));
        };
        src.onerror = () => resolve(dataUrl); // fall back to original on any error
        src.src = dataUrl;
      });
    }

    fullBtn.addEventListener('click', async () => {
      closeCrop();
      onConfirm(await resizeScreenshot(imageDataUrl));
    });

    confirmBtn.addEventListener('click', async () => {
      if (!selection || selection.w < 2 || selection.h < 2) return;
      // Crop at original resolution
      const oc = document.createElement('canvas');
      oc.width  = Math.round(selection.w / scale);
      oc.height = Math.round(selection.h / scale);
      oc.getContext('2d').drawImage(img,
        selection.x / scale, selection.y / scale,
        oc.width, oc.height,
        0, 0, oc.width, oc.height);
      closeCrop();
      onConfirm(await resizeScreenshot(oc.toDataURL('image/jpeg', 0.85)));
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
      img.loading = 'lazy';   // 视口外不解码（MB 级 data URL 的解码成本是真实的）
      img.decoding = 'async';
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
// Shared with the transcript drawer's row clicks via seekVideo(vs, seconds).
async function onTimestampClick(ts) {
  // A live text selection means the user was dragging across text, not
  // aiming at the marker — seeking then would be a surprise.
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (sel && !sel.isCollapsed) return;
  const seconds = Number(ts.dataset.s) || 0;
  const msgEl = ts.closest('.msg');
  let vs = null;
  try { vs = msgEl ? JSON.parse(msgEl.dataset.videoSrc || 'null') : null; } catch (_) {}
  await seekVideo(vs, seconds);
}

// Which tab still shows the video this videoSrc was stamped from? Priority:
// the stamped tabId first (the attach-time source tab — seeking it in place
// is the established behavior even when the user has since switched tabs),
// then the tab the panel is currently following. Covers the recycle cases the
// stamped id alone can't: browser restart (ids recycled), source tab closed
// or navigated away while the same video is open (or reopened) in the tab
// the panel now follows. URL-judged via videoUrlMatches — no network.
function resolveVideoTabId(vs) {
  return resolveMatchingTabId(
    [vs?.tabId, currentTabId],
    async (id) => (await chrome.tabs.get(id))?.url,
    vs?.url
  );
}

// Seek the given video source ({platform,url,tabId}) to `seconds`. Returns
// true when a seek path (in-place or new tab) was taken.
async function seekVideo(vs, seconds) {
  const tabId = await resolveVideoTabId(vs);
  if (tabId != null) {
    try {
      const res = await sendMessage({ type: 'SEEK_VIDEO', tabId, seconds, url: vs.url });
      // background envelopes every reply as { ok, data } — res.ok is just
      // "the handler didn't throw" and is true even when the seek itself
      // failed (tab gone / no <video>). The inner data.ok is the real
      // verdict; reading the outer one silently disabled the ?t= fallback.
      if (res?.data?.ok) return true;
    } catch (_) {}
  }
  // No live tab shows this video (stamped id stale AND current tab is not
  // the video) — only now is opening a fresh tab the right move.
  if (vs?.url) {
    chrome.tabs.create({ url: appendTimeParam(vs.url, seconds) });
    return true;
  }
  showToast(_t('videoSourceGone', '视频源已失效，无法跳转'));
  return false;
}

// The drawer's follow poll and row seeks both run off videoSrc.tabId. When
// the stamped tab is gone but the panel's current tab shows the same video,
// retarget so playback-follow keeps working instead of failing 4 ticks and
// going quiet (same stale-id cases resolveVideoTabId covers for seekVideo).
async function retargetVideoSrcToLiveTab(vs) {
  if (!vs) return vs;
  const liveId = await resolveVideoTabId(vs);
  return liveId != null && liveId !== vs.tabId ? { ...vs, tabId: liveId } : vs;
}

// Transcript drawer source scan: the LAST user history entry stamped with
// videoSrc (ATTACH_PAGE on a video page, or ATTACH_ASR_CONFIRM). Its content
// carries the `## 字幕` block as [mm:ss] lines.
async function getVideoTranscriptSource() {
  try {
    const { history } = await chrome.storage.local.get('history');
    const list = Array.isArray(history) ? history : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m?.role !== 'user' || !m.videoSrc) continue;
      if (typeof m.content === 'string') {
        return { raw: m.content, videoSrc: await retargetVideoSrcToLiveTab(m.videoSrc), figures: [] };
      }
      // 交错多模态条目（视频精读 + 关键帧）：text 部件拼接为时间线原文，
      // image 部件按序抽出——[图N] 锚点行渲染成内联截图卡片。
      if (Array.isArray(m.content)) {
        const raw = m.content
          .filter((p) => p.type === 'text' || p.type === 'input_text')
          .map((p) => p.text)
          .join('\n');
        if (!raw) continue;
        const figures = m.content
          .filter((p) => p.type === 'image_url')
          .map((p) => (typeof p.image_url === 'string' ? p.image_url : p.image_url?.url))
          .filter(Boolean);
        return { raw, videoSrc: await retargetVideoSrcToLiveTab(m.videoSrc), figures };
      }
    }
  } catch (_) {}
  return null;
}

// Transcript drawer 「记一笔」: turn the line being played (−3s reaction
// offset applied in pickNoteLine) into a timestamped draft in the composer.
// The user adds their reaction on top and sends; the [mm:ss] stays clickable.
function noteFromTranscript(seconds, line) {
  if (seconds == null || !line) {
    showToast(_t('noTranscriptPosition', '还没有可用的播放位置或字幕行'));
    return;
  }
  const note = `[${formatTs(seconds)}] 「${line.label ? line.label + ' ' : ''}${line.text}」`;
  inputEl.value = inputEl.value ? `${inputEl.value}\n${note}` : note;
  updateComposerInfo();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
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
        // 真判据在 envelope 的 data.ok 里——res.ok 只是「handler 没抛异常」，
        // 索引超界时 storage 静默返回 ok:false，误当成功会平移错所有 hidx。
        if (res?.data?.ok) {
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
      // 删掉的可能是带 videoSrc 的字幕附件——顶栏按钮的可见性要重算。
      refreshTranscriptSource();
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
    // Regenerate — truncate back to the user turn and re-run it (the same
    // flow edit&resend uses, just without letting the user touch the text).
    const regenBtn = document.createElement('button');
    regenBtn.className = 'msg-action-icon';
    regenBtn.title = _t('regenTitle', 'Regenerate response');
    regenBtn.innerHTML = ICONS.retry;
    regenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ub = findPrevUserBubble(el);
      if (ub) regenerateReply(ub);
    });
    buttons.push(regenBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-icon';
    copyBtn.title = 'Copy response';
    copyBtn.innerHTML = ICONS.copy;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 只复制正文：剥掉 <think>…</think>（思考内容有自己的「Copy thinking」小
      // 按钮，见 addThinkCopyButtons）。getRaw() 为空的兜底路径同样剔除 think 块
      // 的 DOM（克隆后移除 .think-block 再取 innerText——展开状态下的 innerText
      // 会带出 think 正文）。
      let text = stripThinkSegments(getRaw() || '');
      if (!text) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.think-block').forEach((n) => n.remove());
        text = (clone.innerText || '').trim();
      }
      try {
        await _copyText(text);
        copyBtn.textContent = '✓';
        showToast(_t('copied', 'Copied'), 'success');
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
 * Find the user bubble a reply answers to, skipping the streaming-era
 * siblings that live between them (think blocks, tool-progress lines,
 * token-usage chips, action rows).
 */
function findPrevUserBubble(el) {
  const SKIP = new Set(['token-usage', 'tool-progress', 'live-think', 'msg-action-row']);
  let p = el.previousElementSibling;
  while (p) {
    if (p.classList.contains('user')) return p;
    if ([...SKIP].some((c) => p.classList.contains(c)) || p.tagName === 'DETAILS') { p = p.previousElementSibling; continue; }
    return null;
  }
  return null;
}

/**
 * Regenerate: cancel any stream, truncate stored history from the user turn
 * onward, drop the reply (and anything after it) from the DOM, re-send the
 * SAME user text. Inline images attached to the original turn are not
 * replayed — same limitation edit&resend has; text-only turns are exact.
 */
async function regenerateReply(userBubble) {
  const idx = parseInt(userBubble.dataset.hidx, 10);
  if (isNaN(idx)) return;
  const raw = (userBubble.dataset.raw || userBubble.querySelector('.msg-text')?.textContent || '').trim();
  if (!raw) return;

  if (activeController && !activeController.cancelled) cancelStream();
  const truncRes = await sendMessage({ type: 'TRUNCATE_HISTORY_FROM_INDEX', index: idx }).catch(() => null);
  // 内层 ok:false（负索引等）说明 storage 没截成——此时绝不能清 DOM，否则
  // storage 里残留的后续轮次会和界面分叉，下一轮悄悄混进上下文。
  if (!truncRes?.data?.ok) { showToast(_t('truncRegenCancelled', '历史截断失败，已取消重新生成'), 'error'); return; }
  let sib = userBubble.nextElementSibling;
  while (sib) {
    const next = sib.nextElementSibling;
    sib.remove();
    sib = next;
  }
  nextHistoryIdx = idx;

  // onSend() reads the composer as its input source; preserve whatever is
  // parked there and restore after the regenerated turn has been handed off.
  const savedDraft = inputEl.value;
  inputEl.value = raw;
  try {
    await onSend();
  } finally {
    // onSend resolves at the CHAT ack (network RTT). Only restore the parked
    // draft when the composer is still empty — otherwise we'd erase whatever
    // the user typed (or a transcript-drawer 记一笔 filled) meanwhile.
    if (!inputEl.value.trim()) inputEl.value = savedDraft;
  }
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
      const truncRes = await sendMessage({ type: 'TRUNCATE_HISTORY_FROM_INDEX', index: idx }).catch(() => null);
      if (!truncRes?.data?.ok) { showToast(_t('truncEditNotSaved', '历史截断失败，未保存修改'), 'error'); return; }
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
    // 同主输入框：中文 IME 确认候选词的 Enter 不能触发保存重发。
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) { e.preventDefault(); saveBtn.click(); }
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
// ---- Waiting indicator (first-token latency) ----
// Between send and the first CHUNK / TOOL_PROGRESS / reasoning event the
// background pushes NOTHING (measured 2026-09-06 on Hermes /v1/runs: even
// reasoning text only arrives at step end), so on big-context turns the user
// stared at a silent blinking cursor for the whole prefill+thinking window.
// A 1s tick renders elapsed time in the same pre-bubble slot .tool-progress
// uses; the first real event stops it and hands the slot over.
let _waitTimer = null;
let _waitEl = null;
function startWaitingIndicator(getEl) {
  stopWaitingIndicator();
  const t0 = Date.now();
  const render = () => {
    const el = getEl?.();
    if (!el || !el.isConnected) return;
    if (!_waitEl || !_waitEl.isConnected) {
      _waitEl = document.createElement('div');
      _waitEl.className = 'wait-indicator';
      el.parentNode.insertBefore(_waitEl, el);
    }
    _waitEl.innerHTML =
      `<span class="tp-icon">${ICONS.gear}</span>` +
      `<span class="tp-text">${escM(tSub('waitThinking', '思考中… $1s', Math.round((Date.now() - t0) / 1000)))}</span>`;
  };
  render();
  _waitTimer = setInterval(render, 1000);
}
function stopWaitingIndicator() {
  if (_waitTimer) { clearInterval(_waitTimer); _waitTimer = null; }
  _waitEl?.remove();
  _waitEl = null;
}

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
  // Clamp to a known set: this value lands in a class name, so an agent-chosen
  // string with spaces/quotes would otherwise inject extra classes or markup.
  const riskRaw = String(data.risk_level || 'high').toLowerCase();
  const risk = ['high', 'medium', 'low'].includes(riskRaw) ? riskRaw : 'high';
  const choices = Array.isArray(data.choices) && data.choices.length ? data.choices : ['once', 'deny'];
  const btnLabels = {
    once: _t('approvalAllowOnce', 'Allow once'),
    session: _t('approvalAllowSession', 'Allow for session'),
    always: _t('approvalAlwaysAllow', 'Always allow'),
    deny: _t('approvalDeny', 'Deny'),
  };
  const btns = choices.map(c => {
    const label = btnLabels[c] || c;
    const cls   = c === 'deny' ? 'approval-btn-deny' : 'approval-btn-allow';
    return `<button class="approval-btn ${cls}" data-choice="${escM(c)}">${escM(label)}</button>`;
  }).join('');
  card.innerHTML =
    `<div class="approval-header">` +
      `<span class="approval-icon">⚠️</span>` +
      `<span class="approval-title">${escM(_t('approvalRequired', 'Approval required:'))} <strong>${tool}</strong></span>` +
      `<span class="approval-risk approval-risk-${escM(risk)}">${escM(risk)}</span>` +
    `</div>` +
    cmd + desc +
    `<div class="approval-actions">${btns}</div>`;
  // Announce the blocked prompt to assistive tech (it's inserted after the
  // bubble with no role) and give the buttons an accessible name context.
  card.setAttribute('role', 'alert');
  card.setAttribute('aria-label', `${_t('approvalRequired', 'Approval required:')} ${data.tool || data.function_name || ''}`.trim());
  // 审批按 chat 发起时的 tabId 存于 background；点击时再读 currentTabId 会
  // 在用户切 tab 后对不上号（卡片已移除、agent 干等超时）——渲染时钉死。
  card.dataset.tabId = String(currentTabId ?? '');
  card.querySelectorAll('.approval-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await sendMessage({ type: 'APPROVAL_RESPOND', tabId: Number(card.dataset.tabId), choice: btn.dataset.choice }).catch(() => null);
      if (!res?.data?.ok) showToast(tSub('approvalSendFailed', '审批发送失败：$1', res?.data?.error || res?.error || _t('bgStateLost', '后台状态已丢失')), 'error');
      card.remove();
    });
  });
  _insertCard(bubbleEl, card);
  // Move keyboard focus to the first action so the blocked prompt is operable
  // without a mouse.
  setTimeout(() => card.querySelector('.approval-btn')?.focus(), 50);
}

/** Show an agent clarification question card below the streaming bubble. */
function showClarifyCard(bubbleEl, data) {
  _findCard(bubbleEl, 'clarify-card')?.remove();
  const card = document.createElement('div');
  card.className = 'clarify-card';
  const questionText = data.question || data.text || _t('clarifyDefault', 'Please clarify:');
  const question = escM(questionText);
  const inputLabel = _t('clarifyPlaceholder', 'Your response…');
  card.innerHTML =
    `<div class="clarify-question">${question}</div>` +
    `<div class="clarify-input-row">` +
      `<input type="text" class="clarify-input" aria-label="${escM(inputLabel)}" placeholder="${escM(inputLabel)}" />` +
      `<button class="clarify-submit">${escM(_t('clarifySend', 'Send'))}</button>` +
    `</div>`;
  card.setAttribute('role', 'alert');
  card.setAttribute('aria-label', questionText);
  const input  = card.querySelector('.clarify-input');
  const submit = card.querySelector('.clarify-submit');
  // Same tabId pinning as the approval card — currentTabId at click time can
  // already point at a different tab, orphaning the pending clarification.
  card.dataset.tabId = String(currentTabId ?? '');
  const respond = async () => {
    const response = input.value.trim();
    if (!response) return;
    const res = await sendMessage({ type: 'CLARIFY_RESPOND', tabId: Number(card.dataset.tabId), response }).catch(() => null);
    if (!res?.data?.ok) showToast(tSub('replySendFailed', '回复发送失败：$1', res?.data?.error || res?.error || _t('bgStateLost', '后台状态已丢失')), 'error');
    card.remove();
  };
  submit.addEventListener('click', respond);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) respond(); });
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

function appendAttachSystem(text, relatedEl, ctxText, figures, hint, attachId) {
  const el = document.createElement('div');
  el.className = 'msg system attach-msg';
  const span = document.createElement('span');
  span.textContent = text;

  const figList = Array.isArray(figures)
    ? figures.filter((f) => f && (typeof f === 'string' ? f : f.url))
    : [];

  // "检查" button — shows the raw context sent to the model in a scrollable overlay.
  if (ctxText || figList.length) {
    const inspectBtn = document.createElement('button');
    inspectBtn.className = 'undo-attach inspect-ctx';
    inspectBtn.textContent = _t('inspectCtx', '检查');
    inspectBtn.title = _t('inspectCtxTitle', '查看发送给模型的完整上下文');
    inspectBtn.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="ctx-inspector-modal">
          <div class="ctx-inspector-header">
            <span class="ctx-inspector-title">${escM(_t('ctxInspectorTitle', '上下文预览'))}</span>
            <span class="ctx-inspector-len">${(ctxText || '').length.toLocaleString()} ${escM(_t('charsUnit', '字符'))}${figList.length ? ` · ${figList.length} figure${figList.length > 1 ? 's' : ''}` : ''}</span>
            <button class="ctx-inspector-copy">${escM(_t('copy', '复制'))}</button>
            <button class="ctx-inspector-close">✕</button>
          </div>
          <pre class="ctx-inspector-body"></pre>
          ${figList.length ? '<div class="ctx-inspector-figures"></div>' : ''}
        </div>`;
      // Set textContent on the <pre> to avoid any XSS from raw page content.
      overlay.querySelector('.ctx-inspector-body').textContent = ctxText || '(无文本)';
      const figContainer = overlay.querySelector('.ctx-inspector-figures');
      if (figContainer && figList.length) {
        const figTitle = document.createElement('div');
        figTitle.className = 'ctx-fig-title';
        figTitle.textContent = `Figures (${figList.length}, in context order)`;
        figContainer.appendChild(figTitle);
        figList.forEach((f, i) => {
          const url = typeof f === 'string' ? f : f.url;
          const cap = typeof f === 'string' ? '' : (f.caption || '');
          const page = typeof f === 'string' ? '' : (f.page || '');
          const figure = document.createElement('figure');
          figure.className = 'ctx-fig';
          const img = document.createElement('img');
          img.src = url;
          img.alt = cap || `Figure on page ${page || '?'}`;
          const figcaption = document.createElement('figcaption');
          figcaption.textContent = `${i + 1}. ${cap || `Figure on page ${page || '?'}`}`;
          figure.appendChild(img);
          figure.appendChild(figcaption);
          figContainer.appendChild(figure);
        });
      }
      // One close path for every dismissal (✕, backdrop, Escape) so the
      // document-level keydown listener is always removed. Previously only the
      // Escape path removed it — closing via ✕/backdrop leaked one keydown
      // listener per inspected attachment.
      const closeOverlay = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      };
      function onKey(e) { if (e.key === 'Escape') closeOverlay(); }
      overlay.querySelector('.ctx-inspector-close').addEventListener('click', closeOverlay);
      overlay.querySelector('.ctx-inspector-copy').addEventListener('click', () => {
        _copyText(ctxText || '');
        showToast(_t('copied', '已复制'));
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    });
    el.appendChild(span);
    el.appendChild(inspectBtn);
  } else {
    el.appendChild(span);
  }

  // Optional hint line (e.g. "video has no subtitles, enable ASR") rendered
  // as a FULL-WIDTH second row under the pill — appended after the 撤销/检查
  // buttons so flex-wrap puts it on its own line instead of squeezing it into
  // a skinny column between the label and the buttons.
  const btn = document.createElement('button');
  btn.className = 'undo-attach';
  btn.textContent = _t('undoAttach', '撤销');
  btn.title = _t('undoAttachTitle', '从会话中移除此次附加的页面内容');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    // attachId identifies the history entry THIS label owns. Without it the
    // handler removed the LAST page-context entry — with two attachments,
    // undoing the older one deleted the newer entry and left the older
    // content in context (the model then answered from the "undone" page).
    const res = await sendMessage({ type: 'UNDO_ATTACH', attachId }).catch(() => null);
    // Handler returns { ok: removedIdx>=0, removedIdx } INSIDE the envelope —
    // read both off res.data (reading res.removedIdx off the envelope always
    // gave undefined, so the hidx shift never ran and indices drifted).
    const d = res?.data || {};
    if (res?.ok && d.ok) {
      const removedIdx = d.removedIdx ?? -1;
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
      el.querySelector('.inspect-ctx')?.remove();
      // The undone attachment (e.g. the screenshot preview bubble) must
      // disappear too — leaving it visible after "撤销" reads as if the
      // undo only touched the label text, not the actual attached content.
      relatedEl?.remove();
    } else {
      btn.disabled = false;
    }
  });
  el.appendChild(btn);
  if (hint) {
    const hintEl = document.createElement('span');
    hintEl.className = 'attach-hint';
    hintEl.textContent = hint;
    el.appendChild(hintEl);
  }
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

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
// Reply-source chip: names the provider/agent that produced this reply,
// using the SAME label the sidebar dropdown shows for the selection
// (lib/provider-display.js). Stamped by the background on the assistant
// history entry + DONE chunk + stream state; added here on history render
// and on DONE. Sits at the TOP-LEFT of the bubble like a sender label (a
// footer at the bottom-right read as metadata and surprised users) — so it
// is PREPENDED, and must survive the async renderSafe upgrade (it wipes
// innerHTML) — same re-add discipline as .msg-actions.
function addProviderLabel(el, label) {
  if (!label || el.querySelector('.msg-provider')) return;
  const chip = document.createElement('span');
  chip.className = 'msg-provider';
  chip.textContent = label;
  el.insertBefore(chip, el.firstChild);
}

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

/**
 * Error display (Cherry Studio's ErrorBlock pattern): a known failure class
 * leads with one human headline, the raw provider message is clamped below
 * and stays collapsible for the full copyable text. Short unmatched notices
 * ('No active tab.', selection hints) keep the old compact single-line form
 * — a card around "please select text again" would be noise.
 */
function appendError(text) {
  const el = document.createElement('div');
  el.className = 'msg error';
  const raw = String(text ?? '');

  const cls = classifyErrorText(raw);
  if (!cls && raw.length <= 80) {
    el.textContent = '⚠ ' + raw;
    messagesEl.appendChild(el);
    scrollToBottom(true);
    setStatusDotState('error');
    return;
  }
  el.classList.add('has-detail');

  const head = document.createElement('div');
  head.className = 'err-head';
  const icon = document.createElement('span');
  icon.className = 'err-icon';
  icon.textContent = '⚠';
  const title = document.createElement('span');
  title.className = 'err-title';
  title.textContent = _t(cls?.key || 'errGeneric', cls ? '' : 'Something went wrong');
  head.append(icon, title);
  el.appendChild(head);

  if (raw) {
    const detail = document.createElement('div');
    detail.className = 'err-detail';
    detail.textContent = raw;
    el.appendChild(detail);

    const more = document.createElement('details');
    more.className = 'err-more';
    const summary = document.createElement('summary');
    summary.textContent = _t('errRawToggle', 'Raw error');
    const pre = document.createElement('pre');
    pre.textContent = raw;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'err-copy-btn';
    copyBtn.textContent = _t('copyLabel', 'Copy');
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await _copyText(raw);
        copyBtn.textContent = '✓';
      } catch (_) {
        copyBtn.textContent = '✗';
      }
      setTimeout(() => { copyBtn.textContent = _t('copyLabel', 'Copy'); }, 1500);
    });
    more.append(summary, pre, copyBtn);
    el.appendChild(more);
  }

  messagesEl.appendChild(el);
  scrollToBottom(true);
  setStatusDotState('error');
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

  // Replicate the same logic as background.js buildEffectivePrompt
  const base = cfg.systemPrompt || '';
  const langMap = { en: 'Please always respond in English.', zh: '请始终用中文回答。', ja: '常に日本語で回答してください。', ko: '항상 한국어로 답변해 주세요.', de: 'Bitte antworte immer auf Deutsch.', fr: 'Veuillez toujours répondre en français.', es: 'Por favor, responde siempre en español.' };
  const langExtra = langMap[cfg.replyLanguage] || '';

  const sections = [
    base && { label: 'Base system prompt', text: base },
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
  // 当前页 URL 从顶栏的 pagemeta 链接取（tab 切换时会同步更新）；原代码引用
  // 了不存在的 tabUrl，/prompt 一执行就 ReferenceError，输入还被清空。
  urlEl.textContent = pagemetaEl?.href?.startsWith('http') ? pagemetaEl.href : '(no page)';
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
    showToast(_t('copied', 'Copied'), 'success');
  });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } }
  document.addEventListener('keydown', onKey);
}


let historyUpgradeIO = null;     // IntersectionObserver driving the lazy renderSafe upgrades
let pendingAgentBackfill = false; // one-shot: carry the conversation into the next agent turn
let lastReplyKey = null;         // {name, model} of the provider that wrote the latest reply

async function renderHistory() {
  if (historyUpgradeIO) { historyUpgradeIO.disconnect(); historyUpgradeIO = null; }
  disposeChartObservers(); // chart/markmap ResizeObservers hold strong refs to the DOM we're about to wipe
  messagesEl.innerHTML = '';
  messagesEl.classList.remove('cv-settled');
  const { history } = await chrome.storage.local.get('history');
  const list = Array.isArray(history) ? history : [];
  nextHistoryIdx = list.length; // keep local mirror in sync with storage

  // Two-pass rendering: paint bubbles synchronously first (renderStreamingSafe,
  // no async KaTeX) so the panel is visible immediately, then upgrade each
  // assistant bubble to the full renderSafe() output in parallel. Previously
  // this was a single serial loop `await renderSafe()` per message, which
  // meant init() blocked for (N assistant messages × KaTeX Worker latency)
  // before the panel showed anything — visibly 5+ seconds with a long history.
  const asyncUpgrades = []; // [{ el, rawContent, videoSrc }] to upgrade in parallel

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
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
      // Sync fast-render so the bubble is visible immediately
      el.innerHTML = renderStreamingSafe(rawContent);
      const figs = figuresBeforeEntry(list, i);
      decorateFigureRefs(el, figs);
      el.dataset.raw = rawContent;
      el.dataset.hidx = i;
      if (m.videoSrc) el.dataset.videoSrc = JSON.stringify(m.videoSrc);
      addMsgActions(el, () => rawContent);
      addProviderLabel(el, m.providerLabel);
      asyncUpgrades.push({ el, rawContent, videoSrc: m.videoSrc, figs, providerLabel: m.providerLabel });
    }
  }
  // Switch-prompt decision input: which provider/endpoint produced the most
  // recent reply (null when the conversation has no replies yet).
  lastReplyKey = [...list].reverse().find((m) => m.role === 'assistant' && m.providerKey)?.providerKey || null;

  // Synchronous rendering done — panel is visible. Wire shallow decorations
  // (copy buttons, timestamps) on the fast-rendered content now so they work
  // even before the full upgrade resolves.
  addCodeCopyButtons();
  scrollToBottom(true);
  scrollToBottom(true);
  // cv 延迟到首帧稳定后生效（两次 rAF）：初始渲染与滚动定位期间绝不启用——
  // cv 的占位高度会拖慢首开、并把 scrollToBottom 的落点算错（指南明写的反模式）。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    messagesEl.classList.add('cv-settled');
  }));
  // Whether this conversation carries a video transcript decides the
  // transcript-drawer button's visibility — rescan after every history load.
  refreshTranscriptSource();

  // Upgrade all assistant bubbles to the full renderSafe() output (KaTeX
  // math, proper think-block handling, etc.) in the BACKGROUND — deliberately
  // NOT awaited here. init() awaits renderHistory() before wiring every
  // other button's event listener; if this function didn't return until
  // every formula/mermaid diagram finished rendering, the whole panel would
  // stay uninteractive (nothing clickable) for that entire stretch on a long
  // history, reading as "the extension is broken" rather than "still
  // loading." A visible pill covers the gap instead. Each bubble still
  // upgrades independently as soon as its own renderSafe resolves — a long
  // formula in message 3 doesn't delay message 5 from upgrading.
  if (asyncUpgrades.length > 0) {
    // Full renderSafe() upgrade (KaTeX / mermaid / think blocks) per bubble.
    // Eager for ALL bubbles was the v1 behavior: fine for short histories, but
    // a 100+-bubble conversation paid the entire upgrade cost on every panel
    // open. IntersectionObserver-driven: upgrade when the bubble nears the
    // scrollport (rootMargin pre-renders ahead of scroll). jsdom has no
    // IntersectionObserver → eager fallback keeps tests and old behavior.
    const runUpgrade = async ({ el, rawContent, figs, providerLabel }) => {
      const html = await renderSafe(rawContent);
      el.innerHTML = html;
      decorateLinks(el);
      linkifyTimestamps(el);
      decorateFigureRefs(el, figs);
      renderMermaid(el); renderEcharts(el); renderMarkmap(el);
      addCodeCopyButtons(el); // re-wire copy buttons on the upgraded content
      // el.innerHTML above wipes out the .msg-actions row appended during the
      // sync pass (it's a child of el, not a sibling) — re-add it here.
      // addMsgActions is idempotent (no-ops if .msg-actions already present),
      // but since innerHTML just destroyed the old one, this always re-creates it.
      addMsgActions(el, () => rawContent);
      addProviderLabel(el, providerLabel);
    };
    if (typeof IntersectionObserver !== 'function') {
      showHistoryUpgradeIndicator();
      Promise.all(asyncUpgrades.map(runUpgrade)).finally(hideHistoryUpgradeIndicator);
    } else {
      const byEl = new Map(asyncUpgrades.map((j) => [j.el, j]));
      let inFlight = 0;
      historyUpgradeIO = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          historyUpgradeIO.unobserve(entry.target);
          const job = byEl.get(entry.target);
          if (!job || job._started) continue;
          job._started = true;
          inFlight++;
          runUpgrade(job).finally(() => {
            inFlight--;
            if (inFlight === 0) hideHistoryUpgradeIndicator();
          });
        }
      }, { root: messagesEl, rootMargin: '1200px 0px' });
      showHistoryUpgradeIndicator(); // covers the initially-visible bubbles' upgrade gap
      for (const job of asyncUpgrades) historyUpgradeIO.observe(job.el);
    }
  }
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
  // <dialog>（top-layer）：Esc/焦点陷阱/置顶免费获得，替代手写 keydown 监听。
  // jsdom 无 showModal → open 属性兜底（CSS 里有 :not([open]) 守卫）。
  const dlg = document.createElement('dialog');
  dlg.className = 'lightbox-overlay';
  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = alt || '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'lightbox-close';
  closeBtn.innerHTML = ICONS.close;
  const dismiss = () => { try { dlg.close?.(); } catch (_) {} dlg.remove(); };
  closeBtn.addEventListener('click', dismiss);
  dlg.appendChild(img);
  dlg.appendChild(closeBtn);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dismiss(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

