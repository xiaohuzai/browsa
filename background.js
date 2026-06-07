// background.js — service worker (module type)
// Routes messages from the side panel:
//   - GET_PAGE_CONTEXT: extract active tab page
//   - CHAT: send messages to active provider
//   - GET_CONFIG / SET_CONFIG: read/write storage
//   - CLEAR_HISTORY: clear per-tab history

import * as storage from './lib/storage.js';
import { chatStream, chat, ping, ProviderConfigError, ProviderAPIError, ProviderNetworkError } from './lib/openai-client.js';
import { extractActiveTab, buildMessages } from './lib/page-extractor.js';

// Allow side panel to open on action click (Chrome MV3)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('browsa: setPanelBehavior failed', e));

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

    case 'CLEAR_HISTORY': {
      const tabId = msg.tabId;
      if (tabId == null) throw new Error('tabId required');
      await storage.clearHistory(tabId);
      return { cleared: true };
    }

    case 'GET_PAGE_CONTEXT': {
      const all = await storage.getAll();
      const ctx = await extractActiveTab({ mode: msg.mode || all.contextMode || 'full' });
      return ctx;
    }

    case 'PING_PROVIDER': {
      const { name, baseUrl, apiKey, model } = msg;
      let cfg;
      if (name) {
        cfg = (await storage.getAll()).providers[name];
        if (!cfg) throw new ProviderConfigError(`Provider "${name}" not configured`);
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
      if (!provider) throw new ProviderConfigError(`Provider "${all.activeProvider}" not configured`);

      const tabId = msg.tabId;
      if (tabId == null) throw new Error('tabId required');

      // Page context: optional based on msg.attachPage
      let pageContext = null;
      if (msg.attachPage) {
        try {
          pageContext = await extractActiveTab({ mode: msg.contextMode || all.contextMode || 'full' });
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
        withImage: pageContext?.imageDataUrl ? true : false
      });

      // Persist the user turn (text only, no image)
      const userTurn = { role: 'user', content: msg.userText || '(no instruction)' };
      await storage.appendToHistory(tabId, userTurn);

      // Stream
      let fullReply = '';
      const stream = msg.stream !== false && provider.stream !== false;

      const port = msg.port; // optional: a Port for streaming deltas back

      if (stream) {
        fullReply = await chatStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model || provider.defaultModel,
          messages,
          onDelta: (delta) => {
            if (port) safePost(port, { type: 'CHUNK', delta });
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
        if (port) safePost(port, { type: 'CHUNK', delta: fullReply });
      }

      // Persist assistant turn
      await storage.appendToHistory(tabId, { role: 'assistant', content: fullReply });

      if (port) safePost(port, { type: 'DONE', full: fullReply });
      return { full: fullReply, pageContext: pageContext ? { mode: pageContext.mode, url: pageContext.meta.url, title: pageContext.meta.title } : null };
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
