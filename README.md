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

## Xiaohongshu (小红书) note: extraction

`browsa` extracts 小红书 note detail pages via **XHR interception**.

### Why this works
小红书's `/api/sns/web/v1/feed` XHR requires signed `x-s`, `x-s-common`,
and `x-t` headers (per [jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli))
plus a logged-in `web_session` cookie for the full desc. Without
those, XHS serves a different note, a skeleton, or an empty body
(see [jackwener/OpenCLI#994](https://github.com/jackwener/OpenCLI/issues/994)).

Rather than reverse-engineering the signing algorithm (fragile,
version-coupled), `browsa` injects a content script into
`xiaohongshu.com` pages that wraps `window.fetch` and
`XMLHttpRequest.prototype.send`. The browser's own signed fetch runs
unchanged — we just `.clone()` the response, parse the JSON, and
forward the note summary to the background. The result has the full
desc, image count, tag list, and interaction counts.

### How the data flows

```
[XHS SPA]   →  fetch('/api/sns/web/v1/feed', signed)
                 ↓
[content script: lib/xhs-content-script.js]
                 wraps fetch + XHR, clones response, extracts note
                 ↓ chrome.runtime.sendMessage
[background.js]  xhsXhrCache (Map<tabId, note>)
                 ↓ port.postMessage
[sidepanel.js]   lastXhsNote → renderDiagnosticsFromXhr()
                 ↓ sendMessage({type:'GET_PAGE_CONTEXT', ...})
[page-extractor.js]  extractActiveTab({xhsXhrNote})
                 ↓ if noteId matches URL
[synthesizeXhsResultFromXhr(note)] → ctx with full desc
```

### What if it doesn't work?

If the user isn't logged in to `xiaohongshu.com` in this browser,
the XHR returns a skeleton (no `data.noteList`) and the content
script filters it out via `isNoteDetailPayload()`. The side panel
then falls back to the DOM/INITIAL_STATE scrape, which may also be
unreliable. In that case a yellow banner appears explaining what
to do.

To fix: log in to `xiaohongshu.com` in this browser, reload the
note page, then re-send. The XHR will return real data within a
few hundred ms.

## Publish to GitHub

```bash
cd browsa
gh repo create browsa --public --source=. --push
```

## License

MIT

## Fixed in v0.20.4 — mid-stream tab switch

**Bug**: If the user switched tabs while the LLM was streaming a reply and
then switched back, the side panel appeared to freeze on a `▍` placeholder
even though the LLM had already finished. The reply was lost.

**Why**: The streaming port (`chrome.runtime.connect` named `browsa-chat`)
is owned by the side panel document. When the user switches tabs,
Chrome tears down the side panel iframe — the port disconnects. The
background had no record of the in-flight stream, so the freshly-arriving
side panel saw only persisted history (which doesn't include the
in-progress turn until `appendToHistory` runs at DONE time) and rendered
nothing. Worse, the v0.20.3 fix (`setTimeout(disconnect)` after DONE)
killed the port even faster, so the next switch-back couldn't recover.

**Fix**:
- `background.js` keeps a `streamState: Map<tabId, { acc, startedAt, lastDeltaAt }>`
  that survives port churn. Every `onDelta` both pushes to the current
  port and appends to `streamState.acc`.
- New message types: `STREAM_PEEK` (returns in-flight status + accumulated
  text) and `STREAM_RELEASE` (drops the state after DONE / cancel).
- The side panel calls `STREAM_PEEK` on `init()` and on every
  `chrome.tabs.onActivated` event. If a stream is in flight, it opens a
  new port, pre-renders the accumulated text into the assistant bubble,
  and continues receiving live deltas through the same listener.
- Replaced the background's `setTimeout(disconnect)` with explicit
  `STREAM_GOODBYE` + `STREAM_RELEASE` from the side panel — the cleanup
  is now deterministic and races-free.

**Tested by**: `test/stream-resume.test.mjs` (9 cases, including
"streamState survives the streaming port disconnecting").

