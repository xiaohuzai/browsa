# ADR-0005: savedSessions 快照保留图片字节

- 状态：Accepted（2026-09-23 用户决定，效率审计提案被否）
- 来源：AGENTS.md lib/storage.js「savedSessions snapshots are verbatim」

## Context

效率审计发现：savedSessions 每条快照原样拷贝 history，含 ≤8MB 驻留图片 base64 ×50 条上限，
提议在保存时剥离/压缩图片。

## Decision

**保留图片字节，逐字快照。** 恢复会话后的第一轮回合要重发真实像素，保证「对图追问」可答。

## Consequences

- 存储体积换追问质量是有意的取舍；不要再提「保存时压缩/剥离图片」。
- 真正塑造模型视野的是**进行中对话**的请求侧压缩（`prepareHistoryForModel` + 条目 `imagesSeen`
  标记，见 ADR-0013；2026-09-23 起存储像素不再被改写）——该机制不受本决定影响，
  也不要拿它的存在当「所以快照可以压」的理由。
