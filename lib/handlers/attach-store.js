// lib/handlers/attach-store.js — the single owner of the attachment-storage
// recipe (2026-09-20 deepening pass, candidate #2 of the architecture review).
// The recipe — attachId (the panel 撤销 button's undo identity, stamped on
// EVERY attach entry), history entry assembly, appendToHistory,
// boundUnseenImageBytes, and the willSummarize → maybeSummarizeAttachment
// kick — used to be spelled out five times (ATTACH_PAGE's tail + the four
// ATTACH_*_CONFIRM cases in attach-confirm-handler.js) and had already
// drifted: two sites hand-rolled the context header instead of calling
// buildPageContextText. Now the caller builds the pageContext (and, for
// multimodal entries, the content FROM the rendered contextText via
// `contentFrom`) and this function owns everything downstream of that.
import * as storage from '../storage.js';
import { buildPageContextText } from '../message-builder.js';
import { shouldSummarize, maybeSummarizeAttachment } from './attach-summarizer.js';
import { boundUnseenImageBytes } from './history-compactor.js';

/**
 * Stores one attachment entry and kicks the summarize pass.
 *
 * @param {object} opts
 * @param {object} opts.pageContext  ctx-shaped object consumed by
 *   buildPageContextText (meta/mode/text/format[/headerBlock]) AND passed on
 *   to maybeSummarizeAttachment — one object, both consumers.
 * @param {(contextText: string) => Array|string|null} [opts.contentFrom]
 *   Builds the history `content` from the rendered contextText (multimodal
 *   variants: screenshot append, PDF end-append, ASR/tail [图N] interleave).
 *   Return null/undefined to store the plain-string contextText (the default).
 * @param {object} [opts.videoSrc]  stamped on the entry so [mm:ss] markers
 *   render as clickable seek links (youtube/bilibili/ASR only).
 * @param {boolean} [opts.summarize=true]  screenshot passes false — pixels
 *   are compacted by boundUnseenImageBytes, not by the text summarizer.
 * @param {string} [opts.summarizeText]  the text shouldSummarize thresholds
 *   on; defaults to pageContext.text (ASR passes the pre-hint transcript so
 *   VIDEO_NOTE_HINT's ~340 chars can't tip an edge case over the threshold).
 * @param {string|(contextText: string) => string} [opts.log]  console log line.
 * @returns {Promise<{attachId: string, contextText: string}>}
 */
export async function storeAttachment({ pageContext, contentFrom, videoSrc, summarize = true, summarizeText, log }) {
  const all = summarize ? await storage.getAll() : null;
  const contextText = buildPageContextText(pageContext);
  const attachId = crypto.randomUUID();
  const historyEntry = {
    role: 'user',
    content: (contentFrom ? contentFrom(contextText) : null) || contextText,
    attachId, // undo identity — stamped on EVERY attach entry, summarized or not
  };
  if (videoSrc) historyEntry.videoSrc = videoSrc;
  await storage.appendToHistory(historyEntry);
  // Pixels park in history until the first successful chat turn compacts
  // them; cap total parked bytes so attach-without-ask usage can't bloat
  // every panel open. Fire-and-forget. (lib/handlers/history-compactor.js)
  boundUnseenImageBytes().catch(() => {});
  if (log) console.log(`browsa[bg]: ${typeof log === 'function' ? log(contextText) : log}`);
  if (summarize && all.autoSummarizeAttachments !== false
      && shouldSummarize(summarizeText ?? pageContext.text ?? '', all.summarizeThresholdChars)) {
    maybeSummarizeAttachment({
      attachId,
      ctx: pageContext,
      provider: all.providers?.[all.activeProvider],
      all,
    });
  }
  return { attachId, contextText };
}
