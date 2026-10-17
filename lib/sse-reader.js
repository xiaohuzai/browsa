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
// dispatchers do after buffering.

const decoder = new TextDecoder('utf-8');

/**
 * @param {ReadableStreamDefaultReader} reader
 * @param {object} opts
 * @param {() => boolean} opts.isAborted  polled before each read
 * @param {Promise<any>} [opts.abortPend]  resolves when the caller aborts
 * @param {(line: string) => void} opts.onLine
 * @returns {Promise<'done'|'aborted'>}
 */
export async function readSseLines(reader, { isAborted = () => false, abortPend = null, onLine }) {
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
