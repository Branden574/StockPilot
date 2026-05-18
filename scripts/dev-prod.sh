#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# dev-prod.sh — point the web app back at hosted Supabase.
#
# Restores apps/web/.env.local from the backup at .env.local.prod and
# stops the local Supabase Docker stack to free the ports.
#
# Use when you want the dev server to talk to your real hosted project
# (the one you've been using all along). dev-local.sh swaps back.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_ENV="$ROOT/apps/web/.env.local"
WEB_ENV_PROD="$ROOT/apps/web/.env.local.prod"

if [ ! -f "$WEB_ENV_PROD" ]; then
  echo "✗ $WEB_ENV_PROD missing — nothing to restore from."
  echo "  If you have hosted-Supabase keys, paste them into $WEB_ENV manually,"
  echo "  then re-run this script to also stop the local stack."
  exit 1
fi

echo "→ Restoring $WEB_ENV from $WEB_ENV_PROD"
cp "$WEB_ENV_PROD" "$WEB_ENV"

echo "→ Stopping local Supabase stack (frees ports 54321-54324)"
cd "$ROOT"
supabase stop || echo "  (already stopped)"

echo ""
echo "✓ Hosted dev ready."
echo "  Run 'pnpm --filter @stockpilot/web dev' to start."
