// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG: read storage (SET_CONFIG does not exist)
//   - CLEAR_HISTORY: clear per-tab history

import { stopHermesRun } from './lib/handlers/agent-stream-session.js';
import * as storage from './lib/storage.js';
import { initI18n, t } from './lib/i18n.js';
import { ProviderConfigError } from './lib/llm-client.js';
import { VIDEO_NOTE_HINT } from './lib/constants.js';
import {
  streamPorts, streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  subChatControllers, subChatPorts,
  initStreamState, appendToStreamState, clearStreamState,
  recordTerminalTombstone, takeTerminalTombstone, peekTerminalTombstone, clearTerminalTombstone,
  STREAM_KEEPALIVE_ALARM, GC_ALARM_NAME, syncGcAlarm
} from './lib/state.js';
import { handleChat, fetchLlmsTxt, ensureDurableSalvage } from './lib/handlers/chat-handler.js';
import { handleSubchat, handleSubchatAbort, handleSubchatApprovalRespond, handleSubchatClarifyRespond } from './lib/handlers/subchat-handler.js';
import { handleSession } from './lib/handlers/session-handler.js';
import { checkAndRecordAttachChange } from './lib/handlers/attach-change-tracker.js';
import { handleAttachPage } from './lib/handlers/attach-page.js';
import { selectionCache } from './lib/handlers/selection-cache.js';
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
  initStreamState, appendToStreamState, clearStreamState,
  recordTerminalTombstone, takeTerminalTombstone, clearTerminalTombstone
};
import { extractActiveTab, tryXActiveFallback, autoJinaFallbackWarranted, fetchHighwireTablesInPageWorld } from './lib/page-extractor.js';
import { maybeDeepExtract } from './lib/agentic-extract.js';
import { inlinePageImages, collectMarkdownImages, refererGateForImageUrls } from './lib/page-images.js';
import { registerPageImageReferer, removePageImageReferer, sweepOrphanedMediaRules } from './lib/sidepanel/media-headers.js';
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
// 显示 ≠ 发送）。worker 传全量渲染契约；2026-10-20 的按家族门控已回滚
// （普通问答丢掉画图指路后模型明显变懒）。
import { CAPABILITY_HINTS, CHOICE_REQUEST_HINT } from './lib/prompt-assembly.js';


// Allow side panel to open on action click (Chrome MV3)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('browsa: setPanelBehavior failed', e));

// Menu titles follow the same saved UI language as the panel and toolbar.
// Serialize initialization/update so a slow dictionary cannot overwrite a
// newer settings change; read the latest preference when each job begins.
const SELECTION_MENUS = [
  ['browsa-ask', 'toolbarAsk', 'Ask'],
  ['browsa-explain', 'toolbarExplain', 'Explain'],
  ['browsa-translate', 'toolbarTranslate', 'Translate'],
  ['browsa-summarize', 'toolbarSummarize', 'Summarize'],
];
// contextMenus Promise overloads arrived after our Chrome 116 minimum.
// Use callbacks to preserve ordering on 116–122.
function contextMenuOperation(method, ...args) {
  return new Promise(resolve => {
    try {
      const result = chrome.contextMenus[method](...args, () => { void chrome.runtime.lastError; resolve(); });
      if (result?.then) result.then(resolve, resolve);
    } catch (_) { resolve(); }
  });
}
let menuRefreshChain = Promise.resolve();
function refreshSelectionMenus(create = false) {
  menuRefreshChain = menuRefreshChain.catch(() => {}).then(async () => {
    await initI18n();
    if (create) {
      if (chrome.contextMenus.removeAll) await contextMenuOperation('removeAll');
      chrome.contextMenus.create({ id: 'browsa', title: 'browsa', contexts: ['selection'] });
    }
    for (const [id, key, fallback] of SELECTION_MENUS) {
      if (create) chrome.contextMenus.create({ id, title: t(key, fallback), parentId: 'browsa', contexts: ['selection'] });
      else if (chrome.contextMenus.update) await contextMenuOperation('update', id, { title: t(key, fallback) });
    }
  });
  return menuRefreshChain;
}
// Toolbar/locale settings ride a push, not storage.onChanged in the page:
// storage.local is TRUSTED_CONTEXTS-only (a content script must not be able to
// read provider API keys), so the worker forwards changes to every tab itself.
// Changes only happen from the options page, which has just talked to this
// worker, so it is awake; a missed push self-heals on the next page load via
// CONTENT_SETTINGS_GET.
async function broadcastContentSettings() {
  const [settings, tabs] = await Promise.all([
    storage.get(['showSelectionToolbar', 'uiLang']),
    chrome.tabs.query({}).catch(() => []),
  ]);
  const payload = {
    type: 'CONTENT_SETTINGS',
    showSelectionToolbar: settings.showSelectionToolbar !== false,
    uiLang: settings.uiLang || null,
  };
  for (const tab of tabs) {
    if (!tab?.id) continue;
    // Per-tab isolation: one dead receiver must not skip the remaining tabs.
    try { chrome.tabs.sendMessage?.(tab.id, payload)?.catch?.(() => {}); } catch (_) {}
  }
}
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.uiLang) refreshSelectionMenus().catch(() => {});
  if (area === 'local' && (changes.uiLang || changes.showSelectionToolbar)) broadcastContentSettings().catch(() => {});
});
// Content scripts can read storage.local by default; nothing in a content
// script needs it anymore (selection-toolbar fetches its two settings via
// CONTENT_SETTINGS_GET), so lock the area down — provider API keys and history
// become readable only from extension pages. Optional call: Firefox and older
// Chromium without the API just keep the default (looser) access level.
try {
  chrome.storage.local?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.(() => {});
} catch (_) { /* same defense-in-depth posture where unsupported */ }
// Menus survive worker sleep; a fresh worker refreshes existing titles too.
if (chrome.contextMenus.update) refreshSelectionMenus().catch(() => {});
chrome.runtime.onInstalled.addListener((details) => {
  refreshSelectionMenus(true).catch(() => {});
  // Panel documents are torn down by an install/update; any session DNR rule
  // they left behind is orphaned and safe to remove here.
  sweepOrphanedMediaRules().catch(() => {});

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
      // Fire-and-forget, but caught: some Chrome builds reject local writes
      // while the storage backend is still settling right after an update,
      // and an unhandled rejection here surfaces as a SW console error.
      chrome.storage.local.set({ pendingUpdateNotice: version })
        .catch((e) => console.warn('[browsa] update notice write failed:', e?.message || e));
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
  const cached = selectionCache.get(tab.id);
  const text = ((typeof cached === 'string' ? cached : cached?.text) || info.selectionText || '').trim();
  if (!text) return;

  const actionMap = {
    'browsa-ask':       'chat',
    'browsa-explain':   'explain',
    'browsa-translate': 'translate',
    'browsa-summarize': 'summarize'
  };
  const action = actionMap[info.menuItemId];
  if (!action) return;

  selectionCache.set(tab.id, {
    text,
    html: (typeof cached === 'object' && cached?.html) || '',
  });
  syncTabPurgeListener(); // 菜单路径不走 handle()，selectionCache 增长要自己武装 purge 监听
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

// DNR cleanup is only safe when no side panel is open: the media-header rules
// belong to the panel, which can be mid-download while unrelated SW events
// arrive. A last-panel disconnect is the in-session safe point; browser
// startup/install are the cold ones.
function sweepDnrIfNoPanels() {
  if (navPorts.size === 0) sweepOrphanedMediaRules().catch(() => {});
}
chrome.runtime.onStartup?.addListener(() => {
  sweepOrphanedMediaRules().catch(() => {});
});

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
async function siteCacheCtx(t, url = '') {
  await siteCacheRestorePromise(); // ensure session-storage restore finished (lazy, shared)
  if (typeof t !== 'number') return { xhsXhrNote: null, siteCache: null };
  // `url` lets cache selection be host-aware (see getSiteCache): without it a
  // stale entry from the previous site in this tab shadowed the live one.
  return { xhsXhrNote: xhsXhrCache.get(t) || null, siteCache: getSiteCache(t, url) };
}

// 选区 HTML 的存储上限（selectionCache 的 html 字段；整页误选的极端情形也不至于
// 把 SW 内存拖爆——超限截断的尾部丢失可接受，text 字段不受影响）。
const SELECTION_HTML_CAP = 300_000;

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
        // PEEK→HELLO resume race (msg.resume is set ONLY by
        // resumeInFlightStream's HELLO — a fresh-send HELLO arrives BEFORE
        // its CHAT even started and must never pick up a stale tombstone):
        // the turn finished inside the handshake window, its DONE/ERROR went
        // to the old/absent port, and streamState is already cleared. Replay
        // the tombstoned terminal event so the resuming panel finalizes
        // instead of spinning forever. The synthetic-DONE net (tombstone
        // expired — unreachable in practice, the TTL dwarfs the window)
        // finalizes with the panel's PEEK-seeded acc; the turn is persisted
        // by then, so the DONE branch's hidxAssign stays correct.
        if (msg.resume && !streamState.has(claimedTabId)) {
          const terminal = takeTerminalTombstone(claimedTabId) || { type: 'DONE', full: null, synthetic: true };
          try { port.postMessage(terminal); } catch (_) {}
        }
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
        sweepDnrIfNoPanels();
      } else if (msg && msg.type === 'NAV_FOLLOW' && typeof msg.tabId === 'number') {
        // Side panel can switch which tab it's watching (e.g. user clicked
        // a different tab in the browser). Re-register.
        if (claimedTabId != null && claimedTabId !== msg.tabId) {
          const oldSet = navPorts.get(claimedTabId);
          if (oldSet) {
            oldSet.delete(port);
            // Keep `navPorts.size === 0` an accurate "no panels" signal for
            // the DNR safe-point sweep — an empty stale tab entry would make
            // it look like a panel is still open forever.
            if (oldSet.size === 0) navPorts.delete(claimedTabId);
          }
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
        sweepDnrIfNoPanels();
        console.log('browsa[bg]: nav port disconnected for tab', claimedTabId);
      }
    });
    return;
  }
});

// GC for stale streamState entries. A stream can be orphaned when a tab
// is closed (or crashes) mid-stream before the CHAT handler's finally{} runs.
// Only entries with NO live controller/run and older than STREAM_STATE_TTL_MS
// are dropped — a live long turn (agent tools, pending approval) must survive
// its own age.
//
// MV3 service workers can sleep between events, so a setTimeout/setInterval
// would be cleared on sleep. We use chrome.alarms (which survives sleep) to
// guarantee GC runs even when the extension is idle for long periods.
const STREAM_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function gcStreamState() {
  const now = Date.now();
  for (const [tabId, st] of streamState.entries()) {
    // A LIVE turn is never stale, no matter how old it is: agent turns with
    // tool calls or a pending approval routinely run past 10 minutes. The TTL
    // exists for entries whose panel/tab died before the handler's finally{},
    // and those have no controller/run entry. Deleting a live entry made the
    // ownership gate suppress DONE (it compared against a state object that
    // no longer existed), leaving the panel spinning forever (2026-10-21
    // release audit).
    const live = chatControllers.has(tabId) || activeRunIds.has(tabId);
    const lastTouch = Math.max(st.startedAt || 0, st.lastDeltaAt || 0);
    if (!live && now - lastTouch > STREAM_STATE_TTL_MS) {
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

// Restore site caches from session storage LAZILY on first need (2026-09-30
// 批C): the eager top-level restore ran chrome.storage.session.get(null) —
// deserializing EVERY cached site payload (video data, articles; hundreds of
// KB per tab) — on every SW cold start, including wakes for messages that
// never touch site caches. The first siteCacheCtx() call pays it once; the
// promise is shared. restoreSiteCachesFromSession also validates tab liveness
// and prunes dead tabs' sc_* keys (see site-cache-store.js) — that durable
// cleanup is what lets tabs.onRemoved below be registered on demand.
let _siteCacheRestore = null;
function siteCacheRestorePromise() {
  if (!_siteCacheRestore) {
    _siteCacheRestore = restoreSiteCachesFromSession().then(() => { syncTabPurgeListener(); });
  }
  return _siteCacheRestore;
}
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

// SW-death salvage sweep (2026-10-13): if the previous SW died mid-stream
// despite the keepalive alarm, its durable in-flight turn record (lib/state.js)
// survived in storage.session. Sweep it on EVERY module eval — that runs on
// each SW wake, and there is no "I crashed" event to hook. STREAM_PEEK awaits
// this same memoized promise, so a panel reopening right after a death sees
// the recovered partial deterministically even when this sweep hasn't
// finished yet. Fire-and-forget here; failures are logged inside.
ensureDurableSalvage().catch(() => {});

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
      try {
        const result = await handle(msg, sender);
        sendResponse({ ok: true, data: result });
      } finally {
        // Any tab-scoped cache this message populated (selectionCache,
        // SITE_CACHES via recordSiteMessage, xhsXhrCache) must arm the
        // on-demand tab-purge listener — see syncTabPurgeListener.
        syncTabPurgeListener();
      }
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
      // No production sender (the panel's XHS probe reads GET_PAGE_CONTEXT
      // since the 2026-10-01 relay fix) — this case stays as the test
      // seam that observes what pushXhsNote cached, including the
      // security pin "tabId comes from sender.tab.id, never msg.tabId"
      // (background-handler.test.mjs).
      const t = msg.tabId;
      return { note: xhsXhrCache.get(t) || null };
    }

    case 'CONTENT_SETTINGS_GET': {
      // selection-toolbar's two content-script settings. Sent as a message
      // (not read from chrome.storage in the page) because storage.local is
      // locked to TRUSTED_CONTEXTS — see setAccessLevel at the top of the
      // worker.
      const [showSelectionToolbar, uiLang] = await Promise.all([
        storage.get('showSelectionToolbar'),
        storage.get('uiLang'),
      ]);
      return { showSelectionToolbar: showSelectionToolbar !== false, uiLang: uiLang || null };
    }

    case 'SELECTION_CACHE': {
      // Content script sends this on every selectionchange. We only store
      // non-empty selections — clicking elsewhere clears the visual selection
      // but we deliberately keep the cache so the user can still use 📎
      // or the floating toolbar after clicking into the side panel.
      // html carries the same selection's structure (capped) for the
      // selected-attach Markdown upgrade; text stays the source of truth.
      const tabId = sender?.tab?.id;
      if (tabId && msg.text) {
        selectionCache.set(tabId, {
          text: msg.text,
          html: typeof msg.html === 'string' ? msg.html.slice(0, SELECTION_HTML_CAP) : '',
          // Origin URL at capture time: a selection made on page A must never
          // be attached under page B's URL/title after an SPA or full
          // navigation in the same tab (the cache outlives the document).
          url: typeof msg.url === 'string' ? msg.url : (sender?.tab?.url || ''),
        });
      }
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
      // User explicitly clicked "📎 Attach page". Body lives in
      // lib/handlers/attach-page.js (handleAttachPage — the last 372-line case
      // body, extracted 2026-10-28; architecture-review candidate #2, after
      // attach-store.js). The router owns tabId resolution and passes its
      // resident plumbing (site-cache/session restore + deep-extract progress
      // over the nav ports); the handler owns the flow.
      const tabId = msg.tabId ?? tabIdOf(msg, sender);
      if (!tabId) return { ok: false, error: 'no tabId' };
      return handleAttachPage(msg, sender, { tabId, siteCacheCtx, pushDeepProgress });
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
      // rehydrate the assistant bubble from streamState.acc. With
      // `sessionId` it also ATTACHES a watcher: a backgrounded stream (the
      // user switched sessions mid-turn) resumes pushing only when the
      // attached session is the turn's ORIGIN — never re-render another
      // conversation's reply into this one.
      const t = msg.tabId;
      const st = streamState.get(t);
      if (!st) {
        // Not in memory — but if the previous SW died mid-turn, the durable
        // record does: awaiting the memoized sweep here salvages it into
        // history (once per SW lifetime) and lets the panel re-render it.
        // Read-once per tab (Set.delete): one re-render per salvaged turn.
        const recovered = (await ensureDurableSalvage()).delete(t);
        // Turn finished INSIDE the panel-reopen window (2026-10-14 field
        // report: streaming close→reopen showed nothing): DONE persisted
        // AFTER init's renderHistory read storage, PEEK answers after
        // clearStreamState — the reply is in history but rendered nowhere.
        // A non-consuming tombstone peek flags it; the panel re-renders
        // once. (Not take(): a resume-HELLO replay may still need it.)
        const justFinished = !recovered && peekTerminalTombstone(t);
        return recovered ? { inFlight: false, recovered: true }
          : justFinished ? { inFlight: false, justFinished: true }
          : { inFlight: false };
      }
      if (msg.sessionId != null && st.originSessionId === msg.sessionId) st.bg = false;
      // 并发审批堆叠（2026-10-15）：把该 tab 名下仍未决的审批/澄清卡随 PEEK
      // 带回——面板重开时流正停在等审批，没有卡用户就无法应答（只能干等到
      // idle-stop）。已答的条目在 RESPOND 成功时已删，不会重复补挂。
      const peekPrefix = `${t}::`;
      return {
        inFlight: true,
        acc: st.acc,
        startedAt: st.startedAt,
        lastDeltaAt: st.lastDeltaAt,
        providerLabel: st.providerLabel,
        providerKey: st.providerKey,
        originSessionId: st.originSessionId || null,
        bg: !!st.bg,
        pendingAgentCards: {
          approvals: [...pendingApprovals]
            .filter(([k]) => k.startsWith(peekPrefix))
            .map(([reqKey, e]) => ({ reqKey, data: e.data })),
          clarifies: [...pendingClarifications]
            .filter(([k]) => k.startsWith(peekPrefix))
            .map(([reqKey, e]) => ({ reqKey, data: e.data })),
        },
      };
    }

    case 'REASSIGN_STREAM_SESSION': {
      // Session switch with an in-flight turn: the stream goes to the
      // BACKGROUND — its reply must land in the session it STARTED in
      // (msg.sessionId, just snapshotted by the switch-away auto-save), not
      // the conversation the user switched to. The panel detaches its port
      // separately (stop-watching, not cancelling).
      const st = streamState.get(msg.tabId);
      // Refuse to background without an origin session: bg routing keys
      // persistTurnEntry on originSessionId, and an empty origin falls
      // through to LIVE history — the finished reply would land in whatever
      // conversation the user just switched TO (the exact cross-conversation
      // leak bg-gating exists to prevent). reassigned:false tells the caller
      // to cancel the turn instead of detaching it.
      if (st && msg.sessionId) {
        st.originSessionId = msg.sessionId;
        st.bg = true;
      }
      return { reassigned: !!(st && msg.sessionId) };
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
        // `salvage: false` (clearChatHistory — explicit destruction) aborts
        // with reason 'drop': the CHAT handler's catch then skips the
        // interrupted-turn salvage. Everything else keeps the partial text.
        try { controller.abort(msg.salvage === false ? 'drop' : 'user-cancel'); } catch (_) {}
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
      // Do NOT clearStreamState here: the CHAT handler's abort catch reads
      // streamState.acc for the interrupted-turn salvage and clears it itself.
      return { aborted: !!controller };
    }

    case 'SUBCHAT_APPROVAL_RESPOND':   // subchat-keyed approval relay (detail thread card)
      return handleSubchatApprovalRespond(msg);
    case 'SUBCHAT_CLARIFY_RESPOND':    // subchat-keyed clarification relay (detail thread card)
      return handleSubchatClarifyRespond(msg);

    case 'APPROVAL_RESPOND': {      // User clicked Allow/Deny on an approval card. Relay the choice to
      // the agent so it can resume. The card carries its reqKey — the pending
      // entry's map key (agent-stream-session.js agentPendingKey). Routing by
      // reqKey keeps concurrently stacked cards answering their OWN request
      // (the old tabId single slot let the second event overwrite the first,
      // losing it and mis-relaying an in-flight answer to the new request).
      // opencode pending entries carry the server session + request id and
      // reply via the opencode endpoints; card choices (once/always/deny) map
      // onto opencode's reply enum (deny → reject) — see showApprovalCard's
      // btnLabels.
      const pending = pendingApprovals.get(msg.reqKey);
      if (!pending) return { ok: false, error: 'no pending approval' };
      try {
        const res = await relayApproval(pending, msg.choice);
        // 答成即删：条目不再参与 STREAM_PEEK 的未决卡补挂；失败保留供重试。
        if (res?.ok) pendingApprovals.delete(msg.reqKey);
        return res;
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    }

    case 'CLARIFY_RESPOND': {
      // User submitted a clarification response. Relay to the agent. The
      // opencode question flow expects {answers: [[label, …], …]} — browsa's
      // clarify card is free-text, so the response rides as the single
      // selected label (opencode's QuestionInfo has a `custom` answer path).
      // reqKey routing mirrors APPROVAL_RESPOND (see above).
      const pending = pendingClarifications.get(msg.reqKey);
      if (!pending) return { ok: false, error: 'no pending clarification' };
      try {
        const res = await relayClarify(pending, msg.response);
        if (res?.ok) pendingClarifications.delete(msg.reqKey);
        return res;
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
      // Host for cache selection: the caller's tab URL (sender.tab is present
      // for content-script callers; panel callers pass the live tab id).
      const tabForCache = typeof t === 'number' ? await chrome.tabs.get(t).catch(() => null) : null;
      const ctx = await extractActiveTab({
        mode,
        tabId: typeof t === 'number' ? t : null,
        maxTextChars: all.maxTextChars,
        ...(await siteCacheCtx(t, msg.tabUrl || tabForCache?.url || '')),
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
  // SPA route change = new document/route; a selection from the previous
  // route is no longer attachable (it would be sent under the new URL).
  selectionCache.delete(details.tabId);
  broadcastNav(details.tabId, details.url);
}

function onNavCommitted(details) {
  if (details.frameId !== 0) return;
  // Only fires for non-history-API commits. onHistoryStateUpdated handles
  // the SPA case. This is a safety net for any other navigation path.
  selectionCache.delete(details.tabId);
  broadcastNav(details.tabId, details.url);
}

function onNavBeforeNavigate(details) {
  if (details.frameId !== 0) return;
  // A selection captured on the outgoing page must not survive into the next
  // one (same tabId key) — clear it at the earliest navigation signal.
  selectionCache.delete(details.tabId);
  // Reset the dedup so a same-URL back/forward (which history treats as
  // a new navigation) still fires. We can't know the new URL yet, so we
  // just clear.
  lastNavBroadcast.delete(details.tabId);
}

let navListenersActive = false;
function syncNavListeners() {
  // navPorts is also the tab-purge listener's gate input — piggyback the sync
  // here so all four navPorts mutation sites stay covered without edits.
  syncTabPurgeListener();
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

const xhsXhrCache    = new Map(); // tabId -> XHS note summary (has special push logic, kept separate)

// Site-specific XHR intercept caches, keyed by tabId. Each entry is a Map.
// Adding a new site requires only adding an entry here — restore, getSiteCache,
// and onRemoved all iterate this registry automatically.
// 站点缓存 registry 外迁 lib/handlers/site-cache-store.js（C7）——handle() 的
// 站点 case 从此只剩路由。
import { recordSiteMessage, getSiteCache, purgeTab, restoreSiteCachesFromSession, siteCacheCount } from './lib/handlers/site-cache-store.js';


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

// tabs.onRemoved is REGISTERED ON DEMAND (2026-09-30 批C, same pattern as
// syncNavListeners above): a statically registered listener cold-started the
// SW (644KB module parse) on EVERY tab close in EVERY window just to delete a
// few Map entries — and after an SW sleep those Maps are empty anyway, so the
// wake was pure cost. The DURABLE half of the old purge (dead tabs' sc_*
// session keys) moved into restoreSiteCachesFromSession's liveness validation,
// which also closed the old purge-vs-restore race: a tab closing while the
// eager startup restore was in flight used to get its cache RESURRECTED by
// the restore resolving after the purge.
function _tabPurgeHandler(tabId) {
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
  syncTabPurgeListener();
}
let tabPurgeListenerActive = false;
function syncTabPurgeListener() {
  // Needed exactly while any tab-scoped in-memory state exists to purge.
  // Registration can never lag a growth site by more than one event: every
  // mutation path (runtime messages, context-menu selections, nav ports,
  // the lazy site-cache restore) calls this right after writing.
  const want = navPorts.size > 0 || lastNavBroadcast.size > 0 ||
    selectionCache.size > 0 || xhsXhrCache.size > 0 || siteCacheCount() > 0;
  if (want === tabPurgeListenerActive) return;
  tabPurgeListenerActive = want;
  try {
    chrome.tabs.onRemoved[want ? 'addListener' : 'removeListener'](_tabPurgeHandler);
  } catch (_) { /* test mocks may lack removeListener; real Chrome has both */ }
}

// Exported for testing. handle() is the switch-based message dispatcher.
export { handle };
// withSiteInstructions/withVideoNote moved to lib/handlers/attach-page.js
// (2026-10-28); re-exported so the existing import surface stays put
// (test/attach-llms-txt.test.mjs destructures them from here).
export { withSiteInstructions, withVideoNote } from './lib/handlers/attach-page.js';
