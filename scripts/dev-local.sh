#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# dev-local.sh — run the web app against the local Supabase Docker stack.
#
#   • Boots `supabase start` (no-op if already running).
#   • Reads the local stack's anon + service-role keys from
#     `supabase status`.
#   • EXPORTS them (plus the localhost app URL) and execs
#     `pnpm --filter @stockpilot/web dev`.
#
# It writes NOTHING to disk. Stop the dev server and the override is gone.
#
# ── WHY THIS SCRIPT NO LONGER TOUCHES ANY .env FILE (SP-030) ─────────────
# apps/web/.env.local and apps/web/.env.local.prod are SYMLINKS into
# ~/Developer/stockpilot-env — the env files moved outside the repo on
# 2026-06-26, and this script predates that move.
#
# The previous version did `cat > "$WEB_ENV"`, which FOLLOWS the symlink and
# rewrote the CANONICAL env file with only the ten keys its heredoc and its
# five-name whitelist knew about. Everything else was silently deleted:
# ANTHROPIC_API_KEY (Claude is the primary AI provider), GOOGLE_BOOKS_API_KEY,
# STOCKPILOT_PLATFORM_ADMIN_EMAILS (the /platform console) and
# VERCEL_OIDC_TOKEN. There was no safety net either — the backup step is
# guarded by `[ ! -f "$WEB_ENV_PROD" ]`, and `-f` follows the symlink to a
# prod backup that has existed since June, so the backup self-skipped. One
# run cost you four secrets with nothing to restore from.
#
# The replacement works because @next/env (node_modules/@next/env, function
# `processEnv`) only adopts a key from a .env file when that key is NOT
# already present in the initial process.env snapshot. Exporting here
# therefore overrides .env.local for THIS dev server only, while every other
# key in the canonical file keeps loading normally. Verified in
# node_modules, not from memory (bug-pattern #12).
#
# Guarded by apps/web/src/test/dev-local-script.test.ts, which runs this
# script against a throwaway repo whose env files are symlinks and asserts
# the canonical file comes out byte-identical. If you ever reintroduce a
# write here, that test fails.
#
# NOTE: scripts/dev-prod.sh is no longer needed to "switch back" — just run
# the normal dev command. Be aware it still does `cp .env.local.prod
# .env.local`, which DOES write through the symlink and would replace your
# canonical env file with the stale ten-key backup.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Ensuring Docker daemon is up"
if ! docker info >/dev/null 2>&1; then
  echo "  Docker isn't running. Launch Docker Desktop and try again."
  exit 1
fi

echo "→ supabase start (no-op if already running)"
cd "$ROOT"
supabase start

# Pull the local anon + service-role JWT keys from `supabase status --output
# env` so we always use the values matching the running stack (Supabase
# rotates them per project_id).
#
# `|| true` on each pipeline: under `set -euo pipefail` a non-matching grep
# would abort the script here with no explanation, skipping the friendly
# error below.
STATUS_ENV="$(supabase status --output env 2>/dev/null || true)"
LOCAL_ANON="$(echo "$STATUS_ENV" | grep '^ANON_KEY=' | sed 's/^ANON_KEY=//;s/^"//;s/"$//' || true)"
LOCAL_SERVICE="$(echo "$STATUS_ENV" | grep '^SERVICE_ROLE_KEY=' | sed 's/^SERVICE_ROLE_KEY=//;s/^"//;s/"$//' || true)"

if [ -z "$LOCAL_ANON" ] || [ -z "$LOCAL_SERVICE" ]; then
  echo "✗ Failed to read local Supabase keys from 'supabase status --output env'."
  exit 1
fi

# Only these four are overridden. Every other key (Anthropic, Google Books,
# Resend, Stripe, platform-admin emails, …) still comes from .env.local,
# untouched and unread by this script. Values are never echoed.
export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$LOCAL_ANON"
export SUPABASE_SERVICE_ROLE_KEY="$LOCAL_SERVICE"
export NEXT_PUBLIC_APP_URL="http://localhost:3000"

echo ""
echo "✓ Local dev ready — Supabase overridden in this process only, no file written."
echo "  Supabase Studio:  http://127.0.0.1:54323"
echo "  Mail catcher:     http://127.0.0.1:54324  (Supabase Auth emails land here)"
echo "  Web app:          http://localhost:3000"
echo ""
echo "  To go back to hosted Supabase: stop this server and run"
echo "  'pnpm --filter @stockpilot/web dev' normally. Do NOT run"
echo "  scripts/dev-prod.sh — it overwrites your canonical .env.local."
echo ""
echo "→ Starting pnpm --filter @stockpilot/web dev"
exec pnpm --filter @stockpilot/web dev
