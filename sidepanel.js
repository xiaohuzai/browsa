// sidepanel.js — UI logic
// Talks to background.js via chrome.runtime messages. Streaming responses come back
// via a long-lived Port (chrome.runtime.connect) for low-latency chunk delivery.

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const providerSel = $('provider');
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
  applyContextMode(cfg.contextMode || 'full');
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

async function onProviderChange() {
  const name = providerSel.value;
  await sendMessage({ type: 'SET_ACTIVE_PROVIDER', name });
  appendSystem(`Switched to provider: ${prettyProviderName(name)}`);
}

async function onContextModeChange() {
  const mode = [...ctxRadios].find((r) => r.checked)?.value || 'full';
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

  // User bubble
  appendUser(text || '(page only)');
  inputEl.value = '';
  sendBtn.disabled = true;

  // Placeholder assistant bubble
  const assistantEl = appendAssistant('▍');
  let acc = '';

  // Open streaming port
  const port = chrome.runtime.connect({ name: 'browsa-chat' });
  activeController = { port, cancelled: false };

  port.onMessage.addListener((m) => {
    if (m.type === 'CHUNK') {
      acc += m.delta;
      assistantEl.textContent = acc + ' ▍';
      scrollToBottom();
    } else if (m.type === 'DONE') {
      assistantEl.textContent = m.full || acc;
      scrollToBottom();
    }
  });
  port.onDisconnect.addListener(() => {
    sendBtn.disabled = false;
    activeController = null;
    if (acc === '') {
      // No chunks received — likely an error before streaming. Show hint.
      assistantEl.textContent = '(no response)';
    }
  });

  try {
    const mode = [...ctxRadios].find((r) => r.checked)?.value || 'full';
    const res = await sendMessage({
      type: 'CHAT',
      tabId: currentTabId,
      userText: text,
      attachPage: !!autoAttachEl.checked,
      contextMode: mode,
      stream: true
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
