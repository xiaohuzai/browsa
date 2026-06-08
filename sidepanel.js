// sidepanel.js — UI logic
// Talks to background.js via chrome.runtime messages. Streaming responses come back
// via a long-lived Port (chrome.runtime.connect) for low-latency chunk delivery.

import marked from './lib/vendor/marked.bundle.js';
import DOMPurify from './lib/vendor/purify.bundle.js';

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
const waitJsEl = $('waitjs');
const pagemetaEl = $('pagemeta');
const imagePreviewsEl = $('imagepreviews');
const imageInfoEl = $('imageinfo');
const imagePicker = $('imagepicker');

let currentTabId = null;
let activeController = null; // for cancelling in-flight stream
let lastPageMeta = null;
let navPort = null;             // long-lived port for SPA navigation pushes
const images = [];             // { dataUrl, name } — attached for this turn

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
  settingsBtn.addEventListener('click', openSettingsPage);
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      clearChatHistory();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      cycleContextMode();
    }
  });

  // Global shortcuts (Esc = cancel stream)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeController && !activeController.cancelled) {
      e.preventDefault();
      cancelStream();
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
    if (navPort) {
      try { navPort.postMessage({ type: 'NAV_FOLLOW', tabId }); } catch (_) {}
    }
  });
  chrome.tabs.onUpdated.addListener(async (tabId, _info, t) => {
    if (tabId === currentTabId) {
      pagemetaEl.textContent = t.title || t.url || '';
      pagemetaEl.href = t.url || '#';
      pagemetaEl.title = t.url || '';
    }
  });

  // Long-lived nav port. The background pushes NAVIGATED events for ANY
  // tab (it's a firehose). We filter to our current tab so SPAs like
  // 小红书 update the side panel's page-meta UI in real time when the
  // user clicks from one note to another. Without this, chrome.tabs.onUpdated
  // never fires (SPA pushState is invisible to it), and the side panel
  // would keep showing the title of the first note the user opened.
  navPort = chrome.runtime.connect({ name: 'browsa-nav' });
  navPort.postMessage({ type: 'NAV_HELLO', tabId: currentTabId });
  navPort.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'NAVIGATED') return;
    if (msg.tabId !== currentTabId) return; // firehose filter
    if (msg.closed) {
      pagemetaEl.textContent = '(tab closed)';
      pagemetaEl.href = '#';
      pagemetaEl.title = '';
      return;
    }
    if (msg.url) {
      pagemetaEl.href = msg.url;
      pagemetaEl.title = msg.url;
    }
    if (msg.title) {
      pagemetaEl.textContent = msg.title;
    } else if (msg.url) {
      // Title comes from webNavigation as empty; show the URL path so the
      // user at least sees something change.
      try {
        const u = new URL(msg.url);
        pagemetaEl.textContent = u.pathname + u.search;
      } catch (_) {
        pagemetaEl.textContent = msg.url;
      }
    }
  });
  navPort.onDisconnect.addListener(() => {
    navPort = null;
    console.log('browsa: nav port disconnected, will reconnect on next send');
  });

  // Listen for config changes (from options page)
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.providers || changes.activeProvider) {
      const cfg2 = await sendMessage({ type: 'GET_CONFIG' });
      populateProviderSelect(cfg2);
    }
  });

  // Image paste / drop / picker
  inputEl.addEventListener('paste', onPaste);
  const composer = document.querySelector('.composer');
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('dragover'); });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('dragover');
    handleDroppedFiles(e.dataTransfer.files);
  });
  imagePicker.addEventListener('change', () => {
    if (imagePicker.files) handleDroppedFiles(imagePicker.files);
    imagePicker.value = ''; // reset so re-pick works
  });

  refreshImageStrip();

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
  return name;
}

function applyContextMode(mode) {
  for (const r of ctxRadios) r.checked = r.value === mode;
}

/** Cycle: reader → full → selected → screenshot → reader */
function cycleContextMode() {
  const modes = ['reader', 'full', 'selected', 'screenshot'];
  const cur = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  const idx = modes.indexOf(cur);
  const next = modes[(idx + 1) % modes.length];
  applyContextMode(next);
  onContextModeChange(); // persist
}

async function clearChatHistory() {
  if (!currentTabId) return;
  await sendMessage({ type: 'CLEAR_HISTORY', tabId: currentTabId });
  messagesEl.innerHTML = '';
  appendSystem('🗑 History cleared');
}

function cancelStream() {
  if (!activeController) return;
  activeController.cancelled = true;
  if (activeController.port) {
    activeController.port.disconnect();
  }
  activeController = null;
  sendBtn.disabled = false;
  appendSystem('⚠ Stream cancelled');
}

let outputTokens = 0;
function updateOutputTokenCount(delta) {
  const cjk = (delta.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const ascii = delta.length - cjk;
  outputTokens += cjk + Math.ceil(ascii / 4);
  tokCountEl.textContent = `~${outputTokens}`;
}

function addCodeCopyButtons() {
  for (const pre of messagesEl.querySelectorAll('.msg.assistant pre')) {
    // Add language label (from code[class*="language-xxx"])
    const code = pre.querySelector('code[class*="language-"]');
    if (code && !pre.hasAttribute('data-lang')) {
      const cls = code.className.match(/language-(\w+)/);
      if (cls) pre.setAttribute('data-lang', cls[1]);
    }
    if (pre.querySelector('.code-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const text = code?.textContent || pre.textContent || '';
      try { await navigator.clipboard.writeText(text); btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); } catch {}
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}

// Markdown -> sanitized HTML pipeline. Returns HTML safe for innerHTML.
// Also renders math formulas ($...$ and $$...$$) into styled HTML.
function renderSafe(markdown) {
  try {
    let html = marked.parse(markdown || '');
    html = renderMath(html);
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel'],
      ADD_TAGS: ['math-inline', 'math-block'],
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

/** Render LaTeX math: $inline$ -> <math-inline>, $$block$$ -> <math-block> */
function renderMath(html) {
  const blocks = [];
  let out = html.replace(/\$\$([\s\S]*?)\$\$/g, (_, f) => {
    blocks.push(f.trim());
    return '%%MB' + (blocks.length - 1) + '%%';
  });
  out = out.replace(/\$([^$\n]+?)\$/g, (_, f) => {
    blocks.push(f.trim());
    return '%%MI' + (blocks.length - 1) + '%%';
  });
  out = out.replace(/%%MB(\d+)%%/g, (_, i) =>
    '<div class="math-block">' + escM(blocks[+i]) + '</div>');
  out = out.replace(/%%MI(\d+)%%/g, (_, i) =>
    '<math-inline>' + escM(blocks[+i]) + '</math-inline>');
  return out;
}

function escM(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

async function openSettingsPage() {
  // chrome.runtime.openOptionsPage() is unreliable when invoked from a side
  // panel context (Chromium 41294020). Workaround: ask the service worker
  // to open a new tab pointing at our options.html. The extension URL is
  // chrome.runtime.getURL('options.html').
  try {
    const url = chrome.runtime.getURL('options.html');
    await sendMessage({ type: 'OPEN_OPTIONS_TAB', url });
  } catch (e) {
    // Fallback: try the direct API
    try {
      chrome.runtime.openOptionsPage();
    } catch (e2) {
      appendError('Cannot open settings: ' + e2.message);
    }
  }
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

// --- Image attachment helpers ---

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleDroppedFiles(fileList) {
  const maxSize = 20 * 1024 * 1024; // 20 MB
  for (const f of fileList) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > maxSize) { appendError(`Image too large: ${f.name}`); continue; }
    const dataUrl = await fileToDataUrl(f);
    images.push({ dataUrl, name: f.name });
  }
  refreshImageStrip();
}

function removeImage(idx) {
  images.splice(idx, 1);
  refreshImageStrip();
}

function refreshImageStrip() {
  imagePreviewsEl.innerHTML = '';
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const div = document.createElement('div');
    div.className = 'imagepreview';
    div.innerHTML = `<img src="${img.dataUrl}" alt="${img.name}" /><button class="rm" data-idx="${i}" title="Remove image">&times;</button>`;
    div.querySelector('.rm').addEventListener('click', () => removeImage(i));
    imagePreviewsEl.appendChild(div);
  }
  imageInfoEl.textContent = images.length ? `+${images.length} image${images.length > 1 ? 's' : ''}` : '';
  updateComposerInfo();
}

async function onPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      imageItems.push(item.getAsFile());
    }
  }
  if (imageItems.length > 0) {
    e.preventDefault(); // don't paste file name text
    await handleDroppedFiles(imageItems);
  }
}

// --- </Image> ---

const SLASH_COMMANDS = {
  '/summarize':  'Summarize the page content in 3-5 bullet points. Be concise.',
  '/translate':  'Translate the page content to 中文 (Chinese).',
  '/rewrite':    'Rewrite the page content in a more concise and direct style. Keep all key facts.',
  '/explain':    'Explain the page content as if teaching a beginner. Use simple language.',
  '/outline':    'List the structure of the page as a nested outline (headings only).',
  '/keypoints':  'Extract the 5 most important takeaways from the page.',
};

function expandSlash(text) {
  if (!text.startsWith('/')) return null;
  const space = text.indexOf(' ');
  const cmd = space > 0 ? text.slice(0, space) : text;
  const rest = space > 0 ? text.slice(space + 1).trim() : '';
  const template = SLASH_COMMANDS[cmd];
  if (!template) return null; // unknown command, treat as normal text
  return rest ? `${template}\n\nAdditional instruction: ${rest}` : template;
}

async function onSend() {
  if (!currentTabId) {
    appendError('No active tab.');
    return;
  }
  const rawText = inputEl.value.trim();

  if (!rawText && autoAttachEl.checked) {
    // Even with empty text, if page is attached, we can still send.
  } else if (!rawText) {
    return;
  }

  // Slash commands: expand `/summarize` etc. into full prompts. The original
  // slash text is shown in the user bubble; the expanded prompt is what the
  // LLM receives. Unknown commands pass through as-is.
  const slashExpanded = expandSlash(rawText);
  const text = slashExpanded || rawText;

  // Re-read the active tab RIGHT before sending. This is the defense-in-depth
  // for SPA navigation: even if a webNavigation push was missed (background
  // service worker was sleeping, port was re-establishing, etc.), we still
  // have the right tab here. The user perceives a small extra delay
  // (<10ms in practice) but gains correctness.
  if (typeof currentTabId === 'number') {
    try {
      const live = await chrome.tabs.get(currentTabId);
      if (live) {
        pagemetaEl.textContent = live.title || live.url || '';
        pagemetaEl.href = live.url || '#';
        pagemetaEl.title = live.url || '';
        lastPageMeta = { url: live.url, title: live.title };
      }
    } catch (_) {
      // tab gone or permission denied — keep going with what we have
    }
  }

  // Auto-detect: if user has highlighted text on the page, prefer Selection
  // mode automatically. Otherwise respect the chosen context mode.
  let mode = [...ctxRadios].find((r) => r.checked)?.value || 'reader';
  try {
    const selRes = await sendMessage({ type: 'GET_PAGE_CONTEXT', mode: 'selected', targetTabId: currentTabId });
    const selText = (selRes?.text || '').trim();
    if (selText && selText.length >= 50) {
      // The user has selected substantial text on the page — use it.
      mode = 'selected';
    }
  } catch (_) {
    // ignore; fall back to chosen mode
  }

  // User bubble — show the original slash command, not the expanded prompt
  appendUser(rawText || '(page only)');
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
        updateOutputTokenCount(m.delta);
      } else if (m.type === 'DONE') {
        renderStream(m.full || acc, true);
        addCodeCopyButtons();
        outputTokens = 0;
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
    const imageDataUrls = images.length > 0 ? images.map(i => i.dataUrl) : null;
    // Clear thumbnails immediately — the LLM may take seconds to respond
    images.length = 0;
    refreshImageStrip();

    const res = await sendMessage({
      type: 'CHAT',
      tabId: currentTabId,
      userText: text,
      attachPage: !!autoAttachEl.checked,
      contextMode: mode,
      stream: true,
      portName: 'browsa-chat',
      images: imageDataUrls,
      waitMs: waitJsEl.checked ? 2000 : 0
    });
    if (!res.ok) {
      appendError(`${res.code || 'Error'}: ${res.error}`);
      if (res.hint) appendSystem(res.hint);
      assistantEl.remove();
    } else if (res.data?.pageContext?.limitHint) {
      appendSystem(res.data.pageContext.limitHint);
    } else if (res.data?.pageContext?.truncated?.textLength) {
      const t = res.data.pageContext.truncated;
      if (t.rawHtmlLength > t.textLength) {
        appendSystem(
          `ℹ Page truncated: sent ${t.textLength.toLocaleString()} of ${t.rawHtmlLength.toLocaleString()} chars ` +
          `(limit ${t.textCap.toLocaleString()}). Raise limits in ⚙ Settings if you need more.`
        );
      }
    }
    // Detect empty extraction (JS-rendered pages like 小红书)
    if (res.data?.pageContext?.text != null && res.data.pageContext.text.length < 50) {
      appendSystem('⚠ Page content is empty or very short. This site may render content outside the DOM (Shadow DOM / Canvas). Try switching to 📸 Screenshot mode and sending the screenshot to a multimodal LLM.');
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
