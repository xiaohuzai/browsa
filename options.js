// options.js — provider configuration UI
import * as storage from './lib/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from './lib/storage.js';
import { ping, getCapabilities, ProviderConfigError, ProviderAPIError, ProviderNetworkError } from './lib/openai-client.js';

const $ = (id) => document.getElementById(id);
const providersEl = $('providers');
const statusEl = $('status');

let cachedCfg = null;

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
  for (const [name, cfg] of Object.entries(providers)) {
    const card = document.createElement('div');
    card.className = 'provider' + (name === cachedCfg.activeProvider ? ' active' : '');

    const isConfigured = !!(cfg.baseUrl?.trim());
    card.innerHTML = `
      <h3>
        <span class="name">${escapeHtml(prettyProviderName(name))}</span>
        <span class="provider-badge ${isConfigured ? 'configured' : 'unconfigured'}">${isConfigured ? '○ not pinged' : '○ not set'}</span>
        <label style="font-size:12px;font-weight:normal;">
          <input type="radio" name="active" value="${name}" ${name === cachedCfg.activeProvider ? 'checked' : ''} /> Active
        </label>
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
      <div class="options-grid">
        <label class="opt-check">
          <input data-k="stream" type="checkbox" ${cfg.stream ? 'checked' : ''} />
          <span>Stream responses</span>
        </label>
        <label class="opt-check">
          <input data-k="useResponsesApi" type="checkbox" ${cfg.useResponsesApi ? 'checked' : ''} />
          <span>Responses API<small>stateful, saves tokens</small></span>
        </label>
      </div>
      <div class="row action-row">
        <button data-act="save">Save</button>
        <button data-act="ping">Ping</button>
        <button data-act="reset">Reset</button>
        <span class="card-status"></span>
      </div>
    `;
    providersEl.appendChild(card);

    // Wire up
    card.querySelector('input[name="active"]').addEventListener('change', async (e) => {
      if (e.target.checked) {
        await storage.setActiveProvider(name);
        cachedCfg.activeProvider = name;
        renderProviders();
        flash('ok', `Active provider: ${prettyProviderName(name)}`);
      }
    });
    card.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('change', () => {/* input reflected in DOM, saved on Save */});
    });
    card.querySelector('button[data-act="save"]').addEventListener('click', () => saveCard(name, card));
    card.querySelector('button[data-act="ping"]').addEventListener('click', () => pingCard(name, card));
    card.querySelector('button[data-act="reset"]').addEventListener('click', () => resetCard(name, card));

  }
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
  flashCard(card, 'ok', '✓ Saved');
}

async function pingCard(name, card) {
  await saveCard(name, card);
  const cfg = cachedCfg.providers[name];
  flashCard(card, '', 'Pinging…');
  try {
    const reply = await ping({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
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
    setBadge(card, 'reachable');
  } catch (e) {
    flashCard(card, 'err', `❌ ${e.message}`);
    setBadge(card, 'unreachable');
  }
}

function setBadge(card, state) {
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
  if (name === 'hermes') return 'Hermes';
  if (name === 'claude-code') return 'Claude Code';
  return name;
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
