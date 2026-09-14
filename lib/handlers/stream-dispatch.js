// lib/handlers/stream-dispatch.js — the single apiStyle → stream-function
// dispatch for LLM (non-agent) providers.
//
// chat-handler, subchat-handler, selection-explain and mermaid-repair all used
// to hand-roll the same `apiStyle` branch (responses / anthropic / chat), so a
// new wire quirk had to be fixed in four places. This is that one place.
//
// Hermes `/v1/runs` still has its own clients/branches (chat-handler's main
// branch and subchat-handler's dedicated-session branch) — not dispatched here.
// The two agent protocols (opencode / agent-bridge) ARE handled here, but only
// in their SESSIONLESS one-shot form (opt-in via `agent`): their servers have
// no /chat/completions route, so the pre-2026-09-13 behavior of letting an
// agent provider fall through to chatStream produced `HTTP 404 {"ok":false,
// "error":"not found"}` on the float-bar explain/translate and mermaid repair.
// One-shot = a FRESH server session per call (opencode: created and discarded;
// bridge: /turns without a sessionId spawns a throwaway thread) so these side
// queries never enter a conversation's server-side context. Conversation-form
// agent calls (chat-handler/subchat-handler) keep their own session-bearing
// branches and do NOT pass `agent`.
//
// `common` carries the transport-level fields every protocol shares
// (baseUrl/apiKey/model/signal/extraHeaders/temperature/maxTokens). Per-style
// payloads are passed explicitly so each caller keeps its exact message shape.
// Note: the agent one-shot path ignores temperature/maxTokens/model — agents
// run their own inference config (same rule as the conversation branches).

import { chatStream, responsesStream, anthropicStream } from '../llm-client.js';
import { opencodeStream, createOpencodeSession } from '../opencode-client.js';
import { bridgeStream } from '../bridge-client.js';
import { resolveBridgeEndpoint, resolveBridgeApiKey } from './provider-resolver.js';

export async function dispatchStyleStream({
  apiStyle,
  common = {},
  onDelta,
  // optional stream-fn overrides (selection-explain injects these for tests)
  streams,
  // optional overrides for the agent one-shot branch (tests inject these)
  agentStreams,
  // opt-in agent one-shot: { provider, all } — see header comment
  agent,
  // responses
  responsesInput,
  // anthropic
  anthropicMessages,
  anthropicSystem,
  // chat (default)
  chatMessages,
  // convenience for plain single-turn callers (a system prompt + user text)
  system,
  user,
}) {
  const s = streams || { chatStream, responsesStream, anthropicStream };
  // Only inject onDelta when the caller passes one — some callers (subchat)
  // already carry onDelta inside `common`, and an explicit `onDelta: undefined`
  // here would clobber it.
  const base = onDelta ? { ...common, onDelta } : { ...common };
  const style = apiStyle || 'chat';

  const provider = agent?.provider;
  if (agent && (provider.isOpencode || provider.isBridge)) {
    const a = agentStreams || { opencodeStream, createOpencodeSession, bridgeStream };
    const prompt = [system, user].filter(Boolean).join('\n\n') || user || '';
    if (provider.isOpencode) {
      // Fresh throwaway session per call — never a conversation session.
      const sessionId = await a.createOpencodeSession({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      return a.opencodeStream({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        sessionId,
        text: prompt,
        onDelta,
        signal: common.signal,
      });
    }
    const endpoint = agent.all
      ? (resolveBridgeEndpoint(provider, agent.all) || provider.baseUrl)
      : provider.baseUrl;
    return a.bridgeStream({
      baseUrl: endpoint,
      apiKey: resolveBridgeApiKey(provider, endpoint),
      text: prompt,
      onDelta,
      signal: common.signal,
    });
  }

  if (style === 'responses') {
    return s.responsesStream({
      ...base,
      input: responsesInput ?? user,
      instructions: system || undefined,
    });
  }
  if (style === 'anthropic') {
    return s.anthropicStream({
      ...base,
      system: anthropicSystem ?? system ?? undefined,
      messages: anthropicMessages ?? [{ role: 'user', content: user }],
    });
  }
  return s.chatStream({
    ...base,
    messages: chatMessages ?? [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
}
