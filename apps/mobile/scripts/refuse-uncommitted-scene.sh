#!/bin/bash
# Refuses to publish a phone update unless both Liquid Glass scene
# illustrations in this checkout are the committed files the manifest pins.
#
# The illustrations were made for StockPilot by Claude Design during the
# Liquid Glass design work (confirmed 2026-11-05). Their phone copies,
# assets/liquid-glass/scene-light.jpg and scene-dark.jpg, are committed:
# scripts/liquid-glass/install-scene.mjs writes them from the originals and
# pins their SHA-256 in scripts/liquid-glass/scene-files.sha256.
# `eas update` bundles from this working tree, so a file that is missing (the
# bundle fails), or changed since the last commit, or not the pinned one,
# would ship something no one reviewed. Refused here, before anything is
# published.
#
# Usage: bash scripts/refuse-uncommitted-scene.sh [app-dir]
#   app-dir defaults to apps/mobile. Exit 0: both files are the committed,
#   pinned ones. Exit 1: refused.
set -euo pipefail
cd "${1:-$(dirname "$0")/..}"

top="$(git rev-parse --show-toplevel)"
prefix="$(git rev-parse --show-prefix)"
manifest="$top/scripts/liquid-glass/scene-files.sha256"
how="Restore the committed files (git checkout -- assets/liquid-glass), or regenerate them with node scripts/liquid-glass/install-scene.mjs --from-committed and commit them with the manifest, then publish again."

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{ print $1 }'
  else
    shasum -a 256 -- "$1" | awk '{ print $1 }'
  fi
}

if [[ ! -f "$manifest" ]]; then
  echo "FATAL: scripts/liquid-glass/scene-files.sha256 is missing, so the scene files cannot be checked. $how" >&2
  exit 1
fi

for name in scene-light.jpg scene-dark.jpg; do
  file="assets/liquid-glass/$name"
  if [[ ! -f "$file" ]]; then
    echo "FATAL: $file is missing: the update would not bundle the Liquid Glass scene. $how" >&2
    exit 1
  fi
  committed="$(git rev-parse --verify --quiet "HEAD:$prefix$file" || true)"
  if [[ -z "$committed" ]]; then
    echo "FATAL: $file is not committed: only a committed scene file may ship. $how" >&2
    exit 1
  fi
  if [[ "$(git hash-object -- "$file")" != "$committed" ]]; then
    echo "FATAL: $file differs from the committed file: only a committed scene file may ship. $how" >&2
    exit 1
  fi
  pinned="$(awk -v path="$prefix$file" '$2 == path { print $1 }' "$manifest")"
  if [[ -z "$pinned" || "$(sha256_of "$file")" != "$pinned" ]]; then
    echo "FATAL: $file is not the file scripts/liquid-glass/scene-files.sha256 pins. $how" >&2
    exit 1
  fi
done
