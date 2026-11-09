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
// opt-in, and a pick outside the model's vocabulary SNAPS to the nearest rung
// it does speak (ties go up the ladder; thinking is only turned off when the
// level explicitly says so). `provider.reasoningRaw` (JSON) is the escape
// hatch for vendors the registry doesn't know.

/** Vocabulary sets (per model family). */
export const VOCAB_TOGGLE = ['disabled', 'enabled'];                    // 开关型
export const VOCAB_EFFORT3 = ['low', 'high', 'max'];                    // 三档型
export const VOCAB_EFFORT4 = ['low', 'medium', 'high', 'xhigh'];        // 四档型
export const VOCAB_EFFORT6 = ['none', 'low', 'medium', 'high', 'xhigh', 'max']; // 全档型

/** The one canonical ladder every vocabulary is expressed in (nearest-rung fit). */
export const REASONING_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Legacy word → ladder rung. `disabled`/`enabled` are the toggle vocabulary. */
const VOCAB_ALIAS = new Map([['disabled', 'none'], ['enabled', 'high']]);
/** The ladder rung a level word means, or null when the word is not on it. */
const canon = (level) => {
  const w = String(level ?? '').trim().toLowerCase();
  // A Map, not an object: `constructor`/`__proto__`/`toString` must read as
  // "not a level" (an object lookup finds Object.prototype and fits them).
  return VOCAB_ALIAS.get(w) || (REASONING_LADDER.includes(w) ? w : null);
};

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
  // Qwen3.8 class: effort ladder (qwen-family chat prefers enable_thinking on
  // the toggle models above, but 3.8 speaks reasoning_effort). MUST stay
  // AFTER the toggle rule — last-match-wins, and `qwen3.8-*` also matches
  // the bare `/qwen/` pattern; placed earlier the specific rule was fully
  // shadowed (2026-10-24 audit: the picker showed 开/关 and sent
  // enable_thinking instead of reasoning_effort).
  {
    match: /qwen3\.8-(?:max|flash|omni-flash)/i,
    levels: VOCAB_EFFORT4,
    maps: {
      anthropic: (level) => ({ thinking: { type: 'enabled' }, output_config: { effort: e(level) } }),
      chat: (level) => ({ reasoning_effort: e(level) }),
      responses: (level) => ({ reasoning: { effort: e(level) } }),
    },
  },
];

/**
 * The reasoning spec for a model id: `{ levels, maps }`.
 *
 * Vocabulary precedence: per-model override (the options card's
 * `modelLevels[model]`) → built-in rule → catalog (a model directory injected
 * by the caller) → none (inert). Maps resolve independently: the matching
 * rule's maps, else the per-dialect defaults when an outside vocabulary
 * (`overrideLevels`/`catalogLevels`) supplied levels.
 *
 * Non-array `overrideLevels`/`catalogLevels` are IGNORED: the single-model
 * seam takes an ARRAY and the multi-model seam takes a Record, and a Record
 * spread into a level list would be a silent wrong vocabulary. LAST matching
 * rule wins; a `.*` catch-all is deliberately absent.
 */
export function reasoningSpecFor(modelId, { overrideLevels, catalogLevels } = {}) {
  const id = String(modelId || '');
  const override = (Array.isArray(overrideLevels) && overrideLevels.length) ? overrideLevels : null;
  const catalog = (Array.isArray(catalogLevels) && catalogLevels.length) ? catalogLevels : null;
  let rule = null;
  for (const r of RULES) {
    if (r.match.test(id)) rule = r;
  }
  return {
    levels: override || (rule ? rule.levels : (catalog || [])),
    maps: rule ? rule.maps : ((override || catalog) ? DEFAULT_MAPS : {}),
  };
}

/** Level options for the UI: `auto` (send nothing) + the model's vocabulary, deduped. */
export function reasoningLevelOptions(modelId, opts = {}) {
  const out = ['auto'];
  for (const level of reasoningSpecFor(modelId, opts).levels) {
    if (!out.includes(level)) out.push(level);
  }
  return out;
}

/**
 * `auto` + the deduped union of level options for a set of models (first-seen
 * order) — the single implementation behind the options card's level picker.
 * `modelLevelsById`/`catalogLevelsByModel` are records keyed by model id.
 */
export function reasoningLevelsFor(modelIds, { modelLevelsById = {}, catalogLevelsByModel = {} } = {}) {
  const out = ['auto'];
  for (const id of Array.isArray(modelIds) ? modelIds : []) {
    const { levels } = reasoningSpecFor(id, {
      overrideLevels: modelLevelsById?.[id],
      catalogLevels: catalogLevelsByModel?.[id],
    });
    for (const level of levels) {
      if (!out.includes(level)) out.push(level);
    }
  }
  return out;
}

/**
 * Fit a level word onto the vocabulary a model actually speaks: an exact hit
 * comes back verbatim; otherwise the word snaps to the nearest rung of
 * REASONING_LADDER, ties going to the HIGHER rung. 'none' only ever lands on
 * an explicit off rung, and no non-off pick is ever fitted to off — an
 * ambiguous pick always errs towards thinking harder, never towards silence.
 * 'auto', a word outside the ladder, or an empty vocabulary → 'auto'.
 */
export function fitReasoningLevel(want, levels) {
  const list = Array.isArray(levels) ? levels : [];
  const raw = String(want ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return 'auto';
  if (list.includes(raw)) return raw;
  const target = canon(raw);
  if (!target) return 'auto';
  const cands = list
    .map((label) => ({ label, rung: canon(label) }))
    .filter((c) => c.rung);
  if (target === 'none') {
    const off = cands.find((c) => c.rung === 'none');
    return off ? off.label : 'auto';
  }
  const ti = REASONING_LADDER.indexOf(target);
  let best = null;
  for (const c of cands) {
    const ri = REASONING_LADDER.indexOf(c.rung);
    if (c.rung === 'none') continue;
    const d = Math.abs(ri - ti);
    if (!best || d < best.d || (d === best.d && ri > best.ri)) best = { label: c.label, d, ri };
  }
  return best ? best.label : 'auto';
}

/** The spec opts a provider's card implies for one model (override → rule → catalog). */
const specForProvider = (provider, modelId, catalogLevels) =>
  reasoningSpecFor(modelId, { overrideLevels: provider?.modelLevels?.[modelId], catalogLevels });

/** The level a turn sends: per-model pick → card default → 'auto', then fitted. */
const levelWithSpec = (provider, modelId, spec) =>
  fitReasoningLevel(provider?.reasoningByModel?.[modelId] ?? provider?.reasoningDefault ?? '', spec.levels);

/**
 * The configured level for a model: `reasoningByModel[model]` → the card's
 * `reasoningDefault` → 'auto'. 'auto' sends nothing; a pick outside the
 * model's vocabulary snaps to the nearest rung it speaks (2026-11-09: the
 * per-model override is live again — the options card writes both
 * `reasoningByModel` and `modelLevels`).
 */
export function resolveReasoningLevel(provider, modelId, { catalogLevels } = {}) {
  return levelWithSpec(provider, modelId, specForProvider(provider, modelId, catalogLevels));
}

/**
 * Request body fields for one turn: `null` for 'auto' (nothing sent), else the
 * model rule's dialect map output. `provider.reasoningRaw` (a JSON object
 * string) merges LAST — the escape hatch for vendors the registry misses.
 */
export function reasoningFieldsFor({ provider, modelId, apiStyle, catalogLevels }) {
  const spec = specForProvider(provider, modelId, catalogLevels);
  const level = levelWithSpec(provider, modelId, spec);
  let fields = (level !== 'auto' && spec.maps[apiStyle]) ? spec.maps[apiStyle](level) : null;
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
