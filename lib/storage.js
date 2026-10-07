// lib/storage.js
// Tiny wrapper around chrome.storage.local for typed access.
// History is now a single global flat array (not per-tab), matching how
// Sider/Monica/MaxAI all operate — one shared conversation across tabs.

import { PAGE_CONTEXT_PREFIX } from './constants.js';
import { ASR_PROVIDERS } from './asr-providers.js';
import { BRIDGE_CARD_LABEL } from './provider-display.js';

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

const DEFAULTS = {
  providers: {
    // Hermes is the built-in agent provider (full agent backend: /v1/runs,
    // tool execution, approval/clarification). Fixed, not user-deletable.
    hermes: { type: 'agent', alias: 'Hermes Agent', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
    // OpenSquilla is the second built-in agent provider (08-31 integration,
    // restored 2026-09-23 after the upstream origin-guard PR landed) — a
    // local desktop agent whose gateway speaks WebSocket RPC
    // (lib/squilla-client.js). Fixed, not user-deletable; baseUrl is the
    // gateway WS URL (ws://127.0.0.1:18791/ws). The gateway's origin guard
    // requires this extension's origin in its cors.allowed_origins — see
    // README.
    squilla: { type: 'agent', alias: 'OpenSquilla', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: false, isSquilla: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
    // opencode is the third built-in agent provider — `opencode serve` is a
    // first-party headless HTTP server (OpenAPI at GET /doc) with sessions,
    // streaming events, and permission/question flows (lib/opencode-client.js).
    // Fixed, not user-deletable. baseUrl ships EMPTY (same as Hermes): the
    // recommended address (http://127.0.0.1:4096, i.e. `opencode serve
    // --port 4096`) lives in the card's placeholder, not in a default that
    // would look configured while pointing at a server that isn't running.
    // apiKey is optional (bearer).
    opencode: { type: 'agent', alias: 'OpenCode Agent', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: false, isOpencode: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
    // bridge is the fourth built-in agent provider — the user-run local
    // daemon (standalone project: github.com/xiaohuzai/agent-bridge) that
    // adapts CLI agents (codex first, claude code next) to the bridge's wire
    // protocol v1. Fixed, not user-deletable. baseUrl ships EMPTY like
    // Hermes/opencode (recommended address http://127.0.0.1:3948 lives in
    // the card's tip/placeholder); apiKey doubles as the OPTIONAL bridge
    // bearer token.
    bridge: { type: 'agent', alias: BRIDGE_CARD_LABEL, baseUrl: '', apiKey: '', model: '', stream: true, isHermes: false, isBridge: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
    // LLM providers are user-added (via the options page) — the defaults
    // ship with NO llm cards in storage. The options page shows a render-only
    // reserved empty "LLM 1" slot when the group is empty (committed to
    // storage only when the user fills it in and hits Save), so nothing here
    // is persisted and getAll() must never resurrect a blank llm card — an
    // empty group just renders the reserved slot again.
  },
  activeProvider: 'hermes',
  activeModel: '',  // 主页下拉选中的具体模型（多模型 provider 的 Alias · model 选择；'' = 用 provider.model）
  pingStates: {},  // { [providerName]: 'reachable' | 'unreachable' }
  history: [],         // flat global array: [{ role, content }, ...]
  contextMode: 'auto',
  maxTextChars: 0,
  autoSummarizeAttachments: true,  // chunk/summarize/merge very long attachments before they enter history
  summarizeThresholdChars: 0,      // 0 = use the built-in 100,000-char default (see lib/handlers/attach-summarizer.js)
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  // 火山方舟录音文件识别（ASR）配置 — 无字幕 B站视频 attach 时转写音频生成字幕。
  // 与 lib/handlers/attach-asr.js 的 ASR_DEFAULTS 保持同步（storage 是配置入口，
  // attach-asr 是纯逻辑，字段默认值两边一致）。
  asr: {
    enabled: false,
    provider: 'qwen',                              // 服务商（lib/asr-providers.js 注册表）；决定走哪条协议适配器（2026-10-07 默认翻为百炼）
    apiKey: '',                                    // 所选供应商的 Bearer key（百炼 sk- / 方舟 UUID 或 ark-）
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-audio-3.1-asr-flash-filetrans',   // 音频转写模型 ID（百炼专用 ASR）
    videoModel: 'qwen3.8-omni-flash',              // 音视频精读模型 ID（omni 全模态）
    language: 'zh',
    hotwords: '',                                  // 热词（逗号/换行分隔，可选）——百炼 filetrans 系即时热词
    format: 'audio/x-m4a',                         // 上传 MIME（08-16 起 sidepanel 固定转码成 WAV 上传，此字段仅 legacy downloadAndUploadAudio 使用）
    timeoutMs: 150_000,
    subtitleSource: 'original',                   // 'original'=优先视频自带字幕（无字幕才 ASR） | 'asr'=优先 ASR 解析字幕（始终转写并替换）
  },
  replyLanguage: '', // '' = auto, 'en', 'zh', 'ja', etc.
  llmsTxtEnabled: true,  // fetch llms.txt from page origin before each chat
  deepExtractEnabled: true  // auto-escalate: walk pagination + expand what heuristics missed
};

const MAX_HISTORY = 60;
const MAX_TOTAL_CHARS = 300_000;

// The light-key surface getAll() reads (see the contract comment inside).
// DEFAULTS keys minus `history` (a DEFAULTS member but a heavy payload key —
// consumers get DEFAULTS.history = []), plus the three options-page settings
// read off cfg.
function GET_ALL_KEYS() {
  return [
    ...Object.keys(DEFAULTS).filter((k) => k !== 'history'),
    'fontSize', 'sendShortcut', 'thoughtAutoCollapse',
  ];
}

export async function getAll() {
  // getAll() used to `get(null)` — deserializing `history` (up to ~8MB of
  // parked image base64) plus every saved session on EVERY chat turn /
  // attach / explain, only to delete the heavy keys from the result
  // afterward. The read is scoped to the exact light-key surface instead.
  // CONTRACT: a NEW chrome.storage.local key that getAll() consumers must
  // see has to be added to GET_ALL_KEYS — keys read elsewhere via targeted
  // chrome.storage.local.get calls (uiLang, quickbarCollapsed,
  // composerState, pendingUpdateNotice, xhsAnchorFingerprint, …) don't
  // belong here. The three appearance/behavior settings are read off the
  // options page's cfg object, hence their presence.
  const stored = await chrome.storage.local.get(GET_ALL_KEYS());
  // Deep-merge each provider: stored values override defaults but don't drop new default fields.
  // Without this, users who saved providers before new fields (temperature, maxTokens) were
  // added would lose those defaults when their stored object replaces the default entirely.
  const storedProviders = stored.providers || {};
  const mergedProviders = {};
  for (const name of Object.keys(DEFAULTS.providers)) {
    mergedProviders[name] = { ...DEFAULTS.providers[name], ...(storedProviders[name] || {}) };
  }
  // Include any extra providers the user may have added that aren't in DEFAULTS
  for (const name of Object.keys(storedProviders)) {
    if (!mergedProviders[name]) mergedProviders[name] = storedProviders[name];
  }
  // bridge 卡名升级（2026-09-09 起）：历代默认别名读时归一为当前卖点标签——
  // agent 卡没有别名编辑入口，命中旧默认值的只可能是我们自己写入的，不会覆盖
  // 用户自定的名字。新增一代默认名时把上一代追加进这个集合。
  const legacyBridgeAliases = new Set(['Agent Bridge', 'Agent Bridge (Codex / Claude Code …)']);
  if (legacyBridgeAliases.has(mergedProviders.bridge?.alias)) mergedProviders.bridge.alias = BRIDGE_CARD_LABEL;
  // 已卸载的 ASR 供应商（如 2026-08-31 移除的千问）：连接字段整体回落默认（保留
  // 开关与语言等偏好）——残留的别家 baseUrl/模型 ID 会让 ASR 跑在错误端点上，
  // 报出难以定位的错。读时归一，options 与 sidepanel 两条消费路径同时受保护。
  const knownAsrIds = new Set(Object.values(ASR_PROVIDERS).map((p) => p.id));
  if (stored.asr?.provider && !knownAsrIds.has(stored.asr.provider)) {
    stored.asr = {
      ...stored.asr,
      provider: DEFAULTS.asr.provider,
      apiKey: DEFAULTS.asr.apiKey,
      baseUrl: DEFAULTS.asr.baseUrl,
      model: DEFAULTS.asr.model,
      videoModel: DEFAULTS.asr.videoModel,
    };
  }
  // getAll() used to `get(null)` — deserializing `history` (up to ~8MB of
  // parked image base64) plus every saved session on EVERY chat turn /
  // attach / explain, only to delete the heavy keys from the result
  // afterward. The read is scoped to the exact light-key surface instead.
  // Absent keys must not shadow DEFAULTS: drop explicit-undefined entries
  // (real chrome.storage omits absent keys, but defensive filtering keeps
  // the spread correct under any storage impl).
  const light = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined));
  return { ...DEFAULTS, ...light, providers: mergedProviders };
}

// ─── Generic chrome.storage.local adapter (storage seam) ─────────────────────
// The single place callers touch chrome.storage.local through — no caller
// connects to chrome.storage.local directly. Two call shapes per method; both
// are stable API (the original single-key forms this module was written
// against, plus the chrome-shaped forms the callers' seam conversion needs):
//   get('key')        -> the stored value (original single-key form)
//   get(['a', 'b'])   -> { a, b }           (chrome-shaped targeted read)
//   set('key', value) -> single-entry write (original form)
//   set({ ... })      -> chrome-shaped batch write
//   remove(keyOrKeys) -> chrome-shaped delete
export async function get(keys) {
  if (typeof keys === 'string') {
    const v = await chrome.storage.local.get(keys);
    return v[keys];
  }
  return await chrome.storage.local.get(keys);
}

export async function set(key, value) {
  await chrome.storage.local.set(typeof key === 'string' ? { [key]: value } : key);
}

export async function remove(keys) {
  await chrome.storage.local.remove(keys);
}

export async function setActiveProvider(name, model = '') {
  // 多模型 provider：activeModel 记录主页下拉选中的具体模型（Alias · model）；
  // '' = 未指定，消费方回退 provider.model（卡上第一个模型）。
  await set('activeProvider', name);
  await set('activeModel', model || '');
}

export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

function contentChars(m) {
  if (typeof m.content === 'string') return m.content.length;
  if (Array.isArray(m.content)) {
    // Only count text parts — image base64 is excluded from the char budget.
    return m.content.reduce((n, p) => n + (p.text?.length || 0), 0);
  }
  return 0;
}

export async function setHistory(messages) {
  let trimmed = messages.slice(-MAX_HISTORY);
  let total = trimmed.reduce((n, m) => n + contentChars(m), 0);
  while (total > MAX_TOTAL_CHARS && trimmed.length > 1) {
    total -= contentChars(trimmed[0]);
    trimmed = trimmed.slice(1);
  }
  await set('history', trimmed);
  // 所有历史写入的单一咽喉点：历史被清空（多选删光/UNDO 掉唯一条目/截断到 0）
  // 即当前对话不复存在，会话归属一并失效——否则残留的指针会让之后一条
  // 毫无关系的全新对话在切走时写回旧会话，覆盖其快照。
  if (!trimmed.length) await set('activeSessionId', '');
}

// ─── History write serialization ─────────────────────────────────────────────
// Every history mutation is a read-modify-write. Two of them overlapping (each
// awaits getHistory(), so both can snapshot the same pre-state) makes the later
// write clobber the earlier — a silently lost turn. All compound mutators run
// through this single in-file async lock so their read and write never
// interleave. Convention: a mutator returns the next array to write, or
// null/undefined to mean "no change, skip the write". setHistory itself is NOT
// locked (it is called from inside the lock); never await another locked helper
// from within a mutator.
let _historyChain = Promise.resolve();
function withHistoryLock(fn) {
  const run = _historyChain.then(fn, fn);
  _historyChain = run.then(() => {}, () => {});
  return run;
}

/** Locked read-modify-write for callers outside storage.js. */
export function mutateHistory(mutator) {
  return withHistoryLock(async () => {
    const current = await getHistory();
    const next = await mutator(current);
    if (next == null) return current;
    await setHistory(next);
    return next;
  });
}

export async function appendToHistory(message, agentContextId) {
  // Returns the post-append length — the CHAT DONE payload carries it so the
  // panel's reconcile can skip its full-history deserialization (≤8MB with
  // parked images) in the no-drift common case (2026-09-30 批C).
  const append = async () => {
    const next = await mutateHistory((current) => { current.push(message); return current; });
    return Array.isArray(next) ? next.length : null;
  };
  if (!agentContextId) return append();
  // Session creation can outlive a switch, before any stream exists to move
  // to the background. Check and append atomically with respect to load/clear.
  return withSessionLock(async () => {
    if ((await agentStateUnlocked()).contextId !== agentContextId) return null;
    return append();
  });
}

export async function clearHistory() {
  await withSessionLock(() => withHistoryLock(async () => {
    await set('history', []);
    await set('activeSessionId', ''); // 对话清空即失去会话归属（见 setActiveSessionId）
    await replaceAgentSessionState({ contextId: crypto.randomUUID(), ids: {} });
  }));
}

export async function removeHistoryEntryByIndex(index) {
  let removed = false;
  await mutateHistory((current) => {
    if (index < 0 || index >= current.length) return null;
    current.splice(index, 1);
    removed = true;
    return current;
  });
  return removed;
}

// Remove the attach entry carrying this attachId; returns the removed index
// or -1. Undo-attach must delete by identity, not by "last page-context":
// with two attachments in history, undoing the OLDER label has to remove the
// OLDER entry — an index captured at attach time drifts as entries are
// appended/removed/trimmed, so the attachId stamped on the entry is the only
// stable handle.
export async function removeHistoryEntryByAttachId(attachId) {
  if (!attachId) return -1;
  let idx = -1;
  await mutateHistory((current) => {
    idx = current.findIndex((m) => m?.attachId === attachId);
    if (idx === -1) return null;
    current.splice(idx, 1);
    return current;
  });
  return idx;
}

// Remove all history entries from `index` onward (inclusive).
export async function truncateHistoryFromIndex(index) {
  if (index < 0) return false;
  await mutateHistory((current) => current.slice(0, index));
  return true;
}

export async function removeLastPageContext() {
  let removedIdx = -1;
  await mutateHistory((current) => {
    for (let i = current.length - 1; i >= 0; i--) {
      const m = current[i];
      const isCtx =
        (typeof m.content === 'string' && m.content.startsWith(PAGE_CONTEXT_PREFIX)) ||
        (Array.isArray(m.content) && m.content[0]?.text?.startsWith(PAGE_CONTEXT_PREFIX));
      if (m.role === 'user' && isCtx) {
        current.splice(i, 1);
        removedIdx = i;
        return current;
      }
    }
    return null;
  });
  return removedIdx;
}


// ─── Hermes session identity (X-Hermes-Session-Id / session_id) ───────────────
// hermes-webui always sends a stable session_id (as both a header and a body
// field) on every /v1/runs request. browsa's runsApiStream didn't send one at
// all, which may explain behavioral differences (e.g. tool permission scoping)
// between the two clients talking to the same Hermes instance. IDs now
// persist in local agentSessionState and saved-session metadata, with a
// chrome.storage.session cache. Clearing history creates a fresh identity;
// restoring a saved conversation restores its own IDs across all families.
function isAgentSessionKey(key) {
  return /^(hermesSessionId_|opencodeSessionId_|bridgeSessionId_|squillaSessionKey_|agentSessionTitled_|agentSessionBackfilled_)/.test(key);
}

// All identity reads/writes and conversation swaps share the index lock.
// Helpers ending in Unlocked are called only inside that lock.
async function agentStateUnlocked() {
  const { agentSessionState } = await chrome.storage.local.get('agentSessionState');
  if (agentSessionState?.contextId) return agentSessionState;
  const cache = await chrome.storage.session.get(null).catch(() => ({}));
  const state = { contextId: crypto.randomUUID(), ids: Object.fromEntries(Object.entries(cache)
    .filter(([key, value]) => isAgentSessionKey(key) && typeof value === 'string' && value)) };
  await chrome.storage.local.set({ agentSessionState: state });
  return state;
}

async function agentContextUnlocked(contextId) {
  const current = await agentStateUnlocked();
  if (!contextId || current.contextId === contextId) return current;
  const index = await readSessionIndex();
  const saved = index.find(s => s.agentContextId === contextId);
  return { contextId, ids: saved?.agentSessions || {}, legacyRestored: !!saved?.agentHistoryBackfill };
}

async function sessionGet(key, contextId) {
  // UI getters are read-only: sidepanel and worker have different module
  // locks, so only worker mutation/turn paths may initialize identity.
  const { agentSessionState: current } = await chrome.storage.local.get('agentSessionState');
  if (contextId && current?.contextId !== contextId) {
    const index = await readSessionIndex();
    return index.find(s => s.agentContextId === contextId)?.agentSessions?.[key];
  }
  if (current?.contextId) return current.ids?.[key];
  return (await chrome.storage.session.get(key).catch(() => ({})))[key];
}

async function sessionSetUnlocked(key, value, contextId) {
  const current = await agentStateUnlocked();
  if (!contextId || current.contextId === contextId) {
    await chrome.storage.local.set({ agentSessionState: { ...current, ids: { ...current.ids, [key]: value } } });
    await chrome.storage.session.set({ [key]: value }).catch(() => {});
  }
  // A server-assigned ID or title stamp can arrive after a switch. It belongs
  // to the archived origin, never to the newly visible conversation. Update
  // the snapshot even while still live: save and load are separate messages,
  // and a late ID can arrive in the gap between them.
  const index = await readSessionIndex();
  const targets = index.filter(s => s.agentContextId === (contextId || current.contextId));
  for (const target of targets) target.agentSessions = { ...target.agentSessions, [key]: value };
  if (targets.length) await chrome.storage.local.set({ savedSessions: index });
}

async function sessionSet(key, value, contextId) {
  return withSessionLock(() => sessionSetUnlocked(key, value, contextId));
}

async function sessionRemoveUnlocked(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const state = await agentStateUnlocked();
  const ids = { ...state.ids };
  for (const key of list) delete ids[key];
  await chrome.storage.local.set({ agentSessionState: { ...state, ids } });
  await chrome.storage.session.remove(list).catch(() => {});
}

async function sessionRemove(keys) {
  return withSessionLock(() => sessionRemoveUnlocked(keys));
}

// Durable identity for the live conversation, independent of its saved UUID.
// IDs/title stamps only; credentials and history bytes are never copied here.
export async function getAgentSessionContextId() {
  return withSessionLock(async () => (await agentStateUnlocked()).contextId);
}

function backfillStampKey(providerName, endpoint) {
  return `agentSessionBackfilled_${bridgeSessionKey(providerName, endpoint)}`;
}

export async function needsLegacyAgentBackfill(contextId, providerName, sessionId, endpoint) {
  return withSessionLock(async () => {
    const state = await agentContextUnlocked(contextId);
    return !!state.legacyRestored && (!sessionId || state.ids[backfillStampKey(providerName, endpoint)] !== sessionId);
  });
}

export async function markLegacyAgentBackfilled(contextId, providerName, sessionId, endpoint) {
  if (sessionId) await sessionSet(backfillStampKey(providerName, endpoint), sessionId, contextId);
}

async function snapshotAgentSessions() {
  const state = await agentStateUnlocked();
  return { agentContextId: state.contextId, agentSessions: { ...state.ids },
    ...(state.legacyRestored ? { agentHistoryBackfill: true } : {}) };
}

async function replaceAgentSessionState(state) {
  const cache = await chrome.storage.session.get(null).catch(() => ({}));
  const stale = Object.keys(cache).filter(isAgentSessionKey);
  if (stale.length) await chrome.storage.session.remove(stale).catch(() => {});
  await chrome.storage.local.set({ agentSessionState: state });
  if (Object.keys(state.ids).length) await chrome.storage.session.set(state.ids).catch(() => {});
}

export async function getOrCreateHermesSessionId(providerName, contextId) {
  return withSessionLock(async () => {
    const key = `hermesSessionId_${providerName}`;
    const existing = (await agentContextUnlocked(contextId)).ids[key];
    if (existing) return existing;
    const id = crypto.randomUUID();
    await sessionSetUnlocked(key, id, contextId);
    return id;
  });
}

export async function resetHermesSessionId(providerName) {
  const id = crypto.randomUUID();
  await sessionSet(`hermesSessionId_${providerName}`, id);
  return id;
}

// 跨入口接力（2026-10-01）：「这个会话已在 agent 侧命名为 browsa：…」的戳记。
// 值 = 已命名的 sessionId（换会话 ID 自动失效重试）；与会话 ID 同生命周期。
// 所有 agent 家族共用一份（一个 provider 只走一种 agent 协议）。
export async function getAgentSessionTitleStamp(providerName, contextId) {
  return (await sessionGet(`agentSessionTitled_${providerName}`, contextId)) || null;
}

export async function setAgentSessionTitleStamp(providerName, sessionId, contextId) {
  await sessionSet(`agentSessionTitled_${providerName}`, sessionId, contextId);
}

export async function clearAgentSessionTitleStamp(providerName) {
  await sessionRemove(`agentSessionTitled_${providerName}`);
}

// ─── opencode session identity (server-assigned `ses_…` id) ──────────────────
// The opencode server keeps its own per-session transcript. The session id is
// ASSIGNED BY THE SERVER (POST /api/session → data.id) — browsa never
// fabricates one. Stored in chrome.storage.session like the Hermes session
// id: survives SW restarts within a browser session, so a mid-conversation
// SW sleep does not orphan the agent session; cleared when history is
// cleared so a new conversation starts a fresh opencode session.
export async function getOpencodeSessionId(providerName, contextId) {
  const id = await sessionGet(`opencodeSessionId_${providerName}`, contextId);
  return typeof id === 'string' ? id : null;
}

export async function setOpencodeSessionId(providerName, sessionId, contextId) {
  await sessionSet(`opencodeSessionId_${providerName}`, sessionId, contextId);
}

export async function clearOpencodeSessionId(providerName) {
  await sessionRemove(`opencodeSessionId_${providerName}`);
}

// The bridge provider's session id is the adapter's agent-side thread
// (codex threadId), assigned on the FIRST turn and reported on the SSE
// 'start' event — browsa never fabricates one. Same chrome.storage.session
// cache as opencode; durable IDs travel with each saved conversation,
// cleared on history clear so a new conversation starts a fresh agent thread.
// Keyed PER ENDPOINT: one bridge card fronts one agent per address (the
// daemon's serve mode runs one bridge per port), so codex's and claude's
// thread ids must never collide. Endpoint-less calls fall back to the legacy
// single key (pre-multi-bridge configs).
function bridgeSessionKey(providerName, endpointUrl) {
  const base = `bridgeSessionId_${providerName}`;
  const ep = String(endpointUrl || '').trim();
  if (!ep) return base;
  return `${base}__${ep.replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
}

export async function getBridgeSessionId(providerName, endpointUrl, contextId) {
  const id = await sessionGet(bridgeSessionKey(providerName, endpointUrl), contextId);
  return typeof id === 'string' ? id : null;
}

export async function setBridgeSessionId(providerName, sessionId, endpointUrl, contextId) {
  await sessionSet(bridgeSessionKey(providerName, endpointUrl), sessionId, contextId);
}

// 跨入口接力（2026-10-01）：当前 provider 在 agent 侧的服务端会话标识，供面板
// 展示（会话抽屉的「Agent 会话」行）。非 agent / 尚无会话返回 null。bridge 的
// 会话键按端点分——activeModel 即端点 URL（bridge 卡的既定形状），缺省回退首端点。
export async function getAgentSessionInfo(providerName, provider) {
  if (!providerName || !provider) return null;
  let id = null;
  if (provider.isHermes) id = await sessionGet(`hermesSessionId_${providerName}`);
  else if (provider.isOpencode) id = await getOpencodeSessionId(providerName);
  else if (provider.isSquilla) id = await getSquillaSessionKey(providerName);
  else if (provider.isBridge) id = await getBridgeSessionId(providerName, provider.activeModel || provider.baseUrl || '');
  return typeof id === 'string' && id ? { id } : null;
}

export async function clearBridgeSessionId(providerName) {
  return withSessionLock(async () => {
    const base = `bridgeSessionId_${providerName}`;
    const state = await agentStateUnlocked();
    const stale = Object.keys(state.ids).filter(k => k === base || k.startsWith(`${base}__`));
    if (stale.length) await sessionRemoveUnlocked(stale);
  });
}

// ─── OpenSquilla session identity (gateway-assigned sessionKey) ──────────────
// The gateway keeps server-side per-session transcripts. The session key is
// ASSIGNED BY THE GATEWAY (`sessions.create` → `agent:main:cli:<8hex>`) —
// browsa never fabricates one (`sessions.send` requires an existing session
// and does not accept client-chosen keys). Stored in chrome.storage.session
// as a cache of durable conversation metadata; cleared alongside history so a new conversation
// starts a fresh gateway session.
export async function getSquillaSessionKey(providerName, contextId) {
  const id = await sessionGet(`squillaSessionKey_${providerName}`, contextId);
  return typeof id === 'string' ? id : null;
}

export async function setSquillaSessionKey(providerName, sessionKey, contextId) {
  await sessionSet(`squillaSessionKey_${providerName}`, sessionKey, contextId);
}

export async function clearSquillaSessionKey(providerName) {
  const key = `squillaSessionKey_${providerName}`;
  await sessionRemove(key);
}

// One owner of the "which provider kind holds which server-side session"
// knowledge (architecture-review candidate #4): CLEAR_HISTORY calls this
// instead of re-deriving the isHermes/isOpencode/isBridge ladder inline.
// Adding a fourth agent provider = its flag here + its session family above.
export async function clearAllAgentSessions(providers) {
  for (const name of Object.keys(providers || {})) {
    const p = providers[name];
    if (p?.isHermes) await resetHermesSessionId(name);
    if (p?.isOpencode) await clearOpencodeSessionId(name);
    if (p?.isBridge) await clearBridgeSessionId(name);
    if (p?.isSquilla) await clearSquillaSessionKey(name);
    // 命名戳记跟会话一起重置：新会话拿旧 sessionId 比较本来也会自然失效，
    // 但清掉才是「与会话 ID 同生命周期」的本义，旧键也不滞留到浏览器重启。
    await clearAgentSessionTitleStamp(name);
  }
}


// ─── Session management ───────────────────────────────────────────────────────
// Sessions are lightweight metadata + full history snapshots stored in
// chrome.storage.local as a flat array, keyed by auto-generated UUIDs.
// The CURRENT (live) conversation lives in the standard `history` key.
// Saving a session archives the current history with a name and timestamp.

const MAX_SESSIONS = 50;

// ─── 会话归属（activeSessionId）───────────────────────────────────────────────
// 当前“活对话”已经归属于哪个已保存会话：loadSession 加载某个会话后落下指针，
// newSession 归档后由 clearHistory 清掉。切走一个已归属的对话时把最新内容
// 写回该会话（原地更新），而不是每次都 fork 一个新条目——否则用户在历史清单
// 里每点一次就会多出一份副本。存 chrome.storage.local（与 history 同生命周期，
// 浏览器重启后对话还在，归属也得还在）。
export async function getActiveSessionId() {
  return (await get('activeSessionId')) || '';
}

export async function setActiveSessionId(id) {
  await set('activeSessionId', id || '');
}

/** Auto-generate a session name from the first user message in a history. */
function autoSessionName(history) {
  const first = history.find(
    m => m.role === 'user' && typeof m.content === 'string' &&
         !m.content.startsWith(PAGE_CONTEXT_PREFIX)
  );
  if (first) {
    const trimmed = (first.content || '').trim();
    // Code-point slice: UTF-16 .slice() can split a surrogate pair (emoji),
    // leaving a broken half-character in the session name.
    const text = Array.from(trimmed).slice(0, 48).join('');
    return text.length < trimmed.length ? text + '…' : text;
  }
  return new Date().toLocaleDateString();
}

// ─── Saved sessions: split-key layout (2026-09-30 批E) ────────────────────────
// OLD layout: ONE `savedSessions` key holding all ≤MAX_SESSIONS sessions
// INCLUDING their verbatim history snapshots (image bytes and all). Every
// drawer open / debounced search keystroke deserialized the whole multi-MB
// array; every pin toggle / rename / background-stream append REWROTE all
// of it. NEW layout: `savedSessions` is a LIGHT INDEX
// [{id, name, createdAt, pinned, textDigest, agentContextId, agentSessions}] and each session's history
// lives in its own `session_<id>` key (targeted reads — deliberately NOT in
// GET_ALL_KEYS, so getAll() never deserializes any of them; per the contract
// comment there, these are exactly the "read via targeted get" keys that
// don't belong in that list). Listing/pinning/renaming touch only the index;
// appending touches one body + the index; only load/export/full-read
// deserialize a body.
// SNAPSHOTS STILL CARRY IMAGE PIXELS VERBATIM — the pixel-fidelity decision
// (2026-09-23, do-not-re-propose) is untouched: 批E changes WHERE the bytes
// live, never the bytes. Request-side label compaction (prepareHistoryForModel
// + imagesSeen) is unaffected.
// SEARCH matches names + textDigest: a lowercased TEXT-ONLY digest of the
// snapshot capped at SESSION_DIGEST_CAP chars, so a keystroke never touches
// image bytes. Documented trade: content past a session's first 100K text
// chars is not content-searchable (name search unaffected; the content-hit
// dot is a navigation hint, not an index).
// MIGRATION: legacy index entries carry `.history` — every read path funnels
// through readSessionIndex(), which detects legacy entries and splits them
// on the spot (idempotent; bodies are written BEFORE the index is
// overwritten, so a crash mid-way leaves the old shape intact and fully
// functional, and the next call re-runs the migration).
const SESSION_BODY_PREFIX = 'session_';
const SESSION_DIGEST_CAP = 100_000;

function sessionBodyKey(id) { return `${SESSION_BODY_PREFIX}${id}`; }

function entryText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    for (const p of c) if (typeof p?.text === 'string') out += (out ? '\n' : '') + p.text;
    return out;
  }
  return '';
}

function sessionTextDigest(history) {
  let out = '';
  for (const m of (Array.isArray(history) ? history : [])) {
    out += entryText(m) + '\n';
    if (out.length >= SESSION_DIGEST_CAP) break;
  }
  return out.slice(0, SESSION_DIGEST_CAP).toLowerCase();
}

// Incremental digest extension for the append path (one entry at a time — no
// need to re-derive from the whole body; the cap keeps the index bounded).
function extendSessionDigest(digest, entry) {
  const base = typeof digest === 'string' ? digest : '';
  if (base.length >= SESSION_DIGEST_CAP) return base;
  return (base + entryText(entry).toLowerCase() + '\n').slice(0, SESSION_DIGEST_CAP);
}

function sessionIndexMeta(s, digest) {
  return { id: s.id, name: s.name, createdAt: s.createdAt, pinned: !!s.pinned, textDigest: digest,
    ...(s.agentContextId ? { agentContextId: s.agentContextId, agentSessions: s.agentSessions || {} } : {}),
    ...(s.agentHistoryBackfill ? { agentHistoryBackfill: true } : {}) };
}

async function migrateLegacySessions(legacy) {
  const index = [];
  const bodies = {};
  for (const s of legacy) {
    if (!s?.id) continue;
    const history = Array.isArray(s.history) ? s.history : [];
    bodies[sessionBodyKey(s.id)] = history;
    index.push(sessionIndexMeta(s, sessionTextDigest(history)));
  }
  await chrome.storage.local.set(bodies);
  await chrome.storage.local.set({ savedSessions: index });
  return index;
}

/** The single funnel every session read goes through: index + on-the-spot
 * legacy migration. Detection is free (the index read happens anyway); the
 * split runs at most once — after the rewrite no entry carries `.history`. */
async function readSessionIndex() {
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  if (!Array.isArray(savedSessions)) return [];
  if (savedSessions.some(s => s && Array.isArray(s.history))) {
    return await migrateLegacySessions(savedSessions);
  }
  return savedSessions;
}

// ─── Session index/body write serialization (2026-10-01 audit) ───────────────
// savedSessions 轻索引 + session_<id> 体积键的读-改-写与 history 键同病：两个
// 并发写者（后台流落快照的 appendToSessionHistory ↔ 抽屉的改名/置顶/删除，
// 以及切走时的 saveCurrentSession 自动存档）后写者整份覆盖先写者——改名丢失
// 或快照丢一整条回复。withHistoryLock 同款 promise 链，包住全部导出写者；
// 彼此互不调用（无嵌套死锁），readSessionIndex 保持无锁（含只读路径）。
let _sessionChain = Promise.resolve();
function withSessionLock(fn) {
  const run = _sessionChain.then(fn, fn);
  _sessionChain = run.then(() => {}, () => {});
  return run;
}

/** Save current history as a named session. Returns the session object. */
export async function saveCurrentSession(name) {
  return withSessionLock(async () => {
    const history = await getHistory();
    if (!history.length) return null;
    const id = crypto.randomUUID();
    const session = {
      id,
      name: (name || autoSessionName(history)).slice(0, 80),
      createdAt: Date.now(),
      history,
      ...await snapshotAgentSessions()
    };
    const savedSessions = await readSessionIndex();
    // Keep the newest MAX_SESSIONS entries, but evict oldest UNPINNED first:
    // the drawer hides the delete button on pinned rows — the storage layer
    // must keep the same promise, or silent cap-trimming destroys sessions the
    // user explicitly protected. Evicted sessions' BODY keys go with them.
    let updated = [...savedSessions, sessionIndexMeta(session, sessionTextDigest(history))];
    const evictedBodyKeys = [];
    if (updated.length > MAX_SESSIONS) {
      const excess = updated.length - MAX_SESSIONS;
      const kept = [];
      let dropped = 0;
      for (const s of updated) {
        if (!s.pinned && dropped < excess) { dropped++; evictedBodyKeys.push(sessionBodyKey(s.id)); continue; }
        kept.push(s);
      }
      updated = kept; // may exceed MAX_SESSIONS when pinned alone fill the cap
    }
    await chrome.storage.local.set({ [sessionBodyKey(id)]: history, savedSessions: updated });
    if (evictedBodyKeys.length) chrome.storage.local.remove(evictedBodyKeys).catch(() => {});
    return session;
  });
}

/**
 * Append ONE entry to a saved session's history snapshot in place — the
 * session-switch background-stream route (2026-09-24): once the user switches
 * conversations mid-turn, the live history is ANOTHER session's, so the reply
 * must land in the session the turn STARTED in (its snapshot was written by
 * the switch-away auto-save). Returns the updated session, or null when `id`
 * is unknown (deleted since) — the caller falls back to the live append.
 * Split-key win: this used to rewrite EVERY session's bytes for one append.
 */
export async function appendToSessionHistory(id, entry) {
  return withSessionLock(async () => {
    if (!id || !entry) return null;
    const savedSessions = await readSessionIndex();
    const idx = savedSessions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const key = sessionBodyKey(id);
    const stored = await chrome.storage.local.get(key);
    const history = [...(Array.isArray(stored[key]) ? stored[key] : []), entry];
    savedSessions[idx] = { ...savedSessions[idx], textDigest: extendSessionDigest(savedSessions[idx].textDigest, entry) };
    await chrome.storage.local.set({ [key]: history, savedSessions });
    return { ...savedSessions[idx], history };
  });
}

/**
 * Write the CURRENT live history back into an existing saved session, in
 * place (no new entry, name/createdAt/pinned untouched). Returns the updated
 * session, or null when `id` is unknown (e.g. the session was deleted since)
 * or the live history is empty — callers fall back to saveCurrentSession.
 */
export async function updateSessionHistory(id) {
  return withSessionLock(async () => {
    if (!id) return null;
    const history = await getHistory();
    if (!history.length) return null;
    const savedSessions = await readSessionIndex();
    const idx = savedSessions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    savedSessions[idx] = { ...savedSessions[idx], textDigest: sessionTextDigest(history), ...await snapshotAgentSessions() };
    await chrome.storage.local.set({ [sessionBodyKey(id)]: history, savedSessions });
    return { ...savedSessions[idx], history };
  });
}

/**
 * List all saved sessions (metadata only). When `q` is non-empty, keep only
 * sessions whose name OR message content contains the query (case-insensitive
 * substring — content via the index's textDigest, never the bodies) and flag
 * rows that matched on content alone — the drawer shows a small "matched in
 * content" hint there. Pinned sessions float to the top of the result
 * regardless of ordering; within each tier newest first.
 */
export async function getSavedSessions(q = '') {
  const savedSessions = await readSessionIndex();
  const query = String(q || '').trim().toLowerCase();
  let out = [...savedSessions].reverse().map((s) => {
    const meta = { id: s.id, name: s.name, createdAt: s.createdAt, pinned: !!s.pinned };
    if (!query) return meta;
    const nameMatch = typeof s.name === 'string' && s.name.toLowerCase().includes(query);
    let contentMatch = false;
    if (!nameMatch) {
      contentMatch = typeof s.textDigest === 'string' && s.textDigest.includes(query);
    }
    meta.contentMatch = contentMatch;
    return nameMatch || contentMatch ? meta : null;
  }).filter(Boolean);
  // Stable pin-first sort: pinned block precedes unpinned; relative order
  // inside each block stays reverse-chronological from the map above.
  const pinnedFirst = [];
  for (const s of out) if (s.pinned) pinnedFirst.push(s);
  for (const s of out) if (!s.pinned) pinnedFirst.push(s);
  return pinnedFirst;
}

/** Pin/unpin a saved session by id (index-only write — bodies untouched). */
export async function pinSession(id, pinned) {
  return withSessionLock(async () => {
    const savedSessions = await readSessionIndex();
    const updated = savedSessions.map(s => s.id === id ? { ...s, pinned: !!pinned } : s);
    await chrome.storage.local.set({ savedSessions: updated });
  });
}

/**
 * Load a saved session into the active history. Returns the restored history
 * length, or -1 when the id doesn't exist —— 0 是合法长度（空会话），未命中
 * 必须可区分，否则 handleSession 的 ok: len >= 0 恒真、点开失效会话假成功。
 */
export async function loadSession(id) {
  return withSessionLock(async () => {
    const savedSessions = await readSessionIndex();
    const session = savedSessions.find(s => s.id === id);
    if (!session) return -1;
    const key = sessionBodyKey(id);
    const stored = await chrome.storage.local.get(key);
    const history = Array.isArray(stored[key]) ? stored[key] : [];
    // Pre-fix snapshots never recorded thread IDs. Give them a stable, fresh
    // identity and backfill their text on the first turn of each new thread.
    const legacyRestored = !session.agentContextId || !!session.agentHistoryBackfill;
    if (!session.agentContextId) {
      session.agentContextId = crypto.randomUUID();
      session.agentSessions = {};
      session.agentHistoryBackfill = true;
      await chrome.storage.local.set({ savedSessions });
    }
    await withHistoryLock(async () => {
      await set('history', history);
      await replaceAgentSessionState({ contextId: session.agentContextId, ids: session.agentSessions || {}, legacyRestored });
    });
    return history.length;
  });
}

/** Delete a saved session by id (index entry + its body key). */
export async function deleteSession(id) {
  return withSessionLock(async () => {
    const savedSessions = await readSessionIndex();
    await chrome.storage.local.set({ savedSessions: savedSessions.filter(s => s.id !== id) });
    await chrome.storage.local.remove(sessionBodyKey(id));
  });
}

/** Rename a saved session (index-only write). */
export async function renameSession(id, newName) {
  return withSessionLock(async () => {
    const savedSessions = await readSessionIndex();
    const updated = savedSessions.map(s => s.id === id ? { ...s, name: newName.slice(0, 80) } : s);
    await chrome.storage.local.set({ savedSessions: updated });
  });
}

/** Delete ALL saved sessions (index + every body key). */
export async function clearAllSessions() {
  return withSessionLock(async () => {
    const savedSessions = await readSessionIndex();
    const bodyKeys = savedSessions.map(s => sessionBodyKey(s.id));
    await chrome.storage.local.set({ savedSessions: [] });
    if (bodyKeys.length) await chrome.storage.local.remove(bodyKeys);
  });
}

/** Get a single saved session including its full history (for export /
 * LOAD-adjacent full reads). Shape mirrors the pre-split session object. */
export async function getSessionFull(id) {
  const savedSessions = await readSessionIndex();
  const meta = savedSessions.find(s => s.id === id);
  if (!meta) return null;
  const key = sessionBodyKey(id);
  const stored = await chrome.storage.local.get(key);
  return { id: meta.id, name: meta.name, createdAt: meta.createdAt, pinned: !!meta.pinned, history: Array.isArray(stored[key]) ? stored[key] : [] };
}

export async function setContextMode(mode) {
  await set('contextMode', mode);
}
