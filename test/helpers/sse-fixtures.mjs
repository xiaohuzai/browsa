// test/helpers/sse-fixtures.mjs — the ONE place test files build an SSE wire stream.
//
// 22 local stubs across 15 files settled on four names (buildSseStream / sseResponse /
// sseFor / mockFetchWithStream) and had already drifted: one copy serialized raw wire
// objects and appended `data: [DONE]`, the other six only accepted {event, data} and
// never appended it. That difference is not cosmetic — the reader's framing rules
// (`event:` names via sseEventName, multi-line `data:` via sseDataPayload, the [DONE]
// sentinel) are exactly what these tests exist to pin, so they belong in one fixture.
//
// Shapes produced here mirror the wire, not a mock's convenience: each block becomes
//   optional `event: <name>\n` followed by `data: <json>\n\n`.
//
// Use:
//   sseStream([{ event: 'response.output_text.delta', data: { delta: 'x' } }])
//   sseStreamRaw([{ type: 'choices', choices: [...] }], { appendDone: true })
//   globalThis.fetch = sseFetch(blocks)                 // ok/status/body/text
//   sseResponseFromChunks(['data: a\n\n', 'data: b\n\n'])  // one enqueue per chunk

const encoder = new TextEncoder();

/** Raw text of an SSE body for `blocks` of the {event?, data} shape. */
export function sseBytesText(blocks) {
  let text = '';
  for (const b of blocks) {
    if (b && b.event) text += `event: ${b.event}\n`;
    text += `data: ${typeof b?.data === 'string' ? b.data : JSON.stringify(b?.data)}\n\n`;
  }
  return text;
}

/** A one-chunk ReadableStream of the {event?, data} blocks (what a response body is). */
export function sseStream(blocks) {
  const bytes = encoder.encode(sseBytesText(blocks));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Same, for blocks that ARE the wire object (chat-completions style, no `event:`
 * line). `appendDone` adds the OpenAI `data: [DONE]` sentinel.
 */
export function sseStreamRaw(objects, { appendDone = false } = {}) {
  let text = '';
  for (const o of objects) {
    if (o && o.event) text += `event: ${o.event}\n`;
    text += `data: ${JSON.stringify(o && o.data !== undefined ? o.data : o)}\n\n`;
  }
  if (appendDone) text += 'data: [DONE]\n\n';
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Chat-completions stream carrying ONE content delta — the shape the summarize /
 * repair / attach tests stage when all they need is "the model said <text>". */
export function sseChatContent(text) {
  return sseStreamRaw([{ choices: [{ delta: { content: text } }] }]);
}

/** A ReadableStream that enqueues one chunk per entry (framing edge cases). */
export function sseStreamFromChunks(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

/**
 * fetch()-shaped stub returning a 200 SSE body. The client reader only touches
 * ok/status/body/text, so a plain object is enough (no Response needed).
 * `capture` receives `{ url, body }` when the caller wants the request inspected.
 */
export function sseFetch(blocks, { capture, status = 200, body } = {}) {
  return async (url, opts) => {
    if (capture) {
      capture.url = String(url);
      if (opts?.body) capture.body = JSON.parse(opts.body);
    }
    return { ok: status < 400, status, body: body || sseStream(blocks), text: async () => '' };
  };
}

/**
 * A chunk-wise REAL Response — use when the code under test reads status/headers or
 * an abort path needs a genuine stream (bridge, opencode). `holdOpen` leaves the body
 * unclosed so a test can observe a stream that never ends.
 */
export function sseHttpResponse(chunks, { status = 200, holdOpen = false } = {}) {
  const body = holdOpen
    ? new ReadableStream({
        start(c) { for (const chunk of chunks) c.enqueue(encoder.encode(chunk)); },
        cancel() {},
      })
    : sseStreamFromChunks(chunks);
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * The plain response-LIKE object most clients in this repo consume (they read only
 * ok/status/body/text/headers.get). Pass `headers`/`text` only when the caller
 * actually reads them — an always-present field can hide an accidental dependency.
 */
export function sseResponseLike(chunks, { status = 200, headers, text } = {}) {
  const res = { ok: status < 400, status, body: sseStreamFromChunks(chunks) };
  if (headers) res.headers = headers;
  if (text) res.text = text;
  return res;
}
