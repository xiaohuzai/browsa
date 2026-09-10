// lib/handlers/stream-dispatch.js — the single apiStyle → stream-function
// dispatch for LLM (non-agent) providers.
//
// chat-handler, subchat-handler, selection-explain and mermaid-repair all used
// to hand-roll the same `apiStyle` branch (responses / anthropic / chat), so a
// new wire quirk had to be fixed in four places. This is that one place.
//
// Deliberately NOT covering the two agent protocols (opencode / agent-bridge)
// or Hermes `/v1/runs`: those have their own clients, and runs additionally
// carries tool/approval plumbing. It covers exactly the three stateless wire
// protocols that share a `{baseUrl, apiKey, model, …}` transport shape.
//
// `common` carries the transport-level fields every protocol shares
// (baseUrl/apiKey/model/signal/extraHeaders/temperature/maxTokens). Per-style
// payloads are passed explicitly so each caller keeps its exact message shape.

import { chatStream, responsesStream, anthropicStream } from '../llm-client.js';

export async function dispatchStyleStream({
  apiStyle,
  common = {},
  onDelta,
  // optional stream-fn overrides (selection-explain injects these for tests)
  streams,
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
