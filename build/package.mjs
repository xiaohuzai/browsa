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
//
// ALLOWLIST (2026-10-17): the shipped tree is enumerated from the manifest's
// own references plus the fixed runtime roots (_locales, icons, fonts, lib,
// and the top-level page/script files). The previous deny-list silently swept
// three separate incidents into store packages (screenshots, CONTEXT.md, a
// loose PDF) — an allowlist cannot repeat that. The post-build verifier below
// still runs as a second, independent check.
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
root, out = sys.argv[1], sys.argv[2]

ALWAYS = [
    "manifest.json",
    "LICENSE",  # MIT requires the license text to travel with the distribution
    "background.js", "sidepanel.js", "sidepanel.html", "sidepanel.css",
    "options.js", "options.html", "options.css",
    "lib", "icons", "_locales", "fonts",
]

# Anything the manifest references by path is part of the extension by
# definition (content scripts, workers, WAR entries, side panel, options UI).
manifest = json.load(open(os.path.join(root, "manifest.json"), encoding="utf-8"))
referenced = []
def note(v):
    if isinstance(v, str) and ("/" in v or v.endswith((".js", ".html", ".css", ".json", ".wasm", ".png"))):
        referenced.append(v)
def walk_json(node):
    if isinstance(node, dict):
        for k, v in node.items():
            walk_json(v)
    elif isinstance(node, list):
        for v in node: walk_json(v)
    else:
        note(node)
walk_json(manifest)

def collect(rel):
    """Yield every file under root/rel (or rel itself when it is a file)."""
    full = os.path.join(root, rel)
    if os.path.isfile(full):
        yield rel
        return
    if not os.path.isdir(full):
        return
    for dirpath, dirnames, filenames in os.walk(full):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.startswith("."):
                continue
            # Dev-only files can live inside a runtime root (lib/content-scripts/
            # SITES.md is documentation). Skip them here; the verifier below
            # also fails the build if one slips through.
            if fn.endswith((".md", ".log")) or fn.endswith(".test.mjs"):
                continue
            relpath = os.path.relpath(os.path.join(dirpath, fn), root)
            yield relpath.replace(os.sep, "/")

want = set()
for entry in ALWAYS:
    want.update(collect(entry))
for ref in referenced:
    ref = ref.lstrip("./")
    # Glob-ish manifest entries (e.g. _locales/*/messages.json) are covered by
    # the ALWAYS roots; literal paths are added directly.
    if "*" not in ref:
        want.update(collect(ref))

out_name = os.path.basename(out)
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for arcname in sorted(want):
        if arcname == out_name:
            continue
        full = os.path.join(root, arcname)
        if not os.path.isfile(full):
            continue
        if arcname == "manifest.json":
            # CWS upload rejects a manifest containing a "key" field (the
            # store assigns its own key and ID). The repo manifest keeps it so
            # unpacked installs from Releases get a stable extension ID;
            # strip it only here.
            data = json.loads(open(full, encoding="utf-8").read())
            data.pop("key", None)
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

// Post-build assertion: the exclusion list above is a DENY-list and has leaked
// dev material into a store package three times (screenshots, CONTEXT.md, a
// loose PDF). Instead of trusting it, verify the artifact: no markdown / test
// / docs / dev-preview entries, and manifest.json at the zip root.
const verify = spawnSync('python3', ['-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
bad = [n for n in names if n.endswith(('.md', '.test.mjs', '.log')) or
       n.startswith(('test/', 'docs/', 'dev-preview/', 'store-assets/', 'node_modules/', 'build/'))]
if bad:
    print('FAIL: dev-only files leaked into the package:', bad[:10])
    sys.exit(1)
if 'manifest.json' not in names:
    print('FAIL: manifest.json is not at the zip root')
    sys.exit(1)
m = json.loads(z.read('manifest.json'))
if 'key' in m:
    print('FAIL: manifest still carries the CWS-forbidden "key" field')
    sys.exit(1)
print(f'  verified: {len(names)} entries, manifest at root, no dev files')
`, out], { encoding: 'utf8' });
if (verify.status !== 0) {
  console.error(verify.stdout || verify.stderr);
  await fs.unlink(out).catch(() => {});
  console.error('package verification failed — artifact removed');
  process.exit(1);
}
console.log(verify.stdout.trim());
