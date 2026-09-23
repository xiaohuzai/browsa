// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG: read storage (SET_CONFIG does not exist)
//   - CLEAR_HISTORY: clear per-tab history

import { stopHermesRun } from './lib/handlers/agent-stream-session.js';
import * as storage from './lib/storage.js';
import { ProviderConfigError } from './lib/llm-client.js';
import { PAGE_CONTEXT_PREFIX, VIDEO_NOTE_HINT } from './lib/constants.js';
import {
  streamPorts, streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  subChatControllers, subChatPorts,
  initStreamState, appendToStreamState, clearStreamState,
  STREAM_KEEPALIVE_ALARM, GC_ALARM_NAME, syncGcAlarm
} from './lib/state.js';
import { handleChat, fetchLlmsTxt } from './lib/handlers/chat-handler.js';
import { handleSubchat, handleSubchatAbort, handleSubchatApprovalRespond, handleSubchatClarifyRespond } from './lib/handlers/subchat-handler.js';
import { handleSession } from './lib/handlers/session-handler.js';
import { checkAndRecordAttachChange } from './lib/handlers/attach-change-tracker.js';
import { boundUnseenImageBytes } from './lib/handlers/history-compactor.js';
import { repairMermaid } from './lib/handlers/mermaid-repair.js';
import { handleExplainPort } from './lib/handlers/selection-explain.js';
import { resolveChatModel } from './lib/handlers/provider-resolver.js';
import { ASR_SUBTITLE_SOURCE } from './lib/handlers/attach-asr.js';
import { buildAsrPendingCtx } from './lib/handlers/attach-asr-pending.js';
import { handleAttachConfirm, ATTACH_CONFIRM_TYPES } from './lib/handlers/attach-confirm-handler.js';
import { storeAttachment } from './lib/handlers/attach-store.js';
import { relayApproval, relayClarify } from './lib/handlers/approval-relay.js';
import { modeCaps, DEFERRED_HANDOFFS } from './lib/attach-modes.js';
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
import { interleaveImageParts } from './lib/message-builder.js';
import { ensureReadabilityInjected } from './lib/readability-injector.js';

// Capability hints: browsa rendering rules injected automatically so users
// never need to configure them manually. Shared by both CHAT (full turn,
// with page context/domain rules/history) and SUBCHAT (scoped detail-thread
// side-conversation, see openDetailThread in sidepanel.js) — both render
// through the same markdown/Mermaid/ECharts/Markmap/KaTeX pipeline.
// Editing rules: this array rides EVERY turn as a byte-stable prefix (KV
// prompt-cache friendly — never make it dynamic per-turn, see the llms.txt
// lesson in chat-handler.js). It was compressed 2026-09-15 (6669→4873 chars,
// -27%) by tightening wording only, and sits at ~4.9K chars since; every
// constraint that remains is load-bearing (each paid for with a real rendering
// bug) — when adding a hint, keep it terse and never drop an existing
// constraint to save space. The fence list in the second entry is mirrored by
// lib/agent-turn.js's AGENT_RENDER_HINT (agent providers never see this array)
// — add a new renderer to both, and to the assertion in
// test/lib-agent-turn.test.mjs that guards the pair.
// 系统提示常量与组装已收拢到 lib/prompt-assembly.js（C5：/prompt 检视器此前
// 显示 ≠ 发送）。CHAT 用两块、SUBCHAT 只用 capabilityHints——原样传参，通道差异不变。
import { CAPABILITY_HINTS, CHOICE_REQUEST_HINT } from './lib/prompt-assembly.js';


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
    // One-shot self-heal: history blobs bloated by parked images from
    // attach-without-ask sessions (pre-fix) get bounded on first load.
    boundUnseenImageBytes().catch(() => {});

    // Best-effort: re-inject the selection toolbar into already-open tabs.
    // Removes the old host element first so old detached handlers are harmless.
    (async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id || !tab.url?.startsWith('https://')) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              document.getElementById('browsa-sel-host')?.remove();
              delete window.__browsaSelectionToolbarInstalled;
            }
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['lib/content-scripts/selection-toolbar.js']
          });
        } catch (_) {} // tab navigating/closed — best-effort re-injection
      }
    })();

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
  await relaySelectionAction(tab.id, action, text);
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
// 划词动作中继（右键菜单与浮动工具条两个入口此前逐字两份）：优先走既有
// navPort 直推；没有（SW 刚醒、navPorts 是空 Map）则落 chrome.storage.session
// 兜底并拉起面板——setTimeout 重试不可行，handler 一返回 SW 就睡回去。
async function relaySelectionAction(tabId, action, text) {
  const set = navPorts.get(tabId);
  let relayed = false;
  if (set && set.size > 0) {
    for (const p of set) {
      try { p.postMessage({ type: 'SELECTION_ACTION', action, text }); relayed = true; } catch (_) {}
    }
  }
  if (!relayed) {
    chrome.storage.session.set({ pendingSelectionAction: { tabId, action, text } }).catch(() => {});
    try { await chrome.sidePanel.open({ tabId }); } catch (_) {}
  }
}

// 视频 tab 注入的统一门（SEEK_VIDEO / GET_VIDEO_TIME 此前各带一份装配）：
// videoSrc.tabId 随存档跨浏览器重启、id 会被回收——盲注入会操作无关 tab 的
// 视频，先复验 URL 再注入。注入函数内部的 <video> selector 两份是平台约束
//（MAIN-world 只序列化单个函数），保留双份。
async function runInVideoTab(tabId, url, func, args) {
  if (tabId == null) return { ok: false, error: 'no tabId' };
  if (!(await tabMatchesVideo(tabId, url))) return { ok: false, error: 'tab no longer shows the source video' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return res?.result || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// 抽取参数里的站点缓存二件套（ATTACH_PAGE 与 GET_PAGE_CONTEXT 各写一份）。
async function siteCacheCtx(t) {
  await siteCacheReady; // ensure session-storage restore finished
  if (typeof t !== 'number') return { xhsXhrNote: null, siteCache: null };
  return { xhsXhrNote: xhsXhrCache.get(t) || null, siteCache: getSiteCache(t) };
}

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
        syncNavListeners();
        console.log('browsa[bg]: nav port registered for tab', claimedTabId);
        try { port.postMessage({ type: 'NAV_HELLO_ACK' }); } catch (_) {}
      } else if (msg && msg.type === 'NAV_GOODBYE' && claimedTabId != null) {
        const set = navPorts.get(claimedTabId);
        if (set) {
          set.delete(port);
          if (set.size === 0) navPorts.delete(claimedTabId);
        }
        syncNavListeners();
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
        syncNavListeners();
      }
    });
    port.onDisconnect.addListener(() => {
      if (claimedTabId != null) {
        const set = navPorts.get(claimedTabId);
        if (set) {
          set.delete(port);
          if (set.size === 0) navPorts.delete(claimedTabId);
        }
        syncNavListeners();
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

function gcStreamState() {
  const now = Date.now();
  for (const [tabId, st] of streamState.entries()) {
    if (now - st.startedAt > STREAM_STATE_TTL_MS) {
      streamState.delete(tabId);
      console.log('browsa[bg]: GC stale streamState for tab', tabId);
    }
  }
  // The alarm's lifecycle is owned by lib/state.js's syncGcAlarm: created on
  // first streamState entry, cleared here once the sweep empties the map —
  // a permanently-registered alarm cold-started the worker every 5 minutes
  // to sweep a Map that is empty except after an interrupted stream.
  syncGcAlarm();
}

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
  // Attach-confirm family (screenshot/pdf/office/asr storage + ASR URL refresh):
  // one grouped handler, same pattern as handleSession. (lib/handlers/attach-confirm-handler.js)
  if (ATTACH_CONFIRM_TYPES.has(msg.type)) return handleAttachConfirm(msg);
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
      await relaySelectionAction(tabId, action, text);
      return { ok: true };
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
      recordSiteMessage(msg, sender?.tab?.id);
      return { ok: true };
    }

    case 'SEEK_VIDEO': {
      // In-place seek a video tab's <video> to a timestamp. Fired by
      // clickable [mm:ss] markers in video-note replies. The side panel
      // falls back to opening the source URL with ?t= when this returns
      // ok:false (tab closed, navigated away, or no <video> on the page).
      // 复验 + 注入走 runInVideoTab（C7）。MAIN world so YouTube's
      // #movie_player.seekTo (a method the page attaches to the element) is
      // reachable - page-set custom props aren't visible from the ISOLATED
      // world's DOM wrappers. 失败时侧栏回落 ?t= URL 打开。
      return runInVideoTab(msg.tabId, msg.url, (seconds) => {
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
        [Number(msg.seconds) || 0]);
    }

    case 'GET_VIDEO_TIME': {
      // Read the video tab's current playback position (for the transcript
      // drawer's playback-follow highlight). Mirrors SEEK_VIDEO's element
      // lookup so both agree on which <video> is the target.
      // 同 SEEK_VIDEO 的门与注入装配（C7）——selector 双份是 MAIN-world 约束。
      return runInVideoTab(msg.tabId, msg.url, () => {
        const v = document.querySelector('#movie_player video, #bilibili-player video, video');
        if (!v) return { ok: false };
        return { ok: true, time: v.currentTime || 0, paused: !!v.paused };
      });
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
        const source = await repairMermaid({ provider, all: cfg, model, source: String(msg.source || ''), errorText: String(msg.error || '') });
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
      // Fresh server-side agent sessions for the next conversation (new
      // X-Hermes-Session-Id / opencode ses_ / bridge thread id) — the
      // provider-kind ladder lives in storage.clearAllAgentSessions.
      const allCfg = await storage.getAll();
      await storage.clearAllAgentSessions(allCfg.providers);
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
          ctx = await extractActiveTab({
            mode,
            tabId,
            maxTextChars: all.maxTextChars,
            ...(await siteCacheCtx(tabId)),
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
          if (modeCaps(ctx.mode).deepExtract && all.deepExtractEnabled !== false) {
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
        // Deferred-storage handoffs (screenshot crop / pdf.js text / docling
        // office conversion): history storage is deferred until the sidepanel
        // confirms via the matching ATTACH_*_CONFIRM message. One table
        // (lib/attach-modes.js) drives both this check and the sidepanel's
        // dispatch, so a new deferred mode is one row, not two if-chains.
        // Screenshot keys off the REQUEST mode (the mocked/extraction ctx may not
        // carry mode); pdf/office pendings key off ctx.mode — the request mode is
        // never 'pdf-pending'/'office-pending', so the OR is exact, not loose.
        const handoff = DEFERRED_HANDOFFS.find((h) => (ctx.mode === h.mode || mode === h.mode) && ctx[h.field]);
        if (handoff) {
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
        if (ctx.meta?.url && !modeCaps(ctx.mode).skipChangeTracking && (ctx.text || '').length > 50) {
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
        if (modeCaps(ctx.mode).siteInstructions) {
          ctx = await withSiteInstructions(ctx, all);
        }
        // Video page-contexts (youtube/bilibili): append the video-note
        // formatting instruction to the stored text (same KV-cache rationale
        // as llms.txt — dynamic formatting hints ride in the trajectory, not
        // the static system prompt).
        if (modeCaps(ctx.mode).video) {
          ctx = withVideoNote(ctx);
        }

        // 页面配图（reader/auto/jina）：正文 Markdown 里的 ![alt](url) 原位转成
        // [图N] 锚点行，图片在 SW 下载压缩成 JPEG dataURL 随条目交错入库——与视频
        // 截图 / PDF figure 同一套 [图N] 引用协议（回答引用 [图N]，渲染端还原缩略图）。
        // 全程 fail-open：无图/下载失败/无解码环境保持原文，绝不阻塞附加。
        // dom/full 是树状文本（无 Markdown 图片语法）、selected 是局部摘录，不参与。
        if (modeCaps(ctx.mode).inlineImages && ctx.text) {
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

        // All other modes: save to global history immediately, via the single
        // owner of the storage recipe (attachId = the panel 撤销 undo identity,
        // stamped on every entry; summarize kick; image-byte bounding).
        // lib/handlers/attach-store.js — candidate #2 of the architecture review.
        const pageFigures = Array.isArray(ctx.pageFigures) ? ctx.pageFigures : [];
        // Very long attachments (e.g. a 4-5 hour video's transcript) get
        // resent in FULL on every subsequent turn — the one-time chunk/
        // summarize/merge pass here is cheaper than paying that cost on every
        // message. maybeSummarizeAttachment runs fire-and-forget AFTER the
        // response is prepared; the raw text is never rendered in the chat
        // bubble, so there's no UI to block on.
        const { attachId: pageAttachId } = await storeAttachment({
          pageContext: ctx,
          contentFrom: (contextText) => pageFigures.length
            // 有配图时存成按 [图N] 锚点真交错的多模态 content（与 ATTACH_ASR_CONFIRM 的
            // 视频截图同构）；无配图保持纯字符串 content 形状不变。
            ? interleaveImageParts(contextText, pageFigures)
            : null,
          // Stamp the video source on video page-contexts (youtube/bilibili)
          // so video-note replies can turn their [mm:ss] markers into clickable
          // seek links. Other pages have no seekable <video> target.
          videoSrc: modeCaps(ctx.mode).video
            ? { platform: ctx.mode, url: ctx.meta?.url || '', tabId }
            : null,
          log: (contextText) => `page attached — ${contextText.length} chars, mode=${mode}${pageFigures.length ? `, ${pageFigures.length} page images` : ''}`,
        });
        return { ok: true, ctx, attachId: pageAttachId };
      } catch (e) {
        console.warn('browsa: ATTACH_PAGE failed', e);
        // `code` (when present) lets the side panel say the failure in the
        // user's own language instead of echoing a raw browser string; the
        // message stays English for logs and any other consumer.
        return { ok: false, error: e?.message || String(e), code: e?.code };
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
        lastDeltaAt: st.lastDeltaAt,
        providerLabel: st.providerLabel,
        providerKey: st.providerKey
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
        // /stop 的 fetch 唯一实现在 agent-stream-session.js（C4：此前手写三份）。
        stopHermesRun(runInfo);
        activeRunIds.delete(t);
      }
      clearStreamState(t);
      return { aborted: !!controller };
    }

    case 'SUBCHAT_APPROVAL_RESPOND':   // subchat-keyed approval relay (detail thread card)
      return handleSubchatApprovalRespond(msg);
    case 'SUBCHAT_CLARIFY_RESPOND':    // subchat-keyed clarification relay (detail thread card)
      return handleSubchatClarifyRespond(msg);

    case 'APPROVAL_RESPOND': {      // User clicked Allow/Deny on an approval card. Relay the choice to
      // the agent so it can resume. opencode pending entries carry the
      // server session + request id and reply via the opencode endpoint;
      // card choices (once/always/deny) map onto opencode's reply enum
      // (deny → reject) — see showApprovalCard's btnLabels.
      const pending = pendingApprovals.get(msg.tabId);
      if (!pending) return { ok: false, error: 'no pending approval' };
      try {
        return await relayApproval(pending, msg.choice);
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
      try {
        return await relayClarify(pending, msg.response);
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    }

    case 'SUBCHAT':
      return handleSubchat(msg, CAPABILITY_HINTS);

    case 'SUBCHAT_ABORT':
      return handleSubchatAbort(msg);

    case 'GET_PAGE_CONTEXT': {
      const all = await storage.getAll();
      const mode = msg.mode || all.contextMode || 'auto';
      if (mode === 'reader' || mode === 'auto') {
        await ensureReadabilityInjected(tabIdOf(msg, sender)).catch(() => {});
      }
      const t = tabIdOf(msg, sender);
      const ctx = await extractActiveTab({
        mode,
        tabId: typeof t === 'number' ? t : null,
        maxTextChars: all.maxTextChars,
        ...(await siteCacheCtx(t)),
      });
      return ctx;
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

function withVideoNote(ctx) {
  return Object.assign({}, ctx, {
    text: `${ctx.text || ''}\n\nNote: ${VIDEO_NOTE_HINT}`
  });
}

// buildAsrPendingCtx moved to lib/handlers/attach-asr-pending.js (imported below).


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

// The three webNavigation listeners exist ONLY to feed broadcastNav, whose
// only audience is a connected side panel (navPorts). With <all_urls> host
// permissions, registering them unconditionally made every top-frame
// navigation and every SPA pushState in every tab cold-start the service
// worker (644KB of module parse) just to no-op on an empty navPorts. They
// are now registered only while at least one nav port is connected and
// removed when the last one goes away; NAVIGATED delivery is unchanged for
// any panel that is actually open.
function onNavHistoryStateUpdated(details) {
  if (details.frameId !== 0) return; // only top frame
  broadcastNav(details.tabId, details.url);
}

function onNavCommitted(details) {
  if (details.frameId !== 0) return;
  // Only fires for non-history-API commits. onHistoryStateUpdated handles
  // the SPA case. This is a safety net for any other navigation path.
  broadcastNav(details.tabId, details.url);
}

function onNavBeforeNavigate(details) {
  if (details.frameId !== 0) return;
  // Reset the dedup so a same-URL back/forward (which history treats as
  // a new navigation) still fires. We can't know the new URL yet, so we
  // just clear.
  lastNavBroadcast.delete(details.tabId);
}

let navListenersActive = false;
function syncNavListeners() {
  // Count actual ports, not keys: NAV_FOLLOW can leave an empty Set behind
  // under the tab a panel moved away from.
  let want = false;
  for (const set of navPorts.values()) { if (set.size > 0) { want = true; break; } }
  if (want === navListenersActive) return;
  navListenersActive = want;
  const method = want ? 'addListener' : 'removeListener';
  chrome.webNavigation.onHistoryStateUpdated[method](onNavHistoryStateUpdated);
  chrome.webNavigation.onCommitted[method](onNavCommitted);
  chrome.webNavigation.onBeforeNavigate[method](onNavBeforeNavigate);
}

// Per-site XHR intercept caches.
//
// Each content script intercepts the SPA's own API calls and forwards
// structured article data here. We cache by tabId (most-recent wins),
// so when the user asks browsa to read the page, we have the full content
// from the browser's own authenticated request — no signing, no re-auth.
// Pending selection actions are delivered to the side panel via the nav port
// relay, or persisted to chrome.storage.session when no panel is connected yet
// (the panel reads that key directly and removes it itself — sidepanel.js's
// navPort onDisconnect). No in-memory map is needed here.

// (pageContextUrls removed — history is now global, not per-tab)

const selectionCache = new Map(); // tabId -> last selected text (from selectionchange)
const xhsXhrCache    = new Map(); // tabId -> XHS note summary (has special push logic, kept separate)

// Site-specific XHR intercept caches, keyed by tabId. Each entry is a Map.
// Adding a new site requires only adding an entry here — restore, getSiteCache,
// and onRemoved all iterate this registry automatically.
// 站点缓存 registry 外迁 lib/handlers/site-cache-store.js（C7）——handle() 的
// 站点 case 从此只剩路由。
import { recordSiteMessage, getSiteCache, purgeTab, restoreSiteCachesFromSession } from './lib/handlers/site-cache-store.js';


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
  xhsXhrCache.delete(tabId);
  purgeTab(tabId);
  const set = navPorts.get(tabId);
  if (set) {
    for (const p of set) {
      try { p.postMessage({ type: 'NAVIGATED', tabId, url: '', title: '', closed: true }); } catch (_) {}
    }
    navPorts.delete(tabId);
  }
  // Re-sync even when no set existed for THIS tab: if this was the last open
  // panel's tab and its port already disconnected, the map can be empty here
  // without syncNavListeners having run — leaving the webNavigation listeners
  // registered to no-op on every navigation (the exact cost they gate).
  syncNavListeners();
});

// Exported for testing. handle() is the switch-based message dispatcher.
export { handle, withSiteInstructions, withVideoNote };
