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
    destroy: () => { unsubscribe(); controller.destroy(); },
  };
}
