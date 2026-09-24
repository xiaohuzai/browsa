// lib/handlers/turn-request.js — the conversation-form "turn request" object:
// one interface over "which wire shape does THIS provider kind need for this
// turn" (2026-09-20 deepening pass, architecture-review candidate #1).
//
// Before this module, chat-handler.js spelled the per-provider-kind ladder
// out FOUR times inside handleChat: the initial build, the context-overflow
// rescue rebuild, the output-cap continuation rebuild, and the video-notes
// timestamp-rewrite rebuild (plus a fifth single ladder in subchat-handler,
// which stays separate on purpose — see the note at the bottom). Only the
// chat branch was rebuilt in two of those passes once, which silently
// resent the ORIGINAL request on responses/anthropic continuations
// (regenerating the same reply instead of continuing it). The ladder now
// exists exactly once, here.
//
// The object deliberately does NOT own the stream dispatch (doStream keeps
// that — it is written once and is not the duplication) and does NOT own
// the WHEN-to-rebuild decisions (overflow gate, truncation detection,
// timestamp gate — orchestrator logic with their own lockstep-tested
// literals). It owns only the HOW: what payload each kind needs, and how
// that payload is rebuilt when the conversation changes under it.
//
// Session-identity rules ride here too (they used to be per-branch
// comments): Hermes sessions come from storage (main chat), opencode
// sessions are lazily created server-side, bridge sessions are keyed per
// endpoint. SUBCHAT must NOT use this module's storage-backed Hermes
// session — it keeps its dedicated per-subId map (test-pinned in
// test/subchat.test.mjs), which is why subchat-handler keeps its own
// single ladder.
import * as storage from '../storage.js';
import { buildMessages, buildHermesTurn, buildRunsConversationHistory, buildResponsesInput, buildAnthropicMessages, buildSquillaTurn } from '../message-builder.js';
import { buildAgentTurn, withTurnImages, withAgentRenderHints } from '../agent-turn.js';
import { createOpencodeSession } from '../opencode-client.js';
import { createSquillaSession, uploadSquillaFile } from '../squilla-client.js';
import { langInstruction } from '../prompt-assembly.js';
import { resolveBridgeEndpoint } from './provider-resolver.js';

/**
 * @param {object} args
 * @param {object} args.provider      resolved provider entry
 * @param {string} args.activeProvider
 * @param {object} args.all           settings bag (bridge endpoints live here)
 * @param {object} args.msg           the chat message ({userText, images, backfill…})
 * @param {Array}  args.sendHistory   context-aged history for this turn
 * @param {string} args.effectiveSystemPrompt
 */
export function createTurnRequest({ provider, activeProvider, all, msg, sendHistory, effectiveSystemPrompt }) {
  const kind = provider.isHermes ? 'hermes'
    : provider.isSquilla ? 'squilla'
    : provider.isOpencode ? 'opencode'
    : provider.isBridge ? 'bridge'
    : (provider.apiStyle || 'chat');

  const t = {
    kind,
    // opencode/bridge/squilla keep their transcripts server-side, so stubbing
    // the resent prompt cannot shrink what the agent already stored — the
    // overflow self-rescue must not fire for them.
    overflowRescuable: kind !== 'opencode' && kind !== 'bridge' && kind !== 'squilla',

    // Wire payloads (exactly one family is non-null after prepare()):
    messages: null,           // chatStream (stateless OpenAI-compatible)
    runsInput: null,          // runsApiStream: current user message
    runsConvHistory: null,    // runsApiStream: all prior turns
    hermesSessionId: null,    // runsApiStream: X-Hermes-Session-Id / session_id
    opencodeSessionId: null,  // opencodeStream: server-assigned `ses_…` id
    opencodeTurn: '',         // opencodeStream: single prompt string
    opencodeImages: null,     // opencodeStream: image attachments (leg 1 only)
    bridgeSessionId: null,    // bridgeStream: adapter-assigned agent thread id
    bridgeTurn: '',           // bridgeStream: single prompt string
    bridgeEndpoint: '',       // bridgeStream: selected agent endpoint (multi-bridge)
    bridgeImages: null,       // bridgeStream: image URLs riding this turn (leg 1 only)
    responsesInput: null,     // responsesStream: full input array
    anthropicMessages: null,  // anthropicStream: messages array
    anthropicSystem: null,    // anthropicStream: system prompt string
    squillaSessionKey: null,  // squillaStream: gateway-assigned session key
    squillaMessage: '',       // squillaStream: single message string
    squillaAttachments: null, // squillaStream: base64 figure attachments (leg 1 only)
  };

  // Initial build — the shape each kind sends for the user's turn.
  t.prepare = async () => {
    if (kind === 'hermes') {
      t.hermesSessionId = await storage.getOrCreateHermesSessionId(activeProvider);
      // Pasted images go directly into `input` as input_image (read natively by
      // a vision-capable Hermes model); history images are preserved as
      // input_image by buildRunsConversationHistory. See buildHermesTurn.
      // sendHistory = context-aged copy (old attach blocks stubbed at send
      // time; storage untouched — see ageStaleAttachments in message-builder).
      ({ input: t.runsInput, conversationHistory: t.runsConvHistory } = buildHermesTurn(msg, sendHistory));
      return;
    }
    if (kind === 'squilla') {
      // The session key is gateway-assigned (sessions.create); create it on
      // first use and persist for conversational continuity across turns.
      t.squillaSessionKey = await storage.getSquillaSessionKey(activeProvider);
      const squillaNewSession = !t.squillaSessionKey;
      if (!t.squillaSessionKey) {
        t.squillaSessionKey = await createSquillaSession({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
        await storage.setSquillaSessionKey(activeProvider, t.squillaSessionKey);
      }
      const turn = buildSquillaTurn(msg, langInstruction(all.replyLanguage), sendHistory);
      let squillaMessage = turn.message;
      let squillaAttachments = turn.attachments;
      // 大页面兜底：内联消息超容量会被 prompt 组装器以 LargeContextCapacityError
      // 拒掉（路由到的模型窗口装不下几十万字符）。超过安全容量时改走文件材料
      // 通道——全文上传为 page-context.md，agent 用自己的工具分段读取（实测可
      // 处理 30k+，且不受模型窗口限制）。小上下文仍走消息内联（快、省事）。
      const SQUILLA_INLINE_CONTEXT_CAP = 60_000;
      if (turn.contextChars > SQUILLA_INLINE_CONTEXT_CAP) {
        const fileUuid = await uploadSquillaFile({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          name: 'page-context.md',
          mime: 'text/markdown',
          content: turn.contextText,
        });
        squillaAttachments = [
          { type: 'text/markdown', mime: 'text/markdown', name: 'page-context.md', file_uuid: fileUuid },
          ...squillaAttachments,
        ];
        const note = '（这轮消息附带了页面全文的文档附件 page-context.md——请先用工具读取它的完整内容，再基于它回答，不要重新访问或抓取 URL。）';
        squillaMessage = [note, langInstruction(all.replyLanguage), msg?.userText || ''].map(s => s.trim()).filter(Boolean).join('\n\n');
      }
      // First turn of the session carries the live-render fence vocabulary
      // (squilla never sees CAPABILITY_HINTS — parity with opencode/bridge;
      // the hint postdates the original 08-31 integration).
      t.squillaMessage = withAgentRenderHints(squillaMessage, squillaNewSession);
      t.squillaAttachments = squillaAttachments;
      return;
    }
    if (kind === 'opencode') {
      // First turn of this browser session lazily creates the server-side
      // session (id assigned by the server); later turns reuse it so the
      // agent retains its own transcript across the conversation.
      t.opencodeSessionId = await storage.getOpencodeSessionId(activeProvider);
      const opencodeNewSession = !t.opencodeSessionId;
      if (!t.opencodeSessionId) {
        t.opencodeSessionId = await createOpencodeSession({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          title: (msg.userText || '').slice(0, 60) || undefined,
        });
        await storage.setOpencodeSessionId(activeProvider, t.opencodeSessionId);
      }
      // Both fixed agent providers ride this turn's images (pastes/screenshots
      // first, then the trailing page-context run's image parts — PDF figures
      // etc.): opencode as prompt `files` data: attachments (live-verified to
      // reach the model), the bridge as /turns' images array. withTurnImages
      // caps both (≤8 / 3MB) and notes drops in the text. Images ride the
      // FIRST leg only — continuation/rewrite legs below null them out (the
      // agent's own transcript already holds them; resending duplicates).
      const agentTurn = buildAgentTurn(msg, sendHistory, { backfill: !!msg.backfill });
      const { text, images } = withTurnImages(agentTurn.text, agentTurn.images);
      // Agent providers never see CAPABILITY_HINTS — teach them the live-render
      // fence vocabulary (mermaid/echarts/markmap/smiles/pdb/nn) on the first
      // turn of the session; the server-side transcript carries it onward.
      t.opencodeTurn = withAgentRenderHints(text, opencodeNewSession);
      t.opencodeImages = images;
      return;
    }
    if (kind === 'bridge') {
      // Session id comes from the bridge's 'start' event on the FIRST turn
      // (the stream's onSessionId hook persists it); later turns reuse it so
      // the agent retains its own transcript across the conversation. Keyed
      // PER ENDPOINT: one bridge card fronts one agent per address (serve
      // mode = one bridge per port), so codex and claude threads must never
      // share an id.
      t.bridgeEndpoint = resolveBridgeEndpoint(provider, all);
      t.bridgeSessionId = await storage.getBridgeSessionId(activeProvider, t.bridgeEndpoint);
      const turn = buildAgentTurn(msg, sendHistory, { backfill: !!msg.backfill });
      const { text, images } = withTurnImages(turn.text, turn.images);
      t.bridgeTurn = withAgentRenderHints(text, !t.bridgeSessionId);
      t.bridgeImages = images;
      return;
    }
    if (kind === 'responses') {
      t.responsesInput = buildResponsesInput(msg, sendHistory);
      return;
    }
    if (kind === 'anthropic') {
      t.anthropicMessages = buildAnthropicMessages(msg, sendHistory);
      t.anthropicSystem = effectiveSystemPrompt || undefined;
      return;
    }
    // Standard stateless mode: send full history on every turn.
    t.messages = buildMessages({
      history: sendHistory,
      userText: msg.userText,
      pageContext: null,
      withImage: false,
      userImages: msg.images,
      systemPrompt: effectiveSystemPrompt,
    });
  };

  // Overflow self-rescue: rebuild the request shapes from the stubbed
  // history (oversized verbatim attachments replaced by labeled stubs).
  // Agent kinds are no-op here — callers gate on `overflowRescuable`.
  t.rebuildFrom = (history) => {
    if (kind === 'hermes') {
      t.runsConvHistory = buildRunsConversationHistory(history);
    } else if (kind === 'responses') {
      t.responsesInput = buildResponsesInput(msg, history);
    } else if (kind === 'anthropic') {
      t.anthropicMessages = buildAnthropicMessages(msg, history);
    } else if (kind === 'chat') {
      t.messages = buildMessages({
        history,
        userText: msg.userText,
        pageContext: null,
        withImage: false,
        userImages: msg.images,
        systemPrompt: effectiveSystemPrompt,
      });
    }
  };

  // Output-cap continuation: the model sees its own partial reply + a bare
  // continue instruction. Agent kinds send the instruction alone (their
  // server-side transcript already holds v1 — resending would duplicate);
  // stateless kinds re-send the conversation with v1 appended.
  t.continueWith = (instruction, priorReply) => {
    if (kind === 'hermes') {
      t.runsInput = instruction;
      t.runsConvHistory = [
        ...t.runsConvHistory,
        { role: 'user', content: String(msg.userText || '') },
        { role: 'assistant', content: priorReply },
      ].filter((m) => (m.content || '').toString().trim());
      return;
    }
    if (kind === 'opencode') {
      t.opencodeTurn = instruction;
      t.opencodeImages = null;
      return;
    }
    if (kind === 'bridge') {
      t.bridgeTurn = instruction;
      t.bridgeImages = null;
      return;
    }
    if (kind === 'squilla') {
      // The gateway holds this session's transcript server-side — sending the
      // bare continue instruction in the same sessionKey is the whole
      // continuation turn. Attachments rode leg 1; resending duplicates them
      // in the session (same rule as opencode/bridge images).
      t.squillaMessage = instruction;
      t.squillaAttachments = null;
      return;
    }
    const contHistory = [
      ...sendHistory,
      { role: 'user', content: msg.userText || '' },
      { role: 'assistant', content: priorReply },
    ];
    if (kind === 'responses') {
      t.responsesInput = buildResponsesInput({ userText: instruction }, contHistory);
    } else if (kind === 'anthropic') {
      t.anthropicMessages = buildAnthropicMessages({ userText: instruction }, contHistory);
    } else {
      t.messages = buildMessages({
        history: contHistory,
        userText: instruction,
        pageContext: null,
        withImage: false,
        userImages: null,
        systemPrompt: effectiveSystemPrompt,
      });
    }
  };

  // Video-notes timestamp rewrite: rebuild against a TRIMMED history (video
  // attach entry + this turn + v1 — resending the whole session doubled the
  // wall time on big contexts). Agent kinds again send the ask alone.
  t.rewriteWith = (instruction, history) => {
    if (kind === 'hermes') {
      t.runsInput = instruction;
      t.runsConvHistory = buildRunsConversationHistory(history);
      return;
    }
    if (kind === 'opencode') {
      t.opencodeTurn = instruction;
      t.opencodeImages = null;
      return;
    }
    if (kind === 'bridge') {
      t.bridgeTurn = instruction;
      t.bridgeImages = null;
      return;
    }
    if (kind === 'squilla') {
      t.squillaMessage = instruction;
      t.squillaAttachments = null;
      return;
    }
    if (kind === 'responses') {
      t.responsesInput = buildResponsesInput({ userText: instruction }, history);
    } else if (kind === 'anthropic') {
      t.anthropicMessages = buildAnthropicMessages({ userText: instruction }, history);
    } else {
      t.messages = buildMessages({
        history,
        userText: instruction,
        pageContext: null,
        withImage: false,
        userImages: null,
        systemPrompt: effectiveSystemPrompt,
      });
    }
  };

  return t;
}
