// lib/llm-client.js
// Wire-protocol layer for every supported LLM provider — one function per
// endpoint, each returning the same { full, usage, finishReason } shape so
// callers share truncation-detection logic:
//   - chatStream()      — OpenAI Chat Completions /v1/chat/completions
//                         (Hermes api_server, Ollama, vLLM, LM Studio, LiteLLM, ...)
//   - responsesStream() — OpenAI Responses /v1/responses (input_text/input_image parts)
//   - runsApiStream()   — Hermes /v1/runs (approval/clarification/tool events)
//   - anthropicStream() — Anthropic Messages /v1/messages (base64 image blocks)
//   - ping()/getCapabilities() — endpoint probes used by the options page

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
 * 聊天回复的输出 token 预算默认值：provider.maxTokens 未设置（或为 0）时使用。
 * 与 ASR 的 max_output_tokens 同理——不传的话服务端用模型默认输出上限，长回复
 * 会被无声拦腰截断（用户只能不断说“继续”）。32768 起步：方舟等会自动夹到模型
 * 硬上限的服务器无感受益；OpenAI/Anthropic 系对超上限的预算会 400，由
 * renegotiateOutputCap 从报错里解析真实上限自动重试（用户无需知道该填什么）。
 */
export const DEFAULT_MAX_TOKENS = 32768;

/**
 * 从供应商报错文本解析「真实输出上限」。OpenAI："max_tokens is too large: 32768.
 * This model supports at most 16384 max_tokens"；Anthropic："max_tokens: 100000 >
 * 8192, which is the maximum allowed number of output tokens for …"。
 * 返回 0 = 没解析出可信上限（下限 256 过滤噪声，上限 200 万防荒谬值）。
 */
export function parseOutputCapFromError(message) {
  const msg = String(message || '');
  const m = /supports at most (\d{2,7})/i.exec(msg)
    || /max_tokens[^.\n]{0,40}?>\s*(\d{2,7})/i.exec(msg)
    || /at most (\d{2,7})/i.exec(msg);
  const cap = m ? parseInt(m[1], 10) : 0;
  return cap >= 256 && cap <= 2_000_000 ? cap : 0;
}

/**
 * 决定预算重试值：报错提到 max_tokens 且解析出的上限比请求的小 → 用该上限；
 * 提到 max_tokens 但解析不出 → 退回 16384（旧默认值，公认安全档）；其余 → 0
 * （与预算无关的报错，原样抛出）。
 */
export function outputCapRetryBudget(errText, requested) {
  if (!/max_tokens|max_output_tokens|output token/i.test(String(errText || ''))) return 0;
  if (!requested || requested <= 0) return 0;
  const cap = parseOutputCapFromError(errText);
  if (cap && cap < requested) return cap;
  if (!cap && requested > 16384) return 16384;
  return 0;
}

/**
 * 输出预算自动协商的共用底层：三个流式函数（chat/responses/anthropic）拿到
 * !ok 响应后调用。若报错指向预算超限，换算出的重试预算重发一次并返回新响应；
 * 否则原响应原样返回，由调用方按既有路径抛错。
 */
async function renegotiateOutputCap(res, errText, { url, headers, body, budgetKey, signal, networkErrLabel }) {
  const requested = body[budgetKey] || 0;
  const retry = outputCapRetryBudget(errText, requested);
  if (!retry) return res;
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, [budgetKey]: retry }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw ProviderNetworkError(`${networkErrLabel}: ${e?.message}`);
  }
}

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
 * Streaming chat. Calls onDelta(text) for each chunk. Resolves with
 * { full, usage, finishReason } — finishReason is 'length' when the output
 * was cut by the max_tokens cap (callers should surface a hint), 'stop' or
 * '' when it ended normally. Aborts via the AbortSignal.
 */
export async function chatStream({ baseUrl, apiKey, model, messages, onDelta, onToolProgress, onApproval, onClarify, signal, extraHeaders, temperature, maxTokens }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = endpointUrl(baseUrl, '/chat/completions');
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
    // abort() with a STRING reason ('user-cancel'/'idle-timeout') makes fetch
    // reject with that raw string — no .name, no .message. Re-raise as a real
    // AbortError so chat-handler's cancel classification sees it; wrapping it
    // as ProviderNetworkError('Network error: undefined') here used to make
    // an aborted request look like a network failure and get retried.
    if (signal?.aborted) throw new DOMException('Stream aborted', 'AbortError');
    throw ProviderNetworkError(`Network error: ${e.message}`);
  }

  if (!res.ok) {
    const text = await safeReadText(res);
    res = await renegotiateOutputCap(res, text, { url, headers: buildHeaders(apiKey, extraHeaders), body, budgetKey: 'max_tokens', signal, networkErrLabel: 'Network error' });
    if (!res.ok) {
      const text2 = await safeReadText(res);
      throw ProviderAPIError(`HTTP ${res.status}: ${text2.slice(0, 500)}`);
    }
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
  let finishReason = '';

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
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

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
      const { delta, usage: u, finishReason: fr } = parseSseEvent(event);
      if (u) usage = u;
      if (fr) finishReason = fr;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }

  // Flush any trailing single-newline leftover
  const { delta: trailing, usage: trailingUsage, finishReason: trailingFr } = parseSseEvent(buffer);
  if (trailingUsage) usage = trailingUsage;
  if (trailingFr) finishReason = trailingFr;
  if (trailing) {
    full += trailing;
    if (onDelta) onDelta(trailing);
  }

  // finishReason === 'length' → 输出被 max_tokens 截断（调用方应提示“继续”）；
  // 'stop' / 空 → 正常。此前该信号被丢弃，截断无声无息（真实用户反馈 2026-08-24）。
  return { full, usage, finishReason };
}

function parseSseEvent(eventText) {
  // eventText is the raw SSE event block, may contain "data: ..." lines.
  // Returns { delta: string, usage: object|null, finishReason: string }.
  let acc = '';
  let usage = null;
  let finishReason = '';
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
      // 末块会带 finish_reason（'stop'/'length'）；中间块为 null，取最后一个非空值。
      const fr = obj.choices?.[0]?.finish_reason;
      if (typeof fr === 'string' && fr) finishReason = fr;
    } catch {
      // ignore malformed lines
    }
  }
  return { delta: acc, usage, finishReason };
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
  let messageText = ''; // exact text streamed via message.delta (full also holds <thinking> blocks)
  let usage = null;
  let buffer = '';

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

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
        if (delta) { full += delta; messageText += delta; messageTextLen += delta.length; if (onDelta) onDelta(delta); }

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
        // The old code assumed output always starts with the concatenated
        // message.delta text and sliced blindly — when Hermes post-processes
        // (trim/rewrite) or message.delta carried narration, the real
        // answer's head was silently chopped off. Verify the prefix; on
        // divergence deliver the authoritative output whole.
        if (output && messageText && output.startsWith(messageText)) {
          const remainder = output.slice(messageText.length);
          if (remainder) { full += remainder; messageTextLen += remainder.length; if (onDelta) onDelta(remainder); }
        } else if (output && output.length > messageTextLen) {
          const chunk = (full ? '\n\n' : '') + output;
          full += chunk;
          messageTextLen = output.length;
          if (onDelta) onDelta(chunk);
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


/**
 * OpenAI Responses API (/v1/responses) streaming — for OpenAI-compatible
 * providers that expose the newer responses endpoint (the SAME shape Hermes's
 * buildRunsConversationHistory already emits: input_text / input_image parts).
 *
 * Callbacks:
 *   onDelta(text) — text chunk (response.output_text.delta)
 *
 * Resolves with { full, usage, finishReason } — finishReason is 'length' when
 * the output was cut by the max_output_tokens cap, 'stop'/'completed' when it
 * ended normally, '' when unknown. Mirrors chatStream's contract so callers
 * share the truncation-detection logic.
 */
export async function responsesStream({
  baseUrl, apiKey, model, input, instructions, onDelta, signal, temperature, maxTokens, extraHeaders,
}) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = endpointUrl(baseUrl, '/responses');
  const body = { input, stream: true };
  if (model) body.model = model;
  if (instructions) body.instructions = instructions;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_output_tokens = maxTokens;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey, extraHeaders),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw ProviderNetworkError(`/v1/responses request failed: ${e?.message}`);
  }
  if (!res.ok) {
    const errText = await safeReadText(res);
    res = await renegotiateOutputCap(res, errText, { url, headers: buildHeaders(apiKey, extraHeaders), body, budgetKey: 'max_output_tokens', signal, networkErrLabel: '/v1/responses request failed' });
    if (!res.ok) {
      const errText2 = await safeReadText(res);
      throw ProviderAPIError(`/v1/responses HTTP ${res.status}: ${errText2.slice(0, 500)}`);
    }
  }
  if (!res.body) throw ProviderNetworkError('No response body (stream)');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const abortRef = attachAbortToReader(signal, reader);
  let full = '';
  let usage = null;
  let finishReason = '';
  let inReasoning = false; // inside an open <thinking> block
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
      break;
    }
    if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let sseEvent = '';
      for (const line of event.split('\n')) {
        if (line.startsWith('event: ')) sseEvent = line.slice(7).trim();
      }
      const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { continue; }

      // SSE event name wins (response.output_text.delta etc.), else payload.type.
      const ev = sseEvent || String(obj.type || '');

      if (ev === 'response.reasoning_summary_text.delta' || ev === 'response.reasoning_text.delta') {
        // Reasoning models via /v1/responses: surface the reasoning summary
        // as a <thinking> block (same convention as Hermes/DeepSeek) instead
        // of silently dropping it.
        const delta = String(obj.delta || obj.text || '');
        if (delta) {
          if (!inReasoning) { inReasoning = true; full += '<thinking>\n'; if (onDelta) onDelta('<thinking>\n'); }
          full += delta; if (onDelta) onDelta(delta);
        }
      } else if (ev === 'response.output_text.delta') {
        const delta = String(obj.delta || '');
        if (delta && inReasoning) { inReasoning = false; full += '\n</thinking>\n'; if (onDelta) onDelta('\n</thinking>\n'); }
        if (delta) { full += delta; if (onDelta) onDelta(delta); }
      } else if (ev === 'response.completed') {
        const r = obj.response || obj;
        const u = r.usage;
        if (u) usage = u;
        // Truncation: incomplete_details.reason === 'max_output_tokens' → 'length'
        const incompl = r.incomplete_details || obj.incomplete_details;
        if (incompl?.reason === 'max_output_tokens') finishReason = 'length';
        else finishReason = finishReason || 'completed';
      } else if (ev === 'response.failed') {
        throw ProviderAPIError(String(obj.error?.message || obj.error || 'Response failed'));
      }
    }
  }

  if (inReasoning) { full += '\n</thinking>\n'; if (onDelta) onDelta('\n</thinking>\n'); }
  return { full, usage, finishReason };
}


/**
 * Anthropic Messages API (/v1/messages) streaming — for Anthropic's native
 * format and OpenAI-compatible gateways that proxy it (LiteLLM etc. expose it
 * at the same /v1/messages path). Note max_tokens is REQUIRED by Anthropic, so
 * a non-zero budget is always sent (DEFAULT_MAX_TOKENS fallback when unset).
 *
 * Callbacks:
 *   onDelta(text) — text chunk (content_block_delta / text_delta)
 *
 * Resolves with { full, usage, finishReason }.
 */
export async function anthropicStream({
  baseUrl, apiKey, model, system, messages, onDelta, signal, temperature, maxTokens, extraHeaders,
}) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');

  const url = endpointUrl(baseUrl, '/messages');
  // Anthropic's Messages API has NO default output cap and REQUIRES max_tokens
  // (missing → 400). Without it the server errors out entirely, so a budget is
  // always sent: explicit provider maxTokens, else DEFAULT_MAX_TOKENS (16384).
  const budget = maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
  const body = { model, messages, max_tokens: budget, stream: true };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildAnthropicHeaders(apiKey, extraHeaders),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw ProviderNetworkError(`/v1/messages request failed: ${e?.message}`);
  }
  if (!res.ok) {
    const errText = await safeReadText(res);
    res = await renegotiateOutputCap(res, errText, { url, headers: buildAnthropicHeaders(apiKey, extraHeaders), body, budgetKey: 'max_tokens', signal, networkErrLabel: '/v1/messages request failed' });
    if (!res.ok) {
      const errText2 = await safeReadText(res);
      throw ProviderAPIError(`/v1/messages HTTP ${res.status}: ${errText2.slice(0, 500)}`);
    }
  }
  if (!res.body) throw ProviderNetworkError('No response body (stream)');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const abortRef = attachAbortToReader(signal, reader);
  let full = '';
  let usage = null;
  let finishReason = '';
  let inReasoning = false; // inside an open <thinking> block
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
      break;
    }
    if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let sseEvent = '';
      for (const line of event.split('\n')) {
        if (line.startsWith('event: ')) sseEvent = line.slice(7).trim();
      }
      const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { continue; }

      const ev = sseEvent;
      if (ev === 'content_block_delta') {
        const dtype = obj?.delta?.type;
        if (dtype === 'thinking_delta') {
          // Extended thinking: surface as <thinking> like every other
          // adapter instead of dropping it.
          const t = String(obj.delta.thinking || '');
          if (t) {
            if (!inReasoning) { inReasoning = true; full += '<thinking>\n'; if (onDelta) onDelta('<thinking>\n'); }
            full += t; if (onDelta) onDelta(t);
          }
        } else {
          if (inReasoning) { inReasoning = false; full += '\n</thinking>\n'; if (onDelta) onDelta('\n</thinking>\n'); }
          const delta = dtype === 'text_delta' ? String(obj.delta.text || '') : '';
          if (delta) { full += delta; if (onDelta) onDelta(delta); }
        }
      } else if (ev === 'message_delta') {
        const u = obj?.usage;
        if (u) usage = u;
        const stopReason = obj?.delta?.stop_reason;
        if (stopReason === 'max_tokens') finishReason = 'length';
        else if (stopReason) finishReason = finishReason || 'stop';
      } else if (ev === 'message_stop') {
        // end of stream — break out of the SSE loop
        if (abortRef.aborted) throw new DOMException('Stream aborted', 'AbortError');
        break;
      } else if (ev === 'error') {
        throw ProviderAPIError(String(obj?.error?.message || obj?.error || 'Anthropic error'));
      }
    }
  }

  if (inReasoning) { full += '\n</thinking>\n'; if (onDelta) onDelta('\n</thinking>\n'); }
  return { full, usage, finishReason };
}


function buildHeaders(apiKey, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  if (extraHeaders) Object.assign(h, extraHeaders);
  return h;
}

// Anthropic's official API authenticates via x-api-key and REQUIRES
// anthropic-version (Bearer alone 400s with "version required"). Keep the
// Bearer header too so LiteLLM-style gateways that proxy with Bearer keep
// working through the same config.
function buildAnthropicHeaders(apiKey, extraHeaders) {
  const h = buildHeaders(apiKey, extraHeaders);
  h['x-api-key'] = apiKey || '';
  h['anthropic-version'] = '2023-06-01';
  return h;
}

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

/**
 * 版本感知端点拼接：多数 OpenAI 兼容服务的 base 不含版本段（https://api.openai.com、
 * https://api.deepseek.com、Ollama http://127.0.0.1:11434），端点挂在 /v1/ 下；
 * 方舟式网关把版本段放在 base 里（官方文档给 Cline/Cursor 标注的 base 就是
 * https://ark.cn-beijing.volces.com/api/plan/v3，标准版为 …/api/v3），端点直接挂在
 * base 上——再拼 /v1 会得到 …/v3/v1/chat/completions，plan 网关带 key 也 404
 * （2026-08-28 用户实测）。base 以 /v<数字> 结尾时不重复加版本段；
 * https://api.openai.com/v1 这类显式 /v1 的 base 也因此不会双重拼接。
 * sub 不含 /v1 前缀：'/chat/completions' | '/responses' | '/messages' | '/models' | '/capabilities'。
 */
function endpointUrl(base, sub) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + (/\/v\d+$/.test(b) ? sub : '/v1' + sub);
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
  const url = endpointUrl(baseUrl, '/capabilities');
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
 * Tries /health first (Hermes), then /v1/models (standard OpenAI-compatible).
 * If `model` is provided, also verifies it appears in the /v1/models list.
 * Does NOT send a real inference request — no tokens consumed.
 * Returns a status string: 'ok' or 'ok (model not in list — check name)'.
 */
export async function ping({ baseUrl, apiKey, model, apiStyle }) {
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
      res = await fetch(endpointUrl(baseUrl, '/models'), {
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
      // 404 = the server doesn't do OpenAI-style model listing at all (real
      // case: Hermes/OpenViking — /health 200, /v1/models 404, actual traffic
      // on /v1/runs). With /health already verified live, that's reachable,
      // not dead — same "trust /health for non-standard servers" intent as
      // the network-error branch above. 401/403 still fall through: those
      // mean the key is genuinely wrong.
      if (healthOk && res.status === 404) return 'ok';
      const text = await safeReadText(res);
      throw ProviderAPIError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return 'ok';
  }

  // Model is configured: verify by sending a minimal 1-token request.
  // /v1/models lists are unreliable (gateways may hide or rename models),
  // so an actual call is the only way to be certain the model is valid.
  // The request must go to the provider's configured API endpoint with the
  // matching payload shape — /v1/chat/completions for 'chat', /v1/responses
  // for 'responses', /v1/messages for 'anthropic'.
  const style = apiStyle || 'chat';
  let body;
  if (style === 'anthropic') {
    body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
  } else if (style === 'responses') {
    body = { model, input: 'hi', max_output_tokens: 1, stream: false };
  } else {
    body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
  }
  const endpoint = style === 'anthropic' ? '/messages' : style === 'responses' ? '/responses' : '/chat/completions';
  let res;
  try {
    res = await fetch(endpointUrl(baseUrl, endpoint), {
      method: 'POST',
      headers: style === 'anthropic' ? buildAnthropicHeaders(apiKey) : buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw ProviderNetworkError(`Network error: ${e.message}`);
  }
  if (!res.ok) {
    if (res.status === 404) {
      // Endpoint for this apiStyle doesn't exist on the server — same
      // non-standard-server case as the no-model branch's 404-trust policy.
      // A healthy /health means reachable; don't fail for a routing choice
      // (real case: Hermes-only deployment hit at /v1/chat/completions).
      try {
        const h = await fetch(joinUrl(baseUrl, '/health'), { signal: AbortSignal.timeout(5000) });
        if (h.ok) return 'ok';
      } catch (_) {}
    }
    const text = await safeReadText(res);
    throw ProviderAPIError(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return 'ok';
}
