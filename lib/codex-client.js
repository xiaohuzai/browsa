// lib/codex-client.js — browsa ⇄ Codex over Chrome Native Messaging.
//
// Codex's local automation surface is `codex app-server --stdio`: JSON-RPC
// 2.0 (jsonrpc header omitted on the wire), newline-delimited. It is the same
// documented interface that powers the Codex VS Code extension — threads,
// turns, streamed items, approvals — and it needs zero Codex-side changes.
// A browser extension can't spawn processes, so the wire starts at a tiny
// native-messaging host (com.agentbridge.codex, installed once per machine
// page) that Chrome launches and that bridges NM framing (4-byte LE length +
// JSON) to codex's JSONL.
//
// Wire facts verified live against codex-cli 0.149.1 (2026-09-02):
//   • initialize → {userAgent, codexHome, ...}; then an `initialized` notification.
//   • thread/start {} → {thread:{id}}; notifications thread/started etc.
//   • turn/start {threadId, input:[{type:'text',text}]} → {turn:{id, status}}.
//   • Short replies may arrive with NO item/agentMessage/delta at all — the
//     full text lands on item/started AND item/completed. Both are deduped
//     against the streamed prefix (same lesson as the Hermes reasoning echo).
//   • turn/completed carries turn.status 'completed'|'failed'|... and, on
//     failure, turn.error.message. Token usage rides the separate
//     thread/tokenUsage/updated notification (sum of usage.groups).
//   • Approvals are server→client requests `execCommandApproval` /
//     `applyPatchApproval`; the reply is the request id with
//     {decision: 'approved'|'approved_for_session'|'denied'} (snake_case,
//     from ReviewDecision's serde rename).
//   • turn/interrupt {threadId, turnId} stops an in-flight turn.

import { ProviderAPIError, ProviderConfigError } from './llm-client.js';

export const CODEX_NM_HOST = 'com.agentbridge.codex';

// One connection = one Chrome-spawned bridge process = one app-server engine.
// Chrome kills the process when the port disconnects (or the SW dies), which
// also reaps the codex child — no leaks.
class CodexConnection {
  constructor() {
    this.nextId = 1;
    this.pending = new Map(); // request id -> {resolve, reject}
    this.onNotification = null;
    this.onServerRequest = null; // (msg) => respond with conn.respond(msg.id, result)
    this.closed = false;
    this.disconnectReason = null;

    this.port = chrome.runtime.connectNative(CODEX_NM_HOST);
    this.port.onMessage.addListener((msg) => this._dispatch(msg));
    this.port.onDisconnect.addListener(() => {
      this.closed = true;
      // chrome.runtime.lastError is only readable inside this listener.
      this.disconnectReason = chrome.runtime.lastError?.message || null;
      for (const p of this.pending.values()) {
        p.reject(ProviderAPIError(
          `Codex 连接断开${this.disconnectReason ? `：${this.disconnectReason}` : ''}`,
        ));
      }
      this.pending.clear();
      if (this._onClose) this._onClose();
    });
  }

  _dispatch(msg) {
    // Server→client request (approval): has id AND method.
    if (msg.id !== undefined && msg.method) {
      this.onServerRequest?.(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(ProviderAPIError(`Codex ${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.error && !msg.method) {
      // Shim's startup failure frame: {"error":{code,message}} — no pending
      // request will ever resolve, surface it immediately.
      const err = ProviderConfigError(`Codex 桥接失败：${msg.error.message || msg.error.code}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      return;
    }
    if (msg.method) this.onNotification?.(msg);
  }

  call(method, params) {
    if (this.closed) return Promise.reject(ProviderAPIError('Codex 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this._send({ method, params, id });
    }).finally(() => this.pending.delete(id));
  }

  respond(requestId, result) {
    this._send({ id: requestId, result });
  }

  _send(obj) {
    // connectNative serializes plain objects into NM frames itself.
    try { this.port.postMessage(obj); } catch (e) {
      throw ProviderAPIError(`Codex 连接不可用：${e?.message || e}`);
    }
  }

  disconnect() {
    if (!this.closed) {
      this.closed = true;
      try { this.port.disconnect(); } catch (_) { /* already gone */ }
    }
  }
}

// Text helpers shared by the stream mapping -----------------------------------

function truncate(s, n = 80) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function itemCommandText(item) {
  const argv = Array.isArray(item.command) ? item.command : null;
  return argv ? argv.join(' ') : String(item.command || '');
}

// Extract a per-item human progress line from a started/completed item.
// Item type names on the wire are camelCase (userMessage, agentMessage,
// reasoning, commandExecution, mcpToolCall, fileChange, webSearch, ...).
// Hermes-style marks: nothing while running, ✓/✗ on completion.
function itemProgressText(item, phase) {
  const mark = phase === 'done' ? (item.status === 'failed' || item.exitCode ? ' ✗' : ' ✓') : '';
  switch (item.type) {
    case 'commandExecution': {
      const cmd = truncate(itemCommandText(item));
      return `codex 命令: ${cmd}${mark}`;
    }
    case 'mcpToolCall':
      return `codex 工具 ${item.server || ''}${item.tool ? `:${item.tool}` : ''}${mark}`;
    case 'fileChange': {
      const files = Array.isArray(item.changes) ? Object.keys(item.changes).length : null;
      return `codex 改文件${files != null ? ` ×${files}` : ''}${mark}`;
    }
    case 'webSearch':
      return `codex 网页搜索${mark}`;
    case 'reasoning':
    case 'agentMessage':
    case 'userMessage':
      return null; // content, not progress
    default:
      return `codex ${item.type || 'item'}${mark}`;
  }
}

/**
 * Stream one Codex turn. Same callback contract as squillaStream/runsApiStream.
 *
 * @param {object} opts
 * @param {string} opts.message        user text for this turn (page context is
 *                                     expected to be baked in by the caller)
 * @param {string|null} opts.threadId  existing Codex thread to resume; a new
 *                                     thread is started when falsy
 * @param {(id: string) => void} [opts.onThreadId]  fired once with the thread
 *                                     id (new or resumed) so the caller can persist it
 * @param {(delta: string) => void} opts.onDelta
 * @param {(text: string) => void} opts.onToolProgress
 * @param {(data: object) => void} [opts.onApproval]  data includes respond(choice)
 * @param {AbortSignal} opts.signal
 * @returns {Promise<{full: string, usage: object|null, finishReason: undefined}>}
 */
export async function codexStream({
  message,
  threadId = null,
  onThreadId,
  onDelta,
  onToolProgress,
  onApproval,
  signal,
}) {
  const conn = new CodexConnection();
  const cleanup = () => conn.disconnect();

  // Abort: tell the engine to stop the turn, then drop the port (Chrome kills
  // the bridge process and codex with it). Mirror squillaStream's contract —
  // throw AbortError even when partial text was already streamed. Every
  // in-flight await must see the abort: pending requests reject, the
  // turn-wait promise rejects via waitReject, and disconnect closes the port.
  let turnIdForInterrupt = null;
  let waitReject = null;
  const abortErr = () => new DOMException('Aborted', 'AbortError');
  const onAbort = () => {
    const tid = turnIdForInterrupt;
    if (tid) {
      try { conn.port.postMessage({ method: 'turn/interrupt', params: { threadId, turnId: tid } }); } catch (_) {}
    }
    cleanup();
    for (const p of conn.pending.values()) p.reject(abortErr());
    conn.pending.clear();
    waitReject?.(abortErr());
  };
  if (signal) {
    if (signal.aborted) { cleanup(); throw new DOMException('Aborted', 'AbortError'); }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // Streamed/dedup state (see module header: agentMessage text can arrive on
  // item/started AND item/completed, with or without prior deltas).
  let full = '';
  let streamedLen = 0;
  const seenReasoning = new Set();
  let usage = null;
  let failure = null;
  let terminalTurn = null;
  let onTerminal = null;

  const emitDelta = (delta) => {
    if (!delta) return;
    full += delta;
    streamedLen += delta.length;
    onDelta(delta);
  };
  // Emit the part of an agentMessage item's text that deltas didn't cover.
  const emitAgentMessageText = (text) => {
    if (typeof text !== 'string' || !text) return;
    if (full.endsWith(text) && text.length <= streamedLen) return;
    if (text.startsWith(full)) emitDelta(text.slice(full.length));
    else emitDelta(text); // model rewrote history mid-item — surface it raw
  };

  conn.onNotification = (msg) => {
    const { method, params = {} } = msg;
    switch (true) {
      case method === 'item/agentMessage/delta': {
        emitAgentMessageText(params.delta);
        break;
      }
      case method === 'item/started' || method === 'item/completed': {
        const item = params.item || {};
        if (item.type === 'agentMessage') {
          emitAgentMessageText(item.text);
        } else if (item.type === 'reasoning' && method === 'item/completed') {
          const text = (Array.isArray(item.summary) ? item.summary : []).filter(Boolean).join('\n');
          if (text && !seenReasoning.has(item.id)) {
            seenReasoning.add(item.id);
            emitDelta(`<thinking>\n${text}\n</thinking>\n\n`);
          }
        } else {
          const line = itemProgressText(item, method === 'item/completed' ? 'done' : 'started');
          if (line) onToolProgress?.(line);
        }
        break;
      }
      case method === 'thread/tokenUsage/updated': {
        const groups = Array.isArray(params.usage?.groups) ? params.usage.groups : [];
        if (groups.length) {
          const sum = (k) => groups.reduce((n, g) => n + (typeof g[k] === 'number' ? g[k] : 0), 0);
          usage = {
            input_tokens: sum('input_tokens') + sum('cached_input_tokens'),
            output_tokens: sum('output_tokens'),
            total_tokens: sum('total_tokens'),
          };
        }
        break;
      }
      case method === 'error': {
        // Transient reconnect chatter (e.g. "Reconnecting... 1/5") also rides
        // this notification; only the final turn failure decides the outcome.
        const text = params.error?.message;
        if (text && !/^Reconnecting/.test(text)) failure = text;
        break;
      }
      case method === 'turn/completed': {
        // Terminal state is recorded even before the wait below starts — a
        // defensive guard against a terminal frame racing the turn/start
        // response (impossible in the real async stream, free to be safe).
        terminalTurn = params.turn || {};
        onTerminal?.();
        break;
      }
      default:
        break; // thread/started, hook/*, mcpServer/*, configWarning, ... — noise for browsa
    }
  };

  conn.onServerRequest = (req) => {
    if (!/^(execCommandApproval|applyPatchApproval)$/.test(req.method || '')) return;
    const p = req.params || {};
    const data = {
      tool: 'codex',
      command: req.method === 'execCommandApproval'
        ? (Array.isArray(p.command) ? p.command.join(' ') : String(p.command || ''))
        : `修改 ${Object.keys(p.fileChanges || {}).length} 个文件`,
      description: p.reason || (req.method === 'applyPatchApproval'
        ? Object.keys(p.fileChanges || {}).join(', ')
        : p.cwd) || undefined,
      approvalId: p.approvalId || p.callId,
    };
    if (onApproval) {
      onApproval({
        ...data,
        respond: (choice) => {
          // Side panel button vocabulary (showApprovalCard): once / session /
          // always / deny; 'allow'/'allow_session' kept for direct callers.
          const map = { once: 'approved', allow: 'approved', session: 'approved_for_session', allow_session: 'approved_for_session', always: 'approved_for_session', deny: 'denied' };
          const decision = map[choice] || 'approved';
          conn.respond(req.id, { decision });
        },
      });
    } else {
      // No approval UI wired (shouldn't happen in handleChat) — deny loudly
      // so the turn fails instead of hanging forever.
      conn.respond(req.id, { decision: 'denied' });
    }
  };

  try {
    // Control frame (see nm-bridge.sh): argv injected into the baked engine
    // command line. Codex needs none — resume happens in-band via thread/resume.
    conn._send({ argv: [] });
    const init = await conn.call('initialize', {
      clientInfo: { name: 'browsa', title: 'browsa side panel', version: '0.1.0' },
    });
    conn._send({ method: 'initialized' });

    let activeThreadId = threadId;
    if (activeThreadId) {
      try {
        await conn.call('thread/resume', { threadId: activeThreadId });
      } catch (e) {
        // Stored thread may be gone (archived/pruned). Fall through to a fresh
        // thread rather than failing the turn — same recovery posture as a
        // stale OpenSquilla session key.
        console.warn('[browsa] codex thread/resume failed, starting fresh:', e?.message || e);
        activeThreadId = null;
      }
    }
    if (!activeThreadId) {
      const started = await conn.call('thread/start', {});
      activeThreadId = started?.thread?.id;
      if (!activeThreadId) throw ProviderAPIError('Codex thread/start 未返回 thread id');
    }
    onThreadId?.(activeThreadId);

    const turn = await conn.call('turn/start', {
      threadId: activeThreadId,
      input: [{ type: 'text', text: message }],
    });
    turnIdForInterrupt = turn?.turn?.id || null;

    // Wait for terminal turn state. Rejections come from the failed /
    // interrupted branches below, from pending-request cleanup on disconnect,
    // or from onAbort (waitReject).
    await new Promise((resolve, reject) => {
      const settle = () => {
        const t = terminalTurn || {};
        if (t.status === 'failed') {
          reject(ProviderAPIError(`Codex turn 失败：${t.error?.message || failure || '未知错误'}`));
        } else if (t.status === 'interrupted') {
          reject(abortErr());
        } else {
          resolve();
        }
      };
      waitReject = reject;
      if (terminalTurn) { settle(); return; }
      onTerminal = settle;
      // If the port already died (bridge missing), pending-request cleanup
      // rejects `initialize` — but a death mid-turn rejects nothing, so watch
      // for it here too.
      conn._onClose = () => reject(ProviderAPIError(
        `Codex 连接断开${conn.disconnectReason ? `：${conn.disconnectReason}` : ''}`,
      ));
    });

    if (failure && !full) {
      // Engine reported errors yet called the turn "completed" with no text —
      // treat as failure so the user sees something (e.g. auth problems).
      throw ProviderAPIError(`Codex：${failure}`);
    }
    return { full, usage, finishReason: undefined };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    cleanup();
  }
}

/**
 * Options-page connectivity probe: real handshake + model/list through the
 * bridge. Distinguishes the three failure layers so the UI can point at the
 * right fix: bridge not installed / codex binary missing / engine error.
 */
export async function codexPing() {
  const conn = new CodexConnection();
  const died = new Promise((resolve) => { conn._onClose = () => resolve({ ok: false, reason: conn.disconnectReason }); });
  const toFail = (e) => ({ ok: false, reason: e?.message || String(e) });
  try {
    conn._send({ argv: [] }); // control frame before anything else (nm-bridge.sh contract)
    const race = await Promise.race([
      conn.call('initialize', { clientInfo: { name: 'browsa', title: 'browsa options', version: '0.1.0' } })
        .then((result) => ({ ok: true, result }), toFail),
      died,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 15000)),
    ]);
    if (!race.ok) {
      const r = race.reason || '';
      if (/forbidden|not found|cannot be found|has exited|连接断开|已关闭/i.test(r)) {
        throw ProviderConfigError('Codex 桥接未安装或未包含本扩展的 ID —— 先在下方生成并运行安装命令');
      }
      throw ProviderConfigError(`Codex 桥接不可用：${r || '连接断开'}`);
    }
    const version = /\/([\w.]+)/.exec(race.result?.userAgent || '')?.[1] || '';
    conn._send({ method: 'initialized' });
    const models = await conn.call('model/list', {});
    const n = Array.isArray(models?.data) ? models.data.length : 0;
    return `ok — codex ${version || '未知版本'} · ${n} 个模型`;
  } finally {
    conn.disconnect();
  }
}
