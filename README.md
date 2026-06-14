# browsa

> **browsa** = **brow**ser **s**ide p**a**nel **A**I. Side-panel AI chat for any webpage — talk to your LLM agent about what you're reading.

browsa is a Chrome / Edge extension (Manifest V3) that opens a chat panel next to whatever tab you're on, attaches the page content, and streams replies from any OpenAI-compatible API.

```
[Web page]  →  [browsa side panel]  →  [your LLM / agent runtime]  →  streaming reply
                                         http://localhost:8642/v1/chat/completions
                                         (or any OpenAI-compatible endpoint)
```

## Install (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** → select the `browsa/` directory.
5. Press `Ctrl+Shift+H` (or click the toolbar icon) to open the side panel.
6. Click **⚙ Settings** to configure providers (base URL, API key, model).

## Build & package

```bash
npm install          # first time only
npm test             # run tests
npm run package      # → browsa-v<version>.zip
```

To install from the zip: unzip, then **Load unpacked** as above.

## Configure a provider

browsa works with any OpenAI-compatible endpoint. Two agent backends are pre-configured as presets: **Hermes Agent** and **Claude Code**. Both give you a full agentic experience — the AI can search the web, run code, read files, and more on the server side.

Use the **Ping** button in Settings to verify connectivity before chatting.

---

### Hermes Agent

Hermes is a self-hosted AI agent with built-in tools (web search, terminal, file ops, memory, skills). browsa uses its `/v1/responses` stateful API — only the new message is sent each turn, Hermes stores the full conversation history server-side.

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
| Default model | `hermes-agent` |
| Responses API | ✅ auto-enabled on Ping |

**5. Ping** to verify. Responses API will be auto-detected and enabled.

---

### Claude Code (via claude-code-openai-wrapper)

This setup runs the real Claude Code CLI on your server — with its full tool suite (bash, file read/write, etc.) — and exposes it as a standard OpenAI-compatible HTTP API. browsa talks to the wrapper; the wrapper runs `claude` locally.

**Prerequisites:** `claude` CLI installed and authenticated on the server (`claude auth login` or `ANTHROPIC_API_KEY` set).

**1. Install uv** (if not already installed)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**2. Clone and install the wrapper**

```bash
git clone https://github.com/RichardAtCT/claude-code-openai-wrapper
cd claude-code-openai-wrapper
uv python install 3.11          # download Python 3.11 if not available
uv venv --python 3.11           # create isolated venv
source .venv/bin/activate
uv pip install -e .
```

**3. Configure** — create `claude-code-openai-wrapper/.env` (same folder as `pyproject.toml`):

```bash
# Directory where Claude Code will operate (your project root)
CLAUDE_CWD=/path/to/your/project

# A password you make up — browsa will use this same value in its API Key field
# This is NOT an Anthropic API key, just a local access token for the wrapper
API_KEYS=make-up-any-password-here

# Auth method — pick one:
# Option A: use existing `claude auth login` session (recommended)
CLAUDE_AUTH_METHOD=cli
# Option B: direct Anthropic API key
# ANTHROPIC_API_KEY=sk-ant-...

# Required if running as root (e.g. on a server)
IS_SANDBOX=1

# Max tool-call turns per request (default 10, increase for complex tasks)
MAX_TURNS=50
```

**4. Start the wrapper**

```bash
source .venv/bin/activate
uvicorn src.main:app --host 0.0.0.0 --port 8000
```

To keep running in background, use tmux:

```bash
tmux new -s claude-wrapper
source .venv/bin/activate
uvicorn src.main:app --host 0.0.0.0 --port 8000
# Ctrl+B D to detach (server keeps running)
```

To reattach and view logs later:

```bash
tmux attach -t claude-wrapper
```

**5. Configure browsa** — open ⚙ Settings, select the **claude-code** provider:

| Field | Value |
|---|---|
| Base URL | `http://<server-ip>:8000` |
| API Key | value of `API_KEYS` |
| Default model | `claude-sonnet-4-6` (or any model your account supports) |
| Responses API | ☐ leave off |

`enable_tools` is always on — Claude Code's bash, file, and other tools are active for every request. No extra configuration needed.

**6. Ping** to verify.

> **Note on working directory:** Claude Code operates in `CLAUDE_CWD`. Set it to your project root so Claude can read and write your actual files. Leave it unset to use a temporary isolated sandbox.


## Context modes

| Mode | What gets sent |
|---|---|
| **Reader** (default) | Mozilla Readability extracts the main article — clean, ~5–30 KB |
| **Full** | Raw `body.innerText` — everything, unfiltered |
| **Selection** | Only the text you've highlighted |
| **Screenshot** | PNG of the visible tab (for multimodal models) |

## Supported sites (XHR interception)

For SPA sites where Readability fails, browsa intercepts the browser's own API calls — no signing, no re-auth, just observing what the page already fetched:

| Site | Content extracted |
|---|---|
| **小红书** | Note title, description, tags, images, stats |
| **掘金** | Full article Markdown |
| **知乎** | 专栏 article or top 3 question answers |
| **得到** | Article text |
| **极客时间** | Article text |

> **Note:** Open the article page first and let it fully load. Then send your message. The interception happens when the SPA makes its own API call — browsa just observes it.

## Slash commands

Type these in the composer:

| Command | Action |
|---|---|
| `/summarize` | 3–5 bullet summary |
| `/translate` | Translate to Chinese |
| `/rewrite` | More concise rewrite |
| `/explain` | Explain for a beginner |
| `/outline` | Heading-only outline |
| `/keypoints` | Top 5 takeaways |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+H` | Open / close side panel |
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+K` | Clear history |
| `Ctrl+/` | Cycle context mode |
| `Esc` | Cancel streaming reply |

## How it works

- **`background.js`** — MV3 service worker. Routes messages, manages per-site XHR caches, streams LLM replies via a long-lived port. Handles mid-stream tab switching via `streamState` (accumulated reply survives port disconnect).
- **`lib/page-extractor.js`** — Injects Readability + Turndown into the page's MAIN world for reader mode. For SPA sites, uses the XHR cache first and skips DOM injection entirely.
- **`lib/openai-client.js`** — Minimal fetch-based SSE streaming client for `/v1/chat/completions`.
- **`sidepanel.js`** — Chat UI with 60fps blinking-caret streaming, per-tab history, Markdown rendering (marked + DOMPurify).
- **Content scripts** — Run at `document_start` in MAIN world. Wrap `window.fetch` and `XHR.prototype` to observe SPA API calls and forward structured data to the background.

## Project structure

```
browsa/
├── manifest.json
├── background.js                    # service worker
├── sidepanel.{html,css,js}          # chat UI
├── options.{html,css,js}            # settings page
├── lib/
│   ├── openai-client.js             # SSE streaming client
│   ├── page-extractor.js            # content extraction + site synthesis
│   ├── storage.js                   # chrome.storage wrapper
│   ├── xhs-content-script.js        # 小红书 XHR interceptor
│   ├── juejin-content-script.js     # 掘金 XHR interceptor
│   ├── zhihu-content-script.js      # 知乎 XHR interceptor
│   ├── dedao-content-script.js      # 得到 XHR interceptor
│   ├── geektime-content-script.js   # 极客时间 XHR interceptor
│   └── vendor/                      # bundled third-party libs
│       ├── Readability.iife.js
│       ├── Turndown.iife.js
│       ├── marked.bundle.js
│       └── purify.bundle.js
├── _locales/{en,zh_CN}/
├── icons/
├── build/                           # build + package scripts
├── test/                            # node:test unit tests
└── check-compat.sh                  # MV3 / cross-browser lint
```

## Browser compatibility

| Browser | Status | Notes |
|---|---|---|
| **Edge 114+** | ✅ Primary | Default target |
| **Chrome 114+** | ✅ Same as Edge | Identical install |
| **Brave 1.56+** | ✅ Should work | Same Chromium surface |
| **Firefox** | ❌ Not supported | No `side_panel` API |

## Security

- API keys are stored in `chrome.storage.local` on your machine only — never sent anywhere except your configured `baseUrl`.
- LLM replies are sanitized with DOMPurify before rendering.
- Content scripts only observe requests; they never modify them.

## License

MIT
