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
export async function chatStream({ baseUrl, apiKey, model, messages, onDelta, onToolProgress, onApproval, onClarify, signal, extraHeaders, temperature, maxTokens }) {
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
      // Hermes emits these when a dangerous tool call (e.g. execute_code on
      // the api_server platform) needs the user to approve/deny/clarify
      // before it proceeds — same contract as /v1/runs approval.request,
      // resolved the same way via POST /v1/runs/{run_id}/approval. Without
      // this handler the tool call just hangs: Hermes waits for a response
      // that never comes, and the agent eventually reports it as "blocked".
      if ((onApproval || onClarify) && /event: (hermes\.approval\.request|approval\.request|clarification\.request|clarify\.request)/.test(event)) {
        try {
          const eventLine = event.split('\n').find(l => l.startsWith('event: '));
          const dataLine = event.split('\n').find(l => l.startsWith('data: '));
          const evName = eventLine ? eventLine.slice(7).trim() : '';
          if (dataLine) {
            const obj = JSON.parse(dataLine.slice(6));
            if (/approval/.test(evName) && onApproval) onApproval(obj);
            else if (/clarif/.test(evName) && onClarify) onClarify(obj);
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
 * Hermes /v1/runs API — create a run then subscribe to its SSE event stream.
 * Richer than /v1/responses: supports approval, clarification, tool details.
 *
 * Callbacks:
 *   onDelta(text)         — text chunk or <thinking> block
 *   onToolProgress(text)  — tool name/args/result one-liner
 *   onApproval(data)      — agent needs user to approve a dangerous action
 *   onClarify(data)       — agent needs user to answer a question
 *   onRunId(runId)        — called as soon as run_id is known (for cancel)
 *
 * Resolves with { full, usage, runId }.
 */
export async function runsApiStream({
  baseUrl, apiKey, input, instructions, conversationHistory, sessionId,
  onDelta, onToolProgress, onApproval, onClarify, onRunId,
  signal, temperature, maxTokens,
}) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  // hermes-webui always sends a stable session_id (as both a header and a
  // body field) on every /v1/runs request — mirror that shape here in case
  // Hermes scopes tool permissions or approval state off of it.
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (sessionId) {
    headers['X-Hermes-Session-Id'] = sessionId;
    if (apiKey) headers['X-Hermes-Session-Key'] = `browsa:${sessionId}`;
  }

  // Step 1: POST /v1/runs — create the run, get run_id
  const body = { input };
  if (instructions) body.instructions = instructions;
  if (conversationHistory?.length) body.conversation_history = conversationHistory;
  if (sessionId) body.session_id = sessionId;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;

  let runRes;
  try {
    runRes = await fetch(joinUrl(baseUrl, '/v1/runs'), {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw ProviderNetworkError(`/v1/runs request failed: ${e?.message}`);
  }
  if (!runRes.ok) {
    const errText = await runRes.text().catch(() => '');
    throw ProviderAPIError(`/v1/runs HTTP ${runRes.status}: ${errText.slice(0, 200)}`);
  }
  let runData;
  try { runData = await runRes.json(); } catch (_) {
    throw ProviderAPIError('/v1/runs response is not valid JSON');
  }
  const runId = runData.run_id || runData.id;
  if (!runId) throw ProviderAPIError('/v1/runs returned no run_id');
  if (onRunId) onRunId(runId);

  // Step 2: GET /v1/runs/{id}/events — subscribe to SSE stream.
  // Reuse the same session headers as the POST above so Hermes can
  // correlate the two requests as one client.
  let eventsRes;
  try {
    eventsRes = await fetch(
      joinUrl(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/events`),
      { headers: { ...headers, Accept: 'text/event-stream' }, signal },
    );
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw ProviderNetworkError(`/v1/runs/events request failed: ${e?.message}`);
  }
  if (!eventsRes.ok) {
    const errText = await eventsRes.text().catch(() => '');
    throw ProviderAPIError(`/v1/runs/events HTTP ${eventsRes.status}: ${errText.slice(0, 200)}`);
  }

  // Step 3: Parse SSE event stream
  const reader = eventsRes.body.getReader();
  const abortRef = attachAbortToReader(signal, reader);
  const decoder = new TextDecoder();
  let full = '';
  // Tracks how much of `full` came from actual message text (message.delta),
  // as opposed to <thinking> blocks injected by reasoning.available below.
  // run.completed must diff its output against this, not full.length, or
  // thinking-block text gets mistaken for already-streamed message text and
  // the real remainder (the model's actual answer) is silently dropped.
  let messageTextLen = 0;
  let usage = null;
  let buffer = '';

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let sseEvent = '', sseData = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) sseEvent = line.slice(7).trim();
        else if (line.startsWith('data: ')) sseData = line.slice(6).trim();
      }
      if (!sseData || sseData === '[DONE]') continue;

      let obj;
      try { obj = JSON.parse(sseData); } catch (_) { continue; }

      // Event type: SSE event: line wins, then payload.event, then payload.type
      const ev = sseEvent || String(obj.event || obj.type || '');

      if (ev === 'message.delta') {
        const delta = String(obj.delta || obj.text || '');
        if (delta) { full += delta; messageTextLen += delta.length; if (onDelta) onDelta(delta); }

      } else if (ev === 'tool.started') {
        if (onToolProgress) {
          const name = String(obj.name || 'tool');
          let preview = '';
          if (obj.args && typeof obj.args === 'object') {
            const firstVal = Object.values(obj.args)[0];
            if (typeof firstVal === 'string') {
              const s = firstVal.replace(/\n/g, ' ').trim();
              preview = ': ' + (s.length > 80 ? s.slice(0, 80) + '…' : s);
            }
          } else if (obj.preview) {
            preview = ': ' + String(obj.preview).slice(0, 80);
          }
          onToolProgress(name + preview);
        }

      } else if (ev === 'tool.completed') {
        if (onToolProgress) {
          const name = String(obj.name || 'tool');
          onToolProgress(name + (obj.is_error ? ' ✗' : ' ✓'));
        }

      } else if (ev === 'reasoning.available') {
        const text = String(obj.text || obj.preview || obj.delta || obj.content || '');
        // Hermes has been observed to mislabel already-streamed assistant
        // narration as reasoning.available — both for the final consolidated
        // message AND for short per-step commentary throughout a task. Any
        // of these would otherwise get wrapped in a <thinking> block and
        // duplicate content already emitted via message.delta.
        // Use an adaptive anchor: for short text, require the WHOLE trimmed
        // string to already appear in `full`; for long text, a 60-char
        // prefix is enough (avoids re-scanning huge strings). A minimum of
        // 12 chars avoids false positives on trivially short common phrases.
        const trimmed = text.trim();
        const anchorLen = Math.min(60, trimmed.length);
        const isEchoOfStreamed = anchorLen >= 12 && full.includes(trimmed.slice(0, anchorLen));
        if (text && onDelta && !isEchoOfStreamed) {
          const thinkBlock = `<thinking>\n${text}\n</thinking>\n`;
          full += thinkBlock;
          onDelta(thinkBlock);
        }

      } else if (ev === 'approval.request') {
        if (onApproval) onApproval({ ...obj, runId });

      } else if (ev === 'clarification.request' || ev === 'clarify.request') {
        if (onClarify) onClarify({ ...obj, runId });

      } else if (ev === 'run.completed') {
        const output = String(obj.output || '');
        if (output.length > messageTextLen) {
          // Emit only the part not yet streamed via message.delta — diff
          // against messageTextLen, not full.length (see comment above).
          const remainder = output.slice(messageTextLen);
          full += remainder; messageTextLen += remainder.length;
          if (onDelta) onDelta(remainder);
        } else if (output && messageTextLen === 0) {
          full += output; messageTextLen += output.length;
          if (onDelta) onDelta(output);
        }
        const u = obj.usage;
        if (u) usage = u;
        break outer;

      } else if (ev === 'run.failed') {
        throw ProviderAPIError(String(obj.error || 'Run failed'));

      } else if (ev === 'run.cancelled') {
        throw new DOMException('Run cancelled', 'AbortError');
      }
    }
  }

  return { full, usage, runId };
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
