# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                        # run all tests (Node test runner, no build needed)
node --test test/foo.test.mjs   # run a single test file
npm run package                 # build versioned zip for distribution (browsa-vX.Y.Z.zip)
npm run build                   # bundle vendor libs via esbuild (only needed after changing build/build.mjs)
bash check-compat.sh            # static compatibility check
```

When bumping a version, update both `manifest.json` and `package.json`.

## Architecture

**Chrome MV3 extension** — side panel chat UI. No build step is required for the JS source; all extension files are loaded directly by Chrome.

### Message flow

```
page content scripts  →  chrome.runtime.sendMessage  →  background.js (SW)
                                                              ↓
sidepanel.js  ←  navPort (browsa-nav long-lived port)  ←  background.js
sidepanel.js  ←  streamPort (browsa-chat, opened fresh per turn)  ←  background.js
sidepanel.js  ←  subChatPort (browsa-subchat, opened fresh per send)  ←  background.js
```

- **`background.js`** is the service worker and single message router. All `chrome.runtime.onMessage` handling flows through one `handle()` switch — still the single exported dispatcher (tests import it), but the bodies of the two biggest cases live elsewhere: `lib/handlers/chat-handler.js` (`handleChat`, the `CHAT` case) and `lib/handlers/subchat-handler.js` (`handleSubchat`/`handleSubchatAbort`, the `SUBCHAT`/`SUBCHAT_ABORT` cases). The shared stream/approval state Maps (`streamPorts`, `streamState`, `chatControllers`, `idleTimerResetters`, `activeRunIds`, `pendingApprovals`, `pendingClarifications`, `subChatControllers`, `subChatPorts`) plus `pushChunk`/`pushSubChatChunk`/`initStreamState`/`appendToStreamState`/`clearStreamState` live in `lib/state.js` — `background.js` imports and re-exports them, so `import { streamPorts, ... } from '../background.js'` in tests still resolves to the same Map instances. `ATTACH_PAGE` and all other small cases stay inline in `background.js` (entangled with the `SITE_CACHES` subsystem defined later in the same file).
- **`sidepanel.js`** connects `browsa-nav` once on init (receives NAVIGATED, XHS notes, SELECTION_ACTION). `browsa-chat` (main chat streaming) and `browsa-subchat` (detail-thread streaming, see below) are each opened **fresh per turn/send** instead — see "Port lifecycle" below for why that distinction matters. `sidepanel.js` itself is now the UI orchestrator (init/onSend/history/approval-clarify cards/screenshot crop) — the Markdown rendering pipeline, sessions drawer, message search, multiselect, and detail-thread are all split into `lib/sidepanel/*.js` modules (see "sidepanel.js module split" below) and imported back in.
- **`lib/storage.js`** wraps `chrome.storage.local`. History is a **global flat array** (not per-tab).
- **Response envelope**: most background responses use `{ ok: true, data: result }` on success / `{ ok: false, error, code, hint }` on thrown error — unwrap with `res.data?.ok` ONLY for handlers that themselves return an inner `{ok, ...}` object (e.g. `APPROVAL_RESPOND`/`CLARIFY_RESPOND`, which catch relay failures internally). Handlers that just `throw` on failure and return plain data otherwise (e.g. `CHAT`, `SUBCHAT`) are correctly checked via the outer `res.ok` directly — check which pattern a given case actually uses before assuming.
- **`lib/constants.js`** holds shared constants (e.g. `PAGE_CONTEXT_PREFIX`) imported by background, sidepanel, storage, and page-extractor. Content scripts run in MAIN world and cannot import ES modules, so they do not use this file.

### `sidepanel.js` module split (`lib/sidepanel/`)

Twelve modules, each imported by `sidepanel.js` — none of them import `sidepanel.js` back (avoids ES module cycles; modules that need `sidepanel.js`-owned mutable state get it via an `initX(deps)` call from `init()` instead):

- `render.js` — the Markdown/Mermaid/ECharts/KaTeX pipeline: `renderStreamingSafe`/`renderSafe` (marked + DOMPurify), `makeStreamRenderer`, `addCodeCopyButtons`/`highlightDiffBlocks`, `renderMermaid`/`renderEcharts`. **`renderSafe` is `async`** (it awaits the KaTeX worker/threshold decision below) — every caller must `await` it; `renderStreamingSafe` (the per-tick streaming path) stays synchronous since it skips KaTeX entirely. `makeStreamRenderer`'s returned closure is also `async` for the same reason, and exposes a `.destroy()` method that must be called before reassigning it mid-stream (RETRY, tab-switch DOM-identity change) to stop an abandoned reveal-pacer. Three sanitization gotchas: `renderMermaid()` pipes Mermaid's SVG output through the vendored `stream-markdown-parser` package's `sanitizeMermaidSvg()` before `innerHTML` — `securityLevel:'loose'` (needed for `$$...$$` KaTeX math in node labels) also permits `foreignObject` HTML/click-binding content otherwise. DOMPurify's `ALLOWED_URI_REGEXP` does NOT govern `data:` URIs on `<img>`/`video`/`audio` tags (they're in DOMPurify's own `DATA_URI_TAGS` allow-list, validated by an internal check that bypasses the custom regex entirely — confirmed empirically) — blocking `data:image/svg+xml` (which can carry its own `<script>`) instead uses a `DOMPurify.addHook('uponSanitizeAttribute', ...)` registered once at module load. **Never pass `ALLOWED_URI_REGEXP` directly as a `sanitize()` option** — a real bug, found via a live user report (a numbered list's second block rendered as "1." instead of continuing at "2."): DOMPurify applies that regexp to the *value* of every allowed attribute not on its own internal "safe" list (`id`/`class`/`style`/`title`/`alt`/... — see `ADD_URI_SAFE_ATTR` in DOMPurify's source), not just `href`/`src`. A strict allowlist regexp (`https?:|mailto:|tel:|data:image/|#`) then silently strips anything whose value doesn't look like one of those schemes — `<ol start="N">` (a bare number), `<td colspan="N">`, `<input type="checkbox">`. Fixed by moving the check into the `uponSanitizeAttribute` hook, scoped to an explicit `URI_ATTRS` set (`href`/`src`/`action`/`formaction`/`poster`/`cite`/`background`/`xlink:href`) — everything else is left to DOMPurify's own defaults.
- `reveal-pacer.js` — `createRevealPacer(onReveal)`, a thin wrapper around the vendored `markstream-core` package's `createSmoothMarkdownStream`. Paces how fast enqueued deltas become visible (self-terminating internal `requestAnimationFrame` loop, confirmed via source read — no leak risk even if `destroy()` is skipped, though calling it is still correct hygiene). Used by both `render.js`'s `makeStreamRenderer` and `detail-thread.js`'s own inline accumulate loop.
- `katex-threshold.js` / `katex-worker-client.js` / `katex.worker.js` — KaTeX Web Worker offload for `renderSafe`'s final render pass. `katex-threshold.js` ports a small heuristic (`recommendNForSamples`) deciding whether a message's formula count is worth offloading; small/typical messages (1-3 short formulas) stay fully synchronous with zero added latency. `katex-worker-client.js`'s `renderMathBatch(mathParts)` batches ALL of one message's formulas into a single `type: 'module'` Worker call (`katex.worker.js`, which `import`s the same vendored `katex.bundle.js`), with an in-memory cache and automatic fallback to sync rendering on worker construction failure/timeout — never a partial worker/sync mix within one message. Also applies `normalizeKaTeXRenderInput` (replaces `·`→`⋅`, `℃`→`°C` — glyphs KaTeX can't render correctly) before rendering, caching, or dispatch.
- `mermaid-utils.js` — `estimateMermaidPreviewHeight`/`clampMermaidPreviewHeight` (sets the raw code-fence placeholder's height before the async render starts, reducing the jump when it's swapped for the real diagram) and `escapeSequenceTextSemicolons` (works around a real mermaid.js parser bug: a bare `;` inside sequence-diagram message/Note text — e.g. dialogue quoting SQL — breaks the parser; escaped to `#59;` on retry via `renderMermaidWithRetry`, which never touches semicolons that legitimately start a new mermaid statement).
- `sessions-ui.js` — sessions drawer (list/rename/export/delete/load); `loadSession` needs `initSessionsUI({ cancelActiveStream, renderHistory, scrollToBottom, clearPendingImages })`.
- `multiselect.js` — bulk-delete mode; `deleteSelectedMessages` needs `initMultiselect({ decrementNextHistoryIdx })` to keep `sidepanel.js`'s history-index counter in sync.
- `msg-search.js` — Ctrl+F in-conversation search. Fully self-contained.
- `detail-thread.js` — the "select text → 细聊" side-conversation card (see below). Fully self-contained; wires its own `mouseup`/`scroll` listeners on import.
- `icons.js` / `ui-utils.js` — leaf modules with no dependencies on the others: the `ICONS` SVG map, and `$`/`escM`/`_copyText`/`showToast`/`showConfirmDialog`/`sendMessage`/`_findCard`/`_insertCard`.

### Extraction quality improvements (no new UI)

Three backend-only improvements ported from the Python scraping library Scrapling, applied transparently to the existing pipeline:

- **Prompt-injection defensive sanitization**: `extractInPageWorld` strips `<template>` elements and HTML comments from the Readability clone before parsing — a page can hide instructions meant for an LLM reader in markup a human never sees, and this removes them before they reach the model. It also marks CSS-hidden elements (`display:none`/`visibility:hidden`/`opacity:0`/`font-size:0`/zero-dimension boxes) on the **live** document before cloning — `getComputedStyle` needs rendering info the detached clone doesn't have — then strips them from the clone via the marker attribute, immediately un-marking the live DOM afterward so the page itself is never left mutated. `NOISE_SELECTORS`'s `[hidden]`/`[aria-hidden="true"]` only catch attribute-based hiding; this closes the stylesheet-driven blind spot (same threat model — a page can hide boilerplate or an actual injection payload from a human reader while still feeding it to the LLM). Only elements carrying non-empty `textContent` are checked, to bound cost and avoid false positives on empty containers awaiting JS hydration. All of `extractInPageWorld`/`extractDomTreeInPageWorld`/`extractFullInPageWorld` also strip zero-width chars (U+200B/200C/200D/2060/FEFF) and control characters from their final text output.
- **Repeated-structure item markers** (`extractDomTreeInPageWorld`): when a container has ≥3 structurally-similar children (same tag + primary class token — e.g. 20 `.product-card` divs, or a `<ul>/<li>` list), walk() inserts `— Item N —` boundary markers before each item, so the LLM can see where one item ends and the next begins rather than receiving a flat interleaved wall of title/price/link fields with no grouping. Only triggers when the similar group makes up ≥60% of the container's visible children, to avoid spurious markers on navigation menus or mixed-content layouts. Concept: `fingerprint(el)` (tag + first class) + `findRepeatedGroup(children)` (Map-based majority grouping) inlined into the self-contained MAIN-world function. Automatically active in auto/dom modes, no user configuration.
- **`lib/dom-similarity.js`** — pure, Node-testable module: `stringRatio` (Dice-coefficient bigram similarity), `scoreDescriptors` (weighted element descriptor similarity), `cleanText` (zero-width/control char stripping). No longer used by production page-extraction code directly — `_relocateXhsAnchorsInPageWorld` (below) inlines its own copy per the MAIN-world constraint. Kept as the tested reference implementation; if either copy is changed, sync the other.
- **XHS adaptive relocation** (`tryXhsAnchorRelocation`/`_captureXhsAnchorFingerprintsInPageWorld`/`_relocateXhsAnchorsInPageWorld` in `page-extractor.js`): scoped narrowly to XHS's `#detail-title`/`#detail-desc` DOM-anchor fallback path. On every successful DOM-path extraction, saves the anchors' structural fingerprint to `chrome.storage.local`; on a future selector miss (site redesign), attempts structural relocation before falling through to Readability. Not applied to the other 9 sites (they rely on XHR interception). Fully invisible to the user — no UI, no new message types.

### MV3 service worker gotchas

- The SW sleeps after ~30s idle. **Module-level Maps reset on every restart** — do not store durable state there.
- `setTimeout` inside the SW is unreliable after message handling returns — the SW may sleep before it fires. Use `chrome.alarms` or `chrome.storage.session` instead.
- `chrome.storage.session` persists across SW restarts within a browser session. Used for pending SELECTION_ACTION delivery.
- Any open port (`browsa-nav`, or a `browsa-chat`/`browsa-subchat` port currently mid-turn) disconnects when the SW sleeps. `browsa-nav` reconnects after 1s via `onDisconnect` — the new port object must have all `onMessage` listeners re-attached, via the named `connectNavPort()` function pattern, not inline `addListener` inside `init()` only. `browsa-chat`/`browsa-subchat` don't need this: being per-turn already, a fresh one just opens on the next send (see "Port lifecycle" below).

### navPort reconnect pattern (critical)

`onMessage` listeners bind to a specific port object. On SW restart, a new port is created. Always re-attach listeners:

```js
function onNavPortMessage(msg) { /* handler */ }

function connectNavPort() {
  navPort = chrome.runtime.connect({ name: 'browsa-nav' });
  navPort.postMessage({ type: 'NAV_HELLO', tabId: currentTabId });
  navPort.onMessage.addListener(onNavPortMessage);   // re-bind every time
  navPort.onDisconnect.addListener(() => {
    navPort = null;
    setTimeout(() => { if (!navPort) connectNavPort(); }, 1000);
  });
}
```

### Port lifecycle: persistent (navPort) vs per-turn (browsa-chat, browsa-subchat)

Two different, deliberate port patterns coexist — don't mix them up:

- **`browsa-nav`**: connected ONCE at panel init, reconnected on disconnect via the `connectNavPort()` pattern above. Correct for a port that represents "whichever tab the panel is currently watching" — re-registering it under a new tabId on tab-switch (`NAV_FOLLOW`) is exactly what you want.
- **`browsa-chat`** (main chat) and **`browsa-subchat`** (detail-thread side conversations, see below): opened **fresh for every single turn/send**, with an explicit HELLO → wait-for-ACK handshake before the actual chat message is sent (mirrors `onSend()`'s `STREAM_HELLO`/`STREAM_HELLO_ACK`). A persistent, connect-once port was tried for `browsa-subchat` and caused a real bug: if the SW went idle while the user was reading before opening a detail-thread card, `sendMessage({type:'SUBCHAT'})` wakes the SW almost instantly, but the persistent port's reconnect fires on a delayed timer — early deltas got silently dropped before the port re-registered. Opening fresh + waiting for ACK avoids this race entirely. If you add another streaming feature, default to this per-turn pattern, not a persistent one.

### Tab switching

`chrome.tabs.onActivated` in the side panel **must not touch the DOM** — Chrome keeps the side panel document alive across tab switches. Only update `currentTabId`, page-meta text, and send `NAV_FOLLOW` to the nav port.

### Content scripts

Site-specific interceptors (`lib/content-scripts/*-content-script.js`) run in **MAIN world** at `document_start` and wrap `window.fetch` / `XMLHttpRequest` to capture SPA API responses. They send messages to the background, which stores results in `SITE_CACHES` (a registry object in `background.js` — one `Map` per site, keyed by `tabId`). Adding a new site only requires a single entry in `SITE_CACHES`; restore, lookup, and cleanup iterate it automatically. XHS is the one exception — it uses a separate `xhsXhrCache` Map with its own push logic instead of a `SITE_CACHES` entry. `lib/content-scripts/selection-toolbar.js` runs in ISOLATED world at `document_idle` on all `https://` pages.

MAIN-world content scripts can't use ES module imports, so URL matchers there must resolve relative paths against the page: use `new URL(url, location.origin)`, not `new URL(url)` — a bare relative fetch/XHR path (e.g. `fetch('/api/...')`) throws and gets silently swallowed otherwise.

Extension resources used inside Shadow DOM or injected pages (e.g. `icons/icon16.png`) must be declared in `web_accessible_resources`. `ShadowRoot` supports both `querySelector('#id')` and `getElementById('id')` in current Chrome — prefer `querySelector` for consistency with the rest of the codebase.

### Detail-thread ("SUBCHAT") side conversations

Selecting text inside an assistant reply opens an inline card scoped to that excerpt (`lib/sidepanel/detail-thread.js`: `openDetailThread`, `findBlockAnchor`; `lib/handlers/subchat-handler.js`: `handleSubchat`/`handleSubchatAbort`, dispatched from `background.js`'s `SUBCHAT`/`SUBCHAT_ABORT` cases). Rules that are easy to accidentally violate when touching this code:

- **Never call `storage.appendToHistory`** for SUBCHAT — the whole point is that closing the card discards everything, main history stays clean. Covered by a dedicated test in `test/subchat.test.mjs`.
- **Always `chatStream()`, never `runsApiStream()`** — no tool/approval flow needed for a side question, and reusing the main chat's Hermes session would mix it into the agent's main-task context.
- **`CHOICE_REQUEST_HINT` must stay out of SUBCHAT's system message** — it's a separate constant from `CAPABILITY_HINTS`, appended only to CHAT's `effectiveSystemPrompt`. SUBCHAT has no UI to parse/render the resulting buttons, so including the instruction leaks raw `CHOICE_REQUEST:{...}` JSON into replies.
- Rendering reuses `.msg.user`/`.msg.assistant` classes directly (not a parallel CSS ruleset) so it can't silently drift from the main chat's look — remember to add the `.done` class manually when a bubble finishes streaming, or the `.msg.assistant::after` blinking-cursor pseudo-element never goes away.

### Testing

Tests use Node's built-in test runner. They mock the `chrome` global before importing extension modules. Tests are a mix of static-analysis/integration tests against `handle()` and real jsdom-based execution tests (import the real module, drive real DOM events, assert on real DOM output — using the actual vendored `marked`/`DOMPurify`/`katex`/`highlight.js` bundles, not stand-ins) for the `lib/sidepanel/*.js` modules. There is no real browser in any of this — jsdom stands in for the DOM. `sidepanel.js` itself has zero exports (it just calls `init()` at module load and only exposes behavior through DOM events), so its own tests (`test/lib-sidepanel-streaming.test.mjs`, `test/lib-sidepanel-resume-streaming.test.mjs`) load the real `sidepanel.html` into jsdom, mock the `chrome.*` surface `init()` needs, import the real `sidepanel.js`, and drive it via simulated clicks/keydowns/port messages — the same black-box approach a browser would use, since there's no exported function to call directly. The test suite has 392 tests across 30 files.
