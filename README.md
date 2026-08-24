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
npm test             # run 800+ unit tests
npm run package      # → browsa-v<version>.zip
```

`npm version patch|minor` bumps the version in both `package.json` and `manifest.json` automatically.

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

**Structured extraction** — works on any webpage; where Readability alone isn't enough (YouTube, Bilibili, 小红书, and more), browsa observes the page's own network requests and reads structured content directly — subtitles, comments, article source, quotes. No signing, no re-auth.

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
- **Auto-summarize long attachments** — when an attached page or video transcript exceeds the threshold (default: 100,000 chars), browsa chunks it, summarizes each chunk in parallel using the configured provider, and merges the result once in the background — the attachment response returns immediately with no latency, and subsequent turns use the compressed version instead of re-sending the full text every time. Timestamp markers in video transcripts (`[mm:ss]`) are explicitly preserved so clickable seek links keep working. Fails open: any error silently keeps the original text.
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

- **`background.js`** — MV3 service worker, single message router; streaming via per-turn ports, auto-summarize for oversized attachments.
- **`sidepanel.js`** — chat UI orchestrator; rendering (Markdown/Mermaid/Markmap/KaTeX/ECharts), sessions, search, detail-thread each live in `lib/sidepanel/`.
- **`lib/`** — page extraction (Readability cascade + XHR interception), SSE streaming client (`/v1/chat/completions` + Hermes `/v1/runs`), `chrome.storage.local` wrapper, content scripts.

---

## Browser compatibility

Chrome / Edge 114+ (primary target); Brave 1.56+ should work (same Chromium surface). Firefox is not supported (no `side_panel` API).

---

## Security

- API keys are stored in `chrome.storage.local` on your machine only — never sent anywhere except your configured `baseUrl`.
- PDFs are parsed entirely client-side (WASM + pdf.js) — the file's bytes never leave your device; only extracted text goes to your provider.
- LLM replies are sanitized with DOMPurify before rendering (blocks `data:image/svg+xml` sources, and Mermaid's SVG output is stripped of `<script>`/event-handler attributes).
- Content scripts only observe network requests; they never modify or block them.

---

## License

MIT
