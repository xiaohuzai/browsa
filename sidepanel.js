// sidepanel.js — UI logic
// Talks to background.js via chrome.runtime messages. Streaming responses come back
// via a long-lived Port (chrome.runtime.connect) for low-latency chunk delivery.

import marked from './lib/marked.min.js';
import DOMPurify from './lib/purify.min.js';

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
const settingsBtn = $('settings');
const ctxRadios = document.querySelectorAll('input[name="ctx"]');
const autoAttachEl = $('autoattach');
const pagemetaEl = $('pagemeta');

let currentTabId = null;
let activeController = null; // for cancelling in-flight stream
let lastPageMeta = null;

init();

async function init() {
  // Get current tab id (used for per-tab history)
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTabId = tab?.id;

  // Load config
  const cfg = await sendMessage({ type: 'GET_CONFIG' });
  populateProviderSelect(cfg);
  applyContextMode(cfg.contextMode || 'reader');
  autoAttachEl.checked = !!cfg.autoAttachPage;

  // Load history
  await renderHistory();

  // Wire UI
  providerSel.addEventListener('change', onProviderChange);
  settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  ctxRadios.forEach((r) => r.addEventListener('change', onContextModeChange));
  autoAttachEl.addEventListener('change', () => {
    // Persisted on background; also locally
  });
  sendBtn.addEventListener('click', onSend);
  inputEl.addEventListener('input', updateComposerInfo);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });

  // Show current page meta
  if (tab) {
    pagemetaEl.textContent = tab.title || tab.url || '';
    pagemetaEl.href = tab.url || '#';
    pagemetaEl.title = tab.url || '';
  }

  // Update page meta when tab changes
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    currentTabId = tabId;
    await renderHistory();
    const t = await chrome.tabs.get(tabId);
    if (t) {
      pagemetaEl.textContent = t.title || t.url || '';
      pagemetaEl.href = t.url || '#';
      pagemetaEl.title = t.url || '';
    }
  });
  chrome.tabs.onUpdated.addListener(async (tabId, _info, t) => {
    if (tabId === currentTabId) {
      pagemetaEl.textContent = t.title || t.url || '';
      pagemetaEl.href = t.url || '#';
      pagemetaEl.title = t.url || '';
    }
  });

  // Listen for config changes (from options page)
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.providers || changes.activeProvider) {
      const cfg2 = await sendMessage({ type: 'GET_CONFIG' });
      populateProviderSelect(cfg2);
    }
  });

  inputEl.focus();
}

function populateProviderSelect(cfg) {
  const providers = Object.keys(cfg.providers || {});
  providerSel.innerHTML = '';
  for (const name of providers) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = prettyProviderName(name);
    if (name === cfg.activeProvider) opt.selected = true;
    providerSel.appendChild(opt);
  }
}

function prettyProviderName(name) {
  if (name === 'hermes') return 'Hermes';
  if (name === 'claude-code') return 'Claude Code';
  if (name === 'openclaw') return 'OpenClaw';
  return name;
}

function applyContextMode(mode) {
  for (const r of ctxRadios) r.checked = r.value === mode;
}

// Markdown -> sanitized HTML pipeline. Returns HTML safe for innerHTML.
function renderSafe(markdown) {
  try {
    const rawHtml = marked.parse(markdown || '');
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ['target', 'rel'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|#)/
    });
  } catch (e) {
    return DOMPurify.sanitize(
      (markdown || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;'
      }[c]))
    );
  }
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

// Build a streaming-render closure for a specific bubble. Streaming path is
// fast (textContent via rAF throttle); the final DONE render goes through
// marked + DOMPurify for proper Markdown formatting.
function makeStreamRenderer(el) {
  let raf = null;
  return function renderStream(text, isDone) {
    if (isDone) {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      el.innerHTML = renderSafe(text);
      el.classList.add('done');
      decorateLinks(el);
      scrollToBottom();
      return;
    }
    if (raf != null) return; // already scheduled
    raf = requestAnimationFrame(() => {
      raf = null;
      // Plain text during streaming — fast (1 textContent assignment) and
      // we save the expensive Markdown parse for the final render.
      el.textContent = text;
      el.classList.remove('done');
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
  charCountEl.textContent = t.length.toLocaleString();
  const est = estimateTokens(t);
  tokCountEl.textContent = '~' + est.toLocaleString();
  // Color the line based on size
  composerInfoEl.classList.remove('warn', 'danger');
  if (est > 50_000) composerInfoEl.classList.add('danger');
  else if (est > 10_000) composerInfoEl.classList.add('warn');
}

async function onProviderChange() {
  const name = providerSel.value;
  await sendMessage({ type: 'SET_ACTIVE_PROVIDER', name });
  appendSystem(`Switched to provider: ${prettyProviderName(name)}`);
}

async function onContextModeChange() {
  const mode = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  await sendMessage({ type: 'SET_CONTEXT_MODE', mode });
}

async function onSend() {
  if (!currentTabId) {
    appendError('No active tab.');
    return;
  }
  const text = inputEl.value.trim();
  if (!text && autoAttachEl.checked) {
    // Even with empty text, if page is attached, we can still send.
  } else if (!text) {
    return;
  }

  // Auto-detect: if user has highlighted text on the page, prefer Selection
  // mode automatically. Otherwise respect the chosen context mode.
  let mode = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  try {
    const selRes = await sendMessage({ type: 'GET_PAGE_CONTEXT', mode: 'selected', targetTabId: currentTabId });
    const selText = (selRes?.text || '').trim();
    if (selText && selText.length >= 8) {
      // The user has selected something on the page — use it.
      mode = 'selected';
    }
  } catch (_) {
    // ignore; fall back to chosen mode
  }

  // User bubble
  appendUser(text || '(page only)');
  inputEl.value = '';
  sendBtn.disabled = true;

  // Placeholder assistant bubble
  const assistantEl = appendAssistant('▍');
  let acc = '';
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
        renderStream(acc, false);
      } else if (m.type === 'DONE') {
        renderStream(m.full || acc, true);
      } else if (m.type === 'ERROR') {
        assistantEl.textContent = `❌ ${m.error}`;
      }
    });
  }
  port.onDisconnect.addListener(() => {
    sendBtn.disabled = false;
    activeController = null;
    if (acc === '' && assistantEl.textContent === '▍') {
      // No chunks received AND the assistant bubble still shows the
      // placeholder. The background reported an error before any delta
      // was emitted. Show a clear hint.
      assistantEl.textContent = '(no chunks received — check Service Worker DevTools)';
    }
  });

  try {
    const res = await sendMessage({
      type: 'CHAT',
      tabId: currentTabId,
      userText: text,
      attachPage: !!autoAttachEl.checked,
      contextMode: mode,
      stream: true,
      portName: 'browsa-chat' // <- background's onConnect uses port.name to push deltas back
    });
    if (!res.ok) {
      appendError(`${res.code || 'Error'}: ${res.error}`);
      assistantEl.remove();
    } else if (res.data?.pageContext?.truncated?.textLength) {
      const t = res.data.pageContext.truncated;
      if (t.rawHtmlLength > t.textLength) {
        appendSystem(
          `ℹ Page truncated: sent ${t.textLength.toLocaleString()} of ${t.rawHtmlLength.toLocaleString()} chars ` +
          `(limit ${t.textCap.toLocaleString()}). Raise limits in ⚙ Settings if you need more.`
        );
      }
    }
  } catch (e) {
    appendError(e.message);
    assistantEl.remove();
  } finally {
    sendBtn.disabled = false;
  }
}

function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}
function appendAssistant(initial) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.textContent = initial;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}
function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}
function appendError(text) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = '⚠ ' + text;
  messagesEl.appendChild(el);
  scrollToBottom();
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

async function renderHistory() {
  if (!currentTabId) return;
  messagesEl.innerHTML = '';
  // Pull history directly from storage
  const { history = {} } = await chrome.storage.local.get('history');
  const list = history[String(currentTabId)] || [];
  for (const m of list) {
    if (m.role === 'user') appendUser(m.content);
    else if (m.role === 'assistant') appendAssistant(m.content);
  }
  scrollToBottom();
}
