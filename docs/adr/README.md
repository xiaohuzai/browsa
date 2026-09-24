# ADR — 架构决策记录

每条 ADR 固化一个**已拍板的决定及其 why**，供未来的架构评审/重构不重复翻案。
事实与实现细节仍以 AGENTS.md 为准；本目录只收「关门」的决定。

| # | 决定 | 日期 |
|---|---|---|
| [0001](0001-media-download-ui-removed.md) | 媒体下载 UI 删除，不再恢复 | 2026-09-05 |
| [0002](0002-session-organization-explicit.md) | 会话组织显式化：tab 级会话与 context receipt 双双否决 | 2026-09-05 |
| [0003](0003-techniques-not-signature-features.md) | 移植规则：借技法不借招牌功能（双语字幕视图已建又撤） | 2026-09-05 |
| [0004](0004-thinking-default-omit-and-echo-guard.md) | thinking 默认 omit 红线；runs echo guard 是正确的 | 2026-09-11/12 |
| [0005](0005-saved-sessions-keep-image-bytes.md) | savedSessions 快照保留图片字节 | 2026-09-23 |
| [0006](0006-input-history-recall-scopes.md) | 每个输入面一个独立召回域，两域不合 | 2026-09-21 |
| [0007](0007-subchat-diverges-from-turn-request.md) | subchat 故意不并入 turn-request 阶梯 | 2026-09-20 |
| [0008](0008-vendor-loading-constraints.md) | vendor 加载三约束（3Dmol script-tag / wasm glue 原样拷 / office 不预热） | 2026-09-13/20 |
| [0009](0009-main-world-nested-helpers.md) | MAIN-world 注入函数的 helper 必须内嵌 | 2026-09-20 |
| [0010](0010-capability-hints-frozen-renderers-auto.md) | CAPABILITY_HINTS 体积冻结；图表渲染器自动渲染不加按钮 | 2026-09-16 |
| [0011](0011-streaming-render-block-commit.md) | 流式渲染块级提交；不采用 vendor 增量解析器 | 2026-09-23 |
| [0012](0012-efficiency-pass-wontfix-list.md) | 效率审计 wontfix 清单（取舍已定，勿重报） | 2026-09-23 |
| [0013](0013-history-images-display-fidelity.md) | 历史图片像素永不销毁——压缩只在请求侧 | 2026-09-23 |
