// lib/constants.js — shared constants used across background, sidepanel, storage, and page-extractor.

/** Prefix that identifies page-context messages stored in history.
 *  These are sent to the LLM for context but hidden from the chat UI. */
export const PAGE_CONTEXT_PREFIX = '[Page context attached by browsa]';
