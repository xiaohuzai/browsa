#!/usr/bin/env node
// build/package.mjs — package the extension into a versioned zip for
// distribution. Strips the .git directory, node_modules, and the build
// helper scripts; keeps everything the browser needs to load unpacked.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Read version from package.json
const pkg = JSON.parse(await fs.readFile(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const out = join(ROOT, `browsa-v${version}.zip`);

// Use Python's stdlib zipfile (always available on the system; no native dep).
// Exclude .git, node_modules, transient build deps, vendored source cache,
// and the zip itself.
//
// We anchor the relative path against ROOT (the browsa/ project dir), not
// against its parent, so files inside the zip are stored as
// `manifest.json`, `sidepanel.js`, `lib/xhs-content-script.js`, etc.
// — NOT as `browsa/manifest.json`. Edge and Chrome both require
// manifest.json at the root of the extension directory; if the zip
// is unzipped and the user points at the parent, the extension
// fails to load.
const py = `
import os, sys, zipfile
root, out, exclude_dirs = sys.argv[1], sys.argv[2], {".git", "node_modules", "build/_deps"}
exclude_files = {"package-lock.json"}
exclude_path_prefixes = (os.path.join("lib", "_src"),)
out_name = os.path.basename(out)
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == "." or rel_dir.startswith(".."):
            rel = ""
        else:
            if any(rel_dir == p or rel_dir.startswith(p + os.sep) for p in exclude_path_prefixes):
                continue
            rel = rel_dir
        for fn in filenames:
            if fn in exclude_files: continue
            if fn == out_name: continue
            if fn.startswith("browsa-v") and fn.endswith(".zip"): continue
            full = os.path.join(dirpath, fn)
            arcname = os.path.join(rel, fn) if rel else fn
            if any(arcname.startswith(p) for p in exclude_path_prefixes):
                continue
            zf.write(full, arcname)
print(out)
`;
const r = spawnSync('python3', ['-c', py, ROOT, out], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error('zip failed:', r.stderr);
  process.exit(1);
}
console.log(r.stdout.trim());

const stat = await fs.stat(out);
console.log(`  (${stat.size.toLocaleString()} bytes)`);
