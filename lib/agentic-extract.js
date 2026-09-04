// lib/agentic-extract.js — deep extraction: when the heuristic pass reports
// content it could not reach (URL pagination, same-DOM load-more, collapsed
// expanders left over after preExtractCleanup), escalate to a bounded loop
// that finishes the job. Two mechanisms, one entry point:
//
//   1. URL pagination  — deterministic: walk `next` links in a BACKGROUND tab
//      (chrome.tabs.create({active:false})), extract each page, close it. The
//      user's own tab never navigates away.
//   2. In-tab interaction — LLM-in-the-loop (page-agent's text-DOM recipe):
//      number the non-navigating controls, ask the ACTIVE PROVIDER for one
//      JSON action {click:{index}} | {done}, click with a danger-word veto,
//      settle on a DOM sentinel (crawl4ai's content-freshness check), feed
//      the observation back. Works with every provider style browsa speaks —
//      the brain is a plain one-shot completion, no agent/tool protocol.
//
// Hard guarantees: MAX_STEPS clicks, MAX_PAGES pages, TOTAL_BUDGET_MS wall
// clock, abortable, and every failure path returns null so the caller keeps
// the baseline heuristic result (deep extraction is an enhancement, never a
// dependency).

import * as storage from './storage.js';
import {
  chatStream, responsesStream, anthropicStream, runsApiStream
} from './llm-client.js';
import { resolveProvider, resolveChatModel } from './handlers/provider-resolver.js';
import { chatControllers, STREAM_KEEPALIVE_ALARM } from './state.js';
import { t, tSub } from './i18n.js';
import {
  preExtractCleanup,
  extractInPageWorld,
  extractDomTreeInPageWorld,
  extractFullInPageWorld,
  detectIncompleteness,
  interactiveSnapshot,
  clickIndexed
} from './page-extractor.js';

const MAX_STEPS = 8;          // brain-driven clicks per attach, hard cap
const MAX_PAGES = 4;          // total pages walked (page 1 = the user's tab)
const TOTAL_BUDGET_MS = 75_000;
const BRAIN_TIMEOUT_MS = 20_000;
const BRAIN_MAX_TOKENS = 300; // the reply is one tiny JSON object
const SNAPSHOT_MAX_CHARS = 5000;
const MIN_GAIN_CHARS = 200;   // re-extracted text must beat baseline by this to be adopted
const SETTLE_MS = 2000;

const SYSTEM_PROMPT = [
  'You extend a reader tool that captured the page the user is viewing: some content is still hidden behind interactive controls.',
  'You get a numbered list of clickable controls. Reply with exactly ONE JSON object and nothing else:',
  '{"click":{"index":N}} to click control N, or {"done":{}} when the page looks complete or nothing is worth clicking.',
  'Only click controls that plausibly reveal more of the page\'s MAIN content: expanders, "show more", "load comments", content tabs within the article.',
  'Never choose anything that navigates, submits, purchases, deletes, or sends messages.',
  'Never assume a click worked — judge only from the observation you receive afterwards. Never click the same index twice. After two clicks that changed nothing, choose done.'
].join('\n');

/**
 * Entry point, called from background.js's ATTACH_PAGE after the generic
 * extraction cascade. Returns an upgraded { text, clicks, pages } or null
 * when there is nothing to do (no signals, setting off, no provider, any
 * failure — the caller then keeps the baseline result untouched).
 */
export async function maybeDeepExtract({ tabId, ctx, textCap, query, redoMode, sendProgress } = {}) {
  const signals = ctx?.deepExtractSignals;
  if (!signals) return null;
  if (!signals.nextPageHref && !signals.loadMore && !(signals.expandersLeft > 0)) return null;

  const all = await storage.getAll().catch(() => null);
  if (!all || all.deepExtractEnabled === false) return null;
  let provider;
  try {
    provider = resolveProvider(all);
  } catch (_) {
    return null; // nothing configured → zero escalation, zero errors surfaced
  }
  const model = resolveChatModel(provider, all);

  const controller = new AbortController();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const timeLeft = () => deadline - Date.now();
  const progress = (text) => { try { sendProgress?.(text); } catch (_) {} };
  const ask = (snapText, history) => askBrain({
    provider, model, userText: snapText + (history.length ? `\n\nActions so far:\n${history.join('\n')}` : '')
  });

  // Reuse the chat-stream keepalive/abort plumbing: register our controller
  // unless a chat stream already owns this tab, and keep the SW alive with
  // the same periodic alarm. Restoring prior state is exact — we only ever
  // remove our own registration.
  const owned = !chatControllers.has(tabId);
  if (owned) chatControllers.set(tabId, controller);
  try { chrome.alarms.create(STREAM_KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (_) {}

  try {
    progress(t('deepExtractStart', '内容似乎没读全，正在自动展开与翻页…'));

    const clicks = await driveInTabInteractions({ tabId, ask, timeLeft, signal: controller.signal, progress });

    // Re-extract the now fully-expanded page with the SAME extractor kind the
    // baseline used (reader quality stays reader quality), and adopt it only
    // when it meaningfully beat the baseline — otherwise keep the baseline.
    let finalText = ctx.text || '';
    if (clicks > 0) {
      const redo = await inject(tabId, extractorFor(redoMode), { htmlCap: textCap, query }).catch(() => null);
      const redoText = (redo?.text || '').trim();
      if (redoText.length > finalText.length + MIN_GAIN_CHARS) finalText = redoText;
    }

    // URL pagination walks in a background tab — deterministic, no brain.
    const pages = await walkNextPages({
      startHref: signals.nextPageHref, timeLeft, signal: controller.signal,
      progress, textCap, query, knownUrl: ctx.meta?.url || ''
    });

    const assembled = assembleDeepText({ baselineText: ctx.text || '', finalText, pages });
    if (assembled === ctx.text) return null; // nothing gained → keep everything as it was
    return { text: assembled, clicks, pages: pages.length };
  } catch (_) {
    return null; // fail-open: baseline result wins on any unexpected error
  } finally {
    if (owned && chatControllers.get(tabId) === controller) chatControllers.delete(tabId);
    if (chatControllers.size === 0) { try { chrome.alarms.clear(STREAM_KEEPALIVE_ALARM); } catch (_) {} }
  }
}

/**
 * Pure merge of the deep-extract outputs: prefer the re-extracted page text
 * when it meaningfully beat the baseline, then append walked pages with
 * [Page N] markers (same convention as the PDF pipeline), skipping a page
 * whose opening mostly repeats content we already have. Exported for tests.
 */
export function assembleDeepText({ baselineText, finalText, pages }) {
  let out = (finalText && finalText.length > baselineText.length + MIN_GAIN_CHARS)
    ? finalText
    : baselineText;
  const seen = out.replace(/\s+/g, ' ');
  let pageNo = 1;
  for (const p of pages || []) {
    const head = String(p || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (head && seen.includes(head)) continue; // pagination that repeats the prior page
    pageNo += 1;
    out += `\n\n[Page ${pageNo}]\n\n${p}`;
  }
  return out;
}

/**
 * Parse one brain reply into an action. Deliberately strict: anything that
 * is not a well-formed {"click":{"index":N}} parses as done — a garbage
 * reply ends the loop instead of clicking something unvetted. Exported for
 * tests.
 */
export function parseAction(raw) {
  if (!raw) return { done: true };
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return { done: true };
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return { done: true };
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return { done: true };
    if (obj.done != null) return { done: true };
    const idx = obj.click?.index;
    if (Number.isInteger(idx) && idx >= 0 && idx < 10000) return { click: idx };
    return { done: true };
  } catch (_) {
    return { done: true };
  }
}

/** Brain-driven click loop over the user's tab. Returns the click count. */
async function driveInTabInteractions({ tabId, ask, timeLeft, signal, progress }) {
  const history = [];
  let clicks = 0, stale = 0, lastIdx = -1;
  for (let step = 1; step <= MAX_STEPS && timeLeft() > 3000 && !signal.aborted; step++) {
    const snap = await inject(tabId, interactiveSnapshot, { maxChars: SNAPSHOT_MAX_CHARS }).catch(() => null);
    if (!snap || !snap.count) break;
    let raw;
    try {
      raw = await ask(snap.text, history);
    } catch (_) {
      break; // provider hiccup → stop escalating, baseline still wins
    }
    const act = parseAction(raw);
    if (act.done) break;
    if (act.click === lastIdx) break; // prompt rule, enforced mechanically

    const label = (snap.items && snap.items[act.click]) || `#${act.click}`;
    const r = await inject(tabId, clickIndexed, { index: act.click, settleMs: SETTLE_MS }).catch(() => null) || {};
    history.push(`step ${step}: clicked ${label} → ${r.vetoed ? 'REFUSED (unsafe)' : r.clicked ? (r.changed ? `+${r.deltaChars} chars appeared` : 'no change') : 'control gone'}`);
    progress(tSub('deepExtractStep', '自动展开内容中（$1/$2）…', step, MAX_STEPS));

    if (r.vetoed || !r.clicked) break; // refused or vanished → stop pointing blindly
    clicks++;
    if (!r.changed) {
      if (++stale >= 2) break; // crawl4ai zero-delta rule
    } else {
      stale = 0;
    }
    lastIdx = act.click;
  }
  return clicks;
}

/**
 * Walk `next`-link pagination in a BACKGROUND tab: open page 2, wait for
 * load, run cleanup + a cheap full-text extraction, find that page's own
 * next link, repeat. The user's tab is never touched; the walker tab is
 * closed on every exit path.
 */
async function walkNextPages({ startHref, timeLeft, signal, progress, textCap, query, knownUrl }) {
  const pages = [];
  let href = startHref;
  const seen = new Set(knownUrl ? [knownUrl] : []);
  while (href && pages.length < MAX_PAGES - 1 && timeLeft() > 4000 && !signal.aborted) {
    if (seen.has(href)) break;
    seen.add(href);
    progress(tSub('deepExtractPage', '正在读取第 $1 页…', pages.length + 2));
    const tab = await chrome.tabs.create({ url: href, active: false }).catch(() => null);
    if (!tab) break;
    try {
      if (!(await waitTabComplete(tab.id, 15_000, signal))) break;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: preExtractCleanup, world: 'MAIN' });
      } catch (_) { /* best-effort */ }
      const page = await inject(tab.id, extractFullInPageWorld, { htmlCap: textCap, query }).catch(() => null);
      const text = (page?.text || '').trim();
      if (text.length < 50) break;
      pages.push(text);
      const d = await inject(tab.id, detectIncompleteness, {}).catch(() => null);
      href = d?.nextPageHref || null;
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  return pages;
}

// ── plumbing ────────────────────────────────────────────────────────────────

/** executeScript one self-contained page-world function with an args object. */
async function inject(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, func, args: [args], world: 'MAIN'
  });
  return res?.result || null;
}

function extractorFor(mode) {
  if (mode === 'dom') return extractDomTreeInPageWorld;
  if (mode === 'full') return extractFullInPageWorld;
  return extractInPageWorld; // reader / auto(reader) / unknown → reader kind
}

/** Resolve+dispatch the one-shot brain completion across all provider styles. */
async function askBrain({ provider, model, userText }) {
  const signal = AbortSignal.timeout(BRAIN_TIMEOUT_MS);
  const common = { temperature: 0, maxTokens: BRAIN_MAX_TOKENS, onDelta: () => {}, signal };
  if (provider.type === 'agent') {
    const r = await runsApiStream({
      baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      input: userText, instructions: SYSTEM_PROMPT, ...common
    });
    return r?.full || '';
  }
  if (provider.apiStyle === 'anthropic') {
    const r = await anthropicStream({
      baseUrl: provider.baseUrl, apiKey: provider.apiKey, model,
      system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userText }], ...common
    });
    return r?.full || '';
  }
  if (provider.apiStyle === 'responses') {
    const r = await responsesStream({
      baseUrl: provider.baseUrl, apiKey: provider.apiKey, model,
      input: userText, instructions: SYSTEM_PROMPT, ...common
    });
    return r?.full || '';
  }
  const r = await chatStream({
    baseUrl: provider.baseUrl, apiKey: provider.apiKey, model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText }
    ], ...common
  });
  return r?.full || '';
}

/** Wait for a tab's load to complete (or timeout / abort). */
function waitTabComplete(tabId, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done = false;
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    const finish = (v) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      try { signal?.removeEventListener('abort', onAbort); } catch (_) {}
      clearTimeout(timer);
      resolve(v);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // Tabs sometimes complete before we start listening.
    chrome.tabs.get(tabId).then((t) => {
      if (t?.status === 'complete') finish(true);
    }).catch(() => finish(false));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
