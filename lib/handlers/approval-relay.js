// lib/handlers/approval-relay.js — the single owner of the agent approval /
// clarification relay (2026-09-20 deepening pass, candidate #3 of the
// architecture review). The per-kind relay (bridge → respondBridgeApproval;
// opencode → respondOpencode* with the deny→reject card-choice mapping;
// everything else → the self-hosted runs server's raw approval/clarification
// endpoints) used to exist four times: background.js's APPROVAL_RESPOND /
// CLARIFY_RESPOND (tabId-keyed, main-panel cards) and subchat-handler.js's
// twins (subId-keyed, detail-thread cards) — with a real drift already
// present: the hermes clarify body normalized `msg.response` in the subchat
// copy but sent it raw in the background copy. Both callers now do exactly
// "look up the pending entry, relay, (subchat: delete the entry)".
//
// Throwing shape: bridge/opencode failures THROW (callers wrap in
// try/catch → {ok:false, error}); the runs-server paths return
// {ok: res.ok} without throwing (a non-2xx is a relay result, not an
// exception) — same contract the duplicated copies had.
import { respondBridgeApproval } from '../bridge-client.js';
import { respondOpencodePermission, respondOpencodeQuestion } from '../opencode-client.js';

// Card choices (once/always/deny) map onto opencode's reply enum
// (deny → reject) — see showApprovalCard's btnLabels.
export async function relayApproval(pending, choice) {
  if (pending.kind === 'bridge') {
    // agent-bridge daemon: relay the card choice to POST /approvals/:id
    // (the bridge maps it onto the codex decision vocabulary).
    await respondBridgeApproval({
      baseUrl: pending.baseUrl,
      apiKey: pending.apiKey,
      requestId: pending.requestId,
      choice,
    });
    return { ok: true };
  }
  if (pending.kind === 'opencode') {
    await respondOpencodePermission({
      baseUrl: pending.baseUrl,
      apiKey: pending.apiKey,
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      reply: choice === 'deny' ? 'reject' : (choice === 'always' ? 'always' : 'once'),
    });
    return { ok: true };
  }
  const res = await fetch(
    `${pending.baseUrl}/v1/runs/${encodeURIComponent(pending.runId)}/approval`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(pending.apiKey ? { Authorization: `Bearer ${pending.apiKey}` } : {}),
      },
      body: JSON.stringify({ approval_id: pending.approvalId, choice }),
    },
  );
  return { ok: res.ok };
}

// The opencode question flow expects {answers: [[label, …], …]} — browsa's
// clarify card is free-text, so the response rides as the single selected
// label (opencode's QuestionInfo has a `custom` answer path).
export async function relayClarify(pending, response) {
  if (pending.kind === 'opencode') {
    await respondOpencodeQuestion({
      baseUrl: pending.baseUrl,
      apiKey: pending.apiKey,
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      answers: [[String(response ?? '')]],
    });
    return { ok: true };
  }
  const res = await fetch(
    `${pending.baseUrl}/v1/runs/${encodeURIComponent(pending.runId)}/clarifications/${encodeURIComponent(pending.clarifyId)}/respond`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(pending.apiKey ? { Authorization: `Bearer ${pending.apiKey}` } : {}),
      },
      body: JSON.stringify({ response: String(response ?? '') }),
    },
  );
  return { ok: res.ok };
}
