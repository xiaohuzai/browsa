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
// `sseDataPayload` (llm-client.js) is the companion piece: it turns the
// accumulated `data:` lines into a payload, which is what both callers'
// dispatchers do after buffering. `createSseAggregator` (below) is that
// buffering step itself — extracted 2026-11-03 when both copies were found to
// share one poison bug (a malformed event permanently wedged the stream).

import { sseDataPayload } from './llm-client.js';

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
 * Comment (`:`) lines: with `onHeartbeat` they fire it and return (bridge);
 * without one they act as a boundary (opencode's original behavior).
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
      if (onHeartbeat) { onHeartbeat(); return; }
      dispatch(true);
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
