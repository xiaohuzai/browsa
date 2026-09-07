// lib/bridge-client.js — client for the agent-bridge provider.
//
// agent-bridge (github.com/xiaohuzai/agent-bridge) is a tiny standalone daemon
// the user runs next to their CLI agent (codex first; any ACP v2 agent via
// its generic adapter). The wire protocol (v1) it speaks is documented in
// that repo's server.mjs:
//
//   GET  /health                 → {ok:true, agent, version, proto:1}
//   POST /turns {text,sessionId} → SSE: start/delta/tool/approval/usage/
//                                  done/aborted/error events (": ka" comments
//                                  are keepalives)
//   POST /approvals/:id {choice} → answer a pending approval card
//
// The bridge's agent keeps its own per-session transcript — like opencode,
// browsa sends only the user's turn (plus the trailing run of attached
// page-context turns). Aborting = closing the POST /turns connection; the
// bridge notices the disconnect and interrupts the agent server-side.

const DEFAULT_BASE_URL = 'http://127.0.0.1:3948';

/** Normalize a user-typed bridge base URL. Empty → default; strips trailing
 * slashes and any /path (the bridge is root-mounted). */
export function normalizeBridgeUrl(input) {
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

/** Ping the bridge. Reachable ⇔ /health answers {ok:true, proto:1}. */
export async function pingBridge({ baseUrl, apiKey, signal } = {}) {
  const url = normalizeBridgeUrl(baseUrl);
  try {
    const res = await fetch(`${url}/health`, { headers: headers(apiKey), signal });
    if (!res.ok) throw new Error(`bridge /health → ${res.status}`);
    const j = await res.json().catch(() => null);
    if (j?.ok !== true) throw new Error('bridge /health: not ok');
    return { ok: true, url, agent: j.agent || '', version: j.version || '' };
  } catch (e) {
    return { ok: false, url, error: e?.message };
  }
}

/** Answer a pending approval. choice ∈ 'once' | 'always' | 'deny'. */
export async function respondBridgeApproval({ baseUrl, apiKey, requestId, choice, signal } = {}) {
  const url = normalizeBridgeUrl(baseUrl);
  const res = await fetch(`${url}/approvals/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ choice }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    throw new Error(`bridge approval → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return { ok: true };
}

/** Run one bridge turn and stream it back through browsa's callbacks.
 *
 * Returns { full, usage, finishReason, sessionId } — the same shape the
 * llm-client stream adapters and opencodeStream return, so handleChat's
 * continuation/rewrite plumbing works unchanged. finishReason is always ''
 * (output-cap truncation is the agent's own business, not a wire signal). */
export async function bridgeStream({
  baseUrl, apiKey, sessionId, text,
  onDelta, onToolProgress, onApproval, onSessionId, onHeartbeat,
  signal,
}) {
  const url = normalizeBridgeUrl(baseUrl);
  if (!text || !String(text).trim()) throw new Error('bridge: empty turn');

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const res = await fetch(`${url}/turns`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ text, ...(sessionId ? { sessionId } : {}) }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    throw new Error(`bridge /turns → ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = null;
  let sid = sessionId || null;
  let errorMessage = null;
  let ended = false; // saw done/aborted/error

  // Race reads against our own abort: aborting the fetch signal does NOT
  // terminate reads on a locally-constructed Response body in unit tests
  // (real network streams do) — the opencode-client lesson.
  let aborted = false;
  const abortPend = new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
  });

  const handleLine = (line) => {
    if (line.startsWith(':')) { if (onHeartbeat) onHeartbeat(); return; }
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let e;
    try { e = JSON.parse(payload); } catch (_) { return; }
    switch (e.type) {
      case 'start': {
        if (typeof e.sessionId === 'string' && e.sessionId && e.sessionId !== sid) {
          sid = e.sessionId;
          if (onSessionId) onSessionId(sid);
        }
        break;
      }
      case 'delta': {
        if (typeof e.text === 'string' && e.text) {
          full += e.text;
          if (onDelta) onDelta(e.text);
        }
        break;
      }
      case 'tool': {
        if (onToolProgress) {
          const st = e.status === 'started' ? '▶' : '✓';
          onToolProgress(`${st} ${e.name || 'tool'}${e.detail ? `: ${e.detail}` : ''}`);
        }
        break;
      }
      case 'approval': {
        if (onApproval) {
          onApproval({
            requestId: e.requestId,
            tool: e.tool || 'command',
            command: e.command || e.cwd || '',
            choices: ['once', 'always', 'deny'],
          });
        }
        break;
      }
      case 'usage': {
        if (e && typeof e.prompt_tokens === 'number') {
          usage = { prompt_tokens: e.prompt_tokens, completion_tokens: e.completion_tokens ?? 0 };
        }
        break;
      }
      case 'done': {
        ended = true;
        if (typeof e.full === 'string' && e.full && !full) full = e.full;
        break;
      }
      case 'aborted': {
        ended = true;
        break;
      }
      case 'error': {
        ended = true;
        errorMessage = e.message || 'bridge agent error';
        break;
      }
      default:
        break;
    }
  };

  try {
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
  } finally {
    try { reader.cancel().catch(() => {}); } catch (_) {}
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (errorMessage) throw new Error(errorMessage);
  if (!ended && !signal?.aborted) {
    // Stream ended without a terminal event (bridge crash / network cut
    // mid-turn). Surface it instead of silently treating a partial as done.
    throw new Error('bridge: stream ended without a terminal event');
  }
  return { full, usage, finishReason: '', sessionId: sid };
}
