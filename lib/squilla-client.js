// lib/squilla-client.js — OpenSquilla gateway wire protocol (WebSocket RPC).
//
// OpenSquilla (https://github.com/opensquilla) is a local desktop agent whose
// gateway speaks a JSON frame protocol over a single WebSocket at
// ws://127.0.0.1:18791/ws (contracts/gateway/v4 in its repo):
//
//   server → client : {type:'event', event:'connect.challenge', payload:{nonce}, seq}
//                     {type:'hello-ok', protocol, server:{version, conn_id}, features:{methods}}
//                     {type:'event', event:'session.event.text_delta', payload:{task_id, text}, seq}
//                     {type:'res', id, ok, payload, error}
//   client → server : {type:'req', id, method:'connect'|'chat.send'|'chat.abort'|..., params}
//
// Handshake: the first frame MUST be a `connect` req (any inbound frame resets
// the gateway's 120s client-keepalive timer; long turns get periodic cheap
// `agent.identity.get` calls below). Turn flow: sessions.messages.subscribe
// (delta stream) → chat.send (accepted → task_id) → session.event.* frames →
// terminal (session.event.done / task.succeeded / sessions.changed task_terminal).
//
// One WS connection per turn, opened and closed inside squillaStream(): the
// MV3 service worker may sleep between turns, so nothing here outlives one
// chat turn. The sidepanel rendering contract (CHUNK/DONE/ERROR vocabulary)
// is unchanged — chat-handler.js maps squillaStream onto the same callbacks
// runsApiStream uses.

import { ProviderConfigError, ProviderNetworkError, ProviderAPIError } from './llm-client.js';

const PREAUTH_TIMEOUT_MS = 10_000;   // challenge → connect → hello-ok budget
const SEND_TIMEOUT_MS = 20_000;      // chat.send / subscribe res budget
const KEEPALIVE_INTERVAL_MS = 30_000; // < gateway's 120s client keepalive
const ABORT_GRACE_MS = 500;          // time for the chat.abort frame to reach the gateway before ws.close()

/**
 * Accept http(s)://, ws(s)://, bare host:port and bare 'ws' paths — the
 * options card accepts whatever the user pastes (the README example is
 * ws://127.0.0.1:18791/ws). ws://127.0.0.1:18791 → ws://127.0.0.1:18791/ws.
 */
export function normalizeSquillaUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw ProviderConfigError('OpenSquilla gateway URL is required');
  // http→ws / https→wss in one replace ('https' minus 'http' is 's').
  u = u.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(u)) u = 'ws://' + u.replace(/^\/+/, '');
  const p = new URL(u);
  if (p.pathname === '/' || p.pathname === '') p.pathname = '/ws';
  return p.toString();
}

/** Default sessionKey for a fresh OpenSquilla conversation. */
export function squillaSessionKey() {
  return `agent:main:browsa:${crypto.randomUUID()}`;
}

class SquillaSocket {
  constructor(url, apiKey) {
    this.url = url;
    this.apiKey = apiKey;
    this.ws = null;
    this.keepaliveTimer = null;
    this.keepaliveSeq = 0;
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(ProviderNetworkError(`WebSocket construction failed: ${e?.message}`));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        // The browser WebSocket API does not expose the HTTP status of a
        // rejected handshake, so a gateway-side 403 (origin guard: the
        // extension origin must be listed in cors.allowed_origins — see
        // README "OpenSquilla") and a dead gateway look identical here.
        reject(ProviderNetworkError('OpenSquilla gateway WebSocket handshake failed — is the gateway running, and is this extension origin listed in its cors.allowed_origins?'));
      }, PREAUTH_TIMEOUT_MS);
      const cleanup = () => clearTimeout(timer);
      ws.addEventListener('open', () => { cleanup(); resolve(ws); }, { once: true });
      ws.addEventListener('error', () => {
        cleanup();
        reject(ProviderNetworkError('OpenSquilla gateway WebSocket handshake failed — is the gateway running, and is this extension origin listed in its cors.allowed_origins?'));
      }, { once: true });
      ws.addEventListener('close', () => {
        cleanup();
        reject(ProviderNetworkError('OpenSquilla gateway closed the connection during handshake'));
      }, { once: true });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * Challenge → connect req → hello-ok. The connect reply is a dedicated
   * `hello-ok` frame (not a `res`); failures arrive as a normal error res.
   * Returns the hello-ok frame.
   */
  async handshake() {
    const challenge = await this.nextFrame(PREAUTH_TIMEOUT_MS);
    if (challenge?.event !== 'connect.challenge') {
      throw ProviderAPIError('OpenSquilla gateway did not send connect.challenge');
    }
    const connectParams = { minProtocol: 1, maxProtocol: 99 };
    if (this.apiKey) connectParams.auth = { token: this.apiKey };
    this.send({ type: 'req', id: 'connect', method: 'connect', params: connectParams });
    const hello = await this.nextFrame(PREAUTH_TIMEOUT_MS);
    if (hello?.type === 'res' && hello.ok === false) {
      const err = hello.error || {};
      throw err.code === 'UNAUTHORIZED'
        ? ProviderConfigError(`OpenSquilla gateway rejected the API key (${err.message || 'UNAUTHORIZED'})`)
        : ProviderAPIError(`OpenSquilla connect failed: ${err.code || ''} ${err.message || ''}`.trim());
    }
    if (hello?.type !== 'hello-ok') {
      throw ProviderAPIError('OpenSquilla gateway did not answer the connect request');
    }
    this.startKeepalive();
    return hello;
  }

  /**
   * Any inbound client frame resets the gateway's client_ws_keepalive timer
   * (default 120s). A turn with no outgoing traffic for that long would be
   * disconnected mid-stream, so ping a cheap read-only method periodically.
   * The unmatched `res` replies are skipped by nextFrame()/drainEvents().
   */
  startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.closed || !this.ws || this.ws.readyState !== 1) return;
      try {
        this.keepaliveSeq += 1;
        this.send({ type: 'req', id: `ka-${this.keepaliveSeq}`, method: 'agent.identity.get', params: {} });
      } catch (_) {}
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepalive() {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  /**
   * Resolve the next frame whose type === 'req' reply ('res') and id matches.
   * Interleaved frames (keepalive replies, events) are consumed and dropped
   * here — during an active turn the event loop owns event dispatch.
   */
  async call(method, params, timeoutMs = SEND_TIMEOUT_MS) {
    const id = `rq-${crypto.randomUUID().slice(0, 8)}`;
    this.send({ type: 'req', id, method, params });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw ProviderNetworkError(`OpenSquilla gateway did not answer ${method}`);
      const frame = await this.nextFrame(remaining);
      if (frame?.type === 'res' && frame.id === id) {
        if (frame.ok === false) {
          const err = frame.error || {};
          throw ProviderAPIError(`OpenSquilla ${method} failed: ${err.code || 'ERROR'} ${err.message || ''}`.trim());
        }
        return frame.payload ?? {};
      }
      // else: keep waiting (keepalive replies / unrelated frames)
    }
  }

  nextFrame(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.ws || this.ws.readyState !== 1) {
        reject(ProviderNetworkError('OpenSquilla gateway connection closed'));
        return;
      }
      const ws = this.ws;
      const timer = setTimeout(() => {
        cleanup();
        reject(ProviderNetworkError(`OpenSquilla gateway frame timeout`));
      }, timeoutMs);
      const onMessage = (ev) => {
        let data;
        try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (_) { return; }
        // JSON-parse failures (binary/keepalive noise) stay subscribed.
        cleanup();
        resolve(data);
      };
      const onClose = () => { cleanup(); reject(ProviderNetworkError('OpenSquilla gateway connection closed')); };
      const onError = () => { cleanup(); reject(ProviderNetworkError('OpenSquilla gateway connection error')); };
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
      }
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    });
  }

  /**
   * Invoke `onEvent(frame)` for every subsequent event frame until it returns
   * a truthy value (the terminal). Rejects on connection loss. Returns the
   * terminal frame's value, or null when the socket closes without one.
   */
  drainEvents(onEvent, signal) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        signal?.removeEventListener?.('abort', onAbort);
        fn(val);
      };
      const onMessage = (ev) => {
        let frame;
        try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (_) { return; }
        if (frame?.type !== 'event') return; // keepalive replies etc.
        try {
          if (onEvent(frame)) finish(resolve, frame);
        } catch (e) {
          finish(reject, e);
        }
      };
      const onClose = () => finish(resolve, null);
      const onError = () => finish(reject, ProviderNetworkError('OpenSquilla gateway connection error'));
      const onAbort = () => finish(resolve, null); // abort handled by squillaStream
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  close() {
    this.closed = true;
    this.stopKeepalive();
    try { this.ws?.close(); } catch (_) {}
  }
}

/**
 * Create a gateway session for a cli-class client.
 *
 * sessions.send requires an existing session — unlike chat.send it does NOT
 * auto-create one, and it does not accept a client-chosen key
 * (`sessions.create` generates `agent:main:cli:<8hex>` for kind 'cli').
 * Returns the session key string.
 */
export async function createSquillaSession({ baseUrl, apiKey }) {
  const url = normalizeSquillaUrl(baseUrl);
  const sock = new SquillaSocket(url, apiKey);
  try {
    await sock.open();
    await sock.handshake();
    const created = await sock.call('sessions.create', { agentId: 'main', kind: 'cli' });
    const key = created.key || created.sessionKey;
    if (!key) throw ProviderAPIError('OpenSquilla sessions.create returned no session key');
    return key;
  } finally {
    sock.close();
  }
}

/**
 * Upload a text document to the gateway's staging store (POST
 * /api/v1/files/upload, multipart field `file`). Returns the `file_uuid` to
 * reference from a sessions.send attachment. Used for large page contexts:
 * as an uploaded material file the agent reads it with its own tools in
 * chunks — no model-context capacity limit (an inline 370k-char message
 * dies with LargeContextCapacityError at the prompt assembler).
 */
export async function uploadSquillaFile({ baseUrl, apiKey, name, mime, content }) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  const origin = normalizeSquillaUrl(baseUrl)
    .replace(/^wss/i, 'https').replace(/^ws/i, 'http')
    .replace(/\/ws\/?$/, '');
  const form = new FormData();
  form.append('file', new Blob([content], { type: mime }), name);
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(`${origin}/api/v1/files/upload`, {
      method: 'POST', headers, body: form, signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw ProviderNetworkError(`OpenSquilla file upload failed: ${e?.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      throw ProviderNetworkError('OpenSquilla file upload rejected by origin guard — is this extension origin listed in the gateway cors.allowed_origins?');
    }
    if (res.status === 401) throw ProviderConfigError('OpenSquilla file upload requires the gateway token (set it as the API key)');
    throw ProviderAPIError(`OpenSquilla file upload HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const payload = await res.json().catch(() => null);
  if (!payload?.file_uuid) throw ProviderAPIError('OpenSquilla file upload returned no file_uuid');
  return payload.file_uuid;
}

/**
 * Stream one OpenSquilla chat turn over the gateway WebSocket.
 *
 * Callbacks (same contract as runsApiStream):
 *   onDelta(text)        — assistant text chunk (or a <thinking> block)
 *   onToolProgress(text) — reserved for tool lifecycle events (v1: unused)
 *   onTaskId(taskId)     — fires once the send is accepted (for cancel UIs)
 *
 * Resolves with { full, usage: null, finishReason } where finishReason is
 * 'completed' after a normal terminal event. Throws AbortError when `signal`
 * fires (the server-side task is cancelled via chat.abort before closing).
 * Throw ProviderAPIError on task failure / gateway error responses.
 */
export async function squillaStream({
  baseUrl, apiKey, message, sessionKey, attachments,
  onDelta, onToolProgress, onTaskId,
  signal,
}) {
  if (!baseUrl) throw ProviderConfigError('baseUrl is required');
  if (!sessionKey) throw ProviderConfigError('sessionKey is required — create one via createSquillaSession()');
  if (signal?.aborted) throw new DOMException('Stream aborted', 'AbortError');

  const url = normalizeSquillaUrl(baseUrl);

  const sock = new SquillaSocket(url, apiKey);
  // Abort path: tell the gateway to cancel the task (otherwise the agent
  // keeps executing server-side after the panel's cancel — the WS view
  // closing does NOT stop it), then close. The gateway currently sends NO
  // terminal event after an abort (its turn cleanup crashes; reported
  // upstream), so we resolve/throw locally without waiting for one.
  const onAbort = () => {
    try {
      sock.send({ type: 'req', id: `ab-${Date.now()}`, method: 'chat.abort', params: { sessionKey } });
    } catch (_) {}
    setTimeout(() => sock.close(), ABORT_GRACE_MS);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let full = '';
  let inThinking = false;
  const closeThinking = () => {
    if (inThinking) { inThinking = false; full += '\n</thinking>\n'; if (onDelta) onDelta('\n</thinking>\n'); }
  };

  try {
    await sock.open();
    const hello = await sock.handshake();
    // Success is intentionally silent — other backends announce nothing on
    // connect; the first delta is the signal. (A version line here used to
    // render as a permanent TOOL_PROGRESS row in the panel.)

    // Subscribe to the session's message stream BEFORE chat.send so no delta
    // of this turn is missed (events for past turns are replayed only if a
    // stream was in flight; we filter everything by task_id anyway).
    await sock.call('sessions.messages.subscribe', { key: sessionKey });

    let taskId = '';
    let sawDelta = false;
    const onFrame = (frame) => {
      const ev = String(frame.event || '');
      const p = frame.payload || {};
      // Every turn-scoped event carries task_id; when we know ours, ignore
      // other tasks' events (a stale task still streaming in this session).
      const pTask = p.task_id || p.taskId || '';
      if (taskId && pTask && pTask !== taskId) return false;

      if (ev === 'session.event.text_delta') {
        const t = String(p.text || '');
        if (t) {
          sawDelta = true;
          closeThinking();
          full += t;
          if (onDelta) onDelta(t);
        }
        return false;
      }
      if (ev === 'thinking' || ev === 'session.event.thinking') {
        const t = String(p.text || p.delta || '');
        if (t) {
          if (!inThinking) { inThinking = true; full += '<thinking>\n'; if (onDelta) onDelta('<thinking>\n'); }
          full += t;
          if (onDelta) onDelta(t);
        }
        return false;
      }
      if (ev === 'session.event.done') return true;
      if (ev === 'task.succeeded') return true;
      if (ev === 'task.failed') {
        throw ProviderAPIError(String(p.error || p.error_message || p.message || 'OpenSquilla task failed'));
      }
      if (ev === 'task.cancelled') {
        throw new DOMException('OpenSquilla task cancelled', 'AbortError');
      }
      if (ev === 'sessions.changed' && ['task_terminal', 'task_failed', 'task_cancelled'].includes(p.reason)) {
        const st = p.last_task || {};
        if (taskId && st.task_id && st.task_id !== taskId) return false;
        if (st.status === 'failed') {
          // Terminal events often carry no reason (it lives in the gateway's
          // server log) — surface whatever context exists instead of a bare
          // "task failed" so field reports stay diagnosable.
          const detail = [st.error, st.error_message, st.terminal_reason, st.status]
            .filter(Boolean).join(' · ');
          throw ProviderAPIError(`OpenSquilla task failed${detail ? ` (${detail})` : ''}`);
        }
        if (st.status === 'cancelled') {
          throw new DOMException('OpenSquilla task cancelled', 'AbortError');
        }
        return true;
      }
      return false;
    };

    // One attempt = sessions.send + event drain. If the gateway's selected
    // model rejects image input (its own clean `image_input_unsupported`
    // failure — verified live on 0.5.4), retry exactly once WITHOUT the
    // attachments so a text-only model degrades gracefully instead of
    // failing the whole turn.
    let terminal = null;
    let pendingAttachments = Array.isArray(attachments) && attachments.length ? attachments : null;
    for (let attempt = 0; ; attempt++) {
      full = '';
      inThinking = false;
      sawDelta = false;
      const sent = await sock.call('sessions.send', {
        key: sessionKey,
        message,
        clientRequestId: crypto.randomUUID(),
        _source: { caller_kind: 'cli', channel_kind: 'cli' },
        ...(pendingAttachments ? { attachments: pendingAttachments } : {}),
      });
      taskId = sent.task_id || sent.taskId || '';
      if (onTaskId && taskId) onTaskId(taskId);
      try {
        terminal = await sock.drainEvents(onFrame, signal);
        break;
      } catch (e) {
        // Image fallback: a turn that carried images and failed before
        // streaming a single delta is treated as a possible model-side image
        // rejection. The gateway's terminal event often carries NO reason
        // string (details live only in its server log), so matching on the
        // message alone missed the case in the field — retry on "no delta
        // yet" instead; if the failure was unrelated to images, the retry
        // fails the same way and the (annotated) error surfaces as before.
        // The degradation is intentionally silent (user preference): the
        // router frequently picks text-only models, so the note fired on
        // nearly every figure-bearing attach and read as noise.
        const reasonHit = /image_input_unsupported|cannot process image input/i.test(String(e?.message || ''));
        if (attempt === 0 && pendingAttachments && !sawDelta && (reasonHit || !String(e?.message || '').trim() || /task failed/i.test(String(e?.message || '')))) {
          pendingAttachments = null;
          continue;
        }
        throw e;
      }
    }

    closeThinking();
    if (!terminal) {
      // No terminal event on this connection. Three distinct cases:
      // user abort (throw AbortError so chat-handler treats the turn as
      // cancelled and skips the history write — same contract as
      // chatStream/runsApiStream), gateway restart / network drop with
      // nothing streamed (throw), or a drop after partial output (resolve
      // with what streamed — nothing more will arrive on this connection).
      if (signal?.aborted) throw new DOMException('Stream aborted', 'AbortError');
      if (!full) throw ProviderNetworkError('OpenSquilla gateway closed the connection before the task finished');
    }
    return { full, usage: null, finishReason: 'completed' };
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Stream aborted', 'AbortError');
    throw e;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    sock.close();
  }
}

/**
 * Connectivity probe for the options page (mirrors ping() in llm-client.js).
 * Completes the real handshake — no inference request, no tokens consumed.
 * Returns a human-readable status string; throws Provider*Error otherwise.
 */
export async function pingSquilla({ baseUrl, apiKey }) {
  const url = normalizeSquillaUrl(baseUrl);
  const sock = new SquillaSocket(url, apiKey);
  try {
    await sock.open();
    const hello = await sock.handshake();
    const version = hello?.server?.version || 'unknown';
    const methods = hello?.features?.methods?.length;
    return `ok — gateway v${version}${methods ? ` · ${methods} methods` : ''}`;
  } finally {
    sock.close();
  }
}
