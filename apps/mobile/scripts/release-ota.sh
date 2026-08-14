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
# Usage: pnpm release:ota            (message defaults to the git commit)
#        pnpm release:ota -m "text"  (explicit update message)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "FATAL: apps/mobile/.env.local missing — the OTA would ship without the Sentry DSN." >&2
  exit 1
fi
set -a; source .env.local; set +a
: "${EXPO_PUBLIC_SENTRY_DSN:?FATAL: EXPO_PUBLIC_SENTRY_DSN not in .env.local — refusing to publish a Sentry-blind update}"
: "${SENTRY_AUTH_TOKEN:?FATAL: SENTRY_AUTH_TOKEN not in .env.local — source maps could not be uploaded}"

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
