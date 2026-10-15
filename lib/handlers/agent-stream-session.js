// lib/handlers/agent-stream-session.js — agent 流会话的共用接线（C4）。
//
// 搬家前：Hermes /stop fetch 写了三遍（chat-handler 的 stopHermesRun、background
// STREAM_ABORT、subchat SUBCHAT_ABORT 各一份），审批/澄清 pending 条目构造写了
// 八遍（chat 五处 + subchat 三处），每处携带一份 runId‖run_id 双字段兼容——
// 「双副本=最高风险」族的残余。此处是唯一实现。
//
// 有意保留的差异（勿合并）：pending map 键（tabId vs subId）、chunk 推送名
// （APPROVAL vs SUBCHAT_APPROVAL）与回调闭包外壳留在两个 handler 手里——
// test/subchat.test.mjs 的 lockstep pin 锁着那些源码形状（ADR-0007 同族纪律）。
// 条目形状即 approval-relay 的分派接口，字段名勿改。

export function stopHermesRun(runInfo) {
  if (!runInfo?.runId || !runInfo?.baseUrl) return;
  const headers = { 'Content-Type': 'application/json' };
  if (runInfo.apiKey) headers['Authorization'] = `Bearer ${runInfo.apiKey}`;
  fetch(`${runInfo.baseUrl}/v1/runs/${encodeURIComponent(runInfo.runId)}/stop`, {
    method: 'POST',
    headers,
  }).catch(() => {});
}

/**
 * 构造一条 pending 审批/澄清条目。kind: 'hermes'（条目不带 kind 字段——
 * approval-relay 按 runId 形状分派）| 'opencode' | 'bridge'。
 * ctx = { baseUrl, apiKey, sessionId? }，data = 事件原始载荷。
 */
export function agentPendingEntry(kind, which, ctx, data) {
  if (kind === 'opencode') {
    return {
      kind: 'opencode',
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      sessionId: ctx.sessionId || '',
      requestId: data.requestId || '',
    };
  }
  if (kind === 'bridge') {
    return {
      kind: 'bridge',
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      requestId: data.requestId || '',
    };
  }
  // hermes：run_id / 审批、澄清 id 都可能 camelCase 或 snake_case——事件自带
  // （chatStream）或 runsApiStream 注入，两个名字都要接。
  return {
    runId: data.runId || data.run_id || '',
    ...(which === 'clarify'
      ? { clarifyId: data.clarify_id || data.clarifyId || '' }
      : { approvalId: data.approval_id || data.approvalId || '' }),
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
  };
}

// ── 并发审批堆叠（2026-10-15）───────────────────────────────────────────────
// pending map 曾按 tabId/subId 单槽键控：第二个并发审批事件 set 覆盖第一条，
// 其 requestId 永久丢失（agent 干等），面板侧 removeAgentCards 又把旧卡从
// DOM 删掉——用户连看到它的机会都没有；更窄的一支是应答在途时槽位被覆盖，
// 给 A 的「允许」错配到 B 的 requestId 上。现在每条 pending 用
// agentPendingKey(scope) 生成的全局唯一键，APPROVAL_RESPOND 按 reqKey 精确
// 路由，多张卡各答各的。
let pendingKeySeq = 0;

/**
 * 一条 pending 审批/澄清条目的 map 键：`<scope>::<seq>`。scope 是 tabId
 * （主聊天）或 subId（追问卡）——SW 重启会连同内存 map 一起清零，键只需在
 * 单个 SW 生命周期内唯一。seq 计数器即保证；格式不含引号/反斜杠，可安全
 * 进 querySelector 属性选择器。
 */
export function agentPendingKey(scope) {
  return `${scope}::${++pendingKeySeq}`;
}

/** 回合收尾：删掉该 scope（tabId/subId）名下所有未决条目。 */
export function sweepAgentPending(map, scope) {
  const prefix = `${scope}::`;
  for (const k of map.keys()) {
    if (k.startsWith(prefix)) map.delete(k);
  }
}
