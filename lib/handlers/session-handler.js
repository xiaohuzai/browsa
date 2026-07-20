// lib/handlers/session-handler.js — bodies of background.js's session-drawer
// cases (SAVE_SESSION/GET_SESSIONS/LOAD_SESSION/DELETE_SESSION/
// RENAME_SESSION/CLEAR_ALL_SESSIONS/GET_SESSION_FULL), extracted verbatim.
// handle() in background.js delegates here — same extraction pattern already
// used for chat-handler.js/subchat-handler.js. All 7 cases are thin
// pass-throughs to lib/storage.js's session functions with no other business
// logic, so they share one dispatcher instead of getting a function each.

import * as storage from '../storage.js';

const { saveCurrentSession, getSavedSessions, loadSession, deleteSession, renameSession } = storage;

/**
 * Dispatches one of the 7 session-drawer message types. Returns the same
 * plain-data response shape each case originally returned inline — errors
 * are not caught here, they propagate up to handle()'s existing top-level
 * try/catch (matching the CHAT/SUBCHAT extraction's throw-based contract).
 */
export async function handleSession(msg) {
  switch (msg.type) {
    case 'SAVE_SESSION': {
      const session = await saveCurrentSession(msg.name || '');
      return { ok: !!session, session };
    }

    case 'GET_SESSIONS': {
      const sessions = await getSavedSessions();
      return { sessions };
    }

    case 'LOAD_SESSION': {
      const len = await loadSession(msg.id);
      return { ok: len >= 0, len };
    }

    case 'DELETE_SESSION': {
      await deleteSession(msg.id);
      return { ok: true };
    }

    case 'RENAME_SESSION': {
      await renameSession(msg.id, msg.name || '');
      return { ok: true };
    }

    case 'CLEAR_ALL_SESSIONS': {
      await storage.clearAllSessions();
      return { ok: true };
    }

    case 'GET_SESSION_FULL': {
      const session = await storage.getSessionFull(msg.id);
      return { session };
    }

    default:
      throw new Error(`handleSession: unknown message type "${msg.type}"`);
  }
}
