// lib/provider-display.js — the ONE naming scheme for provider/agent entries,
// shared by the sidebar dropdown (sidepanel.js's populateProviderSelect) and
// the reply-source stamp (chat-handler stamps every assistant turn; the
// sidepanel renders it on the bubble). The "Alias · suffix" logic used to
// live only in the dropdown — but a reply stamp is only useful if it names
// the provider EXACTLY as the dropdown does, so the logic lives here: an
// honestly-named common layer, not a copy.

/** Display name for a provider card: the user-set alias wins; fixed agent
 * cards fall back to their well-known names; user-added LLM cards to
 * "LLM <n>"; anything else to a capitalized key. */
export function providerDisplayName(name, pcfg) {
  const alias = pcfg?.alias;
  if (alias && alias.trim()) return alias.trim();
  if (name === 'hermes') return 'Hermes Agent';
  const m = /^llm-(\d+)$/.exec(name);
  if (m) return `LLM ${m[1]}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Entry suffix for one selection of the card: LLM cards show the model id;
 * bridge cards show the per-endpoint agent alias discovered at Ping time
 * (/health.agent), falling back to host:port when never pinged; single-
 * session agent cards (Hermes / opencode) have no suffix. */
export function providerEntrySuffix(pcfg, model) {
  if (!model) return '';
  if (pcfg?.isBridge) return pcfg.bridgeAgents?.[model] || String(model).replace(/^https?:\/\//, '');
  if ((pcfg?.type || 'llm') === 'llm') return model;
  return '';
}

/** The full entry label — exactly what the dropdown shows for one selection
 * and what a reply stamp carries: "Alias · suffix", or the bare display
 * name when there is no suffix. */
export function providerEntryLabel(name, pcfg, model) {
  const display = providerDisplayName(name, pcfg);
  const suffix = providerEntrySuffix(pcfg, model);
  return suffix ? `${display} · ${suffix}` : display;
}
