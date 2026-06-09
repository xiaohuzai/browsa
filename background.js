// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG / SET_CONFIG: read/write storage
//   - CLEAR_HISTORY: clear per-tab history

import * as storage from './lib/storage.js';
import { chatStream, chat, ping, ProviderConfigError, ProviderAPIError, ProviderNetworkError } from './lib/openai-client.js';
import { extractActiveTab, buildMessages, ensureReadabilityInjected } from './lib/page-extractor.js';

// Allow side panel to open on action click (Chrome MV3)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('browsa: setPanelBehavior failed', e));

// Streaming port: the side panel opens a long-lived port named 'browsa-chat'
// before sending the CHAT message. As soon as the background's CHAT handler
// has the first delta from the LLM, it pushes it back through this port.
// We keep a registry keyed by tabId so multiple tabs (each with their own
// side panel) can stream independently.
const streamPorts = new Map(); // tabId -> Port

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
        streamPorts.set(msg.tabId, port);
        console.log('browsa[bg]: stream port registered for tab', msg.tabId);
        // Acknowledge so the side panel knows it's safe to send CHAT. This
        // prevents a race where the first LLM chunk arrives before we have
        // the port in our Map.
        try { port.postMessage({ type: 'STREAM_HELLO_ACK' }); } catch (_) {}
      } else if (msg && msg.type === 'STREAM_GOODBYE' && claimedTabId != null) {
        streamPorts.delete(claimedTabId);
        console.log('browsa[bg]: stream port released for tab', claimedTabId);
      }
    });
    port.onDisconnect.addListener(() => {
      if (claimedTabId != null) {
        streamPorts.delete(claimedTabId);
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
      // Sent by the side panel when it wants the latest XHR data
      // for a given tab. Returns null if we haven't seen one yet.
      const t = msg.tabId;
      return { note: xhsXhrCache.get(t) || null };
    }

    case 'SET_ACTIVE_PROVIDER': {
      await storage.setActiveProvider(msg.name);
      return { activeProvider: msg.name };
    }

    case 'SET_CONTEXT_MODE': {
      await storage.setContextMode(msg.mode);
      return { contextMode: msg.mode };
    }

    case 'CLEAR_HISTORY': {
      await storage.clearHistory(msg.tabId);
      console.log('browsa[bg]: history cleared for tab', msg.tabId);
      return {};
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

    case 'CLEAR_HISTORY': {
      const tabId = msg.tabId;
      if (tabId == null) throw new Error('tabId required');
      await storage.clearHistory(tabId);
      return { cleared: true };
    }

    case 'GET_PAGE_CONTEXT': {
      const all = await storage.getAll();
      const mode = msg.mode || all.contextMode || 'reader';
      if (mode === 'reader') {
        // Readability + Turndown need to be in the page world for reader
        // mode. Skip injection for 'selected' (only reads window.getSelection)
        // and 'full' (uses body.innerText).
        await ensureReadabilityInjected(tabIdOf(msg, sender)).catch(() => {});
      }
      // If we have a recent XHR note for this tab, pass it in so the
      // extractor can prefer it over the DOM scrape. The XHR data is
      // far more reliable on 小红书 because the SPA often renders a
      // skeleton until the JS catches up.
      const t = tabIdOf(msg, sender);
      const xhrNote = (typeof t === 'number') ? (xhsXhrCache.get(t) || null) : null;
      const ctx = await extractActiveTab({
        mode,
        maxTextChars: all.maxTextChars,
        xhsXhrNote: xhrNote
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
      // Stream a chat turn. The side panel receives deltas via CHUNK messages.
      const all = await storage.getAll();
      const provider = all.providers[all.activeProvider];
      if (!provider) throw ProviderConfigError(`Provider "${all.activeProvider}" not configured`);

      const tabId = msg.tabId;
      if (tabId == null) throw new Error('tabId required');

      // Page context: optional based on msg.attachPage
      let pageContext = null;
      if (msg.attachPage) {
        try {
          const mode = msg.contextMode || all.contextMode || 'reader';
          if (mode === 'reader') {
            const inj = await ensureReadabilityInjected(tabId).catch((e) => ({ injected: false, error: e.message }));
            console.log('browsa[bg]: ensurePageLibrariesInjected →', inj);
          }
          pageContext = await extractActiveTab({
            mode,
            maxTextChars: all.maxTextChars,
            waitMs: msg.waitMs || 0
          });
          if (pageContext) {
            console.log('browsa[bg]: pageContext', {
              mode: pageContext.mode,
              format: pageContext.format,
              textLength: pageContext.text?.length,
              wasCapped: pageContext.truncated?.wasCapped,
              imageCount: pageContext.imageCount
            });
          }
        } catch (e) {
          // If extraction fails, just send without it.
          console.warn('browsa: page extract failed, sending without context', e);
        }
      }

      // History (without the new turn yet)
      const history = await storage.getHistory(tabId);

      // Build messages
      const messages = buildMessages({
        history,
        userText: msg.userText,
        pageContext,
        withImage: pageContext?.imageDataUrl ? true : false,
        userImages: msg.images // pasted / dropped images (base64 data URLs)
      });

      // Persist the user turn (text only, no image)
      const userTurn = { role: 'user', content: msg.userText || '(no instruction)' };
      await storage.appendToHistory(tabId, userTurn);

      // Stream
      let fullReply = '';
      const stream = msg.stream !== false && provider.stream !== false;

      if (stream) {
        fullReply = await chatStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model || provider.defaultModel,
          messages,
          onDelta: (delta) => {
            pushChunk(tabId, { type: 'CHUNK', delta });
          },
          signal: msg.signal ? AbortSignal.timeout(60_000 * 5) : undefined // 5 min cap
        });
      } else {
        fullReply = await chat({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model || provider.defaultModel,
          messages,
          signal: msg.signal ? AbortSignal.timeout(60_000 * 5) : undefined
        });
        pushChunk(tabId, { type: 'CHUNK', delta: fullReply });
      }

      // Persist assistant turn
      await storage.appendToHistory(tabId, { role: 'assistant', content: fullReply });

      pushChunk(tabId, { type: 'DONE', full: fullReply });
      // Disconnect the streaming port so the side panel's onDisconnect fires
      // and resets the Send button state. A short delay gives the DONE chunk
      // time to be delivered before the port is torn down.
      setTimeout(() => {
        const p = streamPorts.get(tabId);
        if (p) {
          try { p.disconnect(); } catch (_) {}
          streamPorts.delete(tabId);
        }
      }, 50);
      return {
        full: fullReply,
        pageContext: pageContext
          ? {
              mode: pageContext.mode,
              url: pageContext.meta.url,
              title: pageContext.meta.title,
              truncated: pageContext.truncated,
              limitHint: pageContext.limitHint
            }
          : null
      };
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

// Pure broadcast helper: given the current "last URL" map, the nav-port
// registry, a tabId, and a new URL, decide what (if anything) to push to
// each registered port, and return the updated "last URL" map. Pure for
// testability — no chrome.* calls, no module state reads.
function dedupeAndBroadcast(lastNavMap, navPortsMap, tabId, url) {
  if (typeof tabId !== 'number' || !url) return { updated: false, lastNavMap, sent: 0 };
  if (lastNavMap.get(tabId) === url) return { updated: false, lastNavMap, sent: 0 };
  const next = new Map(lastNavMap);
  next.set(tabId, url);
  const set = navPortsMap.get(tabId);
  if (!set || set.size === 0) return { updated: true, lastNavMap: next, sent: 0 };
  for (const p of set) {
    try { p.postMessage({ type: 'NAVIGATED', tabId, url, title: '' }); } catch (_) {}
  }
  return { updated: true, lastNavMap: next, sent: set.size };
}

function broadcastNav(tabId, url, title) {
  if (typeof tabId !== 'number' || !url) return;
  const result = dedupeAndBroadcast(lastNavBroadcast, navPorts, tabId, url);
  if (!result.updated) return;
  // dedupeAndBroadcast returned an updated map (which is either the same
  // reference as lastNavBroadcast or a copy containing the new entry).
  // lastNavBroadcast is a `const` Map, so we mutate in place.
  if (result.lastNavMap !== lastNavBroadcast) {
    lastNavBroadcast.clear();
    for (const [k, v] of result.lastNavMap) lastNavBroadcast.set(k, v);
  }
  if (result.sent > 0) {
    console.log(`browsa[bg]: nav broadcast tab=${tabId} url=${url} sentTo=${result.sent}`);
  }
}

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // only top frame
  broadcastNav(details.tabId, details.url, '');
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  // Only fires for non-history-API commits. onHistoryStateUpdated handles
  // the SPA case. This is a safety net for any other navigation path.
  broadcastNav(details.tabId, details.url, '');
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  // Reset the dedup so a same-URL back/forward (which history treats as
  // a new navigation) still fires. We can't know the new URL yet, so we
  // just clear.
  lastNavBroadcast.delete(details.tabId);
});

// Xiaohongshu XHR feed cache.
//
// The content script (lib/xhs-content-script.js) intercepts the
// browser's own fetch / XHR against /api/sns/web/v1/feed and
// forwards the JSON to us. We keep the most recent one per tab
// and push it to any side panel that's listening for that tab.
// The side panel then has the FULL XHR data — desc, imageList,
// interactInfo — which is far more reliable than scraping the
// rendered DOM (the SPA may have replaced or hidden it).
//
// Keyed by tabId, not noteId: when the user clicks a new note the
// XHR for that note arrives and overwrites the previous one. We
// always trust the most recent XHR.
const xhsXhrCache = new Map(); // tabId -> note summary

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
  xhsXhrCache.delete(tabId);
  const set = navPorts.get(tabId);
  if (set) {
    for (const p of set) {
      try { p.postMessage({ type: 'NAVIGATED', tabId, url: '', title: '', closed: true }); } catch (_) {}
    }
    navPorts.delete(tabId);
  }
});
