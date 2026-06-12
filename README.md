# browsa

> Side-panel AI chat for any webpage — talk to your LLM agent about what you're reading.

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

| Provider | Base URL | Notes |
|---|---|---|
| **Hermes** `api_server` | `http://<host>:8642` | Set `API_SERVER_KEY` from `~/.hermes/.env` |
| **Claude Code** | `http://localhost:8000` | Via an OpenAI-compatible wrapper |
| **Any OpenAI-compatible** | your URL | Ollama, vLLM, LM Studio, LiteLLM, etc. |

Use the **Ping** button in Settings to verify connectivity before chatting.

## Context modes

| Mode | What gets sent |
|---|---|
| **Reader** (default) | Mozilla Readability extracts the main article — clean, ~5–30 KB |
| **Full** | Raw `body.innerText` — everything, unfiltered |
| **Selection** | Only the text you've highlighted |
| **Screenshot** | PNG of the visible tab (for multimodal models) |

## Supported sites (XHR interception)

For SPA sites where Readability fails, browsa intercepts the browser's own API calls — no signing, no re-auth, just observing what the page already fetched:

| Site | What's intercepted | Content |
|---|---|---|
| **小红书** | `/api/sns/web/v1/feed` | Note title, desc, tags, images, stats |
| **掘金** | `api.juejin.cn/content_api/v1/article/detail` | `mark_content` — raw Markdown |
| **知乎** | `/api/v4/articles/{id}` (专栏) + `/api/v4/questions/{id}/answers` (问答) | HTML → text, top 3 answers |
| **得到** | `/content/detail` or `/article/detail` on dedao.cn | Article text |
| **极客时间** | `time.geekbang.org/serv/v1/article` | HTML → text |

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

## Changelog

### v0.20.8
- Multi-site XHR interception: 掘金, 知乎, 得到, 极客时间
- Removed Auto-attach and Wait JS controls (context mode selection is sufficient)
- `chrome.alarms`-based GC for stream state (MV3 best practice)
- Readability/Turndown source caching in service worker memory
- `tabStates` memory cap (10 tabs)
- Fixed: screenshot mode (`captureVisibleTab` used wrong variable)
- Fixed: `limitHint` for large pages was always null
- Fixed: `ensureReadabilityInjected` didn't inject missing library when one was already present
- Fixed: duplicate `CLEAR_HISTORY` case; `CHAT` path now uses XHR cache
- Fixed: `autoAttachPage` preference was never persisted

### v0.20.7
Fixed "stream finished while away → stuck on ▍" bug. Added `STREAM_DEBUG` message for observability.

### v0.20.6
Snap to bottom when switching back to a tab mid-stream.

### v0.20.5
Cancel (Esc) now actually aborts the LLM fetch via `AbortController`.

### v0.20.4
Mid-stream tab switch: `streamState` survives port disconnect; `STREAM_PEEK` / `STREAM_HELLO` resume on switch-back.

## License

MIT
