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
