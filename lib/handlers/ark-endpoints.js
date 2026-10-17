// lib/handlers/ark-endpoints.js — the Ark (Volcengine) API base URL contract,
// shared by attach-asr.js (Files/ASR calls) and attach-asr-media.js (upload).
// Split out 2026-10-17 so the media module could move without creating an
// import cycle back into attach-asr.js.

export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 把方舟 Base URL 规整到标准版端点（纯函数）。
 *
 * 2026-08-15 实机发现：用户配置里填了 https://ark.cn-beijing.volces.com/api/plan/v3 —— 那是火山
 * 方舟 Agent Plan（给 Hermes 等 Coding Agent 用的 OpenAI 兼容接口）的专属 Base URL，
 * 它没有 Files API（上传 /files 返回 404）。Files API 上传端点只在标准版 …/api/v3 上。
 * 这里把 api/plan 版自动回退到 api/v3，让已存了 plan 版配置的用户无需手动改就能恢复；新保存的
 * 配置由 options.js saveAsr 的校验拦截（见 options.html 的 Base URL 提示）。
 */
export function normalizeArkBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim();
  if (!b) return ARK_DEFAULT_BASE_URL;
  // 兼容 …/api/plan/v3、…/api/plan、…/api/plan/v3/ 等变体
  return b.replace(/\/api\/plan(?:\/v\d+)?\/?$/, '/api/v3');
}

export function arkExpireAtSec(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000) + 30 * 86400;
}
