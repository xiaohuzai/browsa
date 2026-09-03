#!/usr/bin/env node
// cli/install.mjs — generate the one-shot Native Messaging host registration
// command (or a double-clickable installer file) for a backend.
//
// Usage:
//   node cli/install.mjs --list
//   node cli/install.mjs --backend codex --ext-id <chrome-extension-id> [--bin /path/to/engine] [--os mac|linux|win] [--out installer-file]
//
// Prints the shell/PowerShell command to stdout; with --out writes a
// double-clickable installer (.command/.sh/.bat) instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--backend') out.backend = argv[++i];
    else if (a === '--ext-id') out.extId = argv[++i];
    else if (a === '--bin') out.bin = argv[++i];
    else if (a === '--os') out.os = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--host-prefix') out.hostPrefix = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else { out.unknown = a; }
  }
  return out;
}

function loadBackend(id) {
  const path = join(ROOT, 'backends', `${id}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const shPath = (p) => p.replace(/'/g, `'\\''`);
const psPath = (p) => p.replace(/'/g, "''");

function bake(shim, cfg, binPath) {
  const binName = cfg.binName ?? cfg.binary;
  if (shim.endsWith('.sh')) {
    return (text) => text
      .replace(/^#__BRIDGE_BIN_NAME__\s*$/m, `BRIDGE_BIN_NAME='${binName}'`)
      .replace(/^#__BRIDGE_ARGS__\s*$/m, `BRIDGE_ARGS='${cfg.engineArgs}'`)
      .replace(/^#__BRIDGE_BIN_OVERRIDE__\s*$/m, binPath ? `export AGENT_BRIDGE_BIN='${shPath(binPath)}'` : '');
  }
  return (text) => text
    .replace(/^#__BRIDGE_BIN_NAME__\s*$/m, `$script:BridgeBinName = '${binName}'`)
    .replace(/^#__BRIDGE_ARGS__\s*$/m, `$script:BridgeArgs = '${cfg.engineArgs}'`)
    .replace(/^#__BRIDGE_BIN_OVERRIDE__\s*$/m, binPath ? `$env:AGENT_BRIDGE_BIN = '${psPath(binPath)}'` : '');
}

// Shell command (mac/linux) — set -e + >| so a noclobber shell or a stale file
// can never produce a silent half-install; ends with a self-check that proves
// the new shim actually landed.
function shCommand(cfg, shimText, extId, nmDir) {
  return `set -e
mkdir -p "$HOME/.local/bin" "${nmDir}"
cat >| "$HOME/.local/bin/browsa-${cfg.id}-bridge" <<'BRIDGE_SHIM_EOF'
${shimText}
BRIDGE_SHIM_EOF
chmod +x "$HOME/.local/bin/browsa-${cfg.id}-bridge"
cat >| "${nmDir}/${cfg.host}.json" <<BRIDGE_MANIFEST_EOF
{"name":"${cfg.host}","description":"agent-bridge for ${cfg.id}","path":"$HOME/.local/bin/browsa-${cfg.id}-bridge","type":"stdio","allowed_origins":["chrome-extension://${extId}/"]}
BRIDGE_MANIFEST_EOF
echo "桥标记检查: dd bs=$(grep -c 'dd bs' "$HOME/.local/bin/browsa-${cfg.id}-bridge") (应≥4)"
echo "桥接已安装——重启 Chrome，回扩展设置点 Ping 验证。"
`;
}

// PowerShell command (win) — manifest is pure ASCII (PS 5.1 UTF-8 BOM would
// break Chrome's manifest parser); the .ps1 keeps UTF-8 for its Chinese text.
function psCommand(cfg, shimText, extId, winDir) {
  return `$dir = "${winDir}"
New-Item -ItemType Directory -Force $dir | Out-Null
@'
${shimText}
'@ | Set-Content "$dir\\nm-bridge.ps1" -Encoding UTF8
@'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nm-bridge.ps1"
'@ | Set-Content "$dir\\nm-bridge.bat" -Encoding ASCII
@"
{"name":"${cfg.host}","description":"agent-bridge for ${cfg.id}","path":"$dir\\nm-bridge.bat","type":"stdio","allowed_origins":["chrome-extension://${extId}/"]}
"@ | Set-Content "$dir\\${cfg.host}.json" -Encoding ASCII
New-Item -Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${cfg.host}" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${cfg.host}" -Name "(default)" -Value "$dir\\${cfg.host}.json"
Write-Host "桥接已安装——重启 Chrome，回扩展设置点 Ping 验证。"
`;
}

// Double-clickable installer wrapper around the command. macOS .command opens
// in Terminal (no Gatekeeper prompt for plain scripts); Windows runs the whole
// install through powershell -EncodedCommand (UTF-16LE base64 — no quoting).
function installerFile(osKind, command, backend) {
  if (osKind === 'win') {
    let u16 = '';
    for (const ch of command.replace(/\n/g, '\r\n') + '\r\npause\r\n') {
      const c = ch.codePointAt(0);
      u16 += String.fromCharCode(c & 255, (c >> 8) & 255);
    }
    return { filename: `agent-bridge-${backend}-installer.bat`, content: `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(u16, 'utf16le').toString('base64')}\r\n` };
  }
  const pause = osKind === 'mac' ? `\necho\nread -n 1 -s -r -p "完成——按任意键关闭本窗口。"` : '';
  return {
    filename: `agent-bridge-${backend}-installer.${osKind === 'mac' ? 'command' : 'sh'}`,
    content: `#!/bin/bash\nset -e\n${command}${pause}\n`,
  };
}

export { loadBackend, bake, shCommand, psCommand, installerFile };

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.list && !args.backend)) {
    console.log('agent-bridge installer generator\n\n  node cli/install.mjs --list\n  node cli/install.mjs --backend <id> --ext-id <chrome-extension-id> [--bin path] [--os mac|linux|win] [--out file]\n');
    process.exit(args.help ? 0 : 1);
  }
  if (args.list) {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(join(ROOT, 'backends'))) {
      if (f.endsWith('.json')) {
        const b = JSON.parse(readFileSync(join(ROOT, 'backends', f), 'utf8'));
        console.log(`${b.id.padEnd(12)} ${b.displayName}  (binary: ${b.binary})`);
      }
    }
    process.exit(0);
  }
  if (args.unknown) { console.error(`unknown argument: ${args.unknown}`); process.exit(1); }

  const cfg = loadBackend(args.backend);
  if (!args.extId || !/^[a-p]{32}$/.test(args.extId)) {
    console.error('需要 --ext-id <chrome-extension-id>（32 个 a-p 字母，见 chrome://extensions）。');
    process.exit(1);
  }
  // NM host name: generic prefix by default; a consumer may pass its own
  // (e.g. browsa uses com.xiaohuzai.browsa to stay compatible with installs
  // made before this repo existed).
  cfg.host = `${args.hostPrefix || 'com.agentbridge'}.${cfg.id}`;
  const osKind = args.os || (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux');
  if (!['mac', 'linux', 'win'].includes(osKind)) { console.error(`--os 必须是 mac|linux|win`); process.exit(1); }

  const hostFile = osKind === 'win' ? 'hosts/nm-bridge.ps1' : 'hosts/nm-bridge.sh';
  const shimText = bake(hostFile, cfg, args.bin)(readFileSync(join(ROOT, hostFile), 'utf8'));
  const command = osKind === 'win'
    ? psCommand(cfg, shimText, args.extId, `$env:LOCALAPPDATA\\agent-bridge-${cfg.id}`)
    : shCommand(cfg, shimText, args.extId,
        osKind === 'mac'
          ? '$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts'
          : '$HOME/.config/google-chrome/NativeMessagingHosts');

  if (args.out) {
    const { filename, content } = installerFile(osKind, command, cfg.id);
    writeFileSync(args.out, content, { mode: 0o755 });
    console.error(`installer written: ${args.out} (${filename})`);
  } else {
    process.stdout.write(command);
  }
}

// Import-safe: this module is a helper library for cli/agent-bridge.mjs and
// for product authors who want a white-labeled per-product installer. Only
// run the CLI when executed directly — never process.exit on import.
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) await main();
