// lib/sidepanel/tool-tier.js — classify an agent tool-progress line into a
// display tier + icon. Single home for the regex table (2026-09-20
// deepening pass, architecture-review candidate #5): the table used to live
// as two verbatim copies (sidepanel.js's showToolProgress and
// detail-thread.js's card-local copy) kept "in lockstep" by comment only —
// the module-split no-cycle rule was the reason, but a leaf module with no
// imports beyond icons.js satisfies it without the duplication.
import { ICONS } from './icons.js';

export function classifyToolTier(text) {
  const t = String(text).toLowerCase();
  if (/think|reason|analyz|consid/.test(t))           return { tier: 'thinking',  icon: ICONS.think };
  if (/search|fetch|web|http|url/.test(t))            return { tier: 'searching', icon: ICONS.search };
  if (/read|open|load|file|path/.test(t))             return { tier: 'reading',   icon: ICONS.book };
  if (/write|edit|creat|sav|updat/.test(t))           return { tier: 'writing',   icon: ICONS.edit };
  if (/run|exec|bash|shell|cmd|command/.test(t))      return { tier: 'running',   icon: ICONS.terminal };
  return { tier: '', icon: ICONS.gear };
}
