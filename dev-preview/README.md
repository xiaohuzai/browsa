# dev-preview — 在真实浏览器里预览扩展页面（无需加载扩展）

`sidepanel.html` / `options.html` 依赖 `chrome.*` API，无法直接用浏览器打开。
本目录用一个 chrome API shim 让它们在普通 HTTP 服务下完整渲染：

```
node dev-preview/gen.mjs        # 从 sidepanel.html / options.html 重新生成 *.preview.html（改完源 HTML 后重跑）
python3 -m http.server 8931     # 仓库根目录起服务
# 浏览器打开 http://127.0.0.1:8931/dev-preview/sidepanel.preview.html
```

- `chrome-shim.js` — chrome.storage / runtime.sendMessage（回调+Promise 双形态）/ tabs / cookies 等
  的最小实现；`sendMessage` 按 `msg.type` 返回 `{ok, data}` 信封。
- `seed.js` — 预置的 provider 配置与一段富 Markdown 历史（表格/代码/公式/Mermaid/`<think>` 块/时间戳），
  覆盖聊天 UI 的主要渲染路径。改 seed 只需刷新页面。
- `*.preview.html` — 生成物，不要手改（会被 gen.mjs 覆盖）。

截图（无显示器环境）：

```js
// /tmp/pwshot 模式：npm i playwright-core，指向 ms-playwright 的 chromium 二进制
// 截图务必走 CDP：client.send('Page.captureScreenshot', {captureBeyondViewport})
// ⚠ Playwright 自带的 page.screenshot() 在 colorScheme:dark 下偶发渲染成浅色
//   （DOM 计算样式仍是暗色）——是截图管线伪影，不是页面 bug。
```

预览环境的 shim 只覆盖了 UI 初始化所需的 API；发消息、附件等交互需要按需扩展 shim。
