// lib/handlers/provider-resolver.js — shared provider-resolution logic that
// chat-handler.js and subchat-handler.js each independently duplicated
// verbatim (both resolve the active provider + validate baseUrl, and both
// parse temperature/maxTokens the same way). Extracted so a future change
// to either check only needs to happen once.

import { ProviderConfigError, DEFAULT_MAX_TOKENS } from '../openai-client.js';

/**
 * Resolves the active provider from a freshly-loaded `storage.getAll()`
 * result, throwing ProviderConfigError with the same messages both handlers
 * used before extraction.
 */
export function resolveProvider(all) {
  const provider = all.providers[all.activeProvider];
  if (!provider) throw ProviderConfigError(`Provider "${all.activeProvider}" not configured`);
  if (!provider.baseUrl?.trim()) throw ProviderConfigError('Base URL is not set. Open Settings (⚙) and configure the provider.');
  return provider;
}

/**
 * Parses a provider's temperature/maxTokens config fields into the shape
 * chatStream()/runsApiStream() expect: `temperature` is `undefined` when
 * unset (so the API's own default applies), `maxTokens` falls back to
 * DEFAULT_MAX_TOKENS (16384) when unset/0 — a generous output budget so
 * long replies aren't silently cut at the server's default cap (the ASR
 * truncation lesson applied to chat output). An explicit provider-level
 * maxTokens overrides it; the provider still clamps to the model's hard cap.
 */
export function resolveInferenceParams(provider) {
  const temperature = (provider.temperature != null && provider.temperature !== '') ? Number(provider.temperature) : undefined;
  const maxTokens = provider.maxTokens ? Number(provider.maxTokens) : DEFAULT_MAX_TOKENS;
  return { temperature, maxTokens };
}
