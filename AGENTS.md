# AGENTS.md

browsa — Chrome MV3 侧栏 AI 聊天扩展（页面附加 / 多 provider LLM / 本地 agent 接入 / 富渲染）。JS 源码无构建步骤，由 Chrome 直接加载。

## 治理体系：本仓的 agent 指令是分层的

- **本文件（根）**：全局命令、架构一页、P0 不变量索引、文档/发布纪律。每个会话都会加载它——保持小。
- **嵌套文件**（agents.md 规范：就近优先，改哪个子系统前先读它那个）：
  - `lib/handlers/AGENTS.md` — SW 核心：消息路由、回合/流所有权、协议层、存储契约、Provider 接入、附加/抽取/ASR 管线
  - `lib/sidepanel/AGENTS.md` — 面板：渲染管线（mermaid/echarts/markmap/dot/smiles/katex）、32 个 UI 模块、追问卡、会话抽屉
  - `lib/content-scripts/AGENTS.md` — MAIN world 站点脚本、站点快路径、划词条
  - `test/AGENTS.md` — 测试基建规则
- **冲突规则：AGENTS.md 裁决 > wiki 解释**——wiki 与裁决冲突时改 wiki。
- **机制叙事、事故复盘、决策史在 GitHub wiki**（`browsa.wiki.git`，en/zh 权威 + 五语快照；本地镜像 `/root/workspace/browsa-wiki/`（dev VPS）或 `/home/xiaohuzai/workspace/browsa-wiki/`（WSL））。裁决卡只保留：不变量 + 为什么（一个从句）+ 要跑的测试 + wiki 指针。
- **预算纪律**：`test/agents-md-hygiene.test.mjs` 钉住每个文件的字节上限——新叙事进 wiki，别往 AGENTS.md 族里堆。任何一次「拆分/搬迁」都不删东西进稀薄空气：全文永远在 git 历史里（2026-10-13 wiki 拆分与 2026-10-24 多文件化皆然）。

## Commands

```bash
npm test                        # run all tests (Node test runner, no build needed)
node --test test/foo.test.mjs   # run a single test file
npm run package                 # build versioned zip for distribution (browsa-vX.Y.Z.zip)
npm run build                   # bundle vendor libs via esbuild (only needed after changing build/build.mjs)
bash check-compat.sh            # static compatibility check
```

**Memory constraint for tests**: the dev box is a 2-CPU/4GB VPS and `npm test` runs 162 files (≈60 jsdom-heavy; 2082 tests as of 2026-10-24 — `ls test/*.test.mjs` is the authoritative count, not this sentence). The script caps `--test-concurrency=2`; on a 4GB box prefer `--test-concurrency=1`. When adding mock data to tests, keep buffers small — a single 44MB mock blob plus parallel jsdom children can OOM the box mid-run (real recurrence, 2026-08). Never add tests that allocate tens of MB per case without an explicit reason. Prefer pure-function tests (no DOM, no big blobs).

**Headless-browser verification must be torn down in the same step** (2026-10-21 user report「怎么还有个terminal在运行？」): launch with a unique `--user-data-dir=/tmp/browsa-…` + `--remote-debugging-port=92xx`, and as soon as the check finishes — or before ending the turn — kill it with a bracketed pattern (`pkill -f '[b]rowsa-…'`) and assert the debug port is closed.

When bumping a version, update both `manifest.json` and `package.json` — `check-compat.sh` fails on a mismatch (plus locale-key parity and referenced-vendor existence).

## Architecture（一页）

```
page content scripts  →  chrome.runtime.sendMessage  →  background.js (SW)
                                                              ↓
sidepanel.js  ←  navPort (browsa-nav long-lived port)  ←  background.js
sidepanel.js  ←  streamPort (browsa-chat, opened fresh per turn)  ←  background.js
sidepanel.js  ←  subChatPort (browsa-subchat, opened fresh per send)  ←  background.js
```

- `background.js` 是 service worker 与唯一消息路由：所有 `chrome.runtime.onMessage` 走一个 `handle()` switch（测试直接 import 它）；大 case 体在 `lib/handlers/`。
- 响应信封：多数成功 `{ ok: true, data }` / 抛错 `{ ok: false, error, code, hint }`。**只有本身返回内层 `{ok,…}` 的 handler（如 APPROVAL_RESPOND/CLARIFY_RESPOND）才读 `res.data.ok`**；直接 throw 的（如 CHAT）读外层 `res.ok`——先看该 case 实际是哪种。`LOAD_SESSION` 未命中返回 **-1**（0 是合法空会话长度）。
- `lib/storage.js` 包 chrome.storage.local；history 是全局扁平数组（非 per-tab）。`getAll()` 只读固定键表 `GET_ALL_KEYS`（**不是** `get(null)`）；新键要让 getAll 消费者看到必须进表。
- MV3 要点：SW 睡后模块级 Map 全重置（持久状态走 chrome.storage.session/local）；SW 内 setTimeout 不可靠（用 alarms）；`browsa-nav` 断开 1s 重连（监听器必须重挂，见 `connectNavPort()` 模式）；`browsa-chat`/`browsa-subchat` 每回合新开 + HELLO→ACK 握手（勿改成长连）。
- 模块地图：`lib/handlers/*`（SW case 体）/ `lib/sidepanel/*`（32 模块 + 3 worker）/ `lib/content-scripts/*`（MAIN world 站点脚本 + ISOLATED 划词条 + site-relay 信使）/ lib/ 根（llm-client 协议层、storage、state、message-builder、agent-turn、page-extractor 抽取层、image-budget、i18n 等）。完整职责与裁决见各嵌套 AGENTS.md 与 wiki。

## P0 不变量索引（勿回退；详版在对应嵌套文件）

### 回合与流所有权（SW）
- `initStreamState` 返回回合状态；一切 per-tab 清理/DONE 必须过 `ownsStream()`/`ownsController()`；DONE 门 = finally 内先取快照 `ownsAtEnd`，再以 `streamEpoch(tabId)` 比对 init 时捕获的 epoch。Tests: `chat-turn-ownership`。
- **一切 `streamState.acc` 写入都过 turnState 身份检查**（delta 路径的 ownsStream 门 + 重试/overflow/续写/时间戳改写复位的外层 `st === turnState` 门）。Tests: `chat-turn-ownership`。
- **字符串 reason 的 abort 按 AbortError 分类**：判据是 `signal?.aborted`，不是 `e?.name === 'AbortError'`（abort('user-cancel') 使 fetch 以裸字符串 reject）。chat 流内 `{"error":…}` data 事件必须抛 ProviderAPIError。Tests: `llm-client-fetch-abort`。
- SSE reader 必须 finally cancel（`openSseStream`）；`TextDecoder` per-call；行式 SSE 单点 `lib/sse-reader.js`；`event:` 名只经 `sseEventName()`；多行 `data:` 只经 `sseDataPayload()`。Tests: `llm-client-reader-cancel`、`sse-reader`。
- `gcStreamState` 不得删除仍有 `chatControllers`/`activeRunIds` 的活回合（长工具/审批回合 >10 分钟正常）。Tests: `chat-turn-ownership`。
- pending 审批/澄清按 `agentPendingKey` reqKey 堆叠（覆盖=丢 requestId）；答成即删；STREAM_PEEK 补挂未决卡。Tests: `approval-clarify`。
- 原会话被删 → `rescueOrphanedTurn` 重建（禁回退 live append——跨会话泄漏；也禁丢弃）。切会话中的回合写 origin 会话快照；abort 收尸为 `interrupted:true` 条目。Tests: `lib-persist-turn-routing`。
- DNR 媒体/页面图规则只在安全点清扫（onStartup/onInstalled/最后 navPort 断开）；**禁止每次 SW wake 清扫**。Tests: `media-headers-sweep`。

### 存储
- `getAll` 固定键表（禁 `get(null)` 全量反序列化）；`agentSessionKeys` 索引界定 session-store 扫描；`getSiteCache(tabId,url)` 按 host 选源。Tests: `storage`。
- `MAX_SESSIONS` 驱逐不得删除本次保存的条目；rescue 不得 `snapshotAgentSessions()`（借当前 agent 身份）。Tests: `storage`。
- **历史逐字随行（KV 缓存裁决，2026-10-14）**：`prepareHistoryForModel` 只剥 `IMAGE_SEEN_FLAG`/`TURN_STEPS_FIELD`，别的一律 verbatim；回合步骤注记挂**存储的助手条目**（确定性重算），绝不挂当轮 user 消息。Tests: `lib-message-builder-aging`、`lib-turn-steps`。
- 存储像素永不销毁（气泡显示保真，ADR-0013）；会话快照含字节（用户裁决勿重提）。Tests: `history-compactor`。
- savedSessions 写者全部进 `withSessionLock`；嵌套锁只允许 session→history 方向。Tests: `storage`。

### 安全
- 配图下载过 SSRF 门：`isBlockedPageImageUrl` 前置拦私网/loopback/metadata/IPv6 内部段 + `redirect:'error'`/`credentials:'omit'`/content-type 前置/流式超限 cancel；被拦 fail-open 保留原文。Tests: `lib-page-images`。
- storage.local 锁 TRUSTED_CONTEXTS（启动即 `setAccessLevel`）；**lib/content-scripts/ 禁引 chrome.storage**；平台 Cookie 读取单点 `readPlatformCookie`（youtube/bilibili 白名单）。Tests: `security-contracts`。
- X 兜底必须 host 门（只认 `x.com`/`twitter.com`）。Tests: `attach-page-video-fallback`。
- MAIN world 站点脚本**禁裸 `chrome.runtime.sendMessage`**（MAIN world 必然 undefined）——一律经 site-relay。Tests: `site-relay-lockstep`。

### 协议与 Provider
- `thinking:'inline'` 只有 chat-handler 与 subchat-handler 传；其余消费者保持 omit。Tests: `llm-client-chat-reasoning`。
- Hermes `reasoning.available` 是答案重放，echo guard 丢弃是正确的（ADR-0004 勿「修」）。
- subchat 走 `runsApiStream` 专用 per-subId 会话（绝不用主聊天的存储会话）；不并入 turn-request 阶梯（ADR-0007）。Tests: `subchat`。
- reasoning-levels 特定规则必须排在宽规则之后（last-match-wins）。Tests: `lib-reasoning-levels`。
- Anthropic usage 两段合并（message_start 输入/cache + message_delta 输出）。Tests: `anthropic-usage-merge`。
- 桥 400 重试门只认图片上限文案（真 400 不重试）；`bridgeApiKeys` 映射有任一条目即为权威，绝不回落卡级 key。Tests: `bridge-client`。
- 图片张数/字节上限单点 `lib/image-budget.js`（agent 与站点图同源 18/4.5M）；勿在任何侧自造第二套数字。Tests: `attach-site-images`、`lib-image-budget`。

### 渲染与面板（详版 `lib/sidepanel/AGENTS.md`）
- `thinkEl.open` 没有其他写入者（自动开合必须过 pin 检查）；`finishBubble` 是四条完成路径唯一收尾、也是图片尺寸重放唯一挂点。Tests: `render-contract-lockstep`。
- 气泡加宽用 `.has-live-diagram`；CSS 禁回 `.msg.assistant:has(...)`。Tests: `render-contract-lockstep`。
- 追问卡：`closeCard` 先盖 closed 戳（异步不得复活已删记录）；hidx 为 null 时 `findHostBubble` 扫全部气泡；跨面板写走 Web Locks；**任何替换气泡 innerHTML 的路径先 `captureDetailCardsIn`、渲染后 `reinsertDetailCards`**。Tests: `lib-detail-thread-persist`。
- `isImeComposing(e)` 是每个 Enter 提交口的唯一 IME 门。Tests: `lib-sidepanel-*`。

### 构建与清单
- MAIN-world 站点脚本共享 `site-common.js`，manifest 必须把它排在每个 `-content-script.js` 之前。Tests: `manifest-surface`。
- CSP `connect-src` 的 `ws://` 只留 loopback；六个 build 补丁 vendor 精确版本（katex/molstar/@rdkit/docling/pdf-inspector/pdfjs）。构建可复现：vendor 源全在 devDependencies，缺源即失败；`build/entries/marked-entry.mjs` 保住 marked 的可调用 default 契约。Tests: `check-compat.sh`。
- reader 注入走 `executeScript({files})`，禁止 `eval`（页面 CSP 会拦，reader 静默退化成 DOM 树）。Tests: `readability-injector`。
- `package.mjs` 是 allowlist（manifest 引用 + 固定运行根 + LICENSE）；`.md`/`.log`/`.test.mjs` 不收；`docs/assets` 只收被引用的文件。Tests: `release-package`、`docs-home`。

## 文档同步纪律（用户可见变更 = 同 PR 同步，不等提醒）

- **README 七语族**：`README.md`（zh）+ `README.en.md` 逐 PR 权威、逐节语义镜像（zh 不带英文行话）；`README.{ja,ko,es,pt-BR,ru}` 为快照，滞后可接受、功能版集中回同步（结构校验：标题数/表格行/代码块一致）。触点：Highlights（~55 行）、「你在读」表（~289）、免选模式句（~287）。
- **GitHub Pages 七语**：`docs/index.html`（zh）+ `docs/{en,ja,ko,es,pt-br,ru}/index.html`，页首 `.md-header__langs` 七语导航块逐字节统一；feature/privacy 列表镜像 README；guide 保持 en/zh。
- **素材四类逐一考虑**（截图/banner/GIF/视频）：先判断场景与操作表达是否受影响，再判断交付分辨率可辨性；GIF 内容变了必须换文件名（demo-vN 递增）；保留时要记录理由。宣传片与 demo GIF 的权威流程在 `.agents/skills/promo-video`（v7 现役），CWS 商店包在 `.agents/skills/cws-listing`——生产细节读 skill，不写进本文件。
- **AGENTS.md 族**：架构级新裁决=就近文件里加一行（不变量+测试+wiki 指针）；关门型决策必须写清 why。
- **wiki**：en/zh 逐 PR 更新（架构级变更若存在对应页，同 PR 更新本地镜像并 push，推前核对 git log 链=远端 HEAD，绝不盲推/force）。
- 打包排除全部 `README.*.md`（翻译文档不是运行资产）；隐私披露不得写「全部请求只到自选端点」或「完全不上传」。

## 重构原则（沿用）

- N 个近似 case 块只差字面量 → 一张查找表 + 单 case；两个手写同一协议的 handler = 最高危重复，抽共享函数把差异参数化（`wireChatStreamPort` 模式）。
- 抽取前 grep 零调用死导出；测试专用导出不等于死码（先读周边注释）。
- **跨层搬运数据后，重跑形状 lockstep 接线测试**，别只跑单元套件。
- 每次抽取后跑全量测试 + `check-compat.sh`，`node --check` 不够。

> 2026-10-24 多文件化：本文件从 369,618 字节压缩为索引+全局纪律；全部机制叙事移入上方四个嵌套文件与 wiki，拆分前全文在 git 历史（`git show` 拆分前 commit）。
