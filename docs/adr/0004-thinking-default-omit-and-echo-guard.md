# ADR-0004: thinking 默认 omit 红线；runs 的 echo guard 是正确的

- 状态：Accepted（2026-09-11/12 实测验证）
- 来源：AGENTS.md「Reasoning-model thinking + the thinking option」与「runs reasoning truth」

## Context

1. 无状态流（chat/runs/responses/anthropic）支持 `thinking: 'inline'|'omit'`。主聊天与追问卡要
   实时可折叠思考块，其余消费者（attach-summarizer/mermaid-repair/selection-explain/agentic-extract）
   要干净文本。
2. Hermes `/v1/runs` 的唯一推理载体 `reasoning.available` 是 ≤500 字符的**答案内容重放**
   （`_relay_thinking(assistant_message.content)`），单步回合与已流式文本逐字节相同。

## Decision

1. `thinking` 默认 `'omit'` 是**红线**：只有 chat-handler 与 subchat-handler 传 `'inline'`，不得翻默认。
2. llm-client 对 `reasoning.available` 的 echo guard（丢弃重放）是**正确行为**，显示它会重复答案——
   不要「修」这个 guard。真推理要露出需要 Hermes 侧 patch（reasoning_callback → tool_progress），
   那是另一条产品决定的路。

## Consequences

- 新增 LLM 消费者一律用 omit 默认；「为什么思考块不显示」的排查先看调用方有没有显式传 inline。
- 评审不要把 echo guard 当 bug 报。
