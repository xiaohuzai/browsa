// lib/sidepanel/reveal-pacer.js — thin wrapper around markstream-core's
// createSmoothMarkdownStream, so callers don't need its raw
// snapshot-diffing API. Purely a pacing layer: it decides *when* enqueued
// text becomes visible, never how it's parsed or painted. Self-terminates
// its internal requestAnimationFrame loop once caught up (confirmed by
// reading markstream-core's source), so an undestroyed pacer with no more
// enqueues does not leak a persistent timer — destroy() is still correct
// hygiene for a pacer abandoned mid-backlog.
import { createSmoothMarkdownStream } from '../vendor/markstream-core.bundle.js';

export function createRevealPacer(onReveal) {
  const controller = createSmoothMarkdownStream();
  let revealedLen = 0;
  const unsubscribe = controller.subscribe(() => {
    const { visible } = controller.getSnapshot();
    if (visible.length > revealedLen) {
      const delta = visible.slice(revealedLen);
      revealedLen = visible.length;
      onReveal(delta);
    }
  });
  return {
    enqueue: controller.enqueue,
    // Reveal the ENTIRE enqueued backlog synchronously, bypassing the
    // chars-per-second pacing (empirically verified against the vendored
    // markstream-core: flush() moves all pending text to visible at once).
    // Used by the mid-stream resume seed: that text ALREADY exists — pacing
    // it re-types a 30KB reasoning reply over ~30s at the 1000 chars/s
    // default, the opposite of "user sees something immediately". Only
    // genuinely live deltas should be paced.
    flush: controller.flush,
    destroy: () => { unsubscribe(); controller.destroy(); },
  };
}
