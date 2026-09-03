// conformance/installer.test.mjs — the user-facing installer contract.
// agent-bridge.mjs is the ONE way machines get wired up: per-engine opt-in,
// per-consumer opt-in, neutral host names, additive re-runs. These tests pin
// that contract without touching the real NativeMessagingHosts dirs (HOME is
// redirected where the test reads existing manifests for merging).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveConsumers, buildInstall, buildUninstall, NM_HOST_PREFIX, NM_DIRS } from '../cli/agent-bridge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSA_ID = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(ROOT, 'cli', 'consumers.json'), 'utf8'))).browsa.id;

test('resolveConsumers: known preset + raw extension id, deduped', () => {
  const args = parseArgs(['node', 'ab', 'install', '--allow', 'browsa', '--allow-extension', BROWSA_ID, '--allow-extension', 'a'.repeat(32)]);
  const list = resolveConsumers(args);
  assert.deepEqual(list.map((c) => c.id), [BROWSA_ID, 'a'.repeat(32)]);
});

test('resolveConsumers: rejects unknown presets and malformed ids', () => {
  assert.throws(() => resolveConsumers(parseArgs(['node', 'ab', 'install', '--allow', 'nope'])), /未知的客户端/);
  assert.throws(() => resolveConsumers(parseArgs(['node', 'ab', 'install', '--allow-extension', 'zzz'])), /32 个 a-p 字母/);
});

test('install: no consumers → refuse (the security boundary is explicit)', () => {
  assert.throws(
    () => buildInstall(parseArgs(['node', 'ab', 'install', '--backend', 'codex'])),
    /没有要授权的客户端/,
    'agent-bridge must never register a host with a blanket or empty allowlist',
  );
});

test('install: codex for browsa → neutral host com.agentbridge.codex, manifest carries exactly the authorized origins', () => {
  const cmd = buildInstall(parseArgs(['node', 'ab', 'install', '--backend', 'codex', '--allow', 'browsa', '--os', 'linux']));
  assert.match(cmd, new RegExp(`agent-bridge-codex`), 'host script named per backend');
  // The manifest rides inside shell quoting — unescape to inspect its JSON.
  const unescaped = cmd.replace(/\\"/g, '"');
  assert.match(unescaped, new RegExp(`"name":"${NM_HOST_PREFIX}\\.codex"`), 'NM host name is neutral (not per-product)');
  assert.match(unescaped, new RegExp(`chrome-extension://${BROWSA_ID}/`), 'browsa origin allowlisted');
  assert.match(cmd, /AGENT_BRIDGE_SHIM_EOF'\n#!\/usr\/bin\/env bash\n/, 'shim keeps its shebang — Chrome execs it directly');
  assert.match(cmd, /BRIDGE_BIN_NAME='codex'/, 'baked binary from the backend recipe');
  assert.match(cmd, /BRIDGE_ARGS='app-server --stdio'/, 'baked engine args from the backend recipe');
  assert.match(cmd, /google-chrome\/NativeMessagingHosts/, 'linux chrome manifest dir');
  assert.match(cmd, /microsoft-edge\/NativeMessagingHosts/, 'edge registered too (same Chromium family)');
  assert.ok(!cmd.includes('browsa_codex'), 'no per-product host naming anywhere');
});

test('install: multiple backends and multiple consumers in one shot', () => {
  const other = 'b'.repeat(32);
  const cmd = buildInstall(parseArgs(['node', 'ab', 'install', '--backend', 'codex', '--backend', 'codebuddy', '--allow', 'browsa', '--allow-extension', other, '--os', 'linux']));
  assert.match(cmd, new RegExp(NM_HOST_PREFIX.replace(/\./g, '\\.') + '\\.codex'));
  assert.match(cmd, new RegExp(NM_HOST_PREFIX.replace(/\./g, '\\.') + '\\.codebuddy'));
  assert.match(cmd, new RegExp(`chrome-extension://${other}/`), 'arbitrary extension id honored');
});

test('install: --bin codex=... bakes the explicit override into the shim', () => {
  const cmd = buildInstall(parseArgs(['node', 'ab', 'install', '--backend', 'codex', '--allow', 'browsa', '--bin', 'codex=/opt/codex/bin/codex', '--os', 'linux']));
  assert.match(cmd, /AGENT_BRIDGE_BIN='\/opt\/codex\/bin\/codex'/);
});

test('install: --os win → registry branches for chrome+edge+chromium, .bat launcher', () => {
  const cmd = buildInstall(parseArgs(['node', 'ab', 'install', '--backend', 'codex', '--allow', 'browsa', '--os', 'win']));
  assert.match(cmd, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/);
  assert.match(cmd, /HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts/);
  assert.match(cmd, /nm-bridge-codex\.bat/);
});

test('uninstall: removes the host script and every manifest copy', () => {
  const cmd = buildUninstall(parseArgs(['node', 'ab', 'uninstall', '--backend', 'codex', '--os', 'linux']));
  assert.match(cmd, /rm -f "\$HOME\/\.local\/bin\/agent-bridge-codex"/);
  assert.match(cmd, new RegExp(`${NM_HOST_PREFIX.replace(/\./g, '\\.') }\\.codex\\.json`));
  for (const d of NM_DIRS.linux) assert.ok(cmd.includes(d.replace('$HOME/', '')), `covers ${d}`);
});

test('manifests already on this machine are merged into a fresh install (additive --allow)', async () => {
  // The merge reads real NativeMessagingHosts dirs under $HOME. Redirect HOME
  // for the module under test via a scoped import is overkill — instead pin
  // the behavior through previouslyAllowedIds indirectly: write a manifest
  // into a fake HOME, set process.env.HOME before importing? The module
  // resolves homedir() at call time, so patching process.env.HOME works.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const fakeHome = fs.mkdtempSync(join(os.tmpdir(), 'ab-merge-'));
  const dir = join(fakeHome, '.config/google-chrome/NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  const old = 'c'.repeat(32);
  fs.writeFileSync(join(dir, `${NM_HOST_PREFIX}.codex.json`), JSON.stringify({
    name: `${NM_HOST_PREFIX}.codex`,
    allowed_origins: [`chrome-extension://${old}/`],
  }));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const cmd = buildInstall(parseArgs(['node', 'ab', 'install', '--backend', 'codex', '--allow', 'browsa', '--os', 'linux']));
    assert.match(cmd, new RegExp(`chrome-extension://${BROWSA_ID}/`), 'new consumer added');
    assert.match(cmd, new RegExp(`chrome-extension://${old}/`), 'previously authorized consumer preserved');
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
