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
  Object.assign(_pingState, cachedCfg.pingStates || {});
  renderProviders();
  applyContextMode(cachedCfg.contextMode || 'auto');
  applyLimits(cachedCfg);
  applyToolbarToggle();
  applyLlmsTxt();
  applySystemPrompt();
  applyReplyLanguage();
  renderDomainRules(cachedCfg.domainRules || []);
  renderMaskRules(cachedCfg.maskRules || []);

  document.querySelectorAll('input[name="ctx"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const mode = [...document.querySelectorAll('input[name="ctx"]')].find((x) => x.checked)?.value || 'reader';
      await storage.setContextMode(mode);
      flash('ok', `Default context mode: ${mode}`);
    });
  });

  // Save-limits button
  document.querySelector('button[data-act="save-limits"]')?.addEventListener('click', saveLimits);

  // Domain rules
  document.querySelector('button[data-act="add-domain-rule"]')?.addEventListener('click', () => {
    const rules = readDomainRules();
    rules.push({ pattern: '', prompt: '' });
    renderDomainRules(rules);
  });
  document.querySelector('button[data-act="save-domain-rules"]')?.addEventListener('click', saveDomainRules);

  // Mask rules
  document.querySelector('button[data-act="add-mask-rule"]')?.addEventListener('click', () => {
    const rules = readMaskRules();
    rules.push({ pattern: '', flags: 'gi', replacement: '***' });
    renderMaskRules(rules);
  });
  document.querySelector('button[data-act="save-mask-rules"]')?.addEventListener('click', saveMaskRules);
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
    flash('ok', el.checked ? 'llms.txt enabled.' : 'llms.txt disabled.');
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

// ─── Domain Rules ─────────────────────────────────────────────────────────────

function renderDomainRules(rules) {
  const el = document.getElementById('domainRules');
  if (!el) return;
  el.innerHTML = '';
  if (!rules.length) {
    el.innerHTML = '<p class="hint" style="margin:0">No rules yet. Add one below.</p>';
    return;
  }
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const row = document.createElement('div');
    row.className = 'domain-rule-row';
    row.innerHTML = `
      <div class="domain-rule-fields">
        <label>URL pattern
          <input type="text" data-field="pattern" value="${escapeAttr(r.pattern || '')}" placeholder="e.g. github.com" />
        </label>
        <label>Extra system prompt
          <textarea data-field="prompt" rows="3" placeholder="e.g. Focus on code changes. Use English.">${escapeHtml(r.prompt || '')}</textarea>
        </label>
      </div>
      <button class="del-rule-btn" title="Remove this rule">✕</button>`;
    row.querySelector('.del-rule-btn').addEventListener('click', () => {
      const cur = readDomainRules();
      cur.splice(i, 1);
      renderDomainRules(cur);
    });
    el.appendChild(row);
  }
}

function readDomainRules() {
  const el = document.getElementById('domainRules');
  if (!el) return [];
  return [...el.querySelectorAll('.domain-rule-row')].map(row => ({
    pattern: row.querySelector('[data-field="pattern"]')?.value?.trim() || '',
    prompt: row.querySelector('[data-field="prompt"]')?.value?.trim() || ''
  })).filter(r => r.pattern);
}

async function saveDomainRules() {
  const rules = readDomainRules();
  cachedCfg.domainRules = rules;
  await chrome.storage.local.set({ domainRules: rules });
  flash('ok', `Domain rules saved (${rules.length} rule${rules.length !== 1 ? 's' : ''}).`);
}

// ─── Mask Rules ───────────────────────────────────────────────────────────────

function renderMaskRules(rules) {
  const el = document.getElementById('maskRules');
  if (!el) return;
  el.innerHTML = '';
  if (!rules.length) {
    el.innerHTML = '<tr><td colspan="4" class="hint" style="padding:8px">No rules yet.</td></tr>';
    return;
  }
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-field="pattern" value="${escapeAttr(r.pattern || '')}" placeholder="e.g. 1[3-9]\\d{9}" style="width:100%" /></td>
      <td><input type="text" data-field="flags" value="${escapeAttr(r.flags || 'gi')}" placeholder="gi" style="width:48px" /></td>
      <td><input type="text" data-field="replacement" value="${escapeAttr(r.replacement ?? '***')}" placeholder="***" style="width:80px" /></td>
      <td><button class="del-rule-btn" title="Remove">✕</button></td>`;
    tr.querySelector('.del-rule-btn').addEventListener('click', () => {
      const cur = readMaskRules();
      cur.splice(i, 1);
      renderMaskRules(cur);
    });
    el.appendChild(tr);
  }
}

function readMaskRules() {
  const el = document.getElementById('maskRules');
  if (!el) return [];
  return [...el.querySelectorAll('tr')].map(tr => ({
    pattern: tr.querySelector('[data-field="pattern"]')?.value?.trim() || '',
    flags: tr.querySelector('[data-field="flags"]')?.value?.trim() || 'gi',
    replacement: tr.querySelector('[data-field="replacement"]')?.value ?? '***'
  })).filter(r => r.pattern);
}

async function saveMaskRules() {
  const rules = readMaskRules();
  for (const r of rules) {
    try { new RegExp(r.pattern, r.flags); } catch (e) {
      flash('err', `Invalid regex "${r.pattern}": ${e.message}`);
      return;
    }
  }
  cachedCfg.maskRules = rules;
  await chrome.storage.local.set({ maskRules: rules });
  flash('ok', `Mask rules saved (${rules.length} rule${rules.length !== 1 ? 's' : ''}).`);
}
