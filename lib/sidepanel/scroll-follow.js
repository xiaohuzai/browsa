// lib/sidepanel/scroll-follow.js — pure decision helpers for the streaming
// scroll follower and the scroll-edge feather (2026-10-17 motion pass).
// sidepanel.js owns the DOM and the listeners; these are the decisions, kept
// pure so they're testable without a scrollport (same split as
// history-reconcile.js).
//
// Follower physics (ported from the Claude design system's scroll pinning):
// while a reply is streaming, the follower must not fight the user's hand —
// a wheel/touch flick starts a short cooldown during which programmatic
// "stick to bottom" is suppressed even though the viewport is still (just)
// inside the bottom tolerance. force=true (user action, new message, DONE)
// always follows: the cooldown only protects ACTIVE scrolling, not intent.

export const SCROLL_FOLLOW_COOLDOWN_MS = 150;
export const SCROLL_UP_TOLERANCE_PX = 80; // existing isUserScrolledUp threshold
export const EDGE_FADE_GUARD_PX = 2;      // at-edge guard for the feather classes

export function distanceFromBottom({ scrollHeight, scrollTop, clientHeight }) {
  return scrollHeight - scrollTop - clientHeight;
}

/** The scroll listener's decision: has the user manually scrolled up? */
export function isUserScrolledUp({ scrollHeight, scrollTop, clientHeight, tolerancePx = SCROLL_UP_TOLERANCE_PX }) {
  return distanceFromBottom({ scrollHeight, scrollTop, clientHeight }) > tolerancePx;
}

/** The per-tick follower's decision. `lastUserScrollInputAt` defaults to
 * -Infinity (no input yet → no cooldown), so the very first programmatic
 * follow after panel open is never blocked by the document's own clock. */
export function shouldFollowStream({
  force = false,
  isUserScrolledUp,
  lastUserScrollInputAt = -Infinity,
  now = 0,
  cooldownMs = SCROLL_FOLLOW_COOLDOWN_MS,
}) {
  if (force) return true;
  if (isUserScrolledUp) return false;
  return now - lastUserScrollInputAt >= cooldownMs;
}

/** Which feather classes the scroll position calls for. The TOP feather is
 * on when NOT at the top, the BOTTOM feather when NOT at the bottom (±guard):
 * a fully scrolled viewport must never feather the line being read. */
export function edgeFadeClasses({ scrollHeight, scrollTop, clientHeight, guardPx = EDGE_FADE_GUARD_PX }) {
  const atTop = scrollTop <= guardPx;
  const atBottom = distanceFromBottom({ scrollHeight, scrollTop, clientHeight }) <= guardPx;
  return { fadeT: !atTop, fadeB: !atBottom };
}
