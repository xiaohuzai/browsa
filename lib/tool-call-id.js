// Native tool identities are opaque: validate presence, then preserve every
// byte. Trimming or clipping an ID can merge two unrelated invocations.
export function readToolCallId(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
