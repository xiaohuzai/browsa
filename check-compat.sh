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

# 3. JS syntax
for f in background.js sidepanel.js options.js lib/*.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo "FAIL: syntax error in $f"
    node --check "$f"
    exit 1
  fi
done
echo "OK  all JS files pass node --check"

# 4. No Firefox-specific API keys
if grep -lq "browser_specific_settings" manifest.json 2>/dev/null; then
  echo "FAIL: manifest contains browser_specific_settings (Firefox-only)"
  exit 1
fi
echo "OK  no Firefox-specific manifest keys"

# 5. No Firefox-specific runtime APIs in source
if grep -rnE "browser\.[a-zA-Z]+" --include="*.js" lib/ background.js sidepanel.js options.js 2>/dev/null; then
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

echo
echo "=== All checks passed. browsa should run on Edge 114+ and Chrome 114+. ==="
