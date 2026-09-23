# ADR-0011: 流式渲染块级提交；不采用 vendor 增量解析器

- 状态：Accepted（2026-09-23 用户指令的块级增量化）
- 来源：AGENTS.md「Blockwise incremental streaming render」

## Context

流式路径曾每 reveal 帧全量重渲染累积文本（O(n²)，长回复+长思考块时每帧 MB 级重解析）。
vendored `stream-markdown-parser` 自带增量解析器，直觉上该用它。

## Decision

1. 改为**块级提交**：完成的 markdown 块只提交一次（`findStreamingBlockBoundary` 找安全切点），
   每帧只重解析开口尾巴；DONE 仍全量 `renderSafe` 兜底。
2. **不采用 vendor 的增量解析器**（evaluated first, deliberately NOT used）：它输出的是
   组件树渲染器用的 AST、不产 HTML，采用=重写整层渲染；块级缓存 + 现有 marked 能保持
   HTML 形状逐字节不变。

## Consequences

- 不要再提「换 markstream 的增量 parser」；要提速走块级缓存路线。
- 前缀提交安全的三条不变式（partial `<think` 无换行→永远在开口尾巴、display 前缀稳定、
  DONE 全量兜底）改动渲染层时必须保持。
