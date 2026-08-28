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

export function buildPageContextText(pageContext) {
  const { meta, mode, text, format, fallback, changedSinceLastAttach } = pageContext;
  const formatNote = format ? ` | ${format}` : '';
  const changeNote = changedSinceLastAttach
    ? `\nNote: this page's content has changed since it was last attached (previously attached ${new Date(changedSinceLastAttach.previousAttachedAt).toLocaleString()}).`
    : '';
  return (
    `${PAGE_CONTEXT_PREFIX}\n` +
    `URL: ${meta.url}\n` +
    `Title: ${meta.title}\n` +
    `Mode: ${mode}${formatNote}${fallback ? ' (fallback to full)' : ''}${changeNote}\n` +
    `---\n\n${text || ''}`
  );
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
      `URL: ${meta.url}\n` +
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
          { type: 'text', text: `${header}\n\n${text || ''}` },
          ...visionImages
        ]
      });
    } else {
      messages.push({ role: 'user', content: `${header}\n\n${text || ''}` });
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
  let used = 0;
  for (const line of String(text || '').split('\n')) {
    const m = /\[图(\d+)\]/.exec(line);
    const n = m ? parseInt(m[1], 10) : 0;
    buf += (buf ? '\n' : '') + line;
    if (n >= 1 && n <= imgs.length) {
      parts.push({ type: 'text', text: buf });
      parts.push({ type: 'image_url', image_url: { url: urlOf(imgs[n - 1]) } });
      buf = '';
      used++;
    }
  }
  if (buf.trim() || parts.length === 0) parts.push({ type: 'text', text: buf });
  // 未被锚点引用的图片按序追加在尾部（PDF 无位置信息的兜底形状）
  for (let i = used; i < imgs.length; i++) {
    parts.push({ type: 'image_url', image_url: { url: urlOf(imgs[i]) } });
  }
  return parts;
}
