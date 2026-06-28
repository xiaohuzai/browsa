# browsa

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
npm test             # run 68 unit tests
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

Hermes is a self-hosted AI agent with built-in tools (web search, terminal, file ops, memory, skills). browsa uses its `/v1/responses` stateful API — only the new message is sent each turn; Hermes stores the full conversation history server-side.

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

**5. Ping** to verify. The Responses API is auto-detected and enabled automatically.

---

### 🤖 Claude Code (via claude-code-openai-wrapper)

This setup runs the real Claude Code CLI on your server — with its full tool suite (bash, file read/write, etc.) — and exposes it as a standard OpenAI-compatible HTTP API.

**Prerequisites:** `claude` CLI installed and authenticated on the server (`claude auth login` or `ANTHROPIC_API_KEY` set).

**1. Install uv** (if not already installed)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**2. Clone and install the wrapper**

```bash
git clone https://github.com/RichardAtCT/claude-code-openai-wrapper
cd claude-code-openai-wrapper
uv python install 3.11
uv venv --python 3.11
source .venv/bin/activate
uv pip install -e .
```

**3. Configure** — create `claude-code-openai-wrapper/.env`:

```bash
# Directory where Claude Code will operate (your project root)
CLAUDE_CWD=/path/to/your/project

# A password you make up — browsa uses this as the API Key
API_KEYS=make-up-any-password-here

# Auth method — pick one:
CLAUDE_AUTH_METHOD=cli          # use existing `claude auth login` session
# ANTHROPIC_API_KEY=sk-ant-...  # or direct API key

IS_SANDBOX=1     # required if running as root
MAX_TURNS=50     # max tool-call turns per request (default 10)
```

**4. Start the wrapper**

```bash
source .venv/bin/activate
uvicorn src.main:app --host 0.0.0.0 --port 8000

# To keep running in background:
tmux new -s claude-wrapper
# ... start as above, then Ctrl+B D to detach
```

**5. Configure browsa** — open ⚙ Settings, select the **claude-code** provider:

| Field | Value |
|---|---|
| Base URL | `http://<server-ip>:8000` |
| API Key | value of `API_KEYS` |
| Model ID | `claude-sonnet-4-6` (optional — wrapper picks a default if blank) |

> **Note:** Claude Code operates in `CLAUDE_CWD`. Set it to your project root so Claude can read and write your actual files.

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
- **LaTeX** — inline `$...$` and display `$$...$$` via KaTeX
- **Mermaid diagrams** — rendered inline with zoom / pan / copy source / export SVG toolbar
- **Diff highlighting** — `diff` code blocks color `+` green and `-` red
- **Edit & resend** — click ✏ on any user message to edit and re-send
- **Regenerate** — click ↺ on any assistant reply to regenerate from that point
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
- **llms.txt** — optionally fetch `<origin>/llms.txt` before each chat for site-specific LLM instructions

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

- **`background.js`** — MV3 service worker. Single `handle()` message router for all extension messages. Manages site XHR caches (keyed by `tabId`), streaming via long-lived `browsa-chat` ports, and mid-stream tab switching via `streamState`.
- **`sidepanel.js`** — Chat UI. Streaming markdown rendering, live think-block routing, mermaid/KaTeX/hljs rendering, message editing, session drawer, in-conversation search, multi-select.
- **`lib/page-extractor.js`** — Injects Readability + Turndown into the page MAIN world for reader mode. For SPA sites, uses the XHR cache from the matching content script.
- **`lib/openai-client.js`** — Fetch-based SSE streaming client. Supports `/v1/chat/completions` (all providers) and `/v1/responses` (Hermes stateful API).
- **`lib/storage.js`** — `chrome.storage.local` wrapper. Global flat conversation history (not per-tab), session management, mask rules.
- **Content scripts** — Run at `document_start` in MAIN world. Wrap `window.fetch` and `XMLHttpRequest.prototype` to observe SPA API calls and forward structured data to the background.

---

## Project structure

```
browsa/
├── manifest.json
├── background.js                      # service worker + message router
├── sidepanel.{html,css,js}            # chat UI
├── options.{html,css,js}              # settings page
├── lib/
│   ├── constants.js                   # shared constants (PAGE_CONTEXT_PREFIX, …)
│   ├── openai-client.js               # SSE streaming client
│   ├── page-extractor.js              # content extraction + site synthesizers
│   ├── storage.js                     # chrome.storage wrapper + session mgmt
│   ├── selection-toolbar.js           # floating toolbar (Shadow DOM)
│   ├── xhs-content-script.js          # 小红书 XHR interceptor
│   ├── youtube-content-script.js      # YouTube player API interceptor
│   ├── bilibili-content-script.js     # Bilibili video API interceptor
│   ├── juejin-content-script.js       # 掘金 article interceptor
│   ├── zhihu-content-script.js        # 知乎 article / Q&A interceptor
│   ├── twitter-content-script.js      # Twitter/X GraphQL interceptor
│   ├── xueqiu-content-script.js       # 雪球 stock/post interceptor
│   ├── xiaoyuzhou-content-script.js   # 小宇宙 podcast interceptor
│   ├── dedao-content-script.js        # 得到 interceptor
│   ├── geektime-content-script.js     # 极客时间 interceptor
│   └── vendor/                        # bundled third-party libs
│       ├── Readability.iife.js
│       ├── Turndown.iife.js
│       ├── marked.bundle.js
│       ├── purify.bundle.js
│       ├── katex.bundle.js
│       ├── highlight.bundle.js
│       └── mermaid.bundle.js
├── _locales/{en,zh_CN}/
├── icons/
├── build/
│   ├── build.mjs                      # esbuild vendor bundler
│   └── package.mjs                    # distribution zip builder
├── test/                              # node:test unit tests (68 tests)
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
- LLM replies are sanitized with DOMPurify before rendering.
- Content scripts only observe network requests; they never modify or block them.

---

## License

MIT
