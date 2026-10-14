// lib/state.js — module-level state shared between background.js's message
// router and the extracted per-case handlers in lib/handlers/*.js. Moved out
// of background.js verbatim (Phase 2 of the sidepanel/background modularization
// refactor) — background.js re-exports these same bindings so existing test
// imports (`const { streamPorts, ... } = await import('../background.js')`)
// keep working unchanged.

// Streaming port: the side panel opens a long-lived port named 'browsa-chat'
// before sending the CHAT message. As soon as the background's CHAT handler
// has the first delta from the LLM, it pushes it back through this port.
// We keep a registry keyed by tabId so multiple tabs (each with their own
// side panel) can stream independently.
export const streamPorts = new Map(); // tabId -> Port

// Stream state survives port churn. When the side panel is torn down (the
// user switches tabs and Chrome destroys the panel), the streaming port
// disconnects, but the LLM request keeps running on the background. We
// stash the accumulated reply here so a freshly-opened side panel can
// peek + resume from where the old panel left off — fixes the
// "switch tab mid-stream → reply appears stuck" bug.
export const streamState = new Map(); // tabId -> { acc: string, startedAt: number, lastDeltaAt: number }

// AbortControllers per in-flight chat, keyed by tabId. The side panel
// sends STREAM_ABORT to cancel — the controller kills the HTTP fetch
// AND the SSE read loop (see llm-client.js). Without this, cancel
// was a no-op: the LLM kept streaming, the user saw a "cancelled"
// notice, and a phantom assistant turn got written to history.
export const chatControllers = new Map(); // tabId -> AbortController

// 30s alarm created while any chat stream is in flight; firing wakes (and
// thereby keeps alive) the service worker even when the originating side
// panel is gone. Handler lives in background.js.
export const STREAM_KEEPALIVE_ALARM = 'browsa-stream-keepalive';

// Periodic GC for stale streamState entries (background.js's gcStreamState).
// The alarm exists ONLY while the map is non-empty — created here on first
// entry, cleared when the last entry goes away. Creating it unconditionally
// at SW startup (the old shape) cold-started the worker 288 times a day to
// sweep a Map that is empty except after an interrupted stream.
export const GC_ALARM_NAME = 'browsa-stream-gc';
export const GC_ALARM_PERIOD_MINUTES = 5;

export function syncGcAlarm() {
  try {
    if (streamState.size > 0) chrome.alarms.create(GC_ALARM_NAME, { periodInMinutes: GC_ALARM_PERIOD_MINUTES });
    else chrome.alarms.clear(GC_ALARM_NAME);
  } catch (_) { /* no chrome.alarms outside the SW (tests) */ }
}

// Maps a tabId to the active stream's resetIdleTimer function. Allows the
// port's SW_PING handler to reset the idle timeout from outside the CHAT
// handler's closure. This is what makes SW_PING actually prevent the
// idle-timeout cancel during long tool calls (e.g. sub-agent execution).
export const idleTimerResetters = new Map(); // tabId -> () => void

// Active run IDs for Hermes /v1/runs streaming. Stored so STREAM_ABORT can
// call POST /v1/runs/{id}/stop to stop the server-side agent, not just the
// local fetch.
export const activeRunIds = new Map(); // tabId -> { runId, baseUrl, apiKey }

// Pending approval/clarification requests awaiting user response.
export const pendingApprovals = new Map();      // tabId -> { runId, approvalId, baseUrl, apiKey }
export const pendingClarifications = new Map(); // tabId -> { runId, clarifyId, baseUrl, apiKey }

// AbortControllers for "detail thread" side-conversations (SUBCHAT), keyed
// by a client-generated subId rather than tabId — unlike the main chat,
// several detail threads can be open (and streaming) at once for the same
// tab, so each needs its own independent cancel handle.
export const subChatControllers = new Map(); // subId -> AbortController

// Detail-thread ("SUBCHAT") port: opened fresh per send (one port per
// subId), exactly like the main chat's per-turn browsa-chat port.
export const subChatPorts = new Map(); // subId -> Port

export function pushChunk(tabId, payload) {
  // Backgrounded streams (the user switched sessions mid-turn — see
  // REASSIGN_STREAM_SESSION) accumulate silently: CHUNK/DONE/ERROR would
  // render ANOTHER conversation's reply into whatever is on screen. The
  // panel re-reads streamState.acc when the user switches back
  // (STREAM_PEEK). Approval/clarify still push whatever is on screen — a
  // blocked tool call needs the human and must not hang the turn.
  const st = streamState.get(tabId);
  if (st?.bg && payload?.type !== 'APPROVAL' && payload?.type !== 'CLARIFY') return;
  // Record terminal events for the PEEK→HELLO resume race (takeTerminalTombstone):
  // a stream that finishes between a resume's PEEK and its HELLO delivers this
  // DONE/ERROR to the old/absent port; the HELLO handler replays the tombstone.
  if (payload?.type === 'DONE' || payload?.type === 'ERROR') {
    recordTerminalTombstone(tabId, payload);
  }
  const port = streamPorts.get(tabId);
  if (port) safePost(port, payload);
}

export function pushSubChatChunk(subId, payload) {
  const port = subChatPorts.get(subId);
  if (port) safePost(port, payload);
}

// ─── Terminal-event tombstones (PEEK→HELLO resume race) ──────────────────────
// resumeInFlightStream is a two-step handshake: STREAM_PEEK (snapshot: is a
// stream in flight? what's the acc?) then connect + STREAM_HELLO (port
// ownership). A turn that finishes INSIDE that window pushes its DONE/ERROR
// to the old or absent port — lost — and by HELLO time streamState is already
// cleared, so the fresh port registers onto a dead stream and the panel spins
// forever (wait indicator never stops; Enter silently routes into followups
// that can never drain). pushChunk therefore stashes every foreground terminal
// event here; the HELLO handler replays a fresh tombstone onto the new port.
// Replay is gated on the panel's HELLO carrying resume:true — a fresh-send
// HELLO (which arrives BEFORE its CHAT even started) must never pick up the
// previous turn's tombstone. Read-once + TTL + initStreamState clearing keep
// it from ever replaying twice or across turns.
const TERMINAL_TOMBSTONE_TTL_MS = 30_000;
const terminalTombstones = new Map(); // tabId -> { payload, ts }

export function recordTerminalTombstone(tabId, payload) {
  terminalTombstones.set(tabId, { payload, ts: Date.now() });
}

export function takeTerminalTombstone(tabId) {
  const t = terminalTombstones.get(tabId);
  if (!t) return null;
  terminalTombstones.delete(tabId); // read-once: at most one resume replay
  if (Date.now() - t.ts > TERMINAL_TOMBSTONE_TTL_MS) return null;
  return t.payload;
}

// Non-consuming read for STREAM_PEEK's not-in-flight branch: a turn that
// finished while the panel document was being recreated (init renderHistory
// read history BEFORE the DONE persisted, PEEK answers after clearStreamState)
// is in storage but visible nowhere — the panel must re-render once. Peek
// only; consuming here would break a subsequent resume-HELLO replay.
export function peekTerminalTombstone(tabId) {
  const t = terminalTombstones.get(tabId);
  return !!t && Date.now() - t.ts <= TERMINAL_TOMBSTONE_TTL_MS;
}

export function clearTerminalTombstone(tabId) {
  terminalTombstones.delete(tabId);
}

function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    // Port closed (user closed panel). Swallow.
  }
}

// Initialize a streamState record for a tab when CHAT starts. Called by
// the CHAT handler before the first onDelta arrives. This is what lets a
// mid-stream tab switch survive the port disconnect.
export function initStreamState(tabId, extra = {}) {
  // extra carries the reply-source stamp ({providerLabel, providerKey}) so a
  // mid-stream tab switch (STREAM_PEEK resume) can still label the bubble
  // with who started the reply — plus `originSessionId` (the conversation
  // this turn belongs to; session-switch background routing writes the reply
  // there) and `bg` (backgrounded flag, see pushChunk).
  // A fresh turn invalidates any terminal tombstone left by the previous one —
  // a resume for THIS turn must never replay the last turn's DONE.
  clearTerminalTombstone(tabId);
  const st = { acc: '', startedAt: Date.now(), lastDeltaAt: 0, bg: false, originSessionId: '', ...extra };
  streamState.set(tabId, st);
  syncGcAlarm();
  durableTurnBegin(tabId, st).catch(() => {}); // durable mirror for SW-death salvage
}

// Update streamState.acc as deltas stream in. Cheap — runs on every chunk
// (typically dozens to hundreds per second). The acc is what the next
// side panel session will render as its "starting point" via STREAM_PEEK.
export function appendToStreamState(tabId, delta) {
  const st = streamState.get(tabId);
  if (st) {
    st.acc += delta;
    st.lastDeltaAt = Date.now();
    scheduleDurableTurnFlush(tabId); // debounced durable mirror (SW-death salvage)
  }
}

// Drop the streamState once the reply is fully persisted to history and
// the active side panel has acknowledged. Called by the CHAT handler
// right after appendToHistory (so the persisted reply is the same as
// streamState.acc — single source of truth for "what the user sees").
export function clearStreamState(tabId) {
  streamState.delete(tabId);
  syncGcAlarm();
  durableTurnEnd(tabId); // fire-and-forget
}

// ─── Durable in-flight turn record (SW-death salvage, 2026-10-13) ────────────
// Everything a live turn is, lives in Maps on the service worker — streamState,
// chatControllers, the provider socket. If Chrome kills the SW mid-stream
// despite the keepalive alarm (30s-alarm vs 30s-idle race, memory pressure,
// extension reload), the turn evaporates SILENTLY: nothing persisted, no
// error, and the reopened panel's STREAM_PEEK says not-in-flight — the user
// loses thinking + partial output with no trace (field report 2026-10-13:
// OpenSquilla turn lost across a side-panel close/reopen). The keepalive
// alarm makes SW death rare; nothing made it recoverable. These helpers
// mirror the minimum turn state into chrome.storage.session (dies with the
// browser session — right scope for an in-flight turn) so a restarted SW can
// salvage what already streamed: chat-handler.js's salvageDurableTurns()
// appends the partial as an interrupted entry via the SAME 收尸 routing as
// the abort path. Writes are debounced (deltas arrive dozens/sec; the tail
// lost to a death inside the debounce window is ≤1s of text). Every accessor
// no-ops outside the SW (tests, module imports without chrome).
const DURABLE_INDEX_KEY = 'browsa.inflightTurns';
const DURABLE_FLUSH_MS = 1000;
// Salvage cap for the durable copy only — in-memory acc is uncapped and the
// terminal paths persist the full text; this bounds a worst-case death to
// "partial without its head", never to total loss. (session storage quota
// is shared with the site caches — don't let one huge turn crowd them out.)
const DURABLE_ACC_TAIL = 512 * 1024;
const durableFlushTimers = new Map(); // tabId -> timeout id

const durableSession = {
  async get(key) {
    try { return (await chrome.storage?.session?.get(key))?.[key]; } catch { return undefined; }
  },
  async set(obj) {
    try { await chrome.storage?.session?.set(obj); } catch { /* session store full/unavailable — salvage is best-effort */ }
  },
  async remove(key) {
    try { await chrome.storage?.session?.remove(key); } catch { /* best-effort */ }
  },
};

function durableRecordKey(tabId) { return `browsa.inflightTurn.${tabId}`; }

function durableRecordOf(st) {
  return {
    acc: String(st.acc || '').slice(-DURABLE_ACC_TAIL),
    startedAt: st.startedAt,
    originSessionId: st.originSessionId || '',
    providerLabel: st.providerLabel || '',
    providerKey: st.providerKey || null,
    bg: !!st.bg,
  };
}

async function durableTurnBegin(tabId, st) {
  const index = (await durableSession.get(DURABLE_INDEX_KEY)) || [];
  const next = Array.isArray(index) ? index.filter((id) => id !== tabId) : [];
  next.push(tabId);
  await durableSession.set({ [DURABLE_INDEX_KEY]: next, [durableRecordKey(tabId)]: durableRecordOf(st) });
}

// Debounced: the first delta schedules a flush; the pending flush always
// reads the LATEST acc when it fires, so a delta burst costs one write.
export function scheduleDurableTurnFlush(tabId) {
  if (!chrome?.storage?.session || durableFlushTimers.has(tabId)) return;
  durableFlushTimers.set(tabId, setTimeout(async () => {
    durableFlushTimers.delete(tabId);
    const st = streamState.get(tabId);
    if (st) await durableSession.set({ [durableRecordKey(tabId)]: durableRecordOf(st) });
  }, DURABLE_FLUSH_MS));
}

export async function durableTurnEnd(tabId) {
  const timer = durableFlushTimers.get(tabId);
  if (timer !== undefined) { clearTimeout(timer); durableFlushTimers.delete(tabId); }
  if (!chrome?.storage?.session) return;
  const index = (await durableSession.get(DURABLE_INDEX_KEY)) || [];
  if (Array.isArray(index) && index.includes(tabId)) {
    await durableSession.set({ [DURABLE_INDEX_KEY]: index.filter((id) => id !== tabId) });
  }
  await durableSession.remove(durableRecordKey(tabId));
}

// Records for the salvage sweep: only turns with salvageable output. Empty /
// garbage records are deleted on the spot (a death before the first delta has
// nothing to 收尸 — the user turn is already in history; salvage stays
// non-empty-only, same as the abort path).
export async function readDurableTurns() {
  if (!chrome?.storage?.session) return [];
  const index = (await durableSession.get(DURABLE_INDEX_KEY)) || [];
  const out = [];
  for (const tabId of Array.isArray(index) ? index : []) {
    const rec = await durableSession.get(durableRecordKey(tabId));
    if (rec && String(rec.acc || '').trim()) out.push({ tabId, ...rec });
    else await durableTurnEnd(tabId);
  }
  return out;
}
