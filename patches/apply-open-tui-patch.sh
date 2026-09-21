#!/usr/bin/env bash
# Re-applies the pi-open-tui footer patch (stats-row merge + colorful
# percentages) after a pi-open-tui update wipes it from node_modules.
#
#   ~/pi-ollama-usage/patches/apply-open-tui-patch.sh
#
# Patches are named pi-open-tui-<version>-footer.patch, one per pi-open-tui
# version the footer code was regenerated for. The script tries them
# newest-first and applies the first one that fits. If none apply, the
# footer code changed in a newer pi-open-tui — regenerate the patch
# following patches/README.md ("Regenerating the patch for a new
# pi-open-tui version").
set -euo pipefail

NODE_MODULES="${HOME}/.pi/agent/npm/node_modules/pi-open-tui"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$NODE_MODULES" ]; then
  echo "pi-open-tui not found at $NODE_MODULES" >&2
  exit 1
fi

INSTALLED="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$NODE_MODULES/package.json" | head -1)"
echo "Installed pi-open-tui: $INSTALLED"

cd "$NODE_MODULES"

# Idempotency: if the patch is already in place, say so instead of failing.
if grep -qs 'statsInline' extensions/open-tui/footer.ts; then
  echo "Footer patch already applied — nothing to do."
  exit 0
fi

patches=()
while IFS= read -r f; do [ -f "$f" ] && patches+=("$f"); done \
  < <(printf '%s\n' "$PATCH_DIR"/pi-open-tui-*-footer.patch | sort -r)
if [ "${#patches[@]}" -eq 0 ]; then
  echo "No pi-open-tui-*-footer.patch files found in $PATCH_DIR" >&2
  exit 1
fi
for PATCH_FILE in "${patches[@]}"; do
  PATCH_NAME="$(basename "$PATCH_FILE")"
  if git apply --check "$PATCH_FILE" 2>/dev/null; then
    git apply "$PATCH_FILE"
    echo "Applied $PATCH_NAME cleanly. Restart pi to see it."
    exit 0
  elif patch -p1 --dry-run -s <"$PATCH_FILE" >/dev/null 2>&1; then
    patch -p1 <"$PATCH_FILE"
    echo "Applied $PATCH_NAME via patch(1). Restart pi to see it."
    exit 0
  fi
done
echo "No footer patch applies to pi-open-tui $INSTALLED." >&2
echo "The footer code changed in the new version; regenerate the patch for it." >&2
exit 1
