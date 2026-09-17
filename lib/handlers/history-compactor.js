// lib/handlers/history-compactor.js
// After the model has seen attached images on the turn it answers, replace the
// `image_url` pixel blocks in stored history with labeled TEXT placeholders so
// subsequent turns resend cheap text instead of ~1K-token-per-image pixels
// every turn (figure-heavy PDFs were ~30K tokens/turn). The accepted tradeoff:
// later turns can't see figure pixels, only the label/caption - "what's in
// Figure 3" is answerable from the caption, "what's the y-axis label" is not.
//
// Modeled on hermes-webui's `_compact_session_image_parts_for_persistence`
// (which compacts completed image parts to `[screenshot]` text). browsa's
// figures carry meaningful labels, so we use the figure's own caption/label
// (parsed from the `## Figures` section already in the entry's text) instead of
// a generic placeholder - that's how multiple images stay distinguishable.
//
// This is a STORAGE-SIDE mutation only. The API request builders
// (buildMessages, buildRunsConversationHistory) are untouched: they already
// handle text-only content arrays natively, so compacted entries flow through
// unchanged. No labels are stored on the image_url blocks, so nothing extra
// reaches the API.

import * as storage from '../storage.js';

/**
 * Parse the `## Figures` section's numbered labels (in order).
 * The section is built by background.js's ATTACH_PDF_CONFIRM:
 *   "## Figures\nThe descriptions below correspond to the following images in order:\n1. Figure 3: ...\n2. Figure on page 7"
 * The image_url blocks in the same entry are in the SAME order as these labels
 * (both derive from the one `figures` array), so label[N] matches image_url[N].
 * Returns [] when there is no figures section (non-PDF images).
 */
export function parseFigureLabels(text) {
  if (typeof text !== 'string' || !text) return [];
  const idx = text.indexOf('## Figures');
  if (idx === -1) return [];
  const section = text.slice(idx);
  const labels = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\d+\.\s+(.+)$/);
    if (m) labels.push(m[1].trim());
  }
  return labels;
}

/**
 * Replace every `image_url` part in an entry's content array with a labeled
 * text placeholder. Pure + idempotent: an entry with no image_url parts is
 * returned unchanged (so re-running is a no-op).
 *
 * Label for the Nth image (1-indexed within this entry):
 *  - the Nth parsed `## Figures` label (PDF figures, e.g. "Figure 3: ..."), or
 *  - `image N` when there is no figures section (XHS / screenshot / pasted).
 *
 * String-content entries (assistant turns) and non-array content are untouched.
 */
export function compactEntryImageParts(entry) {
  if (!entry || !Array.isArray(entry.content)) return entry;
  const content = entry.content;
  if (!content.some(p => p && p.type === 'image_url')) return entry; // nothing to compact

  // Gather labels from any text parts (the `## Figures` section lives in the
  // text block alongside the image_url blocks in the same entry).
  const fullText = content
    .filter(p => p && (p.type === 'text' || p.type === 'input_text'))
    .map(p => p.text || '')
    .join('\n');
  const labels = parseFigureLabels(fullText);

  let imgIdx = 0;
  const newContent = content.map(part => {
    if (part && part.type === 'image_url') {
      imgIdx++;
      const label = labels[imgIdx - 1] || `image ${imgIdx}`;
      return { type: 'text', text: `[${label}]` };
    }
    return part;
  });
  return { ...entry, content: newContent };
}

/**
 * Read history, compact image parts in every entry, write back if anything
 * changed. Safe to call on every successful chat turn - it's a no-op (read
 * only, no write) when no entry has image_url parts. Returns the number of
 * image parts compacted (0 if nothing changed).
 */
export async function compactImagePartsInHistory() {
  let count = 0;
  // Runs under storage's history lock so a concurrent append (user's next turn)
  // can't be clobbered by this rewrite. Returns null when nothing changed, so
  // the lock skips the write entirely.
  await storage.mutateHistory((history) => {
    if (!Array.isArray(history) || !history.length) return null;
    let changed = false;
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const before = entry?.content;
      const compacted = compactEntryImageParts(entry);
      if (compacted !== entry) {
        // count image_url parts that were replaced
        if (Array.isArray(before)) {
          for (const p of before) if (p && p.type === 'image_url') count++;
        }
        changed = true;
        history[i] = compacted;
      }
    }
    return changed ? history : null;
  });
  if (count) console.log(`[browsa] compacted ${count} image part(s) in history to text placeholders`);
  return count;
}

// ─── Unseen-image byte budget ────────────────────────────────────────────────
// Compaction above normally runs right after the first successful chat turn
// that followed an attach, so parked pixels only live in storage for the
// attach→ask window. But nothing forces that window to close: attaching
// without ever asking (repeated attach testing is the common case) parks each
// attach's base64 — up to ~30 figures × hundreds of KB — in the history blob
// indefinitely. renderHistory() reads the WHOLE array at every panel open, and
// contentChars() deliberately excludes image base64 from the 300K-char trim
// budget (that budget is model-context accounting, not storage hygiene), so
// the blob grows unbounded and every open pays the deserialization. This cap
// compacts OLDEST image-bearing entries first once the total parked bytes
// exceed the budget, always sparing the newest image-bearing entry (the attach
// the user is about to ask about must keep its pixels).

export const UNSEEN_IMAGE_BYTES_BUDGET = 8 * 1024 * 1024;

/** Total chars of image data-URL parts in one history entry. Pure. */
export function imagePartsBytes(entry) {
  if (!entry || !Array.isArray(entry.content)) return 0;
  let n = 0;
  for (const part of entry.content) {
    if (part && part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string') n += url.length;
    }
  }
  return n;
}

/**
 * Cap the total bytes of image_url parts still parked in history, compacting
 * oldest entries first (see section comment). Read-only — no write at all —
 * when already within budget. `budget` is injectable so tests can exercise
 * the boundary without allocating real multi-MB strings. Returns the number
 * of image parts compacted (0 when nothing changed).
 */
export async function boundUnseenImageBytes(budget = UNSEEN_IMAGE_BYTES_BUDGET) {
  let count = 0;
  await storage.mutateHistory((history) => {
    if (!Array.isArray(history) || !history.length) return null;
    const bearing = []; // [{ i, bytes }] — entries still carrying image pixels
    let total = 0;
    for (let i = 0; i < history.length; i++) {
      const bytes = imagePartsBytes(history[i]);
      if (bytes > 0) { bearing.push({ i, bytes }); total += bytes; }
    }
    if (total <= budget || bearing.length <= 1) return null;
    let changed = false;
    // Oldest first; `bearing.length - 1` spares the newest image-bearing entry
    // even when it alone is still over budget (a single big attach stays whole).
    for (let k = 0; k < bearing.length - 1 && total > budget; k++) {
      const { i, bytes } = bearing[k];
      if (Array.isArray(history[i].content)) {
        for (const p of history[i].content) if (p && p.type === 'image_url') count++;
      }
      history[i] = compactEntryImageParts(history[i]);
      total -= bytes;
      changed = true;
    }
    return changed ? history : null;
  });
  if (count) console.log(`[browsa] unseen-image budget: compacted ${count} parked image part(s) (attach(es) never followed by a chat turn)`);
  return count;
}
