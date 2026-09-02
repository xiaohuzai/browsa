// lib/codebuddy-client.js — browsa ⇄ WorkBuddy (Tencent CodeBuddy) over
// Chrome Native Messaging.
//
// WorkBuddy's engine is the CodeBuddy CLI, which ships an OFFICIAL headless
// mode (docs: codebuddy.ai/docs/cli/headless): `--input-format stream-json
// --output-format stream-json` runs a long-lived process consuming JSONL user
// messages on stdin and emitting typed events on stdout — the same
// engine-holds-the-history model as Codex's app-server. The generic NM bridge
// (the com.agentbridge.codebuddy host installed by agent-bridge) pipes frames
// to that process; this module speaks the protocol:
//
//   client → engine: {"type":"user","message":{"role":"user","content":[...]}}
//   engine → client: {"type":"system","subtype":"init","session_id",...}
//                    {"type":"assistant","message":{content:[text|tool_use]}}
//                    {"type":"user","message":{...tool_result...}}   (skipped)
//                    {"type":"task_started"|"task_progress"|..., task_id, ...}
//                    {"type":"result","subtype","is_error","result","usage"}
//
// Wire facts: per the official headless docs, non-interactive runs require
// `-y` (baked into the install command) and `--permission-prompt-tool` is NOT
// supported — so v1 has no approval cards: the WorkBuddy card's hint says so.
// Assistant text arrives as complete messages (no partial deltas), same shape
// the codex client already handles. Session continuity via `--resume <id>`,
// injected through the bridge's control frame ({"argv":["--resume", id]}).

import { ProviderAPIError, ProviderConfigError } from './llm-client.js';

export const CODEBUDDY_NM_HOST = 'com.agentbridge.codebuddy';

// Same port lifecycle as CodexConnection minus request/id matching — the
// stream-json protocol is type-tagged, there is nothing to correlate.
class CodebuddyConnection {
  constructor() {
    this.onEvent = null;
    this.closed = false;
    this.disconnectReason = null;
    this._onClose = null;

    this.port = chrome.runtime.connectNative(CODEBUDDY_NM_HOST);
    this.port.onMessage.addListener((msg) => {
      if (msg && msg.error && msg.code) {
        // Bridge startup failure frame: {"error":{code,message}} (not a
        // protocol event) — surface it via the close path.
        this.disconnectReason = msg.message || msg.code;
        this._fail();
        return;
      }
      this.onEvent?.(msg);
    });
    this.port.onDisconnect.addListener(() => {
      this.disconnectReason = chrome.runtime.lastError?.message || null;
      this._fail();
    });
  }

  _fail() {
    if (this.closed) return;
    this.closed = true;
    this._onClose?.();
  }

  send(obj) {
    try { this.port.postMessage(obj); } catch (e) {
      throw ProviderAPIError(`WorkBuddy 连接不可用：${e?.message || e}`);
    }
  }

  disconnect() {
    if (!this.closed) {
      this.closed = true;
      try { this.port.disconnect(); } catch (_) { /* already gone */ }
    }
  }
}

// data: URL → CodeBuddy image content block (base64 source). Returns null for
// anything that isn't an image data URL (http(s) URLs are skipped — the local
// history keeps them; pasting remote images is a future concern).
function dataUrlToImageBlock(url) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(url || ''));
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

// Resume flags for the bridge control frame. Elements MUST stay within
// [A-Za-z0-9._-] — the bash shim drops anything else rather than trust it.
function resumeArgv(sessionId) {
  return sessionId && /^[A-Za-z0-9._-]+$/.test(sessionId) ? ['--resume', sessionId] : [];
}

function truncate(s, n = 80) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function toolUsePreview(name, input) {
  const first = input && (input.command || input.file_path || input.path || input.pattern
    || input.query || input.url || input.prompt);
  return first ? `${name}: ${truncate(typeof first === 'string' ? first : JSON.stringify(first))}` : name;
}

/**
 * Stream one WorkBuddy turn.
 *
 * @param {object} opts
 * @param {string} opts.message            user text (page context baked in by caller)
 * @param {string[]} [opts.images]         pasted image data: URLs → base64 blocks
 * @param {string|null} opts.sessionId     CodeBuddy session to resume ("" = fresh)
 * @param {(id: string) => void} [opts.onSessionId]  fired with the session id
 *                          from the init event (new or resumed) for persistence
 * @param {(delta: string) => void} opts.onDelta
 * @param {(text: string) => void} opts.onToolProgress
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{full: string, usage: object|null, finishReason: undefined}>}
 */
export async function codebuddyStream({
  message,
  images = null,
  sessionId = null,
  onSessionId,
  onDelta,
  onToolProgress,
  signal,
}) {
  const conn = new CodebuddyConnection();
  const cleanup = () => conn.disconnect();

  // Abort = drop the port; Chrome kills the bridge process and codebuddy with
  // it (no in-band interrupt exists in the headless protocol). Same contract
  // as codexStream: throw AbortError even with partial text already streamed.
  let waitReject = null;
  const abortErr = () => new DOMException('Aborted', 'AbortError');
  const onAbort = () => {
    cleanup();
    waitReject?.(abortErr());
  };
  if (signal) {
    if (signal.aborted) { cleanup(); throw abortErr(); }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let full = '';
  let usage = null;
  let failure = null;
  let done = false;

  const emitDelta = (delta) => {
    if (!delta) return;
    full += delta;
    onDelta(delta);
  };

  conn.onEvent = (ev) => {
    switch (ev?.type) {
      case 'system': {
        if (ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id) {
          onSessionId?.(ev.session_id);
        }
        break;
      }
      case 'assistant': {
        const blocks = ev.message?.content;
        if (typeof blocks === 'string') { emitDelta(blocks); break; }
        if (!Array.isArray(blocks)) break;
        for (const b of blocks) {
          if (b?.type === 'text' && typeof b.text === 'string') {
            emitDelta(b.text);
          } else if (b?.type === 'tool_use' && b.name) {
            onToolProgress?.(`workbuddy ▶ ${toolUsePreview(b.name, b.input)}`);
          }
        }
        break;
      }
      case 'task_started':
      case 'task_progress':
      case 'task_updated': {
        // CodeBuddy background-task events (official headless docs): useful
        // progress lines; details land in the turn's result anyway.
        const label = ev.type === 'task_started' ? '后台任务' : ev.type === 'task_progress' ? '后台进度' : '后台更新';
        const what = truncate(ev.description || ev.summary || ev.task_id || '');
        if (what) onToolProgress?.(`workbuddy ${label}: ${what}`);
        break;
      }
      case 'result': {
        done = true;
        if (ev.usage && typeof ev.usage === 'object') {
          const u = ev.usage;
          const inTok = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
          const outTok = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
          usage = {
            input_tokens: inTok,
            output_tokens: outTok,
            total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : inTok + outTok,
          };
        }
        if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'))) {
          failure = ev.result || ev.error || `result subtype ${ev.subtype || 'error'}`;
        }
        onEventDone?.();
        break;
      }
      default:
        break; // stream events, control requests from the CLI, ... — v1 noise
    }
  };

  // Terminal plumbing shared by the result event and the death path.
  let onEventDone = null;
  const settled = new Promise((resolve, reject) => {
    waitReject = reject;
    onEventDone = () => {
      if (failure && !full) reject(ProviderAPIError(`WorkBuddy：${failure}`));
      else resolve();
    };
    conn._onClose = () => {
      if (done && !failure) resolve(); // engine exited right after result — fine
      else reject(ProviderAPIError(
        `WorkBuddy 连接断开${conn.disconnectReason ? `：${conn.disconnectReason}` : ''}`,
      ));
    };
  });

  try {
    // Bridge control frame first ({"argv":[...]}), then the user message.
    conn.send({ argv: resumeArgv(sessionId) });
    const blocks = [{ type: 'text', text: message }];
    for (const url of images || []) {
      const img = dataUrlToImageBlock(url);
      if (img) blocks.push(img);
    }
    conn.send({ type: 'user', message: { role: 'user', content: blocks } });

    await settled;
    if (failure && full) {
      // Engine produced text then errored — surface the error, keep it simple.
      throw ProviderAPIError(`WorkBuddy：${failure}`);
    }
    if (!full && failure) throw ProviderAPIError(`WorkBuddy：${failure}`);
    return { full, usage, finishReason: undefined };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    cleanup();
  }
}

/**
 * Options-page connectivity probe: handshake through the bridge and wait for
 * the CLI's init event (its arrival proves the binary spawned, the flags were
 * accepted and the engine is live). Distinguishes bridge-missing from
 * engine-broken so the UI can point at the right fix.
 */
export async function codebuddyPing() {
  const conn = new CodebuddyConnection();
  const died = new Promise((resolve) => { conn._onClose = () => resolve({ ok: false, reason: conn.disconnectReason }); });
  const toFail = (e) => ({ ok: false, reason: e?.message || String(e) });
  try {
    conn.send({ argv: [] }); // control frame (empty) before anything else
    const race = await Promise.race([
      new Promise((resolve) => {
        conn.onEvent = (ev) => {
          if (ev?.type === 'system' && ev.subtype === 'init') resolve({ ok: true, event: ev });
        };
      }),
      died,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 15000)),
    ]);
    if (!race.ok) {
      const r = race.reason || '';
      if (/forbidden|not found|cannot be found|has exited|连接断开|已关闭|没找到/i.test(r)) {
        throw ProviderConfigError('WorkBuddy 桥接未安装或未包含本扩展的 ID —— 先在下方生成并运行安装命令');
      }
      throw ProviderConfigError(`WorkBuddy 桥接不可用：${r || '连接断开'}`);
    }
    const model = race.event?.model || '';
    const version = race.event?.version || '';
    const bits = [version && `codebuddy ${version}`, model && `模型 ${model}`].filter(Boolean).join(' · ');
    return `ok — ${bits || 'codebuddy 已连接'}`;
  } finally {
    conn.disconnect();
  }
}
