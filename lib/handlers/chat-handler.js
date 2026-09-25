// lib/handlers/chat-handler.js — body of background.js's `case 'CHAT'`,
// extracted verbatim (Phase 2 of the sidepanel/background modularization
// refactor). handle() in background.js delegates here.

import { buildEffectiveSystemPrompt } from '../prompt-assembly.js';
import * as storage from '../storage.js';
import { runsApiStream } from '../llm-client.js';
import { dispatchStyleStream } from './stream-dispatch.js';
import { createTurnRequest } from './turn-request.js';
import { opencodeStream } from '../opencode-client.js';
import { bridgeStream } from '../bridge-client.js';
import { squillaStream } from '../squilla-client.js';
import { pickTurnImages } from '../image-budget.js';
import { providerEntryLabel } from '../provider-display.js';
import { buildMessages, ageStaleAttachments, stubOversizedAttachments } from '../message-builder.js';
import { resolveProvider, resolveInferenceParams, resolveChatModel, resolveBridgeApiKey, resolveReplyModelOrEndpoint } from './provider-resolver.js';
import { reasoningFieldsFor } from '../reasoning-levels.js';
import { markImagesSeenInHistory } from './history-compactor.js';
import {
  streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  pushChunk, initStreamState, appendToStreamState, clearStreamState,
  STREAM_KEEPALIVE_ALARM
} from '../state.js';

// llms.txt cache: origin → { content: string|null, fetchedAt: number }
// Persists across message handling within a SW lifetime (not durable).
// Exported for tests (cache clearing between cases).
export const llmsTxtCache = new Map();

// Recognizes "this request no longer fits the model's context window" across
// providers, for the one-shot overflow self-rescue in handleChat's retry loop
// (stub oversized attachments, retry once). Real wordings this must match:
//   Hermes:    "This conversation has grown too long for deepseek-flash to
//               read, and Hermes couldn't shrink it enough automatically."
//   OpenAI:    "This model's maximum context length is 16385 tokens. However,
//               your messages resulted in 24500 tokens."
//   Anthropic: "prompt is too long: 357005 tokens > 200000 maximum"
//   Ark-ish:   "...input length exceeds the model's context..." / 输入过长
// Exported for tests.
export function isContextOverflowError(message) {
  const s = String(message || '');
  if (!s) return false;
  return /context[_ ]?(length|window|limit)|context_length_exceeded|maximum context|context length|prompt is too long|grown too long|too many (input )?tokens|request too large|length.{0,12}exceed|输入.{0,8}过长|长度.{0,8}(超|限制)|上下文.{0,12}(超|限|过长|太长)/i.test(s);
}
const LLMS_TXT_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Origins never revisited would otherwise sit in the map forever (the TTL only
// triggers a refetch on a later lookup for the SAME origin). Bound the map so a
// long browsing session can't grow it without limit; oldest-evicted.
const LLMS_TXT_MAX_ORIGINS = 200;
function llmsTxtCacheSet(origin, value) {
  if (llmsTxtCache.has(origin)) llmsTxtCache.delete(origin); // refresh recency
  llmsTxtCache.set(origin, value);
  while (llmsTxtCache.size > LLMS_TXT_MAX_ORIGINS) {
    llmsTxtCache.delete(llmsTxtCache.keys().next().value);
  }
}

// Exported for direct testing — handleChat itself needs a fuller
// chrome.storage.local mock than most of this suite sets up, but this
// helper's cache/TTL/8KB-cap/error-handling behavior is worth testing on
// its own.
export async function fetchLlmsTxt(tabUrl) {
  if (!tabUrl) return null;
  let origin;
  try { origin = new URL(tabUrl).origin; } catch (_) { return null; }
  const cached = llmsTxtCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < LLMS_TXT_TTL_MS) return cached.content;
  try {
    const res = await fetch(`${origin}/llms.txt`, {
      signal: AbortSignal.timeout(3000),
      headers: { 'Accept': 'text/plain' }
    });
    if (!res.ok) { llmsTxtCache.set(origin, { content: null, fetchedAt: Date.now() }); return null; }
    // Reject HTML responses: many sites (e.g. x.com) don't publish a real
    // llms.txt and serve their SPA index.html with HTTP 200 + Content-Type
    // text/html instead. Treating that as "site instructions" injected a whole
    // HTML page (hundreds of KB of tags) into the page context — pure token
    // waste and noise. Only accept genuinely text-ish bodies (text/*, or a
    // missing Content-Type where the body doesn't start with '<').
    const ctype = (res.headers?.get && res.headers.get('content-type')) || '';
    if (/html/i.test(ctype)) {
      llmsTxtCacheSet(origin, { content: null, fetchedAt: Date.now() });
      return null;
    }
    const text = (await res.text()).trim().slice(0, 8000); // cap at 8 KB
    // No Content-Type header: heuristic — a real llms.txt is markdown/plain
    // text, so an HTML-looking body is still rejected.
    if (!ctype && /^\s*</.test(text)) {
      llmsTxtCacheSet(origin, { content: null, fetchedAt: Date.now() });
      return null;
    }
    llmsTxtCacheSet(origin, { content: text || null, fetchedAt: Date.now() });
    return text || null;
  } catch (_) {
    llmsTxtCacheSet(origin, { content: null, fetchedAt: Date.now() });
    return null;
  }
}

// 请求形状 builders 已搬 lib/message-builder.js（C9）。re-export 保住既有
// 测试的 import 面（chat-handler-internals 从本模块取这些纯函数）。
import { buildRunsConversationHistory, buildHermesTurn, buildResponsesInput, buildAnthropicMessages, buildTimestampRewriteHistory, buildSquillaTurn } from '../message-builder.js';
export { buildRunsConversationHistory, buildHermesTurn, buildResponsesInput, buildAnthropicMessages, buildTimestampRewriteHistory, buildSquillaTurn };

// Fire-and-forget server-side stop for an in-flight Hermes run. Used when an
// abort originates INSIDE this handler (idle timeout) — user cancels go
// through STREAM_ABORT, which stops the run itself and deletes the
// activeRunIds entry, so a leftover entry here means the server hasn't been
// told yet. All errors are swallowed: cleanup must never fail the turn.
// stopHermesRun / agentPendingEntry 收拢到 agent-stream-session.js（C4）；
// re-export 保住既有 import 面。
import { stopHermesRun, agentPendingEntry } from './agent-stream-session.js';
export { stopHermesRun };


/** Stream a chat turn. `capabilityHints`/`choiceRequestHint` are background.js's shared system-prompt constants. */
/**
 * Persist a turn entry where the turn's conversation LIVES (2026-09-24,
 * session-switch background streams): the live history while the panel is
 * watching this stream (`bg` false — onSend or re-attached after a switch
 * back), the ORIGIN session's snapshot once the stream went to the background
 * (the user switched conversations mid-turn). Falls back to the live append
 * when the origin session is gone (deleted since). Exported for tests.
 */
export async function persistTurnEntry(tabId, entry) {
  const st = streamState.get(tabId);
  const origin = st?.originSessionId || '';
  if (st?.bg && origin) {
    const saved = await storage.appendToSessionHistory(origin, entry);
    if (saved) return;
  }
  await storage.appendToHistory(entry);
}

export async function handleChat(msg, capabilityHints, choiceRequestHint) {
  // Page context is NOT extracted here — the user explicitly attaches it via
  // ATTACH_PAGE before asking questions. History is now global (single
  // session across all tabs).
  const all = await storage.getAll();
  const provider = resolveProvider(all);

  // Cap the images forwarded this turn (neutral budget, lib/image-budget.js —
  // same limits the fixed agent providers apply). Without this the stateless
  // LLM legs pushed an unbounded image array straight into the request body,
  // so a large paste could 4xx the turn or blow the provider context. Extras
  // are dropped, and the model gets a note so it knows images were omitted.
  // Done here (once, before any leg builds its request or persists the turn)
  // so every downstream consumer sees the same capped list.
  if (msg.images?.length) {
    const picked = pickTurnImages(msg.images);
    if (picked.dropped) {
      msg.userText = (msg.userText || '') + `\n\n（注：另有 ${picked.dropped} 张图片因超出单条消息大小上限未能随附。）`;
    }
    msg.images = picked.images;
  }

  const tabId = msg.tabId;
  if (tabId == null) throw new Error('tabId required');

  // Load global history early - needed both to detect a video page-context
  // (for the video-note prompt hint below) and to build conversation messages.
  const history = await storage.getHistory();

  // Whether this turn involved any images (pasted now, or already in history).
  // Gates the post-turn history image compaction (see end of handleChat) so we
  // don't do a storage read on every image-less turn.
  const mayHaveImages = !!(msg.images?.length) ||
    history.some(m => Array.isArray(m?.content) && m.content.some(p => p?.type === 'image_url'));

  // Detect the most recent video page-context in history (stamped on the
  // user message by ATTACH_PAGE). Drives the videoSrc stamp on the stored
  // assistant turn + DONE chunk so the side panel can turn [mm:ss] markers
  // into clickable in-place seek links. (The video-note formatting
  // instruction used to live in the system prompt here — it is now baked into
  // the video page-context text at attach time, see withVideoNote in
  // background.js — so the system prompt stays a byte-stable prefix.)
  let videoSrc = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].videoSrc) { videoSrc = history[i].videoSrc; break; }
  }

  // Context aging (send-time only): attach blocks that have gone cold (a
  // newer attach exists, >=3 user turns behind it, >=8000 chars) become
  // one-line stubs, so big sessions stop re-sending every old page context
  // on every turn. Storage and the raw `history` stay untouched — the UI
  // and the timestamp-rewrite pass still read the full text.
  const sendHistory = ageStaleAttachments(history);

  // Build effective system prompt: base + language + capability hints.
  // llms.txt is deliberately NOT injected here anymore — it used to be fetched
  // from the currently-active tab on EVERY turn and appended to this prefix,
  // which (a) broke KV/prompt prefix caching whenever the tab's origin changed
  // (the "dynamic system prompt" anti-pattern from ai-agent-book chapter 2)
  // and (b) could inject site instructions for a page the user never attached.
  // It is now fetched ONCE at attach time and baked into the stored
  // page-context text, keyed to the attached page's own URL — see
  // withSiteInstructions in background.js. The video-note formatting hint is
  // likewise baked into video page-contexts at attach time (withVideoNote).
  // 组装收拢到 lib/prompt-assembly.js（C5）：langMap 与「拼哪些块」此前散在
  // 本文件与 sidepanel 的 /prompt 镜像里，且镜像缺两块（显示 ≠ 发送）。
  const effectiveSystemPrompt = buildEffectiveSystemPrompt(all, { capabilityHints, choiceRequestHint });

  // isHermes flag identifies Hermes providers (auto-detected via ping —
  // options.js probes run_submission/run_events_sse capabilities). When
  // true we always use Hermes's richer /v1/runs API (approval,
  // clarification, tool.started/tool.completed, visible thinking)
  // instead of plain /v1/chat/completions.
  // isHermes flag identifies Hermes providers (auto-detected via ping —
  // options.js probes run_submission/run_events_sse capabilities). When
  // true we always use Hermes's richer /v1/runs API (approval,
  // clarification, tool.started/tool.completed, visible thinking)
  // instead of plain /v1/chat/completions. opencode (`opencode serve`
  // headless HTTP server) and agent-bridge (user-run local daemon adapting
  // CLI agents — codex first — to the bridge's wire protocol v1,
  // github.com/xiaohuzai/agent-bridge) are session-scoped the same way:
  // browsa sends only the user's turn, the server keeps its own transcript.
  // The per-kind request-shape ladder (initial build + the overflow /
  // continuation / rewrite rebuilds below) lives ONCE in
  // lib/handlers/turn-request.js — before the 2026-09-20 deepening pass it
  // was hand-written four times here, and the passes that forgot a branch
  // silently resent the ORIGINAL request (see turn-request.js header).
  const turn = createTurnRequest({
    provider,
    activeProvider: all.activeProvider,
    all,
    msg,
    sendHistory,
    effectiveSystemPrompt,
  });
  await turn.prepare();
  const { kind } = turn;
  const apiStyle = kind; // stateless kinds are named by their wire style
  let extraHeaders = undefined;

  // Persist user turn to global history (include images if present)
  const userTurnContent = msg.images?.length
    ? [
        { type: 'text', text: msg.userText || '(no instruction)' },
        ...msg.images.map(url => ({ type: 'image_url', image_url: { url } }))
      ]
    : msg.userText || '(no instruction)';
  const userTurn = { role: 'user', content: userTurnContent };
  await storage.appendToHistory(userTurn);

  // Initialize stream state BEFORE the first onDelta. From this point
  // on, every delta both pushes to the port and accumulates into
  // streamState.acc — so a mid-stream tab switch (which kills the
  // port but not the LLM request) can be recovered via STREAM_PEEK.
  // Reply-source stamp: the same label the sidebar dropdown shows for this
  // selection (provider-display.js), carried on the stream state, the DONE
  // chunk, and the persisted assistant entry so every bubble can say who
  // replied. LLM cards stamp "alias · model"; bridge cards stamp the
  // selected endpoint's discovered agent alias; Hermes/opencode stamp bare.
  const replyModelOrEndpoint = resolveReplyModelOrEndpoint(provider, all, turn.bridgeEndpoint);
  const providerLabel = providerEntryLabel(all.activeProvider, provider, replyModelOrEndpoint);
  const providerKey = { name: all.activeProvider, model: replyModelOrEndpoint };
  // originSessionId: the conversation this turn belongs to — if the user
  // switches sessions mid-turn the reply is written THERE (snapshot), never
  // into the conversation they switched to (see persistTurnEntry).
  initStreamState(tabId, { providerLabel, providerKey, originSessionId: msg.sessionId || '' });

  // Wire an AbortController so the side panel can actually cancel
  // the LLM fetch. Without this, Esc-to-cancel was visual-only —
  // the background kept streaming, a phantom assistant turn got
  // appended to history, and STREAM_RELEASE just hid it from PEEK.
  // Idle timeout: abort if no delta or tool-progress arrives for 5 min.
  // Resets on every output event so long agent tasks with many tool
  // calls never hit this accidentally — only truly stuck streams do.
  const controller = new AbortController();
  chatControllers.set(tabId, controller);
  // Panel-less keepalive: a 30s alarm that wakes (and thus keeps alive) the
  // service worker while this controller exists — a closed side panel used
  // to let the SW die mid-stream, losing the reply with its in-memory
  // state. Cleared by the alarm handler once no controllers remain.
  try { chrome.alarms.create(STREAM_KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (_) {}
  const IDLE_TIMEOUT_MS = 5 * 60_000;
  let idleTimer = setTimeout(() => controller.abort('idle-timeout'), IDLE_TIMEOUT_MS);
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort('idle-timeout'), IDLE_TIMEOUT_MS);
  };
  idleTimerResetters.set(tabId, resetIdleTimer);
  const signal = controller.signal;

  // Per-provider inference params
  const { temperature, maxTokens } = resolveInferenceParams(provider);

  // Stream with auto-retry on transient network / rate-limit errors
  let fullReply = '';
  let replyUsage = null;
  let replyTruncated = false;   // 末个 finish_reason === 'length'（输出被模型上限截断）
  const MAX_RETRIES = 2;
  // Context-overflow self-rescue state (see the catch block below): the stubbed
  // send happens once per turn; storage is rewritten only after the retried
  // turn succeeds, so a still-failing turn never destroys the raw attachment.
  let overflowRescued = false;
  let overflowStubbed = null;

  const doStream = async (opts = {}) => {
    // `opts.silent` (used by the auto timestamp-rewrite below) accumulates
    // deltas into streamState and keeps the idle timer alive, but does NOT
    // push CHUNK to the UI - the rewritten text is delivered wholesale as
    // the DONE chunk's `full`, which the side panel re-renders the bubble
    // from. This avoids a jarring mid-stream bubble wipe.
    const onDelta = opts.silent
      ? (delta) => { resetIdleTimer(); appendToStreamState(tabId, delta); }
      : (delta) => {
          resetIdleTimer();
          appendToStreamState(tabId, delta);
          pushChunk(tabId, { type: 'CHUNK', delta });
        };
    const onToolProgress = (text) => { resetIdleTimer(); pushChunk(tabId, { type: 'TOOL_PROGRESS', text }); };

    // Hermes gates dangerous tools (execute_code, terminal, ...) behind
    // an approval flow on BOTH /v1/runs and /v1/chat/completions — not
    // just /v1/runs. Wire onApproval/onClarify for both paths, or the
    // tool call just hangs waiting for a response that never comes.
    // run_id may arrive embedded in the event payload itself (chatStream)
    // or be injected by runsApiStream (which knows it from POST /v1/runs) —
    // check both the camelCase and snake_case field names.
    const onApproval = (data) => {
      pendingApprovals.set(tabId, agentPendingEntry('hermes', 'approval', { baseUrl: provider.baseUrl, apiKey: provider.apiKey }, data));
      pushChunk(tabId, { type: 'APPROVAL', data });
    };
    const onClarify = (data) => {
      pendingClarifications.set(tabId, agentPendingEntry('hermes', 'clarify', { baseUrl: provider.baseUrl, apiKey: provider.apiKey }, data));
      pushChunk(tabId, { type: 'CLARIFY', data });
    };
    // opencode permission/question requests carry the server-assigned
    // requestID (`per_…` / `que_…`) plus the session they belong to —
    // APPROVAL_RESPOND / CLARIFY_RESPOND relay through the opencode reply
    // endpoints when pending.kind === 'opencode'.
    const onApprovalOpencode = (data) => {
      pendingApprovals.set(tabId, agentPendingEntry('opencode', 'approval', { baseUrl: provider.baseUrl, apiKey: provider.apiKey, sessionId: turn.opencodeSessionId }, data));
      pushChunk(tabId, { type: 'APPROVAL', data });
    };
    const onClarifyOpencode = (data) => {
      pendingClarifications.set(tabId, agentPendingEntry('opencode', 'clarify', { baseUrl: provider.baseUrl, apiKey: provider.apiKey, sessionId: turn.opencodeSessionId }, data));
      pushChunk(tabId, { type: 'CLARIFY', data });
    };
    // bridge approval requests carry the bridge-side request id (codex's
    // JSON-RPC request id) — APPROVAL_RESPOND relays via POST /approvals/:id
    // when pending.kind === 'bridge'.
    const onApprovalBridge = (data) => {
      // 审批回复必须发回同一座桥、带同一把 key —— 按端点解析，不是卡级。
      pendingApprovals.set(tabId, agentPendingEntry('bridge', 'approval', {
        baseUrl: turn.bridgeEndpoint || provider.baseUrl,
        apiKey: resolveBridgeApiKey(provider, turn.bridgeEndpoint || provider.baseUrl),
      }, data));
      pushChunk(tabId, { type: 'APPROVAL', data });
    };

    if (kind === 'squilla') {
      // Abort is handled entirely inside squillaStream: the signal listener
      // sends chat.abort over the still-open WebSocket (closing the WS view
      // alone would NOT stop the server-side task) and then closes.
      return await squillaStream({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        message: turn.squillaMessage,
        sessionKey: turn.squillaSessionKey,
        attachments: turn.squillaAttachments,
        onDelta,
        onToolProgress,
        signal,
      });
    }
    if (kind === 'bridge') {
      return await bridgeStream({
        baseUrl: turn.bridgeEndpoint || provider.baseUrl,
        apiKey: resolveBridgeApiKey(provider, turn.bridgeEndpoint || provider.baseUrl),
        sessionId: turn.bridgeSessionId,
        text: turn.bridgeTurn,
        images: turn.bridgeImages,
        onDelta,
        onToolProgress,
        onApproval: onApprovalBridge,
        onSessionId: (sid) => {
          turn.bridgeSessionId = sid;
          storage.setBridgeSessionId(all.activeProvider, sid, turn.bridgeEndpoint);
        },
        onHeartbeat: resetIdleTimer,
        signal,
      });
    } else if (kind === 'opencode') {
      return await opencodeStream({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        sessionId: turn.opencodeSessionId,
        text: turn.opencodeTurn,
        images: turn.opencodeImages,
        onDelta,
        onToolProgress,
        onApproval: onApprovalOpencode,
        onClarify: onClarifyOpencode,
        signal,
      });
    } else if (kind === 'hermes') {
      const onRunId = (runId) => {
        activeRunIds.set(tabId, { runId, baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      };
      return await runsApiStream({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        input: turn.runsInput,
        instructions: effectiveSystemPrompt || undefined,
        conversationHistory: turn.runsConvHistory,
        sessionId: turn.hermesSessionId,
        onDelta,
        onToolProgress,
        onApproval,
        onClarify,
        onRunId,
        signal,
        temperature,
        maxTokens,
      });
    } else {
      // Stateless LLM legs (chat/responses/anthropic) share one dispatcher —
      // see lib/handlers/stream-dispatch.js. Tool/approval callbacks ride in
      // `common` and are simply ignored by the two protocols that don't use
      // them (only chatStream consumes them).
      return await dispatchStyleStream({
        apiStyle,
        common: {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: resolveChatModel(provider, all) || undefined,
          onToolProgress,
          onApproval,
          onClarify,
          signal,
          extraHeaders,
          temperature,
          maxTokens,
          // Per-model reasoning/thinking fields — auto from the model id
          // (lib/reasoning-levels.js), null = send nothing.
          reasoning: reasoningFieldsFor({ provider, modelId: resolveChatModel(provider, all) || undefined, apiStyle }),
          // Reasoning models on chat-completions/responses/anthropic endpoints:
          // surface their thinking as <thinking> blocks (same as the Hermes
          // runs path) instead of silently dropping it.
          thinking: 'inline',
        },
        onDelta,
        system: effectiveSystemPrompt || undefined,
        anthropicSystem: turn.anthropicSystem,
        responsesInput: turn.responsesInput,
        anthropicMessages: turn.anthropicMessages,
        chatMessages: turn.messages,
      });
    }
  };

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        // Reset stream state accumulator on retry so we don't double content
        if (attempt > 1) {
          const st = streamState.get(tabId);
          if (st) st.acc = '';
          fullReply = '';
          // Notify side panel about retry
          pushChunk(tabId, { type: 'RETRY', attempt, maxAttempts: MAX_RETRIES + 1 });
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        const result = await doStream();
        fullReply = result.full;
        replyUsage = result.usage || null;
        replyTruncated = result.finishReason === 'length';
        break; // success
      } catch (e) {
        if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) throw e;
        // Context-overflow self-rescue (one shot per turn). The request no
        // longer fits the model's window — almost always because a big
        // verbatim attachment rides in the resent history (real case: an
        // 18-page arXiv PDF ≈ 68K chars ≈ 35K tokens + 9 figures, on top of a
        // Hermes agent's own ~23K tokens of tool definitions), and the
        // provider's own shrink cannot remove what the client re-sends every
        // turn. Stub every oversized attach (image parts dropped — figures
        // alone can be ~15K tokens), rebuild the request shapes from the
        // stubbed history, and retry immediately. opencode/bridge are
        // excluded: their transcripts live server-side, so a smaller resent
        // prompt cannot shrink what the agent already stored.
        if (!overflowRescued && turn.overflowRescuable && isContextOverflowError(e?.message)) {
          overflowRescued = true;
          const { history: stubbedSendHistory, changed } = stubOversizedAttachments(sendHistory);
          if (changed.length) {
            turn.rebuildFrom(stubbedSendHistory);
            overflowStubbed = changed;
            // Drop any partial output from the failed attempt (same reset the
            // transient-retry path does) and tell the user what happened.
            const stOv = streamState.get(tabId);
            if (stOv) stOv.acc = '';
            fullReply = '';
            pushChunk(tabId, { type: 'TOOL_PROGRESS', text: '⚠️ 附件超出模型上下文窗口，已临时裁剪大附件并自动重试…' });
            attempt--; // the rescue must not consume the transient-retry ladder
            continue;
          }
        }
        // Only retry on network or rate-limit errors
        const isRetryable = e?.name === 'ProviderNetworkError' || (e?.name === 'ProviderAPIError' && e?.message?.includes('429'));
        if (!isRetryable || attempt > MAX_RETRIES) throw e;
      }
    }

    // Persist the overflow-rescue stubs now that the retried turn succeeded —
    // rewriting storage only on success means a still-failing turn never
    // destroys the raw attachment text (the user can still retry with a
    // bigger-window model and see the full attachment). attachId-keyed atomic
    // rewrite, same read-modify-write pattern as maybeSummarizeAttachment.
    if (overflowStubbed) {
      const stubs = overflowStubbed;
      overflowStubbed = null;
      await storage.mutateHistory((history) => {
        for (const { attachId, content } of stubs) {
          if (!attachId) continue;
          const idx = history.findIndex((m) => m.attachId === attachId);
          if (idx !== -1) history[idx] = { ...history[idx], content };
        }
        return history;
      });
    }

    // ---- Auto-continuation on output-cap truncation (finish_reason=length) ----
    // The reply hit the model's output token budget mid-sentence (real case
    // 2026-08-29: token-dense video notes with mermaid/LaTeX cut at 16K, mid
    // "[13:" timestamp). ONE silent continuation pass, the same pattern as the
    // timestamp rewrite below: the model sees its own partial + a continue
    // instruction, deltas are swallowed, and DONE.full = v1 + 续写 seamlessly
    // replaces the streamed bubble. One hop only (bounds cost/latency); if the
    // continuation ALSO hits the cap, replyTruncated stays true and the
    // sidepanel still shows the hint + 「→ 继续生成」 button. On abort/error we
    // keep v1 (a complete turn the user already saw stream in).
    if (replyTruncated && fullReply) {
      console.warn('[browsa] chat reply cut by output cap — one silent continuation pass');
      pushChunk(tabId, { type: 'TS_STATUS', text: '✍️ 回复被输出上限截断，正在自动续写…' });
      const contInstruction = 'Continue exactly from where your reply above was cut off. Do NOT repeat any content already written, do NOT add any preamble or transition — resume directly, mid-sentence if that is where it stopped.';
      // Rebuild the SAME request shape the original turn used — only the
      // chat-style `messages` was rebuilt here before the turn-request
      // pass, so responses/anthropic continuations silently resent the
      // ORIGINAL request (regenerating the same reply instead of continuing).
      turn.continueWith(contInstruction, fullReply);
      const _stCont = streamState.get(tabId);
      if (_stCont) _stCont.acc = '';
      try {
        const rc = await doStream({ silent: true });
        if (rc && rc.full) {
          fullReply = fullReply + rc.full;
          replyTruncated = rc.finishReason === 'length';
          if (_stCont) _stCont.acc = fullReply; // PEEK（切页签回来）看到合并后的全文
          const u1 = replyUsage, u2 = rc.usage;
          if (u1 && u2) {
            const mergedUsage = { ...u1 };
            for (const k of Object.keys(u2)) {
              if (typeof u2[k] === 'number' && typeof u1[k] === 'number') mergedUsage[k] = u1[k] + u2[k];
            }
            replyUsage = mergedUsage;
          } else if (u2) replyUsage = u2;
        }
      } catch (_) {
        // 续写失败保留 v1（用户已看到的完整一轮），依旧带截断提示。
      }
    }

    // ---- Auto timestamp rewrite (video notes) ----
    // If the user asked for video notes/summary but the model's reply has
    // no [mm:ss] timestamps, silently ask it ONCE to reformat with them.
    // Better UX than a manual "补时间戳" button: the user just gets
    // timestamped notes. The rewrite's deltas are swallowed (silent
    // doStream - not pushed to the UI); the rewritten text becomes the
    // DONE chunk's `full`, which the side panel re-renders the bubble
    // from, so v2 seamlessly replaces v1. On abort/error we keep v1
    // (a complete turn the user already saw stream in). Gated to actual
    // notes/summary requests so a specific question on a video page
    // (e.g. "作者是谁") isn't reformatted.
    // 与 render.js 的 linkifyTimestamps lockstep（2026-09-26）：lookbehind 排除
    // 贴名切片 name[0:23]；秒位 [0-5]\d 排除秒位>59 的独立切片（[0:80]）——
    // 两者都不算「已有时间戳」，否则视频页总结回复会被误判而跳过补写。
    const _TS_PRESENT_RE = /(?<![A-Za-z0-9_$\]\)])\[(?:\d+:)?\d{1,2}:[0-5]\d\]/;
    const _NOTES_REQUEST_RE = /总结|笔记|纪要|要点|大纲|概要|梳理|summary|summarize|notes?|outline|takeaways?|key points/i;
    if (videoSrc && !_TS_PRESENT_RE.test(fullReply) && _NOTES_REQUEST_RE.test(msg.userText || '') && fullReply.length > 50) {
      pushChunk(tabId, { type: 'TS_STATUS', text: '⏱ 正在补充时间戳…' });
      const rewriteInstruction = "The notes above are missing [mm:ss] timestamps. Reformat them: keep all content unchanged, but append each section's start time at the end of its heading as [mm:ss] (or [h:mm:ss] for videos over an hour), using the exact bracket form. Derive the times from the transcript in the context. Do not change any information.";
      // Rebuild the conversation so the model sees its own v1 + the ask.
      // Trimmed to the video attach entry + this turn + v1 (buildTimestampRewriteHistory)
      // — resending the whole session doubled the wall time on big contexts.
      const rewriteHistory = buildTimestampRewriteHistory(history, videoSrc, msg.userText || '', fullReply);
      turn.rewriteWith(rewriteInstruction, rewriteHistory);
      // Reset the stream-state accumulator so a mid-rewrite tab-switch
      // PEEK shows v2 (not v1+v2 concatenated).
      const _st = streamState.get(tabId);
      if (_st) _st.acc = '';
      try {
        const r2 = await doStream({ silent: true });
        if (r2 && r2.full) {
          fullReply = r2.full;
          if (r2.usage) replyUsage = r2.usage;
          replyTruncated = r2.finishReason === 'length';
        }
      } catch (e) {
        // Abort (user Esc) or transient error during the silent rewrite:
        // keep v1 and fall through to store + DONE v1. pushChunk(DONE) is
        // a safe no-op if the port was already disconnected by cancel.
        if (!(e?.name === 'AbortError' || /aborted/i.test(String(e?.message)))) {
          console.warn('[browsa] timestamp rewrite failed, keeping original reply:', e?.message || e);
        }
      }
    }
  } catch (e) {
    // Distinguish user-cancel from real errors. AbortError fires
    // when the side panel's cancelStream() called
    // STREAM_ABORT → controller.abort() → fetch threw. We must NOT
    // append a half-finished reply to history in that case.
    if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) {
      // If a Hermes run is still registered, the abort came from inside this
      // handler (idle timeout) — STREAM_ABORT has not run, so the server-side
      // agent is still executing tools and would burn tokens to nowhere.
      // Tell it to stop too (no-op entry missing; fire-safe).
      stopHermesRun(activeRunIds.get(tabId));
      // 收尸（2026-09-24）：已流出的文本以「已中断」落回来源会话——手动停止、
      // 空闲超时、网络断都不该让思考白费（此前一律静默丢弃，thinking 越久
      // 亏得越多）。显式弃置（clearChatHistory 发 abort('drop')）不收。
      // 写入路由同 DONE：后台流写来源会话快照。
      const st = streamState.get(tabId);
      const partial = String(st?.acc || '').trim();
      if (partial && signal?.reason !== 'drop') {
        try {
          await persistTurnEntry(tabId, { role: 'assistant', content: partial, interrupted: true, providerLabel, providerKey });
        } catch (err) {
          console.warn('[browsa] interrupted-turn salvage failed:', err?.message || err);
        }
      }
      // Tell the side panel it was a clean cancel so it can show
      // its "⚠ Stream cancelled" message and skip DONE.
      pushChunk(tabId, { type: 'ERROR', error: 'cancelled', code: 'ABORTED' });
      clearStreamState(tabId);
      return { ok: true, cancelled: true };
    }
    // Re-throw real errors so the generic onMessage handler can
    // wrap them with a hint (network / config / API).
    throw e;
  } finally {
    clearTimeout(idleTimer);
    idleTimerResetters.delete(tabId);
    chatControllers.delete(tabId);
    activeRunIds.delete(tabId);
    pendingApprovals.delete(tabId);
    pendingClarifications.delete(tabId);
  }

  // Parse CHOICE_REQUEST: agent may embed an interactive choice at the
  // end of its reply. Strip it from the stored text so history stays
  // clean, but forward the parsed data to the side panel so it can
  // render clickable buttons. Format (from personal_ai_assistant):
  //   CHOICE_REQUEST:{"question":"...","choices":["A","B"]}
  let choiceRequest = null;
  const choiceMatch = fullReply.match(/CHOICE_REQUEST:(\{[\s\S]*?\})\s*$/);
  if (choiceMatch) {
    try {
      choiceRequest = JSON.parse(choiceMatch[1]);
      fullReply = fullReply.slice(0, choiceMatch.index).trimEnd();
    } catch (_) { /* malformed JSON — leave as-is */ }
  }

  // Persist assistant turn — this is the durable source of truth.
  // (Only reached if the stream completed naturally, not via abort.)
  await persistTurnEntry(tabId, { role: 'assistant', content: fullReply, providerLabel, providerKey, ...(videoSrc ? { videoSrc } : {}) });

  if (replyTruncated) console.warn('[browsa] chat reply cut by model output cap (finish_reason=length) — surface hint to continue');
  pushChunk(tabId, { type: 'DONE', full: fullReply, choiceRequest, usage: replyUsage, videoSrc: videoSrc || null, providerLabel, providerKey, ...(replyTruncated ? { outputTruncated: true } : {}) });
  clearStreamState(tabId);
  // Now that the model has seen this turn's images, stamp IMAGE_SEEN_FLAG on
  // image-bearing entries so LATER requests send labeled text instead of the
  // pixels — storage keeps them (the bubble/transcript must keep showing what
  // was sent; request-side compaction lives in message-builder's
  // prepareHistoryForModel). Success-path only (abort/errors return above
  // before reaching here). Fire-safe: a failure never breaks the turn.
  if (mayHaveImages) {
    try { await markImagesSeenInHistory(); }
    catch (e) { console.warn('[browsa] history image-seen stamping failed:', e?.message || e); }
  }
  return { full: fullReply };
}
