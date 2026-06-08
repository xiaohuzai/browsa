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
const py = `
import os, sys, zipfile
root, out, exclude_dirs = sys.argv[1], sys.argv[2], {".git", "node_modules", "build/_deps"}
exclude_files = {"package-lock.json"}
exclude_path_prefixes = (os.path.join("browsa", "lib", "_src"),)
out_name = os.path.basename(out)
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
        rel_dir = os.path.relpath(dirpath, os.path.dirname(root))
        if any(rel_dir.startswith(p) for p in exclude_path_prefixes):
            continue
        for fn in filenames:
            if fn in exclude_files: continue
            # Don't include the zip we're currently building, and don't include
            # any prior version's zip that happens to live inside the project
            # tree (e.g. browsa-v0.15.3.zip left inside browsa/).
            if fn == out_name: continue
            if fn.startswith("browsa-v") and fn.endswith(".zip"): continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, os.path.dirname(root))
            if any(rel.startswith(p) for p in exclude_path_prefixes):
                continue
            zf.write(full, rel)
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
