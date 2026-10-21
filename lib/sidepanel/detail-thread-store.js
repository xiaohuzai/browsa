// lib/sidepanel/detail-thread-store.js — persisted state for the 追问 / detail
// thread cards, so closing the side panel (which tears the panel document
// down) no longer discards an open card.
//
// Storage choice: chrome.storage.SESSION, not local. A detail thread is a
// side conversation about the CURRENT main conversation — the main history
// never contains it, saved sessions never contain it, and it should die with
// the browser session, not linger across restarts as user data. The card is
// still ephemeral in the product sense: closing the card deletes its record.
//
// Failure is always open: if chrome.storage.session is unavailable (older
// Chrome, jsdom tests) or a write throws, the card keeps working in memory and
// simply cannot be restored. Losing persistence must never break the card.
//
// All writes are serialized through one promise queue: the store is a single
// key holding an array, and cards persist independently (streaming text,
// draft, resize) — un-serialized read-modify-write would drop concurrent
// updates.

const STORE_KEY = 'browsa.detailThreads.v1';
// One record per card, each can carry the quoted excerpt plus the whole side
// conversation (including the first-turn reply excerpt). 12 open cards is far
// beyond realistic use; the cap only exists so a pathological session cannot
// fill the 10MB session-storage quota.
const MAX_THREADS = 12;

let queue = Promise.resolve();

function storageArea() {
  try {
    if (typeof chrome === 'undefined') return null;
    return chrome?.storage?.session || null;
  } catch (_) {
    return null;
  }
}

async function readAll() {
  const area = storageArea();
  if (!area) return [];
  try {
    const got = await area.get(STORE_KEY);
    return Array.isArray(got?.[STORE_KEY]) ? got[STORE_KEY] : [];
  } catch (_) {
    return [];
  }
}

async function writeAll(list) {
  const area = storageArea();
  if (!area) return;
  try {
    await area.set({ [STORE_KEY]: list });
  } catch (_) { /* fail-open: no persistence is better than a broken card */ }
}

function enqueue(fn) {
  const next = queue.then(fn, fn);
  // Keep the chain alive even if a link rejects; callers get the original
  // promise so they can observe errors (none of the helpers throw today).
  queue = next.then(() => undefined, () => undefined);
  return next;
}

/** Deterministic content fingerprint for re-anchoring after a panel reload. */
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + text.length;
}

/** All persisted thread records, oldest first. Never rejects. */
export function loadDetailThreads() {
  return enqueue(readAll);
}

/** Insert or replace one record (matched by subId). Never rejects. */
export function saveDetailThread(record) {
  if (!record || typeof record.subId !== 'string') return Promise.resolve();
  return enqueue(async () => {
    const list = await readAll();
    const i = list.findIndex((r) => r?.subId === record.subId);
    if (i >= 0) list[i] = record;
    else list.push(record);
    // Evict the least recently touched records first.
    list.sort((a, b) => (a?.updatedAt || 0) - (b?.updatedAt || 0));
    while (list.length > MAX_THREADS) list.shift();
    await writeAll(list);
  });
}

/** Remove one record. Never rejects. */
export function deleteDetailThread(subId) {
  return enqueue(async () => {
    const list = await readAll();
    const next = list.filter((r) => r?.subId !== subId);
    if (next.length !== list.length) await writeAll(next);
  });
}

/** Remove every record. Never rejects. */
export function clearDetailThreadStore() {
  return enqueue(async () => {
    const area = storageArea();
    if (!area) return;
    try { await area.remove(STORE_KEY); } catch (_) {}
  });
}

/** Test/hook seam: resolves when every queued write has settled. */
export function flushDetailThreadStore() {
  return queue;
}
