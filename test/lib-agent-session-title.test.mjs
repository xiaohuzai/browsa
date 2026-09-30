// test/lib-agent-session-title.test.mjs — 跨入口接力的命名层（2026-10-01）：
// deriveSessionTitle 的形状矩阵 + titleAgentSessionOnce 的盖戳语义
// （成功盖戳 / 4xx 终态盖戳 / 网络失败留待重试 / 已盖戳跳过 / 空文本不命名）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { deriveSessionTitle, titleAgentSessionOnce } = await import('../lib/handlers/agent-session-title.js');

test('deriveSessionTitle: first line, whitespace collapsed, browsa： prefix', () => {
  assert.equal(deriveSessionTitle('总结一下这期 YC 视频'), 'browsa：总结一下这期 YC 视频');
  assert.equal(deriveSessionTitle('第一行标题\n\n第二行不算'), 'browsa：第一行标题');
  assert.equal(deriveSessionTitle('  多   个  空格 \t 制表 '), 'browsa：多 个 空格 制表');
});

test('deriveSessionTitle: long input truncates with ellipsis at the cap', () => {
  const t = deriveSessionTitle('一'.repeat(80));
  assert.equal(t.length, 'browsa：'.length + 48 + 1); // 48 chars + …
  assert.ok(t.endsWith('…'));
  const en = deriveSessionTitle('x'.repeat(80));
  assert.ok(en.startsWith('browsa：x'));
});

test('deriveSessionTitle: empty / image-only turns yield null (a later text turn names the session)', () => {
  assert.equal(deriveSessionTitle(''), null);
  assert.equal(deriveSessionTitle('   \n\n  '), null);
  assert.equal(deriveSessionTitle(null), null);
});

test('titleAgentSessionOnce: already-stamped session is skipped without a PATCH', async () => {
  let patchCalls = 0;
  const r = await titleAgentSessionOnce({
    provider: 'hermes1', sessionId: 's-A', userText: '你好',
    patch: async () => { patchCalls++; return { ok: true, status: 200 }; },
    stampGet: async () => 's-A',
    stampSet: async () => {},
  });
  assert.equal(r, false);
  assert.equal(patchCalls, 0);
});

test('titleAgentSessionOnce: success derives the title from the turn text and stamps', async () => {
  const seen = [];
  let stamped = null;
  const r = await titleAgentSessionOnce({
    provider: 'hermes1', sessionId: 's-B', userText: '帮我读这篇论文',
    patch: async (p) => { seen.push(p); return { ok: true, status: 200 }; },
    stampGet: async () => null,
    stampSet: async (_p, id) => { stamped = id; },
  });
  assert.equal(r, true);
  assert.deepEqual(seen, [{ sessionId: 's-B', title: 'browsa：帮我读这篇论文' }]);
  assert.equal(stamped, 's-B');
});

test('titleAgentSessionOnce: a 4xx refusal (title conflict / unknown id) is PERMANENT — stamps to stop retry loops', async () => {
  let stamped = null;
  const r = await titleAgentSessionOnce({
    provider: 'hermes1', sessionId: 's-C', userText: '你好',
    patch: async () => ({ ok: false, status: 400 }),
    stampGet: async () => null,
    stampSet: async (_p, id) => { stamped = id; },
  });
  assert.equal(r, false);
  assert.equal(stamped, 's-C');
});

test('titleAgentSessionOnce: a transport failure (status 0 / throw) stays UNSTAMPED for the next turn', async () => {
  let stamped = null;
  for (const patch of [async () => ({ ok: false, status: 0 }), async () => { throw new Error('boom'); }]) {
    // stamped stays null after each variant
    await titleAgentSessionOnce({
      provider: 'hermes1', sessionId: 's-D', userText: '你好',
      patch,
      stampGet: async () => stamped,
      stampSet: async (_p, id) => { stamped = id; },
    });
    assert.equal(stamped, null);
  }
});

test('titleAgentSessionOnce: no sessionId or empty derived title → no PATCH, no stamp', async () => {
  let patchCalls = 0;
  const patch = async () => { patchCalls++; return { ok: true, status: 200 }; };
  assert.equal(await titleAgentSessionOnce({ provider: 'p', sessionId: '', userText: 'hi', patch, stampGet: async () => null, stampSet: async () => {} }), false);
  assert.equal(await titleAgentSessionOnce({ provider: 'p', sessionId: 's', userText: '   ', patch, stampGet: async () => null, stampSet: async () => {} }), false);
  assert.equal(patchCalls, 0);
});
