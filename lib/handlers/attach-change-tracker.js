// lib/handlers/attach-change-tracker.js — local, offline change detection for
// re-attached pages. Ported concept from firecrawl's change-tracking-diff.ts:
// diffing "what changed since last time" without any network call or LLM.
// Unlike firecrawl (which stores the previous full markdown and unified-diffs
// it), browsa only keeps a hash + length + timestamp per (mode, url) — the
// point is a cheap "did this change at all" signal for the model, not a
// rendered diff, so there's no reason to pay chrome.storage.local space for
// a second full copy of every attached page.

const STORAGE_KEY = 'browsaAttachSnapshots';
const MAX_SNAPSHOTS = 50;

/** Deterministic 32-bit FNV-1a hash — no crypto dependency needed for a pure "did this change" signal. */
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Compare `text` against the last snapshot stored under `key`, then record
 * the new snapshot. Returns `{changed: false}` on first attach (nothing to
 * compare against) or when the content is identical; `{changed: true,
 * previousAttachedAt, previousLength}` when it differs.
 */
export async function checkAndRecordAttachChange(key, text) {
  if (!key || !text) return { changed: false };
  const hash = hashText(text);
  const { [STORAGE_KEY]: snapshots = {} } = await chrome.storage.local.get(STORAGE_KEY);
  const prev = snapshots[key];
  const result = (prev && prev.hash !== hash)
    ? { changed: true, previousAttachedAt: prev.attachedAt, previousLength: prev.length }
    : { changed: false };

  const updated = { ...snapshots, [key]: { hash, length: text.length, attachedAt: Date.now() } };
  const keys = Object.keys(updated);
  if (keys.length > MAX_SNAPSHOTS) {
    keys.sort((a, b) => updated[a].attachedAt - updated[b].attachedAt);
    for (const k of keys.slice(0, keys.length - MAX_SNAPSHOTS)) delete updated[k];
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return result;
}
