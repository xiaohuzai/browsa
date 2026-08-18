// lib/handlers/chat-handler.js — body of background.js's `case 'CHAT'`,
// extracted verbatim (Phase 2 of the sidepanel/background modularization
// refactor). handle() in background.js delegates here.

import * as storage from '../storage.js';
import { chatStream, runsApiStream } from '../openai-client.js';
import { buildMessages } from '../message-builder.js';
import { resolveProvider, resolveInferenceParams } from './provider-resolver.js';
import { compactImagePartsInHistory } from './history-compactor.js';
import {
  streamState, chatControllers, idleTimerResetters,
  activeRunIds, pendingApprovals, pendingClarifications,
  pushChunk, initStreamState, appendToStreamState, clearStreamState
} from '../state.js';

// llms.txt cache: origin → { content: string|null, fetchedAt: number }
// Persists across message handling within a SW lifetime (not durable).
// Exported for tests (cache clearing between cases).
export const llmsTxtCache = new Map();
const LLMS_TXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
    const text = (await res.text()).trim().slice(0, 8000); // cap at 8 KB
    llmsTxtCache.set(origin, { content: text || null, fetchedAt: Date.now() });
    return text || null;
  } catch (_) {
    llmsTxtCache.set(origin, { content: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Build Hermes /v1/runs `conversation_history` from local-storage history.
 *
 * Preserves inline images: OpenAI-shape `image_url` blocks become Hermes
 * `input_image` parts, so attached page images (XHS / PDF figures /
 * screenshots) reach the model as native multimodal tokens instead of being
 * dropped. `text`/`input_text` parts normalize to `input_text`.
 *
 * This replaces an earlier text-only flatten. Verified against a live Hermes
 * endpoint: a red 1×1 PNG placed in conversation_history (as input_image) was
 * correctly identified by the model ("red"), while a no-image control was not
 * -- i.e. conversation_history images ARE processed. (Current-turn `input`
 * images, by contrast, route through Hermes's `vision_analyze` tool, which may
 * be unconfigured -- so history is the reliable path for page-context images.)
 *
 * Exported for direct unit testing (handleChat needs a heavier chrome.storage
 * mock than the suite provides; this pure helper does not).
 */
export function buildRunsConversationHistory(history) {
  return (history || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      let content = m.content;
      if (Array.isArray(content)) {
        const parts = [];
        for (const p of content) {
          if (p.type === 'text' || p.type === 'input_text') {
            if (p.text) parts.push({ type: 'input_text', text: p.text });
          } else if (p.type === 'image_url') {
            // OpenAI shape {image_url:{url}}; also accept the bare-string
            // {image_url:'...'} shape used by /v1/responses, defensively.
            const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
            if (url) parts.push({ type: 'input_image', image_url: url });
          }
        }
        content = parts.length ? parts : '';
      } else {
        content = String(content || '');
      }
      return { role: m.role, content };
    })
    .filter(m => {
      const c = m.content;
      if (typeof c === 'string') return c.trim().length > 0;
      return Array.isArray(c) && c.length > 0; // keep image-only turns
    });
}

/**
 * Build the `input` + `conversation_history` for a Hermes /v1/runs turn.
 *
 * Pasted images (msg.images) go directly into `input` as `input_image` parts
 * alongside the text, and `conversation_history` is just the built prior
 * history. The Hermes model reads current-turn input images natively on a
 * vision-capable server (verified live: a solid-color image and a bar-count
 * image were both read correctly on `/v1/runs` input, `/v1/chat/completions`,
 * and `/v1/responses`).
 *
 * History note: an earlier version routed pasted images into a SYNTHETIC
 * trailing `conversation_history` turn instead of `input`, to work around a
 * Hermes server whose `vision_analyze` tool pointed at a text-only model
 * (input images failed there, while history images were read as native tokens).
 * That workaround is no longer needed now that the server runs a vision-capable
 * model, and it split the user's text from its images (less semantically
 * correct). If a server's vision input is ever broken again, the symptom is the
 * model saying "my active model doesn't support image input" / "vision analysis
 * failed" - fix the server's model, not this code.
 *
 * Exported for direct unit testing (handleChat needs a heavier chrome.storage
 * mock than the suite provides).
 */
export function buildHermesTurn(msg, history) {
  const conversationHistory = buildRunsConversationHistory(history);
  if (msg?.images?.length) {
    const parts = [{ type: 'input_text', text: msg.userText || '' }];
    for (const url of msg.images) parts.push({ type: 'input_image', image_url: url });
    return { input: [{ role: 'user', content: parts }], conversationHistory };
  }
  return { input: msg?.userText || '', conversationHistory };
}

/** Stream a chat turn. `capabilityHints`/`choiceRequestHint` are background.js's shared system-prompt constants. */
export async function handleChat(msg, capabilityHints, choiceRequestHint) {
  // Page context is NOT extracted here — the user explicitly attaches it via
  // ATTACH_PAGE before asking questions. History is now global (single
  // session across all tabs).
  const all = await storage.getAll();
  const provider = resolveProvider(all);

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
  // user message by ATTACH_PAGE). Drives (a) a video-note prompt hint that
  // asks the model to emit [mm:ss] section markers, and (b) a videoSrc stamp
  // on the stored assistant turn + DONE chunk so the side panel can turn
  // those markers into clickable in-place seek links.
  let videoSrc = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].videoSrc) { videoSrc = history[i].videoSrc; break; }
  }
  const videoNoteHint = videoSrc
    ? 'The attached context includes a video transcript with [mm:ss] timestamps. When summarizing it as notes, organize the content into sections and append each section\'s start time at the end of its heading, formatted as [mm:ss] (use [h:mm:ss] for videos longer than an hour). Keep timestamps in this exact bracket form so they can be linked.'
    : '';

  // Build effective system prompt: base + llms.txt
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const tabUrl = tab?.url || '';
  const llmsTxt = (all.llmsTxtEnabled !== false) && tabUrl ? await fetchLlmsTxt(tabUrl) : null;
  const llmsTxtExtra = llmsTxt
    ? `\n\n[Site instructions from ${(() => { try { return new URL(tabUrl).origin; } catch(_){return tabUrl;} })()}/llms.txt]\n${llmsTxt}`
    : '';
  const langMap = { en: 'Please always respond in English.', zh: '请始终用中文回答。', ja: '常に日本語で回答してください。', ko: '항상 한국어로 답변해 주세요.', de: 'Bitte antworte immer auf Deutsch.', fr: 'Veuillez toujours répondre en français.', es: 'Por favor, responde siempre en español.' };
  const langExtra = langMap[all.replyLanguage] || '';
  const effectiveSystemPrompt = [all.systemPrompt || '', llmsTxtExtra, langExtra, capabilityHints, choiceRequestHint, videoNoteHint]
    .map(s => s.trim()).filter(Boolean).join('\n\n');

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
    // Pasted images go directly into `input` as input_image (read natively by
    // a vision-capable Hermes model); history images are preserved as
    // input_image by buildRunsConversationHistory. See buildHermesTurn.
    ({ input: runsInput, conversationHistory: runsConvHistory } = buildHermesTurn(msg, history));
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
  const { temperature, maxTokens } = resolveInferenceParams(provider);

  // Stream with auto-retry on transient network / rate-limit errors
  let fullReply = '';
  let replyUsage = null;
  const MAX_RETRIES = 2;

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
    const _TS_PRESENT_RE = /\[(?:\d+:)?\d{1,2}:\d{2}\]/;
    const _NOTES_REQUEST_RE = /总结|笔记|纪要|要点|大纲|概要|梳理|summary|summarize|notes?|outline|takeaways?|key points/i;
    if (videoSrc && !_TS_PRESENT_RE.test(fullReply) && _NOTES_REQUEST_RE.test(msg.userText || '') && fullReply.length > 50) {
      pushChunk(tabId, { type: 'TS_STATUS', text: '⏱ 正在补充时间戳…' });
      const rewriteInstruction = "The notes above are missing [mm:ss] timestamps. Reformat them: keep all content unchanged, but append each section's start time at the end of its heading as [mm:ss] (or [h:mm:ss] for videos over an hour), using the exact bracket form. Derive the times from the transcript in the context. Do not change any information.";
      // Rebuild the conversation so the model sees its own v1 + the ask.
      if (isHermes) {
        runsInput = rewriteInstruction;
        runsConvHistory = [
          ...runsConvHistory,
          { role: 'user', content: String(msg.userText || '') },
          { role: 'assistant', content: fullReply },
        ].filter(m => (m.content || '').toString().trim());
      } else {
        messages = buildMessages({
          history: [...history, { role: 'user', content: msg.userText || '' }, { role: 'assistant', content: fullReply }],
          userText: rewriteInstruction,
          pageContext: null,
          withImage: false,
          userImages: null,
          systemPrompt: effectiveSystemPrompt,
        });
      }
      // Reset the stream-state accumulator so a mid-rewrite tab-switch
      // PEEK shows v2 (not v1+v2 concatenated).
      const _st = streamState.get(tabId);
      if (_st) _st.acc = '';
      try {
        const r2 = await doStream({ silent: true });
        if (r2 && r2.full) {
          fullReply = r2.full;
          if (r2.usage) replyUsage = r2.usage;
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
  await storage.appendToHistory({ role: 'assistant', content: fullReply, ...(videoSrc ? { videoSrc } : {}) });

  pushChunk(tabId, { type: 'DONE', full: fullReply, choiceRequest, usage: replyUsage, videoSrc: videoSrc || null });
  clearStreamState(tabId);
  // Now that the model has seen this turn's images, compact any image_url pixel
  // blocks in stored history to labeled text placeholders, so later turns resend
  // cheap text instead of the pixels. Success-path only (abort/errors return
  // above before reaching here). Fire-safe: a failure never breaks the turn.
  if (mayHaveImages) {
    try { await compactImagePartsInHistory(); }
    catch (e) { console.warn('[browsa] history image compaction failed:', e?.message || e); }
  }
  return { full: fullReply };
}
