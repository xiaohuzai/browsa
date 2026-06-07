// lib/storage.js
// Tiny wrapper around chrome.storage.local for typed access.
// All extension state lives here so the rest of the code never touches chrome.* directly.

const DEFAULTS = {
  providers: {
    hermes: { baseUrl: 'http://101.47.17.208:8642', apiKey: '', defaultModel: 'hermes-agent', stream: true },
    'claude-code': { baseUrl: 'http://localhost:8000', apiKey: '', defaultModel: 'claude-sonnet-4-6', stream: true },
    openclaw: { baseUrl: 'http://localhost:8080', apiKey: '', defaultModel: 'openai/gpt-5.5', stream: true }
  },
  activeProvider: 'hermes',
  // Conversation history (multi-turn). Keyed by tab id, capped to MAX_HISTORY messages.
  history: {}, // { [tabId]: [{ role, content }, ...] }
  // Page context options
  contextMode: 'full', // 'full' | 'selected' | 'screenshot' | 'summary'
  autoAttachPage: true
};

const MAX_HISTORY = 40;
const HISTORY_PREFIX = 'history:'; // history:[tabId] if we ever want per-tab namespacing

export async function getAll() {
  const stored = await chrome.storage.local.get(null);
  // Merge defaults so missing keys exist
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
  if (!provider) {
    throw new Error(`Active provider "${name}" not configured. Open Options.`);
  }
  return { name, ...provider };
}

export async function setActiveProvider(name) {
  await set('activeProvider', name);
}

export async function getHistory(tabId) {
  const all = await getAll();
  return (all.history && all.history[String(tabId)]) || [];
}

export async function setHistory(tabId, messages) {
  const all = await getAll();
  const trimmed = messages.slice(-MAX_HISTORY);
  all.history[String(tabId)] = trimmed;
  await set('history', all.history);
}

export async function appendToHistory(tabId, message) {
  const current = await getHistory(tabId);
  current.push(message);
  await setHistory(tabId, current);
}

export async function clearHistory(tabId) {
  const all = await getAll();
  delete all.history[String(tabId)];
  await set('history', all.history);
}

export async function setContextMode(mode) {
  await set('contextMode', mode);
}
