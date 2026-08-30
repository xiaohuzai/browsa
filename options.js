// options.js — provider configuration UI
import * as storage from './lib/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from './lib/storage.js';
import { ping, getCapabilities } from './lib/llm-client.js';
import { normalizeArkBaseUrl } from './lib/handlers/attach-asr.js';
import { ASR_PROVIDERS, getAsrProvider } from './lib/asr-providers.js';

const $ = (id) => document.getElementById(id);
const providersEl = $('providers');
const statusEl = $('status');

// Stroke-style SVG (matches sidepanel.js's ICONS.close) used instead of the
// "✕" emoji-range glyph so it renders identically across OS/font.
const ICON_CLOSE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

// Template for a freshly-added LLM provider card (user fills in url/key/
// model/alias and picks the protocol, then hits Save).
const BLANK_LLM = { type: 'llm', alias: '', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: false, apiStyle: 'chat', temperature: null, maxTokens: 0 };

let cachedCfg = null;
const _pingState = {}; // name → 'reachable' | 'unreachable', persists across re-renders

init();

async function init() {
  cachedCfg = await storage.getAll();
  Object.assign(_pingState, cachedCfg.pingStates || {});
  renderProviders();
  applyAsr(cachedCfg);
  applyToolbarToggle();
  applyLlmsTxt();
  applySystemPrompt();
  applyReplyLanguage();

  document.querySelector('button[data-act="save-asr"]')?.addEventListener('click', saveAsr);
  // 切换服务商：Base URL 为空时预填该家默认值，提示/占位符/文档链接随动。
  document.getElementById('asrProvider')?.addEventListener('change', () => {
    const sel = document.getElementById('asrProvider');
    const p = getAsrProvider(sel?.value);
    const baseEl = document.getElementById('asrBaseUrl');
    if (baseEl && !baseEl.value.trim()) baseEl.value = p.defaultBaseUrl;
    syncAsrProviderUI();
  });

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
  // 勾选框反映实际行为：从未设置（undefined）= 默认折叠 = 勾上；显式取消才展开。
  if (tac) tac.checked = cfg.thoughtAutoCollapse !== false;
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

// ASR 卡片的下拉选项、占位符、? 提示、文档链接全部由 lib/asr-providers.js 的
// 注册表驱动——接入新供应商时 UI 零改动（注册表加一项即可）。
function syncAsrProviderUI() {
  const sel = document.getElementById('asrProvider');
  if (!sel) return;
  if (!sel.options.length) {
    for (const p of Object.values(ASR_PROVIDERS)) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    }
  }
  const p = getAsrProvider(sel.value);
  const baseEl = document.getElementById('asrBaseUrl');
  if (baseEl) baseEl.placeholder = p.defaultBaseUrl;
  const keyEl = document.getElementById('asrApiKey');
  if (keyEl) keyEl.placeholder = p.apiKeyPlaceholder || 'API Key';
  const modelEl = document.getElementById('asrModel');
  if (modelEl) modelEl.placeholder = p.defaultModel;
  const videoModelEl = document.getElementById('asrVideoModel');
  if (videoModelEl) {
    // 注册表带 defaultVideoModel 的供应商（转写/视频拆成两个模型）给出推荐值；单模型则提示留空回退
    videoModelEl.placeholder = p.defaultVideoModel
      ? `${p.defaultVideoModel}（推荐）`
      : '留空 = 同转写模型';
  }
  const tip = document.getElementById('asrBaseUrlTip');
  if (tip) tip.innerHTML = p.baseUrlTip || '';
  const doc = document.getElementById('asrDocLink');
  if (doc) {
    doc.href = p.docUrl || '';
    doc.textContent = '📖 ' + (p.docLabel || '配置文档');
  }
}

function applyAsr(cfg) {
  const a = cfg.asr || {};
  const set = (id, v, placeholder) => { const el = document.getElementById(id); if (el) { if (v != null && v !== '') el.value = v; else el.value = ''; el.placeholder = placeholder || el.placeholder; } };
  const cb = document.getElementById('asrEnabled');
  if (cb) cb.checked = a.enabled !== false;
  // 已卸载的供应商（如移除的千问）：ASR 字段整体回落默认——残留的别家 baseUrl/
  // 模型 ID 若留在输入框里，用户随手 Save 就会把错配写回存储。applyAsr 不写存储，
  // 用户重新 Save 才落新值。
  const known = !!ASR_PROVIDERS[a.provider];
  const provSel = document.getElementById('asrProvider');
  if (provSel) {
    syncAsrProviderUI(); // 先填充选项，再回填已存值
    provSel.value = known ? (a.provider || 'ark') : 'ark';
  }
  set('asrApiKey', known ? a.apiKey : '');
  set('asrBaseUrl', known ? a.baseUrl : '');
  set('asrModel', known ? a.model : '');
  set('asrVideoModel', known ? a.videoModel : '');
  const langSel = document.getElementById('asrLanguage');
  if (langSel) {
    const v = a.language || 'auto';
    // 只选中列表里存在的选项；旧配置的未知语种（或空）回退到「自动检测」
    //（保存时才会写回存储，applyAsr 不修改存储）。
    if ([...langSel.options].some((o) => o.value === v)) langSel.value = v;
    else langSel.value = 'auto';
  }
  const ssSel = document.getElementById('asrSubtitleSource');
  if (ssSel) {
    const v = a.subtitleSource || 'original';
    if ([...ssSel.options].some((o) => o.value === v)) ssSel.value = v;
    else ssSel.value = 'original';
  }
}

async function saveAsr() {
  const enabled = !!document.getElementById('asrEnabled')?.checked;
  const provider = document.getElementById('asrProvider')?.value || 'ark';
  const p = getAsrProvider(provider);
  const apiKey = (document.getElementById('asrApiKey')?.value || '').trim();
  const baseUrl = (document.getElementById('asrBaseUrl')?.value || '').trim() || p.defaultBaseUrl;
  const model = (document.getElementById('asrModel')?.value || '').trim() || p.defaultModel;
  // 视频解析（视听精读）模型；留空回退注册表推荐值（defaultVideoModel），再不行才用
  // 转写模型（runVideoAnalysisPipeline 兜底）。
  const videoModel = (document.getElementById('asrVideoModel')?.value || '').trim() || p.defaultVideoModel || '';
  const language = document.getElementById('asrLanguage')?.value || 'auto';
  const subtitleSource = document.getElementById('asrSubtitleSource')?.value || 'original';
  if (enabled && !apiKey) {
    flash('err', '启用 ASR 需要填写 API Key。');
    return;
  }
  // 方舟 Agent Plan 专属端点（api/plan/v3）没有 Files API（上传 /files 会 404）。
  // 不硬拦截保存 —— 自动规整到标准版 api/v3 后正常保存（运行时 normalizeArkBaseUrl
  // 也会兜底），只给一个醒目提示。否则用户点 Save 会被 return 挡住，整个 asr 配置
  // （含 enabled）都存不进去，反而导致 ASR 静默不生效（2026-08-15 实机踩到）。
  // 仅方舟需要该规整；其他服务商的端点没有这个变体。
  let savedBaseUrl = baseUrl;
  if (provider === 'ark' && baseUrl.includes('/api/plan')) {
    savedBaseUrl = normalizeArkBaseUrl(baseUrl);
    flash('err', `已把 Base URL 从 Agent Plan 端点自动改为标准版 ${savedBaseUrl}（api/plan/v3 没有文件上传）。`);
  }
  cachedCfg.asr = { provider, enabled, apiKey, baseUrl: savedBaseUrl, model, videoModel, language, subtitleSource };
  await chrome.storage.local.set({ asr: cachedCfg.asr });
  flash('ok', `ASR ${enabled ? '已启用' : '已停用'}（${p.label}，模型 ${model}）。`);
}

function renderProviders() {
  providersEl.innerHTML = '';
  const providers = cachedCfg.providers || {};

  const groups = [
    { type: 'agent', label: '🤖 Agent Providers', desc: 'Full agent backend — tool execution, file access, multi-step tasks' },
    { type: 'llm',   label: '💬 LLM Providers',   desc: 'Language model endpoint — add as many as you like; each picks its own wire protocol' },
  ];

  for (const group of groups) {
    const entries = Object.entries(providers).filter(([, cfg]) => (cfg.type || 'llm') === group.type);
    const hasActive = entries.some(([name]) => name === cachedCfg.activeProvider);

    const details = document.createElement('details');
    details.className = 'provider-group';
    // Auto-expand the group that holds the active provider, any group that
    // has content, AND the LLM group itself — the LLM group is always open.
    if (hasActive || entries.length > 0 || group.type === 'llm') details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'provider-group-header';
    summary.innerHTML = `
      <span class="provider-group-title">${group.label}</span>
      <span class="provider-group-desc">${group.desc}</span>`;
    details.appendChild(summary);

    for (const [name, cfg] of entries) {
      details.appendChild(buildProviderCard(name, cfg));
    }

    if (group.type === 'llm') {
      // The reserved empty "LLM 1" slot only exists while there are NO LLM
      // providers at all (fresh install / every card deleted). It is
      // render-only — NOT persisted — so the sidebar dropdown never lists an
      // unconfigured "LLM 1 — not set". The moment any provider is committed,
      // the slot is consumed and never comes back on its own.
      if (entries.length === 0) {
        details.appendChild(buildProviderCard('llm-1', { ...BLANK_LLM }, { reserved: true }));
      }
      // "＋ Add Provider" is always available and is the ONLY way to create
      // new empty cards; they append BELOW the already-configured ones.
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'add-provider-btn';
      addBtn.textContent = '＋ Add Provider';
      addBtn.addEventListener('click', () => addProvider());
      details.appendChild(addBtn);
    }

    providersEl.appendChild(details);
  }
}

function buildProviderCard(name, cfg, opts = {}) {
  const reserved = !!opts.reserved; // render-only empty slot (not yet persisted)
  const card = document.createElement('div');
  card.className = 'provider' + (name === cachedCfg.activeProvider ? ' active' : '') + (reserved ? ' reserved' : '');
  card.dataset.name = name;

  const isConfigured = !!(cfg.baseUrl?.trim());
  const isAgent = (cfg.type || 'llm') === 'agent';
  const showModel = !isAgent; // Agent providers (Hermes) don't expose Model ID
  const displayName = prettyProviderName(name);

  // Restore ping state from memory
  const pinged = _pingState[name];
  const badgeCls  = pinged === 'reachable' ? 'reachable' : pinged === 'unreachable' ? 'unreachable' : (isConfigured ? 'configured' : 'unconfigured');
  const badgeTxt  = pinged === 'reachable' ? '● reachable' : pinged === 'unreachable' ? '● unreachable' : (isConfigured ? '○ not pinged' : '○ not set');

  card.innerHTML = `
    <h3 class="provider-h3" title="${reserved ? 'Reserved empty slot — configure and Save to commit it' : 'Click to set as active provider'}">
      <span class="name">${escapeHtml(displayName)}</span>
      <span class="provider-badge ${badgeCls}">${badgeTxt}</span>
      ${!isAgent && !reserved ? `<button type="button" class="provider-delete" data-act="delete" title="Remove this provider">${ICON_CLOSE}</button>` : ''}
    </h3>
    <div class="fields">
    ${!isAgent ? `
      <div class="field">
        <label>Alias
          <input data-k="alias" type="text" value="${escapeAttr(cfg.alias || '')}" placeholder="e.g. My OpenAI" />
        </label>
      </div>` : ''}
      <div class="field">
        <label>${isAgent ? `<span>Base URL<span class="tip" tabindex="0">?<span class="tip-bubble"><a href="https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server" target="_blank" rel="noopener noreferrer">Hermes API Server 启动与配置文档</a></span></span></span>` : 'Base URL'}
          <input data-k="baseUrl" type="text" value="${escapeAttr(cfg.baseUrl)}" placeholder="${isAgent ? 'http://127.0.0.1:8080' : ''}" />
        </label>
      </div>
      <div class="field">
        <label>API key
          <div class="apikey-wrap">
            <input data-k="apiKey" type="password" value="${escapeAttr(cfg.apiKey || '')}" placeholder="sk-..." />
            <button type="button" class="apikey-toggle" title="Show / hide key" aria-label="Toggle API key visibility">👁</button>
          </div>
        </label>
      </div>
      ${showModel ? `
      <div class="field">
        <label>Model ID
          <input data-k="model" type="text" value="${escapeAttr((cfg.models?.length ? cfg.models : (cfg.model ? [cfg.model] : [])).join(', '))}" placeholder="e.g. gpt-4o, gpt-4o-mini — comma separated" />
        </label>
      </div>` : ''}
      ${!isAgent ? `
      <div class="field field-full">
        <label>API
          <select data-k="apiStyle" class="api-style-select">
            ${['chat', 'responses', 'anthropic'].map(s => `
              <option value="${s}"${(cfg.apiStyle || 'chat') === s ? ' selected' : ''}>${apiStyleLabel(s)}</option>`).join('')}
          </select>
        </label>
      </div>` : ''}
    </div>
    <div class="row action-row">
      <button data-act="save">Save</button>
      <button data-act="ping">Ping</button>
      <button data-act="reset">Reset</button>
      <span class="card-status">${reserved ? 'Empty slot — configure and Save' : ''}</span>
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
  const delBtn = card.querySelector('button[data-act="delete"]');
  if (delBtn) delBtn.addEventListener('click', () => removeProvider(name));

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
      if (v === '') { out[k] = null; }
      else { const f = parseFloat(v); out[k] = isNaN(f) ? null : f; }
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
  const wasReserved = !cachedCfg.providers[name];
  // Merge the blank-LLM template as the base so a reserved (render-only,
  // not-yet-persisted) card keeps type/stream/isHermes/temperature/...
  // defaults on first Save; real providers just override their own values.
  cachedCfg.providers[name] = { ...BLANK_LLM, ...(cachedCfg.providers[name] || {}), ...data };
  // Model ID 支持逗号分隔多模型（一张网关卡配多家模型，主页下拉按 Alias · model 逐个
  // 选择）：models 存全量列表、model 存第一个——既有的 model 消费方（Ping、旧路径）
  // 语义不变。Agent 卡（Hermes）没有 model 字段，不做规范化。
  if ('model' in data) {
    const modelList = [...new Set(String(data.model || '').split(',').map((s) => s.trim()).filter(Boolean))];
    cachedCfg.providers[name].models = modelList;
    cachedCfg.providers[name].model = modelList[0] || '';
  }
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  delete _pingState[name]; // config changed — ping state no longer valid
  chrome.storage.local.get('pingStates', ({ pingStates }) => {
    const updated = { ...(pingStates || {}) };
    delete updated[name];
    chrome.storage.local.set({ pingStates: updated });
  });
  if (wasReserved) {
    // The reserved empty slot just became a real provider: re-render so it
    // loses the dashed "reserved" styling and gains its delete button.
    renderProviders();
    card = document.querySelector(`.provider[data-name="${name}"]`) || card;
  }
  flashCard(card, 'ok', '✓ Saved');
}

async function pingCard(name, card) {
  // "Configured" for the purposes of auto-switching the active provider
  // means reachable, not just "has some baseUrl filled in" — a baseUrl check
  // can never distinguish a provider you actually verified from one that's
  // merely filled in (or left at a default that doesn't point anywhere
  // useful). Capture the prior state before saveCard() below unconditionally
  // clears it.
  const wasReachable = _pingState[name] === 'reachable';

  await saveCard(name, card);
  // saveCard() re-renders when a reserved slot is committed — re-query so
  // the DOM ref below stays attached to a live card.
  card = document.querySelector(`.provider[data-name="${name}"]`) || card;
  const cfg = cachedCfg.providers[name];

  // Only LLM providers require a model ID
  if ((cfg.type || 'llm') === 'llm' && !cfg.model?.trim()) {
    flashCard(card, 'err', '❌ Model ID is required for LLM providers');
    return;
  }

  flashCard(card, '', 'Pinging…');
  try {
    const reply = await ping({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, apiStyle: cfg.apiStyle || 'chat' });

    // First time this provider goes from not-reachable to reachable, make
    // it the active one -- otherwise it's easy to ping-verify e.g.
    // OpenAI-compatible and forget the dropdown is still pointed at
    // whatever was active before. Re-pinging an already-reachable provider
    // (e.g. after tweaking temperature) does not re-trigger this, so it
    // won't clobber a deliberate switch between multiple reachable providers.
    let activeNote = '';
    if (!wasReachable && cachedCfg.activeProvider !== name) {
      cachedCfg.activeProvider = name;
      cachedCfg.activeModel = ''; // 首次 Ping 通自动切换：未指定具体模型，用卡上第一个
      await chrome.storage.local.set({ activeProvider: name, activeModel: '' });
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
  const cfg = cachedCfg.providers[name];
  if (!cfg) return;
  const fresh = await storage.getAll();
  const isAgent = (cfg.type || 'llm') === 'agent';
  // Hermes resets to its shipped blank default; every LLM card resets to a
  // blank template — a user-added card's "stored default" is just its own
  // current value, so restoring that would be a no-op.
  cachedCfg.providers[name] = isAgent ? fresh.providers[name] : { ...BLANK_LLM };
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  renderProviders();
}

// Add a brand-new (empty) LLM provider with a unique internal key. The user
// fills in url/key/model/alias and picks the protocol, then hits Save. The
// internal key is opaque (never shown); the Alias is what identifies the
// provider in the sidebar dropdown.
async function addProvider() {
  // Readable internal key: llm-1, llm-2, ... (skip any taken). On a fresh
  // install the reserved slot is llm-1, so the first Add materializes it as a
  // real card; later Adds append llm-2, llm-3, ... below existing providers.
  let n = 1;
  while (cachedCfg.providers[`llm-${n}`]) n++;
  const name = `llm-${n}`;
  cachedCfg.providers[name] = { ...BLANK_LLM };
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  renderProviders();
  // Auto-expand + focus the alias field of the newly added card so the user
  // can immediately type a name.
  const cards = document.querySelectorAll('.provider');
  const last = cards[cards.length - 1];
  if (last) {
    if (last.scrollIntoView) last.scrollIntoView({ block: 'center' });
    const alias = last.querySelector('[data-k="alias"]');
    if (alias) { alias.focus(); alias.select(); }
  }
}

// Remove an LLM provider. Agent providers (Hermes) are never removable. If
// the removed one was the active provider, fall back to hermes so there is
// always a valid active provider.
async function removeProvider(name) {
  const cfg = cachedCfg.providers[name];
  if (!cfg || (cfg.type || 'llm') === 'agent') return;
  delete cachedCfg.providers[name];
  delete _pingState[name];
  await chrome.storage.local.set({ providers: cachedCfg.providers });
  chrome.storage.local.get('pingStates', ({ pingStates }) => {
    const updated = { ...(pingStates || {}) };
    delete updated[name];
    chrome.storage.local.set({ pingStates: updated });
  });
  if (cachedCfg.activeProvider === name) {
    cachedCfg.activeProvider = 'hermes';
    cachedCfg.activeModel = '';
    await chrome.storage.local.set({ activeProvider: 'hermes', activeModel: '' });
  }
  renderProviders();
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
  // Prefer the user-set alias so multiple configured providers stay
  // distinguishable; fall back to a readable form of the internal key.
  const alias = cachedCfg?.providers?.[name]?.alias;
  if (alias && alias.trim()) return alias.trim();
  if (name === 'hermes') return 'Hermes Agent';
  const m = /^llm-(\d+)$/.exec(name);
  if (m) return `LLM ${m[1]}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function apiStyleLabel(style) {
  const map = {
    chat: 'Chat Completions (/v1/chat/completions)',
    responses: 'Responses API (/v1/responses)',
    anthropic: 'Anthropic Messages (/v1/messages)',
  };
  return map[style] || style;
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
