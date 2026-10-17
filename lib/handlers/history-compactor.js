// lib/handlers/history-compactor.js — storage-side lifecycle of history images.
//
// Display fidelity is a hard requirement (2026-09-23 user mandate: 气泡里该有
// 啥就有啥 — the bubble must show what was sent): stored image pixels are NEVER
// destroyed, so chat bubbles, the transcript drawer's screenshot cards, and
// session snapshots keep showing exactly what was there. Everything that
// reshapes images for a CONSUMER happens at read/build time instead:
//
//  - MODEL side (KV-cache ruling, 2026-10-14): history rides to the model
//    VERBATIM — provider prefix caches hit only on byte-identical prefixes,
//    so the old request-side label compaction (images → text labels after the
//    model answered, ADR-0013's token economy) busted the cached state for
//    the whole suffix after the first flagged entry, later text included.
//    Cache-hit pricing makes resending pixels cheaper than that re-prefill.
//    The IMAGE_SEEN_FLAG stamp survives as legacy bookkeeping only —
//    prepareHistoryForModel strips it from request bodies and nothing else.
//    Modeled on hermes-webui's
//    `_compact_session_image_parts_for_persistence`, but request-side —
//    same philosophy as the (also removed) context aging: "Storage is NOT
//    touched … the UI / transcript drawer keep reading the full text".
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
 * Pure stamping loop (no storage access): stamp IMAGE_SEEN_FLAG on every
 * entry that still carries image pixels and isn't flagged yet. Mutates the
 * given array in place, returns the number of entries stamped. Shared by
 * markImagesSeenInHistory (the standalone locked pass) and chat-handler's
 * persistTurnEntry, which folds the stamp into the SAME locked mutate as the
 * turn append (2026-09-30 批C) — one read+write per image turn instead of
 * two full ≤8MB deserialize passes.
 */
export function stampImagesSeenInArray(history) {
  let count = 0;
  if (!Array.isArray(history) || !history.length) return count;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || entry[IMAGE_SEEN_FLAG] || !Array.isArray(entry.content)) continue;
    if (!entry.content.some(p => p && p.type === 'image_url')) continue;
    history[i] = { ...entry, [IMAGE_SEEN_FLAG]: true };
    count++;
  }
  return count;
}

/**
 * Stamp IMAGE_SEEN_FLAG on every history entry that still carries image pixels
 * and isn't flagged yet — called when "the model has seen this turn's images"
 * becomes true (the flag timing mirrors the old destructive compaction's: a
 * restored snapshot's first answered turn stamps its carried images too).
 * Cheap: one entry copy + one boolean, pixels untouched. No-op (read only, no
 * write) when nothing needs marking. Returns the number of entries stamped.
 */
export async function markImagesSeenInHistory() {
  let count = 0;
  // Runs under storage's history lock so a concurrent append (the user's next
  // turn) can't be clobbered. Returns null when nothing changed, so the lock
  // skips the write entirely.
  await storage.mutateHistory((history) => {
    count = stampImagesSeenInArray(history);
    return count ? history : null;
  });
  if (count) console.log(`[browsa] model has seen ${count} image-bearing entr(ies); flag stamped (legacy bookkeeping — requests ride verbatim)`);
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
  const imageUrlOf = (part) => (typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url);
  const urlListAt = (entry) => (Array.isArray(entry?.content) ? entry.content.filter((p) => p && p.type === 'image_url').map(imageUrlOf) : null);

  // Three phases so image DECODING never runs inside the history lock (2026-10-17):
  // the old single locked pass held `withHistoryLock` across every canvas
  // downscale — after an 18-image attach the next turn's appendToHistory could
  // block for seconds. Plan (unlocked read) → decode (unlocked) → apply
  // (locked, revalidated by entry index + its exact image-URL list, so a
  // concurrent append/delete can only make us SKIP a victim, never rewrite
  // the wrong entry — the drift hazard the old comment worried about).
  const snapshot = await storage.getHistory();
  if (!Array.isArray(snapshot) || !snapshot.length) return count;
  const bearing = []; // [{ i, bytes }]
  let total = 0;
  for (let i = 0; i < snapshot.length; i++) {
    const bytes = imagePartsBytes(snapshot[i]);
    if (bytes > 0) { bearing.push({ i, bytes }); total += bytes; }
  }
  if (total <= budget || bearing.length <= 1) return count;

  // Victim choice walks oldest-first until the parked bytes fit the budget;
  // the newest entry is always spared (it is the one the user just attached).
  const plans = []; // [{ i, urls, thumbs|null, fallback }]
  let remaining = total;
  for (let k = 0; k < bearing.length - 1 && remaining > budget; k++) {
    const { i, bytes } = bearing[k];
    remaining -= bytes;
    const urls = urlListAt(snapshot[i]) || [];
    // Try to thumbnail every image of the victim; ANY undecodable payload
    // degrades the whole entry to labeled placeholders (compactEntryImageParts
    // is entry-wide) — the only case display loses its picture.
    const thumbs = [];
    let ok = true;
    for (const url of urls) {
      try {
        const thumb = (typeof url === 'string' && url) ? await downscale(url) : null;
        if (!thumb) { ok = false; break; }
        thumbs.push(thumb);
      } catch (_) { ok = false; break; }
    }
    plans.push({ i, urls, thumbs: ok ? thumbs : null });
  }
  if (!plans.length) return count;

  await storage.mutateHistory(async (history) => {
    if (!Array.isArray(history) || !history.length) return null;
    let changed = false;
    for (const plan of plans) {
      const entry = history[plan.i];
      if (!entry) continue;
      const nowUrls = urlListAt(entry);
      // Revalidate: the entry must still be the one we planned against.
      if (!nowUrls || nowUrls.length !== plan.urls.length || nowUrls.some((u, n) => u !== plan.urls[n])) continue;
      if (!plan.thumbs) {
        count += plan.urls.length;
        history[plan.i] = compactEntryImageParts(entry);
        changed = true;
        continue;
      }
      let idx = 0;
      let entryChanged = false;
      const newContent = entry.content.map((part) => {
        if (!part || part.type !== 'image_url') return part;
        const url = imageUrlOf(part);
        const thumb = plan.thumbs[idx++];
        if (thumb === url) return part; // already thumbnail-sized — nothing to rewrite
        entryChanged = true;
        count++;
        return typeof part.image_url === 'string'
          ? { ...part, image_url: thumb }
          : { ...part, image_url: { ...part.image_url, url: thumb } };
      });
      if (entryChanged) {
        history[plan.i] = { ...entry, content: newContent };
        changed = true;
      }
    }
    return changed ? history : null;
  });
  if (count) console.log(`[browsa] unseen-image budget: rewrote ${count} parked image part(s) to display thumbnails`);
  return count;
}
