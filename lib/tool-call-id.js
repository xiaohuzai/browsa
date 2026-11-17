// Native tool identities are opaque: validate presence, then preserve every
// byte. Trimming or clipping an ID can merge two unrelated invocations.
export function readToolCallId(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * IDs and request scopes are needed only while matching live events. A dead
 * SW cannot resume that stream, and history/backfill consumes the visible
 * step fields instead. Excluding opaque IDs bounds persistence without ever
 * truncating identities or mutating the active turn's steps.
 */
export function stepsWithoutLiveToolIdentity(steps) {
  return steps.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const { toolCallId, toolCallScope, toolTargetIsId, ...stored } = step;
    return stored;
  });
}

export function isRecoverableToolStep(step) {
  return step?.k === 'tool' && typeof step.name === 'string' && !!step.name.trim();
}

// The new steps-only record keeps all recovery metadata inside the already
// stripped ledger. The explicit kind prevents ordinary tool steps from being
// mistaken for a recovered turn. Old entries remain readable without rewrite.
export function recoveredStepMetadata(entry) {
  if (entry?.role !== 'assistant' || entry.content !== '' || !Array.isArray(entry.steps)) return null;
  const step = entry.steps.find(isRecoverableToolStep);
  if (!step) return null;
  const meta = step.recovery;
  if (meta?.kind === 'browsa.interrupted-step-only' && meta.interrupted === true && typeof meta.id === 'string' && meta.id) return meta;
  if (entry.interrupted !== true) return null;
  return { id: step.recoveryId, interrupted: true, providerLabel: entry.providerLabel, providerKey: entry.providerKey };
}

export function recoveryIdOf(entry) {
  return recoveredStepMetadata(entry)?.id || null;
}

export function stepsWithRecoveryId(steps, recoveryId, { providerLabel, providerKey } = {}) {
  const first = steps.findIndex(isRecoverableToolStep);
  return steps.map((step, i) => i === first ? { ...step, recovery: {
    kind: 'browsa.interrupted-step-only', id: recoveryId, interrupted: true, providerLabel, providerKey,
  } } : step);
}
