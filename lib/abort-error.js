// lib/abort-error.js — 取消分类的唯一 owner（2026-11-03 审计 sw-2 + proto-1）。
// chat-handler 与 subchat-handler 共用；刻意不放 llm-client——subchat 不该为
// 一个谓词耦合整个协议层。
//
// 判据（两条，勿加第三条）：
// - signal?.aborted：权威。controller.abort('user-cancel') 以裸字符串 reason
//   让 fetch/throwIfAborted reject（字符串没有 .name/.message），形状判别会把
//   干净取消当成真实错误。新增 adapter 不再依赖各自把字符串规整成 AbortError
//   才能正确分类（各 client 的规整保留为纵深防御）。
// - e?.name === 'AbortError'：嵌套 controller 超时（AbortSignal.timeout 等，
//   本回合 signal 未 aborted）仍靠它，勿删。
// 刻意不做 /aborted/i 文案兜底：真实 provider/agent 错误消息含 "aborted"
// （如 bridge 的 'tool execution aborted by upstream provider'）会被误判为
// 用户取消——错误卡消失、partial 以 interrupted 落库、返回 ok。
// Tests: test/abort.test.mjs（判据执行 + 双 handler 接线 pin）、
// test/subchat.test.mjs / test/chat-turn-ownership.test.mjs（handler 层地板）。
export function isAbortError(signal, e) {
  return Boolean(signal?.aborted) || e?.name === 'AbortError';
}