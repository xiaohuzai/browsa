// test/lib-message-builder-aging.test.mjs
// MUTATION FLOOR for the 2026-10-14 KV-cache ruling (supersedes the former
// ageStaleAttachments coverage): request builders must NEVER rewrite history.
// Provider prefix caches hit only on byte-identical prefixes — any mid-history
// rewrite (stubbed attach, image→label compaction, per-turn injection) busts
// the cached state for the WHOLE suffix after the changed entry, later text
// included. The two tests below pin the invariant itself:
//   1. history rides verbatim — no send-time stubbing of cold attaches;
//   2. turn N's request is a strict PREFIX of turn N+1's request — the cache
//      hit-rate guarantee, stated as bytes.
// Reintroducing ANY send-time rewrite turns these red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages, buildResponsesInput, buildAnthropicMessages, buildRunsConversationHistory, buildHermesTurn, IMAGE_SEEN_FLAG } from '../lib/message-builder.js';

const PREFIX = '[Page context attached by browsa]';

function attach(url, title, body) {
  return `${PREFIX}\nURL: ${url}\nTitle: ${title}\nMode: reader\n---\n\n${body}`;
}

const BIG = 'y'.repeat(9000);

test('history rides verbatim: an old cold attach is NOT stubbed at send time', () => {
  const history = [
    { role: 'user', content: attach('https://a.com', 'A', BIG) },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: attach('https://b.com', 'B', BIG) },
  ];
  const msgs = buildMessages({ history, userText: 'new q', systemPrompt: 'sys' });
  const wire = JSON.stringify(msgs);
  assert.ok(wire.includes(BIG), 'the cold attach full text still rides the request');
  assert.ok(!wire.includes('trimmed to keep replies fast'), 'no aging stub in the request');
});

test('CACHE INvariant: turn N request is a strict prefix of turn N+1 request (byte-identical prefix = cache hit)', () => {
  const histN = [
    { role: 'user', content: attach('https://a.com', 'A', BIG) },
    { role: 'assistant', content: 'answer v1' },
    { role: 'user', [IMAGE_SEEN_FLAG]: true, content: [
      { type: 'text', text: 'seen turn (legacy flag in storage)' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PIXEL' } },
    ] },
    { role: 'assistant', content: 'seen reply' },
  ];
  const turnN = buildMessages({ history: histN, userText: 'question N', systemPrompt: 'sys' });
  // Between turns the storage entry gains the legacy flag (post-answer stamp);
  // the built request must be byte-identical anyway (flag is stripped, pixels
  // ride verbatim).
  const histN1 = histN.map((e, i) => (i === 2 ? { ...e, [IMAGE_SEEN_FLAG]: true } : e));
  histN1.push(
    { role: 'user', content: 'question N' },
    { role: 'assistant', content: 'answer N' },
    { role: 'user', content: attach('https://b.com', 'B', 'page b body') },
  );
  const turnN1 = buildMessages({ history: histN1, userText: 'question N+1', systemPrompt: 'sys' });
  // Per-message byte equality: the provider caches token-by-token over the
  // rendered prompt, so message k of turn N+1 must serialize byte-identically
  // to message k of turn N (the array's own closing bracket is serialization,
  // not prompt).
  assert.ok(turnN1.length > turnN.length, 'turn N+1 extends turn N with new tail messages');
  for (let i = 0; i < turnN.length; i++) {
    assert.equal(
      JSON.stringify(turnN1[i]), JSON.stringify(turnN[i]),
      `message ${i} must be byte-identical across turns — any divergence is a cache bust`
    );
  }
});

// The invariant holds on EVERY LLM channel, not just chat/completions - any
// builder that reshapes history differently per turn busts that channel's
// provider cache.
test('CACHE invariant (all four LLM channels): turn N history messages are byte-identical prefixes of turn N+1', () => {
  const histN = [
    { role: 'user', content: attach('https://a.com', 'A', BIG) },
    { role: 'assistant', content: 'answer v1' },
    { role: 'user', [IMAGE_SEEN_FLAG]: true, content: [
      { type: 'text', text: 'seen turn' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PIXEL' } },
    ] },
  ];
  const histN1 = histN.map((e, i) => (i === 2 ? { ...e, [IMAGE_SEEN_FLAG]: true } : e));
  histN1.push({ role: 'user', content: 'question N' }, { role: 'assistant', content: 'answer N' });

  // Turn N's userText is exactly the string that enters histN1 as a history
  // entry (that is how the real flow persists it) — the builder's live
  // userText rides as the final message in both turns.
  const channels = [
    ['chat/completions', (h) => buildMessages({ history: h, userText: 'question N', systemPrompt: 'sys' })],
    ['responses', (h) => buildResponsesInput({ userText: 'question N' }, h)],
    ['anthropic', (h) => buildAnthropicMessages({ userText: 'question N' }, h)],
    ['hermes runs', (h) => buildHermesTurn({ userText: 'question N' }, h).conversationHistory],
    ['runs flatten', (h) => buildRunsConversationHistory(h)],
  ];
  for (const [name, build] of channels) {
    const turnN = build(histN.map((e, i) => (i === 2 ? { ...e, [IMAGE_SEEN_FLAG]: true } : e)));
    const turnN1 = build(histN1);
    assert.ok(turnN1.length > turnN.length, name + ': turn N+1 extends turn N');
    for (let i = 0; i < turnN.length; i++) {
      assert.equal(
        JSON.stringify(turnN1[i]), JSON.stringify(turnN[i]),
        name + ' message ' + i + ' diverged across turns - cache bust'
      );
    }
  }
});
