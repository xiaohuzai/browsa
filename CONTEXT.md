# CONTEXT.md — browsa 领域词汇表

> 用途：给架构评审（improve-codebase-architecture 流程）提供稳定的领域命名。
> **AGENTS.md 仍是工程事实与实现细节的超集**；`docs/adr/` 存放「已拍板勿翻案」的决定（ADR）。
> 新概念命名先来这里找；评审报告的架构用词见文末词汇表。

## 领域概念（domain）

| 术语 | 含义 |
|---|---|
| **History** | `chrome.storage.local` 的全局扁平消息数组（非 per-tab）；全局单一对话是有意的默认形态 |
| **hidx（history index）** | 气泡与 history 槽位的镜像计数器——是镜像不是权威，`reconcileHistoryIdx` 校正漂移 |
| **Attach pipeline（附加管线）** | 📎 从页面抽取到历史落库的全链路 |
| **Deferred-storage handoff（延时落库交接）** | sidepanel 完成截图/PDF/Office/ASR 管线后经 `ATTACH_*_CONFIRM` 交给 background 落库 |
| **Page context（页面上下文）** | 发给模型的脱敏文本块（`PAGE_CONTEXT_PREFIX`） |
| **Mode caps / deferred handoffs** | `lib/attach-modes.js` 的模式能力表与交接表 |
| **Turn-request ladder（回合请求阶梯）** | `createTurnRequest` 的 prepare/rebuildFrom/continueWith/rewriteWith 形状阶梯（仅主聊天） |
| **apiStyle** | 四种 wire protocol：chat（/v1/chat/completions）/ runs（Hermes /v1/runs）/ responses / anthropic |
| **Agent provider** | opencode / bridge / hermes 等带会话的智能体后端 |
| **Session family（会话族）** | isHermes/isOpencode/isBridge 三族智能体会话的建立与清空族谱 |
| **Detail thread（追问卡 / subchat）** | 选中文字开的细聊侧会话；独立输入召回域、独立 Hermes 会话（ADR-0006/0007） |
| **Stream state（流状态）** | streamPorts/streamState/chatControllers 等 Map + pushChunk 推送协议 |
| **Turn chrome（回合过程外壳）** | 思考中指示、tool 历史折叠、token 用量 chip、审批/澄清卡的统称（当前 chat/subchat 双副本） |
| **Approval / clarify relay** | agent 危险操作审批与反问澄清的人工中继（approval-relay 单一持有） |
| **Fenced renderer（围栏渲染器）** | ` ```lang ` 围栏 → 实时渲染替换的模式家族（mermaid/echarts/markmap/smiles/pdb/nn） |
| **Capability hints / agent render hint** | 教模型发渲染围栏的提示文本（体积已冻结，ADR-0010） |
| **Thinking inline/omit** | 推理文本的包裹策略；仅主聊天与追问用 inline（ADR-0004） |
| **Reveal pacer（显影节奏器）** | delta → 可见文本的节流显影（markstream-core） |
| **Streaming block commit（流式块级提交）** | 已完成 markdown 块只提交一次、每帧只重解析开口尾巴（ADR-0011） |
| **Transcript drawer（视频时间线）** | `[mm:ss]` 音视频笔记的可浏览面（跳转/跟播/记一笔） |
| **Sessions drawer（会话抽屉）** | savedSessions 快照；**含图片字节，是有意保留**（ADR-0005） |
| **Followups queue（跟进队列）** | 流式期间排队的后续消息，DONE 后自动续发 |
| **Input-history recall scope（输入历史召回域）** | 每个输入面一个独立的 ↑/↓ 召回域（ADR-0006） |
| **Site caches（站点缓存）** | XHR 拦截得来的结构化站点数据 registry（SITE_CACHES/SITE_MESSAGE_MAP） |
| **Change tracker（变更追踪）** | 附件文本哈希对比的「内容已变」模型侧提示 |
| **Envelope（响应信封）** | `{ok:true,data}` / `{ok:false,error,code,hint}`；审批/澄清类 handler 自带内层 `{ok,…}`——读层错位是历史 bug 家族 |
| **Get-all keys contract** | `GET_ALL_KEYS` 轻键清单契约：新键要进表，定点读的键不进表 |
| **MAIN-world constraint（主世界约束）** | `executeScript` 只序列化单个注入函数；helper 必须内嵌（ADR-0009） |

## 架构词汇（评审报告用词，禁止替换）

**module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality**
（不用 component / service / API / boundary 替代；「深度」= interface 远小于 implementation。）
