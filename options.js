// options.js — provider configuration UI
import * as storage from './lib/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from './lib/storage.js';
import { ping, getCapabilities } from './lib/openai-client.js';
import { normalizeArkBaseUrl } from './lib/handlers/attach-asr.js';

const $ = (id) => document.getElementById(id);
const providersEl = $('providers');
const statusEl = $('status');

// Stroke-style SVG (matches sidepanel.js's ICONS.close) used instead of the
// "✕" emoji-range glyph so it renders identically across OS/font.
const ICON_CLOSE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

let cachedCfg = null;
const _pingState = {}; // name → 'reachable' | 'unreachable', persists across re-renders

init();

async function init() {
  cachedCfg = await storage.getAll();
  Object.assign(_pingState, cachedCfg.pingStates || {});
  renderProviders();
  applyContextMode(cachedCfg.contextMode || 'auto');
  applyLimits(cachedCfg);
  applyAsr(cachedCfg);
  applyToolbarToggle();
  applyLlmsTxt();
  applySystemPrompt();
  applyReplyLanguage();

  document.querySelectorAll('input[name="ctx"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const mode = [...document.querySelectorAll('input[name="ctx"]')].find((x) => x.checked)?.value || 'reader';
      await storage.setContextMode(mode);
      flash('ok', `Default context mode: ${mode}`);
    });
  });

  // Save-limits button
  document.querySelector('button[data-act="save-limits"]')?.addEventListener('click', saveLimits);
  document.querySelector('button[data-act="save-asr"]')?.addEventListener('click', saveAsr);

  // Chat preferences
  applyChatPrefs(cachedCfg);
  document.querySelector('button[data-act="save-chat-prefs"]')?.addEventListener('click', saveChatPrefs);
  const fontSizeEl = $('fontSize');
  const fontSizeVal = $('fontSizeVal');
  if (fontSizeEl && fontSizeVal) {
    fontSizeEl.addEventListener('input', () => { fontSizeVal.textContent = fontSizeEl.value + 'px'; });
  }
}

function applyChatPrefs(cfg) {
  const fs = $('fontSize');
  const fsv = $('fontSizeVal');
  const val = cfg.fontSize ?? 13.5;
  if (fs) fs.value = val;
  if (fsv) fsv.textContent = val + 'px';
  const ss = $('sendShortcut');
  if (ss) ss.value = cfg.sendShortcut || 'enter';
  const tac = $('thoughtAutoCollapse');
  if (tac) tac.checked = !!(cfg.thoughtAutoCollapse);
}

async function saveChatPrefs() {
  const fs = parseFloat($('fontSize')?.value || '13.5');
  const ss = $('sendShortcut')?.value || 'enter';
  const tac = !!$('thoughtAutoCollapse')?.checked;
  await chrome.storage.local.set({ fontSize: fs, sendShortcut: ss, thoughtAutoCollapse: tac });
  cachedCfg.fontSize = fs;
  cachedCfg.sendShortcut = ss;
  cachedCfg.thoughtAutoCollapse = tac;
  const statusEl = $('chat-prefs-status');
  if (statusEl) {
    statusEl.className = 'card-status ok';
    statusEl.textContent = '✓ Saved';
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'card-status'; }, 3000);
  }
}

function applyLimits(cfg) {
  const textEl = document.getElementById('maxTextChars');
  if (textEl) textEl.value = cfg.maxTextChars ?? 1_000_000;
  const autoSumEl = document.getElementById('autoSummarizeAttachments');
  if (autoSumEl) autoSumEl.checked = cfg.autoSummarizeAttachments !== false;
  const thresholdEl = document.getElementById('summarizeThresholdChars');
  if (thresholdEl) thresholdEl.value = cfg.summarizeThresholdChars ?? 0;
}

async function saveLimits() {
  const textEl = document.getElementById('maxTextChars');
  const text = parseInt(textEl?.value, 10);
  if (!Number.isFinite(text) || text < 1000) {
    flash('err', 'Limit must be ≥ 1000 chars.');
    return;
  }
  const thresholdEl = document.getElementById('summarizeThresholdChars');
  const threshold = parseInt(thresholdEl?.value, 10);
  if (!Number.isFinite(threshold) || threshold < 0) {
    flash('err', 'Summarize threshold must be ≥ 0 chars.');
    return;
  }
  const autoSumEl = document.getElementById('autoSummarizeAttachments');
  const autoSummarize = !!autoSumEl?.checked;
  cachedCfg.maxTextChars = text;
  cachedCfg.autoSummarizeAttachments = autoSummarize;
  cachedCfg.summarizeThresholdChars = threshold;
  await chrome.storage.local.set({
    maxTextChars: text,
    autoSummarizeAttachments: autoSummarize,
    summarizeThresholdChars: threshold
  });
  flash('ok', `Saved: max text ${text.toLocaleString()} chars, auto-summarize ${autoSummarize ? 'on' : 'off'}.`);
}

function applyAsr(cfg) {
  const a = cfg.asr || {};
  const set = (id, v, placeholder) => { const el = document.getElementById(id); if (el) { if (v != null && v !== '') el.value = v; else el.value = ''; el.placeholder = placeholder || el.placeholder; } };
  const cb = document.getElementById('asrEnabled');
  if (cb) cb.checked = a.enabled !== false;
  set('asrApiKey', a.apiKey);
  set('asrBaseUrl', a.baseUrl);
  set('asrModel', a.model);
  set('asrLanguage', a.language);
}

async function saveAsr() {
  const enabled = !!document.getElementById('asrEnabled')?.checked;
  const apiKey = (document.getElementById('asrApiKey')?.value || '').trim();
  const baseUrl = (document.getElementById('asrBaseUrl')?.value || '').trim() || 'https://ark.cn-beijing.volces.com/api/v3';
  const model = (document.getElementById('asrModel')?.value || '').trim() || 'doubao-seed-2-0-lite-260428';
  const language = (document.getElementById('asrLanguage')?.value || '').trim() || 'zh';
  if (enabled && !apiKey) {
    flash('err', '启用 ASR 需要填写 API Key。');
    return;
  }
  // Agent Plan 专属端点（api/plan/v3）没有 Files API（上传 /files 会 404）。
  // 不硬拦截保存 —— 自动规整到标准版 api/v3 后正常保存（运行时 normalizeArkBaseUrl
  // 也会兜底），只给一个醒目提示。否则用户点 Save 会被 return 挡住，整个 asr 配置
  // （含 enabled）都存不进去，反而导致 ASR 静默不生效（2026-08-15 实机踩到）。
  let savedBaseUrl = baseUrl;
  if (baseUrl.includes('/api/plan')) {
    savedBaseUrl = normalizeArkBaseUrl(baseUrl);
    flash('err', `已把 Base URL 从 Agent Plan 端点自动改为标准版 ${savedBaseUrl}（api/plan/v3 没有文件上传）。`);
  }
  cachedCfg.asr = { enabled, apiKey, baseUrl: savedBaseUrl, model, language };
  await chrome.storage.local.set({ asr: cachedCfg.asr });
  flash('ok', `ASR ${enabled ? '已启用' : '已停用'}${enabled ? '（模型 ' + model + '）' : ''}。`);
}

function renderProviders() {
  providersEl.innerHTML = '';
  const providers = cachedCfg.providers || {};

  const groups = [
    { type: 'agent', label: '🤖 Agent Providers', desc: 'Full agent backend — tool execution, file access, multi-step tasks' },
    { type: 'llm',   label: '💬 LLM Providers',   desc: 'Language model endpoint — conversation only' },
  ];

  for (const group of groups) {
    const entries = Object.entries(providers).filter(([, cfg]) => (cfg.type || 'llm') === group.type);
    const hasActive = entries.some(([name]) => name === cachedCfg.activeProvider);

    const details = document.createElement('details');
    details.className = 'provider-group';
    if (hasActive) details.open = true; // auto-expand the group with the active provider

    const summary = document.createElement('summary');
    summary.className = 'provider-group-header';
    summary.innerHTML = `
      <span class="provider-group-title">${group.label}</span>
      <span class="provider-group-desc">${group.desc}</span>`;
    details.appendChild(summary);

    for (const [name, cfg] of entries) {
      details.appendChild(buildProviderCard(name, cfg));
    }

    providersEl.appendChild(details);
  }
}

function buildProviderCard(name, cfg) {
  const card = document.createElement('div');
  card.className = 'provider' + (name === cachedCfg.activeProvider ? ' active' : '');

  const isConfigured = !!(cfg.baseUrl?.trim());
  const showModel = (cfg.type || 'llm') === 'llm'; // Agent providers (Hermes) don't expose Model ID

  // Restore ping state from memory
  const pinged = _pingState[name];
  const badgeCls  = pinged === 'reachable' ? 'reachable' : pinged === 'unreachable' ? 'unreachable' : (isConfigured ? 'configured' : 'unconfigured');
  const badgeTxt  = pinged === 'reachable' ? '● reachable' : pinged === 'unreachable' ? '● unreachable' : (isConfigured ? '○ not pinged' : '○ not set');

  card.innerHTML = `
    <h3 class="provider-h3" title="Click to set as active provider">
      <span class="name">${escapeHtml(prettyProviderName(name))}</span>
      <span class="provider-badge ${badgeCls}">${badgeTxt}</span>
    </h3>
    <div class="row">
      <label>Base URL
        <input data-k="baseUrl" type="text" value="${escapeAttr(cfg.baseUrl)}" />
      </label>
    </div>
    <div class="row">
      <label>API key
        <div class="apikey-wrap">
          <input data-k="apiKey" type="password" value="${escapeAttr(cfg.apiKey || '')}" placeholder="sk-..." />
          <button type="button" class="apikey-toggle" title="Show / hide key" aria-label="Toggle API key visibility">👁</button>
        </div>
      </label>
    </div>
    ${showModel ? `
    <div class="row">
      <label>Model ID
        <input data-k="model" type="text" value="${escapeAttr(cfg.model || '')}" placeholder="e.g. gpt-4o, qwen3.6-plus-anthropic" />
      </label>
    </div>` : ''}
    <div class="row provider-params-row">
      <label class="provider-param-label">Temperature
        <input data-k="temperature" type="number" min="0" max="2" step="0.1"
               value="${escapeAttr(cfg.temperature != null ? String(cfg.temperature) : '')}"
               placeholder="default" style="width:72px" />
      </label>
      <label class="provider-param-label">Max tokens
        <input data-k="maxTokens" type="number" min="0" step="256"
               value="${escapeAttr(cfg.maxTokens ? String(cfg.maxTokens) : '')}"
               placeholder="unlimited" style="width:96px" />
      </label>
    </div>
    <div class="row action-row">
      <button data-act="save">Save</button>
      <button data-act="ping">Ping</button>
      <button data-act="reset">Reset</button>
      <span class="card-status"></span>
    </div>
  `;

  // API key show/hide toggle
  const apiToggle = card.querySelector('.apikey-toggle');
  const apiInput  = card.querySelector('[data-k="apiKey"]');
  if (apiToggle && apiInput) {
    apiToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = apiInput.type === 'password';
      apiInput.type = show ? 'text' : 'password';
      apiToggle.textContent = show ? '🙈' : '👁';
    });
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('input, button, select, textarea')) return;
    document.querySelectorAll('.provider').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
  });
  card.querySelector('button[data-act="save"]').addEventListener('click', () => saveCard(name, card));
  card.querySelector('button[data-act="ping"]').addEventListener('click', () => pingCard(name, card));
  card.querySelector('button[data-act="reset"]').addEventListener('click', () => resetCard(name, card));

  return card;
}

function readCard(card) {
  const out = {};
  card.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') {
      out[k] = el.checked;
    } else if (el.type === 'number') {
      const v = el.value.trim();
      if (k === 'temperature') {
        if (v === '') { out[k] = null; }
        else { const f = parseFloat(v); out[k] = isNaN(f) ? null : Math.min(2, Math.max(0, f)); }
      } else if (k === 'maxTokens') {
        if (v === '') { out[k] = 0; }
        else { const n = parseInt(v, 10); out[k] = (!isNaN(n) && n > 0) ? n : 0; }
      } else {
        out[k] = v === '' ? null : (isNaN(parseFloat(v)) ? null : parseFloat(v));
      }
    } else {
      out[k] = el.value;
    }
  });
  return out;
}

function flashCard(card, cls, text) {
  const el = card.querySelector('.card-status');
  if (!el) return;
  el.className = 'card-status ' + cls;
  el.textContent = text;
  clearTimeout(el._timer);
  if (cls === 'ok') el._timer = setTimeout(() => { el.textContent = ''; el.className = 'card-status'; }, 4000);
}

async function saveCard(name, card) {
  const data = readCard(card);
  cachedCfg.providers[name] = { ...cachedCfg.providers[name], ...data };
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  delete _pingState[name]; // config changed — ping state no longer valid
  chrome.storage.local.get('pingStates', ({ pingStates }) => {
    const updated = { ...(pingStates || {}) };
    delete updated[name];
    chrome.storage.local.set({ pingStates: updated });
  });
  flashCard(card, 'ok', '✓ Saved');
}

async function pingCard(name, card) {
  // "Configured" for the purposes of auto-switching the active provider
  // means reachable, not just "has some baseUrl filled in" (Hermes ships
  // with a non-empty default baseUrl, so a naive baseUrl check would never
  // let you notice you'd forgotten to switch away from it). Capture the
  // prior state before saveCard() below unconditionally clears it.
  const wasReachable = _pingState[name] === 'reachable';

  await saveCard(name, card);
  const cfg = cachedCfg.providers[name];

  // Only LLM providers require a model ID
  if ((cfg.type || 'llm') === 'llm' && !cfg.model?.trim()) {
    flashCard(card, 'err', '❌ Model ID is required for LLM providers');
    return;
  }

  flashCard(card, '', 'Pinging…');
  try {
    const reply = await ping({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });

    // First time this provider goes from not-reachable to reachable, make
    // it the active one -- otherwise it's easy to ping-verify e.g.
    // OpenAI-compatible and forget the dropdown is still pointed at
    // whatever was active before. Re-pinging an already-reachable provider
    // (e.g. after tweaking temperature) does not re-trigger this, so it
    // won't clobber a deliberate switch between multiple reachable providers.
    let activeNote = '';
    if (!wasReachable && cachedCfg.activeProvider !== name) {
      cachedCfg.activeProvider = name;
      await chrome.storage.local.set({ activeProvider: name });
      document.querySelectorAll('.provider').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      activeNote = ' — set as active provider';
    }

    // Auto-detect capabilities and update isHermes accordingly. isHermes
    // gates the Hermes-only /v1/runs API (approval, clarification, tool
    // events) — so it should reflect run support, not the generic
    // OpenAI-spec /v1/responses feature.
    const caps = await getCapabilities({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    if (caps?.features) {
      const hasRuns = !!(caps.features.run_submission && caps.features.run_events_sse);
      if (cachedCfg.providers[name].isHermes !== hasRuns) {
        cachedCfg.providers[name].isHermes = hasRuns;
        await chrome.storage.local.set({ providers: cachedCfg.providers });
      }
      flashCard(card, 'ok', `✅ ${reply.slice(0, 60)} [runs:${hasRuns ? '✓' : '✗'}]${activeNote}`);
    } else {
      flashCard(card, 'ok', `✅ ${reply.slice(0, 80)}${activeNote}`);
    }
    setBadge(card, 'reachable', name);
  } catch (e) {
    flashCard(card, 'err', `❌ ${e.message}`);
    setBadge(card, 'unreachable', name);
  }
}

function setBadge(card, state, name) {
  if (name) {
    _pingState[name] = state;
    // Persist to storage so the sidebar dropdown can reflect ping state
    chrome.storage.local.get('pingStates', ({ pingStates }) => {
      const updated = { ...(pingStates || {}), [name]: state };
      chrome.storage.local.set({ pingStates: updated });
    });
  }
  const badge = card.querySelector('.provider-badge');
  if (!badge) return;
  if (state === 'reachable') {
    badge.className = 'provider-badge reachable';
    badge.textContent = '● reachable';
  } else {
    badge.className = 'provider-badge unreachable';
    badge.textContent = '● unreachable';
  }
}

async function resetCard(name, card) {
  const fresh = await storage.getAll();
  cachedCfg.providers[name] = fresh.providers[name];
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  renderProviders();
}


function applyContextMode(mode) {
  for (const r of document.querySelectorAll('input[name="ctx"]')) r.checked = r.value === mode;
}

function applySystemPrompt() {
  const el = $('systemPrompt');
  if (!el) return;
  el.value = cachedCfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT ?? '';
  document.querySelector('button[data-act="save-system-prompt"]')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ systemPrompt: el.value });
    flash('ok', 'System prompt saved.');
  });
  document.querySelector('button[data-act="reset-system-prompt"]')?.addEventListener('click', async () => {
    el.value = DEFAULT_SYSTEM_PROMPT;
    await chrome.storage.local.set({ systemPrompt: DEFAULT_SYSTEM_PROMPT });
    flash('ok', 'System prompt reset to default.');
  });
}

function applyReplyLanguage() {
  const el = $('replyLanguage');
  if (!el) return;
  el.value = cachedCfg.replyLanguage || '';
  document.querySelector('button[data-act="save-reply-language"]')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ replyLanguage: el.value });
    flash('ok', el.value ? `Reply language set to "${el.options[el.selectedIndex]?.text}".` : 'Reply language: Auto.');
  });
}

function applyToolbarToggle() {
  const el = $('showSelectionToolbar');
  if (!el) return;
  chrome.storage.local.get('showSelectionToolbar', ({ showSelectionToolbar }) => {
    el.checked = showSelectionToolbar !== false; // default on
  });
  el.addEventListener('change', () => {
    chrome.storage.local.set({ showSelectionToolbar: el.checked });
    flash('ok', el.checked ? 'Floating toolbar enabled.' : 'Floating toolbar disabled.');
  });
}

function applyLlmsTxt() {
  const el = $('llmsTxtEnabled');
  if (!el) return;
  chrome.storage.local.get('llmsTxtEnabled', ({ llmsTxtEnabled }) => {
    el.checked = llmsTxtEnabled !== false; // default true
  });
  el.addEventListener('change', () => {
    chrome.storage.local.set({ llmsTxtEnabled: el.checked });
    flash('ok', el.checked ? 'llms.txt will be included when attaching a page.' : 'llms.txt disabled.');
  });
}

function prettyProviderName(name) {
  const map = { hermes: 'Hermes', compatible: 'OpenAI-compatible' };
  return map[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function flash(cls, text) {
  statusEl.className = 'status ' + cls;
  statusEl.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
