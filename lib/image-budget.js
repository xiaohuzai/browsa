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
