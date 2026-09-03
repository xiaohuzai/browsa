# browsa · Chrome Web Store Listing 文案包

> 用法：Phase 0 发布时，把下面各字段**原样粘贴**到 [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → 你的商品 →「Store listing」。
> 每个字段都标了字符限制并已核验。凡标 ✅ 的可直接复制。

---

## 0. 关键词策略（为什么这么写）

CWS 搜索索引主要看：**名称 > 简短描述 > 描述前几段**。用户真实搜索词按意图排序：

| 意图 | 高频搜索词 | 覆盖位置 |
|---|---|---|
| 找品类 | AI sidebar / AI assistant | 名称 ✅ |
| 带着任务来 | chat with webpage / summarize youtube / chat with pdf | 名称 + 短描述 ✅ |
| 认模型 | ChatGPT / Claude / Gemini / Ollama | 名称尾部 + 短描述 ✅ |
| 信任敏感 | open source / no account / your API key | 短描述 + 描述隐私段 ✅ |

不要堆砌词（CWS 会判 spam）；所有关键词都在自然句子里出现。

---

## 1. Store listing 字段（EN 主 listing）

### Name（≤75 字符）✅ 65 字符

```
browsa – AI Sidebar · Chat with Pages · ChatGPT · Claude · Ollama
```

备选（若想突出视频/PDF 场景）：

```
browsa – AI Sidebar, Chat with Any Page, YouTube & PDFs
```

### Short description（≤132 字符）✅ 115 字符

```
Your keys, your models, your agent. Chat with pages, videos and PDFs right in the sidebar. Open source. No account.
```

### Category

`Productivity`（主）；可加次要标签 `Tools`。

---

## 2. Detailed description（EN，直接全选复制）

```
browsa is an AI sidebar that chats with the page you're on — articles, YouTube videos, Bilibili videos, PDFs, and docs — using YOUR own key or YOUR own agent. No subscription. No account. No middleman.

──────────────────────────────
💬 CHAT WITH ANYTHING YOU'RE READING
• Attach the current page with one click — clean reader-mode extraction, not a DOM dump
• Summarize, translate, explain, outline — one-tap quick actions and slash commands
• Select any text on the page → floating toolbar to ask / explain / translate / summarize

🎬 VIDEO NOTES WITH CLICKABLE TIMESTAMPS
• Built-in subtitles for YouTube & Bilibili are extracted automatically
• No subtitles? browsa transcribes the audio (ASR) through your own configured provider, so subtitle-less videos work too
• Every [mm:ss] note in the reply is clickable and seeks the video

📄 PDFs NEVER LEAVE YOUR MACHINE
• Full layout reconstruction client-side (tables, headings, multi-column) — powered by WASM, zero upload
• Charts and figures are cropped and sent as images so vision models can actually see them

🤖 BRING YOUR OWN MODEL — OR YOUR OWN AGENT
• Any OpenAI-compatible endpoint: ChatGPT, Claude, Gemini, Groq, LiteLLM…
• Local & offline models via Ollama / LM Studio / vLLM
• Agent backends too (e.g. self-hosted Hermes): tool execution, streaming progress, human approval before risky actions
• Three wire protocols per provider: Chat Completions, Responses, Anthropic Messages

🌐 DEEP SITE EXTRACTION (not just "grab the text")
• Structured content for YouTube, Bilibili, Xiaohongshu, Zhihu, Xueqiu, Juejin, X/Twitter, Reddit, dedao, geektime, Xiaoyuzhou podcasts and Feishu/Lark documents
• GitHub file pages fetch the raw source instead of the rendered UI

🔒 PRIVACY BY ARCHITECTURE
• Your API keys are stored only in your browser's local storage and sent nowhere except the endpoint you configure
• Page context is sanitized locally before sending: credentials hiding in URLs (tokens, passwords, signatures) are masked so they never reach your provider
• PDF parsing runs entirely on-device (WebAssembly) — file bytes never leave your machine
• Model replies are sanitized (DOMPurify) before rendering; network interceptors only observe requests, never modify them
• Open source (MIT): every line is auditable — https://github.com/xiaohuzai/browsa

✨ RICH REPLIES, RENDERED PROPERLY
Markdown tables, code highlighting (40+ languages), KaTeX math, Mermaid diagrams, ECharts charts and Markmap mind maps — rendered inline. Select any part of a reply to open a scoped side-conversation ("detail thread").

⌨️ MADE FOR KEYBOARD PEOPLE
Ctrl+Shift+H opens the sidebar · Enter/Shift+Enter configurable · Ctrl+F search inside the conversation · Ctrl+/ switch context mode · everything streamable and abortable with Esc

──────────────────────────────
browsa does not add markup to anyone's model bill — you pay your provider directly, or run local models for free. It collects no analytics and requires no sign-up.

The UI follows your browser language (English / 中文), switchable in Settings.

Install, open ⚙ Settings, paste a key (or point at localhost:11434), Ping to verify — you're chatting in under a minute.

Source code & docs: https://github.com/xiaohuzai/browsa
Website: https://xiaohuzai.github.io/browsa/
```

---

## 3. zh_CN 本地化 listing（Dashboard → Locale: 中文（简体）添加）

### Name ✅

```
browsa – AI 侧边栏 · 与任意页面对话 · 接你自己的模型与智能体
```

### Short description ✅（未超限即可）

```
用自己的 Key 或自己的智能体，在侧边栏与网页、B站视频、PDF 对话。开源、无账号、本地解析。
```

### Description

```
browsa 是一个把「你正在看的页面」交给 AI 的浏览器侧边栏——文章、YouTube/B站视频、PDF、飞书文档都能聊。不订阅、不登录、不加价：用你自己的 API Key，或接你自建的智能体。

──────
💬 与任何页面对话
• 一键附加当前页面：干净的正文提取，而非整页 DOM 倒灌
• 总结 / 翻译 / 解释 / 大纲一键快捷操作 + 斜杠命令
• 划选任意文字 → 浮动工具栏：提问 · 解释 · 翻译 · 总结

🎬 带可点击时间戳的视频笔记
• 自动提取 YouTube / B站字幕；无字幕视频也能语音转写（ASR，经由你自己配置的服务）
• 回复里的每个 [mm:ss] 都可以点击跳转

📄 PDF 不出本机
• 客户端（WASM）完整版式重建：表格、标题、多栏，零上传
• 图表区域自动裁剪成图片发给视觉模型，公式图表真正"看得见"

🤖 自选模型与智能体
• OpenAI 兼容端点通吃：ChatGPT、Claude、Gemini、Groq、LiteLLM…
• 本地离线模型：Ollama / LM Studio / vLLM
• 也支持智能体后端（如自建 Hermes）：工具执行、过程直播、危险操作先审批

🌐 深度站点提取
• YouTube、B站、小红书、知乎、雪球、掘金、X/Twitter、Reddit、得到、极客时间、小宇宙播客、飞书/Lark 文档
• GitHub 文件页直接抓源码而非渲染后的界面

🔒 隐私即架构
• API Key 只存于你的浏览器本地，只发往你自己配置的端点
• 页面内容发送前本地脱敏：藏在 URL 里的令牌、密码、签名参数自动隐去，不会到达 provider
• PDF 全程本机解析，文件字节不出设备
• 回复经 DOMPurify 消毒后再渲染；网络拦截器只观察、从不修改请求
• MIT 开源：https://github.com/xiaohuzai/browsa

✨ 富文本回复
Markdown 表格、代码高亮（40+ 语言）、KaTeX 公式、Mermaid 图、ECharts 图表、Markmap 思维导图全部内联渲染；选中回复片段可开"细聊"侧对话。

安装后打开 ⚙ 设置，贴入 Key（或指向 localhost:11434），Ping 通过即用。界面文字跟随浏览器语言（中/英），可在设置中切换。

官网：https://xiaohuzai.github.io/browsa/
```

---

## 4. 图片素材清单（5+1 张）

规格：截图 **1280×800** PNG；小宣传图 **440×280**。

| # | 分镜 | 要传达的关键词 |
|---|---|---|
| 1 | **主图 Hero**：B站视频页 + 侧边栏结构化笔记，金色 `[07:42]` 时间戳清晰可见 | Chat with video |
| 2 | 无字幕视频 → ASR 转写中（进度提示）→ 出现带 `[mm:ss]` 的笔记 | works without subtitles |
| 3 | 论文 PDF + 侧边栏提问，附图中裁出的 Figure 3 | chat with PDF |
| 4 | 设置页 Provider 卡片：OpenAI / Claude / **Ollama(localhost)** / Hermes 四张卡 | Your keys, your agent |
| 5 | 小红书/飞书文档提取前后对比（左：页面；右：干净的结构化正文） | deep extraction |
| 6（440×280） | 冷纸白底 + mono 字标 "browsa" + 一句话 “Your keys. Your agent.” | 品牌 |

> 制作方式建议：沿用官网的纯 HTML/CSS 手绘 mockup 风格做成 6 个 HTML 页面，用无头 Chrome 截成精确尺寸的 PNG——矢量清晰、风格统一。这套我可以直接生成。

---

## 5. Dashboard「权限说明」预填文案（审核必看，单独的表格）

扩展声明了 `<all_urls>` 等 github review 敏感权限，逐条给出理由（英文照抄）：

| Permission | Justification |
|---|---|
| Host permission `<all_urls>` | The core feature extracts readable content from whatever page the user is viewing and attaches it to their own configured AI backend. The user chooses which page to attach; extraction only runs on user action (attach button / selection toolbar). |
| `tabs` / `activeTab` / `webNavigation` | To show the current tab's title/URL in the panel, detect SPA navigations so extraction follows the page the user is reading, and to inject read-only content scripts that capture site API responses the user's own agent will consume. |
| `scripting` | Injects extraction/cleanup scripts into the active tab at user request, and seeks videos for clickable timestamps. |
| `cookies` | Read-only, and only site session cookies of the video platform being downloaded (bilibili/googlevideo) so an audio download initiated by the user carries their own login context. |
| `declarativeNetRequest` | Temporary session-scoped header rules (Referer) so the browser can download the audio/video stream the user explicitly requested; rules live for the service-worker lifetime only. |
| `downloads` | Saves media the user explicitly chose to download (chrome.downloads.download with saveAs). |
| `storage` | Stores settings and conversation history locally in chrome.storage.local. Nothing syncs off-device except calls to the user-configured AI endpoint. |

另外两条硬性前置：
- **Privacy policy URL**：已上线，填 `https://xiaohuzai.github.io/browsa/privacy.html`（CWS 审核要求该 URL 不带登录墙，github.io 满足）。
- 2025 年起若 listing 含联盟链接需披露；我们没有，勿添加返利链接。

---

## 6. 发布 checklist

- [ ] Developer账号 $5（一次性）
- [ ] zip：`npm run package`（版本号取 manifest.json 当前值，打包前不擅自 bump）
- [ ] privacy policy 已上线：https://xiaohuzai.github.io/browsa/privacy.html ，URL 填入 dashboard
- [ ] 上传 5 张截图 + 440×280 宣传图
- [ ] 权限说明逐条粘贴（上表）
- [ ] 单一用途声明：`An AI sidebar that chats with the page you're viewing via the user's own configured model or agent.`
