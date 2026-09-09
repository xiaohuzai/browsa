# Site content scripts — structure knowledge

Maintainer-facing distillation of the 10 site content scripts in this directory
(shape borrowed from ego-lite's per-site "learnings" packs: manifest + notes +
validation rules, 2026-09-09 audit). Each script's header comment remains the
authoritative deep-dive; this file is the triage map and the cross-site
invariants. **When you change a script's interception point, data shape, or
selectors, update its entry here in the same commit.**

## Triage flow (a site stops populating its cache)

1. **Script not firing at all** → check `manifest.json` `matches` still covers
   the site's live hostnames, and that the idempotency guard
   (`window.__browsa<Site>InterceptorInstalled`) isn't already set by a stale injection.
2. **Interception silent** → the site changed endpoints. Compare the path
   patterns below against the Network tab; patterns match path SUFFIXES, never
   query strings or opaque hashes.
3. **Interception fires but data dropped** → response shape changed. Every
   parser probes multiple field names with deep optional chaining; find which
   probe now wins/loses and whether a new field name must be added.
4. **Data arrives but is stale on SPA navigation** → check the
   navigation-staleness guards (e.g. YouTube drops player responses whose
   `videoDetails.videoId` doesn't match the current URL).
5. Update the entry below (and the script header) with what you learned.

## Cross-site invariants (each one paid for with a real bug)

- **Never modify signed URL params.** YouTube `timedtext` `fmt=` (signature
  breaks → 200 + empty body), XHS `x-s`/`x-s-common`/`x-t` (never re-sign —
  clone the browser's own already-signed requests instead), Bilibili
  `__playinfo__` CDN URLs (deadline-signed; refresh via WBI re-sign, don't
  reuse).
- **GraphQL operation hashes rotate per deploy** — match the operation-name
  path suffix only (Twitter `/TweetDetail`, `/TweetResultByRestId`).
- **MAIN world has no `chrome.runtime`** — no `onMessage`, no
  `sendMessage`; push data via `window.postMessage` channels (YouTube trigger
  pattern) or `chrome.runtime.sendMessage` is unreachable entirely.
- **`executeScript`-injected funcs must be self-contained** — no calls to
  module-level siblings (the `countImages` lesson); module-level
  **`var`, not `const/let`**, in scripts re-injected via `files:` (re-declaration
  throws — Bilibili WBI table).
- **Content scripts cannot use ES modules** — each file is fully
  self-contained by construction.
- **Site JSON is hostile** — deep optional chaining everywhere; treat any
  structure as free to reorder/rename without notice (YouTube like-button
  nesting, Bilibili `__INITIAL_STATE__`, Dedao envelope `{code,data}` vs
  `{errno,data}`).
- **No secrets, no pixel coordinates, no scraping beyond what the user's own
  session already fetched** — we only clone/observe requests the page itself
  makes.

## Sites

All scripts: MAIN world, `document_start`, fetch+XHR wrappers installed at the
top of the file, pure testable functions above the IIFE, idempotency guard.
Push messages land in `background.js` `SITE_CACHES` (per-tabId Maps, persisted
to `chrome.storage.session` under `sc_<tabId>` across SW restarts) via
`SITE_MESSAGE_MAP`, except XHS which has its own dedicated case.

| Site | Hosts (manifest matches) | Intercept / anchors | Push msg → field | Product |
|---|---|---|---|---|
| YouTube | `www.youtube.com`, `youtube.com` | POST `/youtubei/v1/player`; clone `/api/timedtext`; `ytInitialData`, `ytInitialPlayerResponse`, `ytcfg`, `#movie_player` | `YOUTUBE_DATA` → `video` | meta + `[mm:ss]` transcript lines + chapters + counts + pot audio streams |
| Bilibili | `www.bilibili.com`, `bilibili.com` | `api.bilibili.com/x/web-interface/view`, `/x/player/wbi/v2`, `/x/web-interface/view/conclusion/get`; `__playinfo__`, `__INITIAL_STATE__` | `BILIBILI_VIDEO` → `video` | meta + CC transcript + AI summary + streams (`__browsaGetBilibiliStreams`, fresh re-sign path) |
| XHS | `www.xiaohongshu.com`, `xiaohongshu.com` | `edith.xiaohongshu.com/api/sns/web/v1/feed`, `/api/sns/web/v2/comment/page(/sub/page)` — clone only, no re-sign | `XHS_XHR_NOTE` (own case, not in SITE_MESSAGE_MAP) | noteId/title/desc/author/counts + comments (≤50); DOM anchors `#detail-title`/`#detail-desc` live in `lib/xhs-extractor.js` (with `tryXhsAnchorRelocation` fingerprint fallback) |
| Zhihu | `www.zhihu.com`, `zhuanlan.zhihu.com` | GET `/api/v4/articles/{id}`, `/api/v4/questions/{id}/answers` | `ZHIHU_CONTENT` → `content` | article {title, text, author, counts} or question + top-10 answers |
| Juejin | `juejin.cn` | POST `api.juejin.cn/content_api/v1/article/detail` | `JUEJIN_ARTICLE` → `article` | title + **raw `markContent` Markdown** + counts (bypasses Readability entirely) |
| Dedao | `www.dedao.cn` | wide `/(content\|article)/(detail\|details)/` on `*.dedao.cn` (paths reverse-engineered from dedao-dl) | `DEDAO_ARTICLE` → `article` | {title, content (multi-field probe), author}; <50 chars discarded |
| Geektime | `time.geekbang.org` | POST `time.geekbang.org/serv/v1/article` | `GEEKTIME_ARTICLE` → `article` | {title, text (HTML→text), summary, author} |
| Xueqiu | `xueqiu.com`, `www.xueqiu.com` | GET `stock.xueqiu.com/v5/stock/quote.json`; `/v4/statuses/show`, `/v4/user/statuses/show` | `XUEQIU_DATA` → `data` | stock quote or post {text, author, likes}; premium fields need the user's login cookies (MAIN world fetch carries them) |
| Twitter/X | `twitter.com`, `x.com` | GraphQL `.../TweetDetail`, `.../TweetResultByRestId` (suffix match); fallback `__INITIAL_STATE__.entities` + `[data-testid="tweet"]` DOM | `TWITTER_TWEET` → `tweet` | tweet {text, author, counts}; known: the in-page passive path's guard sits on `chrome.runtime` (absent in MAIN world) so it never populates — `activeXFetch` (SW `executeScript`) is the working path |
| Xiaoyuzhou | `www.xiaoyuzhoufm.com`, `xiaoyuzhoufm.com` | clone-all on `api.xiaoyuzhoufm.com` + `audioclip.oss-cn-shanghai.aliyuncs.com`, probe shapes | `XIAOYUZHOU_EPISODE` → `episode` | {title, podcast, shownotes, duration, mediaUrl, publishedAt} |

HTML→text conversion for Zhihu/Geektime uses a detached DOM element (MAIN world
has no DOMParser-with-doc context guarantees); audio/stream selection lives in
`lib/handlers/attach-asr.js` (`pickVideoStream`/`estimateStreamBytes`) — prefer
AAC-LC; HE-AAC (`mp4a.40.5`) may fail `decodeAudioData`.

## Tests

- `test/site-content-scripts.test.mjs` — all 10 scripts' pure functions
- `test/youtube-streams.test.mjs`, `test/bilibili-streams.test.mjs`,
  `test/bilibili-fresh-streams.test.mjs` — stream selection paths
- `test/attach-page-video-fallback.test.mjs` — attach flow fallbacks
- `test/page-extractor.test.mjs` — XHS extractor + anchor relocation
