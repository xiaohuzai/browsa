// lib/handlers/attach-summarizer.js — auto-summarize very long page/video
// attachments before they enter history. Ported from auditing BiliNote's
// chunk-summarize-merge pipeline for long transcripts.
//
// Why this exists: an attached page/video's extracted text is stored
// verbatim as a role:'user' history entry (background.js's ATTACH_PAGE
// case), and buildMessages() re-sends the FULL history on every subsequent
// turn — so an oversized attachment isn't a one-time cost, it's resent in
// full on every message for the rest of the session, and can silently
// exceed a smaller-context provider's window (browsa's own maxTextChars
// cap defaults to 1M chars, far above what many self-hosted/local
// providers can handle).
//
// The raw attach text is never rendered in the chat bubble (the UI only
// shows a small "已附加" chip, driven by PAGE_CONTEXT_PREFIX detection, not
// by rendering `content`) — so replacing the stored entry's content after
// the fact requires zero UI changes. This lets maybeSummarizeAttachment()
// run fire-and-forget, AFTER the ATTACH_PAGE response has already been
// sent, with no "compressing..." progress UI needed.
//
// Every failure mode (provider not configured, network error, timeout,
// empty/garbage result, the entry having been removed/undone/truncated by
// the time summarization finishes) is caught and left as a silent no-op —
// the original raw entry is NEVER touched on any failure path, so the
// worst case is identical to today's already-shipped behavior (full text
// kept, resent every turn).

import * as storage from '../storage.js';
import { chatStream, DEFAULT_MAX_TOKENS } from '../llm-client.js';
import { buildPageContextText } from '../message-builder.js';
import { splitIntoMarkdownChunks } from '../markdown-chunker.js';

const DEFAULT_THRESHOLD_CHARS = 100_000;
const DEFAULT_CHUNK_CHARS = 12_000;
const CHUNK_TIMEOUT_MS = 90_000;

export function shouldSummarize(text, thresholdChars) {
  const threshold = thresholdChars && thresholdChars > 0 ? thresholdChars : DEFAULT_THRESHOLD_CHARS;
  return !!text && text.length > threshold;
}

// Greedy line-respecting packing — never splits mid-line, since every
// transcript line is a "[mm:ss] text" unit that must stay intact for the
// timestamp-preservation instructions below to make sense.
export function splitIntoChunks(text, chunkSizeChars = DEFAULT_CHUNK_CHARS) {
  if (!text) return [];
  const lines = text.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the newline that'll rejoin it
    // A single line longer than the budget still gets pushed as its own
    // (oversized) chunk on the next iteration rather than looping forever —
    // `current.length > 0` guards against flushing an empty pending chunk.
    if (current.length > 0 && currentLen + lineLen > chunkSizeChars) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

function isVideoMode(mode) {
  return mode === 'youtube' || mode === 'bilibili';
}

function chunkSummaryPrompt(mode) {
  return isVideoMode(mode)
    ? 'You are compressing one segment of a long timestamped video transcript (lines formatted as "[mm:ss] text") so it can be used to write video notes later. Condense repetitive, filler, and low-information content, merging closely related consecutive lines into a single condensed point. CRITICAL: every point you keep MUST retain its original [mm:ss] timestamp marker exactly as written (use the earliest timestamp among lines merged into one point) — never invent, renumber, or drop timestamp brackets. Output condensed lines in the same "[mm:ss] point" format only — no preamble, no explanation.'
    : 'You are compressing one segment of a long document so it can be used as context for later questions. Condense it into a shorter version that preserves all key facts, names, numbers, dates, and direct quotes — drop repetition and filler. Output only the condensed text — no preamble, no explanation.';
}

function mergePrompt(mode) {
  return isVideoMode(mode)
    ? 'You are given several condensed segments of the same timestamped video transcript, in chronological order. Merge them into one continuous condensed transcript. Keep every [mm:ss] marker exactly as given — never renumber or invent timestamps. Remove only exact duplicate points that appear at segment boundaries. Output only the merged transcript — no preamble, no explanation.'
    : 'You are given several condensed segments of the same document, in original order. Merge them into one coherent condensed document, removing duplicate points that appear at segment boundaries. Output only the merged text — no preamble, no explanation.';
}

async function callSummarizer(provider, systemPrompt, userText) {
  const result = await chatStream({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ],
    onDelta: () => {}, // never surfaced to any UI — not tied to any chat turn's port/streamState
    signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    temperature: provider.temperature,
    // Chat turns fall back to DEFAULT_MAX_TOKENS when the provider leaves
    // maxTokens unset; the summarizer used to pass the raw value, so
    // chatStream omitted max_tokens and many OpenAI-compatible servers
    // applied a small default (~4096) that silently cut each chunk summary
    // mid-sentence (finishReason was discarded, so nothing noticed).
    maxTokens: provider.maxTokens > 0 ? provider.maxTokens : DEFAULT_MAX_TOKENS
  });
  const text = (result?.full || '').trim();
  if (result?.finishReason === 'length' && text) {
    console.warn('[browsa] summarize chunk hit max_tokens cap — output may be truncated');
  }
  return text;
}

// Chunk + summarize each chunk in parallel (independent — chatStream has no
// shared module-level mutable state, safe to run concurrently), then one
// final merge call. Throws on any failure so the caller can leave the
// original content untouched rather than storing a half-done result.
export async function summarizeLongText({ text, mode, provider, chunkSizeChars = DEFAULT_CHUNK_CHARS }) {
  const chunks = splitIntoMarkdownChunks(text, chunkSizeChars);
  if (chunks.length === 0) return text;
  if (chunks.length === 1) return await callSummarizer(provider, chunkSummaryPrompt(mode), text);

  const summaries = await Promise.all(
    chunks.map((chunk, i) =>
      callSummarizer(provider, chunkSummaryPrompt(mode), `[Segment ${i + 1}/${chunks.length}]\n${chunk}`)
    )
  );
  return await callSummarizer(
    provider,
    mergePrompt(mode),
    summaries.map((s, i) => `[Segment ${i + 1}]\n${s}`).join('\n\n')
  );
}

// Fire-and-forget entry point called from background.js's ATTACH_PAGE case
// AFTER the raw (unsummarized) entry has already been appended to history.
export async function maybeSummarizeAttachment({ attachId, ctx, provider, chunkSizeChars }) {
  if (!attachId || !ctx?.text) return;
  if (!provider?.baseUrl?.trim()) {
    console.warn('browsa: skipping attachment auto-summarize — no active provider configured');
    return;
  }
  try {
    const summarized = await summarizeLongText({ text: ctx.text, mode: ctx.mode, provider, chunkSizeChars });
    if (!summarized?.trim()) return; // defensive: never replace with an empty result
    const history = await storage.getHistory();
    const idx = history.findIndex((m) => m.attachId === attachId);
    if (idx === -1) return; // entry was removed/undone/truncated in the meantime — nothing to do
    const note = `[browsa: auto-condensed from ${ctx.text.length.toLocaleString()} chars — some detail may be lost]\n\n`;
    const updatedCtx = { ...ctx, text: note + summarized };
    // Preserve any figure image_url blocks (multimodal content array from
    // ATTACH_PDF_CONFIRM) through the summarize rewrite - otherwise a
    // figure-bearing PDF that also exceeds the summarize threshold would
    // silently lose its figures when the text body is condensed to a plain
    // string. Figures are kept verbatim alongside the condensed text so a
    // vision-capable provider still sees them every turn.
    const prev = history[idx];
    const prevImages = Array.isArray(prev.content) ? prev.content.filter((b) => b && b.type === 'image_url') : [];
    const rebuiltText = buildPageContextText(updatedCtx);
    const newContent = prevImages.length
      ? [{ type: 'text', text: rebuiltText }, ...prevImages]
      : rebuiltText;
    history[idx] = { ...prev, content: newContent, summarized: true };
    await storage.setHistory(history);
    console.log(`browsa[bg]: attachment auto-summarized ${ctx.text.length} -> ${summarized.length} chars`);
  } catch (e) {
    console.warn('browsa: attachment auto-summarize failed, keeping original content:', e?.message || e);
  }
}
