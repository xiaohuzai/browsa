// test/lib-feishu-extractor.test.mjs — feishu document extraction.
//
// Feishu renders docs as slate-style blocks with `data-block-type` /
// `data-string` leaves and virtual scrolling. We run the in-page extractor
// body against a JSDOM fixture (no scroll container in jsdom, so extraction
// runs in direct mode) and assert the block model renders to clean Markdown
// with tables preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FIXTURE = `<!DOCTYPE html>
<html><head><title>R7资源需求</title></head><body>
<div class="bear-web-x-container">
  <div data-slate-editor="true" contenteditable="true" data-block-type="text" data-block-id="1" data-record-id="r1">
    <p><span data-string="true" data-leaf="true">R6期间，针对日本出现频繁的E2E-Path相关问题（排队车误避让、路口拐大、弯道不合理变道等）和红绿灯感知问题，日本团队基于主线R620的EBM模型，进行了一系列的FCT实验，在日本成功准出R6；</span></p>
  </div>
  <div data-slate-editor="true" contenteditable="true" data-block-type="text" data-block-id="2" data-record-id="r2">
    <p><span data-string="true" data-leaf="true">R7在训DLP上资源需求陡升（见下表）。</span></p>
  </div>
  <table data-block-type="table" data-block-id="3">
    <tbody>
      <tr data-index="0">
        <td data-block-type="table_cell" data-block-id="10"><div data-zone-id="109" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="109"><p><span data-string="true" data-leaf="true">版本</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="11"><div data-zone-id="108" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="108"><p><span data-string="true" data-leaf="true">FT方式</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="12"><div data-zone-id="96" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="96"><p><span data-string="true" data-leaf="true">所需要机器数量</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="14"><div data-zone-id="98" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="98"><p><span data-string="true" data-leaf="true">8650量化</span></p></div></td>
      </tr>
      <tr data-index="1">
        <td data-block-type="table_cell" data-block-id="15"><div data-zone-id="106" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="106"><p><span data-string="true" data-leaf="true">R6 </span><span data-string="true">EBM</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="16"><div data-zone-id="110" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="110"><p><span data-string="true">FCT</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="17"><div data-zone-id="104" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="104"><p><span data-string="true" data-leaf="true">8机</span><span data-string="true" data-leaf="true">8卡4090_baidu_bj_fct</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="19"><div data-zone-id="99" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="99"><p><span data-string="true">浮点模型dump数据量 71729个bag，medium优先级需要3500 quota</span></p></div></td>
      </tr>
      <tr data-index="2">
        <td data-block-type="table_cell" data-block-id="20"><div data-zone-id="95" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="95"><p><span data-string="true">R7 </span><span data-string="true">EBM</span></p></div></td>
        <td data-block-type="table_cell" data-block-id="21"><div><div data-zone-id="92" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="92"><p><span data-string="true">Post_Train：</span></p></div><div data-zone-id="93" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="93"><p><span data-string="true">SFT</span><span data-string="true">+</span><span data-string="true">RL</span></p></div></div></td>
        <td data-block-type="table_cell" data-block-id="22"><div><div data-zone-id="100" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="100"><p><span data-string="true">SFT: 32机8卡 4090</span></p></div><div data-zone-id="101" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="101"><p><span data-string="true">RL：16机8卡4090</span></p></div></div></td>
        <td data-block-type="table_cell" data-block-id="24"><div><div data-zone-id="102" data-zone-container="*" data-slate-editor="true" data-block-type="text" data-block-id="102"><p><span data-string="true">浮点模型dump数据量101529个bag，medium优先级需要5000 quota</span></p></div></div></td>
      </tr>
    </tbody>
  </table>
  <div data-slate-editor="true" contenteditable="true" data-block-type="heading1" data-block-id="25" data-record-id="h1"><p><span data-string="true" data-leaf="true">主要分两点需求</span></p></div>
  <div data-slate-editor="true" contenteditable="true" data-block-type="bullet" data-block-id="26" data-record-id="b1"><p><span data-string="true" data-leaf="true">R7下，JP/EU在共有FST上进行海外合训</span></p></div>
  <div data-slate-editor="true" contenteditable="true" data-block-type="bullet" data-block-id="27" data-record-id="b2"><p><span data-string="true" data-leaf="true">R7下，8650量化需要较多quota资源支持</span></p></div>
  <div data-slate-editor="true" contenteditable="true" data-block-type="code" data-block-id="28" data-record-id="c1"><p><span data-string="true" data-leaf="true">def train(): pass</span></p></div>
  <div data-slate-editor="true" contenteditable="true" data-block-type="quote" data-block-id="29" data-record-id="q1"><p><span data-string="true" data-leaf="true">海外是否有共性FST？根据经验是有的。</span></p></div>
  <div data-slate-editor="true" contenteditable="true" data-block-type="text" data-block-id="30" data-record-id="r6"><p><span data-string="true" data-leaf="true">需求</span></p></div>
</div>
<div class="app-chrome"><nav>导航</nav><aside>侧边栏</aside></div>
</body></html>`;

async function loadFn(name) {
  const src = await readFile(join(ROOT, 'lib/feishu-extractor.js'), 'utf8');
  const m = src.match(new RegExp(`(?:async\\s+)?function ${name}\\s*\\([^)]*\\)`));
  if (!m) throw new Error(`${name} not found`);
  const headerEnd = m.index + m[0].length;
  let i = headerEnd;
  while (i < src.length && /\s/.test(src[i])) i++;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

function runExtractor(html) {
  const jsdom = new JSDOM(html);
  const sandbox = {
    document: jsdom.window.document,
    window: jsdom.window,
    console,
    setTimeout
  };
  const ctx = vm.createContext(sandbox);
  return loadFn('extractFeishuInPageWorld').then((body) => {
    vm.runInContext(body + '\n;globalThis.__feishu = extractFeishuInPageWorld({ htmlCap: 1000000 });', ctx);
    return vm.runInContext('globalThis.__feishu', ctx);
  });
}

test('isFeishuDocUrl matches feishu/lark doc and wiki URLs only', async () => {
  const { isFeishuDocUrl } = await import(join(ROOT, 'lib/feishu-extractor.js'));
  assert.ok(isFeishuDocUrl('https://example.feishu.cn/docx/AbC123'));
  assert.ok(isFeishuDocUrl('https://example.feishu.cn/wiki/Wik123'));
  assert.ok(isFeishuDocUrl('https://example.larksuite.com/docx/AbC123'));
  assert.ok(isFeishuDocUrl('https://feishu.cn/docx/AbC123'));
  assert.ok(!isFeishuDocUrl('https://example.com/docx/AbC123'));
  assert.ok(!isFeishuDocUrl('https://example.feishu.cn/calendar/'));
  assert.ok(!isFeishuDocUrl('https://example.feishu.cn/'));
  assert.ok(!isFeishuDocUrl('not a url'));
});

test('extractFeishuInPageWorld renders blocks to clean markdown with tables preserved', async () => {
  const out = await runExtractor(FIXTURE);
  assert.ok(!out.error, out.error);
  const t = out.text;

  // No raw HTML leak (the original "乱码" symptom).
  assert.ok(!/<table|<td|<div data-|<span data-/.test(t), 'must not leak raw HTML tags');

  // Paragraph text present.
  assert.ok(t.includes('R6期间，针对日本出现频繁的E2E-Path相关问题'), 'paragraph text should be present');
  assert.ok(t.includes('R7在训DLP上资源需求陡升'), 'second paragraph should be present');

  // Heading rendered as ATX heading.
  assert.ok(t.includes('# 主要分两点需求'), 'heading1 should render as # heading');

  // Bullets.
  assert.ok(t.includes('- R7下，JP/EU在共有FST上进行海外合训'), 'bullet should render');
  assert.ok(t.includes('- R7下，8650量化需要较多quota资源支持'), 'second bullet should render');

  // Code block fenced.
  assert.ok(t.includes('```') && t.includes('def train(): pass'), 'code should be fenced');

  // Quote.
  assert.ok(t.includes('> 海外是否有共性FST？根据经验是有的。'), 'quote should render');

  // Table: header + separator + data rows.
  assert.ok(t.includes('| 版本 | FT方式 | 所需要机器数量 | 8650量化 |'), 'table header row');
  assert.ok(t.includes('| --- | --- | --- | --- |'), 'table separator row');
  assert.ok(t.includes('| R6 EBM | FCT | 8机8卡4090_baidu_bj_fct | 浮点模型dump数据量 71729个bag，medium优先级需要3500 quota |'), 'table data row 1');
  // Multi-zone cell preserved (both zones).
  assert.ok(t.includes('| R7 EBM | Post_Train：<br>SFT+RL | SFT: 32机8卡 4090<br>RL：16机8卡4090 | 浮点模型dump数据量101529个bag，medium优先级需要5000 quota |'), 'table data row 2 with multi-zone cells');

  assert.ok(out.feishuBlocks === 9, `should count top-level blocks (got ${out.feishuBlocks})`);
  assert.ok(out.feishuVia === 'direct', 'no scroll container in jsdom -> direct');
});

test('extractFeishuInPageWorld skips table-cell blocks as top-level blocks (no duplication)', async () => {
  const out = await runExtractor(FIXTURE);
  // Cell text must appear exactly inside the table, not duplicated as loose lines.
  const occurrences = (out.text.match(/版本/g) || []).length;
  assert.equal(occurrences, 1, 'cell text should appear once');
});

test('extractFeishuInPageWorld fails open on a non-feishu page', async () => {
  const plain = '<html><body><p>Hello world</p></body></html>';
  const out = await runExtractor(plain);
  assert.ok(out.error, 'should return an error for pages without feishu blocks');
});

test('extractFeishuInPageWorld handles the classic .docx-* renderer (nested lists, th headers)', async () => {
  const html = `<html><head><title>Classic</title></head><body>
<div class="docx-container">
  <div class="block docx-text-block"><p>第一段文字</p></div>
  <div class="docx-list-block">
    <div class="docx-bullet-block"><p>列表项一</p></div>
    <div class="docx-bullet-block"><p>列表项二</p></div>
  </div>
  <div class="block docx-heading1"><p>经典标题</p></div>
  <table class="docx-table-block"><tbody>
    <tr><th>列A</th><th>列B</th></tr>
    <tr><td>a1</td><td>b1</td></tr>
  </tbody></table>
</div>
</body></html>`;
  const out = await runExtractor(html);
  assert.ok(!out.error, out.error);
  const t = out.text;
  assert.ok(t.includes('第一段文字'), 'docx-text-block should render');
  assert.ok(t.includes('- 列表项一') && t.includes('- 列表项二'), 'nested bullets should render as separate items');
  assert.ok(!t.includes('列表项一 列表项二'), 'bullets must not be flattened into one line');
  assert.ok(t.includes('# 经典标题'), 'docx-heading1 should render as ATX heading');
  assert.ok(t.includes('| 列A | 列B |'), 'th header row');
  assert.ok(t.includes('| --- | --- |'), 'separator');
  assert.ok(t.includes('| a1 | b1 |'), 'data row');
});
