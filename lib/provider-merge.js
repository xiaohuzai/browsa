// lib/provider-merge.js — provider 表行级 read-merge-write 的合并策略（纯函数）。
// 从 options.js 的 persistProvider 抽出（2026-11-03 存储契约批）：策略长在 DOM
// 事件 wiring 里时，测它必须驱动整个 options.html + jsdom 点击。
//
// 基底 = 最新 storage 表 + 内置默认行中 storage 未持有者：
//   - storage 持有的行一律 storage 赢（救并发编辑与并发新增）；
//   - storage 已删除的行绝不从页面快照复活（lost-delete 回归）；
//   - 内置 agent 行（hermes/opencode/squilla/bridge）首次保存前不在 storage，
//     由 defaultProviders 名单补齐——名单从 lib/storage.js 的 DEFAULT_PROVIDERS
//     导入，勿按 type 猜。
// 调用方（persistProvider）负责：storage 读失败必须放弃写入，绝不把 null 当
// 空表传进来——那会一次性抹掉全部用户行。

/**
 * Merge ONE row write into the latest stored provider table.
 * `value === undefined` deletes the row. Returns a NEW table; inputs untouched.
 */
export function mergeProviderRow(storedProviders, defaultProviders, name, value) {
  const stored = storedProviders || {};
  const next = {};
  for (const [k, v] of Object.entries(defaultProviders || {})) {
    if (!(k in stored)) next[k] = v;
  }
  Object.assign(next, stored);
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}