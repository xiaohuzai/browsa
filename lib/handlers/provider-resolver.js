// lib/handlers/provider-resolver.js — shared provider-resolution logic that
// chat-handler.js and subchat-handler.js each independently duplicated
// verbatim (both resolve the active provider + validate baseUrl, and both
// parse temperature/maxTokens the same way). Extracted so a future change
// to either check only needs to happen once.

import { ProviderConfigError, DEFAULT_MAX_TOKENS } from '../llm-client.js';

/**
 * Resolves the active provider from a freshly-loaded `storage.getAll()`
 * result, throwing ProviderConfigError with the same messages both handlers
 * used before extraction.
 */
export function resolveProvider(all) {
  const provider = all.providers[all.activeProvider];
  if (!provider) throw ProviderConfigError(`Provider "${all.activeProvider}" not configured`);
  // Native-messaging agent providers (Codex) have NO baseUrl by design —
  // the connection is a locally-spawned engine discovered by the bridge, and
  // their real gate is the options-page Ping. A URL check here would block
  // every turn with "Base URL is not set" (real Mac test, 2026-09-02).
  const isNmAgent = !!provider.isCodex;
  if (!isNmAgent && !provider.baseUrl?.trim()) throw ProviderConfigError('Base URL is not set. Open Settings (⚙) and configure the provider.');
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

/**
 * 一个 provider 的模型 ID 全量列表（主页下拉按 Alias · model 逐个展示）。
 * provider.models（options 保存时按逗号拆分写入）优先，缺失时回退单个 model 字段
 * （老配置/手改存储的兼容形态）。去空、去重、保序。
 */
export function providerModelList(provider) {
  const list = Array.isArray(provider?.models)
    ? provider.models.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (list.length) return [...new Set(list)];
  const m = String(provider?.model || '').trim();
  return m ? [m] : [];
}

/**
 * 聊天实际使用的模型 ID：主页下拉在多模型 provider 上选中了具体模型
 * （all.activeModel）且它仍属于该 provider 时用它；否则回退 provider.model
 * （卡上第一个）。includes 校验挡住「切换 provider 后残留的旧 activeModel」——
 * 防止把 A 网关的模型 ID 静默发给 B 网关。
 */
export function resolveChatModel(provider, all) {
  const am = String(all?.activeModel || '').trim();
  if (am && providerModelList(provider).includes(am)) return am;
  return String(provider?.model || '').trim();
}
