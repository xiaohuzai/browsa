// test/manifest-surface.test.mjs — manifest 面的静态钉（jsdom 拉不起扩展，
// 这类「缺一行静默坏功能」的契约只能靠源码钉住）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('WAR exposes _locales/*/messages.json — the in-app language override lifeline', () => {
  // 悬浮条/侧栏的应用内语言覆盖靠内容脚本 fetch _locales 字典；MV3 下没进
  // web_accessible_resources 的扩展资源对页面上下文一律封锁——缺这条 =
  // 语言覆盖静默回落浏览器语言（2026-10-01 复核实锤，已坏多版本无人察觉，
  // 因为 catch 兜底让功能「看起来还在」）。只暴露 messages.json 通配，
  // _locales 下其他内容一律不暴露。
  const war = (manifest.web_accessible_resources || []).flatMap((r) => r.resources || []);
  assert.ok(war.includes('_locales/*/messages.json'), 'wildcard must cover every locale dir');
  for (const r of war) {
    if (r.startsWith('_locales/')) {
      assert.equal(r, '_locales/*/messages.json', 'only messages.json files may be exposed under _locales');
    }
  }
});
