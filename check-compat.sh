#!/usr/bin/env bash
# check-compat.sh — verify the extension is structurally valid for both
# Edge and Chrome (both Chromium-based, but we lint the manifest carefully).
# Usage: bash check-compat.sh

set -euo pipefail

cd "$(dirname "$0")"

echo "=== browsa: browser compatibility self-check ==="
echo

# 1. Manifest must be valid JSON
if ! python3 -c "import json; json.load(open('manifest.json'))"; then
  echo "FAIL: manifest.json is not valid JSON"
  exit 1
fi
echo "OK  manifest.json parses as JSON"

# 2. Required MV3 fields
python3 <<'EOF'
import json, sys
m = json.load(open('manifest.json'))
required = [
  'manifest_version', 'name', 'version', 'description',
  'permissions', 'host_permissions', 'background',
  'action', 'side_panel', 'options_ui', 'icons',
  'web_accessible_resources', 'content_security_policy'
]
missing = [k for k in required if k not in m]
if missing:
  print(f"FAIL: missing required fields: {missing}")
  sys.exit(1)
if m['manifest_version'] != 3:
  print(f"FAIL: manifest_version must be 3 (got {m['manifest_version']})")
  sys.exit(1)
print("OK  all required MV3 fields present")
EOF

# 3. JS syntax — every first-party module, including the nested layers
# (handlers/sidepanel/content-scripts/workers), not just the top-level files.
# Worker scripts are classic/module workers but plain JS either way.
while IFS= read -r f; do
  if ! node --check "$f" 2>/dev/null; then
    echo "FAIL: syntax error in $f"
    node --check "$f"
    exit 1
  fi
done < <( { echo background.js; echo sidepanel.js; echo options.js;
            find lib -name '*.js' -not -path 'lib/vendor/*'; } | sort )
echo "OK  all JS files pass node --check"

# 4. No Firefox-specific API keys
if grep -lq "browser_specific_settings" manifest.json 2>/dev/null; then
  echo "FAIL: manifest contains browser_specific_settings (Firefox-only)"
  exit 1
fi
echo "OK  no Firefox-specific manifest keys"

# 5. No Firefox-specific runtime APIs in source. lib/vendor/ is excluded —
# it's third-party bundles, not browsa's own code, and minified bundles
# have tripped this before on coincidental substring matches (e.g. a
# bundled module path literal like "browser.js", not an actual browser.*
# API call).
if grep -rnE "browser\.[a-zA-Z]+" --include="*.js" --exclude-dir=vendor lib/ background.js sidepanel.js options.js 2>/dev/null; then
  echo "FAIL: source code uses browser.* (Firefox) APIs"
  exit 1
fi
echo "OK  source code uses only chrome.* APIs"

# 6. Default_locale + locales/ match
python3 <<'EOF'
import json, os, sys
m = json.load(open('manifest.json'))
if 'default_locale' in m and '__MSG_' in m.get('name', ''):
  if not os.path.isdir('_locales'):
    print("FAIL: default_locale declared but no _locales/ directory")
    sys.exit(1)
  default = m['default_locale']
  if not os.path.isfile(f'_locales/{default}/messages.json'):
    print(f"FAIL: _locales/{default}/messages.json missing")
    sys.exit(1)
print("OK  i18n config is valid")
EOF

# 7. sidePanel API actually used
if ! grep -q "chrome.sidePanel" background.js 2>/dev/null; then
  echo "WARN: chrome.sidePanel is not referenced in background.js"
fi
echo "OK  sidePanel API used"

# 8. Version consistency: manifest.json must match package.json (the release
# flow has a postversion hook, but hand-edited versions drift silently).
python3 <<'EOF'
import json, sys
pkg = json.load(open('package.json'))
man = json.load(open('manifest.json'))
if pkg['version'] != man['version']:
    print(f"FAIL: version mismatch — package.json={pkg['version']} manifest.json={man['version']}")
    sys.exit(1)
print(f"OK  version consistent ({pkg['version']})")
EOF

# 9. Locale key parity across every _locales bundle (drift = untranslated or
# dangling keys, which chrome.i18n silently falls back on).
python3 <<'EOF'
import json, os, sys
base = None
problems = []
for loc in sorted(os.listdir('_locales')):
    path = os.path.join('_locales', loc, 'messages.json')
    if not os.path.isfile(path):
        continue
    keys = set(json.load(open(path)).keys())
    if base is None:
        base, base_loc = keys, loc
        continue
    missing, extra = base - keys, keys - base
    if missing or extra:
        problems.append((loc, sorted(missing)[:5], sorted(extra)[:5]))
if problems:
    for loc, missing, extra in problems:
        print(f"FAIL: {loc} missing={missing} extra={extra}")
    sys.exit(1)
print(f"OK  all locales carry the same {len(base)} keys")
EOF

# 10. Every vendored artifact the code loads actually exists (a skipped or
# partial build leaves dangling getURL()/import paths that only fail at runtime
# inside the real extension).
python3 <<'EOF'
import os, re, sys
base = 'lib/vendor'
refs = set()
# Both shapes are used: ES imports relative to lib/sidepanel ('../vendor/x.js')
# and runtime URLs ('lib/vendor/x.wasm' via chrome.runtime.getURL).
pat = re.compile(r"""(?:\.\./vendor/|lib/vendor/)([A-Za-z0-9_.\-]+)""")
for root, dirs, files in os.walk('lib'):
    dirs[:] = [d for d in dirs if d != 'vendor']
    for f in files:
        if not f.endswith(('.js', '.html')):
            continue
        with open(os.path.join(root, f), encoding='utf-8', errors='ignore') as fh:
            for m in pat.findall(fh.read()):
                refs.add(m)
missing = sorted(r for r in refs if not os.path.exists(os.path.join(base, r)))
if missing:
    print("FAIL: referenced vendor artifacts missing:")
    for m in missing:
        print("   ", m)
    sys.exit(1)
print(f"OK  all {len(refs)} referenced vendor artifacts exist")
EOF

echo
echo "=== All checks passed. browsa should run on Edge 116+ and Chrome 116+. ==="

# 11. Vendor artifacts must match their declared source versions. A caret range
# can silently move a package across a build-patch boundary (the CSP patches
# regex-anchor on minified string literals), so the wasm/renderer vendors are
# pinned exactly and this check catches an accidental drift.
python3 <<'EOF'
import json, re, sys
pkg = json.load(open('package.json'))
exact = ['katex', 'molstar', '@rdkit/rdkit', 'docling.rs-wasm', '@firecrawl/pdf-inspector-wasm', 'pdfjs-dist']
bad = [f"{k}={pkg['devDependencies'][k]}" for k in exact
       if not re.fullmatch(r'\d+\.\d+\.\d+', pkg['devDependencies'].get(k, ''))]
if bad:
    print("FAIL: these build-patched vendors must be pinned to an exact version:", bad)
    sys.exit(1)
print(f"OK  {len(exact)} build-patched vendors pinned exactly")
EOF
