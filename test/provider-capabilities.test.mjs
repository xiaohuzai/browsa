import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerContractFor } from '../lib/provider-capabilities.js';

test('provider contract: existing adapters declare only their implemented behavior', () => {
  const cases = [
    [{}, 'chat', true, true, true, false],
    [{ apiStyle: 'responses' }, 'responses', true, true, true, false],
    [{ apiStyle: 'anthropic' }, 'anthropic', true, true, true, false],
    [{ isHermes: true }, 'hermes', false, true, true, true],
    [{ isOpencode: true }, 'opencode', false, false, false, true],
    [{ isBridge: true }, 'bridge', false, false, false, true],
    [{ isSquilla: true }, 'squilla', false, false, false, true],
    [{ type: 'agent', apiStyle: 'custom' }, 'custom', true, true, true, false],
  ];
  for (const [provider, mainKind, supportsReasoningFields, allowsAttachmentSummary, overflowRescuable, hasConversationSession] of cases) {
    assert.deepEqual(providerContractFor(Object.freeze(provider)), {
      mainKind, supportsReasoningFields, allowsAttachmentSummary, overflowRescuable, hasConversationSession,
    });
  }
});

test('provider contract: legacy mixed flags retain each operation\'s existing precedence', () => {
  const flags = ['isHermes', 'isSquilla', 'isOpencode', 'isBridge'];
  const kinds = ['chat', 'hermes', 'squilla', 'hermes', 'opencode', 'hermes', 'squilla', 'hermes',
    'bridge', 'hermes', 'squilla', 'hermes', 'opencode', 'hermes', 'squilla', 'hermes'];
  const summaries = [true, true, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false];
  const rescues = [true, true, false, true, false, true, false, true,
    false, true, false, true, false, true, false, true];
  for (let mask = 0; mask < 16; mask++) {
    const provider = Object.freeze(Object.fromEntries(flags.map((flag, i) => [flag, Boolean(mask & (1 << i))])));
    assert.deepEqual(providerContractFor(provider), {
      mainKind: kinds[mask],
      supportsReasoningFields: mask === 0,
      allowsAttachmentSummary: summaries[mask],
      overflowRescuable: rescues[mask],
      hasConversationSession: mask !== 0,
    }, `flag mask ${mask}`);
  }
});

test('provider contract: empty, unknown and legacy apiStyle values are not silently rewritten', () => {
  assert.equal(providerContractFor(null).mainKind, 'chat');
  assert.equal(providerContractFor(undefined).supportsReasoningFields, true);
  assert.equal(providerContractFor({ apiStyle: '' }).mainKind, 'chat');
  const caps = providerContractFor({ apiStyle: 'bridge' });
  assert.equal(caps.mainKind, 'bridge');
  assert.equal(caps.supportsReasoningFields, true, 'reasoning follows flags, not an inferred agent type');
  assert.equal(caps.allowsAttachmentSummary, true, 'summary follows flags as before');
  assert.equal(caps.overflowRescuable, false, 'overflow follows the selected main kind as before');
  assert.equal(caps.hasConversationSession, true);
});

test('provider contract: a caller cannot change later decisions through a returned record', () => {
  const first = providerContractFor({ isHermes: true });
  try { first.allowsAttachmentSummary = false; } catch {}
  assert.equal(providerContractFor({ isHermes: true }).allowsAttachmentSummary, true);
});
