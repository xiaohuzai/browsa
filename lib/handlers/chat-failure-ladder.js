// lib/handlers/chat-failure-ladder.js — handleChat 重试阶梯的纯决策单点
//（2026-11-11 深化）。此前阶梯顺序（reasoning 剥字段先于 overflow 自救）与
// 一次性预算只活在 700 行函数 catch 块的语句序里，测试只能整回合 mock 驱动。
// 这里只回答「这个失败下一步做什么」；副作用（push/reset/rebuild/记忆写入）
// 全部留在 handler。subchat 有意不进此阶梯（ADR-0007），勿并入。
// 谓词（isReasoningRejection / isContextOverflowError）经参数注入而非 import：
// 它们的定义点在 chat-handler，反向 import 会成环；注入也让表驱动测试无需
// chrome mock。abort 判据（signal 权威 + 具名 AbortError）由 handler 传入。
// Tests: test/chat-failure-ladder.test.mjs（表驱动钉顺序与预算）。

/**
 * @param {Error} e 流式尝试抛出的错误
 * @param {object} state
 *   attempt            当前瞬态尝试序号（1-based；strip/stub 重试经 handler
 *                      attempt-- 不消耗它）
 *   maxRetries         瞬态重试预算（MAX_RETRIES=2 → attempt 1..3）
 *   reasoningStripped  本回合是否已剥过 reasoning 字段（一次性）
 *   overflowRescued    本回合是否已做过 overflow 裁剪（一次性）
 *   stateless          provider 是否带 reasoning body 字段（agent 家族 false）
 *   overflowRescuable  重发更小 prompt 能否救（bridge/opencode 服务端存
 *                      transcript，false）
 *   isAbort            handler 的 classifyAbortError(signal, e) 结果——
 *                      字符串 reason 的 abort 也算（P0：signal 权威）
 * @returns {'abort'|'strip-reasoning'|'stub-overflow'|'retry'|'fail'}
 */
export function classifyTurnFailure(e, {
  attempt, maxRetries, reasoningStripped, overflowRescued,
  stateless, overflowRescuable, isAbort,
}, { isReasoningRejection, isContextOverflowError }) {
  if (isAbort) return 'abort';
  // reasoning 拒绝先于 overflow：点名 reasoning 字段的 400/422 是比通用
  // 「context length」模板更具体的判决——overflow 先行会白白丢掉附件精度。
  if (!reasoningStripped && stateless && isReasoningRejection(e)) return 'strip-reasoning';
  if (!overflowRescued && overflowRescuable && isContextOverflowError(e?.message)) return 'stub-overflow';
  const retryable = e?.name === 'ProviderNetworkError'
    || (e?.name === 'ProviderAPIError' && e?.message?.includes('429'));
  if (retryable && attempt <= maxRetries) return 'retry';
  return 'fail';
}
