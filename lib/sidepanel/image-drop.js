// lib/sidepanel/image-drop.js — the shared image-attach chrome for BOTH image
// input surfaces: the main composer (sidepanel.js) and the detail-thread cards
// (detail-thread.js). Extracted 2026-09-30 (批D): the two surfaces carried
// near-verbatim private copies of the whole pipeline (fileToDataUrl, the 20MB
// pre-read gate, the imageRejectReason budget gate + rejection copy, the
// .imagepreview thumbnail-strip builder, the clipboard scan) and had ALREADY
// drifted once (the same rejection surfaced as a compact appendError on one
// side and a showToast on the other). One pipeline now; the only per-surface
// difference — how a rejection is announced — is an injected `notify(text)`
// callback. Budgets stay owned by lib/image-budget.js (pure policy); this
// module is the UI/ingest layer over it.
//
// Leaf module: imports only i18n + image-budget, never sidepanel.js or
// detail-thread.js (the initX injection ownership model, same as every other
// lib/sidepanel module).

import { t as _t, tSub } from '../i18n.js';
import { imageRejectReason, AGENT_TURN_MAX_IMAGES, AGENT_TURN_IMAGE_BUDGET_CHARS } from '../image-budget.js';

// Per-message image limits — the SAME ones the turn applies
// (lib/image-budget.js). Enforced at attach time so every thumbnail the user
// sees is an image that actually ships: a drop at send time has no UI surface
// at all (the strip is cleared the moment the turn starts), so it reads as
// "my paste did nothing". The MB figure is derived from the char budget
// (base64 ≈ 4/3 of the bytes), rounded DOWN so the message never promises
// more than the gate will accept. (Was a lockstep copy pair: sidepanel's
// IMAGE_BUDGET_MB and detail-thread's cardImageBudgetMb — single source now.)
export const IMAGE_BUDGET_MB = (Math.floor(AGENT_TURN_IMAGE_BUDGET_CHARS / 4 * 3 / 1048576 * 10) / 10).toFixed(1);

// 20 MB — refuse before reading the bytes into a data URL.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// 'size'/'budget' share the size wording; 'shape' is unreachable from
// ingestImageFiles (every candidate is a data: image URL we just built), so
// it falls into the same arm.
export function imageNotAttachedText(reason, name, budgetMb = IMAGE_BUDGET_MB) {
  return reason === 'count'
    ? tSub('imageCountExceeded', 'Image not attached ($1) — up to $2 images per message.', name, AGENT_TURN_MAX_IMAGES)
    : tSub('imageBudgetExceeded', 'Image not attached ($1) — too large to send; about $2 MB of images fit in one message.', name, budgetMb);
}

/**
 * Ingest a FileList into `store` (an array of { dataUrl, name }). Rejections
 * are announced via notify(text) — the caller's surface style (main composer:
 * compact appendError; detail-thread card: showToast). Non-image files are
 * skipped silently (a paste of mixed text+image carries the text separately).
 * Returns the number of images actually added. The caller re-renders its own
 * strip afterwards (renderImageStrip below).
 */
export async function ingestImageFiles(fileList, store, notify) {
  let added = 0;
  for (const f of fileList) {
    if (!f.type || !f.type.startsWith('image/')) continue;
    if (f.size > MAX_FILE_BYTES) {
      notify(tSub('imageTooLarge', 'Image too large: $1', f.name));
      continue;
    }
    const dataUrl = await fileToDataUrl(f);
    const reject = imageRejectReason(store.map((i) => i.dataUrl), dataUrl);
    if (reject) {
      notify(imageNotAttachedText(reject, f.name));
      continue;
    }
    store.push({ dataUrl, name: f.name });
    added++;
  }
  return added;
}

/** Extract pasted image files from a paste event (empty array when the
 * clipboard carries no images). The caller owns preventDefault + ingest. */
export function pastedImageFiles(e) {
  const items = e?.clipboardData?.items;
  if (!items) return [];
  const out = [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Rebuild the `.imagepreview` thumbnail strip inside `mountEl` from `store`
 * ({ dataUrl, name } entries). onRemove(idx) is wired to each × button.
 * Identical DOM on both surfaces (one visual principle): img.alt via
 * textContent-safe property assignment, aria-label + title on the remove
 * button from the shared removeImage key.
 */
export function renderImageStrip(mountEl, store, onRemove) {
  mountEl.innerHTML = '';
  for (let i = 0; i < store.length; i++) {
    const img = store[i];
    const div = document.createElement('div');
    div.className = 'imagepreview';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name; // textContent-safe; avoids innerHTML attribute injection
    const rmBtn = document.createElement('button');
    rmBtn.className = 'rm';
    rmBtn.setAttribute('aria-label', _t('removeImage', 'Remove image'));
    rmBtn.title = _t('removeImage', 'Remove image');
    rmBtn.textContent = '×';
    rmBtn.addEventListener('click', () => onRemove(i));
    div.appendChild(imgEl);
    div.appendChild(rmBtn);
    mountEl.appendChild(div);
  }
}
