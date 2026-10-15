# ADR-0013: 历史图片像素永不销毁——压缩只在请求侧

- 状态：Accepted（2026-09-23 用户指令）
- 来源：真机反馈「图片随文字一起发，过了一会气泡里的图就看不到了」；用户原则「气泡里面还是该有啥就有啥，能看到啥就看啥」

## Context

此前 `compactImagePartsInHistory` 在模型答完后把存储历史里的 `image_url` 像素**改写成文本占位**（token 经济设计，图注占位让多图可区分）。副作用：下一次重渲染（重开面板 / 切会话 / 删除等）时气泡从存储重建，用户发的图**从气泡里消失**——展示层为模型侧省 token 买了单。视频时间线抽屉的截图卡同样受害。8MB 驻留预算（`boundUnseenImageBytes`）也用同一破坏性手段（替换成文本）。

## Decision

1. **存储里的像素永不销毁**（气泡 / 时间线截图卡 / 会话快照的展示保真 = 硬约束）。
2. **压缩改到组请求时**：DONE 只在带图条目上盖 `imagesSeen` 标记（等价记录「模型已见过这些像素」，时序与旧的答后压缩完全一致，包括恢复会话的首轮答完才盖）；`prepareHistoryForModel`（message-builder.js）在四个 builder 里把**已标记**条目的图片换成带图注的文本占位（`[Figure 3: …]` / `[image N]`），未标记条目**按引用原样通过**。标记本身从请求副本剥除，绝不进请求体。
3. **驻留预算改为降缩略图**（`downscaleDataUrl`：SW 里 `createImageBitmap` + `OffscreenCanvas`，480px 长边、白底 JPEG）而不是删像素——只有完全解不开的坏图退化为文本占位；最新的带图条目始终豁免（要问的那张保留完整像素给模型首看）。预算在**一次加锁读改写**内完成：先按 URL 规划再重写的两阶段方案实测会误伤共享同一 data URL 的非受害条目，已弃用。
4. agent 提供商（opencode / bridge）**零改动**：`buildAgentTurn` 只取「尾部未回答 attach 串」，未回答 ⇒ 未标记 ⇒ 取图行为天然不变。

## Consequences

- 模型侧 token 经济与旧行为逐时序等价（图随首轮看、答后只见图注）；「后续轮看不到像素、只见图注」这一已接受的取舍不变。
- ADR-0005 完整保留：答前存盘的快照恢复后首轮仍发真实像素（未标记条目按引用通过）。
- 顺带修复同族展示缺陷：历史气泡此前只读**第一个**文本部件，图文交错条目的后段文本被丢弃——现按序全量拼接。
- 存储体积不再随答后压缩自动缩小，由 8MB 预算的缩略图降级兜底（面板打开的反序列化成本仍由该预算约束）。
- 新增条目字段 `imagesSeen`（存储侧标记，builder 负责剥除）；`savedSessions` 逐字快照会带上它——恢复语义恰好需要它（带标记 = 恢复后首轮也只给模型看图注，与旧机制一致）。

## Amendment (2026-10-14, 用户死命令)：请求侧压缩整体废除——KV 缓存率优先

**状态：Decision 第 2 条（请求侧图片标签压缩）被本修正案取代；第 1、3、4 条（存储保真 / 驻留预算缩略图 / agent 零改动）继续有效。**

用户在真机观察到 LLM 会话第二轮起首 token 延迟急剧恶化（「思考中…114s」），追问后拍板：**供应商前缀缓存（KV cache）的命中率是硬约束，历史必须逐字节原样上请求。**

机制依据（非猜测）：前缀缓存是严格前缀匹配——请求中任何一个 token 在位置 N 改变，从 N 到结尾的全部缓存状态作废，**排在改写点之后的纯正文一并 miss**。原「图片→文字标签」压缩发生在历史中部的条目上，等于每轮对话第一次触发压缩时把整个后缀打爆；被压缩省下的像素 token，远抵不过后缀重算的 prefill 与缓存未命中计价（DeepSeek 缓存命中价 ~1/10，Anthropic 0.1x，OpenAI 0.5x）。

随之废除的还有同族的 **context aging**（`ageStaleAttachments`：冷附件在发送时被换成占位符，`lib/handlers/chat-handler.js` 唯一调用点）——同一次后缀打爆，理由相同。

现状：
- 历史逐字原样直发（四个 builder 共用 `prepareHistoryForModel`，现只剥 `IMAGE_SEEN_FLAG` 旧标记——老存档与会话快照带标记，绝不入请求体；新盖章仅作遗留簿记）。
- 保留的例外（均为一次性、确定性，不在每轮反复改写）：`stubOversizedAttachments`（上下文溢出自救，触发即后缀失效一次，但不自救即硬失败）；`boundUnseenImageBytes`（8MB 驻留预算的缩略图降级，触发后字节重新稳定）；`maybeSummarizeAttachment`（>100K 字符附件先落原文、异步回写摘要——通常在首问发出前完成，竞态时该条目一次性破后缀）；storage.js 的 300K 总字符前端裁剪（硬边界，与溢出自救同类）。四条 LLM 通道（chat / responses / anthropic / hermes-runs）全部经 `prepareHistoryForModel` 剥标记，缓存不变量测试覆盖全部通道。
- 逐字直发的直接收益：图片像素在后续轮继续可见（原 ADR「后续轮只见图注」的取舍反转），且前缀从每轮首问起持续命中缓存。
- 回归地板：`test/lib-message-builder-aging.test.mjs`（逐字直发 + **第 N 轮请求逐条消息字节等于第 N+1 轮请求前缀**的缓存不变量）；`test/history-compactor.test.mjs` 与 `test/chat-rebuild-channels.test.mjs` 已改为钉新世界。
