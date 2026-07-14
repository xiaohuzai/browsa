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
// AND the SSE read loop (see openai-client.js). Without this, cancel
// was a no-op: the LLM kept streaming, the user saw a "cancelled"
// notice, and a phantom assistant turn got written to history.
export const chatControllers = new Map(); // tabId -> AbortController

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
  const port = streamPorts.get(tabId);
  if (port) safePost(port, payload);
}

export function pushSubChatChunk(subId, payload) {
  const port = subChatPorts.get(subId);
  if (port) safePost(port, payload);
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
export function initStreamState(tabId) {
  streamState.set(tabId, { acc: '', startedAt: Date.now(), lastDeltaAt: 0 });
}

// Update streamState.acc as deltas stream in. Cheap — runs on every chunk
// (typically dozens to hundreds per second). The acc is what the next
// side panel session will render as its "starting point" via STREAM_PEEK.
export function appendToStreamState(tabId, delta) {
  const st = streamState.get(tabId);
  if (st) {
    st.acc += delta;
    st.lastDeltaAt = Date.now();
  }
}

// Drop the streamState once the reply is fully persisted to history and
// the active side panel has acknowledged. Called by the CHAT handler
// right after appendToHistory (so the persisted reply is the same as
// streamState.acc — single source of truth for "what the user sees").
export function clearStreamState(tabId) {
  streamState.delete(tabId);
}
