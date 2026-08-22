# browsa

> **Languages**: [English](README.md) · **简体中文**

> **browsa** = **brow**ser **s**ide p**a**nel **A**I（浏览器侧边栏 AI）。在任何网页旁侧边栏中与 AI 对话——和你正在读的内容聊 LLM 智能体。

browsa 是一个 Chrome / Edge 扩展（Manifest V3）：在你当前打开的标签页旁打开一个聊天面板，附加页面内容，并从任意 OpenAI 兼容 API 流式接收回复。

```
[Web 页面]  →  [browsa 侧边栏]  →  [你的 LLM / 智能体]  →  流式回复
```

## 安装（开发者模式加载）

1. 克隆或下载本仓库。
2. 打开 `chrome://extensions`（或 `edge://extensions`）。
3. 开启**开发者模式**。
4. 点击**加载已解压的扩展程序** → 选择 `browsa/` 目录。
5. 按 `Ctrl+Shift+H`（或点击工具栏图标）打开侧边栏。
6. 点击 **⚙ 设置**配置一个 provider。

## 构建与打包

```bash
npm install          # 仅首次需要
npm test             # 运行 789 个单元测试
npm run package      # → browsa-v<version>.zip
```

升级版本号后再打包：

```bash
npm version patch    # 修复 bug：      0.24.0 → 0.24.1
npm version minor    # 新增功能：      0.24.0 → 0.25.0
npm run package
```

`npm version` 会自动把版本号同步到 `package.json` 和 `manifest.json`。

---

## 配置 Provider

browsa 把 provider 分成两类：

- **Agent Provider（智能体）**——完整的智能体后端，可执行工具（bash、文件操作、联网搜索等）。AI 真的能在服务端*做事*。
- **LLM Provider（纯语言模型）**——仅用于对话的纯语言模型端点。必须填写模型 ID。

在设置页用 **Ping** 按钮验证连通性并自动检测能力。provider 状态（可达 / 不可达）会显示在侧边栏下拉框中。

---

### 🤖 Hermes Agent

Hermes 是一个自托管的 AI 智能体，内置工具（联网搜索、终端、文件操作、记忆、技能）。browsa 使用它的 `/v1/runs` API——比普通 chat completions 更丰富（工具进度、危险操作的审批/澄清提示），并且每个会话使用稳定的 `X-Hermes-Session-Id`，让 Hermes 能在服务端维持会话连续性。如果某个 Hermes 部署不支持 `/v1/runs`，会自动回退到普通的 `/v1/chat/completions`。

**1. 安装 Hermes**

```bash
pip install hermes-agent   # 或按官方安装指南
```

**2. 启用 API 服务**——在 `~/.hermes/.env` 中添加：

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=your-secret-key
```

**3. 启动 Hermes**

```bash
hermes gateway
# → [API Server] API server listening on http://127.0.0.1:8642
```

**4. 配置 browsa**——打开 ⚙ 设置，选择 **hermes** provider：

| 字段 | 值 |
|---|---|
| Base URL | `http://<server-ip>:8642` |
| API Key | `API_SERVER_KEY` 的值 |

**5. 点击 Ping 验证**。会自动检测并启用 `/v1/runs` 支持。

---
### 💬 OpenAI 兼容 LLM

任何支持 `/v1/chat/completions` 的端点——OpenAI、Anthropic、Ollama、Groq、LiteLLM 等。

**配置 browsa**——打开 ⚙ 设置，配置 **OpenAI 兼容** provider：

| 字段 | 值 |
|---|---|
| Base URL | 例如 `https://api.openai.com` |
| API Key | 你的 API key |
| Model ID | **必填**——例如 `gpt-4o`、`claude-sonnet-4-6` |

**点击 Ping** 验证连通性并确认服务端接受该模型 ID。

---

## 附加页面上下文

点击输入框中的 📎 附加当前页面。browsa 支持在输入区底部选择两种附加模式：

| 模式 | 发送的内容 |
|---|---|
| **自动（Auto）** | 先尝试 Mozilla Readability（干净的正文，约 5–30 KB），失败后回退到 DOM 树，再回退到整个 `body.innerText` |
| **📷 截图（Screenshot）** | 当前可见标签页的 PNG——用于多模态模型或视觉内容 |

附加 PDF（或某个其实是个 PDF 的页面）是自动的——无需单独选择模式。browsa 会先尝试 [`pdf-inspector-wasm`](https://github.com/firecrawl/pdf-inspector)（完整的版式重建——表格、标题、多栏——全部在客户端运行，不上传任何内容），若不可用或该 PDF 是无文本层的扫描/纯图片页，则回退到纯 `pdf.js` 文本提取，最后兜底只附加 PDF 的 URL，让你的智能体用自己的工具去抓取和阅读。对于图多的 PDF（教科书、带图表的论文），browsa 还会裁出真正的图形区域——不是整页渲染——并为每张图配上其标题，作为内联视觉内容发送，让支持视觉的模型真正"看到"图表；模型回答完后，这些图片会在历史中被压缩为带标签的文本占位符，后续轮次重发廉价文本而不是像素。

GitHub 文件页（`github.com/…/blob/…`）是特例：browsa 直接抓取 `raw.githubusercontent.com` 上的原始源码。这比抓取渲染后的 GitHub 界面更干净（markdown 和代码保持结构而不是被压成纯文本），并且跳过了页面清理步骤（那个步骤原本会去点击 GitHub 的导航菜单和分支选择器）。

对于文本选择，在页面上划选文字，然后用**浮动工具栏**或**右键上下文菜单**（提问 Ask / 解释 Explain / 翻译 Translate / 总结 Summarize）。选择内容会自动发送，无需点击 📎。

---

## 支持的站点（XHR 拦截）

对于 Readability 效果较差的站点，browsa 会拦截浏览器自身的 API 调用并提取结构化内容——无需签名、无需重新认证，只是观察页面本来已经请求的内容。先打开页面等它完全加载，再发送第一条消息。

| 站点 | 提取的内容 |
|---|---|
| **YouTube** | 标题、字幕、章节、简介、作者、观看/点赞数 |
| **Bilibili** | 标题、AI 总结、字幕/文稿、音频 URL、视频数据 |
| **小红书** | 笔记标题、简介、标签、图片、热门评论、数据 |
| **掘金** | 完整文章 Markdown 源码 |
| **知乎** | 专栏文章或某个问题的前 3 个回答 |
| **Twitter / X** | 推文文本、作者、互动数据 |
| **雪球** | 行情或帖子内容 |
| **小宇宙** | 播客单集标题、简介、shownotes |
| **得到** | 文章正文 |
| **极客时间** | 文章正文 |

---

## 功能

### 聊天

- **流式回复**——token 逐字出现；点击 ✕ 或按 `Esc` 停止
- **思考块**——` thinking` / `<thinking>` 内容显示为可折叠块，流式结束后自动收起
- **Markdown 渲染**——完整 GFM：表格、代码块、列表、行内格式
- **语法高亮**——40+ 种语言（highlight.js）
- **LaTeX**——行内 `$...$` 和块级 `$$...$$`（KaTeX），公式多的消息会卸载到 Web Worker 渲染，避免面板卡顿
- **Mermaid 图**——内联渲染，带缩放/平移/复制源码/导出 SVG 工具栏；对话文本里含分号（例如内嵌 SQL）的时序图可通过自动转义重试正确渲染
- **ECharts 图表**——` ```echarts ` 代码块内联渲染，带自适应工具栏
- **Markmap 思维导图**——` ```markmap ` 代码块（普通的 Markdown 标题/列表大纲）内联渲染为可交互、可缩放的思维导图，带与 Mermaid/ECharts 相同的缩放/重置/复制/导出工具栏；无需专用按钮——只要说要个思维导图/大纲，模型就懂这个格式
- **Diff 高亮**——`diff` 代码块把 `+` 标绿、`-` 标红
- **细聊（Detail thread）**——选中回复中的任意文本，打开一个仅针对这段摘录的独立侧边对话，不碰主历史。可自由调整大小，✕ 关闭即全部丢弃
- **编辑并重发**——点击任意用户消息上的 ✏ 编辑并重发
- **复制回复**——点击 ⎘ 复制完整原始 Markdown
- **时间戳**——悬停任意消息查看发送时间

### 历史与会话

- **会话历史**——把当前对话保存为命名会话，从 🕐 抽屉浏览和恢复过往会话
- **导出**——把任意会话导出为 Markdown 文件
- **对话内搜索**——`Ctrl+F` 跨全部消息搜索，支持上一条/下一条导航
- **多选**——选择多条消息批量删除
- **撤销清空**——清空历史后 5 秒内可撤销

### 输入

- **图片附件**——直接把图片拖入或粘贴到输入框（用于多模态模型）
- **斜杠命令**——输入 `/` 查看补全；见下方列表
- **快捷操作**——输入框上方的「总结 / 要点 / 解释 / → 中文 / 大纲」一键按钮
- **浮动选择工具栏**——在任意页面划选文字时出现：提问 · 解释 · → 中文 · 总结
- **右键上下文菜单**——browsa › 在选中文本上执行 提问 / 解释 / 翻译 / 总结

### 设置

- **域名规则**——按 URL 模式追加系统提示词（例如在 `github.com` 上始终用英文回复）
- **脱敏规则**——发送给 LLM 前按正则脱敏内容（例如去掉手机号）
- **回复语言**——无论页面语言，强制用指定语言回复
- **最大文本字符数**——限制每轮发送多少页面内容
- **长附件自动总结**——当附加的页面或视频字幕超过阈值（默认 100,000 字符）时，browsa 会分块、用当前配置的 provider 并行总结每个块、再在后台合并一次——附加响应立即返回无延迟，后续轮次使用压缩版而不是每次重发全文。视频字幕的时间戳标记（`[mm:ss]`）会显式保留，可点击跳转链接继续可用。任何错误都安全失败，静默保留原文。
- **llms.txt**——当你附加页面（📎）时，browsa 会抓取一次 `<origin>/llms.txt`，把该站点的 LLM 指令烘焙进附加的页面上下文中（绑定到附加的页面，而不是当前激活的标签页）。放在系统提示词之外，保证提示词前缀跨轮次字节稳定（对 KV / prompt 缓存友好）。

---

## 斜杠命令

在输入框输入 `/` 查看自动补全。所有命令都可以跟额外的指令：

```
/summarize focus on the methodology
/translate keep technical terms in English
```

| 命令 | 发送给 LLM 的提示词 |
|---|---|
| `/summarize` | 3–5 条要点总结 |
| `/translate` | 翻译成中文 |
| `/rewrite` | 更简洁的改写，保留全部事实 |
| `/explain` | 用简单语言向新手解释 |
| `/outline` | 仅标题的嵌套大纲 |
| `/keypoints` | 前 5 条要点 |
| `/prompt` | 显示当前生效的系统提示词（不发送给 LLM） |

---

## 键盘快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Shift+H` | 打开 / 关闭侧边栏 |
| `Enter` | 发送消息（可在设置中配置） |
| `Shift+Enter` | 换行 |
| `Ctrl+K` | 清空历史（可撤销） |
| `Ctrl+/` | 循环切换上下文模式（自动 ↔ 截图） |
| `Ctrl+F` | 打开对话内搜索 |
| `Esc` | 取消流式 / 关闭搜索 / 关闭抽屉 |

---

## 工作原理

- **`background.js`**——MV3 服务工作线程。所有扩展消息的单一 `handle()` 消息路由器——仍是单一分发器，但最大的两个 case（`CHAT`、`SUBCHAT`）委托给 `lib/handlers/`。管理站点 XHR 缓存（按 `tabId` 键控）、通过每轮的 `browsa-chat`/`browsa-subchat` 端口流式传输、通过 `streamState`（`lib/state.js`）支持流式中途切换标签页，并在页面/视频附件超过配置的长度阈值时触发一个 fire-and-forget 的附件自动总结流程（`lib/handlers/attach-summarizer.js`）。
- **`sidepanel.js`**——聊天 UI 编排器：初始化/发送/历史/审批-澄清卡片/截图裁剪。Markdown/Mermaid/Markmap/KaTeX/ECharts 渲染管线、会话抽屉、对话内搜索、多选、细聊侧边对话各是 `lib/sidepanel/` 下的一个模块。
- **`lib/sidepanel/render.js`**——marked + DOMPurify + KaTeX + Mermaid + ECharts + Markmap + highlight.js 管线。流式增量通过 `reveal-pacer.js`（围绕 vendored `markstream-core` 包的薄封装）平滑显示；每条消息最终的 KaTeX 渲染会把公式多的消息卸载给 Web Worker（`katex-worker-client.js`/`katex.worker.js`），低于小批量阈值或 worker 失败时回退为同步渲染；Mermaid 的 SVG 输出会被净化（`sanitizeMermaidSvg`，来自 vendored `stream-markdown-parser` 包），时序图解析失败会用转义问题分号的方式自动重试（`mermaid-utils.js`）。三个图表 vendor 包（Mermaid/ECharts/Markmap）会在轮次开始的一刻被预取（`preloadChartVendors()`），因此会话中第一张图不会在需要渲染时才付出多 MB 冷加载的代价。
- **`lib/page-extractor.js`**——把 Readability + Turndown 注入页面 MAIN world 用于 reader 模式。对 SPA 站点，使用匹配的内容脚本的 XHR 缓存。
- **`lib/sidepanel/pdf-extractor.js`**——PDF 附件管线：先在专用 Worker 里尝试 `pdf-inspector-wasm`（完整版式/表格/标题重建），回退到纯文本 `pdf.js` 提取，并对两者做质量把关（空结果/扫描结果不会当作成功），之后调用方再回退到纯 URL 附件。
- **`lib/openai-client.js`**——基于 fetch 的 SSE 流式客户端。支持 `/v1/chat/completions`（所有 provider）和 `/v1/runs`（Hermes——审批/澄清/工具进度事件，自动检测）。
- **`lib/storage.js`**——`chrome.storage.local` 封装。全局扁平对话历史（非按标签页）、会话管理、脱敏规则。
- **内容脚本**（`lib/content-scripts/`）——在 `document_start` 以 MAIN world 运行。包装 `window.fetch` 和 `XMLHttpRequest.prototype` 观察 SPA API 调用，并把结构化数据转发给后台。

---

## 项目结构

```
browsa/
├── manifest.json
├── background.js                      # 服务工作线程 + 消息路由器（仅分发）
├── sidepanel.{html,css,js}            # 聊天 UI 编排器
├── options.{html,css,js}              # 设置页
├── lib/
│   ├── constants.js                   # 共享常量（PAGE_CONTEXT_PREFIX 等）
│   ├── state.js                       # 共享流/审批状态 Map（background.js 使用）
│   ├── openai-client.js               # SSE 流式客户端
│   ├── page-extractor.js              # 内容提取 + 站点合成器
│   ├── storage.js                     # chrome.storage 封装 + 会话管理
│   ├── handlers/
│   │   ├── chat-handler.js            # CHAT case 主体
│   │   ├── subchat-handler.js         # SUBCHAT / SUBCHAT_ABORT case 主体
│   │   └── attach-summarizer.js       # 自动压缩长页面/视频附件
│   ├── markdown-chunker.js            # 结构感知的截断 + 分块（代码围栏/表格永不拆开）
│   ├── sidepanel/                     # sidepanel.js 的功能模块
│   │   ├── render.js                  # marked+DOMPurify+KaTeX+Mermaid+ECharts 管线
│   │   ├── reveal-pacer.js            # 平滑显示封装（vendored markstream-core）
│   │   ├── katex-threshold.js         # "值得卸载给 worker 吗"启发式判断
│   │   ├── katex-worker-client.js     # 把公式批量发给 katex.worker.js，同步回退
│   │   ├── katex.worker.js            # 专用 KaTeX 渲染 Worker
│   │   ├── mermaid-utils.js           # 时序图分号修复 + 预览高度估算
│   │   ├── pdf-extractor.js           # PDF 附件：wasm 优先/pdf.js 回退编排
│   │   ├── pdf-inspector-worker-client.js # pdf-inspector-wasm Worker 客户端（粘滞失败，超时→null）
│   │   ├── pdf-inspector.worker.js    # 运行 pdf-inspector-wasm 的 processPdf() 的专用 Worker
│   │   ├── sessions-ui.js             # 会话抽屉
│   │   ├── multiselect.js             # 批量删除模式
│   │   ├── msg-search.js              # Ctrl+F 对话内搜索
│   │   ├── detail-thread.js           # "划选文本 → 细聊"侧边对话
│   │   ├── icons.js                   # ICONS SVG 图
│   │   └── ui-utils.js                # $, escM, sendMessage, toast/confirm, 卡片工具
│   ├── content-scripts/               # MAIN world XHR 拦截器 + ISOLATED world 工具栏
│   │   ├── selection-toolbar.js       # 浮动工具栏（Shadow DOM）
│   │   ├── xhs-content-script.js      # 小红书 XHR 拦截器
│   │   ├── youtube-content-script.js  # YouTube 播放器 API 拦截器
│   │   ├── bilibili-content-script.js # Bilibili 视频 API 拦截器
│   │   ├── juejin-content-script.js   # 掘金文章拦截器
│   │   ├── zhihu-content-script.js    # 知乎文章 / 问答拦截器
│   │   ├── twitter-content-script.js  # Twitter/X GraphQL 拦截器
│   │   ├── xueqiu-content-script.js   # 雪球行情/帖子拦截器
│   │   ├── xiaoyuzhou-content-script.js # 小宇宙播客拦截器
│   │   ├── dedao-content-script.js    # 得到拦截器
│   │   └── geektime-content-script.js # 极客时间拦截器
│   └── vendor/                        # 打包的第三方库
│       ├── Readability.iife.js
│       ├── Turndown.iife.js
│       ├── marked.bundle.js
│       ├── purify.bundle.js
│       ├── katex.bundle.js
│       ├── highlight.bundle.js
│       ├── mermaid.bundle.js
│       ├── echarts.bundle.js
│       ├── markmap-lib.bundle.js       # Markdown → 思维导图树转换器
│       ├── markmap-view.bundle.js      # d3-zoom 思维导图 SVG 渲染器
│       ├── markstream-core.bundle.js   # 流式显示节奏控制器
│       ├── stream-markdown-parser.bundle.js # Mermaid SVG 净化器
│       ├── pdf.bundle.js               # pdf.js——PDF 文本提取回退
│       ├── pdf.worker.bundle.js        # pdf.js 自带的 Worker
│       ├── pdf_inspector_wasm.js       # pdf-inspector-wasm 胶水（wasm-bindgen）
│       └── pdf_inspector_wasm_bg.wasm  # pdf-inspector-wasm 二进制——PDF 提取主力
├── _locales/{en,zh_CN}/
├── icons/
├── build/
│   ├── build.mjs                      # esbuild vendor 打包器
│   └── package.mjs                    # 分发 zip 构建器
├── test/                              # node:test 单元测试（789 个测试）
└── check-compat.sh                    # MV3 / 静态兼容性检查
```

---

## 浏览器兼容性

| 浏览器 | 状态 | 说明 |
|---|---|---|
| **Chrome 114+** | ✅ 支持 | 主要目标 |
| **Edge 114+** | ✅ 支持 | 安装方式相同 |
| **Brave 1.56+** | ✅ 应可运行 | 相同的 Chromium 内核 |
| **Firefox** | ❌ 不支持 | 没有 `side_panel` API |

---

## 安全

- API key 只存在你自己的机器上的 `chrome.storage.local` 里——除了你配置的 `baseUrl` 之外，绝不会发送到任何地方。
- PDF 附件完全在客户端解析（WebAssembly + pdf.js，都运行在侧边栏里）——文件字节绝不会上传到任何地方，只有提取出的文本会被发送给你配置的 provider。
- LLM 回复在渲染前用 DOMPurify 净化，包括一个拦截 `data:image/svg+xml` 来源（可能携带自己的 `<script>`/事件处理器）的钩子，同时仍然允许正常的位图 `data:` 图片。
- Mermaid 图的 SVG 输出在插入前会被净化（移除 `<script>`、事件处理器属性、危险 URL）——因为 Mermaid 的 `securityLevel:'loose'` 模式（图形标签内的 KaTeX 数学需要它）否则会允许任意 HTML 通过。
- 内容脚本只观察网络请求，从不修改或阻断它们。

---

## License

MIT
