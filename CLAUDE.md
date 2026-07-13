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

- **`background.js`** is the service worker and single message router. All `chrome.runtime.onMessage` handling flows through one `handle()` switch. Exports `handle` for tests.
- **`sidepanel.js`** connects `browsa-nav` once on init (receives NAVIGATED, XHS notes, SELECTION_ACTION). `browsa-chat` (main chat streaming) and `browsa-subchat` (detail-thread streaming, see below) are each opened **fresh per turn/send** instead — see "Port lifecycle" below for why that distinction matters.
- **`lib/storage.js`** wraps `chrome.storage.local`. History is a **global flat array** (not per-tab).
- **Response envelope**: most background responses use `{ ok: true, data: result }` on success / `{ ok: false, error, code, hint }` on thrown error — unwrap with `res.data?.ok` ONLY for handlers that themselves return an inner `{ok, ...}` object (e.g. `APPROVAL_RESPOND`/`CLARIFY_RESPOND`, which catch relay failures internally). Handlers that just `throw` on failure and return plain data otherwise (e.g. `CHAT`, `SUBCHAT`) are correctly checked via the outer `res.ok` directly — check which pattern a given case actually uses before assuming.
- **`lib/constants.js`** holds shared constants (e.g. `PAGE_CONTEXT_PREFIX`) imported by background, sidepanel, storage, and page-extractor. Content scripts run in MAIN world and cannot import ES modules, so they do not use this file.

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

Selecting text inside an assistant reply opens an inline card scoped to that excerpt (`sidepanel.js`: `openDetailThread`, `findBlockAnchor`; `background.js`: `SUBCHAT`/`SUBCHAT_ABORT` cases). Rules that are easy to accidentally violate when touching this code:

- **Never call `storage.appendToHistory`** for SUBCHAT — the whole point is that closing the card discards everything, main history stays clean. Covered by a dedicated test in `test/subchat.test.mjs`.
- **Always `chatStream()`, never `runsApiStream()`** — no tool/approval flow needed for a side question, and reusing the main chat's Hermes session would mix it into the agent's main-task context.
- **`CHOICE_REQUEST_HINT` must stay out of SUBCHAT's system message** — it's a separate constant from `CAPABILITY_HINTS`, appended only to CHAT's `effectiveSystemPrompt`. SUBCHAT has no UI to parse/render the resulting buttons, so including the instruction leaks raw `CHOICE_REQUEST:{...}` JSON into replies.
- Rendering reuses `.msg.user`/`.msg.assistant` classes directly (not a parallel CSS ruleset) so it can't silently drift from the main chat's look — remember to add the `.done` class manually when a bubble finishes streaming, or the `.msg.assistant::after` blinking-cursor pseudo-element never goes away.

### Testing

Tests use Node's built-in test runner. They mock the `chrome` global before importing extension modules. Tests are static analysis + integration tests against `handle()` — there is no browser runtime in tests. The test suite has 205 tests across 10 files.
