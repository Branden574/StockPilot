#!/bin/bash
# OTA release = publish + source-map upload, as ONE command (`pnpm release:ota`).
#
# Why both steps must travel together (2026-07-06 incident):
#  - `eas update` bundles EXPO_PUBLIC_* from the LOCAL env (.env.local →
#    ~/Developer/stockpilot-env/apps/mobile/.env.local), NOT from eas.json —
#    an update published without that file silently ships a Sentry no-op.
#  - The update's source maps only exist in ./dist on THIS machine right
#    after publishing; skip the upload and every crash from this update is
#    minified gibberish. (Store builds are separate: EAS builders upload
#    their own maps via the SENTRY_AUTH_TOKEN secret.)
#
# The Liquid Glass rollout, EXPO_PUBLIC_LIQUID_GLASS, is inlined into the
# bundle, so every update decides the look of every phone it reaches. It comes
# ONLY from the command that runs this script, and must be named every time:
#   off      classic for everyone (every stored choice kept);
#   opt-in   classic unless the person chose Liquid Glass;
#   default  Liquid Glass unless the person chose Classic.
# Anything else, unset and empty included, is refused: the app would read it
# as off, and an update that forgets the flag would turn every phone back to
# classic. An .env.local that names it is refused too (it would override the
# command), and the value the command gave is exported again after .env.local
# is loaded, so nothing in that file can change what reaches `eas update`.
# (EAS server-side variables of the production environment would still win
# over the shell: none may set it; docs/runbooks/mobile-ota.md.)
#
# Usage: EXPO_PUBLIC_LIQUID_GLASS=<rollout> pnpm release:ota
#          (message defaults to the git commit)
#        EXPO_PUBLIC_LIQUID_GLASS=<rollout> pnpm release:ota -m "text"
#          (explicit update message)
#   <rollout> is off, opt-in or default: the rollout phones have now (the
#   last production update printed it at the top of its log), unless this
#   update is the one meant to change it (docs/runbooks/mobile-ota.md).
set -euo pipefail
cd "$(dirname "$0")/.."

# Taken from the caller BEFORE .env.local is loaded.
rollout_given="${EXPO_PUBLIC_LIQUID_GLASS+given}"
rollout="${EXPO_PUBLIC_LIQUID_GLASS-}"
case "$rollout" in
  off | opt-in | default) ;;
  *)
    if [[ -z "$rollout_given" ]]; then
      why="it is not set"
    elif [[ -z "$rollout" ]]; then
      why="it is empty"
    else
      why="'$rollout' is not one of them"
    fi
    echo "FATAL: name the Liquid Glass rollout this update ships with: EXPO_PUBLIC_LIQUID_GLASS=off, opt-in or default before pnpm release:ota ($why). Without it the update would turn every phone it reaches to classic." >&2
    exit 1
    ;;
esac

# The Liquid Glass scene illustrations ship only as the committed files the
# manifest pins: refused when one is missing or differs.
bash scripts/refuse-uncommitted-scene.sh

if [[ ! -f .env.local ]]; then
  echo "FATAL: apps/mobile/.env.local missing — the OTA would ship without the Sentry DSN." >&2
  exit 1
fi
# Only whether a line outside a comment names it; nothing from the file is
# printed. 0: named; 1: not named; anything else: the file could not be read.
named=0
grep -Eq '^[^#]*(^|[^A-Za-z0-9_])EXPO_PUBLIC_LIQUID_GLASS([^A-Za-z0-9_]|$)' .env.local || named=$?
if [[ "$named" == "0" ]]; then
  echo "FATAL: apps/mobile/.env.local sets EXPO_PUBLIC_LIQUID_GLASS. Remove that line: the rollout comes only from the command (EXPO_PUBLIC_LIQUID_GLASS=off, opt-in or default pnpm release:ota)." >&2
  exit 1
elif [[ "$named" != "1" ]]; then
  echo "FATAL: apps/mobile/.env.local could not be read to check it does not set EXPO_PUBLIC_LIQUID_GLASS." >&2
  exit 1
fi
set -a; source .env.local; set +a
: "${EXPO_PUBLIC_SENTRY_DSN:?FATAL: EXPO_PUBLIC_SENTRY_DSN not in .env.local — refusing to publish a Sentry-blind update}"
: "${SENTRY_AUTH_TOKEN:?FATAL: SENTRY_AUTH_TOKEN not in .env.local — source maps could not be uploaded}"
# The caller's value, whatever .env.local did.
export EXPO_PUBLIC_LIQUID_GLASS="$rollout"
echo "Liquid Glass rollout in this update: EXPO_PUBLIC_LIQUID_GLASS=$EXPO_PUBLIC_LIQUID_GLASS"

# `--environment production` is REQUIRED, not decorative: eas-cli refuses to
# run `update` non-interactively without it, so omitting it fails the whole
# release rather than defaulting. It selects the same EAS environment the
# production BUILD profile uses (eas.json -> build.production.environment), so
# an OTA and a store build resolve server-side env vars identically. Publishing
# an update under a different environment than the binary was built with is how
# an OTA silently changes an API base URL underneath a shipped app.
if [[ $# -gt 0 ]]; then
  pnpm dlx eas-cli@20.3.0 update --channel production --environment production --non-interactive "$@"
else
  pnpm dlx eas-cli@20.3.0 update --channel production --environment production --non-interactive --auto
fi

pnpm dlx @sentry/cli sourcemaps upload \
  --org "${SENTRY_ORG:?}" --project "${SENTRY_PROJECT:?}" \
  dist/_expo/static/js

echo "OTA published + source maps uploaded."
