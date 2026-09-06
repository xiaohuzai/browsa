// Regenerate the English README banners (docs/assets/readme/hero-en.png + providers-en.png)
// from the HTML sources in this directory, at 2x for retina crispness.
//
// Usage:  node dev-preview/banners/render.mjs
//
// The HTML sources load `InterVar.ttf` from this directory (font-weight variable font,
// used for the display headline). If it is missing it is downloaded from Google Fonts.
// Screenshots go through CDP Page.captureScreenshot (Playwright's page.screenshot has
// a dark-mode artifact issue on this box — see AGENTS.md history / dev-preview notes).

import { chromium } from '/tmp/pwshot/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const FONT = 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf';
const PORT = 8947;

const fontPath = path.join(root, 'dev-preview/banners/InterVar.ttf');
if (!fs.existsSync(fontPath)) {
  console.log('downloading Inter variable font…');
  const res = await fetch(FONT);
  fs.writeFileSync(fontPath, Buffer.from(await res.arrayBuffer()));
}

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.end(data);
  });
});
await new Promise(r => server.listen(PORT, r));

const jobs = [
  { html: 'og-en.html',   w: 1200, h: 630, out: 'docs/assets/readme/hero-en.png', scale: 2 },
  { html: 'keys-en.html', w: 1280, h: 800, out: 'docs/assets/readme/providers-en.png', scale: 2 },
  { html: 'keys-zh.html', w: 1280, h: 800, out: 'docs/assets/readme/providers-zh.png', scale: 1 },
];
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
for (const j of jobs) {
  const p = await browser.newPage({ viewport: { width: j.w, height: j.h } });
  await p.goto(`http://127.0.0.1:${PORT}/dev-preview/banners/${j.html}`, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  const client = await p.context().newCDPSession(p);
  const s = await client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: j.w, height: j.h, scale: j.scale ?? 2 },
  });
  fs.writeFileSync(path.join(root, j.out), Buffer.from(s.data, 'base64'));
  console.log('saved', j.out);
  await p.close();
}
await browser.close();
server.close();
