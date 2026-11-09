// lib/model-catalog.js — the optional models.dev catalog (unit E).
//
// What this is: the settings page lets the user import https://models.dev/api.json
// ONCE, by hand. The imported blob is distilled here into
//   { version, fetchedAt, models: { <lowered model id>: <level vocabulary> } }
// and stored under one targeted-read key (lib/storage.js getModelCatalog).
// The only consumer is the reasoning path: lib/reasoning-levels.js takes
// `catalogLevels` as the LAST vocabulary source (per-model override → built-in
// rule → catalog → inert), so a model the registry does not know can still get
// a real picker instead of an inert one. Nothing is fetched in background, at
// startup, or per turn: no catalog imported = byte-identical behaviour.
//
// Pure module on purpose (no chrome / DOM / fetch): the parser is the hard part
// and it is a pure function of the upstream JSON, so it is unit-testable with
// tiny inline fixtures and never touches the ~6MB upstream blob in tests.

import { REASONING_LADDER } from './reasoning-levels.js';

/** chrome.storage.local key — targeted read, SO NOT in lib/storage.js GET_ALL_KEYS. */
export const MODEL_CATALOG_KEY = 'modelCatalog';
export const MODEL_CATALOG_URL = 'https://models.dev/api.json';
/** Bumped only if the stored shape changes incompatibly. */
export const CATALOG_VERSION = 1;
/**
 * Upper bound on stored model keys. The real api.json distils to roughly four
 * thousand keys (~200KB serialized); 8000 leaves headroom for upstream growth
 * while keeping the blob a few hundred KB — it rides in every stateless turn's
 * targeted read, so it must stay bounded.
 */
export const MAX_CATALOG_KEYS = 8000;

const norm = (v) => String(v ?? '').trim().toLowerCase();
const ON_LADDER = new Set(REASONING_LADDER);
/** `disabled`/`enabled` (toggle) are the only off-ladder words the parser emits. */
const isEffortLevels = (levels) => levels.every((l) => ON_LADDER.has(l));

/**
 * One model's own level vocabulary, or null. Schema (models.dev, verified
 * 2026-11-09): `reasoning_options: [{type:'effort', values:[…]} | {type:'toggle'}
 * | {type:'budget_tokens'}]`, where effort values are mostly the canonical
 * ladder but include stray words (`default`) that must be dropped.
 *
 * effort wins over toggle when both are present (effort is the richer
 * vocabulary); budget_tokens carries no word list, so it maps to nothing.
 * Off-ladder / non-string values are filtered and the survivors are ordered by
 * REASONING_LADDER — the same ladder fitReasoningLevel measures distance in.
 */
export function catalogLevelsFromModel(model) {
  if (!model || typeof model !== 'object') return null;
  const opts = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const effort = opts.find((o) => o && o.type === 'effort' && Array.isArray(o.values));
  if (effort) {
    const seen = new Set();
    for (const v of effort.values) {
      const word = norm(v);
      if (ON_LADDER.has(word)) seen.add(word);
    }
    if (seen.size) return REASONING_LADDER.filter((l) => seen.has(l));
  }
  if (opts.some((o) => o && o.type === 'toggle')) return ['disabled', 'enabled'];
  return null;
}

// ─── per-key ballot ─────────────────────────────────────────────────────────
// The same model id shows up in many providers with different vocabularies.
// Resolving that by "first writer wins" would equal JSON key order, i.e. the
// catalog would flip when upstream reorders its providers. Instead every
// contribution is one vote and the winner is: most votes → effort over toggle
// → longer ladder → lexicographic. Deterministic for any input order.
const vote = (ballots, key, levels) => {
  if (!ballots.has(key)) ballots.set(key, new Map());
  const table = ballots.get(key);
  const sig = levels.join('\u0000');
  const cur = table.get(sig);
  if (cur) cur.votes++;
  else table.set(sig, { levels, effort: isEffortLevels(levels), votes: 1 });
};
const winnerOf = (table) => {
  let best = null;
  for (const [sig, c] of table) {
    if (!best
      || c.votes > best.c.votes
      || (c.votes === best.c.votes && c.effort && !best.c.effort)
      || (c.votes === best.c.votes && c.effort === best.c.effort && c.levels.length > best.c.levels.length)
      || (c.votes === best.c.votes && c.effort === best.c.effort && c.levels.length === best.c.levels.length
        && sig < best.sig)) {
      best = { sig, c };
    }
  }
  return best ? best.c.levels : null;
};

// Every id a user might type for this model: the raw id, the canonical id, and
// the canonical id's last path segment (`alibaba/qwen3.8-27b` → `qwen3.8-27b`,
// which is also the form most gateways accept).
function keysFor(id, canonicalRaw) {
  const canonical = typeof canonicalRaw === 'string' ? canonicalRaw : '';
  const out = [];
  const push = (v) => {
    const k = norm(v);
    if (k && !out.includes(k)) out.push(k);
  };
  push(id);
  push(canonical);
  push(String(canonical || id).split('/').pop());
  return out;
}

/**
 * Distil an api.json response into the stored catalog. Tolerant by design — an
 * unreachable/renamed upstream shape yields an EMPTY catalog, never a throw:
 * the caller is a settings-page button and a crash there is worse than a
 * catalog that imports nothing.
 *
 * Two passes: (1) vote each model's `family` on its OWN vocabulary, pick a
 * family winner; (2) models with no own vocabulary borrow their family winner
 * (a large share of the real data only carries `family`), then every model
 * votes for each of its ids. Keys are sorted and capped at `maxKeys`.
 */
export function buildCatalog(raw, { now = Date.now(), maxKeys = MAX_CATALOG_KEYS } = {}) {
  const root = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const entries = [];
  for (const provider of Object.values(root)) {
    const table = (provider && typeof provider === 'object') ? provider.models : null;
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [id, model] of Object.entries(table)) {
      if (!model || typeof model !== 'object') continue;
      entries.push({
        id,
        canonical: model.canonical_model_id,
        family: norm(model.family),
        own: catalogLevelsFromModel(model),
      });
    }
  }

  // Pass 1 — family vocabularies, voted from own vocabularies only.
  const familyBallots = new Map();
  for (const e of entries) {
    if (e.own && e.family) vote(familyBallots, e.family, e.own);
  }
  const familyWinner = new Map([...familyBallots].map(([fam, table]) => [fam, winnerOf(table)]));

  // Pass 2 — every model votes for each of its ids.
  const ballots = new Map();
  for (const e of entries) {
    const levels = e.own || (e.family ? familyWinner.get(e.family) : null);
    if (!levels || !levels.length) continue;
    for (const key of keysFor(e.id, e.canonical)) vote(ballots, key, levels);
  }

  const models = {};
  const keys = [...ballots.keys()].sort().slice(0, Number.isFinite(maxKeys) && maxKeys > 0 ? maxKeys : MAX_CATALOG_KEYS);
  // `[...winner]` per key: two keys of one model (canonical + last segment)
  // share the winning candidate, and the stored catalog must not hand out two
  // keys that alias the same mutable array.
  for (const key of keys) models[key] = [...winnerOf(ballots.get(key))];
  return {
    version: CATALOG_VERSION,
    fetchedAt: Number.isFinite(now) ? now : Date.now(),
    models,
  };
}

/** True for a stored value that has the catalog shape (null/array/garbage → false). */
export function isCatalog(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && !!v.models && typeof v.models === 'object' && !Array.isArray(v.models);
}

/**
 * The catalog vocabulary for one model id: an exact (lowered) hit first, then
 * the id's last path segment. A copy, so a caller can never mutate the stored
 * catalog through the array it was handed.
 */
export function catalogLevelsFor(catalog, modelId) {
  if (!isCatalog(catalog)) return null;
  const id = norm(modelId);
  if (!id) return null;
  const models = catalog.models;
  for (const key of [id, id.split('/').pop()]) {
    if (!Object.hasOwn(models, key)) continue;
    const levels = models[key];
    if (Array.isArray(levels) && levels.length) return [...levels];
  }
  return null;
}

/** How many model ids the catalog knows (0 for anything that is not one). */
export function catalogModelCount(catalog) {
  return isCatalog(catalog) ? Object.keys(catalog.models).length : 0;
}
