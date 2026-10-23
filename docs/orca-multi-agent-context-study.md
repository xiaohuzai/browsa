# Orca 多 agent 上下文共享机制研究，及对 browsa 的借鉴

研究日期：2026-10-23。源码基线：`stablyai/orca` `main`（`pushed_at` 2026-10-23T03:11:44Z，10.29 万星）。

研究方法：没有只看 README。通过 GitHub API 拉取全量文件索引（40183 个 blob）定位相关模块，逐个读取源码原文。下文每个结论都标注了源码路径，可直接核对。

---

## 一、先纠正一个前提：Orca 不做"上下文同步"

这是整份研究里最重要的一条。

我原本也以为 Orca 会像多方会议一样，把各 agent 的对话镜像到一起。**实际不是。** Orca 的架构里，跨 agent 传的东西只有一种：**结构化的任务派遣说明（dispatch preamble）+ 一条可选的任务规格（task spec）**。

读 `src/main/runtime/orchestration/preamble.ts` 的 `buildDispatchPreamble()`，它发给 worker 的内容由这些块组成：

1. 身份块——协调者的 terminal handle / Orca session ID、自己的 task ID、dispatch ID
2. 沟通契约块——一个 ` ```sh ` 围栏，教 worker 用 `orca orchestration send` 汇报结果、发心跳、用 `ask` 提问、用 `check` 收指令
3. 可选的 base drift 块——worktree 落后基线多少 commit、最近五条提交标题
4. 可选的 sub-dispatch 块——能不能再派子 worker
5. `=== TASK ===` 段——task spec 原文

**没有对话历史。** 一个字都没有。`buildDispatchPreamble()` 的返回语句是 `${header}${drift}${subDispatch}\n\n=== TASK ===\n${params.taskSpec}`——四个变量里没有任何一个是历史消息。协调者跟用户的聊天记录、别的 agent 说过什么，都不会进 worker 的 context。

preamble 的作者在注释里把设计理由写得很直白（`preamble.ts:67-71`）：

> Behavioral rules live as inline comments above the relevant CLI example, not as a separate prose block — **LLM readers anchor on examples and skim trailing prose, so rules must land at the point of use.**

以及 `preamble.ts:85-88`：

> Why plain-reason wording: Claude Code tells the model pasted text may carry instructions the user did not write, and **shouted rules read as prompt injection**.

这两条是真正的工程经验，下面还会用到。

---

## 二、Orca 实际怎么让下一个 agent 知道前任做了什么

不靠传历史，靠三样东西：

### 1. 磁盘是共享的，context 不用搬

Orca 的核心设计是 **Parallel Worktrees**：每个 worker 在同一个 repo 的**独立 git worktree** 里干活。所以：

- 前任改的代码，后任在自己的 worktree 里 `git diff` / 读文件就能看到（或者由协调者合并）
- 前任写的报告，落在磁盘上，后任读文件就行
- `.readme` 级别的产物本身就在工作区里

`preamble.ts:99-113` 的 `worker_done` 契约强制要求：

> `--body` must be a 3-sentence executive summary (what you did, what you found, what's left). **Never send an empty body; the coordinator reads the body first and only opens artifacts if it needs more detail.** Append `--files-modified` only when files changed, and append `--report-path` only when you produced a durable report.

也就是说：**交接靠三件东西——3 句话摘要、改动文件清单、报告路径**，而不是对话历史。协调者先看摘要，需要细节才去开产物。

这是关键洞察：**当 agent 共享一个文件系统时，"同步上下文"这个问题大部分自动消失了。** 该共享的不是对话，是产物；对话只是产物地址的索引。

### 2. 结构化生命周期消息，不是自由文本

worker 通过 `orca orchestration send` 发四种消息（`preamble.ts:96-148`）：

| 类型 | 用处 | 关键约束 |
|---|---|---|
| `worker_done` | 报告完成 | 必须恰好一次；必须同时带 `task-id` 和 `dispatch-id` |
| `heartbeat` | 证明还活着 | 每 5 分钟；跳过仅在 `check --wait` / `ask` 阻塞时 |
| `escalation` | 阻塞升级 | completion 之前发 |
| `ask` | 提问并阻塞等答案 | **明确禁止用 AskUserQuestion**（协调者看不见） |

为什么 `task-id` 和 `dispatch-id` 都要带，`preamble.ts:8-12` 写了原因：

> A retried task has multiple `dispatch_contexts` rows; keying `worker_done`/`heartbeat` on `dispatchId` prevents **stale messages from a previously-failed dispatch from completing or refreshing the retry.**

这个细节值得单独记一笔——它是"重试"这个动作在上下文层面的真实代价：**同一个任务会有多个上下文实例，消息必须能区分是哪个实例发的**，否则失败重派的前任发来的迟到消息会把新的那次当成完成。

### 3. 统一的中枢消息总线，agent 之间从不直连

我专门验证了这点。`skill-guides/orchestration/references/messaging-and-gates.md:29-53` 写得很清楚：

- 地址形态：`dispatch:<dispatch_id>`（指定某次派遣）、`run:<id>`（某次运行）、`@all` / `@idle` / `@claude` / `@codex` / `@worktree:<id>`（分组）
- 分组消息只发给**发送者自己 Run 里的活 Dispatch**
- "A sender bound to no Run is refused"
- `worker_done`、`heartbeat` 和生命周期消息**永远不能发往分组**

落库在 SQLite（`src/main/runtime/orchestration/db/`，schema 已经演进到 v43，见 `db/schema/migrate-v43.ts`）。协调者每 2 秒轮询消费。

---

## 三、Orca 存了什么、丢了什么

这块最能看清取舍。

### 存下来的是"产物"，不是"过程"

`worker-output-archive.ts:83-183` 的 `captureWorkerOutputArchive()` 在关闭 PTY 之前冻结输出，**优先 transcript，降级 terminal tail**：

| 归档类型 | 触发条件 | 内容 |
|---|---|---|
| `transcript_pin` | hook 报上了 provider session，且 transcript 可读 | 该 agent 自己落盘的会话文件里的 `NativeChatMessage[]` |
| `structured_journal` | worker 是结构化会话 | 它自己的 journal |
| `terminal_tail` | 上面都不行 | 终端尾部原文，**262144 字符上限**（`TERMINAL_ARCHIVE_MAX_CHARS`） |

注意 `worker-transcript-payload.ts:56-62` 的注释（这段说的是 `boundWorkerTranscriptTail` 为什么从尾部累积，而 `boundWorkerTranscriptMessages` 保留头部——前者用于归档，后者用于前向分页）：

> `boundWorkerTranscriptMessages` keeps the head, which is right for a forward page and wrong for an archive: the evidence anyone reads a released worker back for is **its final answer**, so the tail is what must survive the budget.

还有 `worker-transcript-payload.ts:7-17` 的一组硬上限：

```
DEFAULT_WORKER_TRANSCRIPT_MESSAGE_LIMIT = 40
MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT = 50
MAX_WORKER_TRANSCRIPT_BLOCKS = 6
MAX_WORKER_TRANSCRIPT_BLOCK_CHARS = 1_200
MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES = 512 * 1024
```

也就是说：**即使回读 transcript，也只保留最后约 40 条消息，单块文本 1200 字符封顶。** 它不是"完整历史"，是一份**有明确预算的取证快照**。

### 明确丢弃的东西

- 完整对话历史（从不跨 agent 传递）
- 各 agent 的内部推理过程
- 被裁剪的超长 tool 输入（深度 >5 层直接截断，`worker-transcript-payload.ts:226-228`）

### 一个值得学的安全细节

`worker-transcript-payload.ts:151-161` 的 `boundIdentifier()`：如果消息 ID 里含 transcript 文件路径，**把它换成 sha256 摘要**，并在 warnings 里标注"标识符已不透明化"。同文件的 `redactSensitiveText()` 会把 dispatch capability token 从输出里抹掉。

这是"回读别人 transcript"这件事必须付的隐私代价——Orca 是显式处理的，不是假装没有。

---

## 四、Orca 的 skill / MCP / 知识库共享方式

这个问题我在 browsa 的上下文里也想过，Orca 的答案是**打包分发，不是运行时协议**。

`docs/agent-skill-sharing-implementation-checklist.md`（11.9 万字符，2026-08-12 最后更新）描述的是完整的工程链路：

`src/main/skills/` 目录下共 **201 个文件，其中 107 个是非测试源码模块**（`git/trees?recursive=1` 全量计数），全部围绕同一件事：**把一个 skill 打包成一个可安装的 bundle，投递到各 agent 自己的 provider 目录。**

具体分工（都是真实文件，不是推测）：

| 模块组 | 职责 |
|---|---|
| `skill-package-*.ts` | 打包成 tar/gzip，确定性 gzip，包身份计算 |
| `skill-install-*.ts` | 落地安装事务：规划、锁、日志、崩溃恢复、验证 |
| `skill-provider-destinations.ts` / `skill-provider-runtime-roots.ts` | **每个 agent 各自的安装根目录** |
| `skill-cloud-*.ts` | 经云端的跨机器分发（签名上传、grant、下载） |
| `skill-share-preparation-service.ts` | 分享前的准备与准入 |
| `skill-placement-transaction*.ts` | 跨多个 provider 的放置事务与对账 |

关键事实（`docs/agent-skill-sharing-implementation-checklist.md` 已验证段落原文）：

> **Codex uses its documented global `~/.agents/skills` root**, and provider removal derives allowed roots from the registry so **aliases remain removable after an agent is no longer detected**.

也就是说，Orca 的共享模型是：

```
一个 skill 源  →  打包  →  事务化安装到 N 个 agent 各自的目录
                      ↓
            claude: ~/.claude/skills/
            codex:  ~/.agents/skills/
            opencode: ...
```

**不是**"所有 agent 读同一份共享 skill"。每个 agent 读自己那份拷贝，只是这份拷贝由 Orca 统一分发和版本化。这跟我之前在 browsa 里给的判断一致——各 agent 自己的配置是真值源，共享的是分发通道。

这也解释了为什么这套东西需要 107 个源码模块：跨平台（macOS / Windows / WSL / SSH）、进程被杀后的恢复、锁竞争、alias 修复、事务回滚，每一样都是真问题。

---

## 五、对照 browsa：我们现在处于什么位置

先把 browsa 的现状用同样的颗粒度列出来（都已核对源码）。

| 维度 | Orca | browsa |
|---|---|---|
| 跨 agent 传什么 | 结构化 preamble（身份 + 沟通契约 + task spec） | 纯文本对话转储（`buildAgentBackfill`） |
| 触发方式 | 每次派遣都带完整契约 | 一次性布尔标志 `pendingAgentBackfill` |
| 上限 | 契约无长度上限；task spec 独立 | 20 万字符，**截尾保最近**（`BACKFILL_MAX_CHARS`） |
| 是否记录 agent 干了什么 | 强制 `worker_done` 带 3 句摘要 + `--files-modified` + `--report-path` | **完全没有**：`toolEvents` 只在内存，DONE 时清空 |
| 能否回读前任 transcript | 能（`worker-read`，40 条 / 1200 字符封顶） | **不能**：browsa 没有任何读取 agent 会话文件的代码路径（全库搜索 `transcript` 只命中注释与视频字幕相关模块） |
| 产物共享介质 | 共享文件系统（各 worktree） | 无（浏览器插件没有工作区概念） |
| 失败重试的上下文正确性 | 有 `dispatch-id` 防迟到消息 | 无对应机制（单 agent 顺序对话，暂不需要） |
| skill / MCP 共享 | 打包分发到各 provider 目录 | 无此功能（靠 OS 用户环境天然共享） |

### browsa 具体"糙"在哪，四条

**第一条，也是最致命的：没有过程记录。**

`sidepanel.js:2079` 的 `toolEvents: []` 是唯一的工具事件容器，`sidepanel.js:1892-1893` 在 DONE 时把它渲染进气泡然后**清空**。`chat-handler.js:863` 落库的助手条目只有：

```js
{ role: 'assistant', content: fullReply, providerLabel, providerKey, ...(videoSrc ? { videoSrc } : {}) }
```

对比 `chat-handler.js:195-197` 的 SW-death 收尸条目，形状完全一样——**没有任何字段记录"这一轮调了哪些工具、动了哪些文件"**。

后果很直接：codex 帮你改了一个文件、跑了一次搜索，切到 opencode 之后，这件事在 context 里**根本不存在**。下一轮 `buildAgentBackfill` 能给出的只有"助手：我改好了"这句话，没有"改了哪个文件"。

**第二条：一次性意图，失败即丢。**

`sidepanel.js:2158-2159`：

```js
const backfill = pendingAgentBackfill;
pendingAgentBackfill = false; // 一次性：无论本轮是否 agent，意图已消费
```

这一轮如果失败、被用户中止、或者后台报错，转储就没了。用户得回退、重新切 provider、重新选「带上当前对话继续」。而 `sidepanel.js:1588` 更狠——**只要再切一次 provider，`pendingAgentBackfill` 就作废**。

**第三条：原始转储不是交接。**

`agent-turn.js:133-157` 的 `buildAgentBackfill` 干的事是把历史渲染成：

```
用户：…
助手：…
用户：…
```

超过 20 万字符就 `'（更早的对话已省略）\n\n' + transcript.slice(-BACKFILL_MAX_CHARS)`。

问题不在截断，在于**格式本身没有信息层级**。接手的 agent 需要的是：当前目标是什么、已经定了哪些决策、改了哪些文件、还有什么没解决。它拿到的是流水账，得自己从里面重建这些。而 Orca 的 `worker_done` 契约强制 worker 自己先做这次提炼——而且是**在它还拥有完整上下文的时候**做。

**第四条：图片在交接时消失。**

`agent-turn.js:149`：图片降级成 `（附图，未随记录转发）`。Orca 至少在 transcript 归档里保留了 `image-ref` 类型（`worker-transcript-payload.ts:137-143`），虽然本机路径会被抹掉。

---

## 六、能借鉴什么：按依赖顺序的四层

我按"改动的代价 / 收益比"排序，每层都能独立落地。

### 第一层：给回合加一个持久化的 steps 账本（必做，其他都依赖它）

**借鉴点**：Orca 的 `worker_done` 强制 `--files-modified` + `--report-path`。

**browsa 落地**：给 `persistTurnEntry` 的助手条目加一个不参与渲染的 `steps` 字段：

```js
{
  role: 'assistant',
  content: fullReply,
  providerLabel, providerKey,
  steps: [
    { kind: 'tool', name: 'read_file', target: 'src/app.ts', ts: ... },
    { kind: 'tool', name: 'edit', target: 'src/app.ts', summary: '+12/-3', ts: ... },
    { kind: 'search', query: '...', hits: 7, ts: ... },
  ]
}
```

要点：

- **不渲染**。气泡外观零变化，纯数据。这样不会触发任何视觉回归、不需要改截图/GIF/宣传片
- 数据来源是 CHUNK/TOOL_PROGRESS 事件——`sidepanel.js:1861` 已经在收集了，只是没送出去。需要让后台也能拿到（目前 tool 事件只推给面板）
- 体量控制：单条目 step 上限（建议 50 条）+ 单 step 摘要字数上限（建议 200）

这一层单独就有价值：追问卡、会话导出、错误重试、"它到底改了什么"的追溯，全部依赖它。

### 第二层：交接 brief 替代原始转储

**借鉴点**：`preamble.ts` 的结构化分块 + `worker_done` 的"3 句话摘要"纪律。

**browsa 落地**：切换 agent 时不再 dump 原始历史，而是生成一份结构化交接：

```
## 当前目标
<1-2 句>

## 已确定的决策
- ...

## 产出物
- 文件：src/app.ts（+12/-3）
- 附件：3 个页面、1 个视频

## 未决问题
- ...

## 最近对话原文
<最近 N 轮逐字>
```

关键的实现纪律，直接抄 Orca 的两条注释：

1. **规则要贴在用处旁边，不要单独成段**（`preamble.ts:67-71`）——生成 brief 的模型会照着示例走，不会读尾部的说明。所以「产出物」那一节要给具体的格式示例。
2. **不要用喊叫式措辞**（`preamble.ts:85-88`）——会被模型读成 prompt injection。用平实的理由句。

配套要求：

- brief **存成会话上的持久对象**，不是布尔标志。发送失败、用户中止、再次切换，都能复用同一份，而不是重新生成或直接丢掉
- 可「检查」（复用现有附加条目的 `检查`/`撤销` 按钮模式），用户能看到到底发了什么
- 生成 brief 用廉价模型（不是主对话模型），prompt 里拿到的是 `steps` 账本 + 最近原文

### 第三层：大上下文走文件通道

**借鉴点**：Orca 的 `--report-path` + browsa 自己在 squilla 上已有的先例。

`turn-request.js:117-131` 已经实现了这个模式：

```js
const SQUILLA_INLINE_CONTEXT_CAP = 60_000;
if (turn.contextChars > SQUILLA_INLINE_CONTEXT_CAP || ...) {
  const fileUuid = await uploadSquillaFile({ name: 'page-context.md', content: turn.contextText });
  squillaMessage = [...note, userText].join('\n\n');
}
```

交接同理：brief + 完整历史写成 `browsa-handoff.md` 随轮附上，让 agent 自己分段读。这样彻底绕开 20 万字符的内联上限，而且**保留了完整信息**（Orca 做不到这点，因为它只有终端粘贴）。

这条对 browsa 其实是**优势项**——squilla 的网关支持文件材料通道，Orca 的 worker 只有 PTY 粘贴。

### 第四层（长期）：把历史暴露成 MCP 工具

**借鉴点**：Orca 的 `worker-read` / `check` 这类"agent 主动拉取"的接口设计。

**browsa 落地**：起一个本地 MCP server，暴露三个只读工具：

- `search_history(query, limit)` — 跨会话检索
- `read_attach(attachId)` — 读某个附加页面/文档的全文
- `get_session_brief(sessionId)` — 拿结构化 brief

好处是**解耦了"什么时候同步"**。不再是"切换那一刻塞一段文本"，而是任何支持 MCP 的 agent 在需要时自己来查。这同时是第二段提出的 skill/MCP 共享问题的正确答案——**用行业标准协议做接缝**（client↔tool 已有标准，agent↔agent 至今没有）。

---

## 七、明确不该抄的部分

研究里同样重要的是识别边界。

**不要抄双向 transcript 镜像。** Orca 也**没有**做这件事。它读 transcript 的方式是：**归档前冻结一次**（`captureWorkerOutputArchive`），此后只读冻结的那份。它从不试图让两个 agent 的会话状态互相同步。原因是显然的——每个 agent 的 token 记账、工具 schema、内部状态都不同，镜像必然失败。

**不要抄 40 条 / 1200 字符那种硬上限的规模。** Orca 的 worker 是短命的一次性任务，40 条消息够用。browsa 的会话是长期的，用户在同一个对话里可能聊几十轮。**要抄的是"有明确预算"这个原则，不是具体数字。**

**不要抄 dispatch-id 那套防重放机制（现在还不需要）。** browsa 的对话是用户手动顺序推进的，不存在"同一任务的多个并发派遣"。等真做了并行多 agent 再说。

**不要抄 SKILL 打包分发。** 那套东西需要 107 个源码模块，收益只在大规模跨机器分发时才成立。browsa 现在的形态（浏览器插件 + 本地桥）没有这个需求。要做也是等 MCP 工具层落地之后。

---

## 八、一句话总结

Orca 的答案不是"更好地同步上下文"，而是**重新定义了什么叫共享**：不共享对话，共享产物 + 一份强制的结构化摘要；上下文不是搬过去的，是后任自己按地址去拿的。

browsa 现在做的是"把对话记录拍平成文本塞过去"，既没有产物层（连 agent 改了什么都不知道），也没有摘要层，还是一次性易丢的。**最先要做的是那个 steps 账本**——没有它，后面所有交接格式都只是在给有损数据做包装。

---

## 附：本文引用的源码位置

Orca（基线 `main` @ 2026-10-23）：

- `src/main/runtime/orchestration/preamble.ts` — 派遣说明的全部内容与设计理由
- `src/main/runtime/orchestration/coordinator-task-dispatch.ts` — 派遣流程、drift 守卫、决策门注入
- `src/main/runtime/orchestration/db/dispatch-context/dispatch-context-store.ts` — 派遣上下文落库
- `src/main/runtime/orchestration/worker-output-archive.ts` — 输出归档（transcript 优先 / terminal 降级）
- `src/main/runtime/orchestration/worker-transcript-read.ts` — transcript 回读
- `src/main/runtime/orchestration/worker-transcript-payload.ts` — 回读预算与脱敏
- `src/main/runtime/orchestration/send-agent-turn.ts` — 投递传输层
- `src/main/external-conversations/external-conversation-seam.ts` — 外部消息投递到 agent 终端
- `src/main/external-conversations/external-conversation-chain.ts` — 按会话串行化的队列
- `src/main/skills/` — 107 个源码模块的 skill 打包分发体系（目录共 201 个文件）
- `docs/agent-skill-sharing-implementation-checklist.md` — 分发的完整实施清单
- `skill-guides/orchestration/references/messaging-and-gates.md` — 消息与地址模型
- `skill-guides/orchestration/references/coordinator-loop.md` — 协调者循环

browsa（当前 `dev` 分支）：

- `lib/agent-turn.js:70-115` — `buildAgentTurn`（只发单轮）
- `lib/agent-turn.js:126-157` — `buildAgentBackfill`（20 万字符截尾转储）
- `lib/agent-turn.js:159-169` — `agentSwitchNeedsPrompt`（何时触发交接卡）
- `lib/handlers/turn-request.js:46-341` — 逐 provider 的请求形状
- `lib/handlers/turn-request.js:117-131` — squilla 的大上下文文件通道先例
- `lib/handlers/chat-handler.js:142-169` — `persistTurnEntry` 落库形状
- `lib/handlers/chat-handler.js:863` — 助手条目落库（无 steps 字段）
- `sidepanel.js:1588, 2158-2159` — `pendingAgentBackfill` 的一次性语义
- `sidepanel.js:1861, 1891-1893` — `toolEvents` 收集与清空
- `sidepanel.js:1597-1649` — 切换卡 UI