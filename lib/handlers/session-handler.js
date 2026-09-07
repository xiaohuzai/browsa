// lib/handlers/session-handler.js — bodies of background.js's session-drawer
// cases (SAVE_SESSION/GET_SESSIONS/LOAD_SESSION/DELETE_SESSION/
// RENAME_SESSION/PIN_SESSION/CLEAR_ALL_SESSIONS/GET_SESSION_FULL), extracted
// verbatim.
// handle() in background.js delegates here — same extraction pattern already
// used for chat-handler.js/subchat-handler.js. All 7 cases are thin
// pass-throughs to lib/storage.js's session functions with no other business
// logic, so they share one dispatcher instead of getting a function each.

import * as storage from '../storage.js';

const { saveCurrentSession, updateSessionHistory, getSavedSessions, loadSession, deleteSession, renameSession, pinSession } = storage;

/**
 * Dispatches one of the 7 session-drawer message types. Returns the same
 * plain-data response shape each case originally returned inline — errors
 * are not caught here, they propagate up to handle()'s existing top-level
 * try/catch (matching the CHAT/SUBCHAT extraction's throw-based contract).
 */
export async function handleSession(msg) {
  switch (msg.type) {
    case 'SAVE_SESSION': {
      // msg.id（activeSessionId）= 当前对话已归属于某个已保存会话：把最新
      // 内容原地写回该会话，不新增条目（否则用户每点一次历史清单就多一份
      // fork）。id 缺省（全新对话）或所指会话已被删掉时，回落为归档新条目
      // ——未保存对话的安全网保持不变。
      const session = (msg.id && await updateSessionHistory(msg.id)) || await saveCurrentSession(msg.name || '');
      return { ok: !!session, session };
    }

    case 'GET_SESSIONS': {
      const sessions = await getSavedSessions(msg.q || '');
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

    case 'PIN_SESSION': {
      await pinSession(msg.id, !!msg.pinned);
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
