#!/usr/bin/env node
// build/package.mjs — package the extension into a versioned zip for
// distribution. Strips the .git directory, node_modules, and the build
// helper scripts; keeps everything the browser needs to load unpacked.
// The manifest's "key" field is dropped in the zip (CWS forbids it) but
// stays in the repo for stable unpacked-install IDs.

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
// `manifest.json`, `sidepanel.js`, `lib/content-scripts/xhs-content-script.js`, etc.
// — NOT as `browsa/manifest.json`. Edge and Chrome both require
// manifest.json at the root of the extension directory; if the zip
// is unzipped and the user points at the parent, the extension
// fails to load.
const py = `
import os, sys, json, zipfile
root, out, exclude_dirs = sys.argv[1], sys.argv[2], {".git", "node_modules", "build", "test",
    # Dev-only trees: preview harness + its screenshot library (gitignored),
    # CWS store screenshots (gitignored), and the github.io website sources.
    # None of these load in the browser as part of the extension. A real
    # incident (2026-08-28, v0.32.0): ~6MB of accumulated dev screenshots in
    # dev-preview/shots were silently swept in, bloating the zip from ~5.5MB
    # to 11.8MB -- same failure mode as the loose-PDF exclusion below.
    "dev-preview", "store-assets", "docs"}
exclude_files = {"package-lock.json", "package.json", "check-compat.sh", "config.example.json", "CLAUDE.md", "skills-lock.json"}
# Dev/editor dot-directories (.pi channel transcripts, .claude local config,
# .github workflows, .vscode, ...) must never ship in a distribution zip --
# they can contain Feishu chat transcripts and local secrets. Handled below
# by dropping any directory whose name starts with '.'.
exclude_path_prefixes = (os.path.join("lib", "_src"),)
out_name = os.path.basename(out)
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs and not d.startswith('.')]
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
            # Loose PDFs at any depth are never part of the extension itself
            # (a real 17.9MB test fixture left at the repo root once bloated
            # a package to 21MB by being silently swept up here) -- browsa
            # ships no .pdf assets, so this is a safe blanket exclusion.
            if fn.endswith(".pdf"): continue
            full = os.path.join(dirpath, fn)
            arcname = os.path.join(rel, fn) if rel else fn
            if any(arcname.startswith(p) for p in exclude_path_prefixes):
                continue
            if arcname == "manifest.json":
                # CWS upload rejects a manifest containing a "key" field (the
                # store assigns its own key and ID). The repo manifest keeps
                # it so unpacked installs from Releases get a stable extension
                # ID (chrome.storage.local is keyed by ID); strip it only here.
                data = json.loads(open(full, encoding="utf-8").read())
                if data.pop("key", None) is not None:
                    zf.writestr(arcname, json.dumps(data, indent=2, ensure_ascii=False) + "\\n")
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
