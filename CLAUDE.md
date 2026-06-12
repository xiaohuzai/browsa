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
sidepanel.js  ←  streamPort (browsa-chat long-lived port)  ←  background.js
```

- **`background.js`** is the service worker and single message router. All `chrome.runtime.onMessage` handling flows through one `handle()` switch. Exports `handle` for tests.
- **`sidepanel.js`** connects two long-lived ports on init: `browsa-nav` (receives NAVIGATED, XHS notes, SELECTION_ACTION) and `browsa-chat` (receives streaming CHUNK/DONE/ERROR).
- **`lib/storage.js`** wraps `chrome.storage.local`. History is a **global flat array** (not per-tab). All background responses use envelope `{ ok: true, data: result }` — unwrap with `res.data?.ok`, not `res.ok`.

### MV3 service worker gotchas

- The SW sleeps after ~30s idle. **Module-level Maps reset on every restart** — do not store durable state there.
- `setTimeout` inside the SW is unreliable after message handling returns — the SW may sleep before it fires. Use `chrome.alarms` or `chrome.storage.session` instead.
- `chrome.storage.session` persists across SW restarts within a browser session. Used for pending SELECTION_ACTION delivery.
- Long-lived ports (`browsa-nav`, `browsa-chat`) disconnect when the SW sleeps. The side panel reconnects after 1s via `onDisconnect`. **Crucially**: the new port object must have all `onMessage` listeners re-attached — use the named `connectNavPort()` function pattern, not inline `addListener` inside `init()` only.

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

### Tab switching

`chrome.tabs.onActivated` in the side panel **must not touch the DOM** — Chrome keeps the side panel document alive across tab switches. Only update `currentTabId`, page-meta text, and send `NAV_FOLLOW` to the nav port.

### Content scripts

Site-specific interceptors (`lib/*-content-script.js`) run in **MAIN world** at `document_start` and wrap `window.fetch` / `XMLHttpRequest` to capture SPA API responses. They send messages to the background, which caches by `tabId`. `lib/selection-toolbar.js` runs in ISOLATED world at `document_idle` on all `https://` pages.

Extension resources used inside Shadow DOM or injected pages (e.g. `icons/icon16.png`) must be declared in `web_accessible_resources`. Use `shadow.querySelector('#id')` — `ShadowRoot` does not have `getElementById`.

### Testing

Tests use Node's built-in test runner. They mock the `chrome` global before importing extension modules. Tests are static analysis + integration tests against `handle()` — there is no browser runtime in tests. The test suite has 68 tests across 5 files.
