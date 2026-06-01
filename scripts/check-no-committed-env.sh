#!/usr/bin/env bash
#
# Fails if any *tracked* file looks like a real env file with secrets.
#
# DEFAULT-DENY (allow-list inversion): any tracked file whose basename names an
# env file is treated as a secret UNLESS it is an explicit template. This is the
# policy mandated by the 2026-05-17 incident postmortem (.gitignore lines 35-39):
# match "every plausible env-file shape regardless of suffix order". A
# forbid-list of specific suffixes (e.g. only *.prod / *.production / *.local)
# fails open on the next near-identical name — e.g. .env.production.local (the
# canonical Next.js production-secrets file), .env.staging, .env.secret — so we
# invert: forbid by default, allow only templates.
#
# An "env file" basename is exactly `.env` or begins with `.env.` (any suffix
# order) — e.g. .env, .env.local, .env.production.local, .env.prod.bak. This
# mirrors .gitignore's `.env` / `.env.*` patterns and excludes source modules
# that merely contain "env" (env.ts, environment.ts, next-env.d.ts).
#
# Allowed (template) basenames — the ONLY exceptions:
#   *.example or *.sample   (e.g. .env.example, .env.local.example,
#                            .env.production.example, .env.staging.sample)
#
# Forbidden (real secret) examples — all of these now fail:
#   .env  .env.local  .env.production  .env.production.local  .env.prod.local
#   .env.development.local  .env.test.local  .env.staging  .env.secret  .env.dev
#   .env.live  .env.vercel  .env.local.bak  .env.staging.prod
#
# Uses `git ls-files` so only committed/tracked files are checked — untracked
# local env files on a developer machine never fail CI.

set -euo pipefail

# Tracked dotenv files: basename is exactly `.env` or begins with `.env.`
# (covers nested dirs too). The authoritative per-file check below re-verifies.
# Read into an array without `mapfile` so this runs on bash 3.2 (macOS) too.
env_files=()
while IFS= read -r line; do
  [[ -n "$line" ]] && env_files+=("$line")
done < <(git ls-files | grep -E '(^|/)\.env(\..*)?$' || true)

offenders=()
for f in "${env_files[@]:-}"; do
  [[ -z "$f" ]] && continue
  base="$(basename "$f")"

  # Only consider real dotenv files: a basename that is exactly `.env` or
  # begins with `.env.` (any suffix order). This mirrors .gitignore's
  # `.env` / `.env.*` patterns and the 2026-05-17 postmortem mandate, while
  # excluding source modules that merely contain "env" (e.g. `env.ts`,
  # `environment.ts`, `next-env.d.ts`).
  if [[ "$base" != .env && "$base" != .env.* ]]; then
    continue
  fi

  # Allow templates ONLY: a basename ending in `.example` or `.sample`,
  # regardless of suffix order (e.g. .env.example, .env.production.example,
  # .env.local.sample). Everything else that names an env file is a secret.
  if [[ "$base" == *.example || "$base" == *.sample ]]; then
    continue
  fi

  offenders+=("$f")
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
