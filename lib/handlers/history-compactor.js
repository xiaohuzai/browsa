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
  const history = await storage.getHistory();
  if (!Array.isArray(history) || !history.length) return 0;
  let changed = false;
  let count = 0;
  const next = history.map(entry => {
    const before = entry?.content;
    const compacted = compactEntryImageParts(entry);
    if (compacted !== entry) {
      // count image_url parts that were replaced
      if (Array.isArray(before)) {
        for (const p of before) if (p && p.type === 'image_url') count++;
      }
      changed = true;
    }
    return compacted;
  });
  if (changed) {
    await storage.setHistory(next);
    console.log(`[browsa] compacted ${count} image part(s) in history to text placeholders`);
  }
  return count;
}
