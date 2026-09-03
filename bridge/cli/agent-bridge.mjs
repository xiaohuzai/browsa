#!/usr/bin/env node
// cli/agent-bridge.mjs — THE user-facing installer. Run this once on your
// machine, pick which engines to enable and which apps may call them, done:
// every Chrome-family browser on the box can then connect those apps to those
// engines. Apps themselves never ship installers — they show a hint + a link
// here, and a Ping to verify.
//
//   node cli/agent-bridge.mjs --list
//   node cli/agent-bridge.mjs install                 # interactive (TTY)
//   node cli/agent-bridge.mjs install \
//        --backend codex --backend claude-code \
//        --allow browsa --allow-extension <32-char-id> \
//        [--bin codex=/path/to/codex] [--os mac|linux|win] [--out installer-file]
//   node cli/agent-bridge.mjs uninstall --backend codex [--os ...]
//
// Trust model (deliberately NOT "install once, everything connects"):
//   • per-engine opt-in  — only the --backend registries you name get a host;
//   • per-app opt-in     — a host's manifest allowlists exactly the consumers
//     you authorized (--allow <known> from cli/consumers.json or raw
//     --allow-extension IDs). Chrome refuses to spawn the host for any other
//     origin, and there is no wildcard — a random extension cannot drive your
//     local agents just because agent-bridge is installed.
// Re-running install MERGES consumers into the existing allowlist, so "allow
// another app later" is one command, not a reinstall.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadBackend, bake, installerFile } from './install.mjs';
import { createInterface } from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM_HOST_PREFIX = 'com.agentbridge';

// When this bridge lives inside the browsa repo (bridge/ next to
// manifest.json), the extension's pinned ID can be derived locally: SHA-256
// over the manifest key's DER bytes, first 16 bytes hex, 0-f → a-p. The key
// is pinned, so the ID is the same on every machine and matches the store
// listing. This collapses authorization to zero arguments: the wizard just
// asks "allow browsa (id from manifest.json)?".
function idFromSiblingManifest() {
  try {
    const m = JSON.parse(readFileSync(join(ROOT, '..', 'manifest.json'), 'utf8'));
    if (!m.key) return null;
    const der = Buffer.from(m.key, 'base64');
    const hex = createHash('sha256').update(der).digest().subarray(0, 16).toString('hex');
    const id = [...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
    return /^[a-p]{32}$/.test(id) ? id : null;
  } catch { return null; }
}

// Chrome-family browser manifest locations per OS. Chrome is the canonical
// one; Edge/Chromium get the same registration so any Chromium-based browser
// works. (macOS paths are inside each browser's app-support dir; Windows uses
// one HKCU registry key per browser pointing at one shared manifest dir.)
const OS = (() => {
  const p = process.platform;
  return p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : 'linux';
})();

const NM_DIRS = {
  mac: [
    '$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    '$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts',
    '$HOME/Library/Application Support/Chromium/NativeMessagingHosts',
  ],
  linux: [
    '$HOME/.config/google-chrome/NativeMessagingHosts',
    '$HOME/.config/microsoft-edge/NativeMessagingHosts',
    '$HOME/.config/chromium/NativeMessagingHosts',
  ],
};
const WIN_REGISTRY_BRANCHES = [
  'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU:\\Software\\Chromium\\NativeMessagingHosts',
];

// Existing extension IDs this machine already granted to hostName — so
// re-running install with a NEW --allow appends instead of revoking the old
// apps. Best effort: only possible when generating for THIS machine (no
// --out, matching OS); a generated installer file always carries exactly the
// ids given on the command line.
function previouslyAllowedIds(hostName, osKind) {
  if (osKind !== OS) return [];
  const dirs = osKind === 'mac' ? NM_DIRS.mac : NM_DIRS.linux;
  const ids = new Set();
  for (const dir of dirs) {
    const full = dir.replace(/^\$HOME/, homedir());
    const f = join(full, `${hostName}.json`);
    try {
      for (const o of JSON.parse(readFileSync(f, 'utf8')).allowed_origins || []) {
        const m = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(o);
        if (m) ids.add(m[1]);
      }
    } catch { /* no existing registration here */ }
  }
  return [...ids];
}

function parseArgs(argv) {
  const out = { backend: [], allow: [], allowExtension: [], bin: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === 'install' || a === 'uninstall') out.verb = a;
    else if (a === '--backend') out.backend.push(argv[++i]);
    else if (a === '--allow') out.allow.push(argv[++i]);
    else if (a === '--allow-extension') out.allowExtension.push(argv[++i]);
    else if (a === '--bin') out.bin.push(argv[++i]);
    else if (a === '--os') out.os = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.unknown = a;
  }
  return out;
}

function knownConsumers() {
  return JSON.parse(readFileSync(join(ROOT, 'cli', 'consumers.json'), 'utf8'));
}

// Resolve --allow names + --allow-extension ids → {id, label} list.
function resolveConsumers(args) {
  const known = knownConsumers();
  const consumers = [];
  for (const name of args.allow) {
    const c = known[name];
    if (!c) throw new Error(`未知的客户端 "${name}"。已知的有：${Object.keys(known).join(', ')}`);
    consumers.push({ id: c.id, label: c.name });
  }
  for (const id of args.allowExtension) {
    if (!/^[a-p]{32}$/.test(id)) throw new Error(`--allow-extension 需要扩展 ID（32 个 a-p 字母），收到："${id}"`);
    consumers.push({ id, label: `扩展 ${id}` });
  }
  // dedup by id
  const seen = new Set();
  return consumers.filter((c) => !seen.has(c.id) && seen.add(c.id));
}

function detectBinary(cfg) {
  const roots = [...(cfg.discovery?.pathExtensions || []).map((p) => p.replace(/^~/, homedir()))];
  for (const dir of roots) {
    const p = join(dir, cfg.binary);
    if (existsSync(p)) return p;
  }
  for (const p of cfg.discovery?.managedCopies || []) {
    const full = p.replace(/^~/, homedir());
    if (existsSync(full)) return full;
  }
  return null;
}

// ── install ──────────────────────────────────────────────────────────────────

function shInstallCommand(cfg, hostName, shimText, consumers, osKind) {
  const origins = consumers.map((c) => `chrome-extension://${c.id}/`);
  const dirs = osKind === 'mac' ? NM_DIRS.mac : NM_DIRS.linux;
  const manifest = `{"name":"${hostName}","description":"agent-bridge host for ${cfg.id}","path":"$HOME/.local/bin/agent-bridge-${cfg.id}","type":"stdio","allowed_origins":${JSON.stringify(origins)}}`;
  return `set -e
mkdir -p "$HOME/.local/bin"
cat >| "$HOME/.local/bin/agent-bridge-${cfg.id}" <<'AGENT_BRIDGE_SHIM_EOF'
${shimText}
AGENT_BRIDGE_SHIM_EOF
chmod +x "$HOME/.local/bin/agent-bridge-${cfg.id}"
for d in ${dirs.map((d) => JSON.stringify(d)).join(' ')}; do
  mkdir -p "$d"
  printf '%s' ${JSON.stringify(manifest)} >| "$d/${hostName}.json"
done
echo "agent-bridge：已注册 ${hostName}"
echo "授权的客户端：${consumers.map((c) => c.label).join('、')}"
echo "重启浏览器后，在 app 里点 Ping 验证。"
`;
}

function psInstallCommand(cfg, hostName, shimText, consumers, binPath) {
  const origins = consumers.map((c) => `chrome-extension://${c.id}/`);
  const manifest = `{"name":"${hostName}","description":"agent-bridge host for ${cfg.id}","path":"$dir\\nm-bridge-${cfg.id}.bat","type":"stdio","allowed_origins":${JSON.stringify(origins)}}`;
  return `$dir = "$env:LOCALAPPDATA\\agent-bridge"
New-Item -ItemType Directory -Force $dir | Out-Null
@'
${shimText}
'@ | Set-Content "$dir\\nm-bridge-${cfg.id}.ps1" -Encoding UTF8
@'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nm-bridge-${cfg.id}.ps1"
'@ | Set-Content "$dir\\nm-bridge-${cfg.id}.bat" -Encoding ASCII
@"
${manifest}
"@ | Set-Content "$dir\\${hostName}.json" -Encoding ASCII
${WIN_REGISTRY_BRANCHES.map((b) => `New-Item -Path "${b}\\${hostName}" -Force | Out-Null
Set-ItemProperty -Path "${b}\\${hostName}" -Name "(default)" -Value "$dir\\${hostName}.json"`).join('\n')}
Write-Host "agent-bridge：已注册 ${hostName}（授权：${consumers.map((c) => c.label).join('、')}）"
Write-Host "重启浏览器后，在 app 里点 Ping 验证。"
`;
}

function buildInstall(args) {
  const osKind = args.os || OS;
  if (!['mac', 'linux', 'win'].includes(osKind)) throw new Error('--os 必须是 mac|linux|win');
  const consumers = resolveConsumers(args);
  if (!consumers.length) {
    throw new Error('没有要授权的客户端。至少给一个：--allow browsa 或 --allow-extension <扩展ID>。\n（这正是安全边界：agent-bridge 只为点名的 app 放行，不隐式放行任何扩展。）');
  }
  const parts = [];
  for (const id of args.backend) {
    const cfg = loadBackend(id);
    const binPair = args.bin.find((b) => b.startsWith(`${id}=`));
    const binPath = binPair ? binPair.slice(id.length + 1) : null;
    const hostFile = osKind === 'win' ? 'hosts/nm-bridge.ps1' : 'hosts/nm-bridge.sh';
    const shimText = bake(hostFile, { binary: cfg.binary, engineArgs: cfg.engineArgs }, binPath)(
      readFileSync(join(ROOT, hostFile), 'utf8'),
    );
    const hostName = `${NM_HOST_PREFIX}.${id}`;
    // Additive authorization: keep IDs this machine already granted.
    const allConsumers = args.out
      ? consumers
      : [...consumers, ...previouslyAllowedIds(hostName, osKind)
          .filter((pid) => !consumers.some((c) => c.id === pid))
          .map((pid) => ({ id: pid, label: `已授权的扩展 ${pid}` }))];
    parts.push(osKind === 'win'
      ? psInstallCommand(cfg, hostName, shimText, allConsumers, binPath)
      : shInstallCommand(cfg, hostName, shimText, allConsumers, osKind));
  }
  return parts.join('\n');
}

// ── interactive install ──────────────────────────────────────────────────────

async function interactiveInstall(args) {
  const backends = readdirSync(join(ROOT, 'backends')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(ROOT, 'backends', f), 'utf8')));
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nagent-bridge 安装向导\n────────────────────\n先把各引擎在本机的状态摸一遍：\n');
  for (const b of backends) {
    const p = detectBinary(b);
    console.log(`  ${p ? '●' : '○'} ${b.id.padEnd(12)} ${b.displayName}${p ? `  （发现：${p}）` : '  （未发现——装了 CLI/桌面版后可重跑本向导）'}`);
  }
  console.log('');
  const chosen = [];
  for (const b of backends) {
    const ans = await rl.question(`启用 ${b.id}（${b.displayName}）？[y/N] `);
    if (/^y/i.test(ans.trim())) chosen.push(b.id);
  }
  if (!chosen.length) { console.log('一个都没选——无事可做。'); rl.close(); return; }

  // Authorization is app-driven: an app's ID is its identity (Chrome only
  // launches the host for listed IDs, no wildcards), and the APP shows its
  // own ID in its settings page — the bridge cannot and should not enumerate
  // every client that might exist. Preset names are first-party sugar only.
  // Inside the browsa repo the default is free: the pinned ID falls out of
  // the sibling manifest.json, so the whole step is one Enter.
  const known = Object.keys(knownConsumers());
  const autoId = idFromSiblingManifest();
  let allow = [];
  let allowExtension = [];
  if (autoId) {
    const ans = await rl.question(`允许 browsa 连接（本仓库 manifest.json 的扩展 ID ${autoId}）？[Y/n] `);
    if (!/^n/i.test(ans.trim())) allowExtension.push(autoId);
    console.log('  （其他 app：重跑 install --allow-extension <它的ID>，或现在粘贴，逗号分隔）');
    const extra = await rl.question('  其他客户端 ID 或名字（可留空）：');
    const tokens = extra.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    allowExtension.push(...tokens.filter((t) => /^[a-p]{32}$/.test(t)));
    allow = tokens.filter((t) => !/^[a-p]{32}$/.test(t));
  } else {
    console.log('\n要授权哪些客户端连接这些引擎？');
    console.log('  打开想连上来的 app 的设置页，复制它显示的 ID（浏览器扩展是 32 位扩展 ID）粘贴到这里，逗号分隔。');
    if (known.length) console.log(`  已知集成也可直接写名字：${known.join('、')}`);
    const raw = await rl.question('  客户端 ID 或名字：');
    const tokens = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    allowExtension = tokens.filter((t) => /^[a-p]{32}$/.test(t));
    allow = tokens.filter((t) => !/^[a-p]{32}$/.test(t));
  }
  if (!allow.length && !allowExtension.length) {
    const force = await rl.question('  一个客户端都没授权——桥装上也连不上。确定继续？[y/N] ');
    if (!/^y/i.test(force.trim())) { console.log('已取消。想好要授权的 app 后重跑，或之后用 install --allow-extension 追加。'); rl.close(); return; }
  }
  rl.close();
  console.log('');
  await runInstall({ ...args, backend: chosen, allow, allowExtension });
}

// ── uninstall ────────────────────────────────────────────────────────────────

function buildUninstall(args) {
  const osKind = args.os || OS;
  const parts = [];
  for (const id of args.backend) {
    const hostName = `${NM_HOST_PREFIX}.${id}`;
    if (osKind === 'win') {
      parts.push(WIN_REGISTRY_BRANCHES.map((b) => `Remove-Item -Path "${b}\\${hostName}" -Force -ErrorAction SilentlyContinue`).join('\n')
        + `\nRemove-Item "$env:LOCALAPPDATA\\agent-bridge\\nm-bridge-${id}.ps1","$env:LOCALAPPDATA\\agent-bridge\\nm-bridge-${id}.bat","$env:LOCALAPPDATA\\agent-bridge\\${hostName}.json" -Force -ErrorAction SilentlyContinue`);
    } else {
      const dirs = osKind === 'mac' ? NM_DIRS.mac : NM_DIRS.linux;
      parts.push(`rm -f "$HOME/.local/bin/agent-bridge-${id}"
for d in ${dirs.map((d) => JSON.stringify(d)).join(' ')}; do rm -f "$d/${hostName}.json"; done
echo "agent-bridge：已移除 ${hostName}"`);
    }
  }
  return parts.join('\n\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function runInstall(args) {
  const command = buildInstall(args);
  if (args.out) {
    const { filename, content } = installerFile(args.os || OS, command, args.backend.join('-'));
    writeFileSync(args.out, content, { mode: 0o755 });
    console.error(`installer written: ${args.out} (${filename})`);
  } else {
    process.stdout.write(command + '\n');
  }
}

export { parseArgs, resolveConsumers, buildInstall, buildUninstall, NM_HOST_PREFIX, NM_DIRS, WIN_REGISTRY_BRANCHES };

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.verb && !args.list)) {
    console.log(`agent-bridge — 本机安装器：把浏览器扩展/其他 app 接到本地 agent 引擎

  node cli/agent-bridge.mjs --list                 # 列出可启用的引擎
  node cli/agent-bridge.mjs install                # 交互式向导（推荐）
  node cli/agent-bridge.mjs install --backend codex \\
       --allow browsa [--allow-extension <id>] [--bin codex=/path] [--out file]
  node cli/agent-bridge.mjs uninstall --backend codex

信任模型：逐引擎启用（--backend），逐客户端授权（--allow 已知客户端 /
--allow-extension 扩展 ID）。未授权的扩展永远无法拉起引擎——没有通配符。`);
    process.exit(args.help ? 0 : 1);
  }

  if (args.list) {
    for (const f of readdirSync(join(ROOT, 'backends')).filter((f) => f.endsWith('.json'))) {
      const b = JSON.parse(readFileSync(join(ROOT, 'backends', f), 'utf8'));
      const p = detectBinary(b);
      console.log(`${b.id.padEnd(12)} ${b.displayName}  (binary: ${b.binary}${p ? '' : '，未发现'})`);
    }
    process.exit(0);
  }

  if (args.unknown) { console.error(`unknown argument: ${args.unknown}`); process.exit(1); }

  try {
    if (args.verb === 'install') {
      if (!args.backend.length && process.stdin.isTTY) await interactiveInstall(args);
      else if (!args.backend.length) throw new Error('非交互环境请用 --backend <id>（可多个）。');
      else await runInstall(args);
    } else {
      if (!args.backend.length) throw new Error('uninstall 需要 --backend <id>。');
      process.stdout.write(buildUninstall(args) + '\n');
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
