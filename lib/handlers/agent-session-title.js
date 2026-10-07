// lib/handlers/agent-session-title.js — 跨入口接力（2026-10-01）：给 agent 侧
// 的服务端会话塞一个可发现的名字（「browsa：<首条用户文字>」），让用户能在
// agent 自己的 web UI / CLI 里找到并接着同一会话干活。会话本体一直在 agent
// 侧（agent 管线只发当前轮），这里补的只是可发现性，不搬数据。
//
// 只在回合成功后调用（chat-handler 的 hermes 分支）；同一 sessionId 只尝试
// 一次成功——戳记存 chrome.storage.session（agentSessionTitled_<provider>），
// 清空历史时随 clearAllAgentSessions 一起重置（值比较本来就自失效——换了
// 会话新 sessionId ≠ 戳记值会自动重命名——清掉只是让语义与键生命周期一致）。
// PATCH 网络失败（status 0）不盖戳，下个成功回合重试；4xx（重名/未知会话）
// 是终态，盖戳不再纠缠。
//
// 通道现状（2026-10-07）：Hermes = PATCH /api/sessions/{id}（上游原版 API，
// 服务端 sanitize + 重名拒收）；bridge/codex = 桥的 POST /threads/{id}/title →
// app-server thread/name/set（本机 codex 0.149.1 实测 {threadId, name} 形状）；
// squilla = v4 WS `sessions.rename {key, displayName}`（gateway ≥0.5.5，源码
// 实锤 contracts/generated/v4/sessions_rename.py；error res = 永久拒，transport
// 失败 status 0 留待重试——renameSquillaSession 负责这个映射）。
// claude 无 client 改名通道（claude-agent-acp 自己 AI 起标题并推送
// session_info_update），靠会话抽屉的 ID 复制 + claude --resume <id>。
// opencode 的命名通道仍待验证。

const TITLE_PREFIX = 'browsa：';
const TITLE_MAX_USER_CHARS = 48;

/**
 * Pure: derive the agent-side session title from the user's turn text.
 * First line only, whitespace collapsed, hard-capped; null when there is
 * nothing to name (empty/image-only turn — a later text turn names it).
 */
export function deriveSessionTitle(userText, { maxUserChars = TITLE_MAX_USER_CHARS, prefix = TITLE_PREFIX } = {}) {
  const head = String(userText || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!head) return null;
  // 码点切片：UTF-16 .slice() 会把 emoji/生僻字的代理对切成两半，孤立代理项
  // 进 JSON.stringify 产出 \ud83d 转义——agent 侧标题乱码甚至 4xx（且 4xx 会
  // 被盖「已命名」戳永不重试）。与 autoSessionName 的码点切片同一教训。
  const cps = Array.from(head);
  const body = cps.length > maxUserChars ? cps.slice(0, maxUserChars).join('') + '…' : head;
  return prefix + body;
}

/**
 * Stamp-once wrapper. `patch({ sessionId, title })` → { ok, status };
 * `stampGet(provider)` / `stampSet(provider, sessionId)` are the storage
 * session-key helpers. Injectable for tests.
 */
export async function titleAgentSessionOnce({ provider, sessionId, userText, patch, stampGet, stampSet }) {
  if (!sessionId) return false;
  const title = deriveSessionTitle(userText);
  if (!title) return false;
  try {
    if ((await stampGet(provider)) === sessionId) return false;
  } catch { /* stamp read failure = unstamped; the PATCH is still idempotent */ }
  let res;
  try {
    res = await patch({ sessionId, title });
  } catch {
    return false; // transport-level throw behaves like a network failure
  }
  // Success, or a PERMANENT refusal (4xx/5xx from the API: title conflict,
  // unknown session, auth) — stamp so a transiently-named-then-renamed or
  // hostile endpoint can't turn every later turn into a retry loop. Only a
  // pure transport failure (status 0) stays unstamped for the next turn.
  if (res?.ok || (res?.status || 0) !== 0) {
    try { await stampSet(provider, sessionId); } catch { /* best-effort */ }
    return !!res?.ok;
  }
  return false;
}
