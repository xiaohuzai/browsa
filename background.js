// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG / SET_CONFIG: read/write storage
//   - CLEAR_HISTORY: clear per-tab history

import * as storage from './lib/storage.js';
import { chatStream, runsApiStream, getCapabilities, ping, ProviderConfigError } from './lib/openai-client.js';
import { PAGE_CONTEXT_PREFIX } from './lib/constants.js';
// Session management re-exported from storage for use in handle()
const { saveCurrentSession, getSavedSessions, loadSession, deleteSession, renameSession } = storage;
import { extractActiveTab, buildMessages, buildPageContextText, ensureReadabilityInjected } from './lib/page-extractor.js';

// Capability hints: browsa rendering rules injected automatically so users
// never need to configure them manually. Shared by both CHAT (full turn,
// with page context/domain rules/history) and SUBCHAT (scoped detail-thread
// side-conversation, see openDetailThread in sidepanel.js) — both render
// through the same markdown/Mermaid/ECharts/KaTeX pipeline.
const CAPABILITY_HINTS = [
  'When writing mathematical expressions or formulas, always use LaTeX notation: wrap inline math with $...$ and display/block math with $$...$$. This applies everywhere including inside Markdown table cells — never write formulas as plain text in tables.',
  'When drawing diagrams or charts, output Mermaid code blocks (```mermaid) directly in your response. The chat UI renders Mermaid natively — do not create HTML files or write files to disk for diagrams.',
  'When generating Mermaid diagrams, always quote node labels that contain special characters (<, >, /, \\, (, ), {, }, ;, #, ~, %) using double-quoted syntax: ["label text"].',
  'In Markdown, always place punctuation outside bold/italic delimiters: write **text**, not **text,**.',
  'In Markdown, always put a space between Chinese/CJK text and ** or * emphasis delimiters when they would otherwise be directly adjacent — e.g. write 一个 **"GPU 利用率"** 因子, never 一个**"GPU 利用率"**因子. Without that space, if the emphasized text itself starts or ends with punctuation like quotation marks, CommonMark cannot treat the ** as a valid opening/closing delimiter and renders it as literal asterisks instead of bold.',
  'When your answer covers multiple sub-questions or sections, give each one an actual Markdown heading (## or ###) — never a plain unformatted line of text pretending to be a title. A bare line like "BF16 比 FP16 强在哪?" followed by a paragraph renders with no visual distinction from body text; "### BF16 比 FP16 强在哪?" renders as a real heading.',
  'When listing multiple parallel points, reasons, or comparisons (even just 2-3 short ones), format them as a Markdown list (- item per line or 1. item per line) instead of separate plain lines with no list marker — plain consecutive lines render as one undifferentiated block with no visual separation between items.',
  'In Mermaid diagrams, NEVER use Markdown bold (**text**) or italic (*text*) inside node labels — they display as literal asterisks. Instead use HTML: <b>text</b> for bold, <i>text</i> for italic. Example: A["<b>Title</b><br/>subtitle"] not A["**Title**<br/>subtitle"].',
  'In Mermaid diagrams, use $$...$$ (KaTeX) for math inside node labels with SINGLE backslashes: A["$$T = \\frac{D_{vol}}{B_{bw}}$$"]. Never mix plain-text approximations with LaTeX in the same label. Never use double backslashes (\\\\frac) — single backslash only inside $$...$$.',
  'For data visualizations (bar charts, line charts, pie charts, scatter plots, etc.), output an ECharts option object as JSON in a ```echarts code block. The chat UI renders it natively. Example: ```echarts\n{"xAxis":{"type":"category","data":["A","B","C"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2,3]}]}\n```',
].join(' ');

// CHOICE_REQUEST is CHAT-only, deliberately NOT part of CAPABILITY_HINTS:
// rendering it as clickable buttons requires background.js's CHAT case to
// parse+strip the tail and sidepanel.js to call renderChoiceRequest() —
// SUBCHAT's detail-thread card does neither, so including this hint there
// would just leak the raw "CHOICE_REQUEST:{...}" JSON into the reply text.
const CHOICE_REQUEST_HINT =
  'When you need the user to pick one of several distinct options (not free-form text), end your reply with a line in this exact format so the chat UI renders clickable buttons: CHOICE_REQUEST:{"question":"short question text","choices":["full text of option 1","full text of option 2"]}. This must be the very last thing in your reply, valid single-line JSON, with no text after it. Each choice string should be the complete message that gets sent back to you when clicked (not just a letter like "A") — write full option text, not a lettered index. Only use this when you are truly asking the user to choose between distinct paths forward, not for yes/no confirmations or open-ended questions.';

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

// Maps a tabId to the active stream's resetIdleTimer function. Allows the
// port's SW_PING handler to reset the idle timeout from outside the CHAT
// handler's closure. This is what makes SW_PING actually prevent the
// idle-timeout cancel during long tool calls (e.g. sub-agent execution).
const idleTimerResetters = new Map(); // tabId -> () => void

// Active run IDs for Hermes /v1/runs streaming. Stored so STREAM_ABORT can
// call POST /v1/runs/{id}/stop to stop the server-side agent, not just the
// local fetch.
export const activeRunIds = new Map(); // tabId -> { runId, baseUrl, apiKey }

// Pending approval/clarification requests awaiting user response.
export const pendingApprovals = new Map();      // tabId -> { runId, approvalId, baseUrl, apiKey }
export const pendingClarifications = new Map(); // tabId -> { runId, clarifyId, baseUrl, apiKey }

// AbortControllers for "detail thread" side-conversations (SUBCHAT), keyed
// by a client-generated subId rather than tabId — unlike the main chat,
// several detail threads can be open (and streaming) at once for the same
// tab, so each needs its own independent cancel handle.
export const subChatControllers = new Map(); // subId -> AbortController

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

// Detail-thread ("SUBCHAT") port: opened fresh per send (one port per
// subId), exactly like the main chat's per-turn browsa-chat port — NOT a
// persistent port kept alive across the panel's whole lifetime. A
// persistent port sounds appealing but has a real failure mode: if the SW
// went idle (30s+) while the user was reading before opening a detail
// thread, the persistent port dies and only reconnects on a delayed timer,
// while sendMessage({type:'SUBCHAT'}) wakes the SW almost immediately —
// deltas can start arriving and get silently dropped before the port has
// finished reconnecting. Opening fresh + waiting for the HELLO_ACK (like
// onSend() does for browsa-chat) avoids that race entirely.
export const subChatPorts = new Map(); // subId -> Port

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
      } else if (msg && msg.type === 'SW_PING' && claimedTabId != null) {
        // Sidepanel sends SW_PING every 20 s while a stream is in flight to
        // keep the SW alive AND reset the idle-abort timer. Without this
        // handler the pings arrive but resetIdleTimer never fires, so long
        // tool calls (e.g. sub-agent execution with minutes of SSE silence)
        // hit the 5-minute idle timeout and get falsely cancelled.
        const reset = idleTimerResetters.get(claimedTabId);
        if (reset) reset();
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

  if (port.name === 'browsa-subchat') {
    // One port per subId (one per detail-thread send) — no FOLLOW/re-tab
    // concept needed, since the port only ever lives for that one request.
    let claimedSubId = null;
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'SUBCHAT_HELLO' && typeof msg.subId === 'string') {
        claimedSubId = msg.subId;
        const oldPort = subChatPorts.get(claimedSubId);
        if (oldPort && oldPort !== port) {
          try { oldPort.disconnect(); } catch (_) {}
        }
        subChatPorts.set(claimedSubId, port);
        try { port.postMessage({ type: 'SUBCHAT_HELLO_ACK' }); } catch (_) {}
      }
    });
    port.onDisconnect.addListener(() => {
      if (claimedSubId != null && subChatPorts.get(claimedSubId) === port) {
        subChatPorts.delete(claimedSubId);
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

function pushSubChatChunk(subId, payload) {
  const port = subChatPorts.get(subId);
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

// Restore site caches from session storage on every SW startup so that
// content-script data captured before the SW went to sleep is not lost.
// Store the promise so message handlers can await it before checking caches.
const siteCacheReady = restoreSiteCachesFromSession();
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
      // Sent by the content script; the note summary is in msg.note.
      // Derive tabId from sender.tab.id (like every other SITE_CACHES
      // handler) rather than trusting a client-supplied msg.tabId — the
      // content script never actually sent one, which made this a silent
      // no-op, and a client-supplied tabId would let any page write into
      // another tab's cache.
      pushXhsNote(sender?.tab?.id, msg.note);
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
      if (tabId) { SITE_CACHES.youtube.set(tabId, msg.video); persistSiteCache(tabId, 'youtube', msg.video); }
      return { ok: true };
    }

    case 'JUEJIN_ARTICLE': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.juejin.set(tabId, msg.article); persistSiteCache(tabId, 'juejin', msg.article); }
      return { ok: true };
    }

    case 'ZHIHU_CONTENT': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.zhihu.set(tabId, msg.content); persistSiteCache(tabId, 'zhihu', msg.content); }
      return { ok: true };
    }

    case 'DEDAO_ARTICLE': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.dedao.set(tabId, msg.article); persistSiteCache(tabId, 'dedao', msg.article); }
      return { ok: true };
    }

    case 'GEEKTIME_ARTICLE': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.geektime.set(tabId, msg.article); persistSiteCache(tabId, 'geektime', msg.article); }
      return { ok: true };
    }

    case 'BILIBILI_VIDEO': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.bilibili.set(tabId, msg.video); persistSiteCache(tabId, 'bilibili', msg.video); }
      return { ok: true };
    }

    case 'XUEQIU_DATA': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.xueqiu.set(tabId, msg.data); persistSiteCache(tabId, 'xueqiu', msg.data); }
      return { ok: true };
    }

    case 'TWITTER_TWEET': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.twitter.set(tabId, msg.tweet); persistSiteCache(tabId, 'twitter', msg.tweet); }
      return { ok: true };
    }

    case 'XIAOYUZHOU_EPISODE': {
      const tabId = sender?.tab?.id;
      if (tabId) { SITE_CACHES.xiaoyuzhou.set(tabId, msg.episode); persistSiteCache(tabId, 'xiaoyuzhou', msg.episode); }
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
        `${PAGE_CONTEXT_PREFIX}\nURL: ${metaUrl || ''}\nTitle: ${metaTitle || ''}\nMode: screenshot\n---\n\n(screenshot)`;
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
      // Reset the Hermes session identity for every Hermes provider so the
      // next conversation starts fresh (new X-Hermes-Session-Id / session_id).
      const allCfg = await storage.getAll();
      for (const name of Object.keys(allCfg.providers || {})) {
        if (allCfg.providers[name]?.isHermes) {
          await storage.resetHermesSessionId(name);
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
        } else if (mode === 'jina') {
          // Jina Reader: fetch clean Markdown from r.jina.ai/{url}
          // Runs in the service worker — no CORS restrictions, no cookies sent.
          // Best for paywalled/JS-heavy pages where Readability gives poor results.
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab?.url) return { ok: false, error: 'Cannot get tab URL' };
          if (!/^https?:\/\//.test(tab.url)) return { ok: false, error: 'Jina Reader only works on http/https pages' };
          const jinaUrl = 'https://r.jina.ai/' + tab.url;
          const resp = await fetch(jinaUrl, {
            headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' }
          }).catch(e => { throw new Error('Jina fetch failed: ' + e.message); });
          if (!resp.ok) throw new Error(`Jina Reader returned ${resp.status} for this page`);
          const markdown = await resp.text();
          if (!markdown?.trim()) return { ok: false, error: 'Jina Reader returned empty content' };
          ctx = {
            meta: { url: tab.url, title: tab.title || '', favIconUrl: tab.favIconUrl || '' },
            mode: 'jina',
            text: markdown,
            truncated: { rawTextLength: markdown.length, textLength: markdown.length, wasCapped: false }
          };
        } else {
          // auto and reader modes may need Readability; dom/full don't
          if (mode === 'reader' || mode === 'auto') await ensureReadabilityInjected(tabId).catch(() => {});
          await siteCacheReady; // ensure session-storage restore finished
          ctx = await extractActiveTab({
            mode,
            maxTextChars: all.maxTextChars,
            xhsXhrNote: xhsXhrCache.get(tabId) || null,
            siteCache: getSiteCache(tabId)
          });
          if (!ctx) return { ok: false, error: 'extraction returned null' };

          // Auto mode silent Jina fallback: if all local strategies returned
          // very little content (< 200 chars), try r.jina.ai as last resort.
          // Jina runs on their servers without user cookies, so it's only
          // useful for public pages. We set autoMode='jina' so the UI label
          // shows "auto/jina" rather than the empty/failed local mode.
          if (mode === 'auto' && (ctx.text?.length || 0) < 200) {
            try {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (tab?.url && /^https?:\/\//.test(tab.url)) {
                const resp = await fetch('https://r.jina.ai/' + tab.url, {
                  headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' }
                });
                if (resp.ok) {
                  const markdown = await resp.text();
                  if (markdown?.trim().length > (ctx.text?.length || 0)) {
                    ctx = Object.assign({}, ctx, {
                      autoMode: 'jina',
                      text: markdown,
                      truncated: { rawTextLength: markdown.length, textLength: markdown.length, wasCapped: false }
                    });
                  }
                }
              }
            } catch (_) { /* Jina fallback is best-effort; ignore errors */ }
          }
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
      // For Hermes /v1/runs: also stop the server-side agent so it stops
      // executing tools rather than continuing in the background. The
      // registered route is /stop, not /cancel — there is no /cancel route
      // on the Hermes API server (confirmed via /v1/capabilities' endpoints
      // map and gateway/platforms/api_server.py's route table).
      const runInfo = activeRunIds.get(t);
      if (runInfo) {
        const stopUrl = `${runInfo.baseUrl}/v1/runs/${encodeURIComponent(runInfo.runId)}/stop`;
        const stopHeaders = { 'Content-Type': 'application/json' };
        if (runInfo.apiKey) stopHeaders['Authorization'] = `Bearer ${runInfo.apiKey}`;
        fetch(stopUrl, { method: 'POST', headers: stopHeaders }).catch(() => {});
        activeRunIds.delete(t);
      }
      clearStreamState(t);
      return { aborted: !!controller };
    }

    case 'APPROVAL_RESPOND': {
      // User clicked Allow/Deny on an approval card. Relay the choice to
      // the Hermes agent via POST /v1/runs/{id}/approval so it can resume.
      const pending = pendingApprovals.get(msg.tabId);
      if (!pending) return { ok: false, error: 'no pending approval' };
      try {
        const res = await fetch(
          `${pending.baseUrl}/v1/runs/${encodeURIComponent(pending.runId)}/approval`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(pending.apiKey ? { Authorization: `Bearer ${pending.apiKey}` } : {}),
            },
            body: JSON.stringify({ approval_id: pending.approvalId, choice: msg.choice }),
          },
        );
        return { ok: res.ok };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    }

    case 'CLARIFY_RESPOND': {
      // User submitted a clarification response. Relay to Hermes agent.
      const pending = pendingClarifications.get(msg.tabId);
      if (!pending) return { ok: false, error: 'no pending clarification' };
      try {
        const res = await fetch(
          `${pending.baseUrl}/v1/runs/${encodeURIComponent(pending.runId)}/clarifications/${encodeURIComponent(pending.clarifyId)}/respond`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(pending.apiKey ? { Authorization: `Bearer ${pending.apiKey}` } : {}),
            },
            body: JSON.stringify({ response: msg.response }),
          },
        );
        return { ok: res.ok };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    }

    case 'SUBCHAT': {
      // "Detail thread" side-conversation: the user selected a piece of text
      // inside an assistant reply and wants to drill into it without
      // touching the main conversation. Deliberately scoped down from CHAT:
      // - always chatStream() (/v1/chat/completions), never runsApiStream —
      //   no tool execution/approval needed for a side Q&A, and reusing the
      //   main chat's Hermes session id here would mix this detail question
      //   into the server-side agent's main-task context.
      // - never touches storage.appendToHistory — the whole point is that
      //   the main history stays clean.
      // - no page context/domain rules/llms.txt — sidepanel.js already
      //   built the scoped context (quoted excerpt + the question).
      const all = await storage.getAll();
      const provider = all.providers[all.activeProvider];
      if (!provider) throw ProviderConfigError(`Provider "${all.activeProvider}" not configured`);
      if (!provider.baseUrl?.trim()) throw ProviderConfigError('Base URL is not set. Open Settings (⚙) and configure the provider.');

      const subId = msg.subId;
      if (!subId) throw new Error('subId required');
      const userMessages = Array.isArray(msg.messages) ? msg.messages : [];
      if (!userMessages.length) throw new Error('messages required');

      const messages = [{ role: 'system', content: CAPABILITY_HINTS }, ...userMessages];
      const controller = new AbortController();
      subChatControllers.set(subId, controller);
      const temperature = (provider.temperature != null && provider.temperature !== '') ? Number(provider.temperature) : undefined;
      const maxTokens = provider.maxTokens ? Number(provider.maxTokens) : 0;
      console.log('[subchat][bg]', subId, 'starting chatStream, port already registered?', subChatPorts.has(subId));

      // Fire-and-forget: reply to the sendMessage call immediately so the
      // side panel doesn't block on the whole stream, and push deltas
      // through the dedicated browsa-subchat port (opened fresh for this
      // subId, see subChatPorts comment) as they arrive.
      (async () => {
        try {
          await chatStream({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model || undefined,
            messages,
            onDelta: (delta) => {
              const posted = subChatPorts.has(subId);
              if (!posted) console.warn('[subchat][bg]', subId, 'delta arrived but NO PORT registered — dropped:', delta.slice(0, 40));
              pushSubChatChunk(subId, { type: 'SUBCHAT_CHUNK', subId, delta });
            },
            signal: controller.signal,
            temperature,
            maxTokens,
          });
          console.log('[subchat][bg]', subId, 'chatStream done, port still registered?', subChatPorts.has(subId));
          pushSubChatChunk(subId, { type: 'SUBCHAT_DONE', subId });
        } catch (e) {
          console.error('[subchat][bg]', subId, 'chatStream threw', e);
          if (e?.name !== 'AbortError') {
            pushSubChatChunk(subId, { type: 'SUBCHAT_ERROR', subId, message: e?.message || String(e) });
          }
        } finally {
          subChatControllers.delete(subId);
        }
      })();
      return { started: true };
    }

    case 'SUBCHAT_ABORT': {
      const c = subChatControllers.get(msg.subId);
      if (c) {
        try { c.abort('user-cancel'); } catch (_) {}
        subChatControllers.delete(msg.subId);
      }
      return { aborted: !!c };
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
      await siteCacheReady; // ensure session-storage restore finished
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
      const effectiveSystemPrompt = [all.systemPrompt || '', domainExtra, llmsTxtExtra, langExtra, CAPABILITY_HINTS, CHOICE_REQUEST_HINT]
        .map(s => s.trim()).filter(Boolean).join('\n\n');

      // Load global history
      const history = await storage.getHistory();

      // isHermes flag identifies Hermes providers (auto-detected via ping —
      // options.js probes run_submission/run_events_sse capabilities). When
      // true we always use Hermes's richer /v1/runs API (approval,
      // clarification, tool.started/tool.completed, visible thinking)
      // instead of plain /v1/chat/completions.
      const isHermes = !!(provider.isHermes);

      let messages = null;         // chatStream (stateless OpenAI-compatible)
      let runsInput = null;        // runsApiStream: current user message
      let runsConvHistory = null;  // runsApiStream: all prior turns
      let hermesSessionId = null;  // runsApiStream: X-Hermes-Session-Id / session_id
      let extraHeaders = undefined;

      if (isHermes) {
        hermesSessionId = await storage.getOrCreateHermesSessionId(all.activeProvider);
        // Build current-turn input (text + optional images)
        if (msg.images?.length) {
          const parts = [{ type: 'input_text', text: msg.userText || '' }];
          msg.images.forEach(url => parts.push({ type: 'input_image', image_url: url }));
          runsInput = [{ role: 'user', content: parts }];
        } else {
          runsInput = msg.userText || '';
        }
        // Build conversation history from local storage (all prior user+assistant turns).
        // Page-context messages (PAGE_CONTEXT_PREFIX) are included as-is so Hermes
        // receives the full context. Multimodal content in old turns is text-only.
        runsConvHistory = history
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => {
            let content = m.content;
            if (Array.isArray(content)) {
              content = content
                .filter(p => p.type === 'text' || p.type === 'input_text')
                .map(p => p.text || '').join('') || '[multimodal message]';
            }
            return { role: m.role, content: String(content || '') };
          })
          .filter(m => m.content.trim());
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

      // Persist user turn to global history (include images if present)
      const userTurnContent = msg.images?.length
        ? [
            { type: 'text', text: msg.userText || '(no instruction)' },
            ...msg.images.map(url => ({ type: 'image_url', image_url: { url } }))
          ]
        : msg.userText || '(no instruction)';
      const userTurn = { role: 'user', content: userTurnContent };
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
      // Idle timeout: abort if no delta or tool-progress arrives for 5 min.
      // Resets on every output event so long agent tasks with many tool
      // calls never hit this accidentally — only truly stuck streams do.
      const controller = new AbortController();
      chatControllers.set(tabId, controller);
      const IDLE_TIMEOUT_MS = 5 * 60_000;
      let idleTimer = setTimeout(() => controller.abort('idle-timeout'), IDLE_TIMEOUT_MS);
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort('idle-timeout'), IDLE_TIMEOUT_MS);
      };
      idleTimerResetters.set(tabId, resetIdleTimer);
      const signal = controller.signal;

      // Per-provider inference params
      const temperature = (provider.temperature != null && provider.temperature !== '') ? Number(provider.temperature) : undefined;
      const maxTokens = provider.maxTokens ? Number(provider.maxTokens) : 0;

      // Stream with auto-retry on transient network / rate-limit errors
      let fullReply = '';
      let replyUsage = null;
      const MAX_RETRIES = 2;

      const doStream = async () => {
        const onDelta = (delta) => {
          resetIdleTimer();
          appendToStreamState(tabId, delta);
          pushChunk(tabId, { type: 'CHUNK', delta });
        };
        const onToolProgress = (text) => { resetIdleTimer(); pushChunk(tabId, { type: 'TOOL_PROGRESS', text }); };

        // Hermes gates dangerous tools (execute_code, terminal, ...) behind
        // an approval flow on BOTH /v1/runs and /v1/chat/completions — not
        // just /v1/runs. Wire onApproval/onClarify for both paths, or the
        // tool call just hangs waiting for a response that never comes.
        // run_id may arrive embedded in the event payload itself (chatStream)
        // or be injected by runsApiStream (which knows it from POST /v1/runs) —
        // check both the camelCase and snake_case field names.
        const onApproval = (data) => {
          pendingApprovals.set(tabId, {
            runId: data.runId || data.run_id || '',
            approvalId: data.approval_id || data.approvalId || '',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          });
          pushChunk(tabId, { type: 'APPROVAL', data });
        };
        const onClarify = (data) => {
          pendingClarifications.set(tabId, {
            runId: data.runId || data.run_id || '',
            clarifyId: data.clarify_id || data.clarifyId || '',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          });
          pushChunk(tabId, { type: 'CLARIFY', data });
        };

        if (isHermes) {
          const onRunId = (runId) => {
            activeRunIds.set(tabId, { runId, baseUrl: provider.baseUrl, apiKey: provider.apiKey });
          };
          return await runsApiStream({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            input: runsInput,
            instructions: effectiveSystemPrompt || undefined,
            conversationHistory: runsConvHistory,
            sessionId: hermesSessionId,
            onDelta,
            onToolProgress,
            onApproval,
            onClarify,
            onRunId,
            signal,
            temperature,
            maxTokens,
          });
        } else {
          return await chatStream({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model || undefined,
            messages,
            onDelta,
            onToolProgress,
            onApproval,
            onClarify,
            signal,
            extraHeaders,
            temperature,
            maxTokens,
          });
        }
      };

      try {
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
        clearTimeout(idleTimer);
        idleTimerResetters.delete(tabId);
        chatControllers.delete(tabId);
        activeRunIds.delete(tabId);
        pendingApprovals.delete(tabId);
        pendingClarifications.delete(tabId);
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

const selectionCache = new Map(); // tabId -> last selected text (from selectionchange)
const xhsXhrCache    = new Map(); // tabId -> XHS note summary (has special push logic, kept separate)

// Site-specific XHR intercept caches, keyed by tabId. Each entry is a Map.
// Adding a new site requires only adding an entry here — restore, getSiteCache,
// and onRemoved all iterate this registry automatically.
const SITE_CACHES = {
  youtube:    new Map(), // YouTube video data
  juejin:     new Map(), // 掘金 article
  zhihu:      new Map(), // 知乎 article or Q&A
  dedao:      new Map(), // 得到 article
  geektime:   new Map(), // 极客时间 article
  bilibili:   new Map(), // Bilibili video data
  xueqiu:     new Map(), // 雪球 stock/post data
  twitter:    new Map(), // Twitter/X tweet data
  xiaoyuzhou: new Map(), // 小宇宙 podcast episode
};

// Site caches above are module-level Maps that are wiped on every SW restart
// (~30s idle). Persist them to chrome.storage.session so they survive SW
// sleep/wake cycles within a browser session.
const SC_PREFIX = 'sc_';

function persistSiteCache(tabId, source, data) {
  chrome.storage.session.set({ [`${SC_PREFIX}${tabId}`]: { source, data } }).catch(() => {});
}

function clearSessionSiteCache(tabId) {
  chrome.storage.session.remove(`${SC_PREFIX}${tabId}`).catch(() => {});
}

async function restoreSiteCachesFromSession() {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith(SC_PREFIX)) continue;
      const tabId = parseInt(key.slice(SC_PREFIX.length), 10);
      if (isNaN(tabId) || !val?.source || !val?.data) continue;
      SITE_CACHES[val.source]?.set(tabId, val.data);
    }
  } catch (_) {}
}

/** Return cached site data for a tab, regardless of which site it came from. */
function getSiteCache(tabId) {
  for (const [source, cache] of Object.entries(SITE_CACHES)) {
    if (cache.has(tabId)) return { source, data: cache.get(tabId) };
  }
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
  for (const cache of Object.values(SITE_CACHES)) cache.delete(tabId);
  clearSessionSiteCache(tabId);
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
