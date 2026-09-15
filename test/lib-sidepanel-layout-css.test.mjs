import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = (await readFile(new URL('../sidepanel.css', import.meta.url), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('sidepanel empty state has one centered browsa watermark rule', () => {
  const rules = [...css.matchAll(/\.messages:not\(:has\(\.msg\)\)::before\s*\{([^}]*)\}/g)];
  assert.equal(rules.length, 1, 'watermark styles must not be overwritten by a later rule');
  assert.match(rules[0][1], /content:\s*'browsa'/);
  assert.match(rules[0][1], /text-align:\s*center/);
  assert.doesNotMatch(rules[0][1], /position:\s*absolute/);
  const container = css.match(/\.messages:not\(:has\(\.msg\)\)\s*\{([^}]*)\}/);
  assert.ok(container);
  assert.match(container[1], /align-items:\s*center/);
  assert.match(container[1], /justify-content:\s*center/);
});

test('sidepanel provider stretches without a fixed width cap and tools stay right aligned', () => {
  const rules = [...css.matchAll(/\.provider\s*\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  assert.ok(rules.some((rule) => /flex:\s*1\s*;/.test(rule[1])));
  assert.ok(rules.some((rule) => /min-width:\s*0\s*;/.test(rule[1])));
  for (const rule of rules) {
    assert.doesNotMatch(rule[1], /max-width:\s*\d/, 'fixed caps leave unused header space');
  }
  const divider = css.match(/\.topbar::after\s*\{([^}]*)\}/);
  assert.ok(divider);
  assert.match(divider[1], /margin-left:\s*auto/);
});
