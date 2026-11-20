#!/usr/bin/env bash
# The single-purpose k6 scenarios, one after another. It runs ONLY inside
# run-scale.mjs, which starts the built app itself under the outbound guard
# with the clean app env, seeds the organization the scenarios read, sets
# LOADTEST_MANIFEST and the other LOADTEST_* settings, then starts this script
# and checks the data afterwards:
#
#   node --env-file=<loadtest env file> load-tests/k6/run-scale.mjs \
#     --app-env <app env file> --all-scenarios
#
# Started any other way it refuses: no scenario runs against an app started
# by hand (06 places orders, and a hand-started app could send their email).
# Every scenario also refuses an address that is not this machine
# (lib/safety.js) in its first lines, before any request.
set -u

# Only the runner: it sets LOADTEST_RUNNER_PID to its own process id and is
# this script's parent.
runner_cmd="$(ps -o command= -p "$PPID" 2>/dev/null || true)"
if [ -z "${LOADTEST_RUNNER_PID:-}" ] || [ "${LOADTEST_RUNNER_PID}" != "$PPID" ] ||
  [[ "$runner_cmd" != *"load-tests/k6/run-scale.mjs"* ]]; then
  echo "use load-tests/k6/run-scale.mjs --scenario <name> (or --all-scenarios): run-all.sh runs only inside the runner, which starts the app under the outbound guard." >&2
  exit 2
fi

cd "$(dirname "$0")/../.." || exit 1

if [ -z "${LOADTEST_MANIFEST:-}" ]; then
  echo "LOADTEST_MANIFEST is required: seed an organization first (node load-tests/k6/tools/seed.mjs)." >&2
  exit 1
fi

results="${LOADTEST_RESULTS_DIR:-load-tests/results}"
mkdir -p "$results"
ts="$(date +%Y%m%d-%H%M%S)"

scenarios=(
  "01-anon-marketing"
  "03-inventory-list"
  "04-search-palette"
  "05-item-detail"
  "06-inventory-write"
  "07-procedure-list"
)

status=0
for name in "${scenarios[@]}"; do
  script="load-tests/k6/scenarios/${name}.js"
  out="${results}/${name}-${ts}.json"
  echo "----"
  echo "Running $script"
  # K6_CONSOLE_OUTPUT: each adjust's token log, for the runner's data check.
  export K6_NO_USAGE_REPORT=true LOADTEST_SUMMARY_OUT="$out" K6_CONSOLE_OUTPUT="$out.console"
  if ! k6 run --summary-export "$out.export" "$script"; then
    echo "  (scenario $name failed a threshold or stopped)"
    status=1
  fi
done

echo "----"
echo "Done. Summaries in ${results}/"
exit "$status"
