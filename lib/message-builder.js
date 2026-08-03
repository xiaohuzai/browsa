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
