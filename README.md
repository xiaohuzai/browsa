# browsa

> Hand the current page to your AI agent — single side-panel chat for **Hermes**, **Claude Code**, or any OpenAI-compatible API.

browsa is a small Chrome / Edge extension (Manifest V3) that opens a side panel next to whatever tab you're on, lets you ask a question, and ships the page context (full HTML / selection / screenshot) to whichever OpenAI-compatible agent runtime you configure.

```
[Web page]  →  [browsa side panel]  →  [your agent runtime]  →  [streaming reply]
                                         http://<host>:8642/v1/chat/completions
                                         http://localhost:8000/v1/chat/completions
                                         (or any OpenAI-compatible endpoint)
```

## Why

- **Multi-provider** — works with any agent that exposes an OpenAI-compatible `/v1/chat/completions` endpoint. Hermes `api_server`, Claude Code via an openai-compatible wrapper, or your own LLM proxy.
- **One-click page context** — choose full HTML, text selection, or a screenshot. No copy-pasting.
- **Per-tab history** — conversations are scoped to the tab you started them on.
- **Per-provider config** — base URL, API key, default model, stream on/off. Switch providers from the side panel.

## Install (development / unpacked)

1. Clone or download this repo.
2. Open `edge://extensions` (or `chrome://extensions`).
3. Enable **Developer mode** (bottom-left toggle).
4. Click **Load unpacked** → select the `browsa/` directory.
5. Click the browsa icon in the toolbar (or press `Ctrl+Shift+H`) to open the side panel.
6. Click **⚙ Settings** to configure providers (base URL, API key, model).
7. Use the **Ping** button to verify each provider.

## Browser compatibility

| Browser        | Status     | Notes                                              |
| -------------- | ---------- | -------------------------------------------------- |
| **Edge** 114+  | ✅ Primary | Default development target. Side panel works.      |
| **Chrome** 114+| ✅ Same as Edge | Same Chromium base; identical install steps.   |
| **Brave** 1.56+| ✅ Should work | Same Chromium API surface as Chrome.              |
| **Opera** 100+ | ⚠️ Untested | Should work; side panel API is supported since 100. |
| **Firefox**    | ❌ Not supported | Uses different manifest keys (`browser_specific_settings`, no `side_panel`). Would need a separate build. |

The `manifest.json` declares `minimum_chrome_version: "114"` because the
`chrome.sidePanel` API shipped in 114. Both Edge and Chrome auto-update to
versions well past this.

## Configure a provider

| Provider | Typical base URL | Notes |
|---|---|---|
| **Hermes** `api_server` | `http://<host>:8642` | `API_SERVER_KEY` from `~/.hermes/.env` |
| **Claude Code** (via `claude-code-openai-wrapper` or `claude-code-api`) | `http://localhost:8000` | Wrapper bundles the Claude Agent SDK |
| **Any OpenAI-compatible** | (your URL) | Point at any `/v1/chat/completions` endpoint — Ollama, vLLM, LM Studio, LiteLLM, etc. |

See [`config.example.json`](./config.example.json) for a starting point.

## How it works

- `manifest.json` declares `host_permissions: ["http://*/*", "https://*/*"]` so any provider URL works without rebuilding the extension.
- `lib/openai-client.js` is a ~150-line OpenAI Chat Completions client. It handles both **streaming** (SSE via `fetch` + `ReadableStream`) and **non-streaming** calls, and emits typed errors for config / network / API failures.
- `lib/page-extractor.js` runs in the page's **MAIN world** via `chrome.scripting.executeScript`. It loads `Readability.js` (Mozilla, MIT) for main-content extraction and `Turndown.js` (HTML→Markdown), then returns one of three context modes:
  - `full` — full page (Readability → Markdown), capped at 60 KB
  - `selected` — only the user's text selection (falls back to full if empty)
  - `screenshot` — a `data:image/png;...` URL of the visible tab (multimodal)
- `background.js` is a module service worker. It routes messages from the side panel, extracts page context, builds the messages array, calls the active provider, and streams deltas back via a long-lived `Port`.
- `sidepanel.js` renders the chat UI with **blinking caret streaming** (60fps textContent during generation), then post-processes the final reply with `marked` (Markdown→HTML) and `DOMPurify` (XSS sanitization) so headings/lists/code blocks/quotes/tables render cleanly.

## Security

- The API key is stored in `chrome.storage.local` on your machine only. It is **not** transmitted anywhere except the configured `baseUrl`.
- `host_permissions` is intentionally wide so you can change providers without rebuilding. This is a development-time convenience; if you fork and publish, consider narrowing it to your own domain.

## Project structure

```
browsa/
├── manifest.json
├── background.js               # service worker (module)
├── sidepanel.html / .css / .js # chat UI + Markdown rendering
├── options.html / .css / .js   # provider config UI
├── lib/
│   ├── openai-client.js        # OpenAI Chat Completions + SSE
│   ├── page-extractor.js       # tab context extraction (MAIN world)
│   ├── storage.js              # chrome.storage wrapper
│   ├── Readability.js          # Mozilla main-content extractor (bundled)
│   ├── Turndown.js             # HTML → Markdown (bundled)
│   ├── marked.min.js           # Markdown → HTML for LLM replies (bundled)
│   └── purify.min.js           # XSS sanitizer for LLM replies (bundled)
├── icons/                      # 16 / 48 / 128
├── config.example.json
├── .gitignore
├── LICENSE                     # MIT
└── README.md
```

## Roadmap

- Per-tab history UI (clear / export)
- Image paste into composer
- Slash commands (`/summarize`, `/translate`, `/rewrite`)
- Multi-modal image upload from clipboard
- Fork-able: add your own provider preset in `lib/storage.js` defaults

## ⚠️ Xiaohongshu (小红书) note: extraction is best-effort

The XHS detail page is a React SPA that fetches its actual content via
`/api/sns/web/v1/feed`, with **signed requests** (`x-s`, `x-s-common`,
`x-t` headers) and **login state required for the full desc**. Without
the right signed headers or a logged-in `web_session` cookie, XHS
serves a different note, a skeleton, or an empty body.

browsa reads the rendered DOM (`#detail-title`, `#detail-desc`) and
`window.__INITIAL_STATE__.note.noteDetailMap[noteId].note`, but it
**cannot generate the signed headers** without a full reverse-engineer
of the x-s algorithm. So the extracted text may be:
- the right note (when the user is logged in and the XHR succeeds)
- a different note (when `xsec_token` has been reused/expired)
- empty or a skeleton (when the XHR was rejected)

As of v0.18.0, a yellow banner in the side panel warns you when the
extraction looks suspect (empty title, desc < 20 chars, no images +
near-empty body). The LLM still receives whatever was extracted, but
at least you know to double-check.

A real fix requires either:
1. XHR interception that piggybacks on the browser's already-signed
   fetch (with a content script), or
2. Embedding the x-s signing algorithm in the extension.

Tracked for v0.19.0+.

## Publish to GitHub

```bash
cd browsa
gh repo create browsa --public --source=. --push
```

## License

MIT
