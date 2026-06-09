// test/scroll-snap.test.mjs
// Regression test for the "switch tab and come back → still scrolled to
// where I left off" bug.
//
// Before the fix, onActivated would replace messagesEl.innerHTML with
// the saved snapshot (or call renderHistory) and then just... leave the
// scroll position wherever the browser happened to leave it. The user
// would stare at the middle of an old conversation, not the latest
// reply. This is a 100% UX bug — Slack/Discord/微信 all snap to bottom
// on tab/route switch.
//
// The fix: onActivated and init() each schedule a rAF that calls
// scrollToBottom(). We can't easily unit-test the actual scroll behavior
// (jsdom doesn't simulate layout), so we test the source contract:
// the two entry points MUST call scrollToBottom (or schedule it via
// requestAnimationFrame) at the right times.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('sidepanel.js init() schedules scrollToBottom after renderHistory + resume', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');

  // Find the init() function body
  const initMatch = src.match(/async function init\(\)\s*\{/);
  assert.ok(initMatch, 'init() must exist');
  const initStart = initMatch.index + initMatch[0].length;
  const rest = src.slice(initStart);
  let depth = 1, end = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const initBody = rest.slice(0, end);

  // The init body must schedule a rAF scrollToBottom at the end. The
  // implementation is requestAnimationFrame(() => scrollToBottom()),
  // so the regex must tolerate the arrow function's parens.
  assert.match(initBody, /requestAnimationFrame\([^]*?scrollToBottom/,
    'init() must schedule a rAF scrollToBottom after resumeInFlightStream — first layout may not be done when renderHistory runs');
});

test('sidepanel.js onActivated handler calls scrollToBottom after restore', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');

  // Find the onActivated listener body
  const m = src.match(/chrome\.tabs\.onActivated\.addListener\(async \(\{ tabId \}\) =>\s*\{/);
  assert.ok(m, 'onActivated handler must exist');
  const start = m.index + m[0].length;
  const rest = src.slice(start);
  // Walk braces to find the close
  let depth = 1;
  let end = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = rest.slice(0, end);

  // Two scrollToBottom calls expected: one right after the innerHTML /
  // renderHistory restore, one after resumeInFlightStream (so we
  // snap to the bottom of the resumed bubble, not a position from
  // before its height was added). Strip line comments first so we
  // don't count "scrollToBottom" mentioned in explanatory text.
  const bodyNoComments = body.replace(/\/\/.*$/gm, '');
  const matches = bodyNoComments.match(/scrollToBottom/g) || [];
  assert.ok(matches.length >= 2,
    `onActivated must call scrollToBottom at least twice (post-restore + post-resume); found ${matches.length}`);
  // Both must be wrapped in rAF (the previous-tab leftover scrollTop
  // can be re-applied by Chrome between the innerHTML swap and our
  // explicit scroll assignment; rAF ensures we run after Chrome's
  // own scroll-restoration heuristics).
  const rafMatches = bodyNoComments.match(/requestAnimationFrame\([^]*?scrollToBottom/g) || [];
  assert.equal(rafMatches.length, matches.length,
    'every scrollToBottom in onActivated must be scheduled via requestAnimationFrame');
});

test('sidepanel.js onActivated preserves tab url/title in pagemeta (regression check)', async () => {
  // I accidentally introduced a bug while editing the onActivated
  // handler — changed `t.title || t.url` to `t.title || tab.url` and
  // `tab` was undefined in scope. Lock the original behavior.
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  const m = src.match(/chrome\.tabs\.onActivated\.addListener\(async \(\{ tabId \}\) =>\s*\{/);
  assert.ok(m);
  const start = m.index + m[0].length;
  const rest = src.slice(start);
  let depth = 1, end = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = rest.slice(0, end);
  assert.ok(/pagemetaEl\.textContent\s*=\s*t\.title/.test(body),
    'pagemeta must read t.title (not the unbound `tab`)');
  assert.ok(!/\btab\.url\b/.test(body),
    'onActivated must not reference `tab.url` — `tab` is not in scope, only `t` from chrome.tabs.get()');
});

test('scrollToBottom sets scrollTop to scrollHeight (correct implementation)', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  const m = src.match(/function scrollToBottom\(\)\s*\{([^}]*)\}/);
  assert.ok(m, 'scrollToBottom() must exist');
  const body = m[1];
  // The body should be exactly: messagesEl.scrollTop = messagesEl.scrollHeight
  // (not clientHeight, not offsetHeight, and not the broken sequence
  // `messagesEl.scrollHeight = messagesEl.scrollTop` — flipped assignment
  // would scroll to 0.)
  assert.match(body, /messagesEl\.scrollTop\s*=\s*messagesEl\.scrollHeight/,
    'scrollToBottom must set messagesEl.scrollTop = messagesEl.scrollHeight (not clientHeight, not offsetHeight)');
  assert.doesNotMatch(body, /scrollHeight\s*=\s*scrollTop/,
    'scrollToBottom must NOT flip the assignment (would scroll to 0)');
});

test('tabStates is NOT expected to save scrollTop (documented design choice)', async () => {
  // The design is: on tab switch back, we always snap to bottom.
  // Saving/restoring scrollTop would require (a) extra fields in
  // tabStates, (b) dealing with the case where saved scrollTop
  // exceeds the new scrollHeight (Chrome clamps, user sees
  // middle-of-empty), (c) tests for the save/restore contract. The
  // cost/benefit is bad — users almost always want the latest
  // message when coming back to a tab. We assert the design choice
  // by checking that no `scrollTop` write happens in the onActivated
  // listener body.
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  const m = src.match(/chrome\.tabs\.onActivated\.addListener\(async \(\{ tabId \}\) =>\s*\{/);
  assert.ok(m);
  const start = m.index + m[0].length;
  const rest = src.slice(start);
  let depth = 1, end = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = rest.slice(0, end);
  // No direct `messagesEl.scrollTop = ...` (only via scrollToBottom)
  assert.ok(!/messagesEl\.scrollTop\s*=/.test(body),
    'onActivated must not write messagesEl.scrollTop directly; use scrollToBottom() so the design is centralized');
  // tabStates should not save scrollTop
  assert.ok(!/tabStates\.set\([^)]*scrollTop/.test(src),
    'tabStates should not save scrollTop — see design note in onActivated comments');
});
