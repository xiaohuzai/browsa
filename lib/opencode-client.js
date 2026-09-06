// lib/opencode-client.js — client for the opencode agent provider.
//
// `opencode serve` is a first-party headless HTTP server (same architecture
// class as Hermes's /v1/runs: the agent IS the server, every UI is a client).
// All endpoints were verified live against opencode 1.18.29 (2026-09-06);
// the OpenAPI doc served at GET /doc is the authoritative contract.

import { PAGE_CONTEXT_PREFIX } from './constants.js';

// Wire summary (v1.18.29):
//   GET  /api/health                                   → {healthy:true}      (ping)
//   POST /api/session                                  → {data:{id:'ses_…'}} (server-assigned)
//   POST /api/session/{id}/prompt {prompt:{text}}      → returns immediately (delivery:'steer')
//   GET  /api/event                                    → global SSE (text/event-stream)
//   GET  /api/session/active                           → {data:{<sesId>:{type:'running'}}} while busy
//   POST /api/session/{id}/interrupt                   → cancels the running turn
//   POST /api/session/{id}/permission/{reqID}/reply    → {reply:'once'|'always'|'reject'}
//   POST /api/session/{id}/question/{reqID}/reply      → {answers:[[label,…],…]}
//   GET  /api/session/{id}/message                     → {data:[…messages]} (final content/tokens)
//
// Event stream specifics that cost real debugging time (do not "simplify"):
//   • Text deltas flow ONLY on the global streams (/api/event, /event). The
//     per-session stream (GET /api/session/{id}/event) is lifecycle-only —
//     it replays durable history then emits step/text/tool start/end events
//     but never session.next.text.delta.
//   • The spec lists session.idle / message.updated but opencode 1.18.29
//     never emits them. Turn completion is observed via /api/session/active
//     (the session disappears from the map) — that endpoint returns
//     {data:{<sesId>:{type:'running'}}} while a turn runs, {} when idle.
//   • The global stream starts with a burst of fanfare events
//     (server.connected, plugin.added, catalog.updated, …). Events are
//     filtered by sessionID; a startTimestamp floor drops replays.
//   • Abort: the server emits session.next.step.failed with
//     {error:{message:'Provider turn interrupted'}}; browsa treats user
//     cancel as ABORTED client-side regardless (chat-handler owns that
//     chunk), so the client just stops listening and fires /interrupt.
//
// Images are NOT forwarded in v1: prompt attachments take {uri,name} and the
// accepted uri schemes for remote clients are not documented; browsa history
// keeps the images for the record (same stance squilla shipped first).

const DEFAULT_BASE_URL = 'http://127.0.0.1:4096';

/** Normalize a user-typed opencode base URL. Empty → default; strips
 * trailing slashes and any /path (the server is root-mounted). */
export function normalizeOpencodeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  return withScheme.replace(/\/+$/, '').replace(/(https?:\/\/[^/]+)\/.*$/, '$1');
}

function headers(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function apiFetch({ baseUrl, apiKey, path, method = 'GET', body, signal }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    throw new Error(`opencode ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return text; }
}

/** Build the single prompt string for an opencode turn.
 *
 * The opencode server keeps its own per-session transcript and runs its own
 * agent pipeline — browsa sends only the user's turn, never a rebuilt chat
 * history or system prompt (both would fight the agent's own context
 * management). Page context is the exception: it lives only in browsa's
 * local history and the server has never seen it, so the trailing run of
 * page-context user turns IS forwarded (one attach = one turn; consecutive
 * attaches before a question are forwarded together). Later questions rely
 * on the server retaining that turn in its own session transcript.
 * Interleaved text parts (图文交错条目) are ALL joined — taking only the
 * first segment silently drops the body (squilla lesson, 2026-09-01).
 * Images are not forwarded (see module comment). Exported for unit tests. */
export function buildOpencodeTurn(msg, history) {
  const parts = [];
  const contexts = [];
  for (let i = (history?.length || 0) - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== 'user') break;
    let text = null;
    if (typeof m.content === 'string' && m.content.startsWith(PAGE_CONTEXT_PREFIX)) {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const texts = m.content
        .filter(p => p?.type === 'text' && typeof p.text === 'string')
        .map(p => p.text);
      const joined = texts.join('\n');
      if (texts.some(t => t.startsWith(PAGE_CONTEXT_PREFIX)) && joined.trim()) text = joined;
    }
    if (!text) break;
    contexts.unshift(text);
  }
  if (contexts.length) {
    // Tell the agent the content is attached locally, so it answers from it
    // instead of habitually fetching the URL itself.
    contexts.push('（注：以上是用户已在本地附加的完整页面内容——含全部文字与截图，回答时直接基于它，不要重新访问或抓取该 URL。）');
    parts.push(...contexts);
  }
  if (msg?.userText) parts.push(msg.userText);
  return parts.join('\n\n');
}

/** Ping the server. Reachable ⇔ /api/health answers {healthy:true}. */
export async function pingOpencode({ baseUrl, apiKey, signal } = {}) {
  const url = normalizeOpencodeUrl(baseUrl);
  try {
    const j = await apiFetch({ baseUrl: url, apiKey, path: '/api/health', signal });
    return { ok: j?.healthy === true, url };
  } catch (e) {
    return { ok: false, url, error: e?.message };
  }
}

/** Create a server-side session (id is server-assigned: `ses_…`). */
export async function createOpencodeSession({ baseUrl, apiKey, title, signal } = {}) {
  const url = normalizeOpencodeUrl(baseUrl);
  const j = await apiFetch({ baseUrl: url, apiKey, path: '/api/session', method: 'POST', body: title ? { title } : {}, signal });
  const id = j?.data?.id;
  if (!id) throw new Error('opencode session create: no id in response');
  return id;
}

export async function respondOpencodePermission({ baseUrl, apiKey, sessionId, requestId, reply, signal } = {}) {
  const url = normalizeOpencodeUrl(baseUrl);
  await apiFetch({
    baseUrl: url, apiKey,
    path: `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
    method: 'POST', body: { reply }, signal,
  });
  return { ok: true };
}

export async function respondOpencodeQuestion({ baseUrl, apiKey, sessionId, requestId, answers, signal } = {}) {
  const url = normalizeOpencodeUrl(baseUrl);
  await apiFetch({
    baseUrl: url, apiKey,
    path: `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    method: 'POST', body: { answers }, signal,
  });
  return { ok: true };
}

/** Fire-and-forget server-side interrupt (used on user cancel — after the
 * SSE read is gone the turn would keep running headless otherwise). */
async function interruptSession({ baseUrl, apiKey, sessionId }) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    await apiFetch({
      baseUrl: normalizeOpencodeUrl(baseUrl), apiKey,
      path: `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      method: 'POST', signal: ctrl.signal,
    });
  } catch (_) { /* best-effort */ }
}

async function fetchFinalMessage({ baseUrl, apiKey, sessionId, signal }) {
  const j = await apiFetch({
    baseUrl: normalizeOpencodeUrl(baseUrl), apiKey,
    path: `/api/session/${encodeURIComponent(sessionId)}/message`, signal,
  });
  const list = Array.isArray(j?.data) ? j.data : [];
  // The list is ordered NEWEST-FIRST (verified live against 1.18.29). One
  // turn can span SEVERAL assistant messages (a textless tool-call leg +
  // the text leg), so "last assistant in the array" is both the oldest
  // entry and often the wrong one — pick the assistant with the max
  // time.created, and sum tokens over the assistant legs newer than the
  // newest user message (the turn's own usage).
  let newestUser = 0;
  for (const m of list) if (m?.type === 'user') newestUser = Math.max(newestUser, m.time?.created ?? 0);
  let last = null;
  let turnIn = 0;
  let turnOut = 0;
  let sawTurnTokens = false;
  for (const m of list) {
    if (m?.type !== 'assistant') continue;
    const c = m.time?.created ?? 0;
    if (!last || c >= (last.time?.created ?? 0)) last = m;
    if (c > newestUser) {
      sawTurnTokens = true;
      turnIn += m.tokens?.input ?? 0;
      turnOut += m.tokens?.output ?? 0;
    }
  }
  if (!last) return { full: '', usage: null, finishReason: '' };
  const full = (last.content || [])
    .filter(p => p?.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n');
  const usage = sawTurnTokens
    ? { prompt_tokens: turnIn, completion_tokens: turnOut }
    : { prompt_tokens: last.tokens?.input ?? 0, completion_tokens: last.tokens?.output ?? 0 };
  return { full, usage, finishReason: last.finish || '' };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** Run one opencode turn and stream it back through browsa's callbacks.
 *
 * Returns { full, usage, finishReason, sessionId } — the same shape the
 * llm-client stream adapters return, so handleChat's continuation/rewrite
 * plumbing works unchanged. */
export async function opencodeStream({
  baseUrl, apiKey, sessionId, text,
  onDelta, onToolProgress, onApproval, onClarify,
  signal,
  _fetchActive,   // test seam: override the active-sessions poll
  _pollIntervalMs = 1200,
}) {
  const url = normalizeOpencodeUrl(baseUrl);
  if (!sessionId) throw new Error('opencode: sessionId required');
  if (!text || !String(text).trim()) throw new Error('opencode: empty turn');

  // 1. Submit the prompt (async server-side; returns the admitted user msg).
  await apiFetch({
    baseUrl: url, apiKey,
    path: `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    method: 'POST',
    body: { prompt: { text } },
    signal,
  });

  // 2. Consume the global SSE + poll /api/session/active concurrently.
  const controller = new AbortController();
  const onOuterAbort = () => {
    controller.abort();
    // Keep the server-side agent from running headless after the listener
    // is gone (user cancel / panel closed / idle timeout).
    interruptSession({ baseUrl: url, apiKey, sessionId });
  };
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const startTs = Date.now();
  let full = '';
  let errorMessage = null;
  let sawSignal = false;          // any lifecycle event / positive active sighting
  let done = false;

  const sseResult = (async () => {
    const res = await fetch(`${url}/api/event`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`opencode event stream → ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Race reads against our own abort: a REAL network stream rejects reads
    // when the fetch signal fires, but this must also terminate for a mocked
    // locally-constructed Response body in unit tests (read() would pend
    // forever there).
    let aborted = false;
    const abortPend = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    });
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch (_) { return; }
      const data = j?.data;
      if (!data || data.sessionID !== sessionId) return;
      if (typeof data.timestamp === 'number' && data.timestamp < startTs - 5000) return; // replay
      sawSignal = true;
      switch (j.type) {
        case 'session.next.text.delta': {
          if (typeof data.delta === 'string' && data.delta) {
            full += data.delta;
            if (onDelta) onDelta(data.delta);
          }
          break;
        }
        case 'session.next.tool.called': {
          const name = data.tool || data.action || 'tool';
          if (onToolProgress) onToolProgress(`🔧 ${name}`);
          break;
        }
        case 'permission.v2.asked': {
          if (onApproval) {
            onApproval({
              requestId: data.id,
              tool: data.action || 'tool',
              command: Array.isArray(data.resources) ? data.resources.join(' ') : '',
              choices: ['once', 'always', 'deny'],
            });
          }
          break;
        }
        case 'question.v2.asked': {
          if (onClarify) {
            const qs = Array.isArray(data.questions) ? data.questions : [];
            const question = qs.map(q => [q?.header, q?.question].filter(Boolean).join('：') ||
              (q?.options || []).map(o => o?.label).filter(Boolean).join(' / '))
              .join('\n');
            onClarify({ requestId: data.id, question: question || 'Please clarify' });
          }
          break;
        }
        case 'session.error': {
          errorMessage = data.error?.message || data.error?.type || 'session error';
          done = true; // the turn is over — stop the active-poll loop
          break;
        }
        default:
          break;
      }
    };
    for (;;) {
      if (aborted) break;
      const result = await Promise.race([
        reader.read(),
        abortPend.then(() => 'aborted'),
      ]);
      if (result === 'aborted' || aborted) break;
      const { value, done: streamDone } = result;
      if (value) {
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      }
      if (streamDone) break;
    }
    try { reader.cancel().catch(() => {}); } catch (_) {}
    if (aborted) return 'sse-aborted';
    return 'sse-end';
  })().catch((e) => {
    // AbortError = we (poll loop / outer signal / final cleanup) closed the
    // stream ourselves — not a failure. Anything else kills the turn.
    if (e?.name === 'AbortError') return 'sse-aborted';
    errorMessage = errorMessage || e?.message;
    done = true;
    controller.abort();
    return 'sse-error';
  });

  const pollActive = _fetchActive || (async () => {
    const j = await apiFetch({ baseUrl: url, apiKey, path: '/api/session/active', signal: controller.signal });
    return j?.data || {};
  });

  const pollLoop = (async () => {
    // First tick is delayed: the POST reply races the worker marking the
    // session active, so disappearance is only meaningful after we've seen
    // the session busy at least once (or any lifecycle event arrived).
    try {
      while (!done) {
        await sleep(_pollIntervalMs, controller.signal);
        let active;
        try { active = await pollActive(); }
        catch (e) {
          if (e?.name === 'AbortError') return;
          continue; // transient poll failure — the SSE stream still flows
        }
        const busy = Object.prototype.hasOwnProperty.call(active, sessionId);
        if (busy) { sawSignal = true; continue; }
        if (sawSignal) { done = true; return; }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') throw e;
    }
  })();

  // Whichever watcher finishes first ends the turn. Both are self-catching
  // (only real failures reject), so Promise.race can't leak a rejection.
  const winner = await Promise.race([
    pollLoop.then(() => 'poll'),
    sseResult,
  ]);
  // Drain window: when the active-poll ends the turn first, give the SSE
  // reader a moment to deliver deltas already buffered in the socket before
  // cutting the stream (cosmetic — DONE.full is fetched authoritatively
  // below, but the live bubble should not visibly lose its tail).
  if (winner === 'poll') {
    await Promise.race([sseResult, new Promise(r => setTimeout(r, 250))]);
  }
  controller.abort(); // stop the loser watcher's in-flight fetch/poll
  await sseResult.catch(() => {});

  if (signal?.aborted) {
    const err = new DOMException('Aborted', 'AbortError');
    throw err;
  }
  if (errorMessage) throw new Error(errorMessage);

  // 3. Pull the authoritative final assistant message (text + token usage).
  const finalMsg = await fetchFinalMessage({ baseUrl: url, apiKey, sessionId, signal });
  return {
    full: finalMsg.full || full,
    usage: finalMsg.usage,
    finishReason: finalMsg.finishReason,
    sessionId,
  };
}
