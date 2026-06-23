// sidepanel.js — UI logic
// Talks to background.js via chrome.runtime messages. Streaming responses come back
// via a long-lived Port (chrome.runtime.connect) for low-latency chunk delivery.

import marked from './lib/vendor/marked.bundle.js';
import DOMPurify from './lib/vendor/purify.bundle.js';
import katex from './lib/vendor/katex.bundle.js';
// smd removed: <thinking> tags from Claude confused its HTML parser, breaking markdown rendering.

// Configure marked: GitHub-flavored breaks for line breaks, no mangle/autolink
// head features we don't need. Keep it simple; DOMPurify handles XSS later.
marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false
});

const $ = (id) => document.getElementById(id);
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
let mermaidModule = null;   // lazily loaded on first mermaid block
let slashSuggestIdx = -1;  // keyboard-nav index in slash autocomplete
let lastSentRaw = '';   // raw input text of last user send, used by Retry
let nextHistoryIdx = 0; // mirrors history.length; used to assign data-hidx to new bubbles
let deleteLock = false; // serialises message-delete operations to prevent index races
let isUserScrolledUp = false; // true when user has manually scrolled up during streaming
let scrollToBottomBtn = null; // lazy-created scroll-to-bottom button
let navPort = null;             // long-lived port for SPA navigation pushes
let lastXhsNote = null;         // most-recent XHR-intercepted 小红书 note
const images = [];             // { dataUrl, name } — attached for this turn
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

  // Load config
  const cfgRes = await sendMessage({ type: 'GET_CONFIG' });
  const cfg = cfgRes.data || cfgRes; // unwrap { ok, data } envelope
  populateProviderSelect(cfg);
  applyContextMode(cfg.contextMode || 'reader');
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onSend();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      clearChatHistory();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      cycleContextMode();
    }
  });

  // Global shortcuts (Esc = cancel stream or close drawer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!getSessionsDrawer()?.hidden) { closeSessionsDrawer(); return; }
      if (activeController && !activeController.cancelled) { e.preventDefault(); cancelStream(); }
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
    if (msg.type === 'IMAGE_ACTION') {
      handleImageAction(msg.dataUrl, msg.srcUrl);
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
      chrome.storage.session.get(['pendingSelectionAction', 'pendingImageAction']).then((sess) => {
        if (sess.pendingSelectionAction) {
          chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
          const { action, text } = sess.pendingSelectionAction;
          handleSelectionAction(action, text);
        }
        if (sess.pendingImageAction) {
          chrome.storage.session.remove('pendingImageAction').catch(() => {});
          const { dataUrl, srcUrl } = sess.pendingImageAction;
          handleImageAction(dataUrl, srcUrl);
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
    if (area === 'session' && changes.pendingImageAction?.newValue) {
      const { dataUrl, srcUrl } = changes.pendingImageAction.newValue;
      chrome.storage.session.remove('pendingImageAction').catch(() => {});
      handleImageAction(dataUrl, srcUrl);
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
    const sess = await chrome.storage.session.get(['pendingSelectionAction', 'pendingImageAction']);
    if (sess.pendingSelectionAction) {
      chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
      const { action, text } = sess.pendingSelectionAction;
      setTimeout(() => handleSelectionAction(action, text), 150);
    }
    if (sess.pendingImageAction) {
      chrome.storage.session.remove('pendingImageAction').catch(() => {});
      const { dataUrl, srcUrl } = sess.pendingImageAction;
      setTimeout(() => handleImageAction(dataUrl, srcUrl), 150);
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

/**
 * Handle an image right-clicked from a page.
 * Adds it to the image strip and pre-fills a prompt.
 */
function handleImageAction(dataUrl, srcUrl) {
  if (!dataUrl) return;
  // dataUrl may be a base64 data URL or a plain https:// URL (fallback)
  const name = (() => {
    try { return new URL(srcUrl).pathname.split('/').pop() || 'image'; } catch (_) { return 'image'; }
  })();
  images.push({ dataUrl, name });
  refreshImageStrip();
  if (!inputEl.value.trim()) inputEl.value = 'What\'s in this image?';
  inputEl.focus();
  updateComposerInfo();
}

function populateProviderSelect(cfg) {
  const providers = Object.keys(cfg.providers || {});
  const pingStates = cfg.pingStates || {};
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

/** Human-friendly relative time: "just now", "5m ago", "2h ago", "3d ago" */
function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
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

// ─── Mermaid (lazy-loaded) ────────────────────────────────────────────────────
async function getMermaid() {
  if (mermaidModule) return mermaidModule;
  try {
    const mod = await import('./lib/vendor/mermaid.bundle.js');
    mod.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
    mermaidModule = mod;
  } catch (e) {
    console.warn('browsa: mermaid load failed', e);
  }
  return mermaidModule;
}
async function renderMermaid(el) {
  const blocks = el.querySelectorAll('code.language-mermaid');
  if (!blocks.length) return;
  const m = await getMermaid();
  if (!m) return;
  for (const code of [...blocks]) {
    const pre = code.closest('pre') || code;
    const source = code.textContent;
    try {
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      const { svg } = await m.default.render(id, source);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch (e) {
      console.warn('browsa: mermaid render failed', e);
    }
  }
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
        appendAttachSystem(`📎 已附加截图："${title}"`);
        appendScreenshot(finalDataUrl);
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
  if (activeController.port) {
    try { activeController.port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
    try { activeController.port.disconnect(); } catch (_) {}
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
  const cjk = (delta.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const ascii = delta.length - cjk;
  outputTokens += cjk + Math.ceil(ascii / 4);
  tokCountEl.textContent = `~${outputTokens}`;
}

// Add a copy button to each think-block <summary> (idempotent).
function addThinkCopyButtons(el) {
  for (const details of (el || messagesEl).querySelectorAll('.think-block:not([data-copy-added])')) {
    details.dataset.copyAdded = '1';
    const summary = details.querySelector('summary');
    if (!summary) continue;
    const btn = document.createElement('button');
    btn.className = 'think-copy-btn';
    btn.title = 'Copy thinking';
    btn.textContent = '⎘';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't toggle the details
      const body = details.querySelector('.think-body');
      try {
        await _copyText(body?.textContent || '');
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⎘'; }, 1500);
      } catch (_) {}
    });
    summary.appendChild(btn);
  }
}

function addCodeCopyButtons() {
  highlightDiffBlocks(messagesEl);
  addThinkCopyButtons(messagesEl);
  for (const pre of messagesEl.querySelectorAll('.msg.assistant pre')) {
    // Add language label (from code[class*="language-xxx"])
    const code = pre.querySelector('code[class*="language-"]');
    if (code && !pre.hasAttribute('data-lang')) {
      const cls = code.className.match(/language-(\w+)/);
      if (cls) pre.setAttribute('data-lang', cls[1]);
    }
    if (pre.querySelector('.code-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const text = code?.textContent || pre.textContent || '';
      try {
        await _copyText(text);
        btn.textContent = '✓';
        showToast('Copied', 'success');
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      } catch (_) {}
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}

// Markdown -> sanitized HTML pipeline with proper LaTeX rendering.
//
// Order of operations matters:
//   1. Extract $...$ and $$...$$ BEFORE marked so markdown syntax (_, *, etc.)
//      inside formulas doesn't get mangled.
//   2. Parse the placeholder-substituted markdown with marked.
//   3. Sanitize with DOMPurify (placeholders are plain text — safe, survive).
//   4. Replace placeholders with KaTeX MathML output AFTER sanitization so
//      DOMPurify never sees (or strips) MathML attributes.
//
// Chrome 114+ supports MathML Core natively, so output:'mathml' works with
// zero extra CSS or font files.
// Lightweight markdown render used during streaming (skips KaTeX + think blocks).
function renderStreamingSafe(text) {
  try {
    return DOMPurify.sanitize(marked.parse(text || ''), {
      ADD_ATTR: ['target', 'rel'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|#)/
    });
  } catch (_) {
    return DOMPurify.sanitize(text || '');
  }
}

function renderSafe(markdown) {
  try {
    const mathParts = []; // { displayMode: bool, formula: string }
    const thinkBlocks = []; // extracted <think>…</think> content

    let md = (markdown || '')
      // Extract <think>/<thinking> blocks before marked (handles Claude + DeepSeek).
      .replace(/<(?:think|thinking|antml:thinking)[^>]*>([\s\S]*?)<\/(?:think|thinking|antml:thinking)>/gi, (_, content) => {
        const i = thinkBlocks.push(content.trim()) - 1;
        return `\n\n<div data-think="${i}"></div>\n\n`;
      })
      // Block math: $$...$$ or \[...\]
      .replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (_, a, b) => {
        const i = mathParts.push({ displayMode: true,  formula: (a ?? b).trim() }) - 1;
        return `\n\nBROWSAMATH${i}END\n\n`;
      })
      // Inline math: $...$ or \(...\)
      .replace(/\$([^$\n]+?)\$|\\\(([^)]+?)\\\)/g, (_, a, b) => {
        const i = mathParts.push({ displayMode: false, formula: (a ?? b).trim() }) - 1;
        return `BROWSAMATH${i}END`;
      });

    let html = marked.parse(md);

    html = DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel', 'data-think'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|#)/
    });

    // Restore rendered math after sanitization — KaTeX output is trusted.
    if (mathParts.length > 0) {
      html = html.replace(/BROWSAMATH(\d+)END/g, (_, idx) => {
        const { displayMode, formula } = mathParts[+idx];
        try {
          return katex.renderToString(formula, {
            output: 'mathml',
            throwOnError: false,
            displayMode,
            strict: false
          });
        } catch (_e) {
          return displayMode
            ? `<div class="math-block">${escM(formula)}</div>`
            : `<code>${escM(formula)}</code>`;
        }
      });
    }

    // Restore think blocks as collapsible <details> elements (after sanitization
    // so DOMPurify never sees the raw inner content).
    if (thinkBlocks.length > 0) {
      html = html.replace(/<div data-think="(\d+)"><\/div>/g, (_, idx) => {
        const inner = DOMPurify.sanitize(marked.parse(thinkBlocks[+idx]));
        return `<details class="think-block"><summary>Thinking…</summary><div class="think-body">${inner}</div></details>`;
      });
    }

    return html;
  } catch (e) {
    return DOMPurify.sanitize(
      (markdown || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;'
      }[c]))
    );
  }
}

function escM(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Clipboard write with execCommand fallback (works in non-secure contexts too).
function _fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  } catch (e) { return Promise.reject(e); }
}
function _copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
  }
  return _fallbackCopy(text);
}

// After every innerHTML update, ensure external links open in new tab with
// rel="noopener noreferrer". Cheap (runs on the bubble subtree only).
function decorateLinks(el) {
  for (const a of el.querySelectorAll('a[href]')) {
    if (a.host && a.host !== location.host) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
}

// Matches <think> / <thinking> opening and closing tags (Claude, DeepSeek, etc.)
const _THINK_OPEN_RE  = /<(think|antml:thinking)(\s[^>]*)?>|<thinking>/i;
const _THINK_CLOSE_RE = /<\/(think|antml:thinking)>|<\/thinking>/i;

// Build a streaming-render closure for a specific bubble.
// During streaming:
//   - <think>/<thinking> content shown in a live collapsible element above the bubble
//   - Non-think text rendered each tick via renderStreamingSafe (marked + DOMPurify)
// At DONE: live think removed; full renderSafe() handles KaTeX + final think blocks.
function makeStreamRenderer(el) {
  let fullAccum = '';
  let raf = null;
  let thinkEl = null;
  let thinkBodyEl = null;

  function ensureThinkEl() {
    if (!thinkEl) {
      thinkEl = document.createElement('details');
      thinkEl.className = 'think-block live-think';
      thinkEl.open = true;
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking…';
      thinkBodyEl = document.createElement('div');
      thinkBodyEl.className = 'think-body';
      thinkEl.appendChild(sum);
      thinkEl.appendChild(thinkBodyEl);
      el.parentNode.insertBefore(thinkEl, el);
    }
  }

  // Split accumulated text into display (non-think) and think portions.
  // Scans the full buffer each tick so partial tags across chunk boundaries are handled.
  function splitThink(text) {
    let display = '';
    let think = '';
    let rest = text;
    let inside = false;
    while (rest.length > 0) {
      if (!inside) {
        const m = _THINK_OPEN_RE.exec(rest);
        if (!m) { display += rest; break; }
        display += rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        inside = true;
      } else {
        const m = _THINK_CLOSE_RE.exec(rest);
        if (!m) { think += rest; break; }
        think += rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        inside = false;
        if (thinkEl) thinkEl.open = false; // collapse once tag closed
      }
    }
    return { display, think };
  }

  return function renderStream(delta, isDone) {
    if (isDone) {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (thinkEl) { thinkEl.remove(); thinkEl = null; thinkBodyEl = null; }
      el.innerHTML = renderSafe(delta);
      el.classList.add('done');
      addThinkCopyButtons(el);
      decorateLinks(el);
      addMsgActions(el, () => delta);
      scrollToBottom(true);
      return;
    }
    fullAccum += delta;
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const { display, think } = splitThink(fullAccum);
      if (think) { ensureThinkEl(); thinkBodyEl.textContent = think; }
      el.innerHTML = renderStreamingSafe(display);
      el.classList.remove('done');
      if (isUserScrolledUp && scrollToBottomBtn) scrollToBottomBtn.classList.add('has-new');
      scrollToBottom();
    });
  };
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
    div.innerHTML = `<img src="${img.dataUrl}" alt="${img.name}" /><button class="rm" data-idx="${i}" title="Remove image">&times;</button>`;
    div.querySelector('.rm').addEventListener('click', () => removeImage(i));
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
  // Session / context management (mirrors personal_ai_assistant)
  '/compact':    'Please compact our conversation: summarize what we have discussed so far into a concise context note, then confirm what you now know.',
  '/context':    'Briefly describe the conversation context and any page content you currently have. What topics have we covered?',
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
  const userBubble = appendUser(rawText || '(page only)');
  userBubble.dataset.hidx = nextHistoryIdx++;  // user turn stored in background CHAT handler
  inputEl.value = '';
  setStreamingUI(true);

  // Placeholder assistant bubble
  const assistantEl = appendAssistant('');
  let acc = '';
  let toolEvents = [];   // accumulate TOOL_PROGRESS events for post-stream history panel
  const renderStream = makeStreamRenderer(assistantEl);

  // Open streaming port FIRST so the background can push CHUNKs as they
  // arrive. We pass the port's name to the background via msg.port; the
  // background matches it to the connected port and pushes deltas back.
  const port = chrome.runtime.connect({ name: 'browsa-chat' });
  activeController = { port, cancelled: false };

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
    port.onMessage.addListener((m) => {
      if (m.type === 'CHUNK') {
        acc += m.delta;
        renderStream(m.delta, false); // smd: pass delta, not accumulated text
        updateOutputTokenCount(m.delta);

      } else if (m.type === 'TOOL_PROGRESS') {
        toolEvents.push(m.text);
        showToolProgress(assistantEl, m.text);

      } else if (m.type === 'RETRY') {
        // Background is retrying a transient network/rate-limit error
        showToolProgress(assistantEl, `⟳ Retrying… (attempt ${m.attempt}/${m.maxAttempts})`, 'warn');

      } else if (m.type === 'DONE') {
        clearToolProgress(assistantEl);
        if (toolEvents.length > 0) {
          renderToolHistory(assistantEl, toolEvents);
          toolEvents = [];
        }
        const finalText = m.full || acc;
        assistantEl.dataset.hidx = nextHistoryIdx++; // assistant turn stored in background
        renderStream(finalText, true);
        addCodeCopyButtons();
        renderMermaid(assistantEl);
        outputTokens = 0;
        // Show token usage if the provider returned it
        if (m.usage) showTokenUsage(assistantEl, m.usage);
        if (m.choiceRequest) renderChoiceRequest(assistantEl, m.choiceRequest);
        // Detect max-turns: agent hit the tool-call ceiling and is asking
        // the user to continue. Show a one-click Continue button.
        if (/reached.*max.*turns|maximum.*turns|max_turns|已达上限|工具调用.*上限|继续.*完成/i.test(finalText)) {
          appendMsgAction(assistantEl, '→ 继续', () => { inputEl.value = '继续'; onSend(); });
        }
        try { port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
        try { port.disconnect(); } catch (_) {}
        sendMessage({ type: 'STREAM_RELEASE', tabId: currentTabId }).catch(() => {});
        reconcileHistoryIdx(); // detect + correct auto-trim drift (fire-and-forget)
      } else if (m.type === 'ERROR') {
        // Only ABORTED reaches here — real errors are re-thrown by background
        // and handled via the !res.ok block below (no pushChunk for real errors).
        if (m.code === 'ABORTED') {
          renderStream(acc ? acc + '\n\n_(cancelled)_' : '_(cancelled)_', true);
        }
      }
    });
  }
  port.onDisconnect.addListener(() => {
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
        renderStream(acc + `\n\n---\n❌ **${errMsg}**`, true);
      } else {
        assistantEl.textContent = `❌ ${errMsg}`;
      }
      appendMsgAction(assistantEl, '↺ 重试', () => {
        if (lastSentRaw) { inputEl.value = lastSentRaw; onSend(); }
      });
      if (res.hint) appendSystem(res.hint);
      // Resync counter — user turn may or may not have been stored.
      reconcileHistoryIdx();
    }
  } catch (e) {
    // sendMessage itself threw (SW restart, no receiver, etc.).
    // The CHAT handler never ran, so the user turn was likely NOT stored.
    if (acc) {
      renderStream(acc + `\n\n---\n❌ **${e.message}**`, true);
    } else {
      assistantEl.textContent = `❌ ${e.message}`;
    }
    appendMsgAction(assistantEl, '↺ 重试', () => {
      if (lastSentRaw) { inputEl.value = lastSentRaw; onSend(); }
    });
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
  let acc = peek.acc || '';
  const initialBubble = getOrCreateAssistantBubble();
  let renderStream = makeStreamRenderer(initialBubble);
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
      renderStream = makeStreamRenderer(el);
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
  port.onMessage.addListener((m) => {
    if (m.type === 'CHUNK') {
      const r = ensureAssistantEl();
      acc += m.delta;
      r(m.delta, false); // smd: pass delta, not accumulated text
      updateOutputTokenCount(m.delta);

    } else if (m.type === 'TOOL_PROGRESS') {
      showToolProgress(assistantEl, m.text);

    } else if (m.type === 'RETRY') {
      showToolProgress(assistantEl, `⟳ Retrying… (attempt ${m.attempt}/${m.maxAttempts})`, 'warn');

    } else if (m.type === 'DONE') {
      const r = ensureAssistantEl();
      clearToolProgress(assistantEl);
      assistantEl.dataset.hidx = nextHistoryIdx++; // assistant turn stored in background
      r(m.full || acc, true);
      addCodeCopyButtons();
      renderMermaid(assistantEl);
      outputTokens = 0;
      if (m.usage) showTokenUsage(assistantEl, m.usage);

      try { port.postMessage({ type: 'STREAM_GOODBYE' }); } catch (_) {}
      try { port.disconnect(); } catch (_) {}
      sendMessage({ type: 'STREAM_RELEASE', tabId }).catch(() => {});
      activeController = null;
      setStreamingUI(false);
      reconcileHistoryIdx();
    } else if (m.type === 'ERROR') {
      // Only ABORTED reaches here (same reasoning as onSend path).
      const el = messagesEl.querySelector('.msg.assistant:last-of-type') || appendAssistant('');
      if (m.code === 'ABORTED') {
        el.textContent = acc ? acc + '\n\n_(cancelled)_' : '_(cancelled)_';
      }
      try { port.disconnect(); } catch (_) {}
    }
  });
  port.onDisconnect.addListener(() => {
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
  activeController = { port, cancelled: false, tabId, resumed: true };
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

function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.dataset.raw = text;
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

  // ↩ Reply / quote
  const replyBtn = document.createElement('button');
  replyBtn.className = 'msg-action-icon';
  replyBtn.title = 'Quote';
  replyBtn.textContent = '↩';
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

  // 🗑 Delete
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-action-icon delete-icon';
  delBtn.title = 'Delete message';
  delBtn.textContent = '🗑';
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

  // ⎘ Copy — only for assistant messages
  if (el.classList.contains('assistant')) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-icon';
    copyBtn.title = 'Copy response';
    copyBtn.textContent = '⎘';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = getRaw() || el.innerText || '';
      try {
        await _copyText(text);
        copyBtn.textContent = '✓';
        showToast('Copied', 'success');
        setTimeout(() => { copyBtn.textContent = '⎘'; }, 2000);
      } catch (_) {
        copyBtn.textContent = '✗';
        setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
      }
    });
    buttons.push(copyBtn);
  }

  wrap.append(...buttons);
  el.appendChild(wrap);
}
/** Show a faint "tool progress" line below a streaming bubble. */
function showToolProgress(bubbleEl, text, tierOverride) {
  if (!bubbleEl) return;
  let el = bubbleEl.nextElementSibling;
  if (!el || !el.classList.contains('tool-progress')) {
    el = document.createElement('div');
    el.className = 'tool-progress';
    bubbleEl.insertAdjacentElement('afterend', el);
  }
  // Classify the progress text into a visual tier so the user can
  // tell at a glance whether the agent is thinking, running a tool,
  // or waiting — mirrors personal_ai_assistant's event-type display.
  let icon = '⚙';
  let tier = tierOverride || '';
  if (!tierOverride) {
    const t = text.toLowerCase();
    if (/think|reason|analyz|consid/.test(t))          { icon = '🤔'; tier = 'thinking'; }
    else if (/search|fetch|web|http|url/.test(t))      { icon = '🔍'; tier = 'searching'; }
    else if (/read|open|load|file|path/.test(t))       { icon = '📖'; tier = 'reading'; }
    else if (/write|edit|creat|sav|updat/.test(t))     { icon = '✏️'; tier = 'writing'; }
    else if (/run|exec|bash|shell|cmd|command/.test(t)){ icon = '💻'; tier = 'running'; }
  }
  el.dataset.tier = tier;
  el.innerHTML = `<span class="tp-icon">${icon}</span><span class="tp-text">${text}</span>`;
}
/** Remove the tool progress indicator once the reply is done. */
function clearToolProgress(bubbleEl) {
  const el = bubbleEl?.nextElementSibling;
  if (el?.classList.contains('tool-progress')) el.remove();
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

  const el = document.createElement('div');
  el.className = 'token-usage';
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const parts = [];
  if (prompt != null) parts.push(`↑ ${fmtK(prompt)}`);
  if (completion != null) parts.push(`↓ ${fmtK(completion)}`);
  el.textContent = parts.join(' · ') + ' tokens';
  el.title = `Prompt: ${prompt ?? '?'} tokens · Completion: ${completion ?? '?'} tokens` +
             (usage.total_tokens ? ` · Total: ${usage.total_tokens}` : '');
  // Insert after the bubble (before any msg-action-row that follows)
  bubbleEl.insertAdjacentElement('afterend', el);
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
}
function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom(true);
  return el;
}

function appendAttachSystem(text) {
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
  summary.textContent = `⚙ ${events.length} step${events.length > 1 ? 's' : ''}`;
  details.appendChild(summary);
  const ul = document.createElement('ul');
  for (const ev of events) {
    const li = document.createElement('li');
    // Re-use the same icon classification as showToolProgress
    let icon = '⚙';
    const t = ev.toLowerCase();
    if (/think|reason|analyz|consid/.test(t))           icon = '🤔';
    else if (/search|fetch|web|http|url/.test(t))       icon = '🔍';
    else if (/read|open|load|file|path/.test(t))        icon = '📖';
    else if (/write|edit|creat|sav|updat/.test(t))      icon = '✏️';
    else if (/run|exec|bash|shell|cmd|command/.test(t)) icon = '💻';
    li.textContent = `${icon} ${ev}`;
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
function appendMsgAction(bubbleEl, label, onClick) {
  // Remove any existing action row on this bubble first (avoid stacking).
  bubbleEl.nextElementSibling?.classList.contains('msg-action-row') &&
    bubbleEl.nextElementSibling.remove();
  const row = document.createElement('div');
  row.className = 'msg-action-row';
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  btn.textContent = label;
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

// ─── Toast notifications ──────────────────────────────────────────────────────
let _toastContainer = null;
function showToast(msg, type) {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.className = 'toast-container';
    document.body.appendChild(_toastContainer);
  }
  if (!type) {
    const low = String(msg).toLowerCase();
    if (/fail|error|denied|invalid|❌/.test(low)) type = 'error';
    else if (/warn|⚠/.test(low)) type = 'warn';
    else if (/cleared|copied|switched|saved|✓/.test(low)) type = 'success';
    else type = 'info';
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const msgEl = document.createElement('span');
  msgEl.textContent = msg;
  toast.appendChild(msgEl);

  if (type === 'error') {
    // Error toasts: Copy + Dismiss, no auto-dismiss
    const copyBtn = document.createElement('button');
    copyBtn.className = 'toast-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => _copyText(msg).catch(() => {}));
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'toast-x';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => toast.remove());
    toast.appendChild(copyBtn);
    toast.appendChild(dismissBtn);
  } else {
    const x = document.createElement('button');
    x.className = 'toast-x';
    x.textContent = '×';
    x.addEventListener('click', () => toast.remove());
    toast.appendChild(x);
    // Auto-dismiss, paused on hover
    const duration = type === 'success' ? 2000 : 3500;
    let timer = setTimeout(() => toast.remove(), duration);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => { timer = setTimeout(() => toast.remove(), duration); });
  }
  _toastContainer.appendChild(toast);
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────
function showConfirmDialog({ title = '', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const modal = document.createElement('div');
    modal.className = 'confirm-modal' + (danger ? ' danger' : '');
    modal.innerHTML = `
      <div class="confirm-title">${escM(title)}</div>
      <div class="confirm-msg">${escM(message)}</div>
      <div class="confirm-btns">
        <button class="confirm-cancel">${escM(cancelLabel)}</button>
        <button class="confirm-ok${danger ? ' danger' : ''}">${escM(confirmLabel)}</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    function done(v) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    }
    function onKey(e) {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    }
    modal.querySelector('.confirm-cancel').addEventListener('click', () => done(false));
    modal.querySelector('.confirm-ok').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey);
    modal.querySelector('.confirm-ok').focus();
  });
}

// ─── Diff syntax highlighting ─────────────────────────────────────────────────
function highlightDiffBlocks(el) {
  for (const code of el.querySelectorAll('code.language-diff, code.language-patch')) {
    if (code.dataset.diffDone) continue;
    code.dataset.diffDone = '1';
    const lines = code.textContent.split('\n');
    code.textContent = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const span = document.createElement('span');
      if (/^@@/.test(line))       span.className = 'diff-hunk';
      else if (line.startsWith('+')) span.className = 'diff-add';
      else if (line.startsWith('-')) span.className = 'diff-del';
      span.textContent = line;
      code.appendChild(span);
      if (i < lines.length - 1) code.appendChild(document.createTextNode('\n'));
    }
  }
}

// ─── Sessions drawer ──────────────────────────────────────────────────────────
// Lazily resolved so we're guaranteed the DOM is ready when first used.
function getSessionsDrawer() { return document.getElementById('sessions-drawer'); }

let _sessionsBackdrop = null;
function getOrCreateBackdrop() {
  if (!_sessionsBackdrop) {
    _sessionsBackdrop = document.createElement('div');
    _sessionsBackdrop.className = 'sessions-backdrop';
    _sessionsBackdrop.addEventListener('click', closeSessionsDrawer);
    document.body.appendChild(_sessionsBackdrop);
  }
  return _sessionsBackdrop;
}

function openSessionsDrawer() {
  const el = getSessionsDrawer();
  if (!el) return;
  el.hidden = false;
  getOrCreateBackdrop().classList.add('active');
  // Reset search filter and clear the input each time drawer opens
  _sessionsFilter = '';
  const searchEl = el.querySelector('.sessions-search');
  if (searchEl) searchEl.value = '';
  renderSessionsList();
}

function onSessionSearch(e) {
  _sessionsFilter = e.target.value;
  renderSessionsList();
}

function closeSessionsDrawer() {
  const el = getSessionsDrawer();
  if (el) el.hidden = true;
  if (_sessionsBackdrop) _sessionsBackdrop.classList.remove('active');
}

let _sessionsFilter = '';
let _renameClickTimer = null; // debounce: distinguish single-click-load from double-click-rename

async function renderSessionsList() {
  const listEl = $('sessions-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const res = await sendMessage({ type: 'GET_SESSIONS' });
  const allSessions = res?.data?.sessions || [];

  // Apply search filter
  const q = _sessionsFilter.trim().toLowerCase();
  const sessions = q ? allSessions.filter(s => s.name.toLowerCase().includes(q)) : allSessions;

  if (!sessions.length) {
    listEl.innerHTML = `<div class="sessions-empty">${q ? 'No sessions match your search.' : 'No saved sessions yet.<br>Start a new session to archive this conversation.'}</div>`;
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';
    const relTime = relativeTime(s.createdAt);
    const absTime = new Date(s.createdAt).toLocaleString();

    item.innerHTML = `
      <div class="session-item-body">
        <div class="session-item-name" title="Double-click to rename">${escM(s.name)}</div>
        <div class="session-item-date" title="${escM(absTime)}">${relTime}</div>
      </div>
      <div class="session-item-actions">
        <button class="session-export-btn" title="Export session as Markdown" data-id="${s.id}" data-name="${escM(s.name)}">⬇</button>
        <button class="session-del-btn" title="Delete session" data-id="${s.id}">🗑</button>
      </div>`;

    // Click body → load session; double-click name → rename.
    // A double-click fires two click events before dblclick — debounce
    // the click so we can cancel it when dblclick arrives.
    const nameEl = item.querySelector('.session-item-name');
    item.querySelector('.session-item-body').addEventListener('click', (e) => {
      if (e.target.closest('.session-item-name')) {
        clearTimeout(_renameClickTimer);
        _renameClickTimer = setTimeout(() => loadSession(s.id, s.name), 220);
      } else {
        loadSession(s.id, s.name);
      }
    });
    nameEl.addEventListener('dblclick', (e) => {
      clearTimeout(_renameClickTimer); // cancel the pending single-click load
      e.stopPropagation();
      startSessionRename(nameEl, s.id);
    });

    // Export button
    item.querySelector('.session-export-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await exportSession(s.id, s.name);
    });

    // Delete button
    item.querySelector('.session-del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showConfirmDialog({ title: 'Delete session', message: `Delete "${s.name}"?`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await sendMessage({ type: 'DELETE_SESSION', id: s.id });
      showToast('Session deleted', 'success');
      renderSessionsList();
    });
    listEl.appendChild(item);
  }
}

/** Inline rename: replaces name text with an input field. */
function startSessionRename(nameEl, sessionId) {
  const oldName = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = oldName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false; // prevent double-commit (Enter fires blur on DOM removal)
  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim() || oldName;
    await sendMessage({ type: 'RENAME_SESSION', id: sessionId, name: newName });
    renderSessionsList();
    if (newName !== oldName) showToast('Session renamed', 'success');
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderSessionsList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit); // normal click-away: save
}

/** Export a saved session as a Markdown file. */
async function exportSession(id, name) {
  const res = await sendMessage({ type: 'GET_SESSION_FULL', id });
  const session = res?.data?.session;
  if (!session) { showToast('Could not load session', 'error'); return; }

  const history = session.history || [];
  const lines = [
    `# ${session.name}`,
    `*Exported: ${new Date().toLocaleString()}*`,
    ''
  ];
  const PAGE_CTX = '[Page context attached by browsa]';
  for (const m of history) {
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : null;
      if (!content) continue;
      if (content.startsWith(PAGE_CTX)) {
        const urlLine = content.split('\n').find(l => l.startsWith('URL:')) || '';
        lines.push(`---\n\n*(page context${urlLine ? ' — ' + urlLine.slice(4).trim() : ''})*\n`);
        continue;
      }
      lines.push(`## User\n\n${content}\n`);
    } else if (m.role === 'assistant') {
      lines.push(`## Assistant\n\n${m.content}\n`);
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = (name || 'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').slice(0, 40);
  a.download = `browsa-${slug}-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Session exported', 'success');
}

/** Clear all saved sessions with confirmation. */
async function clearAllSessions() {
  const ok = await showConfirmDialog({
    title: 'Clear all sessions',
    message: 'Delete all saved sessions? This cannot be undone.',
    confirmLabel: 'Clear all',
    danger: true
  });
  if (!ok) return;
  await sendMessage({ type: 'CLEAR_ALL_SESSIONS' });
  showToast('All sessions cleared', 'success');
  renderSessionsList();
}

async function loadSession(id, name) {
  // Cancel any in-progress stream before switching sessions.
  if (activeController && !activeController.cancelled) cancelStream();
  // Auto-save current conversation before switching
  const { history } = await chrome.storage.local.get('history');
  const hasMessages = Array.isArray(history) && history.some(m => m.role === 'user' || m.role === 'assistant');
  if (hasMessages) {
    await sendMessage({ type: 'SAVE_SESSION' });
  }
  const res = await sendMessage({ type: 'LOAD_SESSION', id });
  if (!res?.ok && !res?.data?.ok) { showToast('Failed to load session', 'error'); return; }
  await renderHistory();
  scrollToBottom(true);
  closeSessionsDrawer();
  showToast(`Loaded: "${name}"`, 'success');
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
  modal.innerHTML = `
    <div class="confirm-title">Effective System Prompt</div>
    <div class="prompt-inspector-url">${escM(tabUrl || '(no page)')}</div>
    ${sections.length
      ? sections.map(s => `
          <div class="prompt-section-label">${escM(s.label)}</div>
          <pre class="prompt-section-body">${escM(s.text)}</pre>`).join('')
      : '<p style="color:var(--muted);font-size:13px">No system prompt configured.</p>'
    }
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button class="pi-copy">⎘ Copy full prompt</button>
      <button class="pi-close confirm-ok">Close</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const fullPrompt = sections.map(s => s.text).join('\n\n');
  modal.querySelector('.pi-copy').addEventListener('click', async () => {
    await _copyText(fullPrompt).catch(() => {});
    showToast('Copied', 'success');
  });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  modal.querySelector('.pi-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } }
  document.addEventListener('keydown', onKey);
}

async function exportHistory() {
  const { history } = await chrome.storage.local.get('history');
  const list = Array.isArray(history) ? history : [];
  if (!list.length) { showToast('No conversation to export', 'info'); return; }

  const lines = [
    '# browsa conversation export',
    `*Exported: ${new Date().toLocaleString()}*`,
    ''
  ];
  for (const m of list) {
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : null;
      if (!content) continue; // skip image-only messages
      if (content.startsWith('[Page context attached by browsa]')) {
        // Render page-context messages as a small divider, not a full user bubble
        const urlLine = content.split('\n').find(l => l.startsWith('URL:')) || '';
        lines.push(`---\n\n*(page context attached${urlLine ? ' — ' + urlLine.slice(4).trim() : ''})*\n`);
        continue;
      }
      lines.push(`## User\n\n${content}\n`);
    } else if (m.role === 'assistant') {
      lines.push(`## Assistant\n\n${m.content}\n`);
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `browsa-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Conversation exported', 'success');
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      // Wrap in try/catch — when there's no receiver (e.g. service worker restarting),
      // chrome.runtime.lastError is set; resolve with a structured error.
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message, code: 'NoReceiver' });
      } else {
        resolve(res || { ok: false, error: 'no response', code: 'NoResponse' });
      }
    });
  });
}

// Prefix used to identify page-context messages saved to history.
// These are sent to the LLM for context but should not clutter the chat UI.
const PAGE_CONTEXT_PREFIX = '[Page context attached by browsa]';

async function renderHistory() {
  messagesEl.innerHTML = '';
  const { history } = await chrome.storage.local.get('history');
  const list = Array.isArray(history) ? history : [];
  nextHistoryIdx = list.length; // keep local mirror in sync with storage
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role === 'user') {
      if (Array.isArray(m.content)) continue;
      if (m.content.startsWith(PAGE_CONTEXT_PREFIX)) continue;
      const el = appendUser(m.content);
      el.dataset.hidx = i;
    } else if (m.role === 'assistant') {
      const rawContent = m.content;
      const el = appendAssistant('', true);
      el.innerHTML = renderSafe(rawContent);
      decorateLinks(el);
      addMsgActions(el, () => rawContent);
      renderMermaid(el);
      el.dataset.hidx = i;
    }
  }
  addCodeCopyButtons();
  scrollToBottom(true);
}
