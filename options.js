// options.js — provider configuration UI
import * as storage from './lib/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from './lib/storage.js';
import { ping, getCapabilities, ProviderConfigError, ProviderAPIError, ProviderNetworkError } from './lib/openai-client.js';

const $ = (id) => document.getElementById(id);
const providersEl = $('providers');
const statusEl = $('status');

let cachedCfg = null;
const _pingState = {}; // name → 'reachable' | 'unreachable', persists across re-renders

init();

async function init() {
  cachedCfg = await storage.getAll();
  renderProviders();
  applyContextMode(cachedCfg.contextMode || 'reader');
  applyLimits(cachedCfg);
  applyToolbarToggle();
  applySystemPrompt();

  document.querySelectorAll('input[name="ctx"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const mode = [...document.querySelectorAll('input[name="ctx"]')].find((x) => x.checked)?.value || 'reader';
      await storage.setContextMode(mode);
      flash('ok', `Default context mode: ${mode}`);
    });
  });

  // Save-limits button
  document.querySelector('button[data-act="save-limits"]')?.addEventListener('click', saveLimits);
}

function applyLimits(cfg) {
  const textEl = document.getElementById('maxTextChars');
  if (textEl) textEl.value = cfg.maxTextChars ?? 1_000_000;
}

async function saveLimits() {
  const textEl = document.getElementById('maxTextChars');
  const text = parseInt(textEl?.value, 10);
  if (!Number.isFinite(text) || text < 1000) {
    flash('err', 'Limit must be ≥ 1000 chars.');
    return;
  }
  cachedCfg.maxTextChars = text;
  await chrome.storage.local.set({ maxTextChars: text });
  flash('ok', `Saved: max text ${text.toLocaleString()} chars.`);
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
  const showModel = (cfg.type || 'llm') === 'llm'; // Agent providers (Hermes, Claude Code) don't expose Model ID

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
        <input data-k="apiKey" type="password" value="${escapeAttr(cfg.apiKey || '')}" placeholder="sk-..." />
      </label>
    </div>
    ${showModel ? `
    <div class="row">
      <label>Model ID
        <input data-k="model" type="text" value="${escapeAttr(cfg.model || '')}" placeholder="e.g. gpt-4o, qwen3.6-plus-anthropic" />
      </label>
    </div>` : ''}
    <div class="row action-row">
      <button data-act="save">Save</button>
      <button data-act="ping">Ping</button>
      <button data-act="reset">Reset</button>
      <span class="card-status"></span>
    </div>
  `;

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
    if (el.type === 'checkbox') out[k] = el.checked;
    else out[k] = el.value;
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
    // Auto-detect capabilities and update useResponsesApi accordingly
    const caps = await getCapabilities({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    if (caps?.features) {
      const hasResponses = !!(caps.features.responses_api);
      if (cachedCfg.providers[name].useResponsesApi !== hasResponses) {
        cachedCfg.providers[name].useResponsesApi = hasResponses;
        await chrome.storage.local.set({ providers: cachedCfg.providers });
        renderProviders(); // refresh cards to reflect new checkboxes
      }
      flashCard(card, 'ok', `✅ ${reply.slice(0, 60)} [responses:${hasResponses ? '✓' : '✗'}]`);
    } else {
      flashCard(card, 'ok', `✅ ${reply.slice(0, 80)}`);
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

function prettyProviderName(name) {
  const map = { hermes: 'Hermes', 'claude-code': 'Claude Code', compatible: 'OpenAI-compatible' };
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
