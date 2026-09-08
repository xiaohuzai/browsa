// test/lib-agent-turn.test.mjs — the shared fixed-agent-provider layer
// (lib/agent-turn.js): the trailing-page-context walk behind buildAgentTurn
// (text + image collection order) and the image caps (pickTurnImages /
// withTurnImages). Pure, no DOM. Both bridge and opencode consume this —
// provider-specific wire shaping is tested in their own client test files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentTurn,
  buildAgentBackfill,
  agentSwitchNeedsPrompt,
  pickTurnImages,
  withTurnImages,
  isAgentImageUrl,
  AGENT_TURN_MAX_IMAGES,
  AGENT_TURN_IMAGE_BUDGET_CHARS,
} from '../lib/agent-turn.js';
import { buildOpencodeTurn } from '../lib/opencode-client.js';

const PCP = '[Page context attached by browsa]';

const IMG = (n, len = 10) => `data:image/png;base64,${String(n).padEnd(len, '0')}`;

test('pickTurnImages — keeps https and data:image URLs, drops junk with a count', () => {
  const { images, dropped } = pickTurnImages([
    'data:image/png;base64,AA',
    'https://example.com/a.jpg',
    'data:text/html;base64,PHNjcg==', // non-image data: → drop
    'not-a-url',                       // bare garbage → drop
    '',                                // empty → drop
    null, 42,                          // non-strings → drop
  ]);
  assert.deepEqual(images, ['data:image/png;base64,AA', 'https://example.com/a.jpg']);
  assert.equal(dropped, 5);
});

test('pickTurnImages — hard cap 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => IMG(i));
  const { images, dropped } = pickTurnImages(many);
  assert.equal(images.length, AGENT_TURN_MAX_IMAGES);
  assert.equal(dropped, 12 - AGENT_TURN_MAX_IMAGES);
  assert.deepEqual(images, many.slice(0, AGENT_TURN_MAX_IMAGES));
});

test('pickTurnImages — cumulative budget: first-fit keeps later small images after a big drop', () => {
  // budgetChars is 3MiB; use tiny numbers via a scaled-down scenario instead
  // of building 3MB strings: 4 images of budget/4 each + one of budget/2.
  const q = Math.floor(AGENT_TURN_IMAGE_BUDGET_CHARS / 4);
  const h = Math.floor(AGENT_TURN_IMAGE_BUDGET_CHARS / 2);
  const big = IMG('B'.repeat(h));        // fits alone
  const big2 = IMG('C'.repeat(h));       // would exceed once one big is in
  const small1 = IMG('s1', q);           // fits in leftover after big
  const small2 = IMG('s2', q);           // total (big+s1+s2) exceeds → drop
  const { images, dropped } = pickTurnImages([big, big2, small1, small2]);
  assert.deepEqual(images, [big, small1]);
  assert.equal(dropped, 2);
});

test('pickTurnImages — single oversized image dropped outright', () => {
  const huge = IMG('X'.repeat(AGENT_TURN_IMAGE_BUDGET_CHARS + 1));
  const { images, dropped } = pickTurnImages([huge, IMG('ok')]);
  assert.deepEqual(images, [IMG('ok')]);
  assert.equal(dropped, 1);
});

test('pickTurnImages — non-array input is an empty pick', () => {
  assert.deepEqual(pickTurnImages(null), { images: [], dropped: 0 });
  assert.deepEqual(pickTurnImages(undefined), { images: [], dropped: 0 });
});

test('withTurnImages — clean pick leaves text untouched', () => {
  const r = withTurnImages('看这张图', [IMG('A')]);
  assert.equal(r.text, '看这张图');
  assert.deepEqual(r.images, [IMG('A')]);
});

test('withTurnImages — drops append a model-facing note with the count', () => {
  const r = withTurnImages('看图', ['not-a-url', IMG('A')]);
  assert.equal(r.images.length, 1);
  assert.match(r.text, /1 张图片因超出单条消息大小上限未能随附/);
  assert.ok(r.text.startsWith('看图'));
});

// ─── buildAgentTurn: shared turn shape (opencode + bridge), text + images ────

test('buildAgentTurn — text matches buildOpencodeTurn exactly', () => {
  const history = [
    { role: 'user', content: `${PCP}\nURL: https://a.com\nTitle: A\n---\n\nbody a` },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'now summarize' },
  ];
  const t = buildAgentTurn({ userText: 'now summarize' }, history);
  assert.equal(t.text, buildOpencodeTurn({ userText: 'now summarize' }, history));
});

test('buildAgentTurn — images: msg.images first, then trailing page-context run image parts in order', () => {
  const IMG_A = 'data:image/png;base64,AAAA';
  const IMG_B = 'data:image/jpeg;base64,BBBB';
  const IMG_C = 'data:image/png;base64,CCCC';
  const IMG_D = 'data:image/png;base64,DDDD';
  const history = [
    { role: 'user', content: 'plain text turn — image boundary, not page context' },
    { role: 'user', content: [
      { type: 'text', text: `${PCP}\nURL: https://a.com\n---\n\npage a` },
      { type: 'image_url', image_url: { url: IMG_C } },
    ] },
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: IMG_A } },
      { type: 'text', text: `${PCP}\nURL: https://b.com\n---\n\npage b` },
      { type: 'image_url', image_url: { url: IMG_B } },
    ] },
  ];
  const t = buildAgentTurn({ userText: '看图', images: [IMG_D] }, history);
  // IMG_D (current turn) rides FIRST so budget pressure drops stale attach
  // figures before fresh pastes; then the run's images in attach-entry order
  // (oldest attach IMG_C → newest attach IMG_A, IMG_B). The plain text turn
  // stops the walk, so no images from before it ride along.
  assert.deepEqual(t.images, [IMG_D, IMG_C, IMG_A, IMG_B]);
});

test('buildAgentTurn — no page context, no images: empty images array', () => {
  const t = buildAgentTurn({ userText: 'hi' }, [{ role: 'user', content: 'old' }]);
  assert.equal(t.text, 'hi');
  assert.deepEqual(t.images, []);
});

// ─── buildAgentTurn backfill (provider-switch continuation) ──────────────────

test('buildAgentTurn backfill — prepends transcript, excludes the trailing page-context run', () => {
  const history = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: `${PCP}\nURL: https://a.com\n---\n\nattached page body` },
  ];
  const t = buildAgentTurn({ userText: '现在继续' }, history, { backfill: true });
  // transcript covers everything BEFORE the trailing run; the run itself
  // still rides natively in the forward section (no double-send)
  assert.match(t.text, /^以下是切换对话对象之前的聊天记录，供接续上下文：\n\n用户：first question\n\n助手：first answer\n\n\[Page context attached by browsa\]/);
  assert.match(t.text, /不要重新访问或抓取该 URL。）\n\n现在继续$/);
  assert.match(t.text, /attached page body/);
  assert.ok(t.text.indexOf('attached page body') > t.text.indexOf('first answer'));
  assert.ok(!t.text.includes('用户：[Page context'), 'attach entries must not be re-rendered as transcript turns');
});

test('buildAgentTurn backfill — array-content turns render text parts and an image marker', () => {
  const history = [
    { role: 'user', content: [
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ] },
    { role: 'assistant', content: '图里是红色' },
  ];
  const t = buildAgentTurn({ userText: '继续' }, history, { backfill: true });
  assert.match(t.text, /用户：看看这张图（附图，未随记录转发）/);
  assert.match(t.text, /助手：图里是红色/);
});

test('buildAgentTurn backfill — no prior turns → no prefix; backfill off → byte-identical text', () => {
  const empty = buildAgentTurn({ userText: 'hi' }, [], { backfill: true });
  assert.equal(empty.text, 'hi');
  const history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
  const off = buildAgentTurn({ userText: 'next' }, history);
  const on = buildAgentTurn({ userText: 'next' }, history, { backfill: false });
  assert.equal(off.text, 'next');
  assert.equal(on.text, off.text);
});

// ─── agentSwitchNeedsPrompt (switch-to-agent choice card) ────────────────────

test('agentSwitchNeedsPrompt — only agent targets with a different previous reply prompt', () => {
  const last = { name: 'llm-1', model: 'glm-5.3-flash' };
  assert.equal(agentSwitchNeedsPrompt({ currentIsAgent: true, currentKey: { name: 'bridge', model: 'http://127.0.0.1:3948' }, lastKey: last }), true);
  // same agent endpoint re-selected → its own transcript already holds the thread
  assert.equal(agentSwitchNeedsPrompt({ currentIsAgent: true, currentKey: { name: 'bridge', model: 'http://127.0.0.1:3948' }, lastKey: { name: 'bridge', model: 'http://127.0.0.1:3948' } }), false);
  // same card, different endpoint (codex → claude) → prompt
  assert.equal(agentSwitchNeedsPrompt({ currentIsAgent: true, currentKey: { name: 'bridge', model: 'http://127.0.0.1:3949' }, lastKey: { name: 'bridge', model: 'http://127.0.0.1:3948' } }), true);
  // LLM target never prompts (full history resent every turn)
  assert.equal(agentSwitchNeedsPrompt({ currentIsAgent: false, currentKey: { name: 'llm-2', model: 'doubao' }, lastKey: last }), false);
  // no previous reply (fresh conversation) → nothing to carry
  assert.equal(agentSwitchNeedsPrompt({ currentIsAgent: true, currentKey: { name: 'bridge', model: 'http://127.0.0.1:3948' }, lastKey: null }), false);
});
