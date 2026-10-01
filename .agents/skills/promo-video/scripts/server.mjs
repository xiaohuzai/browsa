// promo 静态服务器：/repo/* → browsa 仓库；/fonts/* → Noto Sans SC；
// /article.html /wrapper.html /page-shim.js → 本目录；
// /repo/dev-preview/seed.js 按 referer 的 ?scene= 动态下发分镜种子；
// /repo/dev-preview/chrome-shim.js 注入 ATTACH_PAGE / APPROVAL_RESPOND 分支
// 并把 fakePort 换成可编程端口（STREAM_HELLO_ACK 自动应答 + __push 逐帧投递），
// 让面板的「真实 onSend 流程 / 追问卡 / 审批卡」全真驱动；
// /repo/lib/content-scripts/selection-toolbar.js 注入 shadow 引用暴露，
// 让真实浮条在模拟网页里跑、驱动脚本能定位按钮。
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

// 可移植：仓库根从本文件位置自推导（<repo>/.agents/skills/promo-video/scripts/）
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.BROWSA_ROOT || join(HERE, '..', '..', '..', '..');
const FONTDIR = join(HERE, 'node_modules/@fontsource/noto-sans-sc');
const PORT = Number(process.env.PROMO_PORT) || 8957;
const COPY_V5_PATH = join(HERE, 'copy-v5.json');
const COPY_V4 = JSON.parse(readFileSync(join(HERE, 'copy-v4.json'), 'utf8'));
const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
function seedV4(scene, lang, providedCopy) {
  if (!['v4-read', 'v4-video', 'v4-agent'].includes(scene) || !COPY_V4[lang]) throw new Error('Unknown v4 scene/language');
  const c = providedCopy || COPY_V4[lang];
  const video = scene === 'v4-video';
  const meta = video ? { id: 7, title: c.videoTitle, url: 'https://www.bilibili.com/video/BV1preview' } : wasmMeta;
  const videoSrc = { platform: 'bilibili', url: meta.url, tabId: 7 };
  const raw = '[Page context attached by browsa]\n\n' + c.videoTitle + '\n\n' + c.transcript.map(t => '['+fmt(t.time)+'] '+t.text).join('\n');
  return { activeProvider: scene === 'v4-agent' ? 'bridge' : 'llm1', providers: bridgeProviders,
    pingStates: { llm1: 'reachable', bridge: 'reachable' }, uiLang: lang === 'pt-BR' ? 'pt' : lang,
    fontSize: 18, contextMode: 'auto', replyLanguage: '', asr, __pageMeta: meta, __videoTime: 84,
    history: video ? [{role:'user',content:raw,videoSrc},{role:'user',content:c.videoQ},{role:'assistant',content:c.videoA,videoSrc}] : [] };
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4',
};

// ── 分镜种子 ────────────────────────────────────────────────────────────────
const asr = { enabled: false, apiKey: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-lite-260915', videoModel: '', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000, subtitleSource: 'original' };
const providers = {
  llm1: { type: 'llm', alias: 'My OpenAI', baseUrl: 'https://api.openai.com', apiKey: 'sk-preview', model: 'gpt-4o', apiStyle: 'chat', temperature: null, maxTokens: 0 },
  llm2: { type: 'llm', alias: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'qwen3:32b', apiStyle: 'chat', temperature: null, maxTokens: 0 },
};
const bridgeProviders = {
  ...providers,
  bridge: {
    type: 'agent', alias: '', baseUrl: 'http://127.0.0.1:3948', apiKey: 'sk-preview', model: '', stream: true,
    isBridge: true, bridgeAgents: { 'http://127.0.0.1:3948': 'codex' }, bridgeApiKeys: { 'http://127.0.0.1:3948': 'sk-preview' },
    activeModel: 'http://127.0.0.1:3948', apiStyle: 'chat', temperature: null, maxTokens: 0,
  },
};
const wasmMeta = { id: 7, title: 'Understanding WebAssembly Memory', url: 'https://docs.example.dev/wasm/memory' };
const SEEDS = {
  s1: { activeProvider: 'llm1', pingStates: { llm1: 'reachable' }, providers, replyLanguage: '', systemPrompt: 'You are a helpful assistant.', contextMode: 'auto', asr, __pageMeta: wasmMeta, history: [] },
  s2: { activeProvider: 'llm1', pingStates: { llm1: 'reachable' }, providers, replyLanguage: '', systemPrompt: 'You are a helpful assistant.', contextMode: 'auto', asr, __pageMeta: wasmMeta, history: [] },
  s4: { activeProvider: 'bridge', pingStates: { bridge: 'reachable', llm1: 'reachable' }, providers: bridgeProviders, replyLanguage: '', systemPrompt: 'You are a helpful assistant.', contextMode: 'auto', asr, __pageMeta: wasmMeta, history: [] },
  // s3 → 仓库原版 seed（B 站视频会话 + 富 Markdown 历史）
};

function serveFile(res, p) {
  if (!existsSync(p)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}

// chrome-shim 注入源（拼进仓库 shim，不影响仓库文件）
// storage.set/remove/clear 必须返回 Promise——composer-state 会 .catch() 链上去，
// 仓库 shim 返回 undefined 会把真发送流程（onSend→clearPersistedDraft）炸掉。
const SHIM_PATCH_STORAGE = `
  const storageLocal = {
    get: storageGet,
    set(obj) { Object.assign(mem, obj); for (const l of storageListeners) l(obj, 'local'); return Promise.resolve(); },
    remove(k) { delete mem[k]; return Promise.resolve(); },
    clear() { for (const k of Object.keys(mem)) delete mem[k]; return Promise.resolve(); },
  };`;
const SHIM_PATCH_CASES = [
  // 真实 ATTACH_PAGE 响应形状（{ok, data:{ok, ctx}}）
  "case 'ATTACH_PAGE': return { ok: true, data: { ok: true, ctx: { mode: (msg && msg.mode) || 'auto', meta: pageMeta, text: seedConfig.__attachText || " + JSON.stringify([
    '# Understanding WebAssembly Memory', '',
    'Every WebAssembly instance works with a **linear memory**: one contiguous, byte-addressable space that both the module and the host can read and write.', '',
    '## Pages, not bytes',
    'Memory is allocated in units of 64 KiB pages. A fresh module starts with the minimum declared at compile time, and can grow up to a declared maximum.', '',
    '## Growing at runtime',
    'Calls to `memory.grow(n)` append n pages and return the previous size in pages. Growth may force the engine to relocate the backing buffer, which is why any ArrayBuffer view you cached becomes detached after a grow.', '',
    '## Sharing with JavaScript',
    'Because the host and the module reference the same bytes, passing large data across the boundary needs no copy at all: write into the shared buffer from JS, hand the module a pointer and a length.',
  ].join('\n')) + " } } };",
  // 审批点击回包（面板读 res.data.ok）
  "case 'APPROVAL_RESPOND': return { ok: true, data: { ok: true } };",
].join('\n      ');
const SHIM_PATCH_PORT = `
  function fakePort(name) {
    const ls = [];
    const fire = (m) => { for (const f of [...ls]) f(m); };
    const port = {
      name,
      onMessage: {
        addListener(f) { ls.push(f); },
        removeListener(f) { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
      },
      onDisconnect: { addListener() {}, removeListener() {} },
      postMessage(msg) {
        if (msg && msg.type === 'STREAM_HELLO') setTimeout(() => fire({ type: 'STREAM_HELLO_ACK' }), 0);
        if (msg && msg.type === 'SUBCHAT_HELLO') setTimeout(() => fire({ type: 'SUBCHAT_HELLO_ACK' }), 0);
      },
      disconnect() {},
      __push: fire,
    };
    (window.__promoPorts = window.__promoPorts || {})[name] = port;
    return port;
  }`;

createServer((req, res) => {
  try {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);

  if (p.startsWith('/fonts/')) return serveFile(res, join(FONTDIR, p.slice('/fonts/'.length)));
  if (['/article.html', '/wrapper.html', '/stage-v4.html', '/page-shim.js'].includes(p)) return serveFile(res, join(HERE, p.slice(1)));

  if (p === '/browser-v7.html') return serveFile(res, join(HERE,'browser-v7.html'));
  if (p === '/browser-v5.html') return serveFile(res, join(HERE,'browser-v5.html'));
  if (p.startsWith('/repo/')) {
    const real = join(ROOT, p.slice('/repo/'.length));
    // seed.js：按 iframe URL（referer）里的 scene 动态下发
    if (p.endsWith('/seed.js')) {
      const ref = new URL(req.headers.referer || '', 'http://x');
      const scene = ref.searchParams.get('scene');
      if (scene?.startsWith('v7-')) {
        const lang=ref.searchParams.get('lang')||'en',c=JSON.parse(readFileSync(join(HERE,'copy-v7.json'),'utf8'))[lang];
        const seed=seedV4(scene.replace('v7-','v4-'),lang,c);
        seed.fontSize=20;seed.__videoTime=130;
        seed.providers.bridge={...seed.providers.bridge,models:['http://127.0.0.1:3948'],endpointPing:{'http://127.0.0.1:3948':'reachable'}};
        if(scene!=='v7-video')seed.__pageMeta={id:7,title:c.article.title,url:'https://browsa.demo/transformer-notes'};
        seed.__attachText='# '+c.article.title+'\n\n'+c.article.dek+'\n\n'+c.article.sections.map(x=>'## '+x.heading+'\n'+x.text).join('\n\n');
        res.writeHead(200,{'content-type':MIME['.js']});return res.end('window.__BROWSA_PREVIEW_SEED = '+JSON.stringify(seed)+';\n');
      }
      if (scene?.startsWith('v5-')) {
        const lang = ref.searchParams.get('lang') || 'en';
        const c = JSON.parse(readFileSync(COPY_V5_PATH,'utf8'))[lang];
        const seed = seedV4(scene.replace('v5-','v4-'),lang,c);
        seed.fontSize = 20;
        seed.providers.bridge = {...seed.providers.bridge, models:['http://127.0.0.1:3948'],endpointPing:{'http://127.0.0.1:3948':'reachable'}};
        if (scene !== 'v5-video') seed.__pageMeta = {id:7,title:c.article.title,url:'https://browsa.demo/wasm-memory'};
        seed.__attachText = '# '+c.article.title+'\n\n'+c.article.dek+'\n\n'+c.article.sections.map(x=>'## '+x.heading+'\n'+x.text).join('\n\n');
        res.writeHead(200, {'content-type':MIME['.js']});
        return res.end('window.__BROWSA_PREVIEW_SEED = '+JSON.stringify(seed)+';\n');
      }
      if (scene?.startsWith('v4-')) {
        const seed = seedV4(scene, ref.searchParams.get('lang') || 'en');
        res.writeHead(200, { 'content-type': MIME['.js'] });
        return res.end('window.__BROWSA_PREVIEW_SEED = '+JSON.stringify(seed)+';\n');
      }
      if (scene && SEEDS[scene]) {
        res.writeHead(200, { 'content-type': MIME['.js'] });
        return res.end('window.__BROWSA_PREVIEW_SEED = ' + JSON.stringify(SEEDS[scene]) + ';\n');
      }
      return serveFile(res, real);
    }
    // chrome-shim.js：注入可编程端口 + ATTACH_PAGE / APPROVAL_RESPOND
    if (p.endsWith('/chrome-shim.js')) {
      let src = readFileSync(real, 'utf8');
      src = src.replace('const p = handle(msg);', 'window.__promoMessages = window.__promoMessages || []; window.__promoMessages.push(msg);\n    const p = handle(msg);');
      src = src.replace('return new URL(p, document.baseURI).href;', "return new URL('/repo/' + p, document.baseURI).href;");
      src = src.replace("case 'SEEK_VIDEO': return { ok: true, data: { ok: true } };", "case 'SEEK_VIDEO': seedConfig.__videoTime = msg.seconds; window.parent?.__promoSeek?.(msg.seconds); return { ok: true, data: { ok: true } };");
      src = src.replace("return new URLSearchParams(location.search).get('lang') === 'en' ? 'en-US' : 'zh-CN';", "const lang = new URLSearchParams(location.search).get('lang') || 'zh'; return lang === 'zh' ? 'zh-CN' : lang;");
      if (!src.includes("case 'ATTACH_PAGE'")) {
        src = src.replace('default: return', SHIM_PATCH_CASES + '\n      default: return');
        src = src.replace(
          `  function fakePort(name) {
    return {
      name,
      onMessage: { addListener() {} },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    };
  }`,
          SHIM_PATCH_PORT
        );
        // storage 补 Promise 返回值（原实现返回 undefined，.catch() 链会炸）
        src = src.replace(
          `  const storageLocal = {
    get: storageGet,
    set(obj) { Object.assign(mem, obj); for (const l of storageListeners) l(obj, 'local'); },
    remove(k) { delete mem[k]; },
    clear() { for (const k of Object.keys(mem)) delete mem[k]; },
  };`,
          SHIM_PATCH_STORAGE.trim()
        );
        src = src.replace(
          "session: { get: async () => ({}), set: noop, remove: noop },",
          "session: { get: async () => ({}), set: noop, remove: () => Promise.resolve() },"
        );
        console.log('[shim] patched ports + storage-promises + ATTACH_PAGE + APPROVAL_RESPOND');
      }
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(src);
    }
    // selection-toolbar.js：暴露 closed shadow 引用给驱动脚本定位浮条按钮
    if (p.endsWith('/selection-toolbar.js')) {
      let src = readFileSync(real, 'utf8');
      if (!src.includes('__promoShadow')) {
        src = src.replace(
          "const shadow = host.attachShadow({ mode: 'closed' });",
          "const shadow = host.attachShadow({ mode: 'closed' });\n    window.__promoShadow = shadow;"
        );
        console.log('[toolbar] patched shadow exposure');
      }
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(src);
    }
    return serveFile(res, real);
  }

  res.writeHead(404); res.end('404');
  } catch (e) {
    console.log('[server] ERROR', (req && req.url), e && e.stack || e);
    try { res.writeHead(500); res.end('ERR'); } catch (_) {}
  }
}).listen(PORT, () => console.log('promo server on ' + PORT));
process.on('uncaughtException', (e) => console.log('[server] UNCAUGHT', e && e.stack || e));
