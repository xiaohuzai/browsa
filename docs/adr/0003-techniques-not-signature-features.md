# ADR-0003: 移植规则——借技法，不借招牌功能

- 状态：Accepted（2026-09-05 确立；双语对齐字幕视图已建又撤）
- 来源：AGENTS.md transcript-drawer「Provenance & positioning boundary」

## Context

视频时间线（时间戳行/播放跟随/记一笔）移植自 zarazhangrui/youtube-digest 的**技法**，
但该产品定位是语言学习工具。browsa 跟进做了一个双语对齐字幕视图，做完即撤（未推送）。

## Decision

- **被移植 repo 的内部 TECHNIQUES 可以借**（例：youtube-digest 的章节覆盖提示锚 → `coverageHintEn/Zh`）。
- **同赛道产品的招牌功能不借**（双语对齐字幕、带时间戳的生词本等学习工具形态）。
- 翻译需求归聊天路径（模型读全上下文、按用户语言回答，优于逐行机翻反复烧 token）；时间线忠实记录说过的话。

## Consequences

- 评审/移植作业遇到「上游有此功能」时，先问：这是技法还是招牌？
- 招牌功能要移植，须先得到产品定位层面的新决定（此 ADR 需被显式重开）。
