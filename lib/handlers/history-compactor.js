// lib/handlers/history-compactor.js — storage-side lifecycle of history images.
//
// Display fidelity is a hard requirement (2026-09-23 user mandate: 气泡里该有
// 啥就有啥 — the bubble must show what was sent): stored image pixels are NEVER
// destroyed, so chat bubbles, the transcript drawer's screenshot cards, and
// session snapshots keep showing exactly what was there. Everything that
// reshapes images for a CONSUMER happens at read/build time instead:
//
//  - MODEL side (token economy): chat-handler's DONE stamps IMAGE_SEEN_FLAG on
//    image-bearing entries ("the model has seen these pixels"); the request
//    builders call prepareHistoryForModel (message-builder.js) which replaces
//    FLAGGED images with labeled text placeholders — the figure's own caption
//    when present, else `[image N]` — so later turns resend cheap text instead
//    of ~1K-token-per-image pixels (figure-heavy PDFs were ~30K tokens/turn).
//    The accepted tradeoff is unchanged: later turns can't see figure pixels,
//    only the label/caption. Modeled on hermes-webui's
//    `_compact_session_image_parts_for_persistence`, but request-side — the
//    same philosophy as message-builder's ageStaleAttachments ("Storage is NOT
//    touched … the UI / transcript drawer keep reading the full text").
//
//  - STORAGE side (panel-open hygiene): boundUnseenImageBytes caps parked
//    pixels at UNSEEN_IMAGE_BYTES_BUDGET by DOWNSCALING the oldest images to
//    display thumbnails — never to labels: a history entry that loses its
//    pixels loses its bubble picture (the exact bug this design exists to
//    prevent). Label-compaction is only the fallback for undecodable payloads.
//
// Pure policy (parseFigureLabels / compactEntryImageParts /
// prepareHistoryForModel) lives in message-builder.js — re-exported here so
// existing imports/tests keep working.

import * as storage from '../storage.js';
import { IMAGE_SEEN_FLAG, compactEntryImageParts, parseFigureLabels } from '../message-builder.js';

export { compactEntryImageParts, parseFigureLabels };

/**
 * Stamp IMAGE_SEEN_FLAG on every history entry that still carries image pixels
 * and isn't flagged yet — called from chat-handler's DONE (success path only),
 * i.e. exactly when "the model has seen this turn's images" becomes true (the
 * flag timing mirrors the old destructive compaction's: a restored snapshot's
 * first answered turn stamps its carried images too). Cheap: one entry copy +
 * one boolean, pixels untouched. No-op (read only, no write) when nothing
 * needs marking. Returns the number of entries stamped.
 */
export async function markImagesSeenInHistory() {
  let count = 0;
  // Runs under storage's history lock so a concurrent append (the user's next
  // turn) can't be clobbered. Returns null when nothing changed, so the lock
  // skips the write entirely.
  await storage.mutateHistory((history) => {
    if (!Array.isArray(history) || !history.length) return null;
    let changed = false;
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (!entry || entry[IMAGE_SEEN_FLAG] || !Array.isArray(entry.content)) continue;
      if (!entry.content.some(p => p && p.type === 'image_url')) continue;
      history[i] = { ...entry, [IMAGE_SEEN_FLAG]: true };
      changed = true;
      count++;
    }
    return changed ? history : null;
  });
  if (count) console.log(`[browsa] model has seen ${count} image-bearing entr(ies); later requests send labels`);
  return count;
}

// ─── Unseen-image byte budget ────────────────────────────────────────────────
// Without any post-answer destruction, attaching without ever asking (repeated
// attach testing is the common case) parks each attach's base64 — up to ~30
// figures × hundreds of KB — in the history blob indefinitely. renderHistory()
// reads the WHOLE array at every panel open, and contentChars() deliberately
// excludes image base64 from the 300K-char trim budget (that budget is
// model-context accounting, not storage hygiene), so the blob would grow
// unbounded and every open would pay the deserialization. This cap DOWNSCALES
// the oldest image-bearing entries' pixels to display thumbnails once the
// total parked bytes exceed the budget, always sparing the newest image-bearing
// entry (the attach the user is about to ask about keeps full pixels for the
// model's first look).

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

/** Display-thumbnail ceiling for budget downgrades — bubble strips render at
 * ~150 CSS px (2x DPR = 300 device px), transcript cards a bit wider; 480
 * covers both with headroom. JPEG q0.82 ≈ 10-25KB per image at this size. */
export const THUMB_MAX_EDGE = 480;

/**
 * Decode + re-encode an image data URL as a bounded JPEG thumbnail. Runs in the
 * service worker (createImageBitmap + OffscreenCanvas are WorkerGlobalScope
 * APIs — no DOM needed). Returns the input unchanged when it is already
 * thumbnail-sized; throws on undecodable input so the caller can fall back to a
 * labeled placeholder. Injectable at the call site for tests.
 */
export async function downscaleDataUrl(dataUrl, maxEdge = THUMB_MAX_EDGE) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, (maxEdge / Math.max(bmp.width, bmp.height)) || 1);
    if (scale >= 1 && blob.size <= 64 * 1024) return dataUrl;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    // Opaque white matte — JPEG has no alpha and a transparent PNG would
    // composite onto black (same reasoning as _rasterizeSvg's backdrop).
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:image/jpeg;base64,${btoa(bin)}`;
  } finally {
    bmp.close?.();
  }
}

/**
 * Cap the total bytes of image_url parts still parked in history by
 * downscaling the oldest entries' images to display thumbnails (see section
 * comment). Read-only — no write at all — when already within budget.
 * `budget` and `downscale` are injectable so tests exercise the boundary
 * without allocating real multi-MB strings. Returns the number of image parts
 * rewritten (0 when nothing changed).
 */
export async function boundUnseenImageBytes(budget = UNSEEN_IMAGE_BYTES_BUDGET, { downscale = downscaleDataUrl } = {}) {
  let count = 0;
  // One locked read-modify-write: victim choice, thumbnailing and rewrite must
  // be atomic against concurrent appends/deletes (index drift) — a two-phase
  // "plan by URL, rewrite by URL" plan over-matches entries that happen to
  // share a data URL (the same paste twice) and rewrites non-victims.
  // mutateHistory awaits the mutator, so awaiting `downscale` inside is fine
  // (only never await ANOTHER locked helper from in here); the lock is held
  // across decodes, bounded by the oldest-first-until-under-budget walk.
  await storage.mutateHistory(async (history) => {
    if (!Array.isArray(history) || !history.length) return null;
    const bearing = []; // [{ i, bytes }]
    let total = 0;
    for (let i = 0; i < history.length; i++) {
      const bytes = imagePartsBytes(history[i]);
      if (bytes > 0) { bearing.push({ i, bytes }); total += bytes; }
    }
    if (total <= budget || bearing.length <= 1) return null;
    let changed = false;
    let remaining = total;
    for (let k = 0; k < bearing.length - 1 && remaining > budget; k++) {
      const { i, bytes } = bearing[k];
      remaining -= bytes;
      const entry = history[i];
      const imageParts = entry.content.filter(p => p && p.type === 'image_url');
      // Try to thumbnail every image of the victim; ANY undecodable payload
      // degrades the whole entry to labeled placeholders (compactEntryImageParts
      // is entry-wide) — the only case display loses its picture.
      let ok = true;
      const thumbs = [];
      for (const part of imageParts) {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        try {
          const thumb = (typeof url === 'string' && url) ? await downscale(url) : null;
          if (!thumb) { ok = false; break; }
          thumbs.push(thumb);
        } catch (_) { ok = false; break; }
      }
      if (!ok) {
        count += imageParts.length;
        history[i] = compactEntryImageParts(entry);
        changed = true;
        continue;
      }
      let idx = 0;
      let entryChanged = false;
      const newContent = entry.content.map(part => {
        if (!part || part.type !== 'image_url') return part;
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        const thumb = thumbs[idx++];
        if (thumb === url) return part; // already thumbnail-sized — nothing to rewrite
        entryChanged = true;
        count++;
        return typeof part.image_url === 'string'
          ? { ...part, image_url: thumb }
          : { ...part, image_url: { ...part.image_url, url: thumb } };
      });
      if (entryChanged) {
        history[i] = { ...entry, content: newContent };
        changed = true;
      }
    }
    return changed ? history : null;
  });
  if (count) console.log(`[browsa] unseen-image budget: rewrote ${count} parked image part(s) to display thumbnails`);
  return count;
}
