// dev-preview/visual-check.mjs — browser-level visual gate for the side panel.
//
// WHY THIS EXISTS (2026-10-20)
// The 1937-case unit suite could not see a whole class of defect: a CSS rule
// that DEFEATS an attribute's semantics. Concretely, `display: flex` added to
// `.scroll-to-bottom-btn` silently overrode the UA stylesheet's
// `[hidden] { display: none }`, so the "jump to latest" button was visible in
// the empty state — with nothing to scroll to. The 1937 tests stayed green;
// a SCREENSHOT caught it.
//
// jsdom cannot catch it either: it models the `hidden` attribute as an
// unconditional hide, so `hidden` + an author `display: flex` rule still
// reports `display: none` there — the exact opposite of a real browser.
// Only a real engine models the cascade correctly.
//
// So the invariants that a screenshot found are encoded HERE, as assertions
// against a real Chromium. Everything below is a defect this file has
// already caught or a hierarchy rule this file must not let regress.
//
// Usage:
//   node dev-preview/visual-check.mjs            # dark + light
//   node dev-preview/visual-check.mjs dark      # one scheme
//   node dev-preview/visual-check.mjs --shots    # also write PNGs to /tmp
//
// Exit code: 0 = all checks pass (or the browser is unavailable → SKIP, loud),
// 1 = at least one check failed.
//
// playwright-core is NOT a repo dependency (same probe list as
// dev-preview/banners/render.mjs). Without a browser this SKIPS rather than
// fails — a missing browser must not break someone's checkout — but it says
// so on stderr, loudly.
//
// NOTE ON THE CHECK BODIES: they run inside the page, so each one is
// self-contained — page.evaluate() serializes the function source, it cannot
// close over helpers from this module. The tiny colour parser is therefore
// repeated where needed; it must understand BOTH forms Chrome serializes:
// `rgb(52, 58, 74)` (0-255) and `color(srgb 0.406 0.258 0.255)` (0-1, what
// color-mix() results become).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8948;

// ── browser discovery (mirrors dev-preview/banners/render.mjs) ──────────────
let chromium = null;
for (const c of [
  path.join(root, '.agents/skills/promo-video/scripts/node_modules/playwright-core/index.mjs'),
  '/tmp/pw/node_modules/playwright-core/index.mjs',
  '/tmp/pwshot/node_modules/playwright-core/index.mjs',
]) {
  try { ({ chromium } = await import(c)); break; } catch { /* next */ }
}
const pwCaches = [
  path.join(process.env.HOME || '/root', '.cache/ms-playwright'),
  '/root/.cache/ms-playwright',
];
const exe = process.env.BROWSA_CHROMIUM
  || pwCaches
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((x) => /^chromium-\d+$/.test(x)).map((x) => path.join(d, x, 'chrome-linux64/chrome')))
    .sort()
    .reverse()
    .find((p) => fs.existsSync(p));

if (!chromium || !exe) {
  console.error('[visual-check] SKIPPED — no Chromium available.');
  console.error('  playwright-core: ' + (chromium ? 'found' : 'not found'));
  console.error('  chromium binary: ' + (exe || 'not found'));
  console.error('  Install: npm i -D playwright-core && npx playwright install chromium');
  process.exit(0);
}

// ── static server (node http, no deps) ─────────────────────────────────────
// Content-Type matters: Chrome applies strict MIME checking to ES modules, so
// a `.js` served without `text/javascript` is REFUSED — the side panel's
// whole module graph then never runs and the panel renders empty. (The
// banners' render.mjs gets away without it: it only loads HTML + CSS.)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const PREVIEW = `http://127.0.0.1:${PORT}/dev-preview/sidepanel.preview.html`;

// ── the checks ──────────────────────────────────────────────────────────────
// Each check runs inside the page and returns { ok, detail }.
// They assert OUTCOMES (geometry, computed style), never CSS text — a
// regex pin on a stylesheet cannot tell a working rule from one that
// silently breaks the UI, which is exactly the failure this file exists for.
const CHECKS = [
  {
    name: 'hidden 属性压得住任何 display 规则',
    // The regression that started this file: `.scroll-to-bottom-btn` gained
    // `display: flex`, which overrode the UA's `[hidden]{display:none}`.
    run: () => {
      const leaks = [];
      for (const el of document.querySelectorAll('[hidden]')) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.width > 0) {
          leaks.push(`${el.tagName}#${el.id || '(no id)'}.${(el.className || '').toString().split(' ')[0]}`);
        }
      }
      return { ok: leaks.length === 0, detail: leaks.length ? `仍然可见: ${leaks.join(', ')}` : '所有 [hidden] 元素都不可见' };
    },
  },
  {
    name: '大纲侧栏的刻度不压在正文上',
    // The first real bug of the 2026-10-20 pass: the rail's ticks drew over
    // the last glyph of every line at narrow widths.
    run: () => {
      const ticks = [...document.querySelectorAll('.outline-rail .tick')].map((t) => t.getBoundingClientRect());
      const texts = [];
      const w = document.createTreeWalker(document.getElementById('messages'), NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        const b = r.getBoundingClientRect();
        if (!(b.width > 0 && b.height > 0)) continue;
        // A text range's geometry ignores ancestor clipping — the Mol*
        // sequence strip's position numbers report a rect that runs past the
        // strip's overflow:hidden edge even though nothing is painted there.
        // Clip to the nearest clipping ancestor so the test asks about what
        // the user can actually SEE.
        let clip = null;
        for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { clip = p.getBoundingClientRect(); break; }
        }
        if (clip) {
          const left = Math.max(b.left, clip.left);
          const right = Math.min(b.right, clip.right);
          const top = Math.max(b.top, clip.top);
          const bottom = Math.min(b.bottom, clip.bottom);
          if (!(right > left && bottom > top)) continue;
          texts.push({ left, right, top, bottom });
        } else {
          texts.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
        }
      }
      let hits = 0;
      for (const t of ticks) for (const b of texts) {
        if (t.left < b.right && b.left < t.right && t.top < b.bottom && b.top < t.bottom) hits++;
      }
      return { ok: hits === 0, detail: hits === 0 ? `${ticks.length} 个刻度与 ${texts.length} 段文字零重叠` : `${hits} 处重叠` };
    },
  },
  {
    name: '快捷操作条没有被拉满（抱住自己的药丸）',
    // "Not stretched" is the real invariant — NOT "narrower than the panel":
    // at 320px the five pills genuinely need 286px, and that is correct.
    // What was wrong was the box being STRETCHED to the panel width with 45%
    // of it empty (offsetWidth >> scrollWidth).
    run: () => {
      const q = document.querySelector('.quickbar');
      if (!q) return { ok: false, detail: '找不到 .quickbar' };
      const slack = q.offsetWidth - q.scrollWidth;
      return {
        ok: slack <= 2,
        detail: `盒子 ${q.offsetWidth}px / 内容 ${q.scrollWidth}px（多出 ${Math.round(slack)}px）`,
      };
    },
  },
  {
    name: '大纲侧栏刻度不伸出面板右缘',
    // At 320px the narrow-width rule used to shrink the message padding while
    // the rail kept assuming the old gutter — the ticks hung 8px OUTSIDE the
    // panel and across the last word of the line.
    run: () => {
      const strip = document.querySelector('.outline-rail-strip');
      if (!strip) return { ok: true, detail: '本次没有大纲侧栏（跳过）' };
      const r = strip.getBoundingClientRect();
      const panel = document.body.getBoundingClientRect().right;
      const over = Math.round(r.right - panel);
      return { ok: over <= 0, detail: `刻度条右缘 ${Math.round(r.right)} / 面板右缘 ${Math.round(panel)}（超出 ${over}px）` };
    },
  },
  {
    name: '顶栏模型选择器是幽灵控件（静止时无边框无底色）',
    run: () => {
      const p = document.getElementById('provider');
      if (!p) return { ok: false, detail: '找不到 #provider' };
      const cs = getComputedStyle(p);
      const transparent = (v) => v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
      const ok = transparent(cs.backgroundColor) && transparent(cs.borderTopColor);
      return { ok, detail: `background=${cs.backgroundColor} border=${cs.borderTopColor}` };
    },
  },
  {
    name: '输入框聚焦时不是满饱和 accent 描边',
    // The composer was the loudest thing on screen; it now keeps a muted
    // border and lets a soft halo carry the focus state.
    run: () => {
      const box = document.querySelector('.composer-box');
      if (!box) return { ok: false, detail: '找不到 .composer-box' };
      const rgb = (css) => {
        let m = css.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
        if (m) return [parseFloat(m[1]) / 255, parseFloat(m[2]) / 255, parseFloat(m[3]) / 255];
        m = css.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
        return null;
      };
      const cs = getComputedStyle(box);
      const c = rgb(cs.borderTopColor);
      if (!c) return { ok: false, detail: `无法解析边框色 ${cs.borderTopColor}` };
      const root = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const accent = rgb(root) || [0.878, 0.329, 0.173];
      // The pure accent is rgb(224,84,44) dark / rgb(194,65,12) light. A
      // muted mix sits at a real distance from it; a saturated accent border
      // sits at zero.
      const d = Math.hypot(c[0] - accent[0], c[1] - accent[1], c[2] - accent[2]);
      return { ok: d > 0.12, detail: `border=${cs.borderTopColor} 与 accent 距离=${d.toFixed(3)}（需 > 0.12）` };
    },
  },
  {
    name: '化学结构图的墨迹填满画布（没有被塞进空画布）',
    // RDKit centres a drawing and never fills the canvas; the reaction used
    // to sit in a 389×280 box with ~190px of dead space above and below.
    // The invariant is the INK's share of the viewBox, not the pixel height —
    // a genuinely tall molecule is fine, an empty canvas is not.
    run: () => {
      const svgs = [...document.querySelectorAll('svg.smiles-svg')];
      if (!svgs.length) return { ok: true, detail: '本次没有 smiles 图（跳过）' };
      const bad = [];
      for (const s of svgs) {
        const vb = s.viewBox && s.viewBox.baseVal;
        if (!vb || !(vb.width > 0) || !(vb.height > 0)) continue;
        let ink = null;
        for (const c of s.children) {
          if (String(c.tagName).toLowerCase() === 'rect') continue;  // background, not ink
          let b; try { b = c.getBBox(); } catch { continue; }
          if (!b || !(b.width > 0) || !(b.height > 0)) continue;
          ink = ink
            ? { x: Math.min(ink.x, b.x), y: Math.min(ink.y, b.y), r: Math.max(ink.r, b.x + b.width), bt: Math.max(ink.bt, b.y + b.height) }
            : { x: b.x, y: b.y, r: b.x + b.width, bt: b.y + b.height };
        }
        if (!ink) continue;
        const fill = ((ink.r - ink.x) * (ink.bt - ink.y)) / (vb.width * vb.height);
        if (fill < 0.5) bad.push(`墨迹只占画布 ${(fill * 100).toFixed(0)}%`);
      }
      return { ok: !bad.length, detail: bad.length ? bad.join('; ') : `${svgs.length} 张图的墨迹都填满了画布` };
    },
  },
  {
    name: 'Mol* 嵌入界面与面板底色同族',
    // molstar.css hard-codes a light palette; in the dark panel that was a
    // whiteboard pasted over an ink-slate surface. The invariant is not
    // "dark" — it is "same family as the panel ground", which also holds
    // for the light theme.
    run: () => {
      const v = document.querySelector('.pdb-viewer');
      if (!v) return { ok: true, detail: '本次没有 3D 视图（跳过）' };
      const rgb = (css) => {
        let m = css.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
        if (m) {
          const a = css.match(/^rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,]+([\d.]+)/);
          if (a && parseFloat(a[1]) === 0) return null;
          return [parseFloat(m[1]) / 255, parseFloat(m[2]) / 255, parseFloat(m[3]) / 255];
        }
        m = css.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
        // a raw token value (#0d0f14) — the design tokens are read as-is
        m = css.match(/^#([0-9a-f]{6})$/i);
        if (m) {
          const h = m[1];
          return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
        }
        return null;
      };
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const ground = rgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
      if (!ground) return { ok: false, detail: '无法解析面板底色' };
      const gl = lum(ground);
      const out = [];
      for (const el of v.querySelectorAll('*')) {
        const bg = getComputedStyle(el).backgroundColor;
        const c = rgb(bg);
        if (!c) continue;
        const rct = el.getBoundingClientRect();
        if (rct.width < 20 || rct.height < 20) continue;
        if (Math.abs(lum(c) - gl) > 0.22) {
          out.push(`${(el.className || '').toString().split(' ')[0]}=${bg}`);
        }
      }
      return { ok: !out.length, detail: out.length ? `与底色差太远: ${out.slice(0, 4).join(', ')}` : '嵌入 chrome 与面板底色同族' };
    },
  },
  {
    name: '打开长对话时落在最新一条（不是历史中间）',
    // The live renderers (mermaid / KaTeX / RDKit / Mol*) resolve AFTER the
    // initial scroll, so the bottom used to be pushed ~900px out of view
    // exactly when the conversation contained a diagram.
    run: () => {
      const m = document.getElementById('messages');
      const dist = m.scrollHeight - m.scrollTop - m.clientHeight;
      const b = document.querySelector('.scroll-to-bottom-btn');
      return {
        ok: dist <= 4 && b && b.hidden,
        detail: `离底部 ${Math.round(dist)}px，跳到最新按钮${b && b.hidden ? '已隐藏' : '仍显示'}`,
      };
    },
  },
  {
    name: '用户上滚后，内容迟到不会把视口拽回底部',
    // The intent must survive late content: a user reading older messages
    // must not be yanked back to the bottom by a diagram that lands later.
    run: async () => {
      const m = document.getElementById('messages');
      // 1. the user scrolls up to read older messages
      m.scrollTop -= 600;
      await new Promise((r) => setTimeout(r, 80));   // let the scroll handler update the intent
      const before = m.scrollTop;
      // 2. a late block lands (what a diagram's SVG does)
      const probe = document.createElement('div');
      probe.style.height = '400px';
      probe.style.flex = 'none';
      probe.textContent = 'late block';
      m.appendChild(probe);
      // 3. give the MutationObserver a chance to (wrongly) re-anchor
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const after = m.scrollTop;
      probe.remove();
      return {
        ok: Math.abs(after - before) <= 2,
        detail: `上滚到 scrollTop=${Math.round(before)}，插入 400px 后=${Math.round(after)}`,
      };
    },
  },
  {
    name: '多选模式的复选框不被面板左缘切掉',
    // It used to sit at left:-22px — 22px left of the bubble, while the
    // message column reserves only a 14px left margin. On the left-aligned
    // (assistant) bubbles the checkbox landed at x = -8 and was cut in half.
    run: () => {
      const cb = document.querySelector('.msg-select-cb');
      if (!cb) return { ok: true, detail: '当前不在多选模式（跳过）' };
      const r = cb.getBoundingClientRect();
      const panel = document.getElementById('messages').getBoundingClientRect();
      return {
        ok: r.left >= panel.left - 0.5,
        detail: `复选框左缘 ${Math.round(r.left)} / 消息列左缘 ${Math.round(panel.left)}`,
      };
    },
  },
  {
    name: '代码高亮走 --code-* 令牌（没有裸 hex）',
    run: () => {
      const rules = [...document.styleSheets]
        .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
        .filter((r) => (r.cssText || '').includes('.hljs'));
      const raw = rules.filter((r) => /#[0-9a-fA-F]{3,6}/.test(r.cssText || ''));
      return { ok: raw.length === 0, detail: raw.length ? `${raw.length} 条规则带裸 hex` : `${rules.length} 条 hljs 规则全部走令牌` };
    },
  },
];

// ── run ─────────────────────────────────────────────────────────────────────
const schemes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantShots = process.argv.includes('--shots');
const useSchemes = schemes.length ? schemes : ['dark', 'light'];
const WIDTHS = (process.env.VISUAL_CHECK_WIDTHS || '420,320').split(',').map(Number);

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] })
  .catch((e) => {
    console.error('[visual-check] SKIPPED — Chromium failed to launch.');
    console.error('  ' + String(e.message || e).split('\n')[0]);
    console.error('  A headless box often needs the shared libs (libnspr4/libnss3);');
    console.error('  on Debian/Ubuntu: apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2');
    server.close();
    process.exit(0);
  });
let failures = 0;
try {
  for (const scheme of useSchemes) {
    // 420 is the common panel width; 320 is the narrow end (the width where
    // the outline rail's ticks first collided with the text) — the gate has
    // to cover BOTH, or it would miss the exact regression it was written for.
    for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(PREVIEW, { waitUntil: 'networkidle' });
    // Wait for the seeded conversation to actually RENDER before checking
    // anything. A gate that runs on an un-rendered panel is the worst kind of
    // test: every geometry assertion vacuously passes ("0 texts overlap"!)
    // while nothing was measured. If the preview never renders, that is a
    // HARD failure, not a skip.
    const rendered = await page
      .waitForFunction(() => document.querySelectorAll('#messages .msg').length > 0, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!rendered) {
      console.log(`\n[${scheme} @${width}px]`);
      console.log('  ✗ 预览没有渲染出对话 — 门禁无法执行（这是硬失败，不是跳过）');
      failures++;
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(1500); // let the live renderers (mermaid/rdkit/mol*) settle
    // Enter multiselect mode so the checkbox-gutter check has something to
    // measure (the check skips itself when the mode is off).
    await page.evaluate(() => {
      const t = document.getElementById('toolbar-tools');
      if (t) t.open = true;
      document.getElementById('multiselect-toggle')?.click();
    });
    await page.waitForTimeout(400);
    console.log(`\n[${scheme} @${width}px]`);
    if (process.env.VISUAL_CHECK_DEBUG) {
      console.log('   [debug] before checks', JSON.stringify(await page.evaluate(() => {
        const m = document.getElementById('messages');
        return { d: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), h: m.scrollHeight, c: m.clientHeight };
      })));
    }
    for (const check of CHECKS) {
      const res = await page.evaluate(check.run);
      if (!res.ok) failures++;
      console.log(`  ${res.ok ? '✓' : '✗'} ${check.name} — ${res.detail}`);
    }
    if (wantShots) {
      const out = `/tmp/visual-check-${scheme}.png`;
      await page.screenshot({ path: out });
      console.log(`  · 截图 ${out}`);
    }
    await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n✗ ${failures} 项未通过` : '\n✓ 全部视觉不变量通过');
process.exit(failures ? 1 : 0);
