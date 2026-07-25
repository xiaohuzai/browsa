// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG / SET_CONFIG: read/write storage
//   - CLEAR_HISTORY: clear per-tab history

import * as storage from './lib/storage.js';
import { ping, ProviderConfigError } from './lib/openai-client.js';
import { PAGE_CONTEXT_PREFIX } from './lib/constants.js';
import {
  streamPorts, streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  subChatControllers, subChatPorts,
  initStreamState, appendToStreamState, clearStreamState
} from './lib/state.js';
import { handleChat } from './lib/handlers/chat-handler.js';
import { handleSubchat, handleSubchatAbort } from './lib/handlers/subchat-handler.js';
import { handleSession } from './lib/handlers/session-handler.js';
import { shouldSummarize, maybeSummarizeAttachment } from './lib/handlers/attach-summarizer.js';
import { checkAndRecordAttachChange } from './lib/handlers/attach-change-tracker.js';
// Re-exported for tests: `const bg = await import('../background.js'); const { streamPorts, ... } = bg;`
export {
  streamPorts, streamState, chatControllers,
  activeRunIds, pendingApprovals, pendingClarifications,
  subChatControllers, subChatPorts,
  initStreamState, appendToStreamState, clearStreamState
};
import { extractActiveTab, buildPageContextText, ensureReadabilityInjected } from './lib/page-extractor.js';

// Capability hints: browsa rendering rules injected automatically so users
// never need to configure them manually. Shared by both CHAT (full turn,
// with page context/domain rules/history) and SUBCHAT (scoped detail-thread
// side-conversation, see openDetailThread in sidepanel.js) — both render
// through the same markdown/Mermaid/ECharts/Markmap/KaTeX pipeline.
const CAPABILITY_HINTS = [
  'When writing mathematical expressions or formulas, always use LaTeX notation: wrap inline math with $...$ and display/block math with $$...$$. This applies everywhere including inside Markdown table cells — never write formulas as plain text in tables.',
  'When drawing diagrams or charts, output Mermaid code blocks (```mermaid) directly in your response. The chat UI renders Mermaid natively — do not create HTML files or write files to disk for diagrams.',
  'When generating Mermaid diagrams, always quote node labels that contain special characters (<, >, /, \\, (, ), {, }, ;, #, ~, %) using double-quoted syntax: ["label text"].',
  'In Markdown, always place punctuation outside bold/italic delimiters: write **text**, not **text,**.',
  'In Markdown, always put a space between Chinese/CJK text and ** or * emphasis delimiters when they would otherwise be directly adjacent — e.g. write 一个 **"GPU 利用率"** 因子, never 一个**"GPU 利用率"**因子. Without that space, if the emphasized text itself starts or ends with punctuation like quotation marks, CommonMark cannot treat the ** as a valid opening/closing delimiter and renders it as literal asterisks instead of bold.',
  'When your answer covers multiple sub-questions or sections, give each one an actual Markdown heading (## or ###) — never a plain unformatted line of text pretending to be a title. A bare line like "BF16 比 FP16 强在哪?" followed by a paragraph renders with no visual distinction from body text; "### BF16 比 FP16 强在哪?" renders as a real heading.',
  'When listing multiple parallel points, reasons, or comparisons (even just 2-3 short ones), format them as a Markdown list (- item per line or 1. item per line) instead of separate plain lines with no list marker — plain consecutive lines render as one undifferentiated block with no visual separation between items.',
  'In Mermaid diagrams, NEVER use Markdown bold (**text**) or italic (*text*) inside node labels — they display as literal asterisks. Instead use HTML: <b>text</b> for bold, <i>text</i> for italic. Example: A["<b>Title</b><br/>subtitle"] not A["**Title**<br/>subtitle"].',
  'In Mermaid diagrams, use $$...$$ (KaTeX) for math inside node labels with SINGLE backslashes: A["$$T = \\frac{D_{vol}}{B_{bw}}$$"]. Write the formula EXACTLY ONCE per label, wrapped in $$...$$ — never write a compact/plain-text version of the formula (e.g. "T=D/BW+O/R") followed by the LaTeX version in the same label; if you want to explain the formula, put the explanation in a separate node or as plain text OUTSIDE the $$...$$ span, never a second unwrapped copy of the formula itself. Never use double backslashes (\\\\frac) — single backslash only inside $$...$$.',
  'For data visualizations (bar charts, line charts, pie charts, scatter plots, etc.), output an ECharts option object as JSON in a ```echarts code block. The chat UI renders it natively. Example: ```echarts\n{"xAxis":{"type":"category","data":["A","B","C"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2,3]}]}\n```',
  'In ECharts option JSON, NEVER put HTML tags like <b>, <br/>, or <span> inside title/legend/axis/label text fields (e.g. title.text) — unlike Mermaid node labels, ECharts text fields render as plain text, so HTML tags show up as literal characters instead of being interpreted. Use \\n for line breaks in text fields. If you need mixed styling within one text field, use ECharts\' own rich-text syntax (a "rich" object in textStyle keyed by style name, referenced as {styleName|text} in the text string) — never raw HTML.',
  'For mind maps / outlines / hierarchical breakdowns (a topic and its sub-points, a video note\'s table of contents, etc.), output a ```markmap code block containing a plain Markdown outline (headings # ## ### and/or nested - lists) — not Mermaid syntax and not JSON. The chat UI renders it as an interactive mind map natively.',
  'Do not use ```markmap for flowcharts, sequence diagrams, or timelines — use ```mermaid for those. ```markmap is only for a plain nested outline of headings/bullets.',
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
          files: ['lib/content-scripts/selection-toolbar.js']
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

// Streaming port/stream-state/controller Maps (streamPorts, streamState,
// chatControllers, idleTimerResetters, activeRunIds, pendingApprovals,
// pendingClarifications, subChatControllers, subChatPorts) live in
// lib/state.js — imported above — since the extracted CHAT/SUBCHAT handlers
// in lib/handlers/*.js need the same Map instances.

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
      // Sent by lib/content-scripts/selection-toolbar.js when user clicks a toolbar button.
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

    case 'YOUTUBE_DATA':
    case 'JUEJIN_ARTICLE':
    case 'ZHIHU_CONTENT':
    case 'DEDAO_ARTICLE':
    case 'GEEKTIME_ARTICLE':
    case 'BILIBILI_VIDEO':
    case 'XUEQIU_DATA':
    case 'TWITTER_TWEET':
    case 'XIAOYUZHOU_EPISODE': {
      const { site, field } = SITE_MESSAGE_MAP[msg.type];
      const tabId = sender?.tab?.id;
      if (tabId) {
        const data = msg[field];
        SITE_CACHES[site].set(tabId, data);
        persistSiteCache(tabId, site, data);
      }
      return { ok: true };
    }

    case 'SEEK_VIDEO': {
      // In-place seek a video tab's <video> to a timestamp. Fired by
      // clickable [mm:ss] markers in video-note replies. The side panel
      // falls back to opening the source URL with ?t= when this returns
      // ok:false (tab closed, navigated away, or no <video> on the page).
      const tabId = msg.tabId;
      if (!tabId) return { ok: false, error: 'no tabId' };
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          // MAIN world so YouTube's #movie_player.seekTo (a method the page
          // attaches to the element) is reachable - page-set custom props
          // aren't visible from the ISOLATED world's DOM wrappers.
          world: 'MAIN',
          func: (seconds) => {
            const v = document.querySelector('#movie_player video, #bilibili-player video, video');
            if (!v) return { ok: false };
            // YouTube exposes seekTo on #movie_player - its custom progress
            // bar / chapters sync cleanly via the official API. Bilibili and
            // others fall back to currentTime + nudge events so their custom
            // UIs (danmaku, progress bar) follow.
            const yt = document.querySelector('#movie_player');
            if (yt && typeof yt.seekTo === 'function') {
              yt.seekTo(seconds, true);
            } else {
              v.currentTime = seconds;
              v.dispatchEvent(new Event('seeking'));
              v.dispatchEvent(new Event('timeupdate'));
            }
            return { ok: true };
          },
          args: [Number(msg.seconds) || 0],
        });
        return res?.result || { ok: false };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
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

    case 'ATTACH_PDF_CONFIRM': {
      // Side panel finished pdf.js text extraction (or fell back to the
      // placeholder text on any parse failure/timeout) and hands us the final
      // text to store — mirrors ATTACH_SCREENSHOT_CONFIRM's two-step handoff.
      const { text, metaUrl, metaTitle, numPages } = msg;
      if (!text) return { ok: false, error: 'no text' };
      const all = await storage.getAll();
      let finalText = text;
      const maskRules = all.maskRules || [];
      if (maskRules.length) {
        for (const rule of maskRules) {
          if (!rule.pattern) continue;
          try {
            const re = new RegExp(rule.pattern, rule.flags || 'gi');
            finalText = finalText.replace(re, rule.replacement || '***');
          } catch (_) {}
        }
      }
      const pdfCtx = {
        meta: { url: metaUrl || '', title: metaTitle || '' },
        mode: 'pdf',
        text: finalText,
        format: numPages ? `pdf-text, ${numPages} pages` : 'pdf-text'
      };
      const contextText = buildPageContextText(pdfCtx);
      const historyEntry = { role: 'user', content: contextText };
      // Same asymmetry ATTACH_PAGE already guards against: a large PDF's
      // extracted text is resent in FULL on every subsequent turn, and
      // pdf-extractor.js's own DEFAULT_MAX_CHARS (500K) only guards against
      // extreme sizes via lossy truncation -- it's not a substitute for the
      // LLM-based compression pass below, which most oversized-but-under-500K
      // PDFs (e.g. a 50-100 page document) would otherwise never get.
      const willSummarize = all.autoSummarizeAttachments !== false && shouldSummarize(finalText, all.summarizeThresholdChars);
      if (willSummarize) historyEntry.attachId = crypto.randomUUID();
      await storage.appendToHistory(historyEntry);
      console.log(`browsa[bg]: pdf attached — ${finalText.length} chars, ${numPages || '?'} pages`);
      if (willSummarize) {
        maybeSummarizeAttachment({
          attachId: historyEntry.attachId,
          ctx: pdfCtx,
          provider: all.providers?.[all.activeProvider]
        });
      }
      return { ok: true };
    }

    case 'SAVE_SESSION':
    case 'GET_SESSIONS':
    case 'LOAD_SESSION':
    case 'DELETE_SESSION':
    case 'RENAME_SESSION':
    case 'CLEAR_ALL_SESSIONS':
    case 'GET_SESSION_FULL':
      return handleSession(msg);

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
            tabId,
            maxTextChars: all.maxTextChars,
            xhsXhrNote: xhsXhrCache.get(tabId) || null,
            siteCache: getSiteCache(tabId),
            query: msg.query || '',
            preClean: true
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
        // PDF bytes fetched: hand off to sidepanel.js for pdf.js text extraction.
        // Like screenshot, history storage is deferred until ATTACH_PDF_CONFIRM.
        if (ctx.mode === 'pdf-pending' && ctx.pdfBase64) {
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

        // Local, offline change detection: warn the model (not the UI, no
        // new chip/badge) when a re-attached page's content differs from the
        // last time it was attached. Keyed by (mode, url) rather than just
        // url -- comparing across different extraction modes for the same
        // page would produce false "changed" signals, since reader/dom/full
        // naturally yield different text for the same page.
        if (ctx.meta?.url && !['selected', 'pdf-url', 'screenshot'].includes(ctx.mode) && (ctx.text || '').length > 50) {
          const changeInfo = await checkAndRecordAttachChange(`${ctx.mode}::${ctx.meta.url}`, ctx.text);
          if (changeInfo.changed) ctx.changedSinceLastAttach = changeInfo;
        }

        // All other modes: save to global history immediately.
        const contextText = buildPageContextText(ctx);
        const historyEntry = { role: 'user', content: contextText };
        // Stamp the video source on video page-contexts (youtube/bilibili)
        // so video-note replies can turn their [mm:ss] markers into clickable
        // seek links. Other pages have no seekable <video> target.
        if (ctx.mode === 'youtube' || ctx.mode === 'bilibili') {
          historyEntry.videoSrc = {
            platform: ctx.mode,
            url: ctx.meta?.url || '',
            tabId,
          };
        }
        // Very long attachments (e.g. a 4-5 hour video's transcript) get
        // resent in FULL on every subsequent turn (buildMessages pushes the
        // whole history every time) — so it's worth a one-time chunk/
        // summarize/merge pass now rather than paying that cost (and risking
        // exceeding a smaller-context provider's window) on every message.
        // Stamp attachId BEFORE appending so maybeSummarizeAttachment can
        // find this exact entry later, then kick it off fire-and-forget
        // AFTER the response below is prepared — the raw text is never
        // rendered in the chat bubble, so there's no UI to block on.
        const willSummarize = all.autoSummarizeAttachments !== false && shouldSummarize(ctx.text, all.summarizeThresholdChars);
        if (willSummarize) historyEntry.attachId = crypto.randomUUID();
        await storage.appendToHistory(historyEntry);
        console.log(`browsa[bg]: page attached — ${contextText.length} chars, mode=${mode}`);
        if (willSummarize) {
          maybeSummarizeAttachment({
            attachId: historyEntry.attachId,
            ctx,
            provider: all.providers?.[all.activeProvider]
          });
        }
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

    case 'SUBCHAT':
      return handleSubchat(msg, CAPABILITY_HINTS);

    case 'SUBCHAT_ABORT':
      return handleSubchatAbort(msg);

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
        tabId: typeof t === 'number' ? t : null,
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

    case 'CHAT':
      return handleChat(msg, CAPABILITY_HINTS, CHOICE_REQUEST_HINT);

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// Resolve a tabId from a message context. CHAT messages carry tabId explicitly;
// GET_PAGE_CONTEXT might not, so we fall back to the sender's tab.
function tabIdOf(msg, sender) {
  if (msg?.tabId != null) return msg.tabId;
  if (sender?.tab?.id != null) return sender.tab.id;
  return null;
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

// Maps each site content script's push-message type to which SITE_CACHES
// entry it writes and which field of the message carries the payload.
// Every entry here follows the exact same shape (SITE_CACHES[site].set(tabId,
// msg[field]); persistSiteCache(tabId, site, msg[field])) — the single
// generic case below in handle() replaces what used to be 9 near-identical
// copy-pasted case blocks. Adding a new site's push message only needs a
// new SITE_CACHES entry (above) plus one line here.
const SITE_MESSAGE_MAP = {
  YOUTUBE_DATA:       { site: 'youtube',    field: 'video' },
  JUEJIN_ARTICLE:     { site: 'juejin',     field: 'article' },
  ZHIHU_CONTENT:      { site: 'zhihu',      field: 'content' },
  DEDAO_ARTICLE:      { site: 'dedao',      field: 'article' },
  GEEKTIME_ARTICLE:   { site: 'geektime',   field: 'article' },
  BILIBILI_VIDEO:     { site: 'bilibili',   field: 'video' },
  XUEQIU_DATA:        { site: 'xueqiu',     field: 'data' },
  TWITTER_TWEET:      { site: 'twitter',    field: 'tweet' },
  XIAOYUZHOU_EPISODE: { site: 'xiaoyuzhou', field: 'episode' },
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
