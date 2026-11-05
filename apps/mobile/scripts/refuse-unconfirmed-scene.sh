#!/bin/bash
# Refuses to publish a phone update while a Liquid Glass scene photo is
# installed in this checkout but not committed (FOLLOWUPS SC1).
#
# The photos stay out of the repository until the owner confirms where they
# came from: scripts/liquid-glass/install-scene.mjs installs them locally for
# walks, into paths .gitignore lists. `eas update` bundles from this checkout,
# and src/components/ui/glass/scene-assets.ts requires them optionally, so an
# installed photo would ship in the update. Once SC1 is settled the photos are
# committed (and the .gitignore lines removed); a committed photo passes.
#
# Usage: bash scripts/refuse-unconfirmed-scene.sh [app-dir]
#   app-dir defaults to apps/mobile. Exit 0: nothing unconfirmed. Exit 1: refused.
set -euo pipefail
cd "${1:-$(dirname "$0")/..}"
shopt -s nullglob

for photo in assets/liquid-glass/scene-*; do
  if ! git ls-files --error-unmatch -- "$photo" >/dev/null 2>&1; then
    echo "FATAL: $photo is installed but not committed. The Liquid Glass scene photos may not ship until the owner confirms where they came from (FOLLOWUPS SC1): remove assets/liquid-glass/scene-* from this checkout and publish again." >&2
    exit 1
  fi
done
