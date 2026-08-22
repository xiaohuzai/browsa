# browsa

> **Languages**: **English** · [简体中文](README.zh-CN.md)

> **browsa** = **brow**ser **s**ide p**a**nel **A**I. Side-panel AI chat for any webpage — talk to your LLM agent about what you're reading.

browsa is a Chrome / Edge extension (Manifest V3) that opens a chat panel next to whatever tab you're on, attaches the page content, and streams replies from any OpenAI-compatible API.

```
[Web page]  →  [browsa side panel]  →  [your LLM / agent]  →  streaming reply
```

## Install (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** → select the `browsa/` directory.
5. Press `Ctrl+Shift+H` (or click the toolbar icon) to open the side panel.
6. Click **⚙ Settings** to configure a provider.

## Build & package

```bash
npm install          # first time only
npm test             # run 789 unit tests
npm run package      # → browsa-v<version>.zip
```

To bump the version before packaging:

```bash
npm version patch    # bug fix:      0.24.0 → 0.24.1
npm version minor    # new feature:  0.24.0 → 0.25.0
npm run package
```

`npm version` automatically syncs the version to both `package.json` and `manifest.json`.

---

## Configure a provider

browsa splits providers into two categories:

- **Agent Providers** — full agent backend with tool execution (bash, file ops, web search, etc.). The AI can actually *do* things on the server side.
- **LLM Providers** — plain language model endpoint for conversation only. Model ID is required.

Use the **Ping** button in Settings to verify connectivity and auto-detect capabilities. The provider status (reachable / unreachable) is shown in the sidebar dropdown.

---

### 🤖 Hermes Agent

Hermes is a self-hosted AI agent with built-in tools (web search, terminal, file ops, memory, skills). browsa uses its `/v1/runs` API — richer than plain chat completions (tool progress, approval/clarification prompts for dangerous actions) — with a stable `X-Hermes-Session-Id` per conversation so Hermes can maintain session continuity server-side. Falls back to plain `/v1/chat/completions` automatically if a Hermes deployment doesn't advertise `/v1/runs` support.

**1. Install Hermes**

```bash
pip install hermes-agent   # or follow the official install guide
```

**2. Enable the API server** — add to `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=your-secret-key
```

**3. Start Hermes**

```bash
hermes gateway
# → [API Server] API server listening on http://127.0.0.1:8642
```

**4. Configure browsa** — open ⚙ Settings, select the **hermes** provider:

| Field | Value |
|---|---|
| Base URL | `http://<server-ip>:8642` |
| API Key | value of `API_SERVER_KEY` |

**5. Ping** to verify. `/v1/runs` support is auto-detected and enabled automatically.

---
### 💬 OpenAI-compatible LLM

Any endpoint that speaks `/v1/chat/completions` — OpenAI, Anthropic, Ollama, Groq, LiteLLM, etc.

**Configure browsa** — open ⚙ Settings, configure the **OpenAI-compatible** provider:

| Field | Value |
|---|---|
| Base URL | e.g. `https://api.openai.com` |
| API Key | your API key |
| Model ID | **required** — e.g. `gpt-4o`, `claude-sonnet-4-6` |

**Ping** validates connectivity and verifies the model ID is accepted by the server.

---

## Attaching page context

Click 📎 in the composer to attach the current page. browsa supports two attachment modes selectable in the composer footer:

| Mode | What gets sent |
|---|---|
| **Auto** | Tries Mozilla Readability first (clean article text, ~5–30 KB), falls back to DOM tree, then full `body.innerText` |
| **📷 Screenshot** | PNG of the visible tab — for multimodal models or visual content |

Attaching a PDF (or a page that turns out to be one) is automatic — no separate mode to pick. browsa tries [`pdf-inspector-wasm`](https://github.com/firecrawl/pdf-inspector) first (full layout reconstruction — tables, headings, columns — running client-side, nothing uploaded), falls back to plain `pdf.js` text extraction if that's unavailable or the PDF turns out to be a scanned/image-only page with no text layer, and as a last resort attaches just the PDF's URL so your agent can fetch and read it with its own tools. For figure-heavy PDFs (textbooks, papers with plots), browsa also crops the actual figure regions - not whole-page renders - pairs each with its caption, and sends them as inline vision content so a vision-capable model can actually see the diagrams; once the model has answered, those figure images are compacted to labeled text placeholders in history so later turns resend cheap text instead of the pixels.

GitHub file pages (`github.com/…/blob/…`) are a special case: browsa fetches the file's raw source from `raw.githubusercontent.com` directly. This is cleaner than scraping the rendered GitHub UI (markdown and code keep their structure instead of being flattened to plain text) and skips the page-cleanup step that would otherwise click through GitHub's nav menus and branch pickers.

For text selection, highlight text on the page and use the **floating toolbar** or **right-click context menu** (Ask / Explain / Translate / Summarize). The selection is sent automatically without needing to click 📎.

---

## Supported sites (XHR interception)

For sites where Readability produces poor results, browsa intercepts the browser's own API calls and extracts structured content — no signing, no re-auth, just observing what the page already fetched. Open the page and let it fully load before sending your first message.

| Site | Content extracted |
|---|---|
| **YouTube** | Title, transcript, chapters, description, author, view/like counts |
| **Bilibili** | Title, AI summary, subtitle/transcript, audio URL, video stats |
| **小红书** | Note title, description, tags, images, top comments, stats |
| **掘金** | Full article Markdown source |
| **知乎** | 专栏 article or top 3 answers to a question |
| **Twitter / X** | Tweet text, author, engagement stats |
| **雪球** | Stock quote or post content |
| **小宇宙** | Podcast episode title, description, show notes |
| **得到** | Article text |
| **极客时间** | Article text |

---

## Features

### Chat

- **Streaming replies** — tokens appear as they arrive; click ✕ or press `Esc` to stop
- **Think blocks** — `<think>` / `<thinking>` content shown in a collapsible block, auto-collapsed after streaming
- **Markdown rendering** — full GFM: tables, code blocks, lists, inline formatting
- **Syntax highlighting** — 40+ languages via highlight.js
- **LaTeX** — inline `$...$` and display `$$...$$` via KaTeX, offloaded to a Web Worker for formula-heavy messages so the panel doesn't jank
- **Mermaid diagrams** — rendered inline with zoom / pan / copy source / export SVG toolbar; sequence diagrams with a semicolon in dialogue text (e.g. embedded SQL) render correctly via an automatic escape-and-retry
- **ECharts charts** — ` ```echarts ` code blocks rendered inline with a resize-aware toolbar
- **Markmap mind maps** — ` ```markmap ` code blocks (a plain Markdown heading/list outline) rendered inline as an interactive, zoomable mind map with the same zoom/reset/copy/export toolbar as Mermaid/ECharts; no dedicated button needed — just ask for a mind map/outline and the model knows the format
- **Diff highlighting** — `diff` code blocks color `+` green and `-` red
- **Detail thread ("细聊")** — select any text inside a reply to open a scoped side conversation about just that excerpt, without touching the main history. Fully resizable, closes and discards everything on ✕
- **Edit & resend** — click ✏ on any user message to edit and re-send
- **Copy response** — click ⎘ to copy the full raw Markdown
- **Timestamps** — hover any message to see send time

### History & sessions

- **Session history** — save the current conversation as a named session, browse and restore past sessions from the 🕐 drawer
- **Export** — export any session as a Markdown file
- **In-conversation search** — `Ctrl+F` to search across all messages with prev/next navigation
- **Multi-select** — select multiple messages for batch deletion
- **Undo clear** — clearing history shows an undo option for 5 seconds

### Input

- **Image attachment** — drag-and-drop or paste images directly into the composer (for multimodal models)
- **Slash commands** — type `/` to see completions; see list below
- **Quick actions** — one-click Summarize / Key Points / Explain / → 中文 / Outline buttons above the composer
- **Floating selection toolbar** — appears when you highlight text on any page: Ask · Explain · → 中文 · Summarize
- **Right-click context menu** — browsa › Ask / Explain / Translate / Summarize on selected text

### Settings

- **Domain rules** — per-URL-pattern extra system prompt (e.g. always respond in English on `github.com`)
- **Mask rules** — regex-based content redaction before sending to the LLM (e.g. strip phone numbers)
- **Reply language** — force replies in a specific language regardless of page language
- **Max text chars** — cap how much page content is sent per turn
- **Auto-summarize long attachments** — when an attached page or video transcript exceeds the threshold (default: 40,000 chars), browsa chunks it, summarizes each chunk in parallel using the configured provider, and merges the result once in the background — the attachment response returns immediately with no latency, and subsequent turns use the compressed version instead of re-sending the full text every time. Timestamp markers in video transcripts (`[mm:ss]`) are explicitly preserved so clickable seek links keep working. Fails open: any error silently keeps the original text.
- **llms.txt** — when you attach a page (📎), browsa fetches `<origin>/llms.txt` once and bakes the site's LLM instructions into the attached page context (tied to the attached page, not the currently-active tab). Kept out of the system prompt so the prompt prefix stays byte-stable across turns (KV/prompt-cache friendly).

---

## Slash commands

Type `/` in the composer to see autocomplete. All commands can be followed by additional instructions:

```
/summarize focus on the methodology
/translate keep technical terms in English
```

| Command | Prompt sent to LLM |
|---|---|
| `/summarize` | 3–5 bullet summary |
| `/translate` | Translate to Chinese |
| `/rewrite` | More concise rewrite, keeping all facts |
| `/explain` | Explain for a beginner in simple language |
| `/outline` | Nested outline of headings only |
| `/keypoints` | Top 5 takeaways |
| `/prompt` | Show the current active system prompt (not sent to LLM) |

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+H` | Open / close side panel |
| `Enter` | Send message (configurable in Settings) |
| `Shift+Enter` | New line |
| `Ctrl+K` | Clear history (with undo) |
| `Ctrl+/` | Cycle context mode (Auto ↔ Screenshot) |
| `Ctrl+F` | Open in-conversation search |
| `Esc` | Cancel stream / close search / close drawer |

---

## How it works

- **`background.js`** — MV3 service worker. Single `handle()` message router for all extension messages — still the single dispatcher, but the two biggest cases (`CHAT`, `SUBCHAT`) delegate to `lib/handlers/`. Manages site XHR caches (keyed by `tabId`), streaming via per-turn `browsa-chat`/`browsa-subchat` ports, mid-stream tab switching via `streamState` (`lib/state.js`), and fires off a fire-and-forget attachment auto-summarize pass (`lib/handlers/attach-summarizer.js`) when a page/video attachment exceeds the configured length threshold.
- **`sidepanel.js`** — Chat UI orchestrator: init/send/history/approval-clarify cards/screenshot crop. The Markdown/Mermaid/Markmap/KaTeX/ECharts rendering pipeline, sessions drawer, in-conversation search, multi-select, and detail-thread ("细聊") side conversations are each their own module under `lib/sidepanel/`.
- **`lib/sidepanel/render.js`** — marked + DOMPurify + KaTeX + Mermaid + ECharts + Markmap + highlight.js pipeline. Streaming deltas are smoothed via `reveal-pacer.js` (a thin wrapper around the vendored `markstream-core` package); KaTeX rendering for the final per-message render offloads formula-heavy messages to a Web Worker (`katex-worker-client.js`/`katex.worker.js`), falling back to synchronous rendering below a small-batch threshold or on worker failure; Mermaid's SVG output is sanitized (`sanitizeMermaidSvg`, from the vendored `stream-markdown-parser` package) and sequence-diagram parse failures auto-retry with problem semicolons escaped (`mermaid-utils.js`). All three diagram vendor bundles (Mermaid/ECharts/Markmap) are speculatively preloaded (`preloadChartVendors()`) the moment a turn starts, so the first diagram in a session doesn't pay a multi-MB cold-load penalty right when it needs to render.
- **`lib/page-extractor.js`** — Injects Readability + Turndown into the page MAIN world for reader mode. For SPA sites, uses the XHR cache from the matching content script.
- **`lib/sidepanel/pdf-extractor.js`** — PDF attachment pipeline: tries `pdf-inspector-wasm` (full layout/table/heading reconstruction) in a dedicated Worker first, falls back to plain-text `pdf.js` extraction, and quality-gates both (empty/scanned results don't get treated as success) before the caller falls back further to a plain URL attachment.
- **`lib/openai-client.js`** — Fetch-based SSE streaming client. Supports `/v1/chat/completions` (all providers) and `/v1/runs` (Hermes — approval/clarification/tool-progress events, auto-detected).
- **`lib/storage.js`** — `chrome.storage.local` wrapper. Global flat conversation history (not per-tab), session management, mask rules.
- **Content scripts** (`lib/content-scripts/`) — Run at `document_start` in MAIN world. Wrap `window.fetch` and `XMLHttpRequest.prototype` to observe SPA API calls and forward structured data to the background.

---

## Project structure

```
browsa/
├── manifest.json
├── background.js                      # service worker + message router (dispatcher only)
├── sidepanel.{html,css,js}            # chat UI orchestrator
├── options.{html,css,js}              # settings page
├── lib/
│   ├── constants.js                   # shared constants (PAGE_CONTEXT_PREFIX, …)
│   ├── state.js                       # shared stream/approval state Maps (used by background.js)
│   ├── openai-client.js               # SSE streaming client
│   ├── page-extractor.js              # content extraction + site synthesizers
│   ├── storage.js                     # chrome.storage wrapper + session mgmt
│   ├── handlers/
│   │   ├── chat-handler.js            # CHAT case body
│   │   ├── subchat-handler.js         # SUBCHAT / SUBCHAT_ABORT case bodies
│   │   └── attach-summarizer.js       # auto-compress long page/video attachments
│   ├── markdown-chunker.js            # structure-aware truncation + chunking (fences/tables never split)
│   ├── sidepanel/                     # sidepanel.js's feature modules
│   │   ├── render.js                  # marked+DOMPurify+KaTeX+Mermaid+ECharts pipeline
│   │   ├── reveal-pacer.js            # smooth-reveal wrapper around vendored markstream-core
│   │   ├── katex-threshold.js         # "worth offloading to a worker?" heuristic
│   │   ├── katex-worker-client.js     # batches formulas to katex.worker.js, sync fallback
│   │   ├── katex.worker.js            # dedicated KaTeX rendering Worker
│   │   ├── mermaid-utils.js           # sequence-diagram semicolon fix + preview-height estimate
│   │   ├── pdf-extractor.js           # PDF attach: wasm-primary/pdf.js-fallback orchestration
│   │   ├── pdf-inspector-worker-client.js # pdf-inspector-wasm Worker client (sticky-failure, timeout→null)
│   │   ├── pdf-inspector.worker.js    # dedicated Worker running pdf-inspector-wasm's processPdf()
│   │   ├── sessions-ui.js             # sessions drawer
│   │   ├── multiselect.js             # bulk-delete mode
│   │   ├── msg-search.js              # Ctrl+F in-conversation search
│   │   ├── detail-thread.js           # "select text → 细聊" side conversation
│   │   ├── icons.js                   # ICONS SVG map
│   │   └── ui-utils.js                # $, escM, sendMessage, toast/confirm, card helpers
│   ├── content-scripts/               # MAIN-world XHR interceptors + ISOLATED-world toolbar
│   │   ├── selection-toolbar.js       # floating toolbar (Shadow DOM)
│   │   ├── xhs-content-script.js      # 小红书 XHR interceptor
│   │   ├── youtube-content-script.js  # YouTube player API interceptor
│   │   ├── bilibili-content-script.js # Bilibili video API interceptor
│   │   ├── juejin-content-script.js   # 掘金 article interceptor
│   │   ├── zhihu-content-script.js    # 知乎 article / Q&A interceptor
│   │   ├── twitter-content-script.js  # Twitter/X GraphQL interceptor
│   │   ├── xueqiu-content-script.js   # 雪球 stock/post interceptor
│   │   ├── xiaoyuzhou-content-script.js # 小宇宙 podcast interceptor
│   │   ├── dedao-content-script.js    # 得到 interceptor
│   │   └── geektime-content-script.js # 极客时间 interceptor
│   └── vendor/                        # bundled third-party libs
│       ├── Readability.iife.js
│       ├── Turndown.iife.js
│       ├── marked.bundle.js
│       ├── purify.bundle.js
│       ├── katex.bundle.js
│       ├── highlight.bundle.js
│       ├── mermaid.bundle.js
│       ├── echarts.bundle.js
│       ├── markmap-lib.bundle.js       # Markdown → mind map tree transformer
│       ├── markmap-view.bundle.js      # d3-zoom mind map SVG renderer
│       ├── markstream-core.bundle.js   # streaming-reveal pacing controller
│       ├── stream-markdown-parser.bundle.js # Mermaid SVG sanitizer
│       ├── pdf.bundle.js               # pdf.js — fallback PDF text extraction
│       ├── pdf.worker.bundle.js        # pdf.js's own Worker
│       ├── pdf_inspector_wasm.js       # pdf-inspector-wasm glue (wasm-bindgen)
│       └── pdf_inspector_wasm_bg.wasm  # pdf-inspector-wasm binary — primary PDF extraction
├── _locales/{en,zh_CN}/
├── icons/
├── build/
│   ├── build.mjs                      # esbuild vendor bundler
│   └── package.mjs                    # distribution zip builder
├── test/                              # node:test unit tests (673 tests)
└── check-compat.sh                    # MV3 / static compatibility check
```

---

## Browser compatibility

| Browser | Status | Notes |
|---|---|---|
| **Chrome 114+** | ✅ Supported | Primary target |
| **Edge 114+** | ✅ Supported | Identical install |
| **Brave 1.56+** | ✅ Should work | Same Chromium surface |
| **Firefox** | ❌ Not supported | No `side_panel` API |

---

## Security

- API keys are stored in `chrome.storage.local` on your machine only — never sent anywhere except your configured `baseUrl`.
- PDF attachments are parsed entirely client-side (WebAssembly + pdf.js, both running in the side panel) — the file's bytes are never uploaded anywhere, only the extracted text is sent to your configured provider.
- LLM replies are sanitized with DOMPurify before rendering, including a hook that blocks `data:image/svg+xml` sources (which can carry their own `<script>`/event handlers) while still allowing normal bitmap `data:` images.
- Mermaid diagram SVG output is sanitized before insertion (strips `<script>`, event-handler attributes, and dangerous URLs) — needed because Mermaid's `securityLevel:'loose'` mode, required for KaTeX math inside diagram labels, otherwise permits arbitrary HTML through.
- Content scripts only observe network requests; they never modify or block them.

---

## License

MIT
