// test/lib-message-fold-css.test.mjs — static CSS contracts for the message
// fold (collapse/expand) feature. jsdom has no flex layout, so the bug this
// guards against (a collapsed bubble squashed to ~8px by flexbox on long
// histories) can only be pinned structurally: the rules that keep a collapsed
// bubble a visible, re-expandable 150px window must exist in sidepanel.css.
//
// The squashed-bubble incident (2026-09-14 user report): .messages is a
// fixed-height flex column; .msg.assistant.collapsed sets overflow-y:hidden,
// which drops the item's automatic min-height floor — with the default
// flex-shrink:1 the collapsed bubble then absorbed the container's ENTIRE
// shrink deficit once the history exceeded the viewport, rendering as an
// ~8px sliver with the hover-only .msg-actions (fold button) clipped away:
// the message became invisible and could never be expanded again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const css = (await readFile(new URL('../sidepanel.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');

test('fold CSS: .msg is flex-shrink:0 — a collapsed (overflow-y:hidden) bubble must never absorb flex shrink deficit', () => {
  // The base .msg rule (the one with max-width:90%) must carry flex-shrink:0.
  const base = css.match(/\.msg \{[^}]*\}/);
  assert.ok(base, '.msg base rule not found');
  assert.match(base[0], /flex-shrink:\s*0/, '.msg must set flex-shrink:0 — without it a collapsed bubble (overflow-y:hidden loses the min-height:auto floor) is squashed to ~8px on long histories');
});

test('fold CSS: collapsed state keeps a bounded visible window (max-height + overflow-y:hidden only)', () => {
  const rule = css.match(/\.msg\.assistant\.collapsed \{[^}]*\}/);
  assert.ok(rule, '.msg.assistant.collapsed rule not found');
  assert.match(rule[0], /max-height:\s*\d+px/, 'collapsed bubble must cap its height');
  // overflow-x must NOT be set (the shorthand overflow:hidden changed the
  // bubble's width per collapse-toggle — the reason this rule exists at all).
  assert.match(rule[0], /overflow-y:\s*hidden/, 'collapsed bubble must clip vertically');
  assert.doesNotMatch(rule[0], /overflow\s*:/, 'the overflow shorthand must not be used (it also sets overflow-x and perturbs width)');
});

test('fold CSS: the fold button lives in the hover-revealed .msg-actions bar pinned inside the bubble top', () => {
  // The expand control must stay INSIDE the collapsed window: .msg-actions is
  // position:absolute with a small top — if it ever moved to the bottom of a
  // tall bubble, a collapsed (clipped) bubble would hide its only expand
  // affordance again.
  const rule = css.match(/\.msg-actions \{[^}]*\}/);
  assert.ok(rule, '.msg-actions rule not found');
  assert.match(rule[0], /position:\s*absolute/);
  const top = rule[0].match(/top:\s*(\d+)px/);
  assert.ok(top && Number(top[1]) <= 8, `.msg-actions must be pinned near the bubble top (got top:${top?.[1]}px) so the fold button remains inside the 150px collapsed window`);
});
