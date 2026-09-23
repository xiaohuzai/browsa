# ADR-0006: 每个输入面一个独立召回域，两域不合

- 状态：Accepted（2026-09-21 用户明确方向）
- 来源：AGENTS.md composer-state.js「One recall SCOPE per input surface」

## Context

主 composer 与追问卡各有 ↑/↓ 历史召回。曾共用一份列表。

## Decision

**一个输入面一个召回域**：主 composer 用模块级导出（含草稿持久化）；追问卡自建
`subchatInputHistory`（只存 history，无草稿；**跨卡片共享**一份，面板重建后仍可召回）。
↑ 在追问卡里只召回追问发过的问题，主输入历史**永不**进卡。

## Consequences

- 不要「为了简单」把两域合并——这是用户点名的方向。
- 域内行走态按输入元素 WeakMap 各存各的（单例会把 A 框的草稿泄漏进 B 框）；新输入面照此开新域。
