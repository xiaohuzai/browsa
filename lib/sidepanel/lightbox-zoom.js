// lib/sidepanel/lightbox-zoom.js — cursor-anchored pan/zoom physics for the
// image lightbox (2026-10-17 motion pass, constants from the CDS media
// viewer): wheel zooms toward the cursor, drag pans, double-click toggles,
// and a zoom of ≤1.05 snaps back to 1 (no near-1 limbo state).
//
// The math is pure and exported for tests; attachLightboxZoom() is the only
// piece that touches DOM events. Single-pointer only (desktop side panel —
// pinch is out of scope).

export const ZOOM_WHEEL_SENSITIVITY = 0.01;
export const ZOOM_MIN = 1;
export const ZOOM_SNAP_MAX = 1.05;   // below this, zoom snaps home
export const ZOOM_DEFAULT_JUMP = 1.25; // double-click zoom step
export const DRAG_DEADZONE_PX = 4;   // shared drag deadzone (CDS global convention)

export function clampScale(scale, maxScale) {
  return Math.min(Math.max(maxScale, ZOOM_MIN), Math.max(ZOOM_MIN, scale));
}

/** Wheel → next scale: exponential per CDS, clamped to [1, maxScale]. */
export function wheelNextScale(scale, deltaY, maxScale, sensitivity = ZOOM_WHEEL_SENSITIVITY) {
  return clampScale(scale * Math.exp(-deltaY * sensitivity), maxScale);
}

/** Cursor-anchored affine (CDS): keep the point under the cursor fixed while
 * the scale goes scale→nextScale. `offset` = pointer relative to the element
 * center; `tx/ty` = current pan. */
export function anchorTranslate({ offsetX, offsetY, tx, ty, scale, nextScale }) {
  const c = nextScale / scale;
  return { tx: offsetX - (offsetX - tx) * c, ty: offsetY - (offsetY - ty) * c };
}

/** Pan slack for one axis at a given scale: the centered image has none at 1,
 * and slack only unlocks above the snap threshold (CDS taper). */
export function maxPan(fitSize, scale, viewportSize) {
  const raw = Math.max(0, (fitSize * scale - viewportSize) / 2);
  const taper = Math.min(1, Math.max(0, (scale - ZOOM_SNAP_MAX) / 0.95));
  return raw * taper;
}

export function clampPan({ tx, ty, fitW, fitH, scale, viewportW, viewportH }) {
  return {
    tx: Math.max(-maxPan(fitW, scale, viewportW), Math.min(maxPan(fitW, scale, viewportW), tx)),
    ty: Math.max(-maxPan(fitH, scale, viewportH), Math.min(maxPan(fitH, scale, viewportH), ty)),
  };
}

/** Wire zoom/pan onto a lightbox <img> inside its <dialog>. Returns
 * { consumeDraggedClick() } — call it from the dialog's click-to-dismiss
 * handler so a drag that ENDS on the backdrop doesn't close the viewer. */
export function attachLightboxZoom(img, surface, doc = document) {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let dragMoved = false;
  let start = null;

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.classList.toggle('is-zoomed', scale > 1);
    img.classList.toggle('is-dragging', dragging && dragMoved);
  };

  const maxScaleOf = () => {
    const natural = img.naturalWidth || 0;
    const fit = img.clientWidth || 1;
    return Math.max(2, natural / fit || 2);
  };

  const zoomTo = (nextScale, offsetX = 0, offsetY = 0) => {
    const maxScale = maxScaleOf();
    const next = clampScale(nextScale, maxScale);
    if (next <= ZOOM_SNAP_MAX && scale > ZOOM_SNAP_MAX) {
      scale = 1; tx = 0; ty = 0; apply(); return;
    }
    const anchored = anchorTranslate({ offsetX, offsetY, tx, ty, scale, nextScale: next });
    const fitW = img.clientWidth || 1;
    const fitH = img.clientHeight || 1;
    const clamped = clampPan({ tx: anchored.tx, ty: anchored.ty, fitW, fitH, scale: next, viewportW: fitW, viewportH: fitH });
    scale = next; tx = clamped.tx; ty = clamped.ty; apply();
  };

  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = img.getBoundingClientRect();
    const offsetX = e.clientX - (rect.left + rect.width / 2);
    const offsetY = e.clientY - (rect.top + rect.height / 2);
    zoomTo(wheelNextScale(scale, e.deltaY, maxScaleOf()), offsetX, offsetY);
  }, { passive: false });

  img.addEventListener('pointerdown', (e) => {
    if (scale <= 1) return;
    dragging = true; dragMoved = false;
    start = { x: e.clientX, y: e.clientY, tx, ty };
    img.setPointerCapture?.(e.pointerId);
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragMoved && Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return;
    dragMoved = true;
    const fitW = img.clientWidth || 1;
    const fitH = img.clientHeight || 1;
    const clamped = clampPan({ tx: start.tx + dx, ty: start.ty + dy, fitW, fitH, scale, viewportW: fitW, viewportH: fitH });
    img.style.transition = 'none';
    tx = clamped.tx; ty = clamped.ty; apply();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    img.style.transition = '';
    img.classList.remove('is-dragging');
  };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  img.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (scale > 1) zoomTo(1);
    else {
      const rect = img.getBoundingClientRect();
      zoomTo(
        ZOOM_DEFAULT_JUMP,
        e.clientX - (rect.left + rect.width / 2),
        e.clientY - (rect.top + rect.height / 2),
      );
    }
  });

  return {
    /** True exactly once if the last interaction was a real drag — the caller
     * uses this to swallow the trailing click that would dismiss the dialog. */
    consumeDraggedClick() {
      const was = dragMoved;
      dragMoved = false;
      return was;
    },
  };
}
