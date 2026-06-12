// lib/storage.js
// Tiny wrapper around chrome.storage.local for typed access.
// History is now a single global flat array (not per-tab), matching how
// Sider/Monica/MaxAI all operate — one shared conversation across tabs.

const DEFAULTS = {
  providers: {
    hermes: { baseUrl: 'http://101.47.17.208:8642', apiKey: '', defaultModel: 'hermes-agent', stream: true },
    'claude-code': { baseUrl: 'http://localhost:8000', apiKey: '', defaultModel: 'claude-sonnet-4-6', stream: true }
  },
  activeProvider: 'hermes',
  history: [],         // flat global array: [{ role, content }, ...]
  contextMode: 'reader',
  maxTextChars: 0
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

export async function setHistory(messages) {
  let trimmed = messages.slice(-MAX_HISTORY);
  let total = trimmed.reduce((n, m) => n + (m.content?.length || 0), 0);
  while (total > MAX_TOTAL_CHARS && trimmed.length > 1) {
    total -= (trimmed[0].content?.length || 0);
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

export async function setContextMode(mode) {
  await set('contextMode', mode);
}
