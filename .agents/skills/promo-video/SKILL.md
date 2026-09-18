---
name: promo-video
description: browsa 宣传片 / 演示 GIF 生成管线——真实 UI 逐帧驱动（dev-preview 预览环境 + Playwright + CDP 截图）+ ffmpeg 合成。当用户要求做宣传视频、宣传片、demo GIF、演示动图、产品短视频，或要求修改/重拍/新增分镜、改字幕文案、换场景顺序、重编码 mp4/GIF 时使用——哪怕用户没说"逐帧"或"脚本驱动"。
---

# browsa 宣传片生成

**核心思路：不录屏、不用 AI 生成视频（AI 画不对 UI 文字），而是把真实 UI 当作可编程演员**——dev-preview 预览环境跑真面板代码，Playwright 逐帧驱动交互，每帧 CDP 截图，ffmpeg 合成。时间线与采集速度解耦，任何一幕可单独重拍。

现役成片：62s 八幕（钩子 / 附页问答 / 追问卡 / 划词浮条 / 视频时间线 / 渲染蒙太奇 / Agent 审批 / 片尾），产物在 `store-assets/promo/`，分发在双语 README（GIF）与官网 `#demo` 区（mp4）。

## 目录

- `scripts/server.mjs` — 静态服务器（:8957）。`/repo/*` 映射仓库、`/fonts/*` 映射 Noto Sans SC、`article.html`/`wrapper.html`/`page-shim.js` 本地服务；**下发时动态注入**：seed 按 referer 的 `?scene=` 切换、chrome-shim 加可编程端口 + ATTACH_PAGE/APPROVAL_RESPOND/storage-Promise 补丁、selection-toolbar.js 暴露 shadow 引用。仓库文件零改动。
- `scripts/wrapper.html` — 1920×1080 合成层：假浏览器窗（标题栏/URL 可驱动）+ 页面/面板双 iframe + 字幕 + 假光标 + 点击涟漪 + 内容区淡入淡出 + 片尾卡。
- `scripts/article.html` — 模拟网页（`?v=doc` 浅色文档 / `?v=video` B 站页），尾部加载 page-shim + **真实** selection-toolbar 内容脚本。
- `scripts/page-shim.js` — 页面侧最小 chrome.* 桩（浮条的 storage/i18n/getURL/explain 端口）。
- `scripts/driver.mjs` — 分镜驱动（8 幕，`only()` 支持单拍；逐帧 evaluate + `Page.captureScreenshot`）。

## 操作流程

```bash
cd <repo>/.agents/skills/promo-video/scripts
npm i                      # playwright-core + @fontsource/noto-sans-sc（node_modules 已 gitignore）
node server.mjs            # 常驻（ZCode 里用 run_in_background；`(cmd &)` 会被回收）
node driver.mjs            # 全量 1480 帧 → $TMPDIR/browsa-promo/frames，约 8 分钟
node driver.mjs s2         # 单拍某幕（s1|s2|s3|s4|s5|s6|s7|s8；全片必须一次连拍帧号才连续）
# 合成（24fps）：
ffmpeg -framerate 24 -i $(PROMO_FRAMES 或 $TMPDIR/browsa-promo/frames)/f%05d.png \
  -c:v libx264 -preset faster -crf 20 -pix_fmt yuv420p -movflags +faststart out.mp4
# GIF（从第 72 帧起 329 帧 = 33s 循环版）：
ffmpeg -framerate 24 -start_number 72 -i .../f%05d.png -frames:v 329 \
  -vf "fps=10,scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" out.gif
```

环境变量：`BROWSA_ROOT`（仓库根，默认从脚本位置向上推三级）、`PROMO_PORT`、`PROMO_FRAMES`、`PROMO_CHROME`。浏览器默认从 `~/.cache/ms-playwright` 自动找最新 chromium；没有就先 `npx playwright-core install chromium`（或设 `PROMO_CHROME` 指向系统 Chrome）。改了 `sidepanel.html` 结构先 `node dev-preview/gen.mjs`。

## 改分镜的常规路径

1. **改字幕文案**：`driver.mjs` 顶部 `Q1/A1/Q2/A2/EXPLAIN/Q3/A3` 常量 + 各幕 `__caption(html, opacity)` 调用。字幕支持 `<span class="hl">` 高亮。
2. **改节奏**：每幕由 `frames(count, step)` 段组成，count 即帧数（24 帧 = 1 秒）；步进函数里做逐帧插值。
3. **加一幕**：仿照现有 `if (only('sN'))` 块写，注意承接上一幕的布局与光标位置；`swapWithFade(setup)` 做"切 tab"观感的幕间转场（窗口框不动）。
4. **重拍范围**：单幕改动仍建议全量连拍（帧号全局连续）；只想预览就 `node driver.mjs sN` 后单独看帧。

## 坑清单（每一条都真翻过车）

- **chrome-shim 的 `storage.local.set/remove/clear` 必须注入为返回 Promise**——composer-state 会 `.catch()` 链上去，仓库 shim 返回 undefined 会把真实 onSend 在 `clearPersistedDraft` 处炸断（且时序随机：打字 debounce 是否触发决定崩不崩，最难查）。server.mjs 已注入此修复，勿删。
- **pill / 浮条按钮必须 down+up 贴死**：追问 pill 在 mousedown 里自移除，按住不放 Chrome 会把按压重定向到底下文本，把选区弄花。
- **涟漪序列末尾必须显式推相位 1**：`__ripple(x,y,phase)` 只在驱动调用时更新，最后一帧相位 <1 就永久冻结成半透明圆环，看着像水印（#139）。
- **面板气泡是 fit-content**：注入纯图表 fence（无文字撑宽）会把 echarts 画布塌成 4px——注入气泡要 `style.width='100%'`。
- **Playwright `evaluate` 不捕获 Node 闭包变量**：页面函数里引用 Node 侧变量必须走参数传递，否则 `ReferenceError`。
- **ESM 不认 NODE_PATH**：依赖装在本目录（或软链 node_modules）。
- **CDP 截图，不用 `page.screenshot()`**：dark 模式下后者有整页变浅色的伪影（详见记忆 browsa-dev-preview-harness）。
- **全真驱动协议**（S2/S3/S4/S7 用）：面板走真 onSend/SUBCHAT/审批管线，server 注入的端口带 `__push`（STREAM_HELLO/SUBCHAT_HELLO 自动 ACK），驱动逐帧 `__push({type:'CHUNK',delta})`；APPROVAL_RESPOND 注入为 `{ok:true,data:{ok:true}}`（面板读 data.ok）。DONE 带 `usage`/`providerLabel` 出真铭牌与用量芯片。token 芯片的 t/s 按采帧墙钟计算，数值偏慢是已知如实呈现。
- **长等待会拖慢帧率**：`page.waitForTimeout` 只用于等真实异步（浮条 220ms 去抖、DONE 渲染），能用帧插值表达的动效不要用等待。

## 交付惯例

- 产物落 `store-assets/promo/`（gitignore 内，本地留存），`README.md` 在该目录记录规格与分镜。
- 分发：GIF → `docs/assets/readme/`（**嵌双语 README**）；mp4+海报 → `docs/assets/promo/`（官网双语 `#demo` 区）。README 侧图片**换内容必须换文件名**（demo.gif → demo-v2 → demo-v3…），否则 camo/浏览器缓存让用户永远看到旧版。
- 发布走仓库惯例：dev 提交 → PR → CI 绿 → squash 合 main（不带 --delete-branch）→ 回灌 dev；Pages 自动部署。
- 中英文案逐节对齐（README 双语、docs/en）；官网截图目检用临时 http.server + 截图，不起常驻预览服务。
