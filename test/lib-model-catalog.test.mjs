// test/lib-model-catalog.test.mjs — models.dev catalog import, pure module.
//
// Contract (unit E): lib/model-catalog.js is pure (no chrome/DOM/fetch) so the
// options page builds a catalog from a fetched api.json and the request path
// only ever READS it. The parser has to survive schema drift: unknown option
// types and off-ladder effort words are filtered, a model with no own
// vocabulary borrows its family's majority word list, and the same model id
// appearing in many providers is decided by MAJORITY VOTE (never by JSON key
// order — that would make the catalog depend on provider insertion order).
//
// Fixtures are inline and tiny on purpose: the real api.json is ~6MB and must
// never be read by a test (see AGENTS.md memory constraint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_VERSION,
  MAX_CATALOG_KEYS,
  MODEL_CATALOG_KEY,
  MODEL_CATALOG_URL,
  buildCatalog,
  catalogLevelsFor,
  catalogLevelsFromModel,
  catalogModelCount,
  isCatalog,
} from '../lib/model-catalog.js';

const effort = (...values) => ({ reasoning_options: [{ type: 'effort', values }] });
const toggle = () => ({ reasoning_options: [{ type: 'toggle' }] });
const provider = (models) => ({ models });
const api = (...providers) => Object.fromEntries(providers.map((models, i) => [`p${i}`, provider(models)]));

// ─── constants ───────────────────────────────────────────────────────────────

test('常量：键名 / URL / 版本 / 键数上限都是单点导出', () => {
  assert.equal(MODEL_CATALOG_KEY, 'modelCatalog');
  assert.equal(MODEL_CATALOG_URL, 'https://models.dev/api.json');
  assert.equal(CATALOG_VERSION, 1);
  assert.equal(MAX_CATALOG_KEYS, 8000);
});

// ─── catalogLevelsFromModel ─────────────────────────────────────────────────

test('effort：只留阶梯词，去重并按 REASONING_LADDER 排序', () => {
  assert.deepEqual(catalogLevelsFromModel(effort('low', 'bogus', 'max')), ['low', 'max'],
    'off-ladder 词被过滤');
  assert.deepEqual(catalogLevelsFromModel(effort('max', 'low', 'MAX')), ['low', 'max'],
    '大小写归一 + 去重 + 阶梯顺序（不是输入顺序）');
  assert.deepEqual(catalogLevelsFromModel(effort('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default')),
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    "实测数据里的 'default' 不是阶梯词，必须过滤");
});

test('toggle → [disabled, enabled]；budget_tokens 忽略', () => {
  assert.deepEqual(catalogLevelsFromModel(toggle()), ['disabled', 'enabled']);
  assert.deepEqual(catalogLevelsFromModel({ reasoning_options: [{ type: 'budget_tokens' }] }), null,
    'budget_tokens 没有词表可映射');
  assert.deepEqual(catalogLevelsFromModel(effort('bogus')), null, 'effort 但一个阶梯词都没有');
  assert.deepEqual(catalogLevelsFromModel({}), null);
  assert.deepEqual(catalogLevelsFromModel(null), null);
});

test('effort 优先于 toggle：两种选项同时存在时取 effort 词表', () => {
  assert.deepEqual(
    catalogLevelsFromModel({ reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }] }),
    ['low', 'high'],
  );
});

// ─── buildCatalog：键与族借用 ───────────────────────────────────────────────

test('canonical 三键：raw id / canonical / canonical 最后一段都命中同一词表', () => {
  const catalog = buildCatalog(api(
    { 'Alias-1': { ...effort('low'), canonical_model_id: 'vendor/real-id' } },
  ), { now: 1 });
  assert.deepEqual(catalogLevelsFor(catalog, 'alias-1'), ['low'], 'raw id（小写）');
  assert.deepEqual(catalogLevelsFor(catalog, 'vendor/real-id'), ['low'], 'canonical id');
  assert.deepEqual(catalogLevelsFor(catalog, 'real-id'), ['low'], 'canonical 最后一段');
});

test('family 借用：无词表但同族另有词表的模型继承族赢家', () => {
  const catalog = buildCatalog(api(
    { 'fam-src': { ...effort('low', 'high'), family: 'fam-x' } },
    { 'fam-borrow': { family: 'fam-x' } },
    { 'budget-only': { reasoning_options: [{ type: 'budget_tokens' }], family: 'fam-none' } },
  ), { now: 1 });
  assert.deepEqual(catalogLevelsFor(catalog, 'fam-borrow'), ['low', 'high'], '族赢家按票借用');
  assert.equal(catalogLevelsFor(catalog, 'budget-only'), null, '族里没有词表 → 仍然没有');
});

// ─── buildCatalog：同键冲突按多数票 ─────────────────────────────────────────

test('多数票：11 票 effort {high,max} 压过 9 票 toggle', () => {
  const providers = [];
  for (let i = 0; i < 11; i++) providers.push({ 'shared-model': effort('high', 'max') });
  for (let i = 0; i < 9; i++) providers.push({ 'shared-model': toggle() });
  const catalog = buildCatalog(api(...providers), { now: 1 });
  assert.deepEqual(catalogLevelsFor(catalog, 'shared-model'), ['high', 'max'],
    '多数票，不是先写者赢（JSON 键序）');
});

test('平票 → effort 优先；再平 → 阶梯更长；再平 → 字典序', () => {
  const tieEffort = buildCatalog(api(
    ...Array.from({ length: 3 }, () => ({ m: effort('low', 'high') })),
    ...Array.from({ length: 3 }, () => ({ m: toggle() })),
  ), { now: 1 });
  assert.deepEqual(catalogLevelsFor(tieEffort, 'm'), ['low', 'high'], '3/3 平票：effort 词表胜 toggle');

  const tieLonger = buildCatalog(api(
    ...Array.from({ length: 2 }, () => ({ m: effort('low') })),
    ...Array.from({ length: 2 }, () => ({ m: effort('low', 'high') })),
  ), { now: 1 });
  assert.deepEqual(catalogLevelsFor(tieLonger, 'm'), ['low', 'high'], '同票同源：阶梯更长的胜');

  const tieLex = buildCatalog(api(
    ...Array.from({ length: 2 }, () => ({ m: effort('low') })),
    ...Array.from({ length: 2 }, () => ({ m: effort('high') })),
  ), { now: 1 });
  assert.deepEqual(catalogLevelsFor(tieLex, 'm'), ['high'], '同票同长：字典序');
});

// ─── buildCatalog：形状、幂等、cap ──────────────────────────────────────────

test('输出形状固定；models 部分幂等（fetchedAt 每次不同，只比 models）', () => {
  const raw = api({ a: effort('low'), b: toggle() });
  const one = buildCatalog(raw, { now: 1 });
  const two = buildCatalog(raw, { now: 999 });
  assert.equal(one.version, CATALOG_VERSION);
  assert.equal(one.fetchedAt, 1);
  assert.equal(two.fetchedAt, 999);
  assert.equal(JSON.stringify(one.models), JSON.stringify(two.models), 'models 逐字节相同');
  assert.deepEqual(Object.keys(one.models), Object.keys(one.models).slice().sort(), '键排序');
});

test('cap：maxKeys 截断（排序后取前 N）；空词表条目剔除', () => {
  const catalog = buildCatalog(api({ c: effort('low'), a: effort('high'), b: effort('max') }), { now: 1, maxKeys: 2 });
  assert.deepEqual(Object.keys(catalog.models), ['a', 'b'], '排序后截断');
  const dropped = buildCatalog(api({ empty: effort('bogus'), kept: effort('low') }), { now: 1 });
  assert.deepEqual(Object.keys(dropped.models), ['kept'], '空词表不进目录');
});

test('宽容：非对象 / 换形状的输入返回空目录而不是抛错', () => {
  for (const raw of [null, undefined, 42, 'x', [], { p: {} }, { p: { models: [] } }, { p: { models: { m: null } } }]) {
    const catalog = buildCatalog(raw, { now: 1 });
    assert.equal(isCatalog(catalog), true, `buildCatalog(${JSON.stringify(raw)}) 仍是合法目录`);
    assert.equal(catalogModelCount(catalog), 0);
  }
});

// ─── catalogLevelsFor / isCatalog / catalogModelCount ──────────────────────

test('catalogLevelsFor：大小写不敏感、最后一段兜底、未知模型 null', () => {
  const catalog = buildCatalog(api({ 'Vendor/Model-X': effort('low', 'max') }), { now: 1 });
  assert.deepEqual(catalogLevelsFor(catalog, 'vendor/model-x'), ['low', 'max']);
  assert.deepEqual(catalogLevelsFor(catalog, 'model-x'), ['low', 'max'], '最后一段兜底');
  assert.equal(catalogLevelsFor(catalog, 'nope'), null);
  assert.equal(catalogLevelsFor(null, 'model-x'), null);
  assert.equal(catalogLevelsFor(catalog, ''), null);
});

test('isCatalog 拒绝 null / 数组 / 无 models；catalogModelCount 数模型', () => {
  assert.equal(isCatalog(null), false);
  assert.equal(isCatalog([]), false);
  assert.equal(isCatalog({}), false);
  assert.equal(isCatalog({ models: [] }), false);
  assert.equal(isCatalog({ models: null }), false);
  assert.equal(isCatalog('x'), false);
  assert.equal(isCatalog({ version: 1, fetchedAt: 1, models: {} }), true);
  assert.equal(catalogModelCount({ version: 1, fetchedAt: 1, models: { a: ['low'], b: ['high'] } }), 2);
  assert.equal(catalogModelCount(null), 0);
  assert.equal(catalogModelCount({}), 0);
});
