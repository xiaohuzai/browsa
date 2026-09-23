# ADR-0001: 媒体下载 UI 删除，不再恢复

- 状态：Accepted（2026-09-05 已删除）
- 来源：AGENTS.md「Media download UI — REMOVED」

## Context

composer 页脚曾有 ⬇ 媒体下载按钮 + 流选择浮层（`GET_MEDIA_STREAMS`/`DOWNLOAD_MEDIA` 全链路）。
现场反复失败：Chrome 对 `chrome.downloads` 请求的自定义 header 不可靠注入（「无法从网站上提取文件」），
YouTube 另有 googlevideo PO-token 反爬。

## Decision

整个下载路径（UI + SW handler + media-downloader）**已删除，不再恢复**。

## Consequences

- 下载能力属扩展核心循环之外的边路功能，可靠性被第三方 CDN 要挟；自配能力强的用户本来就有 cat-catch/yt-dlp。
- **不受影响**：ASR/精读管线（喂给模型媒体的那套 fetch + `media-headers.js`）保留自己的抓取机器。
- 未来的架构评审不要再提「恢复/重做媒体下载」；若真要重启，先解决 header 注入与 PO-token 两个硬前提。
