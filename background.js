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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'browsa-chat') return;
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
      sendResponse({ ok: false, error: e?.message || String(e), code: e?.name || 'Error' });
    }
  })();
  return true;
});

async function handle(msg, _sender) {
  switch (msg.type) {
    case 'GET_CONFIG': {
      return storage.getAll();
    }

    case 'SET_ACTIVE_PROVIDER': {
      await storage.setActiveProvider(msg.name);
      return { activeProvider: msg.name };
    }

    case 'SET_CONTEXT_MODE': {
      await storage.setContextMode(msg.mode);
      return { contextMode: msg.mode };
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
      const ctx = await extractActiveTab({
        mode,
        maxTextChars: all.maxTextChars
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
            maxTextChars: all.maxTextChars
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
              truncated: pageContext.truncated
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
