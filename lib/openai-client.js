// lib/openai-client.js
// OpenAI Chat Completions client. Works with any provider that speaks /v1/chat/completions:
//   - Hermes api_server (http://<host>:8642/v1/chat/completions)
//   - Claude Code + openai-compatible wrapper (http://localhost:8000/v1/chat/completions)
//   - any other OpenAI-compatible gateway (Ollama, vLLM, LM Studio, LiteLLM, etc.)

// Typed error factory functions (functional style — no classes).
// They accept the same args as the native Error constructor and produce an
// Error instance whose `name` matches the error type, so callers can match
// with `e.name === 'ProviderConfigError'` or use `instanceof Error` freely.
function makeError(name, ...args) {
  const err = new Error(...args);
  err.name = name;
  return err;
}

export const ProviderConfigError = (msg) => makeError('ProviderConfigError', msg);
export const ProviderNetworkError = (msg) => makeError('ProviderNetworkError', msg);
export const ProviderAPIError = (msg) => makeError('ProviderAPIError', msg);

// Wire an AbortSignal to a ReadableStreamDefaultReader so that calling
// signal.abort() also cancels the reader (which fetch() alone does not do once
// we're inside the SSE read loop).  Returns a { aborted } ref-object that the
// caller checks in the read loop.
function attachAbortToReader(signal, reader) {
  const ref = { aborted: false };
  if (!signal) return ref;
  if (signal.aborted) {
    ref.aborted = true;
    reader.cancel().catch(() => {});
  } else {
    signal.addEventListener('abort', () => {
      ref.aborted = true;
      reader.cancel().catch(() => {});
    }, { once: true });
  }
  return ref;
}


/**
 * Streaming chat. Calls onDelta(text) for each chunk. Resolves with { full, usage }.
 * Aborts via the AbortSignal.
 */
export async function chatStream({ baseUrl, apiKey, model, messages, onDelta, onToolProgress, signal, extraHeaders, temperature, maxTokens }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = joinUrl(baseUrl, '/v1/chat/completions');
  const body = { messages, stream: true, stream_options: { include_usage: true } };
  if (model) body.model = model;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey, extraHeaders),
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    throw ProviderNetworkError(`Network error: ${e.message}`);
  }

  if (!res.ok) {
    const text = await safeReadText(res);
    throw ProviderAPIError(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) {
    throw ProviderNetworkError('No response body (stream)');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  // Wire the AbortSignal to the reader. fetch() with signal aborts the
  // HTTP request itself, but reader.read() does NOT auto-cancel — once
  // we're inside the SSE loop, we have to call reader.cancel() to make
  // the in-flight read() reject with AbortError. Without this, an
  // abort just sits in the queue and the loop keeps consuming chunks
  // until the LLM finishes (which can be many seconds of wasted work
  // and ghost tokens in streamState).
  const abortRef = attachAbortToReader(signal, reader);
  let buffer = '';
  let full = '';
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (abortRef.aborted) {
        // reader.cancel() (called from the abort listener) makes the
        // next read() resolve with done=true — it does NOT reject. So
        // we have to re-throw the AbortError ourselves here, otherwise
        // chatStream resolves normally and the half-baked reply gets
        // persisted to history as if the LLM had actually finished.
        throw new DOMException('Stream aborted', 'AbortError');
      }
      break;
    }
    if (abortRef.aborted) {
      // Belt-and-suspenders: if the loop somehow reached here with
      // aborted=true and done=false, throw.
      throw new DOMException('Stream aborted', 'AbortError');
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE events separated by \n\n; each line starts with "data: "
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // Check for Hermes tool progress events
      if (onToolProgress && event.includes('event: hermes.tool.progress')) {
        try {
          const dataLine = event.split('\n').find(l => l.startsWith('data: '));
          if (dataLine) {
            const obj = JSON.parse(dataLine.slice(6));
            const text = obj.tool ? `${obj.tool}: ${obj.description || ''}`.trim() : (obj.description || obj.text || '');
            if (text) onToolProgress(text);
          }
        } catch (_) {}
        continue;
      }
      const { delta, usage: u } = parseSseEvent(event);
      if (u) usage = u;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }

  // Flush any trailing single-newline leftover
  const { delta: trailing, usage: trailingUsage } = parseSseEvent(buffer);
  if (trailingUsage) usage = trailingUsage;
  if (trailing) {
    full += trailing;
    if (onDelta) onDelta(trailing);
  }

  return { full, usage };
}

function parseSseEvent(eventText) {
  // eventText is the raw SSE event block, may contain "data: ..." lines.
  // Returns { delta: string, usage: object|null }.
  let acc = '';
  let usage = null;
  for (const line of eventText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') continue;
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload);
      const chunk = obj.choices?.[0]?.delta?.content;
      if (typeof chunk === 'string') acc += chunk;
      // Capture usage from stream_options: { include_usage: true } response
      if (obj.usage) usage = obj.usage;
    } catch {
      // ignore malformed lines
    }
  }
  return { delta: acc, usage };
}


/**
 * Hermes /v1/responses API — stateful streaming.
 * Maintains server-side conversation history via the `conversation` parameter.
 * The client only sends the current `input`; Hermes reconstructs full context.
 *
 * Streaming events: response.output_text.delta (delta text chunks)
 *                   response.completed (final output + usage)
 */
export async function responsesApiStream({ baseUrl, apiKey, input, instructions, conversation, onDelta, onToolProgress, signal, temperature, maxTokens }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = joinUrl(baseUrl, '/v1/responses');
  const body = { input, stream: true, store: true };
  if (instructions) body.instructions = instructions;
  if (conversation) body.conversation = conversation;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    throw ProviderNetworkError(`Network error: ${e.message}`);
  }
  if (!res.ok) {
    const text = await safeReadText(res);
    throw ProviderAPIError(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) throw ProviderNetworkError('No response body (stream)');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const abortRef = attachAbortToReader(signal, reader);

  let buffer = '';
  let full = '';
  // Tracks how much of `full` came from actual message text (output_text
  // deltas), as opposed to <thinking> blocks injected below. response.completed
  // must diff against this, not full.length, or thinking-block text gets
  // mistaken for already-streamed message text and the real remainder
  // (the model's actual answer) is silently dropped.
  let messageTextLen = 0;
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
      break;
    }
    if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let eventType = '';
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
      }
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const obj = JSON.parse(dataStr);
        const type = eventType || obj.type || '';
        if (type === 'response.output_text.delta') {
          const delta = obj.delta || obj.text || '';
          if (delta) { full += delta; messageTextLen += delta.length; onDelta(delta); }
        } else if (type === 'hermes.tool.progress' && onToolProgress) {
          const text = obj.tool ? `${obj.tool}: ${obj.description || ''}`.trim() : (obj.description || obj.text || '');
          if (text) onToolProgress(text);
        } else if (type === 'response.output_item.added') {
          // Tool call starting — show the tool name as a progress indicator.
          // (Responses API uses these spec-native events instead of hermes.tool.progress)
          const item = obj.item || {};
          if (item.type === 'function_call' && onToolProgress) {
            onToolProgress(item.name || 'tool');
          }
        } else if (type === 'response.output_item.done') {
          // Reasoning/thinking item completed — emit as a <thinking> block so
          // browsa's existing think-block renderer can display and collapse it.
          const item = obj.item || {};
          if ((item.type === 'reasoning' || item.type === 'thinking') && onDelta) {
            const parts = item.summary || item.content || [];
            const text = Array.isArray(parts)
              ? parts.map(p => p.text || p.summary_text || '').join('')
              : (item.text || '');
            if (text) {
              const block = `<thinking>\n${text}\n</thinking>\n`;
              full += block;
              onDelta(block);
            }
          }
        } else if (type === 'response.completed') {
          // Extract usage from completed event
          const respUsage = obj.response?.usage || obj.usage;
          if (respUsage) usage = respUsage;
          // Extract final text from output array.
          // When the agent uses tools, pre-tool text arrives via delta events
          // (populating `messageTextLen`), but post-tool text only appears
          // here in response.completed. We must emit the remainder even when
          // messageTextLen != 0. Diff against messageTextLen, not full.length —
          // full may also contain injected <thinking> block text that was
          // never part of the streamed message.
          const output = obj.response?.output || obj.output || [];
          if (output.length) {
            let completedText = '';
            for (const item of output) {
              if (item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c.type === 'output_text') completedText += c.text;
                }
              }
            }
            if (completedText.length > messageTextLen) {
              // Emit only the part not yet streamed via deltas
              const remainder = completedText.slice(messageTextLen);
              full += remainder;
              messageTextLen += remainder.length;
              onDelta(remainder);
            } else if (completedText && messageTextLen === 0) {
              full += completedText;
              messageTextLen += completedText.length;
              onDelta(completedText);
            }
          }
        }
      } catch (_) {}
    }
  }
  // Flush any remaining buffered data (e.g. stream ended without trailing \n\n)
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    let eventType = '', dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
    }
    if (dataStr && dataStr !== '[DONE]') {
      try {
        const obj = JSON.parse(dataStr);
        const type = eventType || obj.type || '';
        if (type === 'response.output_text.delta') {
          const delta = obj.delta || obj.text || '';
          if (delta && messageTextLen === 0) { full += delta; messageTextLen += delta.length; onDelta(delta); }
        } else if (type === 'response.completed') {
          const respUsage = obj.response?.usage || obj.usage;
          if (respUsage) usage = respUsage;
          const output = obj.response?.output || obj.output || [];
          if (output.length) {
            let completedText = '';
            for (const item of output) {
              if (item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c.type === 'output_text') completedText += c.text;
                }
              }
            }
            if (completedText.length > messageTextLen) {
              const remainder = completedText.slice(messageTextLen);
              full += remainder;
              messageTextLen += remainder.length;
              onDelta(remainder);
            } else if (completedText && messageTextLen === 0) {
              full += completedText;
              messageTextLen += completedText.length;
              onDelta(completedText);
            }
          }
        }
      } catch (_) {}
    }
  }
  return { full, usage };
}

function buildHeaders(apiKey, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  if (extraHeaders) Object.assign(h, extraHeaders);
  return h;
}

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}


/**
 * Probe the server's capabilities. Returns the capabilities object or null if
 * the endpoint doesn't exist (non-Hermes server).
 */
export async function getCapabilities({ baseUrl, apiKey }) {
  if (!baseUrl) return null;
  const url = joinUrl(baseUrl, '/v1/capabilities');
  try {
    const res = await fetch(url, { headers: buildHeaders(apiKey) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}


/**
 * Quick connectivity check used by the options page to verify a provider config.
 * Tries /health first (Hermes/Claude Code), then /v1/models (standard OpenAI-compatible).
 * If `model` is provided, also verifies it appears in the /v1/models list.
 * Does NOT send a real inference request — no tokens consumed.
 * Returns a status string: 'ok' or 'ok (model not in list — check name)'.
 */
export async function ping({ baseUrl, apiKey, model }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  // If no model configured: check liveness via /health, then verify auth
  // via /v1/models when an apiKey is present. /health is intentionally
  // unauthenticated on most servers (Hermes, LLM Gateway) — a wrong
  // password still returns 200, so /v1/models is the real auth gate.
  if (!model) {
    let healthOk = false;
    try {
      // /health: liveness only, no auth header
      const r = await fetch(joinUrl(baseUrl, '/health'), {
        signal: AbortSignal.timeout(5000)
      });
      healthOk = r.ok;
    } catch (_) {}

    // No apiKey → liveness is enough.
    if (healthOk && !apiKey) return 'ok';

    // apiKey present (or /health failed): verify credentials via /v1/models.
    let res;
    try {
      res = await fetch(joinUrl(baseUrl, '/v1/models'), {
        headers: buildHeaders(apiKey),
        signal: AbortSignal.timeout(8000)
      });
    } catch (e) {
      if (healthOk) {
        // Server alive but no /v1/models (non-standard server). Trust /health.
        return 'ok';
      }
      throw ProviderNetworkError(`Network error: ${e.message}`);
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      throw ProviderAPIError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return 'ok';
  }

  // Model is configured: verify by sending a minimal 1-token request.
  // /v1/models lists are unreliable (gateways may hide or rename models),
  // so an actual call is the only way to be certain the model is valid.
  let res;
  try {
    res = await fetch(joinUrl(baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw ProviderNetworkError(`Network error: ${e.message}`);
  }
  if (!res.ok) {
    const text = await safeReadText(res);
    throw ProviderAPIError(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return 'ok';
}
