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
//
// Structure (C1): the fetch → error classification → output-budget
// renegotiation → reader/abort wiring → `\n\n` SSE splitting → { full, usage,
// finishReason } wrap-up pipeline — plus the ONE shared <thinking> open/close
// state machine — lives in openSseStream(). Each protocol keeps only:
//   1. buildXRequest()  — its payload + wire-error shape;
//   2. parseXEvent()    — its SSE event semantics as a pure
//      (eventText, state) -> { delta?, think?, block?, usage?, finishReason?,
//      closeThink?, stop? } mapping;
//   3. a few protocol hooks (chatStream's raw hermes.tool.progress / approval
//      interception, runsApiStream's two-phase run creation + tool/approval
//      forwarding + its ADR-0004 echo guard).

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
 *
 * 返回 { res, text }：text 是**尚未被消费**的响应体文本。errText 传进来时已经
 * 读过原 res.body，所以原样返回时必须把它带回（调用方再 safeReadText(res) 只会
 * 拿到 ''，把所有 401/403/404/500 的服务器原话吞掉——真实 bug）；重试拿到新 res
 * 时则读它的 body。调用方用 text 构造错误，不再二次读 body。
 */
async function renegotiateOutputCap(res, errText, { url, headers, body, budgetKey, signal, networkErrLabel }) {
  const requested = body[budgetKey] || 0;
  const retry = outputCapRetryBudget(errText, requested);
  if (!retry) return { res, text: errText };
  try {
    const res2 = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, [budgetKey]: retry }),
      signal,
    });
    return { res: res2, text: res2.ok ? '' : await safeReadText(res2) };
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
 * The one SSE skeleton every streaming protocol runs through (C1). It owns the
 * whole transport pipeline — fetch, error classification, output-budget
 * renegotiation, reader/abort wiring, `\n\n` event splitting, and the
 * { full, usage, finishReason } wrap-up — plus the shared <thinking> open/close
 * state machine. A protocol adapter supplies:
 *
 *   Request shape (buildXRequest):
 *     url / method / headers / body — the wire request. `body` is the OBJECT
 *             (renegotiation rewrites body[budgetKey] and re-stringifies).
 *     budgetKey — the output-budget field name, or null to skip renegotiation
 *             (runsApiStream never renegotiates).
 *     networkErrLabel / httpErrLabel / httpErrMax — byte-stable error wording
 *             per protocol (`${networkErrLabel}: …` / `${httpErrLabel} ${status}:
 *             …`); error-classifier matches on these strings, keep them exact.
 *     fetchAbortStyle — 'signal' (chatStream: abort() with a STRING reason
 *             rejects fetch with that raw string — no .name/.message — so
 *             re-raise a real AbortError when the signal is aborted, or the
 *             cancel looks like a network failure and gets retried) or
 *             'error' (rethrow a genuine AbortError from the rejection).
 *     requireBody — false for runs' events GET (it never carried the
 *             'No response body (stream)' guard).
 *
 *   Event parsing (pure-ish): parseEvent(eventText, state) — the raw SSE event
 *   block in, one semantic emission out ({} when the block carries nothing):
 *     delta?       — visible text to append;
 *     think?       — raw reasoning fragment: wrapped in ONE <thinking>…</thinking>
 *             run when opts.thinking === 'inline', dropped when 'omit' (the
 *            default — every non-chat consumer wants clean text);
 *     block?       — a complete self-contained emission appended verbatim
 *             (runsApiStream's reasoning.available <thinking> blocks; it
 *             bypasses the open/close machine on purpose — see the ADR-0004
 *             echo guard in createRunsEventParser);
 *     closeThink?  — close an open think run even when the delta is empty
 *             (anthropicStream's non-text content_block_delta);
 *     usage? / finishReason? — applied last-non-empty-wins; a parser that needs
 *             "keep the existing value" semantics reads state.finishReason;
 *     stop?        — end the read loop (runs run.completed, anthropic
 *             message_stop); fatal events (run.failed, response.failed, …)
 *             throw from inside parseEvent instead.
 *
 *   Hooks:
 *     onRawEvent(eventText) -> true — the block was consumed BEFORE parsing
 *             (chatStream matches hermes.tool.progress / approval requests on
 *             the RAW SSE text);
 *     flushTail — parse the trailing buffer after the read loop (chatStream
 *             only; the other three drop a trailing partial event).
 *
 *   `state` is the live accumulator shared with parseEvent:
 *     full / usage / finishReason — current values (runs' ADR-0004 echo guard
 *             and its run.completed reconciliation read `full`;
 *             responses/anthropic apply `finishReason || default` rules);
 *     aborted — abortRef mirror (anthropicStream's message_stop re-check);
 *     hasOnDelta — whether the caller passed an onDelta sink (runsApiStream
 *             gates its think-block emission on one existing).
 */
async function openSseStream({
  url, method = 'POST', headers, body,
  budgetKey = null, networkErrLabel, httpErrLabel, httpErrMax = 500,
  fetchAbortStyle = 'error', requireBody = true,
  signal, thinking = 'omit', onDelta,
  parseEvent, onRawEvent = null, flushTail = false,
}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    // abort() with a STRING reason ('user-cancel'/'idle-timeout') makes fetch
    // reject with that raw string — no .name, no .message. Re-raise as a real
    // AbortError so chat-handler's cancel classification sees it; wrapping it
    // as ProviderNetworkError('Network error: undefined') here used to make
    // an aborted request look like a network failure and get retried.
    if (fetchAbortStyle === 'signal') {
      if (signal?.aborted) throw new DOMException('Stream aborted', 'AbortError');
    } else if (e?.name === 'AbortError') {
      throw e;
    }
    throw ProviderNetworkError(`${networkErrLabel}: ${e?.message}`);
  }

  if (!res.ok) {
    let text = await safeReadText(res);
    if (budgetKey) {
      const neg = await renegotiateOutputCap(res, text, { url, headers, body, budgetKey, signal, networkErrLabel });
      res = neg.res;
      text = neg.text;
    }
    if (!res.ok) {
      throw ProviderAPIError(`${httpErrLabel} ${res.status}: ${text.slice(0, httpErrMax)}`);
    }
  }
  if (requireBody && !res.body) {
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

  const state = {
    full: '',
    usage: null,
    finishReason: '',
    get aborted() { return abortRef.aborted; },
    hasOnDelta: !!onDelta,
  };

  // Shared reasoning-model thinking state machine: 'inline' wraps the whole
  // reasoning run in ONE <thinking> block — the same inline shape the runs/
  // responses/anthropic paths inject — so render.js's think-block handling
  // (live collapsible while streaming, final details block) shows it in the
  // main chat and the detail thread. Default 'omit' drops it entirely, which
  // is what every non-chat consumer wants (summarizer, mermaid-repair,
  // selection-explain must receive clean text only).
  let inReasoning = false;
  const push = (text) => { state.full += text; if (onDelta) onDelta(text); };
  const applyEmission = (p) => {
    if (p.usage) state.usage = p.usage;
    if (p.finishReason) state.finishReason = p.finishReason;
    if (p.think && thinking === 'inline') {
      if (!inReasoning) { inReasoning = true; push('<thinking>\n'); }
      push(p.think);
    }
    if ((p.delta || p.closeThink) && inReasoning) { inReasoning = false; push('\n</thinking>\n'); }
    if (p.block) push(p.block);
    if (p.delta) push(p.delta);
  };

  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      // reader.cancel() (called from the abort listener) makes the
      // next read() resolve with done=true — it does NOT reject. So
      // we have to re-throw the AbortError ourselves here, otherwise
      // the stream resolves normally and the half-baked reply gets
      // persisted to history as if the LLM had actually finished.
      if (abortRef.aborted) {
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
    let stopped = false;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (onRawEvent && onRawEvent(event)) continue;
      const parsed = parseEvent(event, state) || {};
      applyEmission(parsed);
      if (parsed.stop) { stopped = true; break; }
    }
    if (stopped) break;
  }

  // Flush any trailing single-newline leftover (chatStream only — see
  // `flushTail` in the adapter contract).
  if (flushTail) applyEmission(parseEvent(buffer, state) || {});
  // Reasoning run still open at stream end (no content ever followed it):
  // close it defensively so the final render never sees an unclosed tag.
  if (inReasoning) push('\n</thinking>\n');

  // finishReason === 'length' → 输出被 max_tokens 截断（调用方应提示“继续”）；
  // 'stop' / 空 → 正常。此前该信号被丢弃，截断无声无息（真实用户反馈 2026-08-24）。
  return { full: state.full, usage: state.usage, finishReason: state.finishReason };
}


/**
 * Streaming chat. Calls onDelta(text) for each chunk. Resolves with
 * { full, usage, finishReason } — finishReason is 'length' when the output
 * was cut by the max_tokens cap (callers should surface a hint), 'stop' or
 * '' when it ended normally. Aborts via the AbortSignal.
 */
export async function chatStream({ baseUrl, apiKey, model, messages, onDelta, onToolProgress, onApproval, onClarify, signal, extraHeaders, temperature, maxTokens, thinking = 'omit' }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  return openSseStream({
    ...buildChatRequest({ baseUrl, apiKey, model, messages, extraHeaders, temperature, maxTokens }),
    signal,
    thinking,
    onDelta,
    parseEvent: parseChatEvent,
    onRawEvent: makeChatEventHooks({ onToolProgress, onApproval, onClarify }),
    flushTail: true,
  });
}

// chatStream's request shape (/v1/chat/completions).
function buildChatRequest({ baseUrl, apiKey, model, messages, extraHeaders, temperature, maxTokens }) {
  const body = { messages, stream: true, stream_options: { include_usage: true } };
  if (model) body.model = model;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  return {
    url: endpointUrl(baseUrl, '/chat/completions'),
    headers: buildHeaders(apiKey, extraHeaders),
    body,
    budgetKey: 'max_tokens',
    networkErrLabel: 'Network error',
    httpErrLabel: 'HTTP',
    fetchAbortStyle: 'signal',
  };
}

// chatStream's protocol hooks: Hermes tool-progress / approval / clarification
// events are matched on the RAW SSE block and consume it before parsing (they
// carry no choices[] payload — feeding them to parseChatEvent would be a
// no-op, but the raw match also fires on malformed JSON, by design).
function makeChatEventHooks({ onToolProgress, onApproval, onClarify }) {
  if (!onToolProgress && !onApproval && !onClarify) return null;
  return (event) => {
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
      return true;
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
      return true;
    }
    return false;
  };
}

// chatStream's SSE event parser (pure). eventText is the raw SSE event block,
// may contain several "data: ..." lines. Returns { delta, think, usage,
// finishReason } — delta is the visible content, think the RAW reasoning text
// (DeepSeek-style `reasoning_content`, or `reasoning` on some gateways) that
// openSseStream's thinking wrapper turns into a <thinking> run.
function parseChatEvent(eventText) {
  let acc = '';
  let thinkAcc = '';
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
      const d = obj.choices?.[0]?.delta;
      if (d && typeof d === 'object') {
        if (typeof d.content === 'string') acc += d.content;
        const r = typeof d.reasoning_content === 'string' ? d.reasoning_content
                : typeof d.reasoning === 'string' ? d.reasoning : '';
        if (r) thinkAcc += r;
      }
      // Capture usage from stream_options: { include_usage: true } response
      if (obj.usage) usage = obj.usage;
      // 末块会带 finish_reason（'stop'/'length'）；中间块为 null，取最后一个非空值。
      const fr = obj.choices?.[0]?.finish_reason;
      if (typeof fr === 'string' && fr) finishReason = fr;
    } catch {
      // ignore malformed lines
    }
  }
  return { delta: acc, think: thinkAcc, usage, finishReason };
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
  const { headers, body } = buildRunsRequest({ apiKey, sessionId, input, instructions, conversationHistory, temperature, maxTokens });

  // Step 1: POST /v1/runs — create the run, get run_id. This two-phase
  // prelude is protocol-specific (openSseStream starts at the subscribe).
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

  // Step 2+3: GET /v1/runs/{id}/events (reusing the same session headers as
  // the POST above so Hermes can correlate the two requests as one client)
  // and parse the SSE event stream through the shared skeleton.
  const { full, usage } = await openSseStream({
    url: joinUrl(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/events`),
    method: 'GET',
    headers: { ...headers, Accept: 'text/event-stream' },
    budgetKey: null,
    networkErrLabel: '/v1/runs/events request failed',
    httpErrLabel: '/v1/runs/events HTTP',
    httpErrMax: 200,
    fetchAbortStyle: 'error',
    requireBody: false,
    signal,
    onDelta,
    parseEvent: createRunsEventParser({ runId, onToolProgress, onApproval, onClarify }),
  });

  return { full, usage, runId };
}

// runsApiStream's request shape (POST /v1/runs body + session headers).
function buildRunsRequest({ apiKey, sessionId, input, instructions, conversationHistory, temperature, maxTokens }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (sessionId) {
    headers['X-Hermes-Session-Id'] = sessionId;
    if (apiKey) headers['X-Hermes-Session-Key'] = `browsa:${sessionId}`;
  }

  const body = { input };
  if (instructions) body.instructions = instructions;
  if (conversationHistory?.length) body.conversation_history = conversationHistory;
  if (sessionId) body.session_id = sessionId;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  return { headers, body };
}

// runsApiStream's SSE event parser. A per-call factory because the parser
// carries the run's message-text bookkeeping (below) and closes over the
// run's callbacks/runId — protocol hooks the skeleton doesn't model.
function createRunsEventParser({ runId, onToolProgress, onApproval, onClarify }) {
  // Tracks how much of `full` came from actual message text (message.delta),
  // as opposed to <thinking> blocks injected by reasoning.available below.
  // run.completed must diff its output against this, not full.length, or
  // thinking-block text gets mistaken for already-streamed message text and
  // the real remainder (the model's actual answer) is silently dropped.
  let messageTextLen = 0;
  let messageText = ''; // exact text streamed via message.delta (full also holds <thinking> blocks)

  return function parseRunsEvent(block, state) {
    let sseEvent = '', sseData = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) sseEvent = line.slice(7).trim();
      else if (line.startsWith('data: ')) sseData = line.slice(6).trim();
    }
    if (!sseData || sseData === '[DONE]') return {};

    let obj;
    try { obj = JSON.parse(sseData); } catch (_) { return {}; }

    // Event type: SSE event: line wins, then payload.event, then payload.type
    const ev = sseEvent || String(obj.event || obj.type || '');

    if (ev === 'message.delta') {
      const delta = String(obj.delta || obj.text || '');
      if (!delta) return {};
      messageText += delta;
      messageTextLen += delta.length;
      return { delta };

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
      return {};

    } else if (ev === 'tool.completed') {
      if (onToolProgress) {
        const name = String(obj.name || 'tool');
        onToolProgress(name + (obj.is_error ? ' ✗' : ' ✓'));
      }
      return {};

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
      // ADR-0004: this guard CORRECTLY drops the echo — the replay is
      // byte-identical to the answer already streamed in single-step turns,
      // so displaying it would duplicate the answer. Do NOT "fix" it into
      // showing; the thinking wrapper deliberately never touches this guard.
      const trimmed = text.trim();
      const anchorLen = Math.min(60, trimmed.length);
      const isEchoOfStreamed = anchorLen >= 12 && state.full.includes(trimmed.slice(0, anchorLen));
      if (text && state.hasOnDelta && !isEchoOfStreamed) {
        return { block: `<thinking>\n${text}\n</thinking>\n` };
      }
      return {};

    } else if (ev === 'approval.request') {
      if (onApproval) onApproval({ ...obj, runId });
      return {};

    } else if (ev === 'clarification.request' || ev === 'clarify.request') {
      if (onClarify) onClarify({ ...obj, runId });
      return {};

    } else if (ev === 'run.completed') {
      const output = String(obj.output || '');
      // The old code assumed output always starts with the concatenated
      // message.delta text and sliced blindly — when Hermes post-processes
      // (trim/rewrite) or message.delta carried narration, the real
      // answer's head was silently chopped off. Verify the prefix; on
      // divergence deliver the authoritative output whole.
      const out = {};
      if (output && messageText && output.startsWith(messageText)) {
        const remainder = output.slice(messageText.length);
        if (remainder) { messageTextLen += remainder.length; out.delta = remainder; }
      } else if (output && output.length > messageTextLen) {
        out.delta = (state.full ? '\n\n' : '') + output;
        messageTextLen = output.length;
      }
      const u = obj.usage;
      if (u) out.usage = u;
      out.stop = true;
      return out;

    } else if (ev === 'run.failed') {
      throw ProviderAPIError(String(obj.error || 'Run failed'));

    } else if (ev === 'run.cancelled') {
      throw new DOMException('Run cancelled', 'AbortError');
    }
    return {};
  };
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
  thinking = 'omit',
}) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  return openSseStream({
    ...buildResponsesRequest({ baseUrl, apiKey, model, input, instructions, extraHeaders, temperature, maxTokens }),
    signal,
    thinking,
    onDelta,
    parseEvent: parseResponsesEvent,
  });
}

// responsesStream's request shape (/v1/responses).
function buildResponsesRequest({ baseUrl, apiKey, model, input, instructions, extraHeaders, temperature, maxTokens }) {
  const body = { input, stream: true };
  if (model) body.model = model;
  if (instructions) body.instructions = instructions;
  if (temperature != null) body.temperature = temperature;
  if (maxTokens > 0) body.max_output_tokens = maxTokens;
  return {
    url: endpointUrl(baseUrl, '/responses'),
    headers: buildHeaders(apiKey, extraHeaders),
    body,
    budgetKey: 'max_output_tokens',
    networkErrLabel: '/v1/responses request failed',
    httpErrLabel: '/v1/responses HTTP',
  };
}

// responsesStream's SSE event parser (pure). The /v1/responses event names
// (response.output_text.delta / response.completed) are distinct from
// /v1/chat/completions's choices[0].delta — this parses ITS OWN event shape.
function parseResponsesEvent(event, state) {
  let sseEvent = '';
  for (const line of event.split('\n')) {
    if (line.startsWith('event: ')) sseEvent = line.slice(7).trim();
  }
  const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) return {};
  const payload = dataLine.slice(6).trim();
  if (!payload || payload === '[DONE]') return {};
  let obj;
  try { obj = JSON.parse(payload); } catch (_) { return {}; }

  // SSE event name wins (response.output_text.delta etc.), else payload.type.
  const ev = sseEvent || String(obj.type || '');

  if (ev === 'response.reasoning_summary_text.delta' || ev === 'response.reasoning_text.delta') {
    // Reasoning models via /v1/responses: surface the reasoning summary
    // as a <thinking> block (same convention as Hermes/DeepSeek) instead
    // of silently dropping it — unless the caller asked for clean text
    // only (thinking:'omit', the default for non-chat consumers).
    const delta = String(obj.delta || obj.text || '');
    return delta ? { think: delta } : {};
  }
  if (ev === 'response.output_text.delta') {
    const delta = String(obj.delta || '');
    return delta ? { delta } : {};
  }
  if (ev === 'response.completed') {
    const r = obj.response || obj;
    const u = r.usage;
    // Truncation: incomplete_details.reason === 'max_output_tokens' → 'length'
    const incompl = r.incomplete_details || obj.incomplete_details;
    return {
      usage: u || undefined,
      finishReason: incompl?.reason === 'max_output_tokens' ? 'length' : (state.finishReason || 'completed'),
    };
  }
  if (ev === 'response.failed') {
    throw ProviderAPIError(String(obj.error?.message || obj.error || 'Response failed'));
  }
  return {};
}


/**
 * Prompt caching for /v1/messages: Anthropic caches NOTHING without explicit
 * `cache_control` breakpoints (unlike OpenAI-style implicit prefix caching),
 * so a big attached page context would be re-prefilled at full latency every
 * turn. Two breakpoints — the system prompt and the last message — cover the
 * longest prefix up to each; the moving last-message breakpoint re-caches the
 * extended prefix each turn (standard incremental pattern; Anthropic allows
 * up to 4). Harmless when the prompt is under the cacheable minimum (~1K
 * tokens): no cache entry is written and nothing is billed.
 */
function withAnthropicCacheControl(system, messages) {
  const sysBlocks = system
    ? [{ type: 'text', text: String(system), cache_control: { type: 'ephemeral' } }]
    : system;
  let msgs = messages;
  const last = messages?.[messages.length - 1];
  if (last) {
    const blocks = Array.isArray(last.content)
      ? last.content.map((b) => ({ ...b }))
      : String(last.content ?? '').trim()
        ? [{ type: 'text', text: String(last.content) }]
        : null;
    if (blocks?.length) {
      blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
      msgs = messages.slice();
      msgs[messages.length - 1] = { ...last, content: blocks };
    }
  }
  return { sysBlocks, msgs };
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
  thinking = 'omit',
}) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  return openSseStream({
    ...buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, extraHeaders, temperature, maxTokens }),
    signal,
    thinking,
    onDelta,
    parseEvent: parseAnthropicEvent,
  });
}

// anthropicStream's request shape (/v1/messages).
function buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, extraHeaders, temperature, maxTokens }) {
  // Anthropic's Messages API has NO default output cap and REQUIRES max_tokens
  // (missing → 400). Without it the server errors out entirely, so a budget is
  // always sent: explicit provider maxTokens, else DEFAULT_MAX_TOKENS (16384).
  const budget = maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
  const { sysBlocks, msgs } = withAnthropicCacheControl(system, messages);
  const body = { model, messages: msgs, max_tokens: budget, stream: true };
  if (sysBlocks) body.system = sysBlocks;
  if (temperature != null) body.temperature = temperature;
  return {
    url: endpointUrl(baseUrl, '/messages'),
    headers: buildAnthropicHeaders(apiKey, extraHeaders),
    body,
    budgetKey: 'max_tokens',
    networkErrLabel: '/v1/messages request failed',
    httpErrLabel: '/v1/messages HTTP',
  };
}

// anthropicStream's SSE event parser (pure). Anthropic's event names ride the
// `event:` line only (no payload.type fallback).
function parseAnthropicEvent(event, state) {
  let sseEvent = '';
  for (const line of event.split('\n')) {
    if (line.startsWith('event: ')) sseEvent = line.slice(7).trim();
  }
  const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) return {};
  const payload = dataLine.slice(6).trim();
  if (!payload || payload === '[DONE]') return {};
  let obj;
  try { obj = JSON.parse(payload); } catch (_) { return {}; }

  const ev = sseEvent;
  if (ev === 'content_block_delta') {
    const dtype = obj?.delta?.type;
    if (dtype === 'thinking_delta') {
      // Extended thinking: surface as <thinking> like every other
      // adapter instead of dropping it (thinking:'inline' only — the
      // omit default keeps non-chat consumers' output clean).
      const t = String(obj.delta.thinking || '');
      return t ? { think: t } : {};
    }
    // Any other content_block_delta closes an open think run EVEN with empty
    // text (input_json_delta etc.) — hence closeThink alongside delta.
    const delta = dtype === 'text_delta' ? String(obj.delta.text || '') : '';
    return { delta, closeThink: true };
  }
  if (ev === 'message_delta') {
    const u = obj?.usage;
    const stopReason = obj?.delta?.stop_reason;
    return {
      usage: u || undefined,
      finishReason: stopReason === 'max_tokens' ? 'length' : (stopReason ? (state.finishReason || 'stop') : undefined),
    };
  }
  if (ev === 'message_stop') {
    // end of stream — stop the read loop
    if (state.aborted) throw new DOMException('Stream aborted', 'AbortError');
    return { stop: true };
  }
  if (ev === 'error') {
    throw ProviderAPIError(String(obj?.error?.message || obj?.error || 'Anthropic error'));
  }
  return {};
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
