#!/bin/bash
# A test-channel OTA, for proving phone-update behaviour on a simulator
# (docs/runbooks/mobile-ota.md, "Prove phone-update behaviour on a
# simulator"). Never production: it refuses the production and preview
# channels, publishes iOS only and uploads no source maps.
#
# Usage: bash scripts/release-ota-test.sh ota-test                  (--auto)
#        bash scripts/release-ota-test.sh ota-test --message "text"
set -euo pipefail
cd "$(dirname "$0")/.."

channel="${1:-}"
case "$channel" in
  '' | production | preview)
    echo "FATAL: give a test channel such as ota-test; never production or preview." >&2
    exit 1
    ;;
esac
shift

if [[ ! -f .env.local ]]; then
  echo "FATAL: apps/mobile/.env.local missing: the update would bundle without the app's public settings." >&2
  exit 1
fi
# Loaded into the shell, never printed. With --environment production,
# eas-cli turns off Expo's own .env loading, and supabase.ts stops without its
# two public values.
set -a; source .env.local; set +a

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
