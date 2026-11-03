// lib/provider-ping.js — bridge 每端点 Ping 状态的聚合规则（纯函数单点）。
// 「任一端点可达即可达；已测端点全不通才 unreachable；从未测过 = null」。
// options 的 rowPingBridge 与 pingCard 共用（此前两处手写同一规则）；
// sidepanel 下拉的回落聚合由面板批对齐到本导出。
// 注意：endpointPing 的持久化仍 exclusively 经 options 的 persistProvider
// （providers 表的唯一行级写入口）——本模块不碰存储，pingStates 的读改写
// 走 lib/storage.js 的 mutatePingStates。

/** @returns {'reachable'|'unreachable'|null} */
export function aggregateBridgePing(endpointPing) {
  const states = Object.values(endpointPing || {});
  if (states.includes('reachable')) return 'reachable';
  if (states.length && states.every((s) => s === 'unreachable')) return 'unreachable';
  return null;
}