# Publishing browsa to the Chrome Web Store

Quick checklist for shipping a zipped version to the Chrome Web Store (CWS)
and the Microsoft Edge Add-ons store.

## 1. Version bump

```bash
# Edit package.json → "version": "x.y.z"
# Then re-build the zip:
npm run build       # regenerate vendor bundles
npm test            # 5/5 pass
npm run package     # → browsa-vX.Y.Z.zip
```

## 2. CWS submission checklist

- [ ] `manifest.json` `version` matches `package.json`
- [ ] `manifest.json` `short_name` ≤ 12 characters (CWS rule: `"browsa"` ✓)
- [ ] Icons: 16/48/128 all present under `icons/`
- [ ] Screenshots (1280×800 or 640×400): at least 1, preferably 3-5 showing
      the side panel in use with a real page + chat response
- [ ] Promotional tile images:
  - Small: 440×280
  - Large: 920×680
  - Marquee: 1400×560 (optional)
- [ ] Description (≤ 132 chars): something like
      _"Side-panel AI agent for any webpage. Chat with Hermes, Claude Code, or OpenAI-compatible APIs."_
- [ ] Detailed description (longer, plain text or limited HTML)
- [ ] Category: "Productivity" or "Developer Tools"
- [ ] Language: English (U.S.) — matches `default_locale: "en"`
- [ ] Privacy practices:
  - [x] Single purpose: "AI-powered page reading assistant"
  - [x] Permission justification for each item in `permissions` and `host_permissions`
  - [x] Data usage: "All data is sent only to the user-configured API endpoint.
        No data is collected, stored, or sent to third parties by the extension itself."
- [ ] Verified the zip with `npm run compat` → 7/7 pass

## 3. Permission justification text

For the CWS submission form, prepare these:

| Permission | Justification |
|---|---|
| `sidePanel` | Required to show the chat interface in the browser sidebar. |
| `activeTab` | Lets the user attach the current page's text content to a chat (user-initiated). |
| `scripting` | Required to inject Readability/Turndown into the active page to extract article text. |
| `tabs` | Needed to detect tab switches and maintain per-tab conversation history. |
| `storage` | Stores provider configuration (API key, base URL) and per-tab chat history locally. |
| `host_permissions: http://*/* https://*/*` | The extension must send API requests to the user's configured LLM endpoint (could be localhost, another server on the LAN, or a hosted service). It also needs to fetch Readability/Turndown resource files from its own chrome-extension:// origin. The wide pattern is necessary because the user chooses the endpoint. |

## 4. Edge Add-ons store

Same manifest works for Edge. Edge Add-ons partner center has a near-identical
submission form. The `minimum_chrome_version: "114"` field is recognized by
Edge as the minimum Chromium version.

## 5. Self-hosting (unpacked / zip download)

Users can also load the zip directly:

```bash
# Download the zip
scp user@host:/path/to/browsa-vX.Y.Z.zip ./

# Edge
Expand-Archive browsa-vX.Y.Z.zip -DestinationPath ./browsa
edge://extensions → Developer mode ON → Load unpacked → select ./browsa/

# Chrome — same flow
chrome://extensions → Developer mode ON → Load unpacked → select ./browsa/
```

## 6. Build from source

```bash
git clone <repo-url>
cd browsa
npm install          # install dev deps (esbuild, jsdom)
npm run build        # bundle vendor libs into lib/vendor/
npm test             # verify 5/5
npm run package      # produce browsa-vX.Y.Z.zip
```

## 7. Project structure (for code reviewers)

```
browsa/
├── manifest.json               # MV3, supports Edge 114+ / Chrome 114+
├── background.js               # Service worker: message routing, CHAT handler
├── sidepanel.{html,css,js}     # Side-panel UI (ESM, Markdown, streaming)
├── options.{html,css,js}       # Options page (provider config + Ping)
├── lib/
│   ├── storage.js              # chrome.storage.local wrapper
│   ├── openai-client.js        # Fetch-based OpenAI chat + SSE streaming
│   ├── page-extractor.js       # Readability + Turndown injection + message builder
│   └── vendor/                 # 4 bundled third-party libs (IIFE + ESM)
│       ├── Readability.iife.js   (Mozilla Readability, built from GitHub raw)
│       ├── Turndown.iife.js      (mixmark-io/turndown v6, built from npm)
│       ├── marked.bundle.js      (marked 13 ESM, built from npm)
│       └── purify.bundle.js      (DOMPurify 3 ESM, built from npm)
├── _locales/{en,zh_CN}/        # Chrome i18n (13 keys each)
├── build/
│   ├── build.mjs               # Vendor bundler (esbuild CJS→IIFE, ESM minify)
│   └── package.mjs             # Zip packager
├── test/
│   └── page-extractor.test.mjs # 5 unit tests (node:test)
├── check-compat.sh             # Cross-browser compatibility self-check
├── package.json                # npm scripts + devDependencies
└── README.md                   # Install guide + browser compat matrix
```
