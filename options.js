// options.js — provider configuration UI
import * as storage from './lib/storage.js';
import { ping, ProviderConfigError, ProviderAPIError, ProviderNetworkError } from './lib/openai-client.js';

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

    card.innerHTML = `
      <h3>
        <span class="name">${escapeHtml(prettyProviderName(name))}</span>
        <label style="font-size:12px;font-weight:normal;">
          <input type="radio" name="active" value="${name}" ${name === cachedCfg.activeProvider ? 'checked' : ''} /> Active
        </label>
      </h3>
      <div class="row">
        <label>Base URL
          <input data-k="baseUrl" type="text" value="${escapeAttr(cfg.baseUrl)}" />
        </label>
        <label class="small">Default model
          <input data-k="defaultModel" type="text" value="${escapeAttr(cfg.defaultModel)}" />
        </label>
      </div>
      <div class="row">
        <label>API key
          <input data-k="apiKey" type="password" value="${escapeAttr(cfg.apiKey || '')}" placeholder="sk-..." />
        </label>
        <label style="min-width:auto;">
          <span style="visibility:hidden;">.</span>
          <span>
            <input data-k="stream" type="checkbox" ${cfg.stream ? 'checked' : ''} /> Stream responses
          </span>
        </label>
      </div>
      <div class="row">
        <button data-act="save">Save</button>
        <button data-act="ping">Ping</button>
        <button data-act="reset">Reset</button>
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

async function saveCard(name, card) {
  const data = readCard(card);
  cachedCfg.providers[name] = { ...cachedCfg.providers[name], ...data };
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  flash('ok', `Saved ${prettyProviderName(name)}.`);
}

async function pingCard(name, card) {
  // Save first so we ping the latest values
  await saveCard(name, card);
  const cfg = cachedCfg.providers[name];
  flash('', `Pinging ${prettyProviderName(name)}…`);
  try {
    const reply = await ping({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model || cfg.defaultModel });
    flash('ok', `✅ Ping ok. Reply: ${reply.slice(0, 120)}`);
  } catch (e) {
    const cls = e instanceof ProviderConfigError ? 'err' : 'err';
    flash(cls, `❌ ${e.name || 'Error'}: ${e.message}`);
  }
}

async function resetCard(name, card) {
  // Reset to the DEFAULTS in storage.js
  const fresh = await storage.getAll();
  cachedCfg.providers[name] = fresh.providers[name];
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  renderProviders();
  flash('ok', `Reset ${prettyProviderName(name)} to defaults.`);
}

function applyContextMode(mode) {
  for (const r of document.querySelectorAll('input[name="ctx"]')) r.checked = r.value === mode;
}

function prettyProviderName(name) {
  if (name === 'hermes') return 'Hermes';
  if (name === 'claude-code') return 'Claude Code';
  if (name === 'openclaw') return 'OpenClaw';
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
