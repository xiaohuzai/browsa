// lib/sse-reader.js — the line-oriented SSE read loop shared by the two
// WebSocket-free agent clients (bridge-client's POST /turns stream and
// opencode-client's /event stream).
//
// Both had a byte-identical loop: race reader.read() against the caller's
// abort promise, decode incrementally, split on '\n', strip a trailing CR,
// hand each line to the caller's dispatcher, and treat "aborted" as a clean
// exit. The frames differ (each client has its own event vocabulary), so only
// the transport lives here.
//
// `sseDataPayload` (below, moved here from llm-client.js 2026-11-03 audit-4 —
// a transport leaf must not import the whole protocol layer) turns the
// accumulated `data:` lines into a payload. `createSseAggregator` is that
// buffering step itself — extracted 2026-11-03 when both copies were found to
// share one poison bug (a malformed event permanently wedged the stream).
// llm-client.js re-exports sseDataPayload for its own parsers + asr-shared.

// SSE spec: an event's data payload is ALL of its "data:" lines joined with
// '\n' (each minus the field name and one optional space). Every provider
// browsa talks to sends exactly one data line per event, but the spec allows
// splitting one JSON across several — the per-line/first-line extraction this
// replaced would have silently dropped the continuation lines. Comment lines
// (": keep-alive") carry no data and are excluded naturally.
export function sseDataPayload(eventText) {
  const parts = [];
  for (const line of eventText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) parts.push(trimmed.slice(5).trim());
  }
  return parts.join('\n'); // parts are trimmed — no leading/trailing ws possible
}

/**
 * Build the line→event aggregator both agent clients hand to readSseLines'
 * `onLine`. Accumulates `data:` lines and parses them as one JSON event:
 * a single-line event dispatches immediately (兼容不带空行分隔的流); a JSON
 * value split across several `data:` lines parses only once its last line
 * arrives. `handleEvent` is the caller's protocol-specific dispatcher.
 *
 * Poison guard (2026-11-03 audit): a parse failure means two different things.
 * Mid-accumulation (after a `data:` line, no boundary yet) it is a legitimate
 * multi-line intermediate — keep buffering. At an event boundary (a blank or
 * other non-data line) it is a MALFORMED event — discard it. The old code kept
 * the buffer in both cases, so one non-JSON `data:` frame (keepalive text, a
 * corrupt frame, a future event shape) concatenated onto every later event and
 * nothing ever dispatched again (bridge: "stream ended without a terminal
 * event"; opencode: all live deltas lost). Two independent JSON values never
 * concatenate into valid JSON, so discarding at the boundary cannot merge or
 * split a real event.
 *
 * Comment (`:`) lines are ALWAYS an event boundary; `onHeartbeat` is a
 * notification only and must not change frame semantics (2026-11-03 proto-2/
 * audit-3: the old heartbeat-mode early return skipped the boundary discard,
 * reviving the poison bug on no-blank-line streams separated by ': ka').
 * Every `data:` line already dispatches parseable buffers immediately below,
 * so a comment never truncates a COMPLETE event. Known residual: per the SSE
 * spec a comment may sit inside a legal multi-line event — treating it as a
 * boundary drops that unfinished event. That was already the no-heartbeat
 * behavior, and both real producers emit single-line JSON + blank lines, so
 * there is no regression surface. Do NOT add a "clear only on bad frames"
 * heuristic: it cannot tell a bad frame from a legal multi-line intermediate
 * — that ambiguity was the original poison bug.
 *
 * @param {(event: any) => void} handleEvent
 * @param {{ onHeartbeat?: (() => void) | null }} [opts]
 * @returns {((line: string) => void) & { flush: () => void }} call flush() at EOF
 */
export function createSseAggregator(handleEvent, { onHeartbeat = null } = {}) {
  let evLines = [];
  const dispatch = (atBoundary) => {
    if (!evLines.length) return;
    const payload = sseDataPayload(evLines.join('\n'));
    if (!payload || payload === '[DONE]') { evLines = []; return; }
    let e;
    try { e = JSON.parse(payload); } catch (_) {
      if (atBoundary) evLines = []; // 坏事件：丢弃，绝不毒化后续累积
      return;
    }
    evLines = [];
    handleEvent(e);
  };
  const onLine = (line) => {
    if (line.startsWith(':')) {
      dispatch(true);
      if (onHeartbeat) onHeartbeat();
      return;
    }
    if (!line.startsWith('data:')) { dispatch(true); return; }
    evLines.push(line);
    dispatch(false);
  };
  // 流尾无空行收尾的末事件——按边界 flush 一次（拼不成即坏帧丢弃）。
  onLine.flush = () => dispatch(true);
  return onLine;
}

/**
 * @param {ReadableStreamDefaultReader} reader
 * @param {object} opts
 * @param {() => boolean} opts.isAborted  polled before each read
 * @param {Promise<any>} [opts.abortPend]  resolves when the caller aborts
 * @param {(line: string) => void} opts.onLine
 * @returns {Promise<'done'|'aborted'>}
 */
export async function readSseLines(reader, { isAborted = () => false, abortPend = null, onLine }) {
  // PER STREAM, never module-level: TextDecoder is stateful across
  // `{stream:true}` calls. A shared decoder leaked the pending bytes of a
  // multibyte character from stream A into stream B when two bridge/opencode
  // turns overlapped, corrupting B's first line ("�data: …" → event lost).
  // v0.44.3 had one decoder per client loop; the extraction to this module
  // must keep that property.
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    if (isAborted()) return 'aborted';
    const result = abortPend
      ? await Promise.race([reader.read(), abortPend.then(() => 'aborted')])
      : await reader.read();
    if (result === 'aborted' || isAborted()) return 'aborted';
    const { value, done } = result;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    }
    if (done) return 'done';
  }
}

/**
 * Single entry for the line-SSE agent clients (2026-11-03 proto-4): owns the
 * whole five-piece orchestration both consumers used to copy verbatim —
 * aborted flag + abortPend race, aggregator assembly, EOF flush, finally
 * cancel. The ordering constraints live HERE, not in each caller's discipline
 * (opencode's copy had already drifted: its cancel was sequential, skipped
 * whenever readSseLines threw).
 *
 * Contract (pinned in test/sse-reader.test.mjs):
 * - flush runs on BOTH clean exits ('done' and 'aborted') — the unterminated
 *   tail event must not be lost;
 * - on a thrown error (transport OR dispatcher) nothing is flushed and the
 *   error propagates verbatim — opencode's catch classifies it as sse-error;
 * - reader.cancel() always runs in finally;
 * - `signal` should be the client's OWN controller signal (the outer turn
 *   signal stays with the caller for post-stream verdicts).
 *
 * @param {ReadableStream} body
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]
 * @param {(event: any) => void} opts.onEvent
 * @param {(() => void) | null} [opts.onHeartbeat]  notification only (bridge)
 * @returns {Promise<'done'|'aborted'>}
 */
export async function readSseEvents(body, { signal = null, onEvent, onHeartbeat = null } = {}) {
  const reader = body.getReader();
  // Race reads against our own abort: aborting the fetch signal does NOT
  // terminate reads on a locally-constructed Response body in unit tests
  // (real network streams do) — the opencode-client lesson.
  let aborted = Boolean(signal?.aborted);
  const abortPend = signal
    ? new Promise((resolve) => {
        if (aborted) { resolve(); return; }
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      })
    : null;
  const onLine = createSseAggregator(onEvent, { onHeartbeat });
  try {
    const result = await readSseLines(reader, { isAborted: () => aborted, abortPend, onLine });
    onLine.flush(); // 流尾无空行收尾的末事件——两个干净出口都别丢
    return result;
  } finally {
    try { reader.cancel().catch(() => {}); } catch (_) {}
  }
}
