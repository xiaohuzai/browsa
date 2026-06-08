// lib/openai-client.js
// OpenAI Chat Completions client. Works with any provider that speaks /v1/chat/completions:
//   - Hermes api_server (http://<host>:8642/v1/chat/completions)
//   - Claude Code + openai-compatible wrapper (http://localhost:8000/v1/chat/completions)
//   - OpenClaw gateway (http://<host>:8080/v1/chat/completions)
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
export async function chat({ baseUrl, apiKey, model, messages, signal }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  if (!model) throw ProviderConfigError('model is required');

  const url = joinUrl(baseUrl, '/v1/chat/completions');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({ model, messages, stream: false }),
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
export async function chatStream({ baseUrl, apiKey, model, messages, onDelta, signal }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  if (!model) throw ProviderConfigError('model is required');

  const url = joinUrl(baseUrl, '/v1/chat/completions');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({ model, messages, stream: true }),
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
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events separated by \n\n; each line starts with "data: "
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
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

function buildHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
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
 * Quick connectivity check used by the options page to verify a provider config.
 * Sends a minimal "say hi" request and waits for the response.
 */
export async function ping({ baseUrl, apiKey, model }) {
  return chat({
    baseUrl,
    apiKey,
    model,
    messages: [{ role: 'user', content: 'ping' }]
  });
}
