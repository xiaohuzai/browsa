// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG / SET_CONFIG: read/write storage
//   - CLEAR_HISTORY: clear per-tab history

import * as storage from './lib/storage.js';
import { chatStream, chat, responsesApiStream, healthCheck, getCapabilities, ping, ProviderConfigError, ProviderAPIError, ProviderNetworkError } from './lib/openai-client.js';
// Session management re-exported from storage for use in handle()
const { saveCurrentSession, getSavedSessions, loadSession, deleteSession, renameSession } = storage;
import { extractActiveTab, buildMessages, buildPageContextText, ensureReadabilityInjected } from './lib/page-extractor.js';

// Allow side panel to open on action click (Chrome MV3)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('browsa: setPanelBehavior failed', e));

// Right-click context menu — text selection + image contexts.
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: 'browsa', title: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-ask',       title: '💬 Ask',                   parentId: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-explain',   title: '🔍 Explain',               parentId: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-translate', title: '🌐 Translate to Chinese',  parentId: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-summarize', title: '📝 Summarize',             parentId: 'browsa', contexts: ['selection'] });
  // Image context menu
  chrome.contextMenus.create({ id: 'browsa-image-ask', title: '🖼 Ask browsa about this image', contexts: ['image'] });

  if (details.reason === 'install' || details.reason === 'update') {
    // Best-effort: re-inject the selection toolbar into already-open tabs.
    // Removes the old host element first so old detached handlers are harmless.
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (!tab.id || !tab.url?.startsWith('https://')) continue;
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            document.getElementById('browsa-sel-host')?.remove();
            delete window.__browsaSelectionToolbarInstalled;
          }
        }).then(() => chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/selection-toolbar.js']
        })).catch(() => {});
      }
    });

    // Show a badge + side-panel notice on update so the user knows
    // something changed and can refresh any page that still feels stale.
    if (details.reason === 'update') {
      const { version } = chrome.runtime.getManifest();
      chrome.storage.local.set({ pendingUpdateNotice: version });
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#238636' });
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  // ── Image right-click ────────────────────────────────────────────────────
  if (info.menuItemId === 'browsa-image-ask') {
    const srcUrl = info.srcUrl;
    if (!srcUrl) return;

    // Fetch the image inside the page's MAIN world so cookies + CORS headers
    // are automatically applied (e.g. authenticated CDN images on XHS, etc.).
    let dataUrl = null;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (url) => {
          try {
            const r = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(8000) });
            if (!r.ok) return null;
            const blob = await r.blob();
            // Resize to max 1024px and encode as JPEG to keep size reasonable
            return await new Promise((resolve) => {
              const img = new Image();
              img.onload = () => {
                const maxDim = 1024;
                let w = img.naturalWidth, h = img.naturalHeight;
                if (w > maxDim || h > maxDim) {
                  const s = Math.min(maxDim / w, maxDim / h);
                  w = Math.round(w * s); h = Math.round(h * s);
                }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(c.toDataURL('image/jpeg', 0.85));
                URL.revokeObjectURL(img.src);
              };
              img.onerror = () => resolve(null);
              img.src = URL.createObjectURL(blob);
            });
          } catch (_) { return null; }
        },
        args: [srcUrl],
        world: 'MAIN'
      });
      dataUrl = res?.result || null;
    } catch (_) {}

    // Fall back to raw URL if fetch failed (public images, no auth needed)
    const imagePayload = dataUrl || srcUrl;

    const payload = { type: 'IMAGE_ACTION', dataUrl: imagePayload, srcUrl };
    const set = navPorts.get(tab.id);
    let relayed = false;
    if (set && set.size > 0) {
      for (const p of set) {
        try { p.postMessage(payload); relayed = true; } catch (_) {}
      }
    }
    if (!relayed) {
      chrome.storage.session.set({ pendingImageAction: { tabId: tab.id, dataUrl: imagePayload, srcUrl } }).catch(() => {});
      try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
    }
    return;
  }

  // ── Text selection right-click ────────────────────────────────────────────
  // On Mac, a two-finger trackpad tap resets the visual selection to the
  // word under the cursor BEFORE contextmenu fires, so info.selectionText
  // is often just that one word — not the user's actual selection.
  // The content script's contextmenu event handler re-sends the original
  // selection to selectionCache just before this callback fires.
  const text = (selectionCache.get(tab.id) || info.selectionText || '').trim();
  if (!text) return;

  const actionMap = {
    'browsa-ask':       'chat',
    'browsa-explain':   'explain',
    'browsa-translate': 'translate',
    'browsa-summarize': 'summarize'
  };
  const action = actionMap[info.menuItemId];
  if (!action) return;

  selectionCache.set(tab.id, text);

  const set = navPorts.get(tab.id);
  let relayed = false;
  if (set && set.size > 0) {
    for (const p of set) {
      try { p.postMessage({ type: 'SELECTION_ACTION', action, text }); relayed = true; } catch (_) {}
    }
  }
  if (!relayed) {
    pendingSelectionActions.set(tab.id, { action, text });
    chrome.storage.session.set({ pendingSelectionAction: { tabId: tab.id, action, text } }).catch(() => {});
    try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
  }
});

// Streaming port: the side panel opens a long-lived port named 'browsa-chat'
// before sending the CHAT message. As soon as the background's CHAT handler
// has the first delta from the LLM, it pushes it back through this port.
// We keep a registry keyed by tabId so multiple tabs (each with their own
// side panel) can stream independently.
export const streamPorts = new Map(); // tabId -> Port

// Stream state survives port churn. When the side panel is torn down (the
// user switches tabs and Chrome destroys the panel), the streaming port
// disconnects, but the LLM request keeps running on the background. We
// stash the accumulated reply here so a freshly-opened side panel can
// peek + resume from where the old panel left off — fixes the
// "switch tab mid-stream → reply appears stuck" bug.
export const streamState = new Map(); // tabId -> { acc: string, startedAt: number, lastDeltaAt: number }

// AbortControllers per in-flight chat, keyed by tabId. The side panel
// sends STREAM_ABORT to cancel — the controller kills the HTTP fetch
// AND the SSE read loop (see openai-client.js). Without this, cancel
// was a no-op: the LLM kept streaming, the user saw a "cancelled"
// notice, and a phantom assistant turn got written to history.
export const chatControllers = new Map(); // tabId -> AbortController

// If a brand-new side panel arrives mid-stream (via STREAM_HELLO while
// streamState has a non-empty acc for that tab), we drain the accumulated
// text into the new port as one synthetic CHUNK, then keep pushing new
// deltas through the new port. streamPorts.get(tabId) is the *current*
// owner; older owners get safely disconnected.

// Navigation port: a separate long-lived port ('browsa-nav') the side panel
// opens on init. The background uses chrome.webNavigation to detect SPA
// route changes (pushState/popstate/replaceState) inside any tab, and
// pushes the new {url, title} to every nav-port that has registered for
// that tab. This is what keeps the side panel's page-meta UI in sync with
// the user's actual location when they're clicking around inside a SPA
// like 小红书 — vanilla chrome.tabs.onUpdated does NOT fire for history-API
// navigation.
const navPorts = new Map(); // tabId -> Set<Port>

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'browsa-chat') {
    // The side panel sends a "hello" with its tabId so we know which tab this
    // port belongs to. We can't accept a Port over sendMessage, so we handshake.
    let claimedTabId = null;
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'STREAM_HELLO' && typeof msg.tabId === 'number') {
        claimedTabId = msg.tabId;
        // If another panel already owns this tab's port (shouldn't happen
        // in practice — chrome.sidePanel is 1-per-tab — but defensive),
        // disconnect the old one so the old session releases its UI lock.
        const oldPort = streamPorts.get(claimedTabId);
        if (oldPort && oldPort !== port) {
          try { oldPort.disconnect(); } catch (_) {}
        }
        streamPorts.set(claimedTabId, port);
        console.log('browsa[bg]: stream port registered for tab', claimedTabId);
        // Acknowledge so the side panel knows it's safe to send CHAT. This
        // prevents a race where the first LLM chunk arrives before we have
        // the port in our Map.
        try { port.postMessage({ type: 'STREAM_HELLO_ACK' }); } catch (_) {}
        // NOTE: we deliberately do NOT push a synthetic drain CHUNK
        // from HELLO. The side panel already has the accumulated text
        // from the STREAM_PEEK it called before opening the port —
        // it pre-renders that itself, so pushing the same text again
        // from here would double the reply (acc += st.acc, twice).
      } else if (msg && msg.type === 'STREAM_GOODBYE' && claimedTabId != null) {
        // Side panel is signing off cleanly (cancel or after-DONE cleanup).
        // We DON'T delete streamState here — the CHAT handler owns its
        // lifetime so a STREAM_PEEK on a freshly-arriving panel can still
        // recover the accumulated text. The CHAT handler clears it after
        // appendToHistory. If the panel is gone for good (tab closed, page
        // navigated away), a safety-net GC in the message handler drops
        // stale entries older than STREAM_STATE_TTL_MS.
        try { port.disconnect(); } catch (_) {}
        if (streamPorts.get(claimedTabId) === port) {
          streamPorts.delete(claimedTabId);
        }
        console.log('browsa[bg]: stream port released for tab', claimedTabId);
      }
    });
    port.onDisconnect.addListener(() => {
      if (claimedTabId != null) {
        // CRITICAL: do NOT delete streamState here. The LLM request is
        // still running on the background — only the port died because
        // the side panel iframe got destroyed (chrome.sidePanel tears
        // down the document on tab switch). When the user switches back
        // and a new port opens, STREAM_HELLO above will drain the acc
        // and resume the stream.
        if (streamPorts.get(claimedTabId) === port) {
          streamPorts.delete(claimedTabId);
        }
        console.log('browsa[bg]: stream port disconnected for tab', claimedTabId);
      }
    });
    return;
  }

  if (port.name === 'browsa-nav') {
    // The nav port is a firehose: the side panel sends a hello with its
    // current tabId, but the background may push NAVIGATED events for ANY
    // tab (because webNavigation.onHistoryStateUpdated fires for any tab
    // we're allowed to see). The side panel filters by tabId on its end.
    let claimedTabId = null;
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'NAV_HELLO' && typeof msg.tabId === 'number') {
        claimedTabId = msg.tabId;
        if (!navPorts.has(claimedTabId)) navPorts.set(claimedTabId, new Set());
        navPorts.get(claimedTabId).add(port);
        console.log('browsa[bg]: nav port registered for tab', claimedTabId);
        try { port.postMessage({ type: 'NAV_HELLO_ACK' }); } catch (_) {}
      } else if (msg && msg.type === 'NAV_GOODBYE' && claimedTabId != null) {
        const set = navPorts.get(claimedTabId);
        if (set) {
          set.delete(port);
          if (set.size === 0) navPorts.delete(claimedTabId);
        }
      } else if (msg && msg.type === 'NAV_FOLLOW' && typeof msg.tabId === 'number') {
        // Side panel can switch which tab it's watching (e.g. user clicked
        // a different tab in the browser). Re-register.
        if (claimedTabId != null && claimedTabId !== msg.tabId) {
          const oldSet = navPorts.get(claimedTabId);
          if (oldSet) oldSet.delete(port);
        }
        claimedTabId = msg.tabId;
        if (!navPorts.has(claimedTabId)) navPorts.set(claimedTabId, new Set());
        navPorts.get(claimedTabId).add(port);
      }
    });
    port.onDisconnect.addListener(() => {
      if (claimedTabId != null) {
        const set = navPorts.get(claimedTabId);
        if (set) {
          set.delete(port);
          if (set.size === 0) navPorts.delete(claimedTabId);
        }
        console.log('browsa[bg]: nav port disconnected for tab', claimedTabId);
      }
    });
    return;
  }
});

function pushChunk(tabId, payload) {
  const port = streamPorts.get(tabId);
  if (port) safePost(port, payload);
}

// Initialize a streamState record for a tab when CHAT starts. Called by
// the CHAT handler before the first onDelta arrives. This is what lets a
// mid-stream tab switch survive the port disconnect.
export function initStreamState(tabId) {
  streamState.set(tabId, { acc: '', startedAt: Date.now(), lastDeltaAt: 0 });
}

// Update streamState.acc as deltas stream in. Cheap — runs on every chunk
// (typically dozens to hundreds per second). The acc is what the next
// side panel session will render as its "starting point" via STREAM_PEEK.
export function appendToStreamState(tabId, delta) {
  const st = streamState.get(tabId);
  if (st) {
    st.acc += delta;
    st.lastDeltaAt = Date.now();
  }
}

// Drop the streamState once the reply is fully persisted to history and
// the active side panel has acknowledged. Called by the CHAT handler
// right after appendToHistory (so the persisted reply is the same as
// streamState.acc — single source of truth for "what the user sees").
export function clearStreamState(tabId) {
  streamState.delete(tabId);
}

// GC for stale streamState entries. A stream can be orphaned when a tab
// is closed (or crashes) mid-stream before the CHAT handler's finally{} runs.
// Entries older than STREAM_STATE_TTL_MS are safe to drop — the side panel
// would never PEEK them because the tab is gone.
//
// MV3 service workers can sleep between events, so a setTimeout/setInterval
// would be cleared on sleep. We use chrome.alarms (which survives sleep) to
// guarantee GC runs even when the extension is idle for long periods.
const STREAM_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GC_ALARM_NAME = 'browsa-stream-gc';
const GC_ALARM_PERIOD_MINUTES = 5;

function gcStreamState() {
  const now = Date.now();
  for (const [tabId, st] of streamState.entries()) {
    if (now - st.startedAt > STREAM_STATE_TTL_MS) {
      streamState.delete(tabId);
      console.log('browsa[bg]: GC stale streamState for tab', tabId);
    }
  }
}

// Register a periodic alarm on service-worker startup. chrome.alarms.create
// is idempotent when given the same name — repeated calls just update the
// schedule, so registering on every startup is safe.
chrome.alarms.create(GC_ALARM_NAME, { periodInMinutes: GC_ALARM_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GC_ALARM_NAME) gcStreamState();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Every handler is async; return true to keep the channel open.
  (async () => {
    try {
      const result = await handle(msg, sender);
      sendResponse({ ok: true, data: result });
    } catch (e) {
      console.error('browsa: handler error', msg?.type, e);
      const code = e?.name || 'Error';
      let hint = '';
      if (code === 'ProviderConfigError') hint = '⚠️ Missing config. Open Settings (⚙) and configure a provider.';
      else if (code === 'ProviderNetworkError') hint = '🌐 Cannot reach API server. Check base URL in Settings. Is the server running?';
      else if (code === 'ProviderAPIError') {
        const errMsg = e?.message || '';
        if (errMsg.includes('401')) hint = '🔑 Invalid API key. Check Settings → API Key.';
        else if (errMsg.includes('403')) hint = '🚫 Forbidden. The server may need CORS enabled or a valid API key.';
        else if (errMsg.includes('404')) hint = '🔗 API endpoint not found. Check base URL → /v1/chat/completions.';
        else if (errMsg.includes('429')) hint = '⏳ Rate limited. Wait a moment and try again.';
        else hint = '❌ API error. Check server logs.';
      }
      sendResponse({ ok: false, error: e?.message || String(e), code, hint });
    }
  })();
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'GET_CONFIG': {
      return storage.getAll();
    }

    case 'XHS_XHR_NOTE': {
      // Sent by the content script. tabId is in msg.tabId, the note
      // summary is in msg.note. We trust the content script's tabId
      // because the sender can't be impersonated (content scripts
      // only run in pages matching our content_scripts.matches).
      pushXhsNote(msg.tabId, msg.note);
      return { ok: true };
    }

    case 'GET_XHS_NOTE': {
      const t = msg.tabId;
      return { note: xhsXhrCache.get(t) || null };
    }

    case 'SELECTION_CACHE': {
      // Content script sends this on every selectionchange. We only store
      // non-empty selections — clicking elsewhere clears the visual selection
      // but we deliberately keep the cache so the user can still use 📎
      // or the floating toolbar after clicking into the side panel.
      const tabId = sender?.tab?.id;
      if (tabId && msg.text) selectionCache.set(tabId, msg.text);
      return { ok: true };
    }

    case 'SELECTION_ACTION': {
      // Sent by lib/selection-toolbar.js when user clicks a toolbar button.
      const tabId = sender?.tab?.id;
      if (!tabId) return { ok: false };
      const { action, text } = msg;
      // Try relaying to the side panel through the existing nav port.
      const set = navPorts.get(tabId);
      let relayed = false;
      if (set && set.size > 0) {
        for (const p of set) {
          try { p.postMessage({ type: 'SELECTION_ACTION', action, text }); relayed = true; } catch (_) {}
        }
      }
      if (!relayed) {
        // navPort not registered yet — the SW just woke up and navPorts is
        // empty (module-level Map resets on every SW restart). A setTimeout
        // retry won't work because the SW goes back to sleep as soon as this
        // message handler returns. Instead, persist to chrome.storage.session
        // which survives SW restarts. The side panel picks it up via
        // storage.onChanged or on navPort reconnect.
        pendingSelectionActions.set(tabId, { action, text });
        chrome.storage.session.set({ pendingSelectionAction: { tabId, action, text } }).catch(() => {});
        try { await chrome.sidePanel.open({ tabId }); } catch (_) {}
      }
      return { ok: true };
    }

    case 'GET_PENDING_ACTION': {
      const tabId = msg.tabId;
      // Check in-memory Map first (fast path, same SW instance).
      // Fall back to session storage (survives SW restarts).
      let pending = pendingSelectionActions.get(tabId) || null;
      if (pending) {
        pendingSelectionActions.delete(tabId);
        chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
      } else {
        const sess = await chrome.storage.session.get('pendingSelectionAction').catch(() => ({}));
        if (sess.pendingSelectionAction) {
          // Accept any pending action regardless of tabId — the panel may have
          // switched tabs between the selection and the SW restart.
          pending = { action: sess.pendingSelectionAction.action, text: sess.pendingSelectionAction.text };
          chrome.storage.session.remove('pendingSelectionAction').catch(() => {});
        }
      }
      return { pending };
    }

    case 'YOUTUBE_DATA': {
      const tabId = sender?.tab?.id;
      if (tabId) youtubeCache.set(tabId, msg.video);
      return { ok: true };
    }

    case 'JUEJIN_ARTICLE': {
      const tabId = sender?.tab?.id;
      if (tabId) juejinCache.set(tabId, msg.article);
      return { ok: true };
    }

    case 'ZHIHU_CONTENT': {
      const tabId = sender?.tab?.id;
      if (tabId) zhihuCache.set(tabId, msg.content);
      return { ok: true };
    }

    case 'DEDAO_ARTICLE': {
      const tabId = sender?.tab?.id;
      if (tabId) dedaoCache.set(tabId, msg.article);
      return { ok: true };
    }

    case 'GEEKTIME_ARTICLE': {
      const tabId = sender?.tab?.id;
      if (tabId) geektimeCache.set(tabId, msg.article);
      return { ok: true };
    }

    case 'SET_ACTIVE_PROVIDER': {
      await storage.setActiveProvider(msg.name);
      return { activeProvider: msg.name };
    }

    case 'SET_CONTEXT_MODE': {
      await storage.setContextMode(msg.mode);
      return { contextMode: msg.mode };
    }

    case 'UNDO_ATTACH': {
      const removedIdx = await storage.removeLastPageContext();
      return { ok: removedIdx >= 0, removedIdx };
    }

    case 'REMOVE_HISTORY_ENTRY_BY_INDEX': {
      const removed = await storage.removeHistoryEntryByIndex(msg.index);
      return { ok: removed };
    }

    case 'TRUNCATE_HISTORY_FROM_INDEX': {
      const ok = await storage.truncateHistoryFromIndex(msg.index);
      return { ok };
    }

    case 'ATTACH_SCREENSHOT_CONFIRM': {
      // Side panel confirmed the screenshot (possibly cropped). Store it now.
      const { imageDataUrl, metaUrl, metaTitle } = msg;
      if (!imageDataUrl) return { ok: false, error: 'no imageDataUrl' };
      const contextText =
        `[Page context attached by browsa]\nURL: ${metaUrl || ''}\nTitle: ${metaTitle || ''}\nMode: screenshot\n---\n\n(screenshot)`;
      await storage.appendToHistory({
        role: 'user',
        content: [
          { type: 'text', text: contextText },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
      return { ok: true };
    }

    case 'SAVE_SESSION': {
      const session = await saveCurrentSession(msg.name || '');
      return { ok: !!session, session };
    }

    case 'GET_SESSIONS': {
      const sessions = await getSavedSessions();
      return { sessions };
    }

    case 'LOAD_SESSION': {
      const len = await loadSession(msg.id);
      return { ok: len >= 0, len };
    }

    case 'DELETE_SESSION': {
      await deleteSession(msg.id);
      return { ok: true };
    }

    case 'RENAME_SESSION': {
      await renameSession(msg.id, msg.name || '');
      return { ok: true };
    }

    case 'CLEAR_ALL_SESSIONS': {
      await storage.clearAllSessions();
      return { ok: true };
    }

    case 'GET_SESSION_FULL': {
      const session = await storage.getSessionFull(msg.id);
      return { session };
    }

    case 'CLEAR_HISTORY': {
      await storage.clearHistory();
      // Reset session IDs for all providers so the next conversation
      // starts a fresh Hermes session (no bleed-over from the old one).
      const allCfg = await storage.getAll();
      for (const name of Object.keys(allCfg.providers || {})) {
        if (allCfg.providers[name]?.useResponsesApi) {
          await storage.resetConversationId(name);
        }
      }
      console.log('browsa[bg]: global history cleared');
      return { cleared: true };
    }

    case 'ATTACH_PAGE': {
      // User explicitly clicked "📎 Attach page". Extract the current page,
      // save it to global history as a user message, and return the result
      // so the side panel can render a context bubble.
      const tabId = msg.tabId ?? tabIdOf(msg, sender);
      if (!tabId) return { ok: false, error: 'no tabId' };
      const all = await storage.getAll();
      const mode = msg.mode || all.contextMode || 'reader';
      try {
        let ctx;
        // For 'selected' mode, use the cached selection (captured before focus
        // shifted to the side panel, which clears window.getSelection()).
        if (mode === 'selected') {
          // Prefer the live cache; fall back to msg.text (passed explicitly by
          // handleSelectionAction when the SW was sleeping and SELECTION_CACHE
          // was dropped — right-click / toolbar path always has the text).
          const cachedText = selectionCache.get(tabId) || msg.text || '';
          if (cachedText) selectionCache.set(tabId, cachedText); // keep in sync
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          const meta = tab ? { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl || '' } : { url: '', title: '', favIconUrl: '' };
          if (!cachedText) return { ok: false, error: 'No text selected. Select some text on the page first, then click 📎.' };
          ctx = {
            meta, mode: 'selected',
            text: cachedText,
            truncated: { rawTextLength: cachedText.length, textLength: cachedText.length, wasCapped: false }
          };
        } else {
          // auto and reader modes may need Readability; dom/full don't
          if (mode === 'reader' || mode === 'auto') await ensureReadabilityInjected(tabId).catch(() => {});
          ctx = await extractActiveTab({
            mode,
            maxTextChars: all.maxTextChars,
            xhsXhrNote: xhsXhrCache.get(tabId) || null,
            siteCache: getSiteCache(tabId)
          });
          if (!ctx) return { ok: false, error: 'extraction returned null' };
        }
        // Screenshot mode: don't store to history yet. The side panel shows
        // a crop UI first; once the user confirms (with or without a crop),
        // it calls ATTACH_SCREENSHOT_CONFIRM with the final image data URL.
        if (mode === 'screenshot' && ctx.imageDataUrl) {
          return { ok: true, ctx };
        }
        // Apply mask rules (sensitive data redaction) before storing
        const maskRules = all.maskRules || [];
        if (maskRules.length && ctx.text) {
          let masked = ctx.text;
          for (const rule of maskRules) {
            if (!rule.pattern) continue;
            try {
              const re = new RegExp(rule.pattern, rule.flags || 'gi');
              masked = masked.replace(re, rule.replacement || '***');
            } catch (_) {}
          }
          ctx.text = masked;
        }

        // All other modes: save to global history immediately.
        const contextText = buildPageContextText(ctx);
        const historyEntry = { role: 'user', content: contextText };
        await storage.appendToHistory(historyEntry);
        console.log(`browsa[bg]: page attached — ${contextText.length} chars, mode=${mode}`);
        return { ok: true, ctx };
      } catch (e) {
        console.warn('browsa: ATTACH_PAGE failed', e);
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'OPEN_OPTIONS_TAB': {
      // The side panel can't reliably call chrome.runtime.openOptionsPage()
      // (it sometimes silently no-ops). Open the options page in a new tab
      // from the service worker, which has the necessary chrome.tabs.create
      // permission (host_permissions cover all URLs).
      const url = msg.url || chrome.runtime.getURL('options.html');
      await chrome.tabs.create({ url });
      return { opened: true };
    }

    case 'STREAM_PEEK': {
      // Side panel asks "is there an in-flight stream for this tab, and
      // if so, what do you have so far?" Used on init / tab switch to
      // rehydrate the assistant bubble from streamState.acc.
      const t = msg.tabId;
      const st = streamState.get(t);
      if (!st) return { inFlight: false };
      return {
        inFlight: true,
        acc: st.acc,
        startedAt: st.startedAt,
        lastDeltaAt: st.lastDeltaAt
      };
    }

    case 'STREAM_RELEASE': {
      // Side panel signals it's done with the streamState (after rendering
      // DONE, or because the user cancelled). Idempotent — safe to call
      // when no state exists. The CHAT handler also calls
      // clearStreamState on its own, so this is mostly a fast-path for
      // the cancel button.
      const t = msg.tabId;
      if (t != null) clearStreamState(t);
      return { released: true };
    }

    case 'STREAM_ABORT': {
      // Side panel hit Esc / clicked cancel. Trigger the AbortController
      // that the CHAT handler stored in chatControllers. The fetch and
      // SSE loop both respect the signal, so the LLM stops within ~1
      // chunk. The CHAT handler's catch block pushes an ERROR {code:
      // 'ABORTED'} and returns without writing to history.
      const t = msg.tabId;
      const controller = chatControllers.get(t);
      if (controller) {
        try { controller.abort('user-cancel'); } catch (_) {}
      }
      clearStreamState(t);
      return { aborted: !!controller };
    }

    case 'STREAM_DEBUG': {
      // Observability endpoint for the side panel. Returns the full
      // state of streamState, streamPorts, and chatControllers so we
      // can debug "switch tab and come back → reply appears stuck"
      // bugs by inspecting actual Map contents from devtools.
      // This is what tells us whether a stream is in-flight from the
      // background's perspective vs the side panel's perspective.
      const out = {
        streamState: {},
        streamPorts: {},
        chatControllers: {}
      };
      for (const [tabId, st] of streamState.entries()) {
        out.streamState[tabId] = {
          accLen: st.acc.length,
          accPreview: st.acc.slice(0, 80),
          startedAt: st.startedAt,
          lastDeltaAt: st.lastDeltaAt,
          msSinceLastDelta: Date.now() - st.lastDeltaAt
        };
      }
      for (const [tabId, port] of streamPorts.entries()) {
        out.streamPorts[tabId] = '<Port>';
      }
      for (const [tabId, _ctrl] of chatControllers.entries()) {
        out.chatControllers[tabId] = '<AbortController>';
      }
      return out;
    }

    case 'GET_PAGE_CONTEXT': {
      const all = await storage.getAll();
      const mode = msg.mode || all.contextMode || 'auto';
      if (mode === 'reader' || mode === 'auto') {
        await ensureReadabilityInjected(tabIdOf(msg, sender)).catch(() => {});
      }
      const t = tabIdOf(msg, sender);
      const ctx = await extractActiveTab({
        mode,
        maxTextChars: all.maxTextChars,
        xhsXhrNote: (typeof t === 'number') ? (xhsXhrCache.get(t) || null) : null,
        siteCache: (typeof t === 'number') ? getSiteCache(t) : null
      });
      return ctx;
    }

    case 'PING_PROVIDER': {
      const { name, baseUrl, apiKey, model } = msg;
      let cfg;
      if (name) {
        cfg = (await storage.getAll()).providers[name];
        if (!cfg) throw ProviderConfigError(`Provider "${name}" not configured`);
        cfg = { ...cfg, name };
      } else {
        cfg = { baseUrl, apiKey, model };
      }
      const reply = await ping({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
      return { reply };
    }

    case 'CHAT': {
      // Stream a chat turn. Page context is NOT extracted here — the user
      // explicitly attaches it via ATTACH_PAGE before asking questions.
      // History is now global (single session across all tabs).
      const all = await storage.getAll();
      const provider = all.providers[all.activeProvider];
      if (!provider) throw ProviderConfigError(`Provider "${all.activeProvider}" not configured`);
      if (!provider.baseUrl?.trim()) throw ProviderConfigError('Base URL is not set. Open Settings (⚙) and configure the provider.');

      const tabId = msg.tabId;
      if (tabId == null) throw new Error('tabId required');

      // Build effective system prompt: base + per-domain rule + llms.txt
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const tabUrl = tab?.url || '';
      const domainRules = all.domainRules || [];
      const matchedRule = domainRules.find(r => r.pattern && tabUrl.includes(r.pattern));
      const domainExtra = matchedRule?.prompt?.trim() || '';
      const llmsTxt = (all.llmsTxtEnabled !== false) && tabUrl ? await fetchLlmsTxt(tabUrl) : null;
      const llmsTxtExtra = llmsTxt
        ? `\n\n[Site instructions from ${(() => { try { return new URL(tabUrl).origin; } catch(_){return tabUrl;} })()}/llms.txt]\n${llmsTxt}`
        : '';
      const langMap = { en: 'Please always respond in English.', zh: '请始终用中文回答。', ja: '常に日本語で回答してください。', ko: '항상 한국어로 답변해 주세요.', de: 'Bitte antworte immer auf Deutsch.', fr: 'Veuillez toujours répondre en français.', es: 'Por favor, responde siempre en español.' };
      const langExtra = langMap[all.replyLanguage] || '';
      const effectiveSystemPrompt = [all.systemPrompt || '', domainExtra, llmsTxtExtra, langExtra]
        .map(s => s.trim()).filter(Boolean).join('\n\n');

      // Load global history
      const history = await storage.getHistory();

      // Hermes /v1/responses API: stateful, server stores conversation history.
      // Only the current input is sent — Hermes remembers previous turns via
      // the `conversation` UUID. The first turn includes any attached page
      // context so Hermes learns it; subsequent turns send only the new message.
      const useResponsesApi = !!(provider.useResponsesApi);

      let messages = null;       // used by chat/chatStream (stateless)
      let responsesInput = null; // used by responsesApiStream (stateful)
      let responsesConversation = null;
      let extraHeaders = undefined;

      if (useResponsesApi) {
        responsesConversation = await storage.getOrCreateConversationId(all.activeProvider);
        const hasAssistantTurn = history.some(m => m.role === 'assistant');
        if (hasAssistantTurn) {
          // Subsequent turns: Hermes already knows previous context.
          // BUT if the user attached a new page after the last assistant turn,
          // we must include it — Hermes has never seen it.
          const lastAssistantIdx = history.map(m => m.role).lastIndexOf('assistant');
          const newPageContextMsg = history.slice(lastAssistantIdx + 1).find(m =>
            m.role === 'user' && (
              (typeof m.content === 'string' && m.content.startsWith('[Page context attached by browsa]')) ||
              (Array.isArray(m.content))
            )
          );

          if (newPageContextMsg) {
            // New page was attached — include it alongside the user message.
            const parts = [];
            if (typeof newPageContextMsg.content === 'string') {
              parts.push({ type: 'input_text', text: newPageContextMsg.content });
            } else if (Array.isArray(newPageContextMsg.content)) {
              for (const p of newPageContextMsg.content) {
                if (p.type === 'text') parts.push({ type: 'input_text', text: p.text });
                else if (p.type === 'image_url') parts.push({ type: 'input_image', image_url: p.image_url?.url || p.image_url });
              }
            }
            parts.push({ type: 'input_text', text: msg.userText || '' });
            if (msg.images?.length) {
              msg.images.forEach(url => parts.push({ type: 'input_image', image_url: url }));
            }
            responsesInput = [{ role: 'user', content: parts }];
          } else if (msg.images?.length) {
            responsesInput = [
              { role: 'user', content: [
                  { type: 'input_text', text: msg.userText || '' },
                  ...msg.images.map(url => ({ type: 'input_image', image_url: url }))
                ]
              }
            ];
          } else {
            responsesInput = msg.userText || '';
          }
        } else {
          // First turn: include page context from history so Hermes learns it.
          const pageContextMsg = history.find(m =>
            m.role === 'user' && (
              (typeof m.content === 'string' && m.content.startsWith('[Page context attached by browsa]')) ||
              (Array.isArray(m.content))
            )
          );
          const parts = [];
          if (pageContextMsg) {
            if (typeof pageContextMsg.content === 'string') {
              parts.push({ type: 'input_text', text: pageContextMsg.content });
            } else if (Array.isArray(pageContextMsg.content)) {
              // Multimodal (screenshot)
              for (const p of pageContextMsg.content) {
                if (p.type === 'text') parts.push({ type: 'input_text', text: p.text });
                else if (p.type === 'image_url') parts.push({ type: 'input_image', image_url: p.image_url?.url || p.image_url });
              }
            }
          }
          parts.push({ type: 'input_text', text: msg.userText || '' });
          if (msg.images?.length) {
            msg.images.forEach(url => parts.push({ type: 'input_image', image_url: url }));
          }
          responsesInput = [{ role: 'user', content: parts }];
        }
      } else {
        // Standard stateless mode: send full history on every turn.
        messages = buildMessages({
          history,
          userText: msg.userText,
          pageContext: null,
          withImage: false,
          userImages: msg.images,
          systemPrompt: effectiveSystemPrompt
        });
      }

      // Persist user turn to global history
      const userTurn = { role: 'user', content: msg.userText || '(no instruction)' };
      await storage.appendToHistory(userTurn);

      // Initialize stream state BEFORE the first onDelta. From this point
      // on, every delta both pushes to the port and accumulates into
      // streamState.acc — so a mid-stream tab switch (which kills the
      // port but not the LLM request) can be recovered via STREAM_PEEK.
      initStreamState(tabId);

      // Wire an AbortController so the side panel can actually cancel
      // the LLM fetch. Without this, Esc-to-cancel was visual-only —
      // the background kept streaming, a phantom assistant turn got
      // appended to history, and STREAM_RELEASE just hid it from PEEK.
      // The 5-min hard timeout still stands as a safety net.
      const controller = new AbortController();
      chatControllers.set(tabId, controller);
      const timeout = setTimeout(() => controller.abort('timeout'), 60_000 * 5);
      const signal = controller.signal;

      // Per-provider inference params
      const temperature = (provider.temperature != null && provider.temperature !== '') ? Number(provider.temperature) : undefined;
      const maxTokens = provider.maxTokens ? Number(provider.maxTokens) : 0;

      // Stream with auto-retry on transient network / rate-limit errors
      let fullReply = '';
      let replyUsage = null;
      let aborted = false;
      const MAX_RETRIES = 2;

      const doStream = async () => {
        const onToolProgress = (text) => pushChunk(tabId, { type: 'TOOL_PROGRESS', text });

        if (useResponsesApi) {
          const result = await responsesApiStream({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            input: responsesInput,
            instructions: effectiveSystemPrompt || undefined,
            conversation: responsesConversation,
            onDelta: (delta) => {
              appendToStreamState(tabId, delta);
              pushChunk(tabId, { type: 'CHUNK', delta });
            },
            onToolProgress,
            signal,
            temperature,
            maxTokens
          });
          return result;
        } else {
          const result = await chatStream({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model || undefined,
            messages,
            onDelta: (delta) => {
              appendToStreamState(tabId, delta);
              pushChunk(tabId, { type: 'CHUNK', delta });
            },
            onToolProgress,
            signal,
            extraHeaders,
            temperature,
            maxTokens
          });
          return result;
        }
      };

      try {
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
          try {
            // Reset stream state accumulator on retry so we don't double content
            if (attempt > 1) {
              const st = streamState.get(tabId);
              if (st) st.acc = '';
              fullReply = '';
              // Notify side panel about retry
              pushChunk(tabId, { type: 'RETRY', attempt, maxAttempts: MAX_RETRIES + 1 });
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
            const result = await doStream();
            fullReply = result.full;
            replyUsage = result.usage || null;
            break; // success
          } catch (e) {
            if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) throw e;
            lastError = e;
            // Only retry on network or rate-limit errors
            const isRetryable = e?.name === 'ProviderNetworkError' || (e?.name === 'ProviderAPIError' && e?.message?.includes('429'));
            if (!isRetryable || attempt > MAX_RETRIES) throw e;
          }
        }
      } catch (e) {
        // Distinguish user-cancel from real errors. AbortError fires
        // when the side panel's cancelStream() called
        // STREAM_ABORT → controller.abort() → fetch threw. We must NOT
        // append a half-finished reply to history in that case.
        if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) {
          aborted = true;
          // Tell the side panel it was a clean cancel so it can show
          // its "⚠ Stream cancelled" message and skip DONE.
          pushChunk(tabId, { type: 'ERROR', error: 'cancelled', code: 'ABORTED' });
          clearStreamState(tabId);
          return { ok: true, cancelled: true };
        }
        // Re-throw real errors so the generic onMessage handler can
        // wrap them with a hint (network / config / API).
        throw e;
      } finally {
        clearTimeout(timeout);
        chatControllers.delete(tabId);
      }

      // Parse CHOICE_REQUEST: agent may embed an interactive choice at the
      // end of its reply. Strip it from the stored text so history stays
      // clean, but forward the parsed data to the side panel so it can
      // render clickable buttons. Format (from personal_ai_assistant):
      //   CHOICE_REQUEST:{"question":"...","choices":["A","B"]}
      let choiceRequest = null;
      const choiceMatch = fullReply.match(/CHOICE_REQUEST:(\{[\s\S]*?\})\s*$/);
      if (choiceMatch) {
        try {
          choiceRequest = JSON.parse(choiceMatch[1]);
          fullReply = fullReply.slice(0, choiceMatch.index).trimEnd();
        } catch (_) { /* malformed JSON — leave as-is */ }
      }

      // Persist assistant turn — this is the durable source of truth.
      // (Only reached if the stream completed naturally, not via abort.)
      await storage.appendToHistory({ role: 'assistant', content: fullReply });

      pushChunk(tabId, { type: 'DONE', full: fullReply, choiceRequest, usage: replyUsage });
      clearStreamState(tabId);
      return { full: fullReply };
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    // Port closed (user closed panel). Swallow.
  }
}

// Resolve a tabId from a message context. CHAT messages carry tabId explicitly;
// GET_PAGE_CONTEXT might not, so we fall back to the sender's tab.
function tabIdOf(msg, sender) {
  if (msg?.tabId != null) return msg.tabId;
  if (sender?.tab?.id != null) return sender.tab.id;
  return null;
}

// llms.txt cache: origin → { content: string|null, fetchedAt: number }
// Persists across message handling within a SW lifetime (not durable).
const llmsTxtCache = new Map();
const LLMS_TXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchLlmsTxt(tabUrl) {
  if (!tabUrl) return null;
  let origin;
  try { origin = new URL(tabUrl).origin; } catch (_) { return null; }
  const cached = llmsTxtCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < LLMS_TXT_TTL_MS) return cached.content;
  try {
    const res = await fetch(`${origin}/llms.txt`, {
      signal: AbortSignal.timeout(3000),
      headers: { 'Accept': 'text/plain' }
    });
    if (!res.ok) { llmsTxtCache.set(origin, { content: null, fetchedAt: Date.now() }); return null; }
    const text = (await res.text()).trim().slice(0, 8000); // cap at 8 KB
    llmsTxtCache.set(origin, { content: text || null, fetchedAt: Date.now() });
    return text || null;
  } catch (_) {
    llmsTxtCache.set(origin, { content: null, fetchedAt: Date.now() });
    return null;
  }
}

// SPA navigation watch.
//
// chrome.tabs.onUpdated does NOT fire when a SPA does pushState() to change
// the URL (e.g. 小红书 switching from one /explore/<noteId> to another).
// chrome.webNavigation.onHistoryStateUpdated DOES fire — it covers both
// pushState and replaceState. We also listen to onCommitted/onCompleted for
// the more common full-reload case (since webNavigation fires earlier than
// onUpdated in some flows). Each event carries the new tab URL; we forward
// it to every side panel that has registered a nav-port for that tab.
//
// We dedupe: a single SPA navigation can fire multiple webNavigation
// events (e.g. onHistoryStateUpdated + onCommitted if the SPA also triggers
// a fetch). Without dedup, the side panel UI flickers. We track the last
// (tabId, url) we broadcast and skip if unchanged.
const lastNavBroadcast = new Map(); // tabId -> url
// (The Map is mutated in place; we never replace the reference.)

// Pure broadcast helper: mutates lastNavMap in-place (no copy) and fans out to
// registered ports. Kept as a named function so tests can import and call it
// with their own Map/port stubs without importing the full module.
function dedupeAndBroadcast(lastNavMap, navPortsMap, tabId, url) {
  if (typeof tabId !== 'number' || !url) return { updated: false, lastNavMap, sent: 0 };
  if (lastNavMap.get(tabId) === url) return { updated: false, lastNavMap, sent: 0 };
  lastNavMap.set(tabId, url); // mutate in place — no Map copy needed
  const set = navPortsMap.get(tabId);
  if (!set || set.size === 0) return { updated: true, lastNavMap, sent: 0 };
  for (const p of set) {
    try { p.postMessage({ type: 'NAVIGATED', tabId, url, title: '' }); } catch (_) {}
  }
  return { updated: true, lastNavMap, sent: set.size };
}

function broadcastNav(tabId, url) {
  if (typeof tabId !== 'number' || !url) return;
  const result = dedupeAndBroadcast(lastNavBroadcast, navPorts, tabId, url);
  if (result.updated && result.sent > 0) {
    console.log(`browsa[bg]: nav broadcast tab=${tabId} url=${url} sentTo=${result.sent}`);
  }
}

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // only top frame
  broadcastNav(details.tabId, details.url);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  // Only fires for non-history-API commits. onHistoryStateUpdated handles
  // the SPA case. This is a safety net for any other navigation path.
  broadcastNav(details.tabId, details.url);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  // Reset the dedup so a same-URL back/forward (which history treats as
  // a new navigation) still fires. We can't know the new URL yet, so we
  // just clear.
  lastNavBroadcast.delete(details.tabId);
});

// Per-site XHR intercept caches.
//
// Each content script intercepts the SPA's own API calls and forwards
// structured article data here. We cache by tabId (most-recent wins),
// so when the user asks browsa to read the page, we have the full content
// from the browser's own authenticated request — no signing, no re-auth.
// Pending selection actions: when the side panel isn't open yet, we store
// the action here and deliver it once the panel connects via nav port.
const pendingSelectionActions = new Map(); // tabId -> { action, text }

// (pageContextUrls removed — history is now global, not per-tab)

const selectionCache   = new Map(); // tabId -> last selected text (from selectionchange)
const xhsXhrCache      = new Map(); // tabId -> XHS note summary
const youtubeCache     = new Map(); // tabId -> YouTube video data
const juejinCache      = new Map(); // tabId -> Juejin article
const zhihuCache       = new Map(); // tabId -> Zhihu article or Q&A
const dedaoCache       = new Map(); // tabId -> Dedao article
const geektimeCache    = new Map(); // tabId -> Geektime article

/** Return cached site data for a tab, regardless of which site it came from. */
function getSiteCache(tabId) {
  if (youtubeCache.has(tabId))  return { source: 'youtube',  data: youtubeCache.get(tabId) };
  if (juejinCache.has(tabId))   return { source: 'juejin',   data: juejinCache.get(tabId) };
  if (zhihuCache.has(tabId))    return { source: 'zhihu',    data: zhihuCache.get(tabId) };
  if (dedaoCache.has(tabId))    return { source: 'dedao',    data: dedaoCache.get(tabId) };
  if (geektimeCache.has(tabId)) return { source: 'geektime', data: geektimeCache.get(tabId) };
  return null;
}

function pushXhsNote(tabId, note) {
  if (typeof tabId !== 'number' || !note) return;
  xhsXhrCache.set(tabId, note);
  const set = navPorts.get(tabId);
  if (!set || set.size === 0) return;
  for (const p of set) {
    try { p.postMessage({ type: 'XHS_XHR_NOTE', tabId, note }); } catch (_) {}
  }
  console.log(`browsa[bg]: xhs XHR note cached for tab=${tabId} noteId=${note.noteId}`);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  lastNavBroadcast.delete(tabId);
  selectionCache.delete(tabId);
  pendingSelectionActions.delete(tabId);
  xhsXhrCache.delete(tabId);
  youtubeCache.delete(tabId);
  juejinCache.delete(tabId);
  zhihuCache.delete(tabId);
  dedaoCache.delete(tabId);
  geektimeCache.delete(tabId);
  const set = navPorts.get(tabId);
  if (set) {
    for (const p of set) {
      try { p.postMessage({ type: 'NAVIGATED', tabId, url: '', title: '', closed: true }); } catch (_) {}
    }
    navPorts.delete(tabId);
  }
});

// Exported for testing. handle() is the switch-based message dispatcher.
export { handle };
