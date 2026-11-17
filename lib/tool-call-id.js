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
