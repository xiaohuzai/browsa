// lib/image-budget.js — neutral per-turn image caps, shared by every provider
// path that forwards a turn's images (the fixed agent providers, and the
// stateless LLM legs: chat/completions, responses, anthropic).
//
// The caps started life in agent-turn.js (first consumer). They are sized for
// the bridge daemon's request-body headroom — 18 images / 4.5M chars fits
// agent-bridge ≥0.8.0's 16MB body (the 2026-10 relax that made full 18-image
// 小红书 note attaches deliverable); older bridges reject the turn with a 400,
// and bridge-client's fallback degrades those to "first 8 + a text note"
// instead of failing. The same limits also protect the LLM legs from a large
// paste blowing the request body or the provider context window. Kept
// provider-agnostic on purpose — see lib/agent-turn.js, which re-exports these
// so its existing consumers/tests are unaffected.

export const AGENT_TURN_MAX_IMAGES = 18;
export const AGENT_TURN_IMAGE_BUDGET_CHARS = 4.5 * 1024 * 1024;

// Site byte-images (小红书/推特/Reddit MAIN-world fetches) are capped by BUDGET,
// not by a fixed count — a 15-image note is exactly the case where the content
// lives in the images (2026-10-11 field report: browsa described 5 of 15).
// 18 = XHS's per-note platform maximum; the char budget bounds the executeScript
// payload and the stored entry (~4.5M chars ≈ 3.4MB binary at 1024px JPEG, well
// under boundUnseenImageBytes' 8MB parked budget). Agent TURNS stay at
// AGENT_TURN_* above — the bridge daemon's 4MB body is a protocol limit we
// cannot spend here.
export const SITE_IMAGES_MAX_COUNT = 18;
export const SITE_IMAGES_BUDGET_CHARS = 4.5 * 1024 * 1024;

/** Trim a fetched dataURL list to count + total-chars budgets, first-fit in
 * order (an oversized image is skipped; later smaller ones can still fill the
 * leftover budget — same rule as pickTurnImages). Pure; exported for tests.
 * The MAIN-world fetchers break at their FIRST overflow to bound the
 * executeScript payload (a transport shortcut, not a semantic difference:
 * images they never fetched can't be kept by anyone); this SW-side trim is
 * the authority applied to whatever did come back. */
export function capFetchedImages(list, {
  maxCount = SITE_IMAGES_MAX_COUNT,
  budgetChars = SITE_IMAGES_BUDGET_CHARS,
} = {}) {
  const images = [];
  let total = 0;
  let dropped = 0;
  for (const raw of (Array.isArray(list) ? list : [])) {
    const url = typeof raw === 'string' ? raw : '';
    if (!url) { dropped++; continue; }
    if (images.length >= maxCount) { dropped++; continue; }
    if (total + url.length > budgetChars) { dropped++; continue; }
    images.push(url);
    total += url.length;
  }
  return { images, dropped };
}

/** Shape gate: only http(s) URLs or data: IMAGE urls. A single malformed URI
 * poisons a whole turn on some providers (the bridge 400s /turns; opencode
 * fails the turn server-side with "OpenAI Chat media must contain valid
 * base64" before the provider is ever called), so anything not matching is
 * dropped. */
export function isAgentImageUrl(u) {
  return typeof u === 'string' && /^(https?:\/\/|data:image\/)/i.test(u.trim());
}

/** Why a candidate would be dropped if added to `current` (a list of accepted
 * URL strings) — null when it fits. Same rules, same order, same comparisons as
 * pickTurnImages, so the composer can refuse at ATTACH time exactly what the
 * turn would otherwise drop at send time. That matters because a send-time drop
 * is invisible in the UI (the thumbnail is long gone by then: the composer
 * clears the strip on send), so it reads to the user as "my paste did nothing".
 * Reasons: 'shape' | 'count' | 'size' | 'budget'. Pure; exported for tests. */
export function imageRejectReason(current, url) {
  const candidate = typeof url === 'string' ? url.trim() : '';
  if (!isAgentImageUrl(candidate)) return 'shape';
  const list = Array.isArray(current) ? current : [];
  if (list.length >= AGENT_TURN_MAX_IMAGES) return 'count';
  if (candidate.length > AGENT_TURN_IMAGE_BUDGET_CHARS) return 'size';
  const total = list.reduce((n, u) => n + (typeof u === 'string' ? u.length : 0), 0);
  return total + candidate.length > AGENT_TURN_IMAGE_BUDGET_CHARS ? 'budget' : null;
}

/** Apply the shared image limits to a candidate list, keeping as many as fit
 * (first-fit in order — after a large image is dropped, later smaller ones can
 * still fill leftover budget). Pure; exported for unit tests. */
export function pickTurnImages(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const images = [];
  let total = 0;
  let dropped = 0;
  for (const raw of list) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!isAgentImageUrl(url)) { dropped++; continue; }
    if (images.length >= AGENT_TURN_MAX_IMAGES) { dropped++; continue; }
    if (url.length > AGENT_TURN_IMAGE_BUDGET_CHARS) { dropped++; continue; }
    if (total + url.length > AGENT_TURN_IMAGE_BUDGET_CHARS) { dropped++; continue; }
    images.push(url);
    total += url.length;
  }
  return { images, dropped };
}

/** Model-facing anchor for a turn's OWN images, using the [图N] convention of
 * the interleaved-figure pipeline. Pins「这张图 / 这个图片」to THIS turn's
 * attachments — needed on the paths whose context keeps earlier images as
 * PIXELS forever (bridge/opencode server-side transcripts, Hermes
 * conversation_history): there "这个图片" is ambiguous and the model silently
 * answers about an older image (user-reported 2026-09-25: a fresh paste was
 * seen but the reply anchored to「第一张图」). The stateless LLM legs skip it —
 * their history images are label-compacted (`[image N]`) before the request,
 * so the fresh pixels are unambiguous there. Pure; '' when no images. */
export function imageAnchorNote(count) {
  const n = Number(count) || 0;
  if (!n) return '';
  const span = n > 1 ? `[图1]…[图${n}]` : '[图1]';
  return `（注：本条消息随附 ${n} 张图片，按附图顺序即 ${span}；用户说「这张图」「这个图片」时指的就是它们，不是对话里更早的图。）`;
}
