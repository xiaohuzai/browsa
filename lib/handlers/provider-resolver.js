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

/**
 * bridge provider 实际请求的端点地址。多桥形态下「模型槽」存的是端点 URL
 * （options 卡一行一个端点，保存时逐行写进 models，一桥一 agent、/health 的
 * agent 字段即 alias），主页下拉逐端点展开、选中项落 activeModel——所以
 * 端点解析与 resolveChatModel 完全同构，只是语义不同，独立命名让调用点可读。
 * 老配置（models 为空）回退 provider.model（=保存时的首个 URL）→ baseUrl。
 */
export function resolveBridgeEndpoint(provider, all) {
  return resolveChatModel(provider, all) || String(provider?.baseUrl || '').trim();
}

/**
 * bridge provider 在某个端点上要用的 API Key。桥可以各要各的 token
 * （options 卡一行一个端点、一行一个 key，存 provider.bridgeApiKeys），所以
 * 这张表非空时就是权威：端点不在表里 = 该桥无 key，绝不回落到卡级 apiKey
 * ——那会把 A 桥的 token 发给 B 桥。老配置没有这张表（单 key 时代，一个 key
 * 对所有端点生效）才回落到卡级 apiKey。
 */
export function resolveBridgeApiKey(provider, endpoint) {
  const map = provider?.bridgeApiKeys;
  if (map && Object.keys(map).length) return map[endpoint] || '';
  return String(provider?.apiKey || '');
}
