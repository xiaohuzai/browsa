// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG / SET_CONFIG: read/write storage
//   - CLEAR_HISTORY: clear per-tab history

import * as storage from './lib/storage.js';
import { ping, ProviderConfigError } from './lib/llm-client.js';
import { PAGE_CONTEXT_PREFIX } from './lib/constants.js';
import {
  streamPorts, streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  subChatControllers, subChatPorts,
  initStreamState, appendToStreamState, clearStreamState,
  STREAM_KEEPALIVE_ALARM
} from './lib/state.js';
import { handleChat, fetchLlmsTxt } from './lib/handlers/chat-handler.js';
import { handleSubchat, handleSubchatAbort } from './lib/handlers/subchat-handler.js';
import { handleSession } from './lib/handlers/session-handler.js';
import { shouldSummarize, maybeSummarizeAttachment } from './lib/handlers/attach-summarizer.js';
import { checkAndRecordAttachChange } from './lib/handlers/attach-change-tracker.js';
import { repairMermaid } from './lib/handlers/mermaid-repair.js';
import { handleExplainPort } from './lib/handlers/selection-explain.js';
import { respondOpencodePermission, respondOpencodeQuestion } from './lib/opencode-client.js';
import { resolveChatModel } from './lib/handlers/provider-resolver.js';
import { ASR_DEFAULTS, ASR_SUBTITLE_SOURCE, resolveVideoDurationSec } from './lib/handlers/attach-asr.js';
import { videoUrlMatches } from './lib/video-url.js';
// Re-exported for tests: `const bg = await import('../background.js'); const { streamPorts, ... } = bg;`
export {
  streamPorts, streamState, chatControllers,
  activeRunIds, pendingApprovals, pendingClarifications,
  subChatControllers, subChatPorts,
  initStreamState, appendToStreamState, clearStreamState
};
import { extractActiveTab } from './lib/page-extractor.js';
import { maybeDeepExtract } from './lib/agentic-extract.js';
import { inlinePageImages } from './lib/page-images.js';
import { buildPageContextText, interleaveImageParts } from './lib/message-builder.js';
import { redactUrlCredentials, redactTextUrls } from './lib/sanitize-url.js';
import { ensureReadabilityInjected } from './lib/readability-injector.js';

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
  'Never fabricate or invent image URLs (e.g. made-up https://i.imgur.com/... links) in your replies — a URL you cannot verify is a real, existing image will render as a broken placeholder. The chat UI has NO native Markdown-image source of truth, so if you want to show a diagram, chart, or mind map, output a ```mermaid, ```echarts, or ```markmap code block (rendered live by the chat UI) or a plain ASCII/text diagram instead — never a made-up image link.',
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
  // 菜单标题与浮动工具条（selection-toolbar）共用同一组 i18n 键——同一动作的
  // 两个入口必须长一样（2026-08-31 用户反馈：右键菜单是英文+emoji、浮动条是
  // 本地语言，观感割裂）。getMessage 在 SW 里可用；键缺失回退英文默认。
  const menuTitle = (key, fallback) => {
    try { return chrome.i18n.getMessage(key) || fallback; } catch (_) { return fallback; }
  };
  chrome.contextMenus.create({ id: 'browsa', title: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-ask',       title: menuTitle('toolbarAsk', 'Ask'),           parentId: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-explain',   title: menuTitle('toolbarExplain', 'Explain'),   parentId: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-translate', title: menuTitle('toolbarTranslate', 'Translate'), parentId: 'browsa', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'browsa-summarize', title: menuTitle('toolbarSummarize', 'Summarize'), parentId: 'browsa', contexts: ['selection'] });

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

// Deep-extraction progress rides the nav port the side panel already holds,
// so the attach progress pill updates live while ATTACH_PAGE is still
// awaiting (the pill is cleared by the attach flow when the response lands).
function pushDeepProgress(tabId, text) {
  const set = navPorts.get(tabId);
  if (!set) return;
  for (const p of set) {
    try { p.postMessage({ type: 'DEEP_EXTRACT_PROGRESS', tabId, text }); } catch (_) {}
  }
}

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

  if (port.name === 'browsa-explain') {
    // 划词内联解释：content script 的浮层每点一次「解释」开一条一次性端口，
    // 首条消息即请求（无需 HELLO 握手——connect 本身唤醒 SW，onConnect 必然
    // 先于端口消息注册好监听，不存在 subchat 当年的重连竞态）。断开即中止。
    handleExplainPort(port);
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
  // Fires every 30s while a chat stream is in flight. Waking the service
  // worker resets its idle timer, which keeps it alive when the side panel
  // that started the stream is gone (closed panel used to mean the SW could
  // die mid-stream and the reply was lost with its in-memory controller).
  if (alarm.name === STREAM_KEEPALIVE_ALARM) {
    if (chatControllers.size === 0) chrome.alarms.clear(STREAM_KEEPALIVE_ALARM);
  }
});

// videoUrlMatches now lives in lib/video-url.js (shared with the side
// panel's live-tab resolution for seekVideo / the transcript drawer).

async function tabMatchesVideo(tabId, sourceUrl) {
  // A missing source URL (older stamps) can't be verified — allow, matching
  // pre-0.33.1 behavior; the video-element probe still degrades safely.
  if (!sourceUrl) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    return videoUrlMatches(tab?.url, sourceUrl);
  } catch (_) {
    return false; // tab gone
  }
}

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
      if (tabId == null) return { ok: false, error: 'no tabId' };
      // videoSrc.tabId is persisted in saved sessions — after a browser
      // restart those ids are recycled, and blind injection could seek an
      // UNRELATED tab's video. Revalidate the tab still shows the source
      // video; mismatch degrades to the side panel's ?t= URL fallback.
      if (!(await tabMatchesVideo(tabId, msg.url))) return { ok: false, error: 'tab no longer shows the source video' };
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

    case 'GET_VIDEO_TIME': {
      // Read the video tab's current playback position (for the transcript
      // drawer's playback-follow highlight). Mirrors SEEK_VIDEO's element
      // lookup so both agree on which <video> is the target.
      const tabId = msg.tabId;
      if (tabId == null) return { ok: false, error: 'no tabId' };
      // Same stale-tabId revalidation as SEEK_VIDEO — otherwise a recycled
      // id makes the drawer follow some OTHER tab's playback.
      if (!(await tabMatchesVideo(tabId, msg.url))) return { ok: false, error: 'tab no longer shows the source video' };
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const v = document.querySelector('#movie_player video, #bilibili-player video, video');
            if (!v) return { ok: false };
            return { ok: true, time: v.currentTime || 0, paused: !!v.paused };
          },
        });
        return res?.result || { ok: false };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'SET_ACTIVE_PROVIDER': {
      // model 可空：多模型 provider 上主页下拉选中的具体模型（Alias · model），
      // 空串 = 未指定，聊天侧回退 provider.model
      await storage.setActiveProvider(msg.name, msg.model || '');
      return { activeProvider: msg.name };
    }

    case 'REPAIR_MERMAID': {
      // 「AI 修复重绘」：用当前 provider 修复渲染失败的 mermaid 源码。一次独立
      // 补全调用，不进聊天历史（view-only 修复，气泡原文不动）；修复稿由
      // sidepanel 先过本地 mermaid parse 校验，通过才就地替换错误卡。
      try {
        const cfg = await storage.getAll();
        const provider = cfg.providers?.[cfg.activeProvider];
        if (!provider?.baseUrl?.trim()) return { ok: false, error: 'No active AI provider configured' };
        const model = resolveChatModel(provider, cfg);
        const source = await repairMermaid({ provider, model, source: String(msg.source || ''), errorText: String(msg.error || '') });
        if (!source) return { ok: false, error: 'Model returned no mermaid code' };
        return { ok: true, source };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'SET_CONTEXT_MODE': {
      await storage.setContextMode(msg.mode);
      return { contextMode: msg.mode };
    }

    case 'UNDO_ATTACH': {
      // The panel sends the attachId stamped on the entry at attach time —
      // undo must remove the entry the CLICKED label owns. With two
      // attachments in history, removeLastPageContext() (the legacy no-id
      // path below) always removes the LAST one, so undoing the older attach
      // left its content in context and deleted the newer entry instead
      // (2026-09-03: undo attach #1, ask, and the model still answered from
      // page #1). Not-found (trimmed/undone race) is an honest ok:false —
      // falling back to "last" would delete an unrelated attachment.
      if (msg.attachId) {
        const removedIdx = await storage.removeHistoryEntryByAttachId(msg.attachId);
        return { ok: removedIdx >= 0, removedIdx };
      }
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
        `${PAGE_CONTEXT_PREFIX}\nURL: ${redactUrlCredentials(metaUrl || '')}\nTitle: ${metaTitle || ''}\nMode: screenshot\n---\n\n(screenshot)`;
      // attachId = the entry's undo identity (panel's 撤销 removes THIS entry
      // by id, not by "last page-context" — see UNDO_ATTACH).
      const attachId = crypto.randomUUID();
      await storage.appendToHistory({
        role: 'user',
        attachId,
        content: [
          { type: 'text', text: contextText },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
      return { ok: true, attachId };
    }

    case 'ATTACH_PDF_CONFIRM': {
      // Side panel finished pdf.js text extraction (or fell back to the
      // placeholder text on any parse failure/timeout) and hands us the final
      // text to store — mirrors ATTACH_SCREENSHOT_CONFIRM's two-step handoff.
      const { text, metaUrl, metaTitle, numPages, figureImages, arxivHeader } = msg;
      if (!text) return { ok: false, error: 'no text' };
      const all = await storage.getAll();
      // arXiv enrichment: the sidepanel fetched the paper's Atom API metadata
      // (authors/categories/dates/DOI) and passes the formatted header block
      // in. It rides the context header (like URL/Title) — the model sees
      // provenance up front without it polluting the extracted body.
      let headerBlock = '';
      if (typeof arxivHeader === 'string' && arxivHeader.trim()) {
        headerBlock = arxivHeader.trim() + '\n';
      }
      let finalText = text;
      // Figure preservation (vision-capable providers): each extracted figure
      // arrives as {url, caption, page} (caption may be null). The caption is
      // the positional anchor - it is listed in the body text under a Figures
      // section (so the model can match "Figure 3" in the prose to the labeled
      // figure), and the image_url blocks follow in the SAME order. This gives
      // figure<->text correspondence WITHOUT page markers, which the (page-
      // boundary-less) wasm markdown cannot provide. Bare-string figureImages
      // (older callers / fallbacks) are normalized to {url} with no caption.
      const figures = (Array.isArray(figureImages) ? figureImages : [])
        .map((f) => (typeof f === 'string' ? { url: f } : f))
        .filter((f) => f && f.url);
      if (figures.length) {
        const lines = figures.map((f, i) =>
          `${i + 1}. ${f.caption || `Figure on page ${f.page || '?'}`}`);
        // PDF 文本提取不保留插图位置（wasm markdown 无占位），图片按文档顺序
        // 附在文末；引用约定与视频截图统一：回答中用 [图N]（N 为顺序号）。
        finalText += '\n\n## Figures\nThe attached images are the document\'s figures in document order — refer to them as [图N] (N = order below) when citing them in your reply:\n' + lines.join('\n');
      }
      // paper flag: paper-shaped analysis prompts downstream (auto-summarizer
      // digest, paper analysis card). arXiv URL is the current signal; the
      // sidepanel's detection result wins if it ever disagrees.
      let isPaper = !!msg.paper;
      if (!isPaper) {
        try { isPaper = /(^|\.)arxiv\.org$/i.test(new URL(metaUrl || '').hostname); } catch (_) { /* non-URL */ }
      }
      const pdfCtx = {
        meta: { url: metaUrl || '', title: metaTitle || '', paper: isPaper },
        mode: 'pdf',
        text: finalText,
        format: numPages ? `pdf-text, ${numPages} pages` : 'pdf-text'
      };
      const contextText =
        `${PAGE_CONTEXT_PREFIX}\n` +
        `URL: ${redactUrlCredentials(metaUrl || '')}\n` +
        `Title: ${metaTitle || ''}\n` +
        (headerBlock ? headerBlock : '') +
        `Mode: ${pdfCtx.mode}${pdfCtx.format ? ` | ${pdfCtx.format}` : ''}\n` +
        `---\n\n${redactTextUrls(finalText)}`;
      // Store the page text plus figure JPEGs as a multimodal content array -
      // exactly like ATTACH_SCREENSHOT_CONFIRM - so figures are resent on every
      // turn alongside the text. buildMessages pushes history entries through
      // unchanged, so the image_url blocks reach the provider each turn. The
      // image_url blocks follow the text block in the SAME order as the
      // Figures section above, preserving the caption<->image pairing. Text-
      // only PDFs (no figures, or figure extraction disabled/failed) keep the
      // plain-string content shape used everywhere else, so history stays
      // uniform and Hermes's text-only flattening is unaffected.
      const historyEntry = figures.length
        ? {
            role: 'user',
            content: [
              { type: 'text', text: contextText },
              ...figures.map((f) => ({ type: 'image_url', image_url: { url: f.url } }))
            ]
          }
        : { role: 'user', content: contextText };
      // Same asymmetry ATTACH_PAGE already guards against: a large PDF's
      // extracted text is resent in FULL on every subsequent turn, and
      // pdf-extractor.js's own DEFAULT_MAX_CHARS (500K) only guards against
      // extreme sizes via lossy truncation -- it's not a substitute for the
      // LLM-based compression pass below, which most oversized-but-under-500K
      // PDFs (e.g. a 50-100 page document) would otherwise never get.
      const willSummarize = all.autoSummarizeAttachments !== false && shouldSummarize(finalText, all.summarizeThresholdChars);
      // attachId is stamped on EVERY attach entry (not only summarized ones) —
      // it's also the undo identity the panel's 撤销 button deletes by.
      historyEntry.attachId = crypto.randomUUID();
      await storage.appendToHistory(historyEntry);
      console.log(`browsa[bg]: pdf attached — ${finalText.length} chars, ${numPages || '?'} pages`);
      if (willSummarize) {
        maybeSummarizeAttachment({
          attachId: historyEntry.attachId,
          ctx: pdfCtx,
          provider: all.providers?.[all.activeProvider]
        });
      }
      // contextText = the exact text the model receives (header incl. the
      // arXiv block + body incl. the Figures section) — the sidepanel's
      // 检查 dialog displays this, not the pre-header pdfText it holds.
      return { ok: true, contextText, attachId: historyEntry.attachId };
    }

    case 'ATTACH_ASR_CONFIRM': {
      // Side panel finished the ASR pipeline (download audio -> upload to
      // 火山方舟 Files API -> poll -> Responses API ASR transcript) and hands
      // us the final subtitle text to store. Mirrors ATTACH_PDF_CONFIRM's
      // two-step handoff. The transcript is a `[mm:ss] text` block which, when
      // stamped with videoSrc below, becomes clickable seek links in the
      // rendered reply (linkifyTimestamps).
      const { text, metaUrl, metaTitle, platform, figureImages } = msg;
      if (!text) return { ok: false, error: 'no text' };
      const all = await storage.getAll();
      let finalText = text;
      // 关键帧截图（视频精读专属，镜像 ATTACH_PDF_CONFIRM 的 figure 管线）：模型在
      // 精读文档里标记的 [截屏] 时刻，sidepanel 从视频 blob 抽帧后以 {url, caption}
      // 传入。captions 按顺序列进正文 Figures 段（模型把「截图 N」与 image_url 块
      // 一一对应），image_url 块随 history 每轮重发给多模态 provider。
      const figures = (Array.isArray(figureImages) ? figureImages : [])
        .map((f) => (typeof f === 'string' ? { url: f } : f))
        .filter((f) => f && f.url);
      if (figures.length) {
        // 锚点说明（VinQA 式引用约定）：精读文档的 [图N] 锚点行已带 caption 与
        // 时间戳，无需再列编号清单；这里只告诉模型对应关系与引用方式。
        finalText += `\n\n（文中 [图N] 标记按顺序对应随附的 ${figures.length} 张视频截图；在回答中引用截图时请使用相同的 [图N] 标记。）`;
      }
      // 原始平台由 sidepanel 透传（bilibili / youtube）——决定 mode、videoSrc.platform
      // 和日志标签。缺省回退 bilibili（兼容旧调用/测试）。
      const asrPlatform = (platform === 'youtube') ? 'youtube' : 'bilibili';
      // format 标签：音频转写 `${platform}-asr`（默认，兼容旧调用）；视频精读由
      // sidepanel 传 `${platform}-video`，让下游上下文/日志能区分两种产物。
      const asrFormat = (typeof msg.format === 'string' && msg.format) ? msg.format : `${asrPlatform}-asr`;
      const asrCtx = {
        meta: { url: metaUrl || '', title: metaTitle || '' },
        mode: asrPlatform,
        text: `${finalText}\n\nNote: ${VIDEO_NOTE_HINT}`,
        format: asrFormat,
      };
      // 关键帧截图（视频精读专属，镜像 ATTACH_PDF_CONFIRM 的 figure 管线）：模型在
      // 精读文档里标记的 [截屏] 时刻，sidepanel 从视频 blob 抽帧后以 {url, caption}
      // 传入。sidepanel 已把文档里的标记行改写为 [图N] 锚点（带 caption 与时间戳），
      // 这里按锚点位置真交错入库——图片部件出现在其语义位置，而非文末堆图。
      const contextText = buildPageContextText(asrCtx);
      // 有关键帧时存成交错多模态 content（与 ATTACH_PDF_CONFIRM 同为 image_url 部件，
      // 但按 [图N] 锚点插入文档中间）。buildMessages 把 history 原样透传，截图每轮
      // 随文本一起发给多模态 provider。无截图保持纯字符串 content 形状不变。
      const historyEntry = figures.length
        ? { role: 'user', content: interleaveImageParts(contextText, figures) }
        : { role: 'user', content: contextText };
      // Stamp videoSrc so the [mm:ss] transcript renders as clickable seek
      // links (same platform/url/tabId shape as ATTACH_PAGE stamps on video
      // page-contexts).
      historyEntry.videoSrc = {
        platform: asrPlatform,
        url: metaUrl || '',
        tabId: msg.tabId ?? null,
      };
      const willSummarize = all.autoSummarizeAttachments !== false && shouldSummarize(finalText, all.summarizeThresholdChars);
      // attachId is stamped on EVERY attach entry (not only summarized ones) —
      // it's also the undo identity the panel's 撤销 button deletes by.
      historyEntry.attachId = crypto.randomUUID();
      await storage.appendToHistory(historyEntry);
      console.log(`browsa[bg]: ${asrPlatform} asr attached — ${finalText.length} chars${figures.length ? `, ${figures.length} keyframes` : ''}`);
      if (willSummarize) {
        maybeSummarizeAttachment({
          attachId: historyEntry.attachId,
          ctx: asrCtx,
          provider: all.providers?.[all.activeProvider]
        });
      }
      return { ok: true, attachId: historyEntry.attachId };
    }

    case 'ASR_FRESH_URLS': {
      // 播放地址过期（deadline 签名 m4s URL，CDN 无条件 403）的自愈重试：在页内重调
      // playurl API 换全新签名 URL。由 sidepanel 在下载 403 时触发一次；失败则返回
      // 原因由 sidepanel 走现有兜底（明示报错），不在此抛错。
      // bilibili 重调 playurl（bvid/cid + WBI 签名）；youtube 重调 /player（新 PO token）。
      const { tabId, platform } = msg;
      try {
        if (platform === 'youtube') {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: ['lib/content-scripts/youtube-content-script.js']
          });
          const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            // videoId parsed INSIDE the func from window.location (never the
            // service-worker closure — executeScript re-evaluates func in the
            // page, closures don't survive serialization; the countImages lesson).
            func: async () => {
              const freshFn = window.__browsaFetchFreshYouTubeStreams;
              const vid = (() => {
                try { return new URLSearchParams(window.location.search).get('v') || ''; }
                catch (_) { return ''; }
              })();
              if (typeof freshFn !== 'function' || !vid) {
                return { ok: false, error: '脚本未注入或缺 videoId' };
              }
              // Prefer pot-bearing audio streams from the page's real player
              // response (pot-less ANDROID URLs 403 — real test 2026-08-25).
              try {
                const potStreams = (typeof window.__browsaGetPlayerAudioStreams === 'function')
                  ? window.__browsaGetPlayerAudioStreams(vid)
                  : [];
                if (Array.isArray(potStreams) && potStreams.length > 0) {
                  const usable = potStreams.filter((s) => s.url && s.hasPot);
                  if (usable.length > 0) return { ok: true, streams: usable };
                }
              } catch (_) {}
              const fresh = await freshFn(vid);
              const audios = (Array.isArray(fresh.streams) ? fresh.streams : []).filter((s) => s.type === 'audio' && s.url);
              if (!audios.length) return { ok: false, error: 'player 返回空音频流' };
              return { ok: true, streams: audios };
            }
          });
          const r = res?.result;
          if (r?.ok && Array.isArray(r.streams) && r.streams.length) {
            console.log(`browsa: ASR_FRESH_URLS(youtube) ok — ${r.streams.length} fresh audio streams`);
            return { ok: true, streams: r.streams };
          }
          console.warn('browsa: ASR_FRESH_URLS(youtube) refresh failed:', r?.error || 'no result');
          return { ok: false, error: r?.error || 'no result' };
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['lib/content-scripts/bilibili-content-script.js']
        });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async () => {
            try {
              const pi = window.__playinfo__?.data || window.__playinfo__;
              // bvid 不能读 __playinfo__（playurl 响应无此字段，恒空串 → 自愈永远
              // 拦死）；与字幕提取同策略：URL path 优先，__INITIAL_STATE__ 兜底。
              const pathBvid = (window.location?.pathname || '').match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1] || '';
              const vd = window.__INITIAL_STATE__?.videoData;
              const bvid = pathBvid || pi?.bvid || vd?.bvid || '';
              const cid = pi?.cid || vd?.cid || 0;
              const freshFn = window.__browsaFetchFreshBilibiliStreams;
              if (typeof freshFn !== 'function' || !bvid || !cid) {
                return { ok: false, error: '脚本未注入或缺 bvid/cid（页面可能未播放过）' };
              }
              const fresh = await freshFn(bvid, cid);
              // 返回全部流类型（audio/video/muxed），由 background 按 msg.want 过滤——
              // 视频解析模式需要 video/muxed 流一起刷新（want 缺省 'audio'，纯 ASR 行为不变）。
              const all = (Array.isArray(fresh) ? fresh : []).filter((s) => s.url);
              if (!all.length) return { ok: false, error: 'playurl 返回空流列表' };
              return { ok: true, streams: all };
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          }
        });
        const r = res?.result;
        if (r?.ok && Array.isArray(r.streams) && r.streams.length) {
          // want: 'audio'（缺省，纯 ASR）只回音频流；'all' 连 video/muxed 一起回
          //（视频解析模式的自愈刷新，sidepanel 拿到后重新选流）。
          const want = msg.want === 'all' ? 'all' : 'audio';
          const filtered = want === 'all' ? r.streams : r.streams.filter((s) => s.type === 'audio');
          console.log(`browsa: ASR_FRESH_URLS ok — ${filtered.length} fresh ${want} streams`);
          return { ok: true, streams: filtered };
        }
        console.warn('browsa: ASR_FRESH_URLS refresh failed:', r?.error || 'no result');
        return { ok: false, error: r?.error || 'no result' };
      } catch (e) {
        console.warn('browsa: ASR_FRESH_URLS executeScript failed:', e?.message);
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case 'SAVE_SESSION':
    case 'GET_SESSIONS':
    case 'LOAD_SESSION':
    case 'DELETE_SESSION':
    case 'RENAME_SESSION':
    case 'PIN_SESSION':
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
        if (allCfg.providers[name]?.isOpencode) {
          // New conversation → fresh opencode server session (the agent's
          // transcript would otherwise carry over across "clear history").
          await storage.clearOpencodeSessionId(name);
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

          // Deep extraction (auto-escalation): when the heuristic pass
          // reports content it could not reach (URL pagination / load-more /
          // leftover collapsed expanders), finish the job — walk next pages
          // in a background tab and let the active provider click through
          // what the heuristics missed. Provider-agnostic, hard-capped, and
          // fail-open: any null/throw keeps the baseline result above.
          // Generic modes only — site fast paths own their extraction.
          if (['reader', 'dom', 'full', 'auto'].includes(ctx.mode) && all.deepExtractEnabled !== false) {
            try {
              const deep = await maybeDeepExtract({
                tabId,
                ctx,
                textCap: all.maxTextChars,
                query: msg.query || '',
                redoMode: ctx.autoMode || ctx.mode,
                sendProgress: (text) => pushDeepProgress(tabId, text)
              });
              if (deep) {
                ctx.text = deep.text;
                ctx.truncated.textLength = deep.text.length;
                ctx.deepExtract = { clicks: deep.clicks, pages: deep.pages };
              }
            } catch (_) { /* fail-open: baseline result wins */ }
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
        // Bilibili video WITHOUT subtitles + ASR enabled: hand off to sidepanel
        // for the ASR pipeline (download audio in page-world -> upload to 火山方舟
        // Files API -> poll -> Responses API transcript). Deferred storage until
        // ATTACH_ASR_CONFIRM, mirroring the pdf-pending handoff. The audio stream
        // URL is read fresh via the MAIN-world-exposed reader so the signed URL is
        // valid at handoff time. Detection keys off the structured noTranscript
        // flag (from synthesizeBilibiliResult), NOT the `## 字幕` text marker — auto
        // mode's silent Jina fallback can rewrite ctx.text and drop the marker.
        // `all.asr.subtitleSource === 'asr'` additionally forces the ASR handoff even
        // for videos that ALREADY have subtitles (user opted to prefer ASR
        // subtitles over low-quality originals — the strip/replace happens in the
        // sidepanel at ATTACH_ASR_CONFIRM time, keeping ctx.text intact for the
        // fail-open fallback).
        // Bilibili / YouTube video WITHOUT subtitles + ASR enabled: hand off to
        // sidepanel for the ASR pipeline (download audio in page-world -> upload to 火山方舟
        // Files API -> poll -> Responses API transcript). Deferred storage until
        // ATTACH_ASR_CONFIRM, mirroring the pdf-pending handoff. The audio stream
        // URL is read fresh via the MAIN-world-exposed reader so the signed URL is
        // valid at handoff time. Detection keys off the structured noTranscript
        // flag (from synthesizeBilibiliResult / synthesizeYouTubeResult), NOT the
        // `## 字幕`/`*(No captions...)*` text marker — auto mode's silent Jina
        // fallback can rewrite ctx.text and drop the marker.
        // `all.asr.subtitleSource === 'asr'` additionally forces the ASR handoff even
        // for videos that ALREADY have subtitles (user opted to prefer ASR
        // subtitles over low-quality originals — the strip/replace happens in the
        // sidepanel at ATTACH_ASR_CONFIRM time, keeping ctx.text intact for the
        // fail-open fallback).
        const isVideoPlatform = ctx.mode === 'bilibili' || ctx.mode === 'youtube';
        if (isVideoPlatform && all.asr?.enabled && (ctx.noTranscript || all.asr.subtitleSource === ASR_SUBTITLE_SOURCE.ASR)) {
          const asrCtx = await buildAsrPendingCtx(tabId, ctx);
          if (asrCtx) return { ok: true, ctx: asrCtx };
        } else if (isVideoPlatform && ctx.noTranscript) {
          // Video WITHOUT subtitles AND ASR not enabled: keep the
          // current behavior (plain video-info attach) but flag the ctx so
          // the sidepanel can hint that this video has no subtitles and
          // that enabling ASR would auto-transcribe it.
          ctx.noTranscriptHint = true;
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

        // llms.txt: fetch once per attach (NOT per chat turn) for the attached
        // page's own origin, and bake it into the stored page-context text.
        // This keeps the system prompt a byte-stable prefix (KV/prompt-cache
        // friendly) and ties site instructions to the page actually attached.
        // reader/dom/full/auto only: `selected` is a partial excerpt (quick
        // actions shouldn't pull in full site instructions), `jina` is a
        // third-party proxy, and the deferred paths (screenshot/pdf/asr) store
        // derived content — none should carry site instructions.
        if (['reader', 'dom', 'full', 'auto'].includes(ctx.mode)) {
          ctx = await withSiteInstructions(ctx, all);
        }
        // Video page-contexts (youtube/bilibili): append the video-note
        // formatting instruction to the stored text (same KV-cache rationale
        // as llms.txt — dynamic formatting hints ride in the trajectory, not
        // the static system prompt).
        if (ctx.mode === 'youtube' || ctx.mode === 'bilibili') {
          ctx = withVideoNote(ctx);
        }

        // 页面配图（reader/auto/jina）：正文 Markdown 里的 ![alt](url) 原位转成
        // [图N] 锚点行，图片在 SW 下载压缩成 JPEG dataURL 随条目交错入库——与视频
        // 截图 / PDF figure 同一套 [图N] 引用协议（回答引用 [图N]，渲染端还原缩略图）。
        // 全程 fail-open：无图/下载失败/无解码环境保持原文，绝不阻塞附加。
        // dom/full 是树状文本（无 Markdown 图片语法）、selected 是局部摘录，不参与。
        if (['reader', 'auto', 'jina'].includes(ctx.mode) && ctx.text) {
          try {
            const inlined = await inlinePageImages(ctx.text, { baseUrl: ctx.meta?.url || '' });
            if (inlined.figures.length) {
              ctx.text = inlined.text
                + `\n\n（文中 [图N] 标记按顺序对应随附的 ${inlined.figures.length} 张页面配图；在回答中引用配图时请使用相同的 [图N] 标记。）`;
              ctx.pageFigures = inlined.figures;
            }
          } catch (e) {
            console.warn('browsa: page image inlining failed, keeping plain text:', e?.message);
          }
        }

        // All other modes: save to global history immediately.
        const contextText = buildPageContextText(ctx);
        const pageFigures = Array.isArray(ctx.pageFigures) ? ctx.pageFigures : [];
        // 有配图时存成按 [图N] 锚点真交错的多模态 content（与 ATTACH_ASR_CONFIRM 的
        // 视频截图同构）；无配图保持纯字符串 content 形状不变。
        const historyEntry = pageFigures.length
          ? { role: 'user', content: interleaveImageParts(contextText, pageFigures) }
          : { role: 'user', content: contextText };
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
        // Stamped on EVERY attach entry (not only summarized ones): it is
        // also the undo identity the panel's 撤销 button deletes by.
        const willSummarize = all.autoSummarizeAttachments !== false && shouldSummarize(ctx.text, all.summarizeThresholdChars);
        historyEntry.attachId = crypto.randomUUID();
        await storage.appendToHistory(historyEntry);
        console.log(`browsa[bg]: page attached — ${contextText.length} chars, mode=${mode}${pageFigures.length ? `, ${pageFigures.length} page images` : ''}`);
        if (willSummarize) {
          maybeSummarizeAttachment({
            attachId: historyEntry.attachId,
            ctx,
            provider: all.providers?.[all.activeProvider]
          });
        }
        return { ok: true, ctx, attachId: historyEntry.attachId };
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
      // the agent so it can resume. opencode pending entries carry the
      // server session + request id and reply via the opencode endpoint;
      // card choices (once/always/deny) map onto opencode's reply enum
      // (deny → reject) — see showApprovalCard's btnLabels.
      const pending = pendingApprovals.get(msg.tabId);
      if (!pending) return { ok: false, error: 'no pending approval' };
      if (pending.kind === 'opencode') {
        try {
          await respondOpencodePermission({
            baseUrl: pending.baseUrl,
            apiKey: pending.apiKey,
            sessionId: pending.sessionId,
            requestId: pending.requestId,
            reply: msg.choice === 'deny' ? 'reject' : (msg.choice === 'always' ? 'always' : 'once'),
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e?.message };
        }
      }
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
      // User submitted a clarification response. Relay to the agent. The
      // opencode question flow expects {answers: [[label, …], …]} — browsa's
      // clarify card is free-text, so the response rides as the single
      // selected label (opencode's QuestionInfo has a `custom` answer path).
      const pending = pendingClarifications.get(msg.tabId);
      if (!pending) return { ok: false, error: 'no pending clarification' };
      if (pending.kind === 'opencode') {
        try {
          await respondOpencodeQuestion({
            baseUrl: pending.baseUrl,
            apiKey: pending.apiKey,
            sessionId: pending.sessionId,
            requestId: pending.requestId,
            answers: [[String(msg.response ?? '')]],
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e?.message };
        }
      }
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

// Build an `asr-pending` ctx for a subtitle-less bilibili page when ASR is
// enabled. Reads the fresh audio stream URL via the MAIN-world-exposed
// window.__browsaGetBilibiliStreams (injected by bilibili-content-script.js;
// re-injected on demand if absent — same on-demand injection pattern as
// tryBilibiliActiveFallback), picks the highest-bandwidth audio stream, and
// attaches the config the side panel needs to run the pipeline. Returns null
// when no usable audio stream is available (falls through to the normal
// placeholder store path).

// llms.txt — fetched ONCE at attach time and baked into the stored
// page-context text (see ATTACH_PAGE), keyed to the ATTACHED page's own URL.
// It used to be injected into the per-turn system prompt from whatever tab was
// active at message time, which (a) invalidated the KV/prompt prefix cache on
// every origin change (the "dynamic system prompt" anti-pattern from
// ai-agent-book chapter 2 — same failure as a `Current time: {{now}}` line in
// the system prompt) and (b) could deliver site instructions for a page the
// user never attached. Baked into the attach text instead, it rides through
// history exactly like the page body — auto-summarize, image compaction, and
// session export all treat it as normal content. Returns the (possibly new)
// ctx; a no-op when llms.txt is disabled, the URL is unparseable/non-http(s),
// or the origin doesn't publish an llms.txt.
async function withSiteInstructions(ctx, all) {
  if (all.llmsTxtEnabled === false) return ctx;
  const url = ctx?.meta?.url;
  if (!url || !/^https?:\/\//.test(url)) return ctx;
  const instructions = await fetchLlmsTxt(url);
  if (!instructions) return ctx;
  let site = url;
  try { site = new URL(url).origin; } catch (_) {}
  return Object.assign({}, ctx, {
    text: `[Site instructions from ${site}/llms.txt]\n${instructions}\n\n${ctx.text || ''}`
  });
}

// Video-note formatting instruction — baked into youtube/bilibili page-context
// text at attach time (see ATTACH_PAGE / ATTACH_ASR_CONFIRM). It used to live
// in the per-turn system prompt, present only when a video was attached — a
// conditional dynamic prefix that split the KV/prompt cache key between
// "video session" and "normal session" (same anti-pattern as llms.txt, cf.
// ai-agent-book chapter 2). Rides in the trajectory like the transcript itself.
const VIDEO_NOTE_HINT = 'The attached context includes a video transcript with [mm:ss] timestamps. When summarizing it as notes, organize the content into sections and append each section\'s start time at the end of its heading, formatted as [mm:ss] (use [h:mm:ss] for videos longer than an hour). Keep timestamps in this exact bracket form so they can be linked.';

function withVideoNote(ctx) {
  return Object.assign({}, ctx, {
    text: `${ctx.text || ''}\n\nNote: ${VIDEO_NOTE_HINT}`
  });
}

async function buildAsrPendingCtx(tabId, ctx) {
  try {
    // --- Platform dispatch: Bilibili vs YouTube ---
    // Both paths produce a list of audio stream candidates + the video's true
    // length (sec); the shared stream-selection logic below picks the best one.
    let got = null;
    if (ctx.mode === 'youtube') {
      // YouTube: no passive playurl cache like B站's __playinfo__ — the audio
      // stream must come from a FRESH /youtubei/v1/player response (ANDROID
      // client) so the PO token / signature in the URL is valid at download
      // time. ytInitialPlayerResponse goes stale after SPA navigation and
      // carries no guarantee of freshness, so we always re-fetch here.
      // NOTE: the videoId is parsed INSIDE the injected func from
      // window.location (never captured from the service-worker closure) —
      // chrome.scripting.executeScript serializes func via toString() and
      // re-evaluates it in the page, so closure variables are NOT available
      // (the countImages lesson). A closure-captured videoId is undefined in
      // the page, the fresh fetch returns no streams, and buildAsrPendingCtx
      // silently falls through to the normal store path.
      const videoId = (() => {
        try { return new URLSearchParams(new URL(ctx.meta?.url).search).get('v') || ''; }
        catch (_) { return ''; }
      })();
      if (!videoId) return null;
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['lib/content-scripts/youtube-content-script.js']
      });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async () => {
          const fn = window.__browsaFetchFreshYouTubeStreams;
          if (typeof fn !== 'function') return { streams: [], videoDurationSec: 0, asrExpiredError: '脚本未注入 __browsaFetchFreshYouTubeStreams' };
          // videoId from the live page URL — NOT a closure capture (see note above).
          const vid = (() => {
            try { return new URLSearchParams(window.location.search).get('v') || ''; }
            catch (_) { return ''; }
          })();
          if (!vid) return { streams: [], videoDurationSec: 0, asrExpiredError: '页面 URL 无 videoId' };
          // 1) Prefer the pot-bearing audio streams captured from the page's REAL
          // player response (handlePlayerResponse caches them). These carry a valid
          // PO token — the pot-less ANDROID POST (fetchFreshYouTubeStreams) returns
          // URLs that googlevideo 403s (real test 2026-08-25). Only pot URLs stand a
          // chance of being downloadable outside the player context.
          try {
            const potStreams = (typeof window.__browsaGetPlayerAudioStreams === 'function')
              ? window.__browsaGetPlayerAudioStreams(vid)
              : [];
            if (Array.isArray(potStreams) && potStreams.length > 0) {
              const usable = potStreams.filter((s) => s.url && s.hasPot);
              if (usable.length > 0) {
                console.log(`browsa: ASR using ${usable.length} captured pot audio streams`);
                return { streams: usable, videoDurationSec: 0 };
              }
            }
          } catch (_) {}
          // 2) Fall back to the fresh ANDROID /player POST (pot-less — likely 403,
          // but kept for the case where no pot capture exists yet).
          try {
            const r = await fn(vid);
            if (Array.isArray(r.streams) && r.streams.length > 0) return r;
            return { streams: [], videoDurationSec: r.videoDurationSec || 0, asrExpiredError: 'player 返回空音频流列表' };
          } catch (e) {
            return { streams: [], videoDurationSec: 0, asrExpiredError: 'player 自动刷新失败：' + String((e && e.message) || e) };
          }
        }
      });
      got = (res?.result && Array.isArray(res.result.streams)) ? res.result : null;
      if (!got) return null;
    } else {
      // Bilibili: existing behavior — prefer cached __playinfo__ URLs, fall
      // back to fresh playurl API on expiry. (Unchanged from before the
      // youtube branch; kept in its own else for clarity.)
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['lib/content-scripts/bilibili-content-script.js']
      });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        // Prefer __playinfo__ cached URLs (SSR-picked CDN nodes, fastest) — only
        // fall back to the fresh playurl API when the cached URL is expired
        // (deadline signature → 403). For ASR we only need the audio stream, and
        // we want the LOWEST bitrate one (smallest/fastest download — quality is
        // irrelevant, it gets transcoded to 16kHz mono WAV for Ark anyway). BUT a
        // truncated/short stream (a real user bug: 100+ min video → only ~20 min
        // of subtitles) must be rejected — each stream carries a `duration` (sec)
        // that we compare against the video's true length.
        func: async () => {
          try {
            const cached = (typeof window.__browsaGetBilibiliStreams === 'function')
              ? window.__browsaGetBilibiliStreams()
              : [];
            // Expiry is detected by parsing the `deadline` query param from the
            // signed URL itself (a network probe is unreliable — B站 CDN may
            // answer 200 to a plain GET for an already-expired URL, only the
            // actual media download 403s). No deadline param → assume valid.
            const isLive = (u) => {
              try {
                const m = /[?&]deadline=(\d+)/.exec(u);
                return !m || (parseInt(m[1], 10) * 1000) > Date.now() + 5 * 60_000;
              } catch (_) { return true; }
            };
            // Video true length (sec) from __playinfo__ SSR data — the reference
            // for detecting truncated audio streams.
            const pi = window.__playinfo__?.data || window.__playinfo__;
            const videoDurationSec = (pi?.duration || 0) > 0 ? pi.duration : 0;
            const cachedAudio = cached
              .filter(s => s.type === 'audio' && s.url && isLive(s.url))
              .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
            if (cachedAudio) return { streams: cached, videoDurationSec };
            // Cached audio empty or expired — fall back to fresh playurl API
            // (re-signs a brand-new URL with a fresh deadline, no page refresh).
            // bvid 绝不能从 __playinfo__ 读：B站 playurl 响应里没有 bvid 字段，
            // pi?.bvid 恒为空串 → 自愈刷新永远被 !bvid 拦死（真实故障 2026-08-29：
            // 页面开久了缓存流过期后必报「脚本未注入或缺 bvid/cid」让用户白刷新）。
            // 与字幕提取的主动拉取同策略：URL path 优先，__INITIAL_STATE__ 兜底；
            // cid 用 playinfo（有此字段）+ INITIAL_STATE 兜底。
            //（注意：函数体内不要出现 activeFetch / contentType 等 mock 匹配标记词，
            // attach-asr.test.mjs 按 func.toString() 字符串路由 canned 结果。）
            const pathBvid = (window.location?.pathname || '').match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1] || '';
            const vd = window.__INITIAL_STATE__?.videoData;
            const bvid = pathBvid || pi?.bvid || vd?.bvid || '';
            const cid = pi?.cid || vd?.cid || 0;
            const freshFn = window.__browsaFetchFreshBilibiliStreams;
            if (typeof freshFn === 'function' && bvid && cid) {
              try {
                const fresh = await freshFn(bvid, cid);
                if (Array.isArray(fresh) && fresh.length > 0) {
                  return { streams: fresh, videoDurationSec };
                }
                // 刷新返回空流：把原因留给调用方（缓存已过期，不能再静默回退死 URL）。
                return { streams: cached, videoDurationSec, asrExpiredError: 'fresh playurl 返回空流列表' };
              } catch (e) {
                // fresh playurl 失败（WBI 签名/网络/风控）时缓存已过期——不能静默
                // 回退到死 URL 让用户白等 403 重试；原因必须传到 UI（toast + 日志）。
                return { streams: cached, videoDurationSec, asrExpiredError: 'playurl 自动刷新失败：' + String((e && e.message) || e) };
              }
            }
            return { streams: cached, videoDurationSec, asrExpiredError: '缓存流全部过期且无自动刷新可用（脚本未注入或缺 bvid/cid）' };
          } catch (_) { return { streams: [], videoDurationSec: 0 }; }
        }
      });
      got = (res?.result && Array.isArray(res.result.streams)) ? res.result : null;
      if (!got) return null;
    }
    const streams = got.streams || [];
    // SSR duration 缺失时用 DASH 流自带 duration（秒）兜底（resolveVideoDurationSec）。
    const videoDurationSec = resolveVideoDurationSec(got.videoDurationSec, streams);
    const audioCandidates = streams
      .filter((s) => s.type === 'audio' && s.url)
      .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    // ASR only needs the audio track — prefer the LOWEST bitrate (smallest /
    // fastest download; quality is irrelevant, it gets transcoded to 16kHz
    // mono WAV for Ark anyway). BUT reject streams whose duration is clearly
    // shorter than the video (truncated/partial stream → 20 min of a 100+ min
    // video, a real user bug), AND prefer decodable codecs: the lowest-bitrate
    // stream is often HE-AAC (mp4a.40.5), which decodeAudioData may reject
    // (real bug: transcode "Unable to decode audio data"), while AAC-LC
    // (mp4a.40.2) decodes reliably. Only fall back to lowest-bitrate-everything
    // when duration metadata is missing/unusable.
    const fullLen = (s) => {
      if (!videoDurationSec || !s.duration) return null; // 无法判定 → 不拦截
      // 允许 -10% 容差（不同容器时长略有出入）；明显短则视为截断流。
      return s.duration >= videoDurationSec * 0.9 ? true : false;
    };
    // codecPrio: AAC-LC 最稳（decodeAudioData 可靠）；未知居中；HE-AAC 等靠后。
    const codecPrio = (s) => {
      const c = s.codecs || '';
      if (c === 'mp4a.40.2') return 0;
      if (!c) return 1;
      return 2; // 含 mp4a.40.5 (HE-AAC) 等
    };
    const sortBest = (list) => list.slice()
      .sort((a, b) => (codecPrio(a) - codecPrio(b)) || ((a.bandwidth || 0) - (b.bandwidth || 0)));
    const fullStreams = sortBest(audioCandidates.filter((s) => fullLen(s) === true));
    const unknownStreams = sortBest(audioCandidates.filter((s) => fullLen(s) === null));
    const anyStreams = sortBest(audioCandidates);
    // 完整长度的流优先；无法判定时长（元数据缺失）次之；都没有才退回全部。
    const ordered = fullStreams.length ? fullStreams : (unknownStreams.length ? unknownStreams : anyStreams);
    const audio = ordered[0];
    // 即便被选中的流元数据看似完整，若真实解码时长远小于视频总长（服务端 body
    // 截断、元数据谎报），或转码失败（编码不支持），也交由 sidepanel 在转码后
    // 校验并换下一候选重试——这里把完整候选列表（按优先级排序）+ 视频时长传给
    // sidepanel。
    const candidateAudios = ordered.map((s) => ({
      url: s.url, label: s.label || '', bandwidth: s.bandwidth || 0,
      duration: s.duration || 0, size: s.size || 0, codecs: s.codecs || '', id: s.id || 0,
    }));
    if (!audio) return null;
    // 视频解析（v1，当前暂时只支持 B 站）：透传 video-only 流候选（按码率降序）+ durl 合一流。
    // YouTube 的流捕获是 audio-only（pot 视频 URL 未验证），天然没有 video 条目 →
    // sidepanel 不出模式选择卡，维持纯音频行为。选流/512MB 预算判定在 sidepanel
    // 的 pickVideoStream 里做（卡片上要展示预估体积，选流必须发生在 UI 层）。
    const videoCandidates = streams
      .filter((s) => s.type === 'video' && s.url)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
      .map((s) => ({
        url: s.url, label: s.label || '', bandwidth: s.bandwidth || 0,
        duration: s.duration || 0, size: s.size || 0,
        width: s.width || 0, height: s.height || 0, id: s.id || 0,
      }));
    const muxedRaw = streams.find((s) => s.type === 'muxed' && s.url);
    const muxedStream = muxedRaw ? {
      url: muxedRaw.url, label: muxedRaw.label || 'mp4', bandwidth: muxedRaw.bandwidth || 0,
      duration: muxedRaw.duration || 0, size: muxedRaw.size || 0,
    } : null;
    // 读完整平台 cookie（含 HttpOnly 的 SESSDATA / SID），传给 sidepanel 在下载前经
    // DNR 注入 Cookie 头——对齐 cat-catch 的下载逻辑：cat-catch 用 chrome.webRequest
    // onSendHeaders 捕获页面播放器真实请求的完整 cookie（含 HttpOnly），而
    // document.cookie 读不到 HttpOnly。登录态/大会员 m4s 流缺 SESSDATA 会 403，
    // YouTube 的 googlevideo 下载也带 cookie（SID/SSID/VISITOR_INFO1_LIVE 等）。
    // chrome.cookies 权限 + <all_urls> host_permissions 才能读 HttpOnly cookie。
    // 早期假设 YouTube 靠 URL 里的 PO token（pot）免 cookie —— 实机测试（2026-08-25）
    // 证明不行：扩展上下文直接 fetch googlevideo 一律 403（chrome-extension origin
    // 被拒），必须像 B 站一样 DNR 注入 Referer+Origin+Cookie。
    let platformCookie = '';
    const cookieUrl = ctx.mode === 'bilibili' ? 'https://www.bilibili.com' : 'https://www.youtube.com';
    try {
      const cookies = await chrome.cookies.getAll({ url: cookieUrl });
      platformCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      console.warn('browsa: chrome.cookies.getAll failed', e?.message);
    }
    const all = await storage.getAll();
    const asr = { ...ASR_DEFAULTS, ...(all.asr || {}) };
    // 缓存播放地址过期且自动刷新失败（真实复现：页面开太久，playurl 签名 URL 的
    // deadline 已过期 → CDN 一律 403）。原因传入 ctx：sidepanel 会在下载前直接
    // 明示给用户（不再无意义地重试死 URL），请其刷新视频页后重新 attach。
    if (got.asrExpiredError) {
      console.warn('browsa: ASR cached playurl expired, auto-refresh failed:', got.asrExpiredError);
    }
    return Object.assign({}, ctx, {
      mode: 'asr-pending',
      // 保留原始平台（bilibili / youtube），sidepanel 据此决定 DNR 规则、下载头、
      // 平台文案和自愈路径。
      asrPlatform: ctx.mode,
      audioUrl: audio.url,
      audioLabel: audio.label || '',
      audioCodec: audio.codecs || '', audioId: audio.id || 0,
      // 完整候选音频流列表 + 视频总时长（秒）：sidepanel 转码后若发现实际解码
      // 时长远小于视频总长（服务端 body 截断 / 元数据谎报），可换下一候选流重试。
      audioCandidates: candidateAudios,
      // 视频解析候选（B站才有内容）：video-only 流（码率降序）+ durl 合一流（可空）。
      videoCandidates,
      muxedStream,
      videoDurationSec: videoDurationSec || 0,
      // 传給 sidepanel，供下载前 DNR 注入 Cookie 头（对齐 cat-catch 的下载逻辑）。
      biliCookie: platformCookie,
      // 播放地址过期/刷新失败原因（无则空串）。
      asrExpiredError: got.asrExpiredError || '',
      asr: {
        provider: asr.provider || 'ark',
        apiKey: asr.apiKey,
        baseUrl: asr.baseUrl,
        model: asr.model,
        videoModel: asr.videoModel || '',
        language: asr.language,
        format: asr.format,
        timeoutMs: asr.timeoutMs,
        subtitleSource: asr.subtitleSource || ASR_SUBTITLE_SOURCE.ORIGINAL,
      },
    });
  } catch (e) {
    console.warn('browsa: buildAsrPendingCtx failed', e?.message);
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
export { handle, withSiteInstructions, withVideoNote };
