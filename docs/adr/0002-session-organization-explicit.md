# ADR-0002: 会话组织显式化——tab 级会话与 context receipt 双双否决

- 状态：Accepted（两项均完整删除，非禁用）（2026-09-05 用户决定）
- 来源：AGENTS.md「Session-organization philosophy (two explicit user rejections)」

## Context

两个曾建好的功能被用户否决并彻底删除：
1. **tab 级会话切换**（顶栏开关、切 tab 自动换对话）；
2. **每条消息的 context receipt**（「本次发送了什么」可折叠回执）。

## Decision

- 全局单一对话是**有意的默认形态**；用户要组织对话时用会话抽屉**显式**新建/切换（新话题=新会话）。
- 发送内容的检查面只保留附件 chip 上的「检查/撤销」。

## Consequences

- 自动切换对话剥夺用户控制权——凡「随 tab/上下文自动切换对话面」的设计一律不做。
- 回执类 UI 不再做——用户判定不实用；附件 chip 是唯一检查入口。
- 不要以「恢复了功能」的名义重新提出这两项。
