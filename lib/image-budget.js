// lib/image-budget.js — neutral per-turn image caps, shared by every provider
// path that forwards a turn's images (the fixed agent providers, and the
// stateless LLM legs: chat/completions, responses, anthropic).
//
// The caps started life in agent-turn.js (first consumer). They are sized for
// the bridge daemon's 4 MB JSON body cap, and the same limits also protect the
// LLM legs from a large paste blowing the request body or the provider context
// window. Kept provider-agnostic on purpose — see lib/agent-turn.js, which
// re-exports these so its existing consumers/tests are unaffected.

export const AGENT_TURN_MAX_IMAGES = 8;
export const AGENT_TURN_IMAGE_BUDGET_CHARS = 3 * 1024 * 1024;

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
