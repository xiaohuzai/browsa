// lib/reasoning-levels.js — per-model reasoning ("thinking") levels, adapted
// from model id alone. Pure module (no chrome/DOM) so request builders and the
// options UI share one registry.
//
// The problem this solves (user, 2026-09-23: "thinking 的类型各家不一样"):
// every vendor calls the knob something else AND gives it a different value
// vocabulary. GLM/Kimi-class models are a plain {关, 开} toggle; Claude/GLM-x
// take {low, high, max}; GPT-5-class take {none … xhigh, max}. The same word
// ("high") becomes a different wire field per API dialect.
//
// Technique ported from ZCode's built-in provider registry
// (github.com/zai-org/ZCode, config/provider/zcode-builtin.json — audited
// 2026-09-23; per ADR-0003 this is a TECHNIQUE, not a signature feature):
// TWO orthogonal rule tables keyed on the model id —
//   1. model rules: which LEVEL VOCABULARY this model speaks;
//   2. (model × api-dialect) map rules: how one level becomes wire fields.
// ZCode compiles the maps from small expression strings; this port uses plain
// JS functions — same semantics, no eval. Fill in a model id and the level
// picker + request fields adapt with zero further configuration.
//
// Failure philosophy: unknown model → NO vocabulary and NO fields are ever
// sent (the provider's own defaults apply). Picking a level is an explicit
// opt-in; `provider.reasoningRaw` (JSON) is the escape hatch for vendors the
// registry doesn't know.

/** Vocabulary sets (per model family). */
export const VOCAB_TOGGLE = ['disabled', 'enabled'];                    // 开关型
export const VOCAB_EFFORT3 = ['low', 'high', 'max'];                    // 三档型
export const VOCAB_EFFORT4 = ['low', 'medium', 'high', 'xhigh'];        // 四档型
export const VOCAB_EFFORT6 = ['none', 'low', 'medium', 'high', 'xhigh', 'max']; // 全档型

const e = (level, enabled = 'high') => (level === 'disabled' ? 'none' : level === 'enabled' ? enabled : level);

// ─── Dialect default maps (the three "any model on this API" fallbacks) ──────
// Faithful to ZCode's modelApiRules `.*` rows. Anthropic's map is the current
// effort API (`thinking.type:'adaptive'` + `output_config.effort`); Responses
// uses `reasoning.effort`; chat-completions has NO standard, so its default
// map emits the known shapes together — OpenAI-derived gateways ignore unknown
// body fields, and the per-family rules below REPLACE this shotgun with the
// exact shape for vendors known to be strict.
const DEFAULT_MAPS = {
  anthropic: (level) => (level === 'disabled' || level === 'none'
    ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'adaptive' }, output_config: { effort: e(level) } }),
  responses: (level) => ({ reasoning: { effort: e(level) } }),
  chat: (level) => ({
    thinking: { type: (level === 'disabled' || level === 'none') ? 'disabled' : 'enabled' },
    enable_thinking: !(level === 'disabled' || level === 'none'),
    reasoning_effort: e(level),
    reasoning: { effort: e(level) },
  }),
};

const toggleMap = (field) => (level) => ({ [field]: !(level === 'disabled' || level === 'none') });
// Anthropic's toggle is an object, not a bool ({thinking:{type:'enabled'}}).
const anthropicToggle = (level) => ({ thinking: { type: (level === 'disabled') ? 'disabled' : 'enabled' } });
// DeepSeek-class vocabulary: the ladder with an explicit off position.
const VOCAB_EFFORT3D = ['disabled', 'low', 'high', 'max'];

// ─── Model rules ─────────────────────────────────────────────────────────────
// Ordered; the LAST matching rule wins the vocabulary and its maps (a `.*`
// catch-all is deliberately absent — unknown models stay inert). Patterns and
// vocabularies curated from ZCode's modelRules/modelApiRules (families kept,
// patch-version churn dropped); suffix tolerance matches their
// `(?:[.\\-:/\\[].*)?` convention so `qwen3.5-plus-2026-01-01` still hits.
const RULES = [
  // GPT-5/6 class: full effort ladder on Responses/Chat.
  {
    match: /(?:^|[^\w])(?:gpt-5|gpt-6|o[134])(?:[.\-:/[]|$)/i,
    levels: VOCAB_EFFORT6,
    maps: {
      responses: (level) => ({ reasoning: { effort: e(level) } }),
      chat: (level) => ({ reasoning_effort: e(level) }),
      anthropic: DEFAULT_MAPS.anthropic,
    },
  },
  // Claude class (5-gen: adaptive thinking + effort).
  {
    match: /claude-(?:opus|sonnet|fable|mythos|haiku)-?(?:4|5)/i,
    levels: VOCAB_EFFORT3,
    maps: {
      anthropic: (level) => (level === 'disabled'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'adaptive' }, output_config: { effort: e(level) } }),
    },
  },
  // Kimi k3 class: effort ladder, `output_config.effort` on Anthropic-style
  // endpoints and `reasoning_effort` on chat.
  {
    match: /(?:^|[^\w])(?:kimi-)?k3(?:[.\-:/[]|$)/i,
    levels: VOCAB_EFFORT4,
    maps: {
      anthropic: (level) => ({ output_config: { effort: e(level) } }),
      chat: (level) => ({ reasoning_effort: e(level) }),
      responses: (level) => ({ reasoning: { effort: e(level) } }),
    },
  },
  // GLM-x preview class: three-level effort.
  {
    match: /(?:ox-alpha|glm-x-preview|x-preview-f)/i,
    levels: VOCAB_EFFORT3,
    maps: {
      anthropic: (level) => ({ thinking: { type: 'adaptive' }, output_config: { effort: e(level) } }),
      chat: (level) => ({ reasoning_effort: e(level) }),
    },
  },
  // Qwen3.8 class: effort ladder (qwen-family chat prefers enable_thinking on
  // the toggle models below, but 3.8 speaks reasoning_effort).
  {
    match: /qwen3\.8-(?:max|flash|omni-flash)/i,
    levels: VOCAB_EFFORT4,
    maps: {
      anthropic: (level) => ({ thinking: { type: 'enabled' }, output_config: { effort: e(level) } }),
      chat: (level) => ({ reasoning_effort: e(level) }),
      responses: (level) => ({ reasoning: { effort: e(level) } }),
    },
  },
  // DeepSeek v4 class: ladder with an explicit off position (their chat shape
  // is thinking.type + reasoning_effort; Anthropic shape is thinking + effort).
  {
    match: /deepseek-(?:v4|flash|r2)/i,
    levels: VOCAB_EFFORT3D,
    maps: {
      anthropic: DEFAULT_MAPS.anthropic,
      chat: (level) => ((level === 'disabled' || level === 'none')
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' }, reasoning_effort: e(level) }),
      responses: (level) => ({ reasoning: { effort: e(level) } }),
    },
  },
  // Toggle-class thinking models (the {关, 开} family): Qwen chat dialects use
  // enable_thinking; the rest use thinking.type on Anthropic-style endpoints
  // and a high/none effort on Responses.
  {
    match: /qwen|glm-[45]|kimi-k2|mimo-v2|qwq/i,
    levels: VOCAB_TOGGLE,
    maps: {
      anthropic: anthropicToggle,
      chat: toggleMap('enable_thinking'),
      responses: (level) => ({ reasoning: { effort: e(level) } }),
    },
  },
];

/**
 * The reasoning spec for a model id: `{ levels, maps }`. Unknown model →
 * `{ levels: [], maps: {} }` (inert). LAST matching rule wins.
 */
export function reasoningSpecFor(modelId) {
  const id = String(modelId || '');
  let spec = { levels: [], maps: {} };
  for (const r of RULES) {
    if (r.match.test(id)) spec = { levels: r.levels, maps: r.maps };
  }
  return spec;
}

/** Level options for the UI: `auto` (send nothing) + the model's vocabulary. */
export function reasoningLevelOptions(modelId) {
  return ['auto', ...reasoningSpecFor(modelId).levels];
}

/**
 * The configured level for a model: per-model override → card default →
 * 'auto'. Values outside the model's vocabulary degrade to 'auto' (a stale
 * per-model pick must never send a level the model doesn't speak).
 */
export function resolveReasoningLevel(provider, modelId) {
  const per = provider?.reasoningByModel?.[String(modelId || '')];
  const level = (per != null && per !== '') ? per : (provider?.reasoningDefault || 'auto');
  if (level === 'auto') return 'auto';
  const { levels } = reasoningSpecFor(modelId);
  return levels.includes(level) ? level : 'auto';
}

/**
 * Request body fields for one turn: `null` for 'auto' (nothing sent), else the
 * model rule's dialect map output. `provider.reasoningRaw` (a JSON object
 * string) merges LAST — the escape hatch for vendors the registry misses.
 */
export function reasoningFieldsFor({ provider, modelId, apiStyle }) {
  const level = resolveReasoningLevel(provider, modelId);
  const { maps } = reasoningSpecFor(modelId);
  let fields = (level !== 'auto' && maps[apiStyle]) ? maps[apiStyle](level) : null;
  const raw = parseReasoningRaw(provider?.reasoningRaw);
  if (raw) fields = { ...(fields || {}), ...raw };
  return fields;
}

/** Parse the card's `reasoningRaw` JSON passthrough; null when absent/invalid. */
export function parseReasoningRaw(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch (_) { return null; }
}
