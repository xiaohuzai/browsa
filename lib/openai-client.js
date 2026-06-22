// lib/openai-client.js
// OpenAI Chat Completions client. Works with any provider that speaks /v1/chat/completions:
//   - Hermes api_server (http://<host>:8642/v1/chat/completions)
//   - Claude Code + openai-compatible wrapper (http://localhost:8000/v1/chat/completions)
//   - any other OpenAI-compatible gateway (Ollama, vLLM, LM Studio, LiteLLM, etc.)
//
// Usage:
//   const reply = await chat({ baseUrl, apiKey, model, messages, stream: true, onDelta });

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

/**
 * Non-streaming chat. Returns the full assistant message string.
 */
export async function chat({ baseUrl, apiKey, model, messages, signal, extraHeaders }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = joinUrl(baseUrl, '/v1/chat/completions');
  const body = { messages, stream: false };
  if (model) body.model = model;
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

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Streaming chat. Calls onDelta(text) for each chunk. Resolves with the full text.
 * Aborts via the AbortSignal.
 */
export async function chatStream({ baseUrl, apiKey, model, messages, onDelta, onToolProgress, signal, extraHeaders }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = joinUrl(baseUrl, '/v1/chat/completions');
  const body = { messages, stream: true };
  if (model) body.model = model;
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
  let aborted = false;
  if (signal) {
    if (signal.aborted) {
      aborted = true;
      try { await reader.cancel(); } catch (_) {}
    } else {
      signal.addEventListener('abort', () => {
        aborted = true;
        try { reader.cancel().catch(() => {}); } catch (_) {}
      }, { once: true });
    }
  }
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (aborted) {
        // reader.cancel() (called from the abort listener) makes the
        // next read() resolve with done=true — it does NOT reject. So
        // we have to re-throw the AbortError ourselves here, otherwise
        // chatStream resolves normally and the half-baked reply gets
        // persisted to history as if the LLM had actually finished.
        throw new DOMException('Stream aborted', 'AbortError');
      }
      break;
    }
    if (aborted) {
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
      const delta = parseSseDelta(event);
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }

  // Flush any trailing single-newline leftover
  const trailing = parseSseDelta(buffer);
  if (trailing) {
    full += trailing;
    if (onDelta) onDelta(trailing);
  }

  return full;
}

function parseSseDelta(eventText) {
  // eventText is the raw SSE event block, may contain "data: ..." lines.
  // Returns concatenated delta.content from all data lines, skipping [DONE] / non-data lines.
  let acc = '';
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
    } catch {
      // ignore malformed lines
    }
  }
  return acc;
}

/**
 * Hermes /v1/responses API — stateful streaming.
 * Maintains server-side conversation history via the `conversation` parameter.
 * The client only sends the current `input`; Hermes reconstructs full context.
 *
 * Streaming events: response.output_text.delta (delta text chunks)
 *                   response.completed (final output + usage)
 */
export async function responsesApiStream({ baseUrl, apiKey, input, instructions, conversation, onDelta, onToolProgress, signal }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = joinUrl(baseUrl, '/v1/responses');
  const body = { input, stream: true, store: true };
  if (instructions) body.instructions = instructions;
  if (conversation) body.conversation = conversation;

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
  let aborted = false;
  if (signal) {
    if (signal.aborted) { aborted = true; try { await reader.cancel(); } catch (_) {} }
    else signal.addEventListener('abort', () => { aborted = true; try { reader.cancel().catch(() => {}); } catch (_) {} }, { once: true });
  }

  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (aborted) throw new DOMException('Stream aborted', 'AbortError');
      break;
    }
    if (aborted) throw new DOMException('Stream aborted', 'AbortError');
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
          if (delta) { full += delta; onDelta(delta); }
        } else if (type === 'hermes.tool.progress' && onToolProgress) {
          const text = obj.tool ? `${obj.tool}: ${obj.description || ''}`.trim() : (obj.description || obj.text || '');
          if (text) onToolProgress(text);
        } else if (type === 'response.completed') {
          // Fallback: extract text from output array (OpenAI format: obj.response.output)
          const output = obj.response?.output || obj.output || [];
          if (!full && output.length) {
            for (const item of output) {
              if (item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c.type === 'output_text') { full += c.text; onDelta(c.text); }
                }
              }
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
          if (delta && !full) { full += delta; onDelta(delta); }
        } else if (type === 'response.completed') {
          const output = obj.response?.output || obj.output || [];
          if (!full && output.length) {
            for (const item of output) {
              if (item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c.type === 'output_text') { full += c.text; onDelta(c.text); }
                }
              }
            }
          }
        }
      } catch (_) {}
    }
  }
  return full;
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
 * Quick server health check. Returns { status: 'ok' } or throws.
 * Much faster than a full chat ping — no LLM inference needed.
 */
export async function healthCheck({ baseUrl, apiKey }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  const url = joinUrl(baseUrl, '/health');
  let res;
  try {
    res = await fetch(url, { headers: buildHeaders(apiKey) });
  } catch (e) {
    throw ProviderNetworkError(`Network error: ${e.message}`);
  }
  if (!res.ok) throw ProviderAPIError(`HTTP ${res.status}`);
  return await res.json().catch(() => ({ status: 'ok' }));
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

  // If no model configured: /health is sufficient (Hermes / Claude Code / any server)
  if (!model) {
    try {
      const r = await fetch(joinUrl(baseUrl, '/health'), {
        headers: buildHeaders(apiKey),
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) return 'ok';
    } catch (_) {}
    // Fallback to /v1/models for servers without /health
    let res;
    try {
      res = await fetch(joinUrl(baseUrl, '/v1/models'), {
        headers: buildHeaders(apiKey),
        signal: AbortSignal.timeout(8000)
      });
    } catch (e) {
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
