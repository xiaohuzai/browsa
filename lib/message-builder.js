// lib/message-builder.js - builds the chat messages array + page-context
// text from a pageContext object. Pure string/shape construction, no DOM or
// chrome deps - extracted out of page-extractor.js (along the same
// responsibility-split line as lib/site-synthesizers.js) since these never
// run in the page's MAIN world and have no "must be self-contained for
// chrome.scripting.executeScript" constraint. page-extractor.js is left with
// extraction only; assembling the {role, content} messages sent to the
// provider is a separate concern that belongs here.
//
// buildPageContextText renders the stored page-context block (the
// PAGE_CONTEXT_PREFIX-tagged text appended to an attached user turn, and what
// attach-summarizer rewrites onto a summarized entry). buildMessages assembles
// the full messages array for a chat turn (system prompt + page context +
// history + final user instruction, with vision image_url parts when the
// attachment carries images).
import { PAGE_CONTEXT_PREFIX } from './constants.js';
import { redactUrlCredentials, redactTextUrls } from './sanitize-url.js';

export function buildPageContextText(pageContext) {
  const { meta, mode, text, format, fallback, changedSinceLastAttach, headerBlock } = pageContext;
  const formatNote = format ? ` | ${format}` : '';
  const changeNote = changedSinceLastAttach
    ? `\nNote: this page's content has changed since it was last attached (previously attached ${new Date(changedSinceLastAttach.previousAttachedAt).toLocaleString()}).`
    : '';
  return (
    `${PAGE_CONTEXT_PREFIX}\n` +
    `URL: ${redactUrlCredentials(meta.url)}\n` +
    `Title: ${meta.title}\n` +
    // headerBlock (optional, pre-formatted, already \n-terminated — e.g. the
    // arXiv metadata block) rides the header between Title and Mode: model-
    // facing provenance stays up front without polluting the extracted body.
    `${headerBlock || ''}` +
    `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}${changeNote}\n` +
    `---\n\n${redactTextUrls(text || '')}`
  );
}

/**
 * Context aging: replace COLD attached-page blocks with a one-line stub before
 * sending, so a long session doesn't re-send every old page context on every
 * turn (the dominant latency on big-context chats — prefill scales with the
 * full resent history). Storage is NOT touched: the stub is computed at send
 * time from the entry itself, deterministically, so it is byte-identical on
 * every later turn (one cache-prefix break when a block ages, then stable
 * again) and the UI / transcript drawer keep reading the full text.
 *
 * What counts as cold (all three must hold):
 *   - it is NOT the most recent attach (the active page context is always
 *     kept whole — a "summarize the video I attached 4 turns ago" request
 *     must still see the transcript);
 *   - >= `minUserTurnsAfter` user turns have come after it (default 3);
 *   - its text is >= `minChars` (default 8000) — small attaches cost little
 *     and are often the actual reference material.
 *
 * The stub carries the attach's URL/title/size so the model can ask the user
 * to re-attach instead of hallucinating details. Entries that don't parse as
 * a browsa attach are left untouched.
 */
export function ageStaleAttachments(history, opts = {}) {
  const minUserTurnsAfter = opts.minUserTurnsAfter ?? 3;
  const minChars = opts.minChars ?? 8000;
  if (!Array.isArray(history) || history.length === 0) return history;

  const attachTextOf = (m) => {
    if (m?.role !== 'user') return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const part = m.content.find((p) => p?.type === 'text' || p?.type === 'input_text');
      return typeof part?.text === 'string' ? part.text : '';
    }
    return '';
  };
  const isAttach = (m) => attachTextOf(m).startsWith(PAGE_CONTEXT_PREFIX);

  const attachIdx = [];
  for (let i = 0; i < history.length; i++) if (isAttach(history[i])) attachIdx.push(i);
  if (attachIdx.length === 0) return history;
  const newestAttach = attachIdx[attachIdx.length - 1];

  // userTurnsAfter[i] = number of user entries after index i
  const userTurnsAfter = new Array(history.length).fill(0);
  let c = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    userTurnsAfter[i] = c;
    if (history[i]?.role === 'user') c++;
  }

  let changed = false;
  const out = history.slice();
  for (const i of attachIdx) {
    if (i === newestAttach) continue;
    if (userTurnsAfter[i] < minUserTurnsAfter) continue;
    const text = attachTextOf(history[i]);
    if (text.length < minChars) continue;
    const url = (/^URL: (.*)$/m.exec(text) || [])[1] || '';
    const title = (/^Title: (.*)$/m.exec(text) || [])[1] || '';
    out[i] = {
      ...history[i],
      content: `[Attached page context trimmed to keep replies fast — sent in full in an earlier turn]` +
        `${title ? `\nTitle: ${title}` : ''}${url ? `\nURL: ${url}` : ''}` +
        `\nOriginal size: ~${text.length} chars. If you need exact details from this page, ask the user to re-attach it.`,
    };
    changed = true;
  }
  return changed ? out : history;
}

/**
 * Context-overflow self-rescue (chat-handler's retry loop): when a send failed
 * because the conversation no longer fits the model's window, replace EVERY
 * attached-page block at or above `minChars` with a stub and drop its image
 * parts (PDF figures alone can be ~15K tokens — the retry cannot fit while
 * they ride along). Unlike context aging this includes the NEWEST attach: the
 * goal is not latency, it is making the very next request fit.
 *
 * Pure: returns { history, changed } — `history` is the rewritten array (the
 * input array is never mutated), `changed` lists { index, attachId, content }
 * for each replaced entry so the caller can persist the stubs (attachId-keyed,
 * same storage read-modify-write pattern as maybeSummarizeAttachment) and
 * rebuild its provider request shapes. Entries without PAGE_CONTEXT_PREFIX and
 * small attaches (below `minChars`, often the actual reference material) are
 * left untouched.
 */
export function stubOversizedAttachments(history, { minChars = 8000 } = {}) {
  if (!Array.isArray(history) || history.length === 0) return { history, changed: [] };
  const attachTextOf = (m) => {
    if (m?.role !== 'user') return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const part = m.content.find((p) => p?.type === 'text' || p?.type === 'input_text');
      return typeof part?.text === 'string' ? part.text : '';
    }
    return '';
  };
  const changed = [];
  const out = history.map((m, index) => {
    const text = attachTextOf(m);
    if (!text.startsWith(PAGE_CONTEXT_PREFIX) || text.length < minChars) return m;
    const url = (/^URL: (.*)$/m.exec(text) || [])[1] || '';
    const title = (/^Title: (.*)$/m.exec(text) || [])[1] || '';
    const content =
      `${PAGE_CONTEXT_PREFIX}\n` +
      `[browsa: this attachment was too large for the model's context window and was omitted so the conversation could continue]` +
      `${title ? `\nTitle: ${title}` : ''}${url ? `\nURL: ${url}` : ''}` +
      `\nOriginal size: ~${text.length} chars. If you need exact details from this page, ask the user to re-attach it.`;
    changed.push({ index, attachId: m.attachId || null, content });
    return { ...m, content };
  });
  return { history: out, changed };
}

/**
 * Build the messages array for a chat turn. Adds a system-style "user attachment"
 * prefix so the model understands the context.
 */
export function buildMessages({ history, userText, pageContext, withImage, userImages, systemPrompt }) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (pageContext) {
    const { meta, mode, text, textContent, format, imageDataUrl, imageBase64List, fallback } = pageContext;
    const formatNote = format ? ` | ${format}` : '';
    const header =
      `${PAGE_CONTEXT_PREFIX}\n` +
      `URL: ${redactUrlCredentials(meta.url)}\n` +
      `Title: ${meta.title}\n` +
      `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}\n` +
      `---`;

    // Images to include as vision content. Priority:
    // 1. XHS imageBase64List (v0.20.0 image-fetch path)
    // 2. Screenshot imageDataUrl (screenshot mode)
    const visionImages = (Array.isArray(imageBase64List) && imageBase64List.length > 0)
      ? imageBase64List.map((url) => ({ type: 'image_url', image_url: { url } }))
      : (withImage && imageDataUrl)
        ? [{ type: 'image_url', image_url: { url: imageDataUrl } }]
        : null;

    if (visionImages) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `${header}\n\n${redactTextUrls(text || '')}` },
          ...visionImages
        ]
      });
    } else {
      messages.push({ role: 'user', content: `${header}\n\n${redactTextUrls(text || '')}` });
    }
  }

  // Append conversation history (skip the last user message we just added if any)
  if (history && history.length) {
    for (const m of history) {
      // Avoid duplicating the page-context message we just pushed
      if (pageContext && messages.length && m === messages[0]) continue;
      messages.push(m);
    }
  }

  // Final user instruction (with optional pasted/dropped images)
  if (userImages && userImages.length > 0) {
    const content = [{ type: 'text', text: userText || 'Describe these images.' }];
    for (const dataUrl of userImages) {
      content.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userText || '(no instruction; just respond to the page context)' });
  }

  return messages;
}

/**
 * 把文本按 [图N] 内联锚点拆分，图片部件插入其锚点位置（真交错多模态 content）。
 *
 * 这是 browsa 对"文字+图片如何喂给 LLM"的统一约定（对标 ImageRef-VL /
 * InterleavedReferencing 一类内联引用方案，Anthropic 官方 PDF 指南的按页交错
 * 也是同思路）：锚点行 `…[图N]…`（N 从 1 起）标记图片在文档中的语义位置，图片
 * 部件严格出现在其锚点之后，模型无需在文末编号列表里反推对应关系。
 *
 * - 锚点行整体保留在其所属文本片段里（时间戳、caption 等上下文不丢）。
 * - N 越界（> images.length）的锚点行按普通文本保留。
 * - 无任何可解析锚点 → [text, ...images]（PDF 无位置信息的形状）。
 * - images 为空 → 原样返回字符串（history 形状不变，text-only 入口零开销）。
 *
 * @param {string} text 全文（含 [图N] 锚点行）
 * @param {Array<{url:string}|string>} images 按文档顺序的图片
 * @returns {string|Array} OpenAI 形状 content：字符串或 {type:text|image_url} 部件数组
 */
export function interleaveImageParts(text, images) {
  const imgs = (Array.isArray(images) ? images : []).filter(Boolean);
  if (!imgs.length) return String(text || '');
  // 兼容三种入参形状：'dataURL' 字符串、{url}（figureImages）、
  // {type:'image_url', image_url:{url}}（history 条目里的部件，attach-summarizer 复用）。
  const urlOf = (img) => (typeof img === 'string' ? img : img.url ?? (typeof img.image_url === 'string' ? img.image_url : img.image_url?.url));
  const parts = [];
  let buf = '';
  // Track WHICH images were placed, not how many anchors were seen: a model can
  // emit anchors out of order or skip one (e.g. only `[图2]`). Counting anchors
  // (`used++`) then appending from index `used` duplicated the placed image and
  // never emitted imgs[0]. The Set makes the tail append drop only the images
  // that were genuinely placed.
  const placed = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = /\[图(\d+)\]/.exec(line);
    const n = m ? parseInt(m[1], 10) : 0;
    buf += (buf ? '\n' : '') + line;
    if (n >= 1 && n <= imgs.length && !placed.has(n - 1)) {
      parts.push({ type: 'text', text: buf });
      parts.push({ type: 'image_url', image_url: { url: urlOf(imgs[n - 1]) } });
      placed.add(n - 1);
      buf = '';
    }
  }
  if (buf.trim() || parts.length === 0) parts.push({ type: 'text', text: buf });
  // 未被任何锚点引用的图片按序追加在尾部（PDF 无位置信息的兜底形状）
  for (let i = 0; i < imgs.length; i++) {
    if (placed.has(i)) continue;
    parts.push({ type: 'image_url', image_url: { url: urlOf(imgs[i]) } });
  }
  return parts;
}

// ─── 无状态 wire 协议的请求形状 builders（C9 自 chat-handler.js 迁入） ─────
// 「一轮对话怎么变成请求形状」的实现自此全住本模块：chat-handler 只编排
// （WHEN + 流分发），turn-request 直接 import（此前经参数注入回流，纯为绕开
// import cycle）。均为纯函数，导出供单元测试直取。

/**
 * Build Hermes /v1/runs `conversation_history` from local-storage history.
 *
 * /v1/runs 契约（2026-09-24 按服务器源码订正）：history content 一律字符串
 * ——多模态 entry 扁平化为文本 + [image] 标记（服务端 str() 数组会把 base64
 * 灌进提示词，部件也到不了严格层）；partStyle='responses' 时保留
 * input_text/input_image 多模态部件（/v1/responses 的原生拼写）。
 *
 * This replaces an earlier text-only flatten. Verified against a live Hermes
 * endpoint: a red 1×1 PNG placed in conversation_history (as input_image) was
 * correctly identified by the model ("red"), while a no-image control was not
 * -- i.e. conversation_history images ARE processed. (Current-turn `input`
 * images, by contrast, route through Hermes's `vision_analyze` tool, which may
 * be unconfigured -- so history is the reliable path for page-context images.)
 *
 * Exported for direct unit testing (handleChat needs a heavier chrome.storage
 * mock than the suite provides; this pure helper does not).
 */
export function buildRunsConversationHistory(history, { partStyle = 'flatten' } = {}) {
  return (history || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      let content = m.content;
      if (Array.isArray(content)) {
        if (partStyle === 'responses') {
          // /v1/responses 渠道保留多模态部件（input_text/input_image 是该 API 的
          // 原生拼写，历史图片可达模型）。
          const parts = [];
          for (const p of content) {
            if (p.type === 'text' || p.type === 'input_text') {
              if (p.text) parts.push({ type: 'input_text', text: p.text });
            } else if (p.type === 'image_url') {
              const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
              if (url) parts.push({ type: 'input_image', image_url: url });
            }
          }
          content = parts.length ? parts : '';
        } else {
          // /v1/runs 契约（2026-09-24 真机 422 后按服务器源码订正）：
          // conversation_history 的 content 只吃字符串——数组会被服务端 str()
          // 成 Python repr（base64 原样灌进提示词烧 token），部件也到不了严格层。
          // 文本按段拼接，图片降级 [image] 标记（不留 base64）。
          content = flattenHermesHistoryContent(content);
        }
      } else {
        content = String(content || '');
      }
      return { role: m.role, content };
    })
    .filter(m => {
      const c = m.content;
      if (typeof c === 'string') return c.trim().length > 0;
      return Array.isArray(c) && c.length > 0;
    });
}

/**
 * 多模态 content → /v1/runs 历史用的纯字符串：文本段按行拼接，每个图片部件
 * 降级为一个 [image] 标记（历史图片在当前 /v1/runs 无通道，见上方注释）。
 * 纯函数，导出供测试钉住「不泄漏 base64」。
 */
export function flattenHermesHistoryContent(content) {
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' || p.type === 'input_text') {
      if (p.text) out.push(p.text);
    } else if (p.type === 'image_url' || p.type === 'input_image') {
      out.push('[image]');
    }
  }
  return out.join('\n');
}

/**
 * Build the `input` + `conversation_history` for a Hermes /v1/runs turn.
 *
 * Pasted images (msg.images) go directly into `input` as `input_image` parts
 * alongside the text, and `conversation_history` is just the built prior
 * history. The Hermes model reads current-turn input images natively on a
 * vision-capable server (verified live: a solid-color image and a bar-count
 * image were both read correctly on `/v1/runs` input, `/v1/chat/completions`,
 * and `/v1/responses`).
 *
 * History note: an earlier version routed pasted images into a SYNTHETIC
 * trailing `conversation_history` turn instead of `input`, to work around a
 * Hermes server whose `vision_analyze` tool pointed at a text-only model
 * (input images failed there, while history images were read as native tokens).
 * That workaround is no longer needed now that the server runs a vision-capable
 * model, and it split the user's text from its images (less semantically
 * correct). If a server's vision input is ever broken again, the symptom is the
 * model saying "my active model doesn't support image input" / "vision analysis
 * failed" - fix the server's model, not this code.
 *
 * Exported for direct unit testing (handleChat needs a heavier chrome.storage
 * mock than the suite provides).
 */
export function buildHermesTurn(msg, history) {
  const conversationHistory = buildRunsConversationHistory(history);
  if (msg?.images?.length) {
    // 规范 chat 风格部件（2026-09-24 真机 422）：agent 管线的严格层只认
    // text/image_url/file——input_text/input_image 只是入口归一化白名单的别名，
    // /v1/runs 的解析不过归一化、部件原样递进管线，别名在那被 422。
    // image_url 用 {url} 对象形（网关 _normalize_image_part 的规范输出形）。
    const parts = [{ type: 'text', text: msg.userText || '' }];
    for (const url of msg.images) parts.push({ type: 'image_url', image_url: { url } });
    return { input: [{ role: 'user', content: parts }], conversationHistory };
  }
  return { input: msg?.userText || '', conversationHistory };
}

/**
 * History for the auto timestamp-rewrite second pass. The rewrite only needs
 * the video transcript + the v1 notes — NOT the whole session (a second
 * full-context pass on a big session roughly doubled the wall time). Uses the
 * RAW history (not the context-aged copy) so an aged transcript is still
 * available here, and falls back to the full history when the videoSrc-stamped
 * entry can't be found (e.g. trimmed out from the front by storage caps).
 * Exported for direct unit testing.
 */
export function buildTimestampRewriteHistory(history, videoSrc, userText, assistantReply) {
  let videoEntry = null;
  if (videoSrc) {
    for (let i = (history?.length || 0) - 1; i >= 0; i--) {
      if (history[i]?.videoSrc === videoSrc) { videoEntry = history[i]; break; }
    }
  }
  const userTurn = { role: 'user', content: userText || '(no instruction)' };
  const asstTurn = { role: 'assistant', content: assistantReply || '' };
  if (!videoEntry) return [...(history || []), userTurn, asstTurn];
  return [videoEntry, userTurn, asstTurn];
}

/**
 * Build the `input` for the OpenAI Responses API (/v1/responses): all prior
 * history in input_text / input_image parts (reusing buildRunsConversationHistory
 * — /v1/responses and /v1/runs share the same input part schema), plus the
 * current user turn with any pasted images. The system prompt goes in the
 * separate `instructions` field, NOT as a system message in input.
 * Exported for direct unit testing.
 */
export function buildResponsesInput(msg, history) {
  const prior = buildRunsConversationHistory(history, { partStyle: 'responses' });
  if (msg?.images?.length) {
    const parts = [{ type: 'input_text', text: msg.userText || '' }];
    for (const url of msg.images) parts.push({ type: 'input_image', image_url: url });
    prior.push({ role: 'user', content: parts });
  } else {
    prior.push({ role: 'user', content: msg?.userText || '' });
  }
  return prior;
}

// Extract media_type + base64 data from an image data URL (Anthropic needs
// base64 source blocks, unlike OpenAI's data: image_url passthrough).
function splitImageDataUrl(url) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(url || ''));
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

/**
 * Build the messages array for the Anthropic Messages API (/v1/messages):
 * [{role:'user'|'assistant', content: string | blocks}]. The system prompt is
 * returned separately (Anthropic's `system` top-level field, not a message).
 * Pasted data: URLs become {type:'image', source:{type:'base64', ...}} blocks;
 * history image_url parts are skipped (their pixels are only reachable via the
 * data URL in this session — Anthropic needs base64, which the compacted/history
 * parts don't carry in a usable form). Exported for direct unit testing.
 */
export function buildAnthropicMessages(msg, history) {
  const out = [];
  const pushContent = (role, content) => {
    if (!content || (Array.isArray(content) && content.length === 0)) return;
    out.push({ role, content });
  };
  for (const m of history || []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let c = m.content;
    if (Array.isArray(c)) {
      const parts = [];
      for (const p of c) {
        if (p.type === 'text' || p.type === 'input_text') {
          if (p.text) parts.push({ type: 'text', text: p.text });
        } else if (p.type === 'image_url') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
          const src = url && splitImageDataUrl(url);
          if (src) parts.push({ type: 'image', source: { type: 'base64', media_type: src.mediaType, data: src.data } });
        }
      }
      c = parts;
    } else {
      c = String(c || '');
    }
    pushContent(m.role, c);
  }
  // Current user turn + pasted images
  if (msg?.images?.length) {
    const parts = [{ type: 'text', text: msg.userText || '' }];
    for (const url of msg.images) {
      const src = splitImageDataUrl(url);
      if (src) parts.push({ type: 'image', source: { type: 'base64', media_type: src.mediaType, data: src.data } });
    }
    out.push({ role: 'user', content: parts });
  } else {
    pushContent('user', msg?.userText || '');
  }
  return out;
}

