# ADR-0010: CAPABILITY_HINTS 体积冻结；图表渲染器自动渲染不加按钮

- 状态：Accepted（2026-09-16 评估后拍板）
- 来源：AGENTS.md「System prompt economics」与 renderMarkmap 小节

## Context

1. CAPABILITY_HINTS（教模型发 mermaid/echarts/markmap/smiles/pdb/nn 围栏的提示文本）≈1.4K token/轮，
   有压缩提案。
2. 围栏渲染器家族（mermaid/echarts/markmap/…）是「模型发围栏、渲染层检测语言自动替换」的模式，
   无任何新 UI 按钮；有提案给 markmap 等加显式按钮。

## Decision

1. CAPABILITY_HINTS **维持现状**：它是模型与渲染层之间的接口契约，不是可裁的 few-shot；
   AGENT_RENDER_HINT 与它互为镜像，改动要两侧同步。
2. 渲染器**自动渲染、不加 UI 按钮**——能力暴露靠提示契约，不靠按钮发现。

## Consequences

- 不要再提压缩/重构 CAPABILITY_HINTS；新增渲染器时契约行是必须项。
- 评审不要提「给图表加导出/切换按钮入口」（块内 hover 工具条已有，那是渲染器自带的，不算入口）。
