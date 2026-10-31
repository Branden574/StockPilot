#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# dev-prod.sh — stop the local Supabase stack after a dev-local.sh session.
#
# Stops the local Supabase Docker stack to free its ports (54321-54324).
# It writes NOTHING to disk and reads no env file: apps/web/.env.local is
# left exactly as it is. It does not change which Supabase project the dev
# server uses; that is whatever apps/web/.env.local names. Since SP-030,
# dev-local.sh overrides Supabase in its own process only, but a run of the
# version before SP-030 rewrote that file to name the local stack, and
# nothing writes it back. So the file can still name the stack this script
# stops, and the output says only what the script knows.
#
# ── WHY THIS SCRIPT NO LONGER COPIES .env.local.prod (B19) ───────────────
# It used to "restore" the dev env with `cp "$WEB_ENV_PROD" "$WEB_ENV"`.
# apps/web/.env.local is a SYMLINK into the env folder outside the repo
# (~/Developer/stockpilot-env, since 2026-06-26), and cp writes THROUGH a
# symlink: one run replaced the CANONICAL env file with the older backup and
# dropped every key the backup lacked. That is the same loss SP-030 fixed in
# dev-local.sh. With plain files instead of links the copy did the same
# damage. So the copy is gone, in every layout, and stopping the stack no
# longer depends on the backup existing. To reach the hosted project while
# the file names the local stack, export the hosted values in the dev
# server's own process (the way dev-local.sh exports the local ones) rather
# than copying over or editing the file.
#
# Guarded by apps/web/src/test/dev-prod-script.test.ts, which runs this
# script in a throwaway repo (env files as links, as plain files, with no
# backup, as a dangling link, and with .env.local naming the local stack).
# It asserts every env file and link comes out unchanged, and that the
# output claims nothing about which project the dev server reaches. If you
# ever reintroduce a write here, that test fails.
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

echo "→ Stopping local Supabase stack (frees ports 54321-54324)"
cd "$ROOT"
supabase stop || echo "  (already stopped)"

# The file is never read here, so the script cannot know which project a
# dev server reaches next. It says what decides that instead.
echo ""
echo "✓ Local Supabase stack stopped. apps/web/.env.local is unchanged."
echo "  The dev server uses whichever Supabase project that file names."
echo "  If it names the local stack (http://127.0.0.1:54321), the dev server"
echo "  cannot reach Supabase while that stack is stopped. To use your hosted"
echo "  project instead, export its values in the dev server's own process,"
echo "  as dev-local.sh does for the local stack, rather than editing the file."
