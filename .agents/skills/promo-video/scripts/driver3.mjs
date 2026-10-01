// browsa 宣传片 v3 驱动（Remotion 重制版）：素材层与 v2 同一套真机编排，
// 但合成职责上移——
//   · 字幕不再烧进 wrapper（__caption 全部改为 cap() 记入 timeline.json，Remotion 接管）
//   · 新增「面板加宽」运镜：panelZoom() 用 __layout 真重排加宽侧栏，关键瞬间看得清
//   · 砍掉冗余等待帧；片头/片尾卡由 Remotion 承担，S8 只留收尾板
// 分镜：S1 钩子 → S2 附页问答 → S3 追问卡 → S4 划词浮条 → S5 视频时间线
//       → S6 渲染蒙太奇 → S7 Agent 审批 → S8 收尾板
// 用法：node driver3.mjs            → 全部（全片必须一次连拍，帧号才连续）
//       node driver3.mjs s2 s4      → 只拍指定幕（timeline 不完整，仅供预览）
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const OUT = process.env.PROMO_FRAMES || join(tmpdir(), 'browsa-promo', 'frames');
const BASE = 'http://127.0.0.1:' + (process.env.PROMO_PORT || 8957);

// 浏览器解析：PROMO_CHROME 环境变量 → playwright 浏览器缓存 → 交给 playwright 自解析
function findChrome() {
  if (process.env.PROMO_CHROME) return process.env.PROMO_CHROME;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of readdirSync(cache).sort().reverse()) {
      if (!d.startsWith('chromium') || d.includes('headless_shell')) continue;
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(cache, d, sub);
        if (existsSync(p)) return p;
      }
    }
  } catch (_) { /* 无缓存目录 */ }
  return null;
}
const CHROME = findChrome();
const onlySet = new Set(process.argv.slice(2));
const only = (s) => !onlySet.size || onlySet.has(s);

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) unlinkSync(join(OUT, f));

// WebGL 旗标 2026-09-29 更新（Mol* 蛋白质镜头需要 WebGL2）：chromium-1234 起
// `--use-gl=swiftshader` 不再创建 WebGL context（实测 "Could not create a WebGL
// rendering context"），要 ANGLE+swiftshader 并显式允许软件 WebGL；且必须
// headless:false（配合 xvfb-run -a 跑），headless 下同样拿不到 context。
const launchOpts = {
  headless: false,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
if (CHROME) launchOpts.executablePath = CHROME;
const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.emulateMedia({ colorScheme: 'dark' });
page.on('pageerror', (e) => console.log('[pageerror]', String((e && e.stack) || e).slice(0, 500)));
const client = await ctx.newCDPSession(page);

let n = 0;
async function shot() {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'f' + String(n++).padStart(5, '0') + '.png'), Buffer.from(data, 'base64'));
}
const W = (fn, arg) => page.evaluate(fn, arg);
const PF = () => page.frames().find((f) => f.url().includes('sidepanel.preview'));
const PAGEF = () => page.frames().find((f) => f.url().includes('article.html'));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function frames(count, step) { for (let i = 0; i < count; i++) { if (step) await step(i, count); await shot(); } }

// ── v3 合成时间线（Remotion 消费）──────────────────────────────────────────
const CAPTIONS = []; // {start, dur, zh, en}：start=当前帧号，dur=持续帧数
const SCENES = [];   // {id, start}：幕边界（仅供 Remotion 调漂移锚点，转场已烧在板内）
const mark = (id) => SCENES.push({ id, start: n });
const cap = (zh, en, dur) => CAPTIONS.push({ start: n, dur, zh, en });

await page.goto(BASE + '/wrapper.html');
await page.waitForTimeout(600);

// ── 定位：面板/页面 iframe 内元素 → 页面坐标 ────────────────────────────────
async function framePoint(frameSel, iframeId, sel) {
  const [ix, iy] = await W((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y]; }, iframeId);
  const p = await frameSel().evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  }, sel);
  return [ix + p[0], iy + p[1]];
}
const panelPoint = (sel) => framePoint(PF, 'panelframe', sel);
const articlePoint = (sel) => framePoint(PAGEF, 'pageframe', sel);
// 浮条按钮在 closed shadow 里，经 __promoShadow（服务器注入暴露）取坐标
async function toolbarPoint(action) {
  const [ix, iy] = await W(() => { const r = document.getElementById('pageframe').getBoundingClientRect(); return [r.x, r.y]; });
  const p = await PAGEF().evaluate((a) => {
    const b = window.__promoShadow.querySelector('[data-action="' + a + '"]').getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  }, action);
  return [ix + p[0], iy + p[1]];
}

// ── 可编程端口投递（服务器注入的 __push）─────────────────────────────────────
const chatPush = (m) => PF().evaluate((mm) => { const p = window.__promoPorts && window.__promoPorts['browsa-chat']; if (p) p.__push(mm); }, m);
const subPush = (m) => PF().evaluate((mm) => { const p = window.__promoPorts && window.__promoPorts['browsa-subchat']; if (p) p.__push(mm); }, m);
const pinScroll = () => PF().evaluate(() => { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; });

// ── 场景加载 / 转场 ────────────────────────────────────────────────────────
async function loadScene({ scene, video, url }) {
  await W(() => {
    document.getElementById('pageframe').src = 'about:blank';
    document.getElementById('panelframe').src = 'about:blank';
  });
  await page.waitForTimeout(250);
  await W(([{ scene, video, url }]) => {
    document.getElementById('pageframe').src = '/article.html?v=' + (video ? 'video' : 'doc') + '&r=' + Math.random();
    document.getElementById('panelframe').src = '/repo/dev-preview/sidepanel.preview.html?scene=' + scene;
    window.__layout({ url });
  }, [{ scene, video, url }]);
  await page.waitForTimeout(2500);
  await PF().waitForSelector('#messages', { timeout: 10000 });
  await PF().evaluate(() => {
    if (document.getElementById('promo-font')) return;
    for (const w of ['400', '500', '700']) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = '/fonts/' + w + '.css';
      document.head.appendChild(l);
    }
    const st = document.createElement('style');
    st.textContent = "body { font-family: 'Noto Sans SC', sans-serif; }";
    document.head.appendChild(st);
  });
  await page.waitForTimeout(400);
}
async function initRender() {
  await PF().evaluate(async () => {
    window.__promoRender = await import(new URL('../lib/sidepanel/render.js', location.href).href);
  });
}
// 内容区淡入淡出转场：窗口框不动，只盖内容（观感 = 用户切了 tab）
async function swapWithFade(setup, each = 12) {
  await frames(each, async (i) => { await W((op) => window.__bodyFade(op), easeInOut((i + 1) / each)); });
  await W(() => window.__cursor(-100, -100));
  await setup();
  await frames(each, async (i) => { await W((op) => window.__bodyFade(op), 1 - easeInOut((i + 1) / each)); });
}
// 平滑滚动（覆盖 scrollTop 跳变）
async function smoothScroll(targetGetter, count, ease = easeInOut) {
  const from = await PF().evaluate(() => document.getElementById('messages').scrollTop);
  const to = await targetGetter();
  await frames(count, async (i) => {
    await PF().evaluate(([a, b, t]) => { document.getElementById('messages').scrollTop = a + (b - a) * t; }, [from, to, ease((i + 1) / count)]);
  });
}
// ── v3 运镜：面板加宽（真 DOM 重排，不是光栅放大）─────────────────────────────
// winbody 总宽恒为 1792，页面区让位给面板；panelX 归 0（S1 滑入完成后才可用）。
async function panelZoom(toPanel, count = 18) {
  const from = await W(() => document.getElementById('panelframe').getBoundingClientRect().width);
  await frames(count, async (i) => {
    const t = easeInOut((i + 1) / count);
    const pw = Math.round(from + (toPanel - from) * t);
    await W((p) => window.__layout({ page: 1792 - p, panel: p, panelX: 0 }), pw);
  });
}

// ── 文案 ──────────────────────────────────────────────────────────────────
const Q1 = '这篇在讲什么？用中文给我 3 个要点';
const A1 = [
  '这篇讲的是 **WebAssembly 线性内存**——模块与宿主共享的一块连续、可按字节寻址的空间。',
  '',
  '1. 内存以 **64KB 为一页**分配，地址从 0 开始连续编址',
  '2. `memory.grow()` 运行时扩容，但会让旧的 TypedArray 视图失效（detached）',
  '3. JS 与 WASM 共享同一块内存，大数据传递**零拷贝**',
  '',
  '文中建议：热路径尽量预先分配好内存，每次 `grow` 之后立刻重建视图。',
].join('\n');
const Q2 = '为什么会失效？怎么避免？';
const A2 = [
  '`grow()` 扩容时，引擎可能要**搬家**——重新分配一块更大的连续内存，把旧数据拷贝过去。旧的 `ArrayBuffer` 会被标记为 **detached**（`byteLength` 归零），挂在它上面的视图自然全部失效。',
  '',
  '避免办法只有一条：每次 `grow()` 之后，用 `mem.buffer` **重新创建**视图。',
].join('\n');
const EXPLAIN = [
  '**byte-addressable** 按字节寻址',
  '',
  '- 内存的最小寻址单位是**字节**：每个字节都有独立地址，可单独读写',
  '- 与之相对的「按字寻址」只能整块读写，改一个字节要读出整字、改完再写回',
  '- 所以线性内存里 `Uint8Array` 的每个下标，就是一个真实的字节地址',
].join('\n');
const Q3 = '把这篇文章里的代码示例整理保存成 markdown';
const A3 = [
  '已保存到 `~/notes/wasm-memory.md`：',
  '',
  '- 「Growing at runtime」的 `memory.grow` 示例',
  '- 「Sharing with JavaScript」的零拷贝说明',
  '- 文末的三条 takeaways',
  '',
  '文件按原文章节组织，代码块前保留了标题，方便回看。',
].join('\n');

// ════════ S1 钩子（72f）：文档页 + 面板滑入 ════════
if (only('s1')) {
  mark('s1');
  await loadScene({ scene: 's2', video: false, url: 'docs.example.dev/wasm/memory' });
  await initRender();
  await W(() => {
    window.__layout({ win: [64, 48, 1792, 896], page: 1790, panel: 448, panelX: 450 });
    window.__cursor(560, 520);
    window.__fade(1);
  });
  await frames(12, async (i) => {
    const t = easeOut(i / 11);
    await W((op) => window.__fade(1 - op), t);
  });
  await cap('网页看不懂？<span class="hl">别再复制粘贴</span>', "Can't make sense of the page? <span class=\"hl\">Stop copy-pasting</span>", 84);
  await frames(24, async (i) => {
    const t = easeInOut(i / 23);
    await W(([x, y]) => window.__cursor(x, y), [560 + t * 900, 520 - t * 200]);
  });
  await frames(24, async (i) => {
    const t = easeOut(i / 23);
    await W((p) => window.__layout({ page: 1790 - p * 447, panelX: 450 - p * 450 }), t);
  });
  await frames(12, async () => {});
}

// ════════ S2 附页问答：📎 真附加 → 运镜加宽 → 真发送 → 端口流式回答 ════════
if (only('s2')) {
  mark('s2');
  if (only('s1')) {
    // 承接 S1 布局
  } else {
    await loadScene({ scene: 's2', video: false, url: 'docs.example.dev/wasm/memory' });
    await initRender();
    await W(() => {
      window.__layout({ win: [64, 48, 1792, 896], page: 1343, panel: 448, panelX: 0 });
      window.__cursor(800, 500);
    });
  }
  const [ax, ay] = await panelPoint('#attach');
  await frames(20, async (i) => {
    const t = easeInOut(i / 19);
    await W(([x, y]) => window.__cursor(x, y), [800 + t * (ax - 800), 500 + t * (ay - 500)]);
  });
  cap('整页内容，<span class="hl">一键</span>进对话', 'The whole page, in the chat in <span class="hl">one click</span>', 78);
  const attachP = PF().click('#attach');
  await frames(18, async (i) => {
    await W(([x, y, ph]) => window.__ripple(x, y, ph), [ax, ay, i / 9]);
  });
  await attachP;
  // 附加芯片已亮 → 运镜：面板加宽到 640，后面整段问答都看得清
  await panelZoom(640, 16);
  const [ax2, ay2] = await panelPoint('#attach');
  await frames(36, async (i) => {
    const c = Math.ceil(((i + 1) / 36) * Q1.length);
    await PF().evaluate(([text]) => {
      const ta = document.getElementById('input');
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, [Q1.slice(0, c)]);
  });
  // 真发送：面板自己建用户气泡/占位气泡/开端口，STREAM_HELLO_ACK 由 shim 自动应答
  const [sx, sy] = await panelPoint('#send');
  await frames(12, async (i) => {
    const t = easeInOut(i / 11);
    await W(([x, y]) => window.__cursor(x, y), [ax2 + t * (sx - ax2), ay2 + t * (sy - ay2)]);
  });
  cap('<span class="hl">你自己的</span>密钥，你自己的回答', '<span class="hl">Your keys</span>, your answers', 112);
  await PF().click('#send');
  await page.waitForTimeout(260);
  await W(([x, y, ph]) => window.__ripple(x, y, ph), [sx, sy, 0.3]);
  await frames(6, async (i) => {
    await W(([x, y, ph]) => window.__ripple(x, y, ph), [sx, sy, 0.3 + i / 9]);
    await pinScroll();
  });
  await W(([x, y]) => window.__ripple(x, y, 1), [sx, sy]); // 涟漪走完归隐，不留半透明环
  // 逐帧投递 CHUNK 切片（真实 reveal-pacer 负责渐显）
  let prev = 0;
  await frames(72, async (i) => {
    const chars = Math.ceil(((i + 1) / 72) * A1.length);
    const d = A1.slice(prev, chars); prev = chars;
    if (d) await chatPush({ type: 'CHUNK', delta: d });
    await pinScroll();
  });
  await chatPush({ type: 'DONE', full: A1, usage: { prompt_tokens: 8123, completion_tokens: 356 }, providerLabel: 'My OpenAI · gpt-4o', providerKey: 'llm1' });
  await page.waitForTimeout(300);
  await frames(10, async () => { await pinScroll(); });
}

// ════════ S3 追问卡：选中答案里的短语 → 追问 → 真 SUBCHAT 流 ════════
if (only('s3')) {
  mark('s3');
  // 选中「TypedArray 视图失效」→ mouseup 触发追问 pill（真实监听）
  await PF().evaluate(() => {
    const msgs = document.getElementById('messages');
    const bubbles = msgs.querySelectorAll('.msg.assistant');
    const bubble = bubbles[bubbles.length - 1];
    const phrase = 'TypedArray 视图失效';
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    let node, hit = null;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf(phrase);
      if (i >= 0) { hit = { node, i }; break; }
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(hit.node, hit.i);
    r.setEnd(hit.node, hit.i + phrase.length);
    sel.addRange(r);
    msgs.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(120);
  // 24f：光标到 pill
  const [qx, qy] = await panelPoint('.selection-ask-btn');
  const [cx0, cy0] = await W(() => { const c = document.getElementById('cursor'); return [+c.style.left.replace('px', ''), +c.style.top.replace('px', '')]; });
  cap('哪句没懂，<span class="hl">选中</span>接着问', 'Didn\'t get a line? <span class="hl">Select it</span>, keep asking', 104);
  await frames(24, async (i) => {
    const t = easeInOut(i / 23);
    await W(([x, y]) => window.__cursor(x, y), [cx0 + t * (qx - cx0), cy0 + t * (qy - cy0)]);
  });
  // 真点击 pill（mousedown 触发 openDetailThread；down+up 必须贴死——
  // pill 在 mousedown 里自移除，按住不放会让 Chrome 把按压重定向到底下文本弄花选区）
  await page.mouse.move(qx, qy);
  await page.mouse.down();
  await page.mouse.up();
  await frames(4, async (i) => { await W(([x, y, ph]) => window.__ripple(x, y, ph), [qx, qy, i / 4]); });
  await W(([x, y]) => window.__ripple(x, y, 1), [qx, qy]);
  await page.waitForTimeout(150);
  await smoothScroll(async () => PF().evaluate(() => document.getElementById('messages').scrollHeight), 16);
  await frames(14, async () => {});
  // 36f：在卡里输入追问
  await frames(36, async (i) => {
    const c = Math.ceil(((i + 1) / 36) * Q2.length);
    await PF().evaluate(([text]) => {
      const inp = document.querySelector('.detail-thread-input');
      inp.value = text;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, [Q2.slice(0, c)]);
    await pinScroll();
  });
  // 真点击卡内发送 → SUBCHAT 端口流
  const [dx, dy] = await panelPoint('.detail-thread-send');
  await frames(10, async (i) => {
    const t = easeInOut(i / 9);
    await W(([x, y]) => window.__cursor(x, y), [qx + t * (dx - qx), qy + t * (dy - qy)]);
  });
  await PF().click('.detail-thread-send');
  await page.waitForTimeout(240);
  let prev2 = 0;
  await frames(72, async (i) => {
    const chars = Math.ceil(((i + 1) / 72) * A2.length);
    const d = A2.slice(prev2, chars); prev2 = chars;
    if (d) await subPush({ type: 'SUBCHAT_CHUNK', delta: d });
    await pinScroll();
  });
  await subPush({ type: 'SUBCHAT_DONE', providerLabel: 'My OpenAI · gpt-4o', usage: { prompt_tokens: 2310, completion_tokens: 96 } });
  await page.waitForTimeout(250);
  await frames(8, async () => { await pinScroll(); });
}

// ════════ S4 划词浮条：页面侧真内容脚本，拖选 → 解释就地作答 ════════
if (only('s4')) {
  mark('s4');
  // 运镜还原：面板收回 448，页面区回到全宽（划词发生在页面侧）
  await panelZoom(448, 16);
  // 24f：光标从面板移到页面目标短语
  const [wx, wy] = await articlePoint('[data-sel="byte"]');
  const [cx1, cy1] = await W(() => { const c = document.getElementById('cursor'); return [+c.style.left.replace('px', ''), +c.style.top.replace('px', '')]; });
  cap('划到哪，<span class="hl">讲到哪</span>：解释 · 翻译 · 总结', 'Select anything — <span class="hl">explained</span>, translated, summarized', 104);
  await frames(24, async (i) => {
    const t = easeInOut(i / 23);
    await W(([x, y]) => window.__cursor(x, y), [cx1 + t * (wx - cx1), cy1 + t * (wy - cy1)]);
  });
  // 20f：真拖选（原生选区高亮）
  const r = await PAGEF().evaluate(() => { const b = document.querySelector('[data-sel="byte"]').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
  const [ix, iy] = await W(() => { const b = document.getElementById('pageframe').getBoundingClientRect(); return [b.x, b.y]; });
  const x0 = ix + r[0] - 6, x1 = ix + r[0] + r[2] + 6, ym = iy + r[1] + r[3] / 2;
  await page.mouse.move(x0, ym);
  await page.mouse.down();
  await frames(20, async (i) => {
    const t = easeInOut((i + 1) / 20);
    await page.mouse.move(x0 + (x1 - x0) * t, ym);
    await W(([x, y]) => window.__cursor(x + 5, y + 5), [x0 + (x1 - x0) * t, ym]);
  });
  await page.mouse.up();
  await page.waitForTimeout(420); // 浮条 220ms 去抖 + 渲染
  await frames(14, async () => {});
  // 18f：光标到「解释」按钮 → 真点击（closed shadow，服务器注入了 __promoShadow）
  const [ex, ey] = await toolbarPoint('explain');
  await frames(18, async (i) => {
    const t = easeInOut(i / 17);
    await W(([x, y]) => window.__cursor(x, y), [x1 + t * (ex - x1), ym + t * (ey - ym)]);
  });
  await PAGEF().evaluate((t) => { window.__promoExplain = { text: t }; }, EXPLAIN);
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  await page.mouse.up(); // 同 S3：按钮点击即按即放，防按压重定向
  await frames(4, async (i) => { await W(([x, y, ph]) => window.__ripple(x, y, ph), [ex, ey, i / 4]); });
  await W(([x, y]) => window.__ripple(x, y, 1), [ex, ey]);
  await page.waitForTimeout(150);
  // 84f：解释卡逐帧流式（真浮条 popover）
  let prev3 = 0;
  await frames(84, async (i) => {
    const chars = Math.ceil(((i + 1) / 84) * EXPLAIN.length);
    const d = EXPLAIN.slice(prev3, chars); prev3 = chars;
    if (d) await PAGEF().evaluate((dd) => window.__promoExplainPort.push({ type: 'EXPLAIN_CHUNK', delta: dd }), d);
  });
  await PAGEF().evaluate(() => window.__promoExplainPort.push({ type: 'EXPLAIN_DONE' }));
  await frames(12, async () => {});
}

// ════════ 转场 → S5 视频时间线（运镜加宽看时间线行）════════
if (only('s5')) {
  mark('s5');
  await swapWithFade(async () => {
    await loadScene({ scene: 's3', video: true, url: 'bilibili.com/video/BV1preview' });
    await W(() => window.__layout({ win: [64, 48, 1792, 896], page: 1343, panel: 448, panelX: 0 }));
    await PF().evaluate(() => { document.getElementById('messages').scrollTop = 1e9; });
    await W(() => window.__cursor(760, 320));
  });
  const [tx, ty] = await panelPoint('#transcript-btn');
  await frames(20, async (i) => {
    const t = easeInOut(i / 19);
    await W(([x, y]) => window.__cursor(x, y), [760 + t * (tx - 760), 320 + t * (ty - 320)]);
  });
  cap('视频也能问：字幕 · 要点 · <span class="hl">时间线</span>', 'Videos too — subtitles, takeaways, <span class="hl">timeline</span>', 96);
  const openP = PF().click('#transcript-btn');
  await frames(24, async (i) => {
    await W(([x, y, ph]) => window.__ripple(x, y, ph), [tx, ty, i / 9]);
  });
  await openP;
  await PF().evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  // 运镜：面板加宽到 820，时间线行大字号可读
  await panelZoom(820, 20);
  for (const t of [84, 462, 1390]) {
    await PF().evaluate((v) => { window.__BROWSA_PREVIEW_SEED.__videoTime = v; }, t);
    await PAGEF().evaluate((frac) => window.__setProgress(frac), t / 2400);
    await page.waitForTimeout(700);
    await frames(36, async (i) => {
      const t2 = i / 35;
      await W(([x, y]) => window.__cursor(x, y), [tx - 60 + Math.sin(t2 * 3.1) * 24, ty + 180 + Math.cos(t2 * 2.3) * 30]);
    });
  }
  await PF().evaluate(() => { window.__BROWSA_PREVIEW_SEED.__videoTime = 1390; });
  await page.waitForTimeout(700);
  const [nx, ny] = await panelPoint('#transcript-note');
  const noteP = PF().click('#transcript-note');
  await frames(16, async (i) => {
    await W(([x, y]) => window.__cursor(x, y), [nx - i * 2, ny]);
    if (i === 2) await W(([x, y, ph]) => window.__ripple(x, y, ph), [nx, ny, 0.5]);
  });
  cap('<span class="hl">记下一笔</span>，回去接着问', '<span class="hl">Jot it down</span>, keep the thread going', 44);
  await noteP;
  await W(([x, y]) => window.__ripple(x, y, 1), [nx, ny]);
  await frames(6, async () => {});
}

// ════════ 转场 → S6 渲染蒙太奇（运镜：整段 940 宽面板）→ S7 Agent 审批 ════════
if (only('s6') || only('s7')) {
  if (!only('s5')) {
    await loadScene({ scene: 's4', video: false, url: 'docs.example.dev/wasm/memory' });
    await initRender();
    await W(() => {
      window.__layout({ win: [64, 48, 1792, 896], page: 1343, panel: 448, panelX: 0 });
      window.__cursor(-100, -100);
    });
  } else {
    await swapWithFade(async () => {
      await loadScene({ scene: 's4', video: false, url: 'docs.example.dev/wasm/memory' });
      await initRender();
      await W(() => {
        window.__layout({ win: [64, 48, 1792, 896], page: 1343, panel: 448, panelX: 0 });
        window.__cursor(-100, -100);
      });
    });
  }

  if (only('s6')) {
    mark('s6');
    cap('图表、公式、蛋白结构，<span class="hl">直接长在回复里</span>', 'Charts, math, protein structures — <span class="hl">rendered inline</span>', 132);
    // 运镜先行：面板 940 宽，mermaid/echarts/蛋白质全部在大画幅里渲染
    await panelZoom(940, 20);
    // 三个问答组按镜头顺序入列：mermaid → echarts → 蛋白质（蛋白质预渲染，慢，不占采帧）
    await PF().evaluate(async () => {
      const mod = window.__promoRender;
      const msgs = document.getElementById('messages');
      const pair = (q) => {
        const u = document.createElement('div');
        u.className = 'msg user';
        const s = document.createElement('span');
        s.className = 'msg-text';
        s.textContent = q;
        u.appendChild(s);
        msgs.appendChild(u);
        const a = document.createElement('div');
        a.className = 'msg assistant';
        a.style.width = '100%'; // 气泡是 fit-content，纯图表无文字会塌成 0 宽
        msgs.appendChild(a);
        return a;
      };
      window.__mmBubble = pair('把这个流程画成架构图');
      window.__echBubble = pair('看下上月各类任务的使用量');
      window.__pdbBubble = pair('EGFR 的 AlphaFold 预测结构长什么样？');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-pdb';
      code.textContent = 'AF-P00533-F1';
      pre.appendChild(code);
      window.__pdbBubble.appendChild(pre);
      window.__pdbBubble.classList.add('done');
      await mod.renderPdb(msgs);
      msgs.scrollTop = 0;
    });
    const pdbReady = await PF().evaluate(async () => {
      for (let i = 0; i < 240; i++) {
        if (document.querySelector('.pdb-block .pdb-legend')) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    });
    console.log('[s6] pdb ready:', pdbReady);

    const MERMAID = ['```mermaid', 'flowchart LR', '  A[当前网页] --> B[browsa 侧栏]', '  B --> C{你的模型 / Agent}', '  C -->|读页| D[结构化回答]', '  C -->|审批| E[工具调用]', '```'].join('\n');
    await PF().evaluate((full) => { window.__promoMermaid = full; }, MERMAID);
    await frames(48, async (i) => {
      const chars = Math.ceil(((i + 1) / 48) * MERMAID.length);
      await PF().evaluate((c) => {
        const msgs = document.getElementById('messages');
        window.__mmBubble.innerHTML = window.__promoRender.renderStreamingSafe(window.__promoMermaid.slice(0, c));
        msgs.scrollTop = 0;
      }, chars);
    });
    await PF().evaluate(async (full) => {
      const mod = window.__promoRender;
      window.__mmBubble.innerHTML = await mod.renderSafe(full);
      await mod.renderMermaid(window.__mmBubble);
      document.getElementById('messages').scrollTop = 0;
    }, MERMAID);
    await frames(24, async () => {});

    const ECHARTS_MD = ['```echarts', JSON.stringify({
      backgroundColor: 'transparent', textStyle: { color: '#c9d4e0' },
      grid: { left: 52, right: 24, top: 42, bottom: 36 },
      xAxis: { type: 'category', data: ['附页问答', '视频精读', 'PDF 精读', '划词解释'], axisLabel: { color: '#c9d4e0' }, axisLine: { lineStyle: { color: '#3a4654' } } },
      yAxis: { type: 'value', axisLabel: { color: '#8b97a5' }, splitLine: { lineStyle: { color: '#232c38' } } },
      series: [{ type: 'bar', barWidth: 44, data: [320, 214, 156, 98], itemStyle: { color: '#4c8dff', borderRadius: [7, 7, 0, 0] } }],
    }), '```'].join('\n');
    await PF().evaluate(async (md) => {
      const mod = window.__promoRender;
      window.__echBubble.innerHTML = await mod.renderSafe(md);
      await mod.renderEcharts(window.__echBubble);
    }, ECHARTS_MD);
    // 平滑滚动到 echarts 块
    await smoothScroll(async () => PF().evaluate(() => window.__echBubble.offsetTop - 16), 18);
    await frames(42, async () => {});

    // 平滑滚动到蛋白质块
    await smoothScroll(async () => PF().evaluate(() => window.__pdbBubble.offsetTop - 16), 18);
    await page.waitForTimeout(250);
    const [cx0b, cy0b] = await (async () => {
      const [ix2, iy2] = await W(() => { const r = document.getElementById('panelframe').getBoundingClientRect(); return [r.x, r.y]; });
      const p = await PF().evaluate(() => { const c = document.querySelector('.pdb-viewer canvas').getBoundingClientRect(); return [c.x + c.width / 2, c.y + c.height / 2]; });
      return [ix2 + p[0], iy2 + p[1]];
    })();
    await page.mouse.move(cx0b, cy0b);
    await frames(10, async (i) => {
      await W(([x, y]) => window.__cursor(x, y), [cx0b - 260 + i * 26, cy0b - 160 + i * 16]);
    });
    await page.mouse.down();
    await frames(52, async (i) => {
      const dx = 7, dy = Math.sin(i / 6) * 3;
      await page.mouse.move(cx0b + dx * (i + 1), cy0b + dy);
      await W(([x, y]) => window.__cursor(x, y), [cx0b + dx * (i + 1) + 4, cy0b + dy + 4]);
    });
    await page.mouse.up();
    await frames(22, async () => {});
  }

  // ══════ S7 Agent 审批：真发送 → TOOL_PROGRESS → 审批卡（运镜加宽）→ 允许 → 流式 ══════
  if (only('s7')) {
    mark('s7');
    // 运镜：面板从 940 收回到 820（输入态稍收，审批卡仍然大画幅）
    await panelZoom(820, 16);
    // 36f：输入任务（光标原地休息，不打扰输入）
    await frames(36, async (i) => {
      const c = Math.ceil(((i + 1) / 36) * Q3.length);
      await PF().evaluate(([text]) => {
        const ta = document.getElementById('input');
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, [Q3.slice(0, c)]);
    });
    cap('Agent 动手前，<span class="hl">先过你这一关</span>', 'Your agent acts only <span class="hl">after you approve</span>', 158);
    const [sx2, sy2] = await panelPoint('#send');
    const [pcx, pcy] = await W(() => { const c = document.getElementById('cursor'); const x = parseFloat(c.style.left) || 0; const y = parseFloat(c.style.top) || 0; return [x < 0 ? 1500 : x, y < 0 ? 940 : y]; });
    await frames(12, async (i) => {
      const t = easeInOut(i / 11);
      await W(([x, y]) => window.__cursor(x, y), [pcx + t * (sx2 - pcx), pcy + t * (sy2 - pcy)]);
    });
    await PF().click('#send');
    await page.waitForTimeout(260);
    await W(([x, y, ph]) => window.__ripple(x, y, ph), [sx2, sy2, 0.3]);
    await frames(6, async (i) => {
      await W(([x, y, ph]) => window.__ripple(x, y, ph), [sx2, sy2, 0.3 + i / 9]);
      await pinScroll();
    });
    await W(([x, y]) => window.__ripple(x, y, 1), [sx2, sy2]);
    // 工具过程 ×3（真 TOOL_PROGRESS 行）
    const tools = [
      '读取页面：Understanding WebAssembly Memory',
      '提取代码块：3 处（grow 示例 / 零拷贝 / takeaways）',
      '准备写入 ~/notes/wasm-memory.md',
    ];
    for (const t of tools) {
      await chatPush({ type: 'TOOL_PROGRESS', text: t });
      await page.waitForTimeout(80);
      await frames(20, async () => { await pinScroll(); });
    }
    // 审批卡（真 APPROVAL 卡 + 真按钮）
    await chatPush({ type: 'APPROVAL', data: {
      tool: 'write_file',
      command: 'write ~/notes/wasm-memory.md',
      description: '新建文件并写入整理后的代码示例（3 个代码块 + 章节标题）',
      risk_level: 'medium',
      choices: ['once', 'deny'],
    } });
    await page.waitForTimeout(150);
    await frames(24, async () => { await pinScroll(); });
    // 光标 → 允许一次 → 真点击（APPROVAL_RESPOND 已在 shim 打通，卡片自移除）
    const [ax3, ay3] = await panelPoint('.approval-btn-allow');
    const [acx0, acy0] = await W(() => { const c = document.getElementById('cursor'); return [parseFloat(c.style.left) || 0, parseFloat(c.style.top) || 0]; });
    const acx = acx0 < 0 ? sx2 : acx0, acy = acy0 < 0 ? sy2 : acy0;
    await frames(14, async (i) => {
      const t = easeInOut(i / 13);
      await W(([x, y]) => window.__cursor(x, y), [acx + t * (ax3 - acx), acy + t * (ay3 - acy)]);
    });
    await PF().click('.approval-btn-allow');
    await page.waitForTimeout(150);
    await frames(6, async () => { await pinScroll(); });
    // 流式回答 → DONE（工具步数折叠 + 用量芯片都是真实 DONE 处理）
    let prev4 = 0;
    await frames(72, async (i) => {
      const chars = Math.ceil(((i + 1) / 72) * A3.length);
      const d = A3.slice(prev4, chars); prev4 = chars;
      if (d) await chatPush({ type: 'CHUNK', delta: d });
      await pinScroll();
    });
    await chatPush({ type: 'DONE', full: A3, usage: { prompt_tokens: 5230, completion_tokens: 2100 }, providerLabel: 'Agent Bridge · codex', providerKey: 'bridge' });
    await page.waitForTimeout(300);
    await frames(16, async () => { await pinScroll(); });
  }
}

// ════════ S8 收尾板（24f；片尾卡由 Remotion 承担）════════
if (only('s8')) {
  mark('s8');
  await W(() => {
    window.__cursor(-100, -100);
  });
  await frames(24, async () => {});
}

// ── 写合成时间线 ────────────────────────────────────────────────────────────
writeFileSync(join(OUT, '..', 'timeline.json'), JSON.stringify({
  fps: 24, width: 1920, height: 1080, totalFrames: n,
  captions: CAPTIONS, scenes: SCENES,
}, null, 1));
console.log('[driver3] done, frames =', n, '| captions =', CAPTIONS.length, '| scenes =', SCENES.length);
await browser.close();
