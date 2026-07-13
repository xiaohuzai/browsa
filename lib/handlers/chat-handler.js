// lib/handlers/chat-handler.js — body of background.js's `case 'CHAT'`,
// extracted verbatim (Phase 2 of the sidepanel/background modularization
// refactor). handle() in background.js delegates here.

import * as storage from '../storage.js';
import { chatStream, runsApiStream, ProviderConfigError } from '../openai-client.js';
import { buildMessages } from '../page-extractor.js';
import {
  streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  pushChunk, initStreamState, appendToStreamState, clearStreamState
} from '../state.js';

// llms.txt cache: origin → { content: string|null, fetchedAt: number }
// Persists across message handling within a SW lifetime (not durable).
const llmsTxtCache = new Map();
const LLMS_TXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchLlmsTxt(tabUrl) {
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
    const text = (await res.text()).trim().slice(0, 8000); // cap at 8 KB
    llmsTxtCache.set(origin, { content: text || null, fetchedAt: Date.now() });
    return text || null;
  } catch (_) {
    llmsTxtCache.set(origin, { content: null, fetchedAt: Date.now() });
    return null;
  }
}

/** Stream a chat turn. `capabilityHints`/`choiceRequestHint` are background.js's shared system-prompt constants. */
export async function handleChat(msg, capabilityHints, choiceRequestHint) {
  // Page context is NOT extracted here — the user explicitly attaches it via
  // ATTACH_PAGE before asking questions. History is now global (single
  // session across all tabs).
  const all = await storage.getAll();
  const provider = all.providers[all.activeProvider];
  if (!provider) throw ProviderConfigError(`Provider "${all.activeProvider}" not configured`);
  if (!provider.baseUrl?.trim()) throw ProviderConfigError('Base URL is not set. Open Settings (⚙) and configure the provider.');

  const tabId = msg.tabId;
  if (tabId == null) throw new Error('tabId required');

  // Build effective system prompt: base + per-domain rule + llms.txt
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const tabUrl = tab?.url || '';
  const domainRules = all.domainRules || [];
  const matchedRule = domainRules.find(r => r.pattern && tabUrl.includes(r.pattern));
  const domainExtra = matchedRule?.prompt?.trim() || '';
  const llmsTxt = (all.llmsTxtEnabled !== false) && tabUrl ? await fetchLlmsTxt(tabUrl) : null;
  const llmsTxtExtra = llmsTxt
    ? `\n\n[Site instructions from ${(() => { try { return new URL(tabUrl).origin; } catch(_){return tabUrl;} })()}/llms.txt]\n${llmsTxt}`
    : '';
  const langMap = { en: 'Please always respond in English.', zh: '请始终用中文回答。', ja: '常に日本語で回答してください。', ko: '항상 한국어로 답변해 주세요.', de: 'Bitte antworte immer auf Deutsch.', fr: 'Veuillez toujours répondre en français.', es: 'Por favor, responde siempre en español.' };
  const langExtra = langMap[all.replyLanguage] || '';
  const effectiveSystemPrompt = [all.systemPrompt || '', domainExtra, llmsTxtExtra, langExtra, capabilityHints, choiceRequestHint]
    .map(s => s.trim()).filter(Boolean).join('\n\n');

  // Load global history
  const history = await storage.getHistory();

  // isHermes flag identifies Hermes providers (auto-detected via ping —
  // options.js probes run_submission/run_events_sse capabilities). When
  // true we always use Hermes's richer /v1/runs API (approval,
  // clarification, tool.started/tool.completed, visible thinking)
  // instead of plain /v1/chat/completions.
  const isHermes = !!(provider.isHermes);

  let messages = null;         // chatStream (stateless OpenAI-compatible)
  let runsInput = null;        // runsApiStream: current user message
  let runsConvHistory = null;  // runsApiStream: all prior turns
  let hermesSessionId = null;  // runsApiStream: X-Hermes-Session-Id / session_id
  let extraHeaders = undefined;

  if (isHermes) {
    hermesSessionId = await storage.getOrCreateHermesSessionId(all.activeProvider);
    // Build current-turn input (text + optional images)
    if (msg.images?.length) {
      const parts = [{ type: 'input_text', text: msg.userText || '' }];
      msg.images.forEach(url => parts.push({ type: 'input_image', image_url: url }));
      runsInput = [{ role: 'user', content: parts }];
    } else {
      runsInput = msg.userText || '';
    }
    // Build conversation history from local storage (all prior user+assistant turns).
    // Page-context messages (PAGE_CONTEXT_PREFIX) are included as-is so Hermes
    // receives the full context. Multimodal content in old turns is text-only.
    runsConvHistory = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        let content = m.content;
        if (Array.isArray(content)) {
          content = content
            .filter(p => p.type === 'text' || p.type === 'input_text')
            .map(p => p.text || '').join('') || '[multimodal message]';
        }
        return { role: m.role, content: String(content || '') };
      })
      .filter(m => m.content.trim());
  } else {
    // Standard stateless mode: send full history on every turn.
    messages = buildMessages({
      history,
      userText: msg.userText,
      pageContext: null,
      withImage: false,
      userImages: msg.images,
      systemPrompt: effectiveSystemPrompt
    });
  }

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
  initStreamState(tabId);

  // Wire an AbortController so the side panel can actually cancel
  // the LLM fetch. Without this, Esc-to-cancel was visual-only —
  // the background kept streaming, a phantom assistant turn got
  // appended to history, and STREAM_RELEASE just hid it from PEEK.
  // Idle timeout: abort if no delta or tool-progress arrives for 5 min.
  // Resets on every output event so long agent tasks with many tool
  // calls never hit this accidentally — only truly stuck streams do.
  const controller = new AbortController();
  chatControllers.set(tabId, controller);
  const IDLE_TIMEOUT_MS = 5 * 60_000;
  let idleTimer = setTimeout(() => controller.abort('idle-timeout'), IDLE_TIMEOUT_MS);
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort('idle-timeout'), IDLE_TIMEOUT_MS);
  };
  idleTimerResetters.set(tabId, resetIdleTimer);
  const signal = controller.signal;

  // Per-provider inference params
  const temperature = (provider.temperature != null && provider.temperature !== '') ? Number(provider.temperature) : undefined;
  const maxTokens = provider.maxTokens ? Number(provider.maxTokens) : 0;

  // Stream with auto-retry on transient network / rate-limit errors
  let fullReply = '';
  let replyUsage = null;
  const MAX_RETRIES = 2;

  const doStream = async () => {
    const onDelta = (delta) => {
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
      pendingApprovals.set(tabId, {
        runId: data.runId || data.run_id || '',
        approvalId: data.approval_id || data.approvalId || '',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      });
      pushChunk(tabId, { type: 'APPROVAL', data });
    };
    const onClarify = (data) => {
      pendingClarifications.set(tabId, {
        runId: data.runId || data.run_id || '',
        clarifyId: data.clarify_id || data.clarifyId || '',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      });
      pushChunk(tabId, { type: 'CLARIFY', data });
    };

    if (isHermes) {
      const onRunId = (runId) => {
        activeRunIds.set(tabId, { runId, baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      };
      return await runsApiStream({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        input: runsInput,
        instructions: effectiveSystemPrompt || undefined,
        conversationHistory: runsConvHistory,
        sessionId: hermesSessionId,
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
      return await chatStream({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model || undefined,
        messages,
        onDelta,
        onToolProgress,
        onApproval,
        onClarify,
        signal,
        extraHeaders,
        temperature,
        maxTokens,
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
        break; // success
      } catch (e) {
        if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) throw e;
        // Only retry on network or rate-limit errors
        const isRetryable = e?.name === 'ProviderNetworkError' || (e?.name === 'ProviderAPIError' && e?.message?.includes('429'));
        if (!isRetryable || attempt > MAX_RETRIES) throw e;
      }
    }
  } catch (e) {
    // Distinguish user-cancel from real errors. AbortError fires
    // when the side panel's cancelStream() called
    // STREAM_ABORT → controller.abort() → fetch threw. We must NOT
    // append a half-finished reply to history in that case.
    if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) {
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
  await storage.appendToHistory({ role: 'assistant', content: fullReply });

  pushChunk(tabId, { type: 'DONE', full: fullReply, choiceRequest, usage: replyUsage });
  clearStreamState(tabId);
  return { full: fullReply };
}
