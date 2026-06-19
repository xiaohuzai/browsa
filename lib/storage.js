// lib/storage.js
// Tiny wrapper around chrome.storage.local for typed access.
// History is now a single global flat array (not per-tab), matching how
// Sider/Monica/MaxAI all operate — one shared conversation across tabs.

export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. ' +
  'When writing mathematical expressions or formulas, always use LaTeX notation: ' +
  'wrap inline math with $...$ and display/block math with $$...$$';

const DEFAULTS = {
  providers: {
    hermes: { baseUrl: 'http://101.47.17.208:8642', apiKey: '', stream: true, useResponsesApi: true },
    'claude-code': { baseUrl: 'http://localhost:8000', apiKey: '', stream: true, useResponsesApi: false }
  },
  activeProvider: 'hermes',
  history: [],         // flat global array: [{ role, content }, ...]
  contextMode: 'reader',
  maxTextChars: 0,
  systemPrompt: DEFAULT_SYSTEM_PROMPT
};

const MAX_HISTORY = 60;
const MAX_TOTAL_CHARS = 300_000;

export async function getAll() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...stored, providers: { ...DEFAULTS.providers, ...(stored.providers || {}) } };
}

export async function get(key) {
  const v = await chrome.storage.local.get(key);
  return v[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getActiveProvider() {
  const all = await getAll();
  const name = all.activeProvider || 'hermes';
  const provider = all.providers[name];
  if (!provider) throw new Error(`Active provider "${name}" not configured. Open Options.`);
  return { name, ...provider };
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
      (typeof m.content === 'string' && m.content.startsWith('[Page context attached by browsa]')) ||
      (Array.isArray(m.content) && m.content[0]?.text?.startsWith('[Page context attached by browsa]'));
    if (m.role === 'user' && isCtx) {
      current.splice(i, 1);
      await setHistory(current);
      return i; // return the removed index so callers can shift data-hidx
    }
  }
  return -1;
}

// Conversation ID for Hermes /v1/responses stateful sessions.
// Each provider gets a UUID stored in chrome.storage.session (survives SW
// restarts but not browser restarts — appropriate for chat sessions).
// On history clear, a new UUID is generated so the next conversation starts fresh.
export async function getOrCreateConversationId(providerName) {
  const key = `convId_${providerName}`;
  const res = await chrome.storage.session.get(key).catch(() => ({}));
  if (res[key]) return res[key];
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: id }).catch(() => {});
  return id;
}

export async function resetConversationId(providerName) {
  const key = `convId_${providerName}`;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: id }).catch(() => {});
  return id;
}

export async function setContextMode(mode) {
  await set('contextMode', mode);
}
