// lib/handlers/subchat-handler.js — body of background.js's `case 'SUBCHAT'`
// and `case 'SUBCHAT_ABORT'`, extracted verbatim (Phase 2 of the
// sidepanel/background modularization refactor). handle() in background.js
// delegates here.

import * as storage from '../storage.js';
import { dispatchStyleStream } from './stream-dispatch.js';
import { runsApiStream } from '../llm-client.js';
import { opencodeStream, createOpencodeSession, respondOpencodePermission, respondOpencodeQuestion } from '../opencode-client.js';
import { bridgeStream, respondBridgeApproval } from '../bridge-client.js';
import { subChatControllers, subChatPorts, pushSubChatChunk } from '../state.js';
import { resolveProvider, resolveInferenceParams, resolveChatModel, resolveBridgeEndpoint, resolveBridgeApiKey, resolveReplyModelOrEndpoint } from './provider-resolver.js';
import { providerEntryLabel } from '../provider-display.js';
import { buildRunsConversationHistory } from './chat-handler.js';

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
  // `messages` (chat/completions) is the flat [{role, content}] array.
  const messages = [{ role: 'system', content: capabilityHints }, ...userMessages];
  // For responses/anthropic, split the leading system message out of the
  // turn array into the API's dedicated system field (instructions/system).
  const sysPrompt = capabilityHints;
  const turnMessages = userMessages; // [{role:'user'|'assistant', content}] as supplied
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
        if (!subSessionId) {
          subSessionId = await createOpencodeSession({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
          setBounded(subchatOpencodeSessions, subId, subSessionId);
        }
        const subText = turnMessages.length === 1 && typeof turnMessages[0].content === 'string'
          ? turnMessages[0].content
          : turnMessages.map((m) => `${m.role === 'user' ? '[用户]' : '[助手]'} ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`).join('\n\n');
        st = await opencodeStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          sessionId: subSessionId,
          text: subText,
          onDelta,
          onToolProgress: (text) => pushSubChatChunk(subId, { type: 'SUBCHAT_TOOL_PROGRESS', subId, text }),
          onApproval: (data) => {
            subchatPendingApprovals.set(subId, {
              kind: 'opencode',
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              sessionId: subSessionId,
              requestId: data.requestId || '',
            });
            pushSubChatChunk(subId, { type: 'SUBCHAT_APPROVAL', subId, data });
          },
          onClarify: (data) => {
            subchatPendingClarifications.set(subId, {
              kind: 'opencode',
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              sessionId: subSessionId,
              requestId: data.requestId || '',
            });
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
        const subText = turnMessages.length === 1 && typeof turnMessages[0].content === 'string'
          ? turnMessages[0].content
          : turnMessages.map((m) => `${m.role === 'user' ? '[用户]' : '[助手]'} ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`).join('\n\n');
        st = await bridgeStream({
          baseUrl: subBridgeUrl,
          apiKey: resolveBridgeApiKey(provider, subBridgeUrl),
          sessionId: subSessionId,
          text: subText,
          onDelta,
          onToolProgress: (text) => pushSubChatChunk(subId, { type: 'SUBCHAT_TOOL_PROGRESS', subId, text }),
          onApproval: (data) => {
            subchatPendingApprovals.set(subId, {
              kind: 'bridge',
              baseUrl: subBridgeUrl,
              apiKey: resolveBridgeApiKey(provider, subBridgeUrl),
              requestId: data.requestId || '',
            });
            pushSubChatChunk(subId, { type: 'SUBCHAT_APPROVAL', subId, data });
          },
          signal: controller.signal,
          onSessionId: (sid) => setBounded(subchatBridgeSessions, subId, sid),
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
          subchatPendingApprovals.set(subId, {
            runId: data.runId || data.run_id || '',
            approvalId: data.approval_id || data.approvalId || '',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          });
          pushSubChatChunk(subId, { type: 'SUBCHAT_APPROVAL', subId, data });
        };
        const onClarify = (data) => {
          subchatPendingClarifications.set(subId, {
            runId: data.runId || data.run_id || '',
            clarifyId: data.clarify_id || data.clarifyId || '',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          });
          pushSubChatChunk(subId, { type: 'SUBCHAT_CLARIFY', subId, data });
        };
        st = await runsApiStream({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          input: String(lastTurn?.content || ''),
          instructions: sysPrompt || undefined,
          conversationHistory: buildRunsConversationHistory(turnMessages.slice(0, -1)),
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
        st = await dispatchStyleStream({
          apiStyle,
          common,
          system: sysPrompt || undefined,
          responsesInput: turnMessages.map((m) => ({ role: m.role, content: m.content })),
          anthropicMessages: turnMessages.map((m) => ({ role: m.role, content: m.content })),
          chatMessages: messages,
        });
      }
      console.log('[subchat][bg]', subId, 'stream done, port still registered?', subChatPorts.has(subId));
      pushSubChatChunk(subId, { type: 'SUBCHAT_DONE', subId, providerLabel, providerKey, ...(st.finishReason === 'length' ? { truncated: true } : {}) });
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
    const stopHeaders = { 'Content-Type': 'application/json' };
    if (runInfo.apiKey) stopHeaders['Authorization'] = `Bearer ${runInfo.apiKey}`;
    fetch(`${runInfo.baseUrl}/v1/runs/${encodeURIComponent(runInfo.runId)}/stop`, { method: 'POST', headers: stopHeaders }).catch(() => {});
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
    if (pending.kind === 'bridge') {
      await respondBridgeApproval({
        baseUrl: pending.baseUrl,
        apiKey: pending.apiKey,
        requestId: pending.requestId,
        choice: msg.choice,
      });
      return { ok: true };
    }
    if (pending.kind === 'opencode') {
      await respondOpencodePermission({
        baseUrl: pending.baseUrl,
        apiKey: pending.apiKey,
        sessionId: pending.sessionId,
        requestId: pending.requestId,
        reply: msg.choice === 'deny' ? 'reject' : (msg.choice === 'always' ? 'always' : 'once'),
      });
      return { ok: true };
    }
    const res = await fetch(
      `${pending.baseUrl}/v1/runs/${encodeURIComponent(pending.runId)}/approval`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(pending.apiKey ? { Authorization: `Bearer ${pending.apiKey}` } : {}),
        },
        body: JSON.stringify({ approval_id: pending.approvalId, choice: msg.choice }),
      },
    );
    return { ok: res.ok };
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
    if (pending.kind === 'opencode') {
      await respondOpencodeQuestion({
        baseUrl: pending.baseUrl,
        apiKey: pending.apiKey,
        sessionId: pending.sessionId,
        requestId: pending.requestId,
        answers: [[String(msg.response ?? '')]],
      });
      return { ok: true };
    }
    const res = await fetch(
      `${pending.baseUrl}/v1/runs/${encodeURIComponent(pending.runId)}/clarifications/${encodeURIComponent(pending.clarifyId)}/respond`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(pending.apiKey ? { Authorization: `Bearer ${pending.apiKey}` } : {}),
        },
        body: JSON.stringify({ response: String(msg.response ?? '') }),
      },
    );
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e?.message };
  } finally {
    subchatPendingClarifications.delete(msg.subId);
  }
}
