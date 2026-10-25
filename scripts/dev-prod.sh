#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# dev-prod.sh — stop the local Supabase stack after a dev-local.sh session.
#
# Stops the local Supabase Docker stack to free its ports (54321-54324).
# It writes NOTHING to disk: apps/web/.env.local is left exactly as it is.
# dev-local.sh never changes that file (it overrides Supabase in its own
# process only, SP-030), so the normal dev command already talks to your
# hosted project.
#
# ── WHY THIS SCRIPT NO LONGER COPIES .env.local.prod (B19) ───────────────
# It used to "restore" the dev env with `cp "$WEB_ENV_PROD" "$WEB_ENV"`.
# apps/web/.env.local is a SYMLINK into the env folder outside the repo
# (~/Developer/stockpilot-env, since 2026-06-26), and cp writes THROUGH a
# symlink: one run replaced the CANONICAL env file with the older backup and
# dropped every key the backup lacked. That is the same loss SP-030 fixed in
# dev-local.sh. With plain files instead of links the copy did the same
# damage. And there was nothing left to restore: dev-local.sh stopped
# writing .env.local in SP-030. So the copy is gone, in every layout, and
# stopping the stack no longer depends on the backup existing.
#
# Guarded by apps/web/src/test/dev-prod-script.test.ts, which runs this
# script in a throwaway repo (env files as links, as plain files, with no
# backup, and as a dangling link) and asserts every env file and link comes
# out unchanged. If you ever reintroduce a write here, that test fails.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_ENV="$ROOT/apps/web/.env.local"

# Only the path is tested (-L reads the link, never the file it points at).
if [ -L "$WEB_ENV" ]; then
  echo "→ Leaving apps/web/.env.local alone: it is a link into your env folder,"
  echo "  and this script never writes through a link."
else
  echo "→ Leaving apps/web/.env.local alone: this script never writes an env file."
fi
echo "  dev-local.sh never changes it, so there is nothing to restore."

echo "→ Stopping local Supabase stack (frees ports 54321-54324)"
cd "$ROOT"
supabase stop || echo "  (already stopped)"

echo ""
echo "✓ Hosted dev ready."
echo "  Run 'pnpm --filter @stockpilot/web dev' to start."
