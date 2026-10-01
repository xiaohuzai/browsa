// 七语 _locales 契约（纯文件测试，无 DOM）：每个语言目录的 messages.json 必须——
// ① 键集与 en 全等且键序一致（翻译按 en 的顺序写，diff 友好）；
// ② 每条 message 的占位符集与 en 全等（bare $N 形态；$N 后必须跟非名称字符）；
// ③ 不出现 well-formed $name$ 对（$名称$ 相邻闭合）——Chrome 的 messages.json
//    解析器把它当必须声明的占位符，未声明直接拒绝整个扩展加载（2026-09-30 实录，
//    "（$2$3）" 被解析成 $2$ 就是这个坑）；翻译里出现即红灯；
// ④ 占位符无 ≥2 位数、无前缀碰撞（$1 与 $12 共存会让 tSub 的 replaceAll('$1') 咬坏 $12）；
// ⑤ extensionName 七语恒为 "browsa"，无空 message。
// 新增 UI 语言：_locales 加目录 + lib/i18n.js 与 selection-toolbar.js 的
// UI_LANG_DIRS（lockstep）+ options.html 选择器 + 本文件 LANGS。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['en', 'zh_CN', 'ja', 'ko', 'es', 'pt_BR', 'ru'];

const dicts = Object.fromEntries(
  LANGS.map((l) => [l, JSON.parse(readFileSync(join(root, '_locales', l, 'messages.json'), 'utf8'))]),
);
const en = dicts.en;
const enKeys = Object.keys(en);

// 占位符比对用宽松数字正则（$ + 数字串）：$1s 这类「占位符紧贴字母后缀」要抓得到，
// $8K 这类金额也天然被抓到——金额译文必须原样保留数字，宽松比对恰好能把擅改金额的
// 译文挡下。$name$ 词形与 $$ 转义不会被数字正则命中。
function barePlaceholders(s) {
  return [...String(s).matchAll(/\$(\d+)(?!\d)/g)].map((m) => m[1]);
}

// 例外表：chipPdfFigures 的 $2 是代码传入的英文复数词尾（"s"/""，attach-orchestrator），
// 对分析语形态无意义——zh 先例直接丢弃（多余实参被忽略）。en/es/pt 的名词复数恰好
// 是加 s，保留两段；ja/ko/ru/zh_CN 丢 $2 只留 $1。新开例外必须在此具名，不许静默。
const ALLOWED_DROPS = { chipPdfFigures: { ja: ['$2'], ko: ['$2'], ru: ['$2'], zh_CN: ['$2'] } };

test('七语键集与键序全等', () => {
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(dicts[lang]), enKeys, `${lang} 键集/键序与 en 不一致`);
  }
});

test('每条 message 占位符集与 en 全等（具名例外除外）', () => {
  for (const key of enKeys) {
    for (const lang of LANGS) {
      // 例外对两侧同时生效：被豁免的占位符整个不参与比对（en 多出的复数词尾不该苛求分析语）
      const drops = ALLOWED_DROPS[key]?.[lang] ?? [];
      const strip = (s) =>
        [...new Set(barePlaceholders(String(s)))].filter((t) => !drops.includes(`$${t}`)).sort().join(',');
      assert.equal(strip(dicts[lang][key].message), strip(en[key].message), `${lang}.${key} 占位符与 en 不一致`);
    }
  }
});

test('全字典无 well-formed $name$ 对（Chrome 加载陷阱；$$ 转义不算）', () => {
  for (const lang of LANGS) {
    for (const [key, entry] of Object.entries(dicts[lang])) {
      assert.doesNotMatch(
        String(entry.message),
        /(?<!\$)\$[A-Za-z0-9_]+\$(?!\$)/,
        `${lang}.${key} 含 \$name\$ 形态`,
      );
      assert.equal(entry.placeholders, undefined, `${lang}.${key} 出现 placeholders 声明——本仓约定全走 bare $N，勿引入`);
    }
  }
});

test('无 ≥2 位占位符、无 $1/$12 式前缀碰撞', () => {
  for (const lang of LANGS) {
    for (const [key, entry] of Object.entries(dicts[lang])) {
      const ps = barePlaceholders(String(entry.message));
      for (const p of ps) {
        assert.ok(p.length === 1, `${lang}.${key} 占位符 $${p} 超过一位数`);
      }
      assert.equal(new Set(ps).size, ps.length, `${lang}.${key} 占位符重复`);
    }
  }
});

test('extensionName 恒为 browsa；message 无空串', () => {
  for (const lang of LANGS) {
    assert.equal(dicts[lang].extensionName.message, 'browsa');
    for (const [key, entry] of Object.entries(dicts[lang])) {
      assert.ok(String(entry.message).length > 0, `${lang}.${key} 是空 message`);
    }
  }
});
