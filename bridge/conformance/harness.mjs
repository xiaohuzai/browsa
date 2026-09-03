// conformance/harness.mjs — shared test plumbing: backend baking + an NM
// client that speaks the real 4-byte-LE framing. Used by bridge.test.mjs
// (fake engines) and live-codex.test.mjs (the real binary on PATH).

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function bake(backendId, { binOverride, hostPrefix = 'com.agentbridge' } = {}) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'backends', `${backendId}.json`), 'utf8'));
  const shimPath = join(ROOT, 'hosts', 'nm-bridge.sh');
  let text = readFileSync(shimPath, 'utf8')
    .replace(/^#__BRIDGE_BIN_NAME__\s*$/m, `BRIDGE_BIN_NAME='${cfg.binary}'`)
    .replace(/^#__BRIDGE_ARGS__\s*$/m, `BRIDGE_ARGS='${cfg.engineArgs}'`)
    .replace(/^#__BRIDGE_BIN_OVERRIDE__\s*$/m,
      binOverride ? `export AGENT_BRIDGE_BIN='${binOverride}'` : '');
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-test-${backendId}-`));
  const host = join(dir, 'bridge');
  writeFileSync(host, text);
  chmodSync(host, 0o755);
  return { host, cfg, dir, hostName: `${hostPrefix}.${cfg.id}` };
}

export function nmClient(shimPath, { env } = {}) {
  const proc = spawn('bash', [shimPath], { stdio: ['pipe', 'pipe', 'inherit'], env });
  const frames = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  let exited = null;
  proc.on('exit', (code) => { exited = code; for (const w of [...waiters]) if (w.exit) w.resolve(); });
  proc.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const text = buf.slice(4, 4 + len).toString('utf8');
      buf = buf.slice(4 + len);
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      frames.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(payload.length, 0);
    proc.stdin.write(Buffer.concat([hdr, payload]));
  };
  const wait = (pred, label, ms = 8000) => {
    const p = pred;
    const hit = frames.find(p);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      waiters.push({ pred: p, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  const closeStdin = () => proc.stdin.end();
  return { proc, frames, send, wait, closeStdin, get exited() { return exited; } };
}
