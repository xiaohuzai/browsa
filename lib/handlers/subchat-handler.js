// lib/handlers/subchat-handler.js — body of background.js's `case 'SUBCHAT'`
// and `case 'SUBCHAT_ABORT'`, extracted verbatim (Phase 2 of the
// sidepanel/background modularization refactor). handle() in background.js
// delegates here.

import * as storage from '../storage.js';
import { stopHermesRun, agentPendingEntry } from './agent-stream-session.js';
import { dispatchStyleStream } from './stream-dispatch.js';
import { runsApiStream } from '../llm-client.js';
import { opencodeStream, createOpencodeSession } from '../opencode-client.js';
import { bridgeStream } from '../bridge-client.js';
import { squillaStream, createSquillaSession } from '../squilla-client.js';
import { relayApproval, relayClarify } from './approval-relay.js';
import { subChatControllers, subChatPorts, pushSubChatChunk } from '../state.js';
import { resolveProvider, resolveInferenceParams, resolveChatModel, resolveBridgeEndpoint, resolveBridgeApiKey, resolveReplyModelOrEndpoint } from './provider-resolver.js';
import { reasoningFieldsFor } from '../reasoning-levels.js';
import { providerEntryLabel } from '../provider-display.js';
import { pickTurnImages } from '../image-budget.js';
import { buildMessages, buildHermesTurn, buildResponsesInput, buildAnthropicMessages } from '../message-builder.js';
import { withAgentRenderHints } from '../agent-turn.js';

// opencode session per detail thread (subId → server `ses_…` id). In-memory
// only: threads are ephemeral, and a SW restart mid-thread simply starts a
// fresh server session (same degradation rule the OpenSquilla integration
// used). Keeping the side Q&A out of the main opencode session preserves
// the same isolation that keeps subchat off the Hermes runs path.
const subchatOpencodeSessions = new Map();

// Same for the bridge provider: one agent thread per detail thread. In-memory
// only — a SW restart mid-thread just starts a fresh agent thread (the same
// degradation rule as opencode subchat above).
const subchatBridgeSessions = new Map();

// Hermes runs session per detail thread (subId → session id). Same lifecycle
// rule as the opencode/bridge maps: in-memory only, a SW restart mid-thread
// starts a fresh server session — and since the full subMessages ride in
// conversation_history on every turn, the thread self-heals regardless.
// NEVER the main chat's storage-backed hermesSessionId: mixing would pour
// this side Q&A into the main conversation's server-side agent context.
const subchatHermesSessions = new Map();

// Live run ids for server-side cancellation: SUBCHAT_ABORT fires Hermes's
// /v1/runs/{id}/stop (the route is /stop — there is no /cancel, confirmed via
// /v1/capabilities; same call background.js's main-chat ABORT makes) so a
// stopped follow-up doesn't leave the agent executing tools headless.
// Gateway session per detail thread (subId → sessionKey). In-memory only:
// threads are ephemeral, and a SW restart mid-thread starting a fresh
// gateway session is an acceptable degradation (see the squilla branch).
const subchatSessionKeys = new Map();

const subChatRunIds = new Map();

// Pending agent approval/clarification requests, keyed by subId (the
// subchat analog of background.js's per-tab pending-approval maps).
// Entries carry exactly what the SUBCHAT_*_RESPOND relays below need —
// same per-kind shapes as the main chat's handlers
// (runs: runId+approvalId/clarifyId; opencode: sessionId+requestId;
// bridge: requestId+per-endpoint key).
const subchatPendingApprovals = new Map();
const subchatPendingClarifications = new Map();

// Bound the per-thread session maps. A detail-thread subId is regenerated on
// every card open, so without a cap a long browsing session accumulates one
// entry — and one live server-side agent session — per thread ever opened.
// Oldest-evicted LRU; threads are ephemeral, so dropping the oldest just costs
// a fresh server session if that (long-closed) thread is somehow reopened.
const SUBCHAT_SESSION_CAP = 50;
function setBounded(map, key, value) {
  if (map.has(key)) map.delete(key); // refresh recency
  map.set(key, value);
  while (map.size > SUBCHAT_SESSION_CAP) map.delete(map.keys().next().value);
}

/**
 * "Detail thread" side-conversation: the user selected a piece of text
 * inside an assistant reply and wants to drill into it without touching the
 * main conversation. Deliberately scoped down from CHAT:
 * - Hermes providers run through runsApiStream (the same channel as the main
 *   chat) with a DEDICATED per-subId session, so this side Q&A never mixes
 *   into the main conversation's server-side agent context. (2026-09-11,
 *   reversing the earlier compat-only rule: the /v1/chat/completions compat
 *   layer does not surface the agent's reasoning at all — verified live,
 *   zero reasoning fields in the stream — while runs streams
 *   reasoning.available, which llm-client turns into the <thinking> blocks
 *   the detail thread renders. Per-turn fixed cost measured equal between
 *   the two paths, ~9.7K input tokens; both construct an agent per request.)
 * - LLM providers (chat/completions, responses, anthropic messages) share
 *   dispatchStyleStream with CHAT. Agent branches (Hermes runs, opencode,
 *   bridge) surface tool progress and approval/clarify requests to the card.
 * - never touches storage.appendToHistory — the whole point is that
 *   the main history stays clean.
 * - no page context/domain rules/llms.txt — sidepanel.js already
 *   built the scoped context (quoted excerpt + the question).
 *
 * `capabilityHints` is background.js's shared system-prompt constant.
 */
export async function handleSubchat(msg, capabilityHints) {
  const all = await storage.getAll();
  const provider = resolveProvider(all);

  const subId = msg.subId;
  if (!subId) throw new Error('subId required');
  const userMessages = Array.isArray(msg.messages) ? msg.messages : [];
  if (!userMessages.length) throw new Error('messages required');

  // apiStyle selects the wire format for non-Hermes providers, same as CHAT.
  const apiStyle = provider.apiStyle || 'chat';
  // For responses/anthropic, split the leading system message out of the
  // turn array into the API's dedicated system field (instructions/system).
  const sysPrompt = capabilityHints;
  const turnMessages = userMessages; // [{role:'user'|'assistant', content}] as supplied
  // 本次轮次要转发的图片（粘贴/截图的 data URL，卡片随 SUBCHAT 带来）。预算
  // 与主聊天同门（lib/image-budget.js 的 pickTurnImages：≤8 张 + 字节预算），
  // 超限裁掉——卡片侧 attach 时已逐张拦截，这里只兜直连消息。squilla 分支
  // 刻意不转发（网关契约：粘贴图留在 browsa 侧，见其分支注释）。
  const turnImages = pickTurnImages(Array.isArray(msg.images) ? msg.images : []).images;
  const controller = new AbortController();
  subChatControllers.set(subId, controller);
  const { temperature, maxTokens } = resolveInferenceParams(provider);
  // Reply-source stamp on DONE — the same label the main chat's reply chip
  // shows for this selection (provider-display.js via the shared resolver),
  // so a detail-thread reply says who produced it exactly like a main-chat
  // bubble does. The bridge endpoint is resolved once here and reused by the
  // bridge branch below (subBridgeUrl); other kinds ignore the 3rd arg.
  const subBridgeUrl = resolveBridgeEndpoint(provider, all) || provider.baseUrl;
  const replyModelOrEndpoint = resolveReplyModelOrEndpoint(provider, all, subBridgeUrl);
  const providerLabel = providerEntryLabel(all.activeProvider, provider, replyModelOrEndpoint);
  const providerKey = { name: all.activeProvider, model: replyModelOrEndpoint };
  console.log('[subchat][bg]', subId, 'starting', apiStyle, 'stream, port already registered?', subChatPorts.has(subId));

  // Fire-and-forget: reply to the sendMessage call immediately so the
  // side panel doesn't block on the whole stream, and push deltas
  // through the dedicated browsa-subchat port (opened fresh for this
  // subId, see subChatPorts comment) as they arrive.
  (async () => {
    try {
      const onDelta = (delta) => {
        const posted = subChatPorts.has(subId);
        if (!posted) console.warn('[subchat][bg]', subId, 'delta arrived but NO PORT registered — dropped:', delta.slice(0, 40));
        pushSubChatChunk(subId, { type: 'SUBCHAT_CHUNK', subId, delta });
      };
      const common = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: resolveChatModel(provider, all) || undefined,
        onDelta,
        signal: controller.signal,
        temperature,
        maxTokens,
        // Per-model reasoning fields — same auto-adaptation as the main chat
        // (lib/reasoning-levels.js), null = send nothing.
        reasoning: reasoningFieldsFor({ provider, modelId: resolveChatModel(provider, all) || undefined, apiStyle }),
        // Reasoning providers: the detail thread shows the same live
        // <thinking> collapsible as the main chat (makeStreamRenderer's
        // splitThink). Default-omit would leave the card's reasoning models
        // with a bare blinking cursor.
        thinking: 'inline',
      };
      let st;
      if (provider.isOpencode) {
        // Detail thread over the opencode server: a dedicated server session
        // per thread keeps the side Q&A out of the main agent session. The
        // panel's scoped context (quoted excerpt + question) rides inside
        // the single prompt text; the agent runs its own pipeline, so
        // capabilityHints are not forwarded.
        let subSessionId = subchatOpencodeSessions.get(subId);
        const subOpencodeNewSession = !subSessionId;
        if (!subSessionId) {
          subSessionId = await createOpencodeSession({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
          setBounded(subchatOpencodeSessions, subId, subSessionId);
        }
        let subText = turnMessages.length === 1 && typeof turnMessages[0].content === 'string'
          ? turnMessages[0].content
          : turnMessages.map((m) => `${m.role === 'user' ? '[用户]' : '[助手]'} ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`).join('\n\n');
        // First turn of the thread carries the live-render fence vocabulary
        // (opencode never sees CAPABILITY_HINTS).
        subText = withAgentRenderHints(subText, subOpencodeNewSession);
        st = await opencodeStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          sessionId: subSessionId,
          text: subText,
          images: turnImages,
          onDelta,
          onToolProgress: (text) => pushSubChatChunk(subId, { type: 'SUBCHAT_TOOL_PROGRESS', subId, text }),
          onApproval: (data) => {
            subchatPendingApprovals.set(subId, agentPendingEntry('opencode', 'approval', { baseUrl: provider.baseUrl, apiKey: provider.apiKey, sessionId: subSessionId }, data));
            pushSubChatChunk(subId, { type: 'SUBCHAT_APPROVAL', subId, data });
          },
          onClarify: (data) => {
            subchatPendingClarifications.set(subId, agentPendingEntry('opencode', 'clarify', { baseUrl: provider.baseUrl, apiKey: provider.apiKey, sessionId: subSessionId }, data));
            pushSubChatChunk(subId, { type: 'SUBCHAT_CLARIFY', subId, data });
          },
          signal: controller.signal,
        });
      } else if (provider.isBridge) {
        // Detail thread over the bridge: one agent thread per subId, created
        // lazily on the first send (the id arrives on the SSE start event).
        // The panel's scoped context rides inside the prompt text; the agent
        // runs its own pipeline, so capabilityHints are not forwarded.
        // Same endpoint resolution as the main chat: the bridge card's
        // models slot holds endpoint URLs, activeModel picks one — resolved
        // once above (subBridgeUrl) for both the stream and the reply stamp.
        let subSessionId = subchatBridgeSessions.get(subId);
        const subBridgeNewThread = !subSessionId;
        let subText = turnMessages.length === 1 && typeof turnMessages[0].content === 'string'
          ? turnMessages[0].content
          : turnMessages.map((m) => `${m.role === 'user' ? '[用户]' : '[助手]'} ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`).join('\n\n');
        subText = withAgentRenderHints(subText, subBridgeNewThread);
        st = await bridgeStream({
          baseUrl: subBridgeUrl,
          apiKey: resolveBridgeApiKey(provider, subBridgeUrl),
          sessionId: subSessionId,
          text: subText,
          images: turnImages,
          onDelta,
          onToolProgress: (text) => pushSubChatChunk(subId, { type: 'SUBCHAT_TOOL_PROGRESS', subId, text }),
          onApproval: (data) => {
            subchatPendingApprovals.set(subId, agentPendingEntry('bridge', 'approval', { baseUrl: subBridgeUrl, apiKey: resolveBridgeApiKey(provider, subBridgeUrl) }, data));
            pushSubChatChunk(subId, { type: 'SUBCHAT_APPROVAL', subId, data });
          },
          signal: controller.signal,
          onSessionId: (sid) => setBounded(subchatBridgeSessions, subId, sid),
        });
      } else if (provider.isSquilla) {
        // Detail thread over the OpenSquilla gateway: a dedicated gateway
        // session per thread keeps the side Q&A out of the main gateway
        // session — the same isolation rule that keeps subchat off the
        // Hermes runs path. The key is gateway-assigned (sessions.create);
        // the in-memory map only spans this SW lifetime, so a SW restart
        // mid-thread simply starts a fresh session (threads are short-lived).
        // The scoped context the panel built rides inside the message; the
        // gateway has no system-prompt channel, so capabilityHints are not
        // forwarded (the agent runs its own pipeline). Pasted images are
        // deliberately NOT forwarded either — the squilla attachment contract
        // keeps pasted images browsa-side (same as the main chat's squilla
        // branch); turnImages are ignored here.
        let subSessionKey = subchatSessionKeys.get(subId);
        const subSquillaNewSession = !subSessionKey;
        if (!subSessionKey) {
          subSessionKey = await createSquillaSession({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
          setBounded(subchatSessionKeys, subId, subSessionKey);
        }
        let subMessage = turnMessages.length === 1 && typeof turnMessages[0].content === 'string'
          ? turnMessages[0].content
          : turnMessages.map((m) => `${m.role === 'user' ? '[用户]' : '[助手]'} ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`).join('\n\n');
        // First turn carries the live-render fence vocabulary (parity with
        // opencode/bridge; the hint postdates the original integration).
        subMessage = withAgentRenderHints(subMessage, subSquillaNewSession);
        st = await squillaStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          message: subMessage,
          sessionKey: subSessionKey,
          onDelta,
          signal: controller.signal,
        });
      } else if (provider.isHermes) {
        // Detail thread over Hermes /v1/runs — the SAME channel the main chat
        // uses, with a DEDICATED session per subId (never the main chat's
        // storage-backed hermesSessionId). The wrapped first-turn prompt
        // (quote + question) is the LAST user message in subMessages and
        // becomes `input`; prior turns ride as conversation_history — the
        // main chat's own shape, which keeps the thread self-healing across
        // SW restarts even though the session map is in-memory.
        let subSessionId = subchatHermesSessions.get(subId);
        if (!subSessionId) {
          subSessionId = crypto.randomUUID();
          setBounded(subchatHermesSessions, subId, subSessionId);
        }
        const lastTurn = turnMessages[turnMessages.length - 1];
        // Hermes gates dangerous tools behind approval/clarify on runs —
        // same wiring as the main chat's onApproval/onClarify, but stored
        // under subId and pushed as SUBCHAT_* chunks (the card renders its
        // own cards; SUBCHAT_APPROVAL_RESPOND relays the reply).
        const onApproval = (data) => {
          subchatPendingApprovals.set(subId, agentPendingEntry('hermes', 'approval', { baseUrl: provider.baseUrl, apiKey: provider.apiKey }, data));
          pushSubChatChunk(subId, { type: 'SUBCHAT_APPROVAL', subId, data });
        };
        const onClarify = (data) => {
          subchatPendingClarifications.set(subId, agentPendingEntry('hermes', 'clarify', { baseUrl: provider.baseUrl, apiKey: provider.apiKey }, data));
          pushSubChatChunk(subId, { type: 'SUBCHAT_CLARIFY', subId, data });
        };
        // 主聊天同一构造器（message-builder buildHermesTurn）：带图轮的 input
        // 变 text/image_url 部件数组（runs 严格层规范形），无图轮保持字符串。
        const { input, conversationHistory } = buildHermesTurn(
          { userText: typeof lastTurn?.content === 'string' ? lastTurn.content : '', images: turnImages },
          turnMessages.slice(0, -1)
        );
        st = await runsApiStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          input,
          instructions: sysPrompt || undefined,
          conversationHistory,
          sessionId: subSessionId,
          onDelta,
          onToolProgress: (text) => pushSubChatChunk(subId, { type: 'SUBCHAT_TOOL_PROGRESS', subId, text }),
          onApproval,
          onClarify,
          signal: controller.signal,
          temperature,
          maxTokens,
          onRunId: (runId) => setBounded(subChatRunIds, subId, { runId, baseUrl: provider.baseUrl, apiKey: provider.apiKey }),
        });
      } else {
        // LLM styles（chat/responses/anthropic）：主聊天同一批构造器
        // （message-builder）——带图轮的当前条目按各 API 方言变多模态 content
        // （image_url / input_image / base64 image 块），无图轮输出与旧手写
        // 映射逐字节一致。
        const lastTurn = turnMessages[turnMessages.length - 1];
        const lastText = typeof lastTurn?.content === 'string' ? lastTurn.content : '';
        const prior = turnMessages.slice(0, -1);
        st = await dispatchStyleStream({
          apiStyle,
          common,
          system: sysPrompt || undefined,
          responsesInput: buildResponsesInput({ userText: lastText, images: turnImages }, prior),
          anthropicMessages: buildAnthropicMessages({ userText: lastText, images: turnImages }, prior),
          chatMessages: buildMessages({ history: prior, userText: lastText, userImages: turnImages, systemPrompt: sysPrompt || undefined }),
        });
      }
      console.log('[subchat][bg]', subId, 'stream done, port still registered?', subChatPorts.has(subId));
      // usage rides DONE when the channel provided it (runs: input/output_tokens;
      // chat/responses/anthropic: prompt/completion_tokens) — the card renders
      // the same token-usage chip as the main panel's DONE.
      pushSubChatChunk(subId, { type: 'SUBCHAT_DONE', subId, providerLabel, providerKey, ...(st.finishReason === 'length' ? { truncated: true } : {}), ...(st.usage ? { usage: st.usage } : {}) });
    } catch (e) {
      console.error('[subchat][bg]', subId, 'stream threw', e);
      if (e?.name !== 'AbortError') {
        pushSubChatChunk(subId, { type: 'SUBCHAT_ERROR', subId, message: e?.message || String(e) });
      }
    } finally {
      subChatControllers.delete(subId);
      subChatRunIds.delete(subId);
      subchatPendingApprovals.delete(subId);
      subchatPendingClarifications.delete(subId);
    }
  })();
  return { started: true };
}

export function handleSubchatAbort(msg) {
  const c = subChatControllers.get(msg.subId);
  if (c) {
    try { c.abort('user-cancel'); } catch (_) {}
    subChatControllers.delete(msg.subId);
  }
  // Hermes runs: also stop the server-side agent so a stopped follow-up
  // doesn't keep executing tools headless — same /stop route the main chat's
  // ABORT case fires. Fire-and-forget; the runId entry may already be gone
  // (stream finished first), in which case this is a no-op.
  const runInfo = subChatRunIds.get(msg.subId);
  if (runInfo) {
    // /stop 的 fetch 唯一实现在 agent-stream-session.js（C4：此前手写三份）。
    stopHermesRun(runInfo);
    subChatRunIds.delete(msg.subId);
  }
  // An abort also orphans any pending approval/clarification — the agent is
  // being stopped, so no reply will ever be relayed.
  subchatPendingApprovals.delete(msg.subId);
  subchatPendingClarifications.delete(msg.subId);
  return { aborted: !!c };
}

/**
 * Relay the user's approval-card choice back to the agent, subId-keyed twin
 * of background.js's APPROVAL_RESPOND (per-kind shapes identical).
 */
export async function handleSubchatApprovalRespond(msg) {
  const pending = subchatPendingApprovals.get(msg.subId);
  if (!pending) return { ok: false, error: 'no pending subchat approval' };
  try {
    return await relayApproval(pending, msg.choice);
  } catch (e) {
    return { ok: false, error: e?.message };
  } finally {
    subchatPendingApprovals.delete(msg.subId);
  }
}

/**
 * Relay the user's clarification answer back to the agent, subId-keyed twin
 * of background.js's CLARIFY_RESPOND.
 */
export async function handleSubchatClarifyRespond(msg) {
  const pending = subchatPendingClarifications.get(msg.subId);
  if (!pending) return { ok: false, error: 'no pending subchat clarification' };
  try {
    return await relayClarify(pending, msg.response);
  } catch (e) {
    return { ok: false, error: e?.message };
  } finally {
    subchatPendingClarifications.delete(msg.subId);
  }
}
