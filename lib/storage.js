// lib/storage.js
// Tiny wrapper around chrome.storage.local for typed access.
// History is now a single global flat array (not per-tab), matching how
// Sider/Monica/MaxAI all operate — one shared conversation across tabs.

import { PAGE_CONTEXT_PREFIX } from './constants.js';

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

const DEFAULTS = {
  providers: {
    hermes:       { type: 'agent', baseUrl: 'http://101.47.17.208:8642', apiKey: '', model: '', stream: true, isHermes: true, temperature: null, maxTokens: 0 },
    compatible:   { type: 'llm',   baseUrl: '',                          apiKey: '', model: '', stream: true, isHermes: false, temperature: null, maxTokens: 0 },
  },
  activeProvider: 'hermes',
  pingStates: {},  // { [providerName]: 'reachable' | 'unreachable' }
  history: [],         // flat global array: [{ role, content }, ...]
  contextMode: 'auto',
  maxTextChars: 0,
  autoSummarizeAttachments: true,  // chunk/summarize/merge very long attachments before they enter history
  summarizeThresholdChars: 0,      // 0 = use the built-in 40,000-char default (see lib/handlers/attach-summarizer.js)
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  // 火山方舟录音文件识别（ASR）配置 — 无字幕 B站视频 attach 时转写音频生成字幕。
  // 与 lib/handlers/attach-asr.js 的 ASR_DEFAULTS 保持同步（storage 是配置入口，
  // attach-asr 是纯逻辑，字段默认值两边一致）。
  asr: {
    enabled: false,
    apiKey: '',                                    // ark.cn-beijing.volces.com Bearer key
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-0-lite-260428',          // 已开通的音频理解/ASR 模型 ID
    language: 'zh',
    format: 'audio/x-m4a',                         // 上传 MIME（08-16 起 sidepanel 固定转码成 WAV 上传，此字段仅 legacy downloadAndUploadAudio 使用）
    timeoutMs: 150_000,
  },
  replyLanguage: '', // '' = auto, 'en', 'zh', 'ja', etc.
  llmsTxtEnabled: true  // fetch llms.txt from page origin before each chat
};

const MAX_HISTORY = 60;
const MAX_TOTAL_CHARS = 300_000;

export async function getAll() {
  const stored = await chrome.storage.local.get(null);
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
  return { ...DEFAULTS, ...stored, providers: mergedProviders };
}

export async function get(key) {
  const v = await chrome.storage.local.get(key);
  return v[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function setActiveProvider(name) {
  await set('activeProvider', name);
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
}

export async function appendToHistory(message) {
  const current = await getHistory();
  current.push(message);
  await setHistory(current);
}

export async function clearHistory() {
  await set('history', []);
}

export async function removeHistoryEntryByIndex(index) {
  const current = await getHistory();
  if (index < 0 || index >= current.length) return false;
  current.splice(index, 1);
  await setHistory(current);
  return true;
}

// Remove all history entries from `index` onward (inclusive).
export async function truncateHistoryFromIndex(index) {
  const current = await getHistory();
  if (index < 0) return false;
  await setHistory(current.slice(0, index));
  return true;
}

export async function removeLastPageContext() {
  const current = await getHistory();
  for (let i = current.length - 1; i >= 0; i--) {
    const m = current[i];
    const isCtx =
      (typeof m.content === 'string' && m.content.startsWith(PAGE_CONTEXT_PREFIX)) ||
      (Array.isArray(m.content) && m.content[0]?.text?.startsWith(PAGE_CONTEXT_PREFIX));
    if (m.role === 'user' && isCtx) {
      current.splice(i, 1);
      await setHistory(current);
      return i; // return the removed index so callers can shift data-hidx
    }
  }
  return -1;
}


// ─── Hermes session identity (X-Hermes-Session-Id / session_id) ───────────────
// hermes-webui always sends a stable session_id (as both a header and a body
// field) on every /v1/runs request. browsa's runsApiStream didn't send one at
// all, which may explain behavioral differences (e.g. tool permission scoping)
// between the two clients talking to the same Hermes instance. Stored in
// chrome.storage.session (survives SW restarts, not browser restarts — same
// lifetime as a chat session). Reset alongside history so a new conversation
// gets a fresh identity.
export async function getOrCreateHermesSessionId(providerName) {
  const key = `hermesSessionId_${providerName}`;
  const res = await chrome.storage.session.get(key).catch(() => ({}));
  if (res[key]) return res[key];
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: id }).catch(() => {});
  return id;
}

export async function resetHermesSessionId(providerName) {
  const key = `hermesSessionId_${providerName}`;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: id }).catch(() => {});
  return id;
}


// ─── Session management ───────────────────────────────────────────────────────
// Sessions are lightweight metadata + full history snapshots stored in
// chrome.storage.local as a flat array, keyed by auto-generated UUIDs.
// The CURRENT (live) conversation lives in the standard `history` key.
// Saving a session archives the current history with a name and timestamp.

const MAX_SESSIONS = 50;

/** Auto-generate a session name from the first user message in a history. */
function autoSessionName(history) {
  const first = history.find(
    m => m.role === 'user' && typeof m.content === 'string' &&
         !m.content.startsWith(PAGE_CONTEXT_PREFIX)
  );
  if (first) {
    const text = (first.content || '').trim().slice(0, 48);
    return text.length < (first.content || '').trim().length ? text + '…' : text;
  }
  return new Date().toLocaleDateString();
}

/** Save current history as a named session. Returns the session object. */
export async function saveCurrentSession(name) {
  const history = await getHistory();
  if (!history.length) return null;
  const id = crypto.randomUUID();
  const session = {
    id,
    name: (name || autoSessionName(history)).slice(0, 80),
    createdAt: Date.now(),
    history
  };
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  // Keep newest MAX_SESSIONS entries
  const updated = [...savedSessions, session].slice(-MAX_SESSIONS);
  await chrome.storage.local.set({ savedSessions: updated });
  return session;
}

/** List all saved sessions (metadata only, no history). */
export async function getSavedSessions() {
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  // Return in reverse-chronological order (newest first)
  return [...savedSessions].reverse().map(({ id, name, createdAt }) => ({ id, name, createdAt }));
}

/** Load a saved session into the active history. Returns the restored history length. */
export async function loadSession(id) {
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  const session = savedSessions.find(s => s.id === id);
  if (!session) return 0;
  await set('history', session.history || []);
  return (session.history || []).length;
}

/** Delete a saved session by id. */
export async function deleteSession(id) {
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  await chrome.storage.local.set({ savedSessions: savedSessions.filter(s => s.id !== id) });
}

/** Rename a saved session. */
export async function renameSession(id, newName) {
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  const updated = savedSessions.map(s => s.id === id ? { ...s, name: newName.slice(0, 80) } : s);
  await chrome.storage.local.set({ savedSessions: updated });
}

/** Delete ALL saved sessions. */
export async function clearAllSessions() {
  await chrome.storage.local.set({ savedSessions: [] });
}

/** Get a single saved session including its full history (for export). */
export async function getSessionFull(id) {
  const { savedSessions = [] } = await chrome.storage.local.get('savedSessions');
  return savedSessions.find(s => s.id === id) || null;
}

export async function setContextMode(mode) {
  await set('contextMode', mode);
}
