// options.js — provider configuration UI
import * as storage from './lib/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from './lib/storage.js';
import { ping, getCapabilities } from './lib/llm-client.js';
import { pingOpencode } from './lib/opencode-client.js';
import { pingBridge, normalizeBridgeUrl } from './lib/bridge-client.js';
import { normalizeArkBaseUrl } from './lib/handlers/attach-asr.js';
import { ASR_PROVIDERS, getAsrProvider } from './lib/asr-providers.js';
import { providerModelList, resolveBridgeApiKey } from './lib/handlers/provider-resolver.js';
import { BRIDGE_CARD_LABEL } from './lib/provider-display.js';
import { applyI18n, initI18n, watchUiLang, currentUiLang, t, tSub } from './lib/i18n.js';

const $ = (id) => document.getElementById(id);
// i18n convenience — same idiom as sidepanel.js: t() resolves explicit-language
// dict → chrome.i18n → inline fallback (jsdom tests stay chrome-free).
const _t = t;
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
  // 语言偏好就绪后先填静态文案，再渲染动态区块（渲染函数里的文案同样走 t()）。
  await initI18n();
  document.documentElement.lang = currentUiLang() === 'zh' ? 'zh' : 'en';
  applyI18n();

  // UI Language 下拉：选择即生效（写 storage），watchUiLang 统一重渲染。
  const uiLangSel = $('uiLang');
  if (uiLangSel) {
    chrome.storage.local.get('uiLang', ({ uiLang }) => { uiLangSel.value = uiLang || 'auto'; });
    uiLangSel.addEventListener('change', () => {
      chrome.storage.local.set({ uiLang: uiLangSel.value });
    });
  }
  watchUiLang(() => {
    document.documentElement.lang = currentUiLang() === 'zh' ? 'zh' : 'en';
    applyI18n();
    syncGuideLink();
    renderProviders();
    syncAsrProviderUI();
  });
  syncGuideLink();

  cachedCfg = await storage.getAll();
  Object.assign(_pingState, cachedCfg.pingStates || {});
  renderProviders();
  applyAsr(cachedCfg);
  applyToolbarToggle();
  applyLlmsTxt();
  applyDeepExtract();
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

// 使用指南链接随 UI 语言走：中文站 /guide/，英文站 /en/guide/。HTML 里已带
// 中文站地址兜底（JS 未跑/字典未载时也可点），这里只做语言同步。
function syncGuideLink() {
  const a = document.getElementById('guideLink');
  if (a) a.href = currentUiLang() === 'en'
    ? 'https://xiaohuzai.github.io/browsa/en/guide/'
    : 'https://xiaohuzai.github.io/browsa/guide/';
}

function applyChatPrefs(cfg) {  const fs = $('fontSize');
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
    statusEl.textContent = _t('savedFlash', '✓ Saved');
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
      o.textContent = _t(`asrLabel_${p.id}`, p.label); // 字典按 provider id 覆盖，注册表原文兜底
      sel.appendChild(o);
    }
  }
  const p = getAsrProvider(sel.value);
  const baseEl = document.getElementById('asrBaseUrl');
  if (baseEl) baseEl.placeholder = p.defaultBaseUrl;
  const keyEl = document.getElementById('asrApiKey');
  if (keyEl) keyEl.placeholder = _t(`asrApiKeyPlaceholder_${p.id}`, p.apiKeyPlaceholder || 'API Key');
  const modelEl = document.getElementById('asrModel');
  if (modelEl) modelEl.placeholder = p.defaultModel;
  const videoModelEl = document.getElementById('asrVideoModel');
  if (videoModelEl) {
    // 注册表带 defaultVideoModel 的供应商（转写/视频拆成两个模型）给出推荐值；单模型则提示留空回退
    videoModelEl.placeholder = p.defaultVideoModel
      ? `${p.defaultVideoModel}${_t('videoModelRecommended', '（推荐）')}`
      : _t('asrVideoModelPlaceholder', '留空 = 同转写模型');
  }
  const tip = document.getElementById('asrBaseUrlTip');
  if (tip) {
    // 文档链接并进气泡：? 气泡现在可驻留（hover 进去点链接不消失），读提示时
    // 就能直接跳文档，不必找到卡片底部那个常驻入口（两处都保留）。
    const docLabel = _t(`asrDocLabel_${p.id}`, p.docLabel || _t('asrDocLabelDefault', '配置文档'));
    tip.innerHTML = _t(`asrBaseUrlTip_${p.id}`, p.baseUrlTip || '') +
      (p.docUrl ? `<br><a href="${p.docUrl}" target="_blank" rel="noopener noreferrer">📖 ${docLabel}</a>` : '');
  }
  const doc = document.getElementById('asrDocLink');
  if (doc) {
    doc.href = p.docUrl || '';
    doc.textContent = '📖 ' + _t(`asrDocLabel_${p.id}`, p.docLabel || _t('asrDocLabelDefault', '配置文档'));
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
    flash('err', _t('asrNeedApiKey', '启用 ASR 需要填写 API Key。'));
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
    flash('err', tSub('asrPlanUrlRewritten', `已把 Base URL 从 Agent Plan 端点自动改为标准版 $1（api/plan/v3 没有文件上传）。`, savedBaseUrl));
  }
  cachedCfg.asr = { provider, enabled, apiKey, baseUrl: savedBaseUrl, model, videoModel, language, subtitleSource };
  await chrome.storage.local.set({ asr: cachedCfg.asr });
  flash('ok', tSub('asrSaveOk', `ASR $1（$2，模型 $3）。`, enabled ? _t('asrOn', '已启用') : _t('asrOff', '已停用'), p.label, model));
}

function renderProviders() {
  providersEl.innerHTML = '';
  const providers = cachedCfg.providers || {};

  const groups = [
    { type: 'agent', label: _t('agentGroupLabel', '🤖 Agent Providers'), desc: _t('agentGroupDesc', 'Full agent backend — tool execution, file access, multi-step tasks') },
    { type: 'llm',   label: _t('llmGroupLabel', '💬 LLM Providers'),   desc: _t('llmGroupDesc', 'Language model endpoint — add as many as you like; each picks its own wire protocol') },
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
      addBtn.textContent = _t('addProviderBtn', '＋ Add Provider');
      addBtn.addEventListener('click', () => addProvider());
      details.appendChild(addBtn);
    }

    providersEl.appendChild(details);
  }
}

// One bridge endpoint row: URL + alias + its own API key (a bridge can require
// its own token — loopback bridges usually need none) + remove. Shared
// verbatim by the card render and the ＋ button (addBridgeRow) so the two
// never drift. Two lines per row because the options page is 660px wide —
// three inputs on one line would squeeze every field below legibility.
function bridgeRowHtml(url, alias, apiKey) {
  return `
    <div class="bridge-row">
      <div class="bridge-row-main">
        <input data-bridge-url type="text" value="${escapeAttr(url)}" placeholder="http://127.0.0.1:3948" />
        <button type="button" class="bridge-row-x" data-act="bridge-remove" title="${_t('bridgeRemoveTitle', '移除此地址')}" aria-label="${_t('bridgeRemoveTitle', '移除此地址')}">${ICON_CLOSE}</button>
      </div>
      <div class="bridge-row-sub">
        <input data-bridge-alias type="text" value="${escapeAttr(alias)}" placeholder="${_t('bridgeAliasPlaceholder', '别名（留空，Ping 后自动发现）')}" />
        <div class="apikey-wrap">
          <input data-bridge-key type="password" value="${escapeAttr(apiKey)}" placeholder="${_t('bridgeKeyPlaceholder', 'API Key（可选）')}" autocomplete="off" />
          <button type="button" class="bridge-key-eye" data-act="bridge-key-eye" title="${_t('apiKeyToggleTitle', 'Show / hide key')}" aria-label="${_t('apiKeyToggleAria', 'Toggle API key visibility')}">👁</button>
        </div>
      </div>
    </div>`;
}

// Per-endpoint API key for display: a bridgeApiKeys map (once any endpoint has
// its own key) is authoritative — an endpoint missing from it has NO key. Only
// a config without that map (single-key era) falls back to the card-level
// apiKey, which applied to every endpoint back then.
function bridgeRowApiKey(cfg, url) {
  const map = cfg.bridgeApiKeys || {};
  if (Object.keys(map).length) return map[url] || '';
  return cfg.apiKey || '';
}

// Bridge endpoint rows source: cfg.models (the endpoints slot the bridge card
// shares with multi-model LLM cards) first; a legacy comma-joined baseUrl
// (config last saved before #112) splits as fallback. One row per endpoint,
// always at least one (empty) row so the card never renders rowless.
function bridgeEndpointRows(cfg) {
  let urls = Array.isArray(cfg.models) ? cfg.models.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!urls.length) urls = String(cfg.baseUrl || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const agents = cfg.bridgeAgents || {};
  const rows = [...new Set(urls)].map((u) => ({ url: u, alias: agents[u] || '', apiKey: bridgeRowApiKey(cfg, u) }));
  if (!rows.length) rows.push({ url: '', alias: '', apiKey: '' });
  return rows;
}

function addBridgeRow(wrap, { url = '', alias = '', apiKey = '' } = {}) {
  wrap.querySelector('.bridge-add').insertAdjacentHTML('beforebegin', bridgeRowHtml(url, alias, apiKey));
  const rows = wrap.querySelectorAll('.bridge-row');
  return rows[rows.length - 1];
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
  // Base URL tip bubble per agent provider. Precomputed OUTSIDE the card
  // template on purpose: a conditional template literal nested three levels
  // deep inside card.innerHTML's template made V8's parser bail with
  // "missing ) after argument list" — same HTML, one less nesting level.
  const agentBaseUrlTip = !isAgent ? '' : cfg.isBridge
    ? `<span class="tip" tabindex="0">?<span class="tip-bubble">${_t('bridgeTip', '本地桥的安装与启动见 <a href="https://github.com/xiaohuzai/agent-bridge" target="_blank" rel="noopener noreferrer">agent-bridge 文档</a>。一行填一个桥地址。')}</span></span>`
    : cfg.isOpencode
    ? `<span class="tip" tabindex="0">?<span class="tip-bubble">${_t('opencodeTip', '先在终端启动 <code>opencode serve --port 4096</code>，把它打印的地址填到这里（建议固定端口；不固定则每次重启端口都会变）。<a href="https://opencode.ai/docs/server/" target="_blank" rel="noopener noreferrer">opencode Server 文档</a>')}</span></span>`
    : `<span class="tip" tabindex="0">?<span class="tip-bubble"><a href="https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server" target="_blank" rel="noopener noreferrer">${_t('hermesApiDocsLink', 'Hermes API Server 启动与配置文档')}</a></span></span>`;

  // Base URL field: a plain input for LLM/Hermes/opencode, a per-row endpoint
  // editor (URL + alias per row, ＋ to add) for the bridge card. Precomputed
  // OUTSIDE the card template on purpose — same V8 nested-conditional rule as
  // agentBaseUrlTip above.
  const agentPlaceholder = cfg.isOpencode ? 'http://127.0.0.1:4096' : 'http://127.0.0.1:8080';
  const baseUrlField = isAgent && cfg.isBridge
    ? `
      <div class="field field-full">
        <label><span>Base URL${agentBaseUrlTip}</span>
          <div class="bridge-endpoints" data-bridge-endpoints>
            ${bridgeEndpointRows(cfg).map(({ url, alias, apiKey }) => bridgeRowHtml(url, alias, apiKey)).join('')}
            <button type="button" class="bridge-add" data-act="bridge-add">${_t('bridgeAddBtn', '＋ 添加 Agent')}</button>
          </div>
        </label>
      </div>`
    : `
      <div class="field">
        <label>${isAgent ? `<span>Base URL${agentBaseUrlTip}</span>` : _t('baseUrlLabel', 'Base URL')}
          <input data-k="baseUrl" type="text" value="${escapeAttr(cfg.baseUrl)}" placeholder="${isAgent ? agentPlaceholder : ''}" />
        </label>
      </div>`;

  // API key field: bridge cards skip it — each endpoint row carries its own
  // key (bridges can require different tokens; one card-level field was the
  // user-reported flaw of the first row-editor pass).
  const apiKeyField = isAgent && cfg.isBridge ? '' : `
      <div class="field">
        <label>${_t('apiKeyLabel', 'API key')}
          <div class="apikey-wrap">
            <input data-k="apiKey" type="password" value="${escapeAttr(cfg.apiKey || '')}" placeholder="sk-..." />
            <button type="button" class="apikey-toggle" title="${_t('apiKeyToggleTitle', 'Show / hide key')}" aria-label="${_t('apiKeyToggleAria', 'Toggle API key visibility')}">👁</button>
          </div>
        </label>
      </div>`;

  // Restore ping state from memory
  const pinged = _pingState[name];
  const badgeCls  = pinged === 'reachable' ? 'reachable' : pinged === 'unreachable' ? 'unreachable' : (isConfigured ? 'configured' : 'unconfigured');
  const badgeTxt  = pinged === 'reachable' ? _t('statusReachableBadge', '● reachable') : pinged === 'unreachable' ? _t('statusUnreachableBadge', '● unreachable') : (isConfigured ? _t('badgeNotPinged', '○ not pinged') : _t('badgeNotSet', '○ not set'));

  card.innerHTML = `
    <h3 class="provider-h3" title="${reserved ? _t('reservedSlotTitle', 'Reserved empty slot — configure and Save to commit it') : _t('clickToActivateTitle', 'Click to set as active provider')}">
      <span class="name">${escapeHtml(displayName)}</span>
      <span class="provider-badge ${badgeCls}">${badgeTxt}</span>
      ${!isAgent && !reserved ? `<button type="button" class="provider-delete" data-act="delete" title="${_t('removeProviderTitle', 'Remove this provider')}">${ICON_CLOSE}</button>` : ''}
    </h3>
    <div class="fields">
    ${!isAgent ? `
      <div class="field">
        <label>${_t('aliasLabel', 'Alias')}
          <input data-k="alias" type="text" value="${escapeAttr(cfg.alias || '')}" placeholder="${_t('aliasPlaceholder', 'e.g. My OpenAI')}" />
        </label>
      </div>` : ''}
      ${baseUrlField}
      ${apiKeyField}
      ${showModel ? `
      <div class="field">
        <label>${_t('modelIdLabel', 'Model ID')}
          <div class="model-chips" data-model-chips>
            ${(cfg.models?.length ? cfg.models : (cfg.model ? [cfg.model] : [])).filter(Boolean).map((id) => `
              <span class="chip" data-id="${escapeAttr(id)}">${escapeHtml(id)}<button type="button" class="chip-x" data-remove="${escapeAttr(id)}" title="${_t('chipRemoveTitle', 'Remove model')}" aria-label="${_t('chipRemoveAria', 'Remove')} ${escapeAttr(id)}">${ICON_CLOSE}</button></span>`).join('')}
            <input class="chip-input" type="text" placeholder="${_t('chipInputPlaceholder', 'add model id — Enter')}" aria-label="${_t('chipInputAria', 'Add model ID')}" />
            <button type="button" class="chip-add" title="${_t('chipAddTitle', 'Add model')}" aria-label="${_t('chipAddAria', 'Add model ID')}">＋</button>
          </div>
          <input type="hidden" data-k="model" value="${escapeAttr((cfg.models?.length ? cfg.models : (cfg.model ? [cfg.model] : [])).filter(Boolean).join(', '))}" />
        </label>
      </div>` : ''}
      ${!isAgent ? `
      <div class="field field-full">
        <label>${_t('apiLabel', 'API')}
          <select data-k="apiStyle" class="api-style-select">
            ${['chat', 'responses', 'anthropic'].map(s => `
              <option value="${s}"${(cfg.apiStyle || 'chat') === s ? ' selected' : ''}>${apiStyleLabel(s)}</option>`).join('')}
          </select>
        </label>
      </div>` : ''}
    </div>
    <div class="row action-row">
      <button data-act="save">${_t('saveBtn', 'Save')}</button>
      <button data-act="ping">${_t('pingBtn', 'Ping')}</button>
      <button data-act="reset">${_t('resetBtn', 'Reset')}</button>
      <span class="card-status">${reserved ? _t('emptySlotStatus', 'Empty slot — configure and Save') : ''}</span>
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

  // Model ID chips 编辑器：输入 + 回车/＋ 添加（粘贴逗号分隔自动拆分、去重），
  // chip 上 ✕ 移除；真实值同步进隐藏的 data-k="model" 逗号串，readCard/saveCard
  // 的既有规范化（models 全量 + model 首个）零改动。
  const chipsWrap = card.querySelector('[data-model-chips]');
  if (chipsWrap) {
    const hidden = card.querySelector('input[data-k="model"]');
    const chipInput = chipsWrap.querySelector('.chip-input');
    const chipIds = () => [...chipsWrap.querySelectorAll('.chip')].map((c) => c.dataset.id);
    const syncChips = () => { hidden.value = chipIds().join(', '); };
    const addChips = () => {
      const parts = chipInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      const existing = new Set(chipIds());
      for (const id of parts) {
        if (existing.has(id)) continue;
        existing.add(id);
        chipInput.insertAdjacentHTML('beforebegin',
          `<span class="chip" data-id="${escapeAttr(id)}">${escapeHtml(id)}<button type="button" class="chip-x" data-remove="${escapeAttr(id)}" title="${_t('chipRemoveTitle', 'Remove model')}" aria-label="${_t('chipRemoveAria', 'Remove')} ${escapeAttr(id)}">${ICON_CLOSE}</button></span>`);
      }
      chipInput.value = '';
      syncChips();
    };
    chipInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addChips(); }
    });
    chipsWrap.querySelector('.chip-add').addEventListener('click', (e) => { e.stopPropagation(); chipInput.focus(); addChips(); });
    chipsWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (btn) {
        e.stopPropagation();
        btn.closest('.chip').remove();
        syncChips();
        return;
      }
      // 盒子外观对齐普通输入框后，点空白/点 chip 也应聚焦输入框（表单惯例）
      if (e.target !== chipInput) chipInput.focus();
    });
  }

  // Bridge endpoints editor: ＋ appends an empty row and focuses its URL
  // input; ✕ removes the row, and when the last row goes a fresh empty one
  // takes its place so the card never renders rowless; the eye toggles that
  // row's own key field. (Row inputs carry data-bridge-* on purpose —
  // readCard only harvests [data-k], and the bridge branch of saveCard reads
  // the rows itself.)
  const bridgeWrap = card.querySelector('[data-bridge-endpoints]');
  if (bridgeWrap) {
    bridgeWrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="bridge-add"]')) {
        e.stopPropagation();
        addBridgeRow(bridgeWrap).querySelector('[data-bridge-url]').focus();
        return;
      }
      const eye = e.target.closest('[data-act="bridge-key-eye"]');
      if (eye) {
        e.stopPropagation();
        const keyInput = eye.closest('.apikey-wrap')?.querySelector('[data-bridge-key]');
        if (keyInput) {
          const show = keyInput.type === 'password';
          keyInput.type = show ? 'text' : 'password';
          eye.textContent = show ? '🙈' : '👁';
        }
        return;
      }
      const rm = e.target.closest('[data-act="bridge-remove"]');
      if (rm) {
        e.stopPropagation();
        rm.closest('.bridge-row').remove();
        if (!bridgeWrap.querySelector('.bridge-row')) addBridgeRow(bridgeWrap);
      }
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
  // bridge 卡：端点逐行编辑（一行 = 一个桥地址 + 别名，＋ 添加）。models 槽
  // 仍存端点 URL 列表（与多模型 LLM 卡共用；resolveBridgeEndpoint / 主页下拉
  // / 每端点会话键的消费方零改动），model/baseUrl 指向首个端点。别名 WYSIWYG：
  // 框里有字 = 手动别名（Ping 不覆盖）；框留空 = 交给 Ping 的 /health 发现
  // （发现值保存时不保留——想重新发现，清空别名再 Ping 即可）。
  // 注意必须先滤空原始输入再 normalizeBridgeUrl：它对空串返回默认地址而非空串。
  if (cachedCfg.providers[name].isBridge) {
    const urls = [];
    const aliases = {};
    const keys = {};
    for (const row of card.querySelectorAll('.bridge-row')) {
      const raw = (row.querySelector('[data-bridge-url]')?.value || '').trim();
      if (!raw) continue;
      const u = normalizeBridgeUrl(raw);
      if (urls.includes(u)) continue;
      urls.push(u);
      const a = (row.querySelector('[data-bridge-alias]')?.value || '').trim();
      if (a) aliases[u] = a;
      const k = (row.querySelector('[data-bridge-key]')?.value || '').trim();
      if (k) keys[u] = k;
    }
    cachedCfg.providers[name].models = urls;
    cachedCfg.providers[name].model = urls[0] || '';
    cachedCfg.providers[name].baseUrl = urls[0] || '';
    cachedCfg.providers[name].bridgeAgents = aliases;
    // 每端点 token（桥可以各要各的）：bridgeApiKeys 是权威表，未列出的端点
    // 即「无 key」；卡级 apiKey 仍写首个端点的 key，给老消费方/老配置兜底。
    cachedCfg.providers[name].bridgeApiKeys = keys;
    cachedCfg.providers[name].apiKey = keys[urls[0]] || '';
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
  flashCard(card, 'ok', _t('savedFlash', '✓ Saved'));
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
    flashCard(card, 'err', _t('modelRequiredErr', '❌ Model ID is required for LLM providers'));
    return;
  }

  flashCard(card, '', _t('pingingFlash', 'Pinging…'));
  try {
    // Agent cards speak their own HTTP APIs — the generic OpenAI-style
    // ping() would 404 on a healthy server. bridge pings GET /health PER
    // configured endpoint (one endpoint = one agent; aliases come back in
    // the `agent` field and are persisted to the card for the sidebar
    // dropdown), opencode GET /api/health. A failed ping is normalized into
    // a throw so the shared error flash/badge path below handles all
    // families alike (bridge: reachable ⇔ at least one endpoint answers).
    const reply = cfg.isBridge
      ? await (async () => {
          const urls = providerModelList(cfg);
          if (!urls.length) throw new Error(_t('bridgeNeedEndpointErr', '先添加至少一个桥地址再 Ping。'));
          const results = await Promise.all(urls.map((u) => pingBridge({ baseUrl: u, apiKey: resolveBridgeApiKey(cfg, u) })));
          const okUrls = results.filter((r) => r.ok);
          if (!okUrls.length) {
            throw new Error(results[0]?.error || `no agent-bridge at ${results[0]?.url}`);
          }
          // 别名 WYSIWYG：发现名只填进「空」端点（没存别名 = 交给发现）；
          // 用户手填的别名永不被 /health 覆盖，改对了名字自己清空再 Ping。
          const agents = cfg.bridgeAgents || {};
          cfg.bridgeAgents = Object.fromEntries(okUrls.map((r) => [
            r.url,
            (agents[r.url] || '').trim() || r.agent || '',
          ]));
          await chrome.storage.local.set({ providers: cachedCfg.providers });
          // 发现的别名顺手写回页面上还空着的输入框——所见即所存，下次 Save
          // 即按手填处理；输入框按规整后的 URL 对上行匹配（raw 输入可能没写 scheme）。
          for (const row of card.querySelectorAll('.bridge-row')) {
            const urlInput = row.querySelector('[data-bridge-url]');
            const aliasInput = row.querySelector('[data-bridge-alias]');
            if (!urlInput || !aliasInput || aliasInput.value.trim()) continue;
            const u = normalizeBridgeUrl(urlInput.value.trim());
            if (cfg.bridgeAgents[u]) aliasInput.value = cfg.bridgeAgents[u];
          }
          const downs = results.length - okUrls.length;
          const names = okUrls.map((r) => cfg.bridgeAgents[r.url] || String(r.url).replace(/^https?:\/\//, '')).join(', ');
          return `agent-bridge ×${okUrls.length}/${results.length} healthy (${names})${downs ? ` — ${downs} down` : ''}`;
        })()
      : cfg.isOpencode
      ? await (async () => {
          const r = await pingOpencode({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
          if (!r.ok) throw new Error(r.error || `no healthy opencode server at ${r.url}`);
          return 'opencode server healthy';
        })()
      : await ping({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, apiStyle: cfg.apiStyle || 'chat' });

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
      activeNote = _t('setActiveNote', ' — set as active provider');
    }

    // Auto-detect capabilities and update isHermes accordingly. isHermes
    // gates the Hermes-only /v1/runs API (approval, clarification, tool
    // events) — so it should reflect run support, not the generic
    // OpenAI-spec /v1/responses feature. opencode is identified by its
    // fixed isOpencode flag — never flip it from capability probing.
    const caps = (cfg.isOpencode || cfg.isBridge) ? null : await getCapabilities({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
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
    badge.textContent = _t('statusReachableBadge', '● reachable');
  } else {
    badge.className = 'provider-badge unreachable';
    badge.textContent = _t('statusUnreachableBadge', '● unreachable');
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
    flash('ok', _t('systemPromptSaved', 'System prompt saved.'));
  });
  document.querySelector('button[data-act="reset-system-prompt"]')?.addEventListener('click', async () => {
    el.value = DEFAULT_SYSTEM_PROMPT;
    await chrome.storage.local.set({ systemPrompt: DEFAULT_SYSTEM_PROMPT });
    flash('ok', _t('systemPromptReset', 'System prompt reset to default.'));
  });
}

function applyReplyLanguage() {
  const el = $('replyLanguage');
  if (!el) return;
  el.value = cachedCfg.replyLanguage || '';
  document.querySelector('button[data-act="save-reply-language"]')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ replyLanguage: el.value });
    flash('ok', el.value ? tSub('replyLanguageSet', `Reply language set to "$1".`, el.options[el.selectedIndex]?.text) : _t('replyLanguageAutoSet', 'Reply language: Auto.'));
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
    flash('ok', el.checked ? _t('toolbarEnabledFlash', 'Floating toolbar enabled.') : _t('toolbarDisabledFlash', 'Floating toolbar disabled.'));
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
    flash('ok', el.checked ? _t('llmsTxtOnFlash', 'llms.txt will be included when attaching a page.') : _t('llmsTxtOffFlash', 'llms.txt disabled.'));
  });
}

function applyDeepExtract() {
  const el = $('deepExtractEnabled');
  if (!el) return;
  chrome.storage.local.get('deepExtractEnabled', ({ deepExtractEnabled }) => {
    el.checked = deepExtractEnabled !== false; // default true
  });
  el.addEventListener('change', () => {
    chrome.storage.local.set({ deepExtractEnabled: el.checked });
    flash('ok', el.checked
      ? _t('deepExtractOnFlash', 'Automatic expand-and-page on incomplete pages enabled.')
      : _t('deepExtractOffFlash', 'Automatic expand-and-page disabled.'));
  });
}

function prettyProviderName(name) {
  // Prefer the user-set alias so multiple configured providers stay
  // distinguishable; fall back to a readable form of the internal key.
  const alias = cachedCfg?.providers?.[name]?.alias;
  if (alias && alias.trim()) return alias.trim();
  if (name === 'hermes') return 'Hermes Agent';
  if (name === 'opencode') return 'OpenCode Agent';
  if (name === 'bridge') return BRIDGE_CARD_LABEL;
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
