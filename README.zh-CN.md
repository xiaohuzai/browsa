# browsa

> **Languages**: [English](README.md) · **简体中文**

> **browsa** = **brow**ser **s**ide p**a**nel **A**I（浏览器侧边栏 AI）。在任何网页旁侧边栏中与 AI 对话——和你正在读的内容聊 LLM 智能体。

> **官网**: [xiaohuzai.github.io/browsa](https://xiaohuzai.github.io/browsa/) — 功能亮点与界面示意（简体中文 · English）

browsa 是一个 Chrome / Edge 扩展（Manifest V3）：在你当前打开的标签页旁打开一个聊天面板，附加页面内容，并从 OpenAI（Chat Completions / Responses）、Anthropic Messages、Ollama 等任意兼容端点流式接收回复。

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
npm test             # 运行 800+ 个单元测试
npm run package      # → browsa-v<version>.zip
```

`npm version patch|minor` 会自动把版本号同步到 `package.json` 和 `manifest.json`。

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
### 💬 LLM Providers

任何支持 OpenAI **Chat Completions**（`/v1/chat/completions`）、OpenAI **Responses**（`/v1/responses`）或 **Anthropic Messages**（`/v1/messages`）的端点——OpenAI、Anthropic、Ollama、Groq、LiteLLM 等。

**配置 browsa**——打开 ⚙ 设置 → **LLM Providers**。系统会为你预留一个空的 **LLM 1** 槽位——填入信息后点 **Save**，或随时用 **＋ Add Provider** 添加更多，然后配置：

| 字段 | 值 |
|---|---|
| Alias | 你起的名字（例如「My OpenAI」「本地模型」）——显示在侧边栏下拉框中，方便区分多个 provider |
| Base URL | 例如 `https://api.openai.com` |
| API Key | 你的 API key |
| Model ID | **必填**——例如 `gpt-4o`、`claude-sonnet-4-6`；可填多个（逗号分隔），侧边栏下拉按「Alias · 模型」逐个选择 |
| API | 端点使用的协议：Chat Completions / Responses / Anthropic |

想加多少 LLM provider 都行；每个可各自选择协议并带上自己的 Alias。一张卡也可填多个模型 ID（逗号分隔）——托管几十个模型的聚合网关一张卡就够，主面板下拉按「Alias · 模型」展开选择。用卡片上的 **✕** 删除（内置 Hermes 智能体卡片固定不可删）。用 **Ping** 验证连通性并自动检测能力；第一个验证通过的 provider 会自动设为当前激活。

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

**结构化提取**——对任意网页都可用；在 Readability 不够用的站点（YouTube、Bilibili、小红书等），browsa 会观察页面自身的网络请求，直接读出结构化内容——字幕、评论、文章源码、行情——无需签名、无需重新认证。对于完全没有字幕的视频，browsa 还能自动做语音转写（ASR），或做「视频精读」——画面（幻灯片、屏幕代码）与语音一起理解，默认仍为音频转写——让无字幕视频也能用同样的可点击 `[mm:ss]` 笔记来总结（ASR 需在 ⚙ 设置中启用并填入火山方舟 Key）。 飞书 / Lark 文档页是特例：browsa 直接解析页面里的 Slate 编辑器块结构，标题、列表以及**表格的行列**都能被保留下来，而不是被压成一段纯文本。

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
- **重新生成**——⟳ 从其前一条用户消息重新运行任意回复
- **排队追问**——流式回答期间继续输入会自动排队，回答结束后依次发出
- **错误说明卡**——provider 报错归类成大白话标题（鉴权 / 限流 / 超时 / 网络 / 5xx），原始错误可展开、可复制
- **复制回复**——点击 ⎘ 复制完整原始 Markdown
- **时间戳**——悬停任意消息查看发送时间

### 历史与会话

- **会话历史**——把当前对话保存为命名会话，从 🕐 抽屉浏览和恢复过往会话
- **导出**——把任意会话导出为 Markdown 文件
- **对话内搜索**——`Ctrl+F` 跨全部消息搜索，支持上一条/下一条导航
- **会话抽屉检索**——按标题与消息内容过滤会话（仅内容命中会有标记）；会话可置顶悬浮在列表上方
- **安全删除**——会话两步确认删除，消息多选批量删除
- **多选**——选择多条消息批量删除
- **撤销清空**——清空历史后 5 秒内可撤销

### 输入

- **图片附件**——直接把图片拖入或粘贴到输入框（用于多模态模型）
- **输入历史与草稿**——↑/↓ 召回之前发送过的消息；未发送的草稿在面板关闭后仍在
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

- **`background.js`**——MV3 服务工作线程，单一消息路由器；通过每轮端口流式传输，超大附件自动总结。
- **`sidepanel.js`**——聊天 UI 编排器；渲染（Markdown/Mermaid/Markmap/KaTeX/ECharts）、会话、搜索、细聊各在 `lib/sidepanel/` 下。
- **`lib/`**——页面提取（Readability 级联 + XHR 拦截）、SSE 流式客户端（`/v1/chat/completions` + Hermes `/v1/runs`）、`chrome.storage.local` 封装、内容脚本。

---

## 浏览器兼容性

Chrome / Edge 114+（主要目标）；Brave 1.56+ 应可运行（相同的 Chromium 内核）。Firefox 不支持（没有 `side_panel` API）。

---

## 安全

- API key 只存在你自己的机器上的 `chrome.storage.local` 里——除了你配置的 `baseUrl` 之外，绝不会发送到任何地方。
- PDF 完全在客户端解析（WASM + pdf.js）——文件字节绝不离开你的设备，只有提取出的文本会发送给你配置的 provider。
- LLM 回复在渲染前用 DOMPurify 净化（拦截 `data:image/svg+xml` 来源；Mermaid 的 SVG 输出会移除 `<script>` / 事件处理器属性）。
- 内容脚本只观察网络请求，从不修改或阻断它们。

---

## License

MIT
