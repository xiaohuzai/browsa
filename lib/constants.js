// lib/constants.js — shared constants used across background, sidepanel, storage, and page-extractor.

/** Prefix that identifies page-context messages stored in history.
 *  These are sent to the LLM for context but hidden from the chat UI. */
export const PAGE_CONTEXT_PREFIX = '[Page context attached by browsa]';

/** Appended to a video transcript's context text so the model organizes
 *  summaries into sections whose headings end with the section's start
 *  [mm:ss] — those become clickable seek links in the rendered reply.
 *  Deliberately NOT in the per-turn system prompt: a conditional dynamic
 *  prefix there would split the KV/prompt cache key between "video session"
 *  and "normal session" (same anti-pattern as llms.txt). Rides in the
 *  trajectory like the transcript itself. */
export const VIDEO_NOTE_HINT = 'The attached context includes a video transcript with [mm:ss] timestamps. When summarizing it as notes, organize the content into sections and append each section\'s start time at the end of its heading, formatted as [mm:ss] (use [h:mm:ss] for videos longer than an hour). Keep timestamps in this exact bracket form so they can be linked.';
