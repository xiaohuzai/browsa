// lib/state.js — module-level state shared between background.js's message
// router and the extracted per-case handlers in lib/handlers/*.js. Moved out
// of background.js verbatim (Phase 2 of the sidepanel/background modularization
// refactor) — background.js re-exports these same bindings so existing test
// imports (`const { streamPorts, ... } = await import('../background.js')`)
// keep working unchanged.

import { stepsWithoutLiveToolIdentity, isRecoverableToolStep } from './tool-call-id.js';

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

// Monotonic per-tab turn generation. A turn captures its epoch at init; after
// its finally has deleted the maps, a later turn (even one that has already
// finished and cleared its state) still bumps the epoch, so the older turn's
// post-persist DONE gate can tell it was superseded. Without this, the
// ownsAtEnd snapshot alone would push the old DONE into the newer port during
// the persist window (2026-10-21 audit).
const streamEpochs = new Map(); // tabId -> number
export function streamEpoch(tabId) {
  return streamEpochs.get(tabId) || 0;
}

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

// Pending approval/clarification requests awaiting user response, keyed by
// agentPendingKey(tabId|subId) (`<scope>::<seq>`, agent-stream-session.js) —
// concurrent requests STACK (2026-10-15); the old tabId single slot let the
// second event overwrite the first. Entries carry the per-kind relay fields
// plus `data` (the card display payload, re-ridden by STREAM_PEEK).
export const pendingApprovals = new Map();
export const pendingClarifications = new Map();

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
  // Record terminal events for the PEEK→HELLO resume race (takeTerminalTombstone):
  // a stream that finishes between a resume's PEEK and its HELLO delivers this
  // DONE/ERROR to the old/absent port; the HELLO handler replays the tombstone.
  // MUST run before the bg gate below (2026-11-03 audit): a backgrounded stream
  // (user switched sessions mid-turn) that finishes still needs a tombstone, or
  // switching back strands the reply (spinner forever) — the exact race this
  // mechanism fixes. Replay is resume-gated + origin-safe (initStreamState clears
  // a fresh turn's stale tombstone; TTL + read-once bound it), so recording bg
  // terminal events cannot leak another conversation's reply.
  if (payload?.type === 'DONE' || payload?.type === 'ERROR') {
    recordTerminalTombstone(tabId, payload);
  }
  const st = streamState.get(tabId);
  if (st?.bg && payload?.type !== 'APPROVAL' && payload?.type !== 'CLARIFY') return;
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
  // Prune expired entries on write (2026-10-17): a tombstone is normally
  // consumed by the resume HELLO, but a turn whose panel simply STAYS OPEN is
  // never resumed — its entry sat here until the SW died. Bounded by tab count
  // per SW lifetime, yet tabIds recycle, so an expired entry can also shadow
  // nothing useful. Cheap sweep, only when the map is non-trivial.
  if (terminalTombstones.size >= 8) {
    const now = Date.now();
    for (const [k, v] of terminalTombstones) {
      if (now - v.ts > TERMINAL_TOMBSTONE_TTL_MS) terminalTombstones.delete(k);
    }
  }
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
  if (!t) return false;
  if (Date.now() - t.ts > TERMINAL_TOMBSTONE_TTL_MS) {
    // Peek is non-consuming for LIVE tombstones only; an expired one can never
    // be replayed (take would return null), so drop it here instead of leaving
    // it to the next SW death.
    terminalTombstones.delete(tabId);
    return false;
  }
  return true;
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
  const st = { acc: '', startedAt: Date.now(), lastDeltaAt: 0, bg: false, originSessionId: '', ...extra,
    recoveryId: extra.recoveryId || globalThis.crypto.randomUUID() };
  streamEpochs.set(tabId, (streamEpochs.get(tabId) || 0) + 1);
  st.epoch = streamEpochs.get(tabId);
  streamState.set(tabId, st);
  syncGcAlarm();
  durableTurnBegin(tabId, st).catch(() => {}); // durable mirror for SW-death salvage
  // Returned so the turn can later prove ownership before clearing per-tab
  // state — a second (erroneous or concurrent) turn on the same tabId must
  // not have its controller/state deleted by the first turn's cleanup.
  return st;
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
  const st = streamState.get(tabId);
  // After an SW restart the panel can send a late STREAM_RELEASE while the
  // only surviving copy is the durable mirror. With no live state there is no
  // owner whose identity could authorize deleting that mirror.
  if (!st) { syncGcAlarm(); return; }
  streamState.delete(tabId);
  syncGcAlarm();
  durableTurnEnd(tabId, st?.epoch, { recoveryId: st?.recoveryId }); // fire-and-forget; identity gates the durable delete
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
// appends an interrupted entry via source-identity routing. Writes are
// debounced (deltas arrive dozens/sec; the tail
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
// All tabs share DURABLE_INDEX_KEY, so serializing by tab would still let two
// begin/end operations overwrite each other's read-modify-write of the index.
let durableWriteChain = Promise.resolve();

function withDurableWriteLock(fn) {
  const run = durableWriteChain.then(fn, fn);
  durableWriteChain = run.then(() => {}, () => {});
  return run;
}

const durableSession = {
  async set(obj) {
    try { await chrome.storage?.session?.set(obj); return true; } catch { return false; }
  },
  async remove(key) {
    try { await chrome.storage?.session?.remove(key); return true; } catch { return false; }
  },
};

async function readDurableStrict(key) {
  return (await chrome.storage.session.get(key))?.[key];
}

export async function readDurableTurnStrict(tabId) {
  return readDurableStrict(durableRecordKey(tabId));
}

export function hasRecoverableDurableTurn(rec) {
  return !!(rec && !rec.discarded && (String(rec.acc || '').trim()
    || (Array.isArray(rec.steps) && rec.steps.some(isRecoverableToolStep))));
}

function durableRecordKey(tabId) { return `browsa.inflightTurn.${tabId}`; }

function durableRecordOf(st) {
  return {
    // Silent continuation/rewrite uses acc for its own unseen stream. The
    // durable copy must keep the answer already visible to the user.
    acc: String(st.visibleBeforeSilent || st.acc || '').slice(-DURABLE_ACC_TAIL),
    startedAt: st.startedAt,
    // 回合身份随镜像落盘（sw-3）：durableTurnEnd 比对式删除的依据。
    epoch: st.epoch,
    recoveryId: st.recoveryId,
    originSessionId: st.originSessionId || '',
    originContextId: st.originContextId || '',
    originHistoryGeneration: st.originHistoryGeneration || '',
    providerLabel: st.providerLabel || '',
    providerKey: st.providerKey || null,
    bg: !!st.bg,
    // What the turn DID rides the durable record too: a salvaged turn whose
    // text survives but whose tool ledger doesn't would hand the next agent
    // "I did it" with no file names — the exact hole the ledger exists to close.
    ...(Array.isArray(st.steps) && st.steps.length ? { steps: stepsWithoutLiveToolIdentity(st.steps) } : {}),
  };
}

async function durableTurnBegin(tabId, st) {
  return withDurableWriteLock(async () => {
    if (st.durableSuppressed) return;
    const index = (await readDurableStrict(DURABLE_INDEX_KEY)) || [];
    if (st.durableSuppressed) return;
    const next = Array.isArray(index) ? index.filter((id) => id !== tabId) : [];
    next.push(tabId);
    await durableSession.set({ [DURABLE_INDEX_KEY]: next, [durableRecordKey(tabId)]: durableRecordOf(st) });
  });
}

// Debounced: the first delta schedules a flush; the pending flush always
// reads the LATEST acc when it fires, so a delta burst costs one write.
export function scheduleDurableTurnFlush(tabId) {
  if (!chrome?.storage?.session || streamState.get(tabId)?.durableSuppressed || durableFlushTimers.has(tabId)) return;
  durableFlushTimers.set(tabId, setTimeout(async () => {
    durableFlushTimers.delete(tabId);
    await withDurableWriteLock(async () => {
      const st = streamState.get(tabId);
      if (st && !st.durableSuppressed) await durableSession.set({ [durableRecordKey(tabId)]: durableRecordOf(st) });
    });
  }, DURABLE_FLUSH_MS));
}

// Called synchronously before abort: queued or later tool callbacks must not
// re-create the mirror while the durable discard is being written.
export function suppressDurableTurn(tabId, st) {
  st.durableSuppressed = true;
  const timer = durableFlushTimers.get(tabId);
  if (timer !== undefined) { clearTimeout(timer); durableFlushTimers.delete(tabId); }
}

// A handled user discard must survive SW death even if normal abort cleanup
// has not run. Never create a missing record or touch a newer turn's record.
export async function discardDurableTurn(tabId, st) {
  return withDurableWriteLock(async () => {
    let current;
    try { current = (await chrome.storage.session.get(durableRecordKey(tabId)))?.[durableRecordKey(tabId)]; }
    catch { return false; }
    if (!current) return true; // normal abort cleanup already removed it
    if (current.recoveryId !== st.recoveryId || current.epoch !== st.epoch) return true;
    return durableSession.set({ [durableRecordKey(tabId)]: { ...current, discarded: true } });
  });
}

export async function durableTurnEnd(tabId, epoch, { recoveryId, onlyIfInactive = false, startedAt } = {}) {
  if (!chrome?.storage?.session) return;
  return withDurableWriteLock(async () => {
    if (onlyIfInactive && streamState.has(tabId)) return;
    // A late end must never clear a newer turn's mirror, even if its epoch
    // repeats after a SW restart. Legacy records can lack an identity.
    if (epoch != null || recoveryId || startedAt !== undefined) {
      let rec;
      try { rec = await readDurableStrict(durableRecordKey(tabId)); } catch { return; }
      if (onlyIfInactive && streamState.has(tabId)) return;
      if (epoch != null && rec && rec.epoch != null && rec.epoch !== epoch) return;
      if (rec && recoveryId && rec.recoveryId !== recoveryId) return;
      if (rec && startedAt !== undefined && rec.startedAt !== startedAt) return;
    }
    const timer = durableFlushTimers.get(tabId);
    if (timer !== undefined) { clearTimeout(timer); durableFlushTimers.delete(tabId); }
    let index;
    try { index = (await readDurableStrict(DURABLE_INDEX_KEY)) || []; } catch { return; }
    // Remove the record first. If that fails, retain the index so recovery
    // can retry; if the index update fails, a harmless missing-record row
    // remains and can be pruned on the next sweep.
    if (!await durableSession.remove(durableRecordKey(tabId))) return;
    if (Array.isArray(index) && index.includes(tabId)) {
      await durableSession.set({ [DURABLE_INDEX_KEY]: index.filter((id) => id !== tabId) });
    }
  });
}

// Legacy mirrors predate recoveryId. Assign and persist one before touching
// history: if this write fails the mirror is retained for a later retry.
export async function ensureDurableRecoveryId(rec) {
  return withDurableWriteLock(async () => {
    if (streamState.has(rec.tabId)) return null;
    const key = durableRecordKey(rec.tabId);
    let current;
    try { current = await readDurableStrict(key); } catch { return null; }
    if (streamState.has(rec.tabId) || !current || current.epoch !== rec.epoch || current.startedAt !== rec.startedAt
      || (rec.recoveryId && current.recoveryId !== rec.recoveryId)) return null;
    if (current.recoveryId) return current.recoveryId;
    const recoveryId = globalThis.crypto.randomUUID();
    if (!await durableSession.set({ [key]: { ...current, recoveryId } })) return null;
    return streamState.has(rec.tabId) ? null : recoveryId;
  });
}

// Records for the salvage sweep: visible text or a real tool step. Empty /
// garbage records are deleted on the spot; live turns keep their mirrors.
export async function readDurableTurns() {
  if (!chrome?.storage?.session) return [];
  const index = (await readDurableStrict(DURABLE_INDEX_KEY)) || [];
  const out = [];
  for (const tabId of Array.isArray(index) ? index : []) {
    // 活回合守卫（2026-11-03 审计）：SW 醒来即发的新回合（queued followup、划词
    // 拉起面板即发送）可能刚 durableTurnBegin 写入 acc='' 的记录。收尸扫描绝不能
    // 删活回合的记录/索引——下游 salvageDurableTurns 的 streamState.has 守卫来得
    // 太晚（删除已在此发生），且 scheduleDurableTurnFlush 只重写记录键不重写索引，
    // 一旦索引条目被删该回合的 SW-death 收尸永久失效。活回合跳过，由其结束时的
    // clearStreamState→durableTurnEnd 正常清理。
    if (streamState.has(tabId)) continue;
    const rec = await readDurableStrict(durableRecordKey(tabId));
    if (streamState.has(tabId)) continue;
    if (hasRecoverableDurableTurn(rec)) out.push({ tabId, ...rec });
    else await durableTurnEnd(tabId, rec?.epoch, { recoveryId: rec?.recoveryId, startedAt: rec?.startedAt, onlyIfInactive: true });
  }
  return out;
}
