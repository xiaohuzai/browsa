// lib/agent-turn.js — shared turn-shape + image caps for the FIXED AGENT
// providers (bridge / opencode). This is the deliberately COMMON layer: both
// providers send only the user's turn (the agent keeps its own transcript),
// so the trailing-page-context walk, the image collection, and the image
// size limits are identical for both and live here — one implementation, no
// drift. Provider-specific wire details stay in their own clients
// (lib/bridge-client.js, lib/opencode-client.js); pure LLM message assembly
// stays in message-builder.js.

import { PAGE_CONTEXT_PREFIX } from './constants.js';

// ─── Image caps ──────────────────────────────────────────────────────────────
// Both fixed agent providers carry a turn's images as URL strings — the bridge
// as /turns' `images` array (daemon cap: ≤8, bounded by its 4MB JSON body
// cap), opencode as prompt `files` attachments ({uri} data: URLs, verified
// live on 1.18.29 to reach the model). browsa pre-applies the shared limits
// here so an over-budget turn degrades to "text + a note" instead of a 4xx
// killing the whole turn. The budget counts raw URL string chars (a data
// URL's base64 ≈ 4/3 of its binary size), leaving ~1MB of the bridge's 4MB
// body for the turn text and JSON overhead.
export const AGENT_TURN_MAX_IMAGES = 8;
export const AGENT_TURN_IMAGE_BUDGET_CHARS = 3 * 1024 * 1024;

/** Shape gate shared by the clients' defensive filters: only http(s) URLs or
 * data: IMAGE urls. A single malformed URI poisons the whole turn on both
 * providers (the bridge 400s /turns; opencode fails the turn server-side with
 * "OpenAI Chat media must contain valid base64" before the provider is ever
 * called), so anything not matching is dropped. */
export function isAgentImageUrl(u) {
  return typeof u === 'string' && /^(https?:\/\/|data:image\/)/i.test(u.trim());
}

/** Apply the shared image limits to a candidate list, keeping as many as fit
 * (first-fit in order — after a large image is dropped, later smaller ones
 * can still fill leftover budget). Pure; exported for unit tests. */
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

/** Combine a built turn text with its capped image list: drops over-budget
 * images and appends a note when any were dropped, so the agent knows images
 * existed and were omitted (model-facing, like the attach directive). */
export function withTurnImages(text, images) {
  const picked = pickTurnImages(images);
  const note = picked.dropped
    ? `\n\n（注：另有 ${picked.dropped} 张图片因超出单条消息大小上限未能随附。）`
    : '';
  return { text: text + note, images: picked.images };
}

// ─── Turn shape ──────────────────────────────────────────────────────────────

/** Build the single turn for a fixed agent provider. Returns `{text, images}`.
 *
 * Sends ONLY the user's turn (the agent keeps its own transcript — full-
 * history resend would fight the agent's own context management). Page
 * context is the exception: it lives only in browsa's local history and the
 * agent has never seen it, so the trailing run of page-context user turns IS
 * forwarded (one attach = one turn; consecutive attaches before a question
 * are forwarded together). Later questions rely on the agent retaining that
 * turn in its own session transcript.
 * Interleaved text parts (图文交错条目) are ALL joined — taking only the
 * first segment silently drops the body (squilla lesson, 2026-09-01).
 *
 * `images` collects the current turn's own images (msg.images) FIRST (so
 * budget pressure drops stale attach figures before fresh pastes), then the
 * image_url parts of the trailing page-context run in attach order
 * (screenshots / PDF figures / video keyframes — the agent has never seen
 * those either). Exported for unit tests. */
export function buildAgentTurn(msg, history) {
  const parts = [];
  const contexts = [];
  const runImages = [];
  for (let i = (history?.length || 0) - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== 'user') break;
    let text = null;
    if (typeof m.content === 'string' && m.content.startsWith(PAGE_CONTEXT_PREFIX)) {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const texts = m.content
        .filter(p => p?.type === 'text' && typeof p.text === 'string')
        .map(p => p.text);
      const joined = texts.join('\n');
      if (texts.some(t => t.startsWith(PAGE_CONTEXT_PREFIX)) && joined.trim()) text = joined;
      // image_url parts of this attach entry, in entry order — unshift keeps
      // attach order across the reverse walk.
      const entryImages = m.content
        .filter(p => p?.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url)
        .map(p => p.image_url.url);
      if (entryImages.length) runImages.unshift(...entryImages);
    }
    if (!text) break;
    contexts.unshift(text);
  }
  if (contexts.length) {
    // Tell the agent the content is attached locally, so it answers from it
    // instead of habitually fetching the URL itself.
    contexts.push('（注：以上是用户已在本地附加的完整页面内容——含全部文字与截图，回答时直接基于它，不要重新访问或抓取该 URL。）');
    parts.push(...contexts);
  }
  if (msg?.userText) parts.push(msg.userText);
  return {
    text: parts.join('\n\n'),
    images: [...(Array.isArray(msg?.images) ? msg.images : []), ...runImages],
  };
}
