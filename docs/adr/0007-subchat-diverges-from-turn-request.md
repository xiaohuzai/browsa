# ADR-0007: subchat 故意不并入 turn-request 阶梯

- 状态：Accepted（2026-09-20 重构 pass 明示）
- 来源：AGENTS.md「subchat-handler deliberately does NOT use this module」

## Context

`lib/handlers/turn-request.js` 把主聊天的四条请求形状阶梯收敛为一个对象。
subchat-handler 有一套平行阶梯，未并入。

## Decision

**不并入。** subchat 的阶梯是**有意分叉**：Hermes 走 DEDICATED per-subId 会话
（`subchatHermesSessions`，绝不碰主聊天的 storage 级 hermesSessionId），
`test/subchat.test.mjs` 用 `doesNotMatch(/getOrCreateHermesSessionId/)` 钉死这一点。

## Consequences

- 合并两套阶梯前必须先重审该测试 pin 与「per-subId 会话」的产品语义。
- 评审不要把「chat/subchat 阶梯重复」当无脑收敛项——收敛的合法入口是「抽取共享的请求形状
  builder」（message-builder 方向），不是让 subchat 用 turn-request。
