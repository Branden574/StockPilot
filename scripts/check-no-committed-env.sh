#!/usr/bin/env bash
#
# Fails if any *tracked* file looks like a real env file with secrets.
# Allows example/template files (.env.example, .env.*.example).
#
# Matched (forbidden) examples:
#   .env.local        apps/web/.env.local
#   .env.production   .env.prod        .env.staging.prod
#   .env.local.bak    .env.local.old
#
# Allowed (template) examples:
#   .env.example      apps/web/.env.example      .env.local.example
#
# Uses `git ls-files` so only committed/tracked files are checked — untracked
# local env files on a developer machine never fail CI.

set -euo pipefail

# Tracked files whose basename starts with `.env` (covers nested dirs too).
# Read into an array without `mapfile` so this runs on bash 3.2 (macOS) too.
env_files=()
while IFS= read -r line; do
  [[ -n "$line" ]] && env_files+=("$line")
done < <(git ls-files | grep -E '(^|/)\.env[^/]*$' || true)

offenders=()
for f in "${env_files[@]:-}"; do
  [[ -z "$f" ]] && continue
  base="$(basename "$f")"

  # Allow templates: *.example anywhere in the suffix (e.g. .env.example,
  # .env.local.example, .env.production.example).
  if [[ "$base" == *.example ]]; then
    continue
  fi

  # Forbid real env files:
  #   .env.local / .env.local.* (e.g. .env.local.bak)
  #   .env*.prod / .env*.production / .env*.staging  (prod-like secret files)
  if [[ "$base" =~ ^\.env\.local(\..*)?$ ]] \
    || [[ "$base" =~ ^\.env.*\.prod$ ]] \
    || [[ "$base" =~ ^\.env.*\.production$ ]] \
    || [[ "$base" == .env ]] \
    || [[ "$base" == .env.production ]]; then
    offenders+=("$f")
  fi
done

if [[ ${#offenders[@]} -gt 0 ]]; then
  echo "ERROR: real env file(s) are committed to the repository:" >&2
  for f in "${offenders[@]}"; do
    echo "  - $f" >&2
  done
  echo "" >&2
  echo "Remove them from git history and commit only .env.example templates." >&2
  echo "  git rm --cached <file>   # untrack but keep locally" >&2
  exit 1
fi

echo "OK: no real .env secret files are tracked."
