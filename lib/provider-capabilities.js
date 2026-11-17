// Capabilities implemented by browsa's adapters, not claims about the remote
// model. Keep main-chat selection separate from subchat/one-shot selection:
// those paths deliberately have their own session and protocol precedence.
const AGENT_PROTOCOLS = [
  { flag: 'isHermes', kind: 'hermes', allowsAttachmentSummary: true, overflowRescuable: true },
  { flag: 'isSquilla', kind: 'squilla', allowsAttachmentSummary: false, overflowRescuable: false },
  { flag: 'isOpencode', kind: 'opencode', allowsAttachmentSummary: false, overflowRescuable: false },
  { flag: 'isBridge', kind: 'bridge', allowsAttachmentSummary: false, overflowRescuable: false },
];

/**
 * Pure, per-call description of the existing adapter contract. Summary and
 * reasoning eligibility historically inspect all flags; overflow eligibility
 * follows the selected main-chat kind. Preserve both rules for old configs
 * with overlapping flags, and leave unknown apiStyle values untouched.
 */
export function providerContractFor(provider) {
  const active = AGENT_PROTOCOLS.filter(({ flag }) => provider?.[flag]);
  const mainKind = active[0]?.kind || provider?.apiStyle || 'chat';
  const mainProtocol = AGENT_PROTOCOLS.find(({ kind }) => kind === mainKind);
  return Object.freeze({
    mainKind,
    supportsReasoningFields: active.length === 0,
    allowsAttachmentSummary: active.every(({ allowsAttachmentSummary }) => allowsAttachmentSummary),
    overflowRescuable: mainProtocol?.overflowRescuable ?? true,
    hasConversationSession: Boolean(mainProtocol),
  });
}
