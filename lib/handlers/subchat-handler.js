// lib/handlers/subchat-handler.js — body of background.js's `case 'SUBCHAT'`
// and `case 'SUBCHAT_ABORT'`, extracted verbatim (Phase 2 of the
// sidepanel/background modularization refactor). handle() in background.js
// delegates here.

import * as storage from '../storage.js';
import { chatStream, responsesStream, anthropicStream } from '../llm-client.js';
import { subChatControllers, subChatPorts, pushSubChatChunk } from '../state.js';
import { resolveProvider, resolveInferenceParams } from './provider-resolver.js';

/**
 * "Detail thread" side-conversation: the user selected a piece of text
 * inside an assistant reply and wants to drill into it without touching the
 * main conversation. Deliberately scoped down from CHAT:
 * - uses the provider's configured apiStyle (chat/completions, responses, or
 *   anthropic messages) — but never runsApiStream — no tool execution/
 *   approval needed for a side Q&A, and reusing the main chat's Hermes
 *   session id here would mix this detail question into the server-side
 *   agent's main-task context.
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
        model: provider.model || undefined,
        onDelta,
        signal: controller.signal,
        temperature,
        maxTokens,
      };
      let st;
      if (apiStyle === 'responses') {
        st = await responsesStream({
          ...common,
          input: turnMessages.map((m) => ({ role: m.role, content: m.content })),
          instructions: sysPrompt || undefined,
        });
      } else if (apiStyle === 'anthropic') {
        st = await anthropicStream({
          ...common,
          system: sysPrompt || undefined,
          messages: turnMessages.map((m) => ({ role: m.role, content: m.content })),
        });
      } else {
        st = await chatStream({ ...common, messages });
      }
      console.log('[subchat][bg]', subId, 'stream done, port still registered?', subChatPorts.has(subId));
      pushSubChatChunk(subId, { type: 'SUBCHAT_DONE', subId, ...(st.finishReason === 'length' ? { truncated: true } : {}) });
    } catch (e) {
      console.error('[subchat][bg]', subId, 'stream threw', e);
      if (e?.name !== 'AbortError') {
        pushSubChatChunk(subId, { type: 'SUBCHAT_ERROR', subId, message: e?.message || String(e) });
      }
    } finally {
      subChatControllers.delete(subId);
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
  return { aborted: !!c };
}
