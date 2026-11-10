#!/bin/bash
# A test-channel OTA, for proving phone-update behaviour on a simulator
# (docs/runbooks/mobile-ota.md, "Prove phone-update behaviour on a
# simulator"). Never production: it refuses the production and preview
# channels, publishes iOS only and uploads no source maps.
#
# The Liquid Glass rollout is named as for `pnpm release:ota`, through the same
# checks (scripts/liquid-glass-rollout.sh): the simulator-ota-test build
# embeds default, and a test update without the flag would turn it to classic.
#
# Usage: EXPO_PUBLIC_LIQUID_GLASS=<rollout> bash scripts/release-ota-test.sh ota-test    (--auto)
#        EXPO_PUBLIC_LIQUID_GLASS=<rollout> bash scripts/release-ota-test.sh ota-test --message "text"
#   <rollout> is off, opt-in or default: default to prove what phones get at G3.
set -euo pipefail
cd "$(dirname "$0")/.."

channel="${1:-}"
case "$channel" in
  '' | production | preview)
    echo "FATAL: give a test channel such as ota-test; never production or preview." >&2
    exit 1
    ;;
esac
# Read-only: a line in .env.local that changed it would publish elsewhere.
readonly channel
shift

source scripts/liquid-glass-rollout.sh
# Taken from the caller BEFORE .env.local is loaded.
lg_rollout_take "bash scripts/release-ota-test.sh"

# The Liquid Glass scene illustrations only as the committed, pinned files.
bash scripts/refuse-uncommitted-scene.sh

if [[ ! -f .env.local ]]; then
  echo "FATAL: apps/mobile/.env.local missing: the update would bundle without the app's public settings." >&2
  exit 1
fi
lg_rollout_refuse_env_file "bash scripts/release-ota-test.sh"
# Loaded into the shell, never printed. With --environment production,
# eas-cli turns off Expo's own .env loading, and supabase.ts stops without its
# two public values.
set -a; source .env.local; set +a
# The caller's value, whatever .env.local did, exported and printed.
lg_rollout_export

if [[ $# -gt 0 ]]; then
  pnpm dlx eas-cli@20.3.0 update --channel "$channel" --environment production --platform ios --non-interactive "$@"
else
  pnpm dlx eas-cli@20.3.0 update --channel "$channel" --environment production --platform ios --non-interactive --auto
fi

# The runbook's host check ("Verify after publishing", step 3): the bundle
# names no lab or local host.
hits=$(cat dist/_expo/static/js/ios/entry-*.hbc | grep -a -c -E '127\.0\.0\.1:[0-9]|localhost:(3000|5[0-9]{4})([^0-9]|$)' || true)
if [[ "$hits" != "0" ]]; then
  echo "FATAL: the bundle published to $channel names a lab or local host ($hits). Only $channel received it: publish a good update there." >&2
  exit 1
fi

echo "Test update published to $channel (iOS only, no source maps)."
