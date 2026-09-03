<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/assets/readme/hero-en.png" alt="browsa — read anywhere, ask anywhere" width="100%" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14171f?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="#install"><img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-114%2B-c2410c?style=flat-square" alt="Chrome / Edge 114+" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/browsa/pulls"><img src="https://img.shields.io/badge/PRs-welcome-926c0d?style=flat-square" alt="PRs welcome" /></a>
</p>

<p align="center">
  <a href="https://xiaohuzai.github.io/browsa/"><strong>Website</strong></a> · <a href="#see-it-in-action"><strong>Screenshots</strong></a> · <a href="#install"><strong>Install</strong></a> · <a href="https://github.com/xiaohuzai/browsa/issues"><strong>Issues</strong></a>
</p>

---

**browsa** (**brow**ser **s**ide p**a**nel **A**I) is a Chrome / Edge extension that opens a chat panel next to whatever tab you're on, attaches the page — article, video, or PDF — and streams replies from **your own** model or agent: any OpenAI, Anthropic, or Ollama-compatible API, or a full agent backend (Hermes, OpenSquilla) with tools, memory, and approvals. No subscription, no markup — your keys stay on your machine.

## See it in action

**Video pages** — ask for a summary and the key points come back as clickable `[mm:ss]` timestamps; click one to jump straight back to the moment. No subtitles? browsa transcribes the audio (ASR) or reads the visuals.

![browsa summarizing a Bilibili video into clickable timestamped notes](docs/assets/readme/video-notes.png)

**Papers & PDFs** — parsed entirely on your machine, nothing uploaded: tables, headings, and multi-column layout reconstructed, and actual figure regions cropped out and sent as images, so a vision model can actually *see* Figure 1.

![browsa explaining Figure 1 of the Attention Is All You Need paper on arXiv](docs/assets/readme/pdf-figures.png)

**Feeds & messy pages** — where plain readers give up, browsa reads the page's own data directly: subtitles, comments, note content. No re-auth, no signing in.

![browsa extracting decision-ready key points from a Xiaohongshu note](docs/assets/readme/deep-extraction.png)

## Install

1. Clone or download this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** → select the `browsa/` directory.
4. Press `Ctrl+Shift+H` (or click the toolbar icon) — the panel opens next to any page.
5. Click **⚙ Settings** and connect a provider below.

<details>
<summary><b>Build & package</b></summary>

```bash
npm install          # first time only
npm test             # run 800+ unit tests
npm run package      # → browsa-v<version>.zip
```

`npm version patch|minor` bumps the version in both `package.json` and `manifest.json` automatically.

</details>

## Connect a provider

browsa works with two kinds of backends:

- **Agent providers** — full agent backends with server-side tool execution (bash, file ops, web search…). The AI can actually *do* things.
- **LLM providers** — plain chat endpoints for conversation. Model ID required.

Open ⚙ Settings, fill in Base URL + API key, hit **Ping** — connectivity is verified and capabilities auto-detected; the first provider you verify becomes active.

![browsa settings listing OpenAI, Claude, Ollama, and Hermes Agent providers](docs/assets/readme/providers-en.png)

<details>
<summary><b>🤖 Hermes Agent</b> — self-hosted agent with built-in tools</summary>

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

**4. Configure browsa** — open ⚙ Settings, select the **Hermes Agent** provider. It only needs a Base URL and API key — its own `/v1/runs` protocol is used automatically (no API-type dropdown).

| Field | Value |
|---|---|
| Base URL | `http://<server-ip>:8642` |
| API Key | value of `API_SERVER_KEY` |

**5. Ping** to verify. `/v1/runs` support is auto-detected and enabled automatically.

</details>

<details>
<summary><b>🦑 OpenSquilla Agent</b> — local desktop agent over gateway WebSocket</summary>

[OpenSquilla](https://github.com/opensquilla/opensquilla) is a local desktop agent (gateway + Web UI + Electron app) with a token-efficient microkernel design, model routing, and skills. browsa talks to its **gateway WebSocket** (`/ws`) — the same channel its own Web UI uses — so you get the full agent experience: server-side session memory, streaming deltas, thinking output, and server-side cancellation.

**1. Install & start the gateway**

```bash
uv tool install --python 3.12 "opensquilla[recommended] @ https://github.com/opensquilla/opensquilla/releases/download/v0.5.4/opensquilla-0.5.4-py3-none-any.whl"
opensquilla gateway start
# → running: http://127.0.0.1:18791
```

**2. Let the extension in** — the gateway's origin guard rejects browser origins it doesn't know (that's what keeps hostile web pages out). Add browsa's origin to `~/.opensquilla/config.toml`:

```toml
[cors]
allowed_origins = ["chrome-extension://apoodheofdhglelbnmggeokbhampbmgn"]
```

This is browsa's **pinned extension ID** (fixed via the manifest key, the same on every machine and matching the future store listing — verify at `chrome://extensions` → browsa → **ID**). Accepting `chrome-extension://` origins needs OpenSquilla's origin-guard extension for non-http(s) origins — current releases 403 them even when listed; it's a small upstream patch (`gateway/origin_guard.py`, same pattern as the registered desktop origin), PR pending.

**3. Configure browsa** — open ⚙ Settings, select the **OpenSquilla** provider:

| Field | Value |
|---|---|
| Base URL | `ws://127.0.0.1:18791/ws` |
| API Key | only if your gateway requires a token (optional) |

**4. Ping** to verify — it performs the real WebSocket handshake, so a green ping proves both connectivity and the origin allowlist.

Notes: each browsa conversation maps to one gateway session (`agent:main:browsa:…`, reset when you clear browsa's history). Chat history lives on the gateway side — browsa forwards your text plus any page you attached right before asking (the 📎 context rides along on the next message, then lives in the gateway's own transcript); pasted images stay in browsa's own history but are not forwarded to OpenSquilla yet (its `chat.send` attachment encoding is not documented — v1 sends text only); the reply-language preference is prepended to the message since this protocol has no system-prompt field.

</details>

<details>
<summary><b>⚙️ Codex Agent</b> — the local Codex engine, no URL, no key</summary>

browsa can drive the OpenAI **Codex** engine installed on your own machine (CLI or the desktop app's managed copy) — the same `codex app-server` interface the VS Code extension uses. There is nothing to type: no Base URL, no API key — the connection is local and authenticated by your existing Codex login.

A browser extension can't spawn processes, so browsa connects through the Native-Messaging bridge that ships in this repo ([bridge/](bridge/README.md)) — a small, open, auditable host. You already have the code (you cloned browsa to load the extension), so installing is one command from the repo root:

```bash
node bridge/cli/agent-bridge.mjs install   # wizard: enable codex → Enter to allow browsa
```

The wizard reads browsa's pinned extension ID straight from `manifest.json` (no IDs to copy), registers the bridge for your browsers (Chrome / Edge / Chromium), and allowlists **exactly** the extensions you approve — no wildcard; an unapproved extension can never drive your local agents. Engine binary discovery (PATH → Codex desktop's managed copy) is the bridge's job; if your engine needs environment variables (e.g. an API-key provider), put `KEY=VALUE` lines in `~/.agent-bridge.env`.

**Then** restart the browser, open ⚙ Settings → select the **Codex** provider → **Ping** — it performs a real app-server handshake and shows the engine version + model count.

Notes: each browsa conversation maps to one Codex thread that lives in `~/.codex` (cleared with browsa's history; a lost thread falls back to a fresh one). Replies stream as deltas; thinking summaries render as `<thinking>` blocks. Approvals for shell commands and file patches arrive as interactive cards — Allow / Allow for session / Deny. Sandbox and network policy stay where they belong: codex's own settings (`sandbox_mode` / `network_access` in `~/.codex/config.toml` or the desktop app) — browsa neither reads nor overrides them. Pasted images are not forwarded yet (Codex's `turn/start` takes file paths; converting data-URLs from the service worker is a future step).

</details>

<details>
<summary><b>💬 LLM providers</b> — OpenAI · Anthropic · Ollama · Groq · LiteLLM · any compatible endpoint</summary>

Any endpoint that speaks OpenAI **Chat Completions** (`/v1/chat/completions`), OpenAI **Responses** (`/v1/responses`), or **Anthropic Messages** (`/v1/messages`).

Open ⚙ Settings → **LLM Providers**. An empty **LLM 1** slot is reserved for you — fill it in and hit **Save**, or use **＋ Add Provider** anytime:

| Field | Value |
|---|---|
| Alias | a name you choose (e.g. "My OpenAI", "本地模型") — shown in the sidebar dropdown so multiple providers stay distinguishable |
| Base URL | e.g. `https://api.openai.com` |
| API Key | your API key |
| Model ID | e.g. `gpt-4o`, `claude-3-5-sonnet` (required) — comma-separate multiple models and the sidebar dropdown expands to one "Alias · model" entry each |
| API | the protocol this endpoint speaks: Chat Completions / Responses / Anthropic |

Add as many LLM providers as you like; each picks its own protocol and carries its own alias. A single card can also carry several Model IDs — one card covers an entire gateway hosting dozens of models. Use the **✕** on a card to remove it (the built-in Hermes agent card is fixed and not removable).

</details>

## What browsa reads

Click 📎 to attach the current tab — **Auto** mode (clean article text, falling back to DOM tree, then full page text) or **📷 Screenshot** mode (the visible tab, for multimodal models). Attaching a PDF — or a page that turns out to be one — is automatic; no mode to pick.

| You're reading | What browsa sends |
|---|---|
| Articles & docs | clean article text; the site's `llms.txt` instructions folded into the context |
| PDFs & papers | full layout — tables, headings, columns — parsed in-browser; figure regions cropped and sent as images to vision models (compacted to labeled placeholders in history after answering) |
| Videos | transcript with clickable `[mm:ss]` timestamps; subtitle-less videos auto-transcribed (ASR, optional — Volcengine Ark key in Settings) or visually analyzed together with the speech |
| GitHub file pages | raw source from `raw.githubusercontent.com` — markdown and code keep their structure |
| Feishu / Lark docs | the page's editor block structure parsed directly — headings, lists, and **table rows & columns** survive |
| Anything messy | the page's own network requests observed and read directly — subtitles, comments, article source (YouTube, Bilibili, 小红书, and more) |

To ask about a text selection, highlight it and use the **floating toolbar** or **right-click menu** (Ask / Explain / Translate / Summarize) — no need to click 📎.

## Features

The screenshots above are the shape of it — the full reference lives here:

<details>
<summary><b>Chat</b> — streaming, thinking blocks, diagrams, detail thread…</summary>

| Feature | What you get |
|---|---|
| **Streaming replies** | tokens appear as they arrive; click ✕ or press `Esc` to stop |
| **Think blocks** | `<think>` / `<thinking>` content in a collapsible block, auto-collapsed after streaming |
| **Markdown & highlighting** | full GFM (tables, code blocks, lists); 40+ languages via highlight.js; `diff` blocks color `+` green / `-` red |
| **LaTeX** | inline `$...$` and display `$$...$$` via KaTeX — formula-heavy messages offloaded to a Web Worker so the panel doesn't jank |
| **Mermaid · ECharts · Markmap** | ` ```mermaid ` / ` ```echarts ` / ` ```markmap ` code blocks render inline, each with a zoom / copy / export-SVG toolbar; just ask for a chart or mind map — the model knows the format |
| **Detail thread ("细聊")** | select any text inside a reply to open a scoped side-conversation about just that excerpt, without touching the main history; fully resizable |
| **Edit & resend · Regenerate** | ✏ edits and resends any user message; ⟳ re-runs any assistant reply |
| **Queued follow-ups** | typing while a reply streams queues your message; it sends automatically once the stream ends |
| **Error cards** | provider errors classified into plain language (auth / rate-limit / timeout / network / 5xx), raw error expandable and copyable |
| **Copy & timestamps** | ⎘ copies the full raw Markdown; hover any message to see its send time |

</details>

<details>
<summary><b>History & sessions</b> — drawers, search, export…</summary>

| Feature | What you get |
|---|---|
| **Sessions** | save the conversation as a named session; browse and restore from the 🕐 drawer; pin favorites above the list |
| **Search everywhere** | `Ctrl+F` across all messages in a conversation; the drawer filters sessions by title **and** message content (content-only hits flagged) |
| **Export** | any session as a Markdown file |
| **Safe deletion** | two-step armed delete for sessions; multi-select messages for batch deletion; clearing history is undoable for 5 seconds |

</details>

<details>
<summary><b>Input</b> — images, drafts, quick actions…</summary>

| Feature | What you get |
|---|---|
| **Image attachments** | drag-and-drop or paste images into the composer (for multimodal models) |
| **Input history & drafts** | ↑/↓ recalls previously sent messages; an unsent draft survives closing the panel |
| **Slash commands** | type `/` for completions — see the table below |
| **Quick actions** | one-click Summarize / Key Points / Explain / → 中文 / Outline above the composer |
| **Selection toolbar & context menu** | highlight text on any page: Ask · Explain · → 中文 · Summarize; or right-click → browsa › Ask / Explain / Translate / Summarize |

</details>

<details>
<summary><b>Settings</b> — domain rules, masking, auto-summarize…</summary>

| Setting | What it does |
|---|---|
| **Domain rules** | per-URL-pattern extra system prompt (e.g. always respond in English on `github.com`) |
| **Mask rules** | regex-based content redaction before anything is sent (e.g. strip phone numbers) |
| **Reply language** | force replies in a specific language regardless of page language |
| **Max text chars** | cap how much page content is sent per turn |
| **Auto-summarize long attachments** | pages or transcripts over the threshold (default 100,000 chars) are chunked, summarized in parallel, and merged in the background — the attachment returns instantly and later turns resend the compressed version; `[mm:ss]` markers are preserved so seek links keep working; any error fails open to the original text |
| **llms.txt** | on 📎, the site's LLM instructions are fetched once and baked into the attached page context — kept out of the system prompt so the prompt prefix stays byte-stable across turns (prompt-cache friendly) |

</details>

### Slash commands

Type `/` in the composer to see autocomplete. All commands accept extra instructions — `/summarize focus on the methodology`:

| Command | Prompt sent to the model |
|---|---|
| `/summarize` | 3–5 bullet summary |
| `/translate` | Translate to Chinese |
| `/rewrite` | More concise rewrite, keeping all facts |
| `/explain` | Explain for a beginner in simple language |
| `/outline` | Nested outline of headings only |
| `/keypoints` | Top 5 takeaways |
| `/prompt` | Show the current active system prompt (not sent to the model) |

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

## How it works

```
[Web page]  →  [browsa side panel]  →  [your model / agent]  →  streaming reply
```

<details>
<summary><b>Code map</b></summary>

- **`background.js`** — MV3 service worker, single message router; streaming via per-turn ports, auto-summarize for oversized attachments.
- **`sidepanel.js`** — chat UI orchestrator; rendering (Markdown/Mermaid/Markmap/KaTeX/ECharts), sessions, search, detail thread each live in `lib/sidepanel/`.
- **`lib/`** — page extraction (Readability cascade + XHR interception), SSE streaming client (`/v1/chat/completions` + Hermes `/v1/runs`), `chrome.storage.local` wrapper, content scripts.

</details>

## Browser compatibility

Chrome / Edge 114+ (primary target); Brave 1.56+ should work (same Chromium surface). Firefox is not supported (no `side_panel` API).

## Security

- API keys are stored in `chrome.storage.local` on your machine only — never sent anywhere except your configured `baseUrl`.
- PDFs are parsed entirely client-side (WASM + pdf.js) — the file's bytes never leave your device; only extracted text goes to your provider.
- LLM replies are sanitized with DOMPurify before rendering (blocks `data:image/svg+xml` sources; Mermaid's SVG output is stripped of `<script>` / event-handler attributes).
- Content scripts only observe network requests; they never modify or block them.

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<p align="center">
  <sub><b>browsa</b> — read anywhere, ask anywhere.</sub>
</p>
