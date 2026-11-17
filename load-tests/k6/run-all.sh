#!/usr/bin/env bash
# Run the single-purpose k6 scenarios one after another against a LOCAL app.
#
# For a measured ladder with seeding, database snapshots, a correctness check
# and a report, use run-scale.mjs instead (see load-tests/README.md).
#
# Needs the same environment as run-scale.mjs (an env file outside the
# repository, loaded without printing) plus LOADTEST_MANIFEST, the manifest of
# an organization seeded with tools/seed.mjs:
#
#   set -a; . <loadtest env file>; set +a
#   LOADTEST_MANIFEST=<manifest.json> ./load-tests/k6/run-all.sh
#
# Every scenario refuses an address that is not this machine (lib/safety.js)
# in its first lines, before any request.
set -u

cd "$(dirname "$0")/../.." || exit 1

if [ -z "${LOADTEST_MANIFEST:-}" ]; then
  echo "LOADTEST_MANIFEST is required: seed an organization first (node load-tests/k6/tools/seed.mjs)." >&2
  exit 1
fi

mkdir -p load-tests/results
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
  out="load-tests/results/${name}-${ts}.json"
  echo "----"
  echo "Running $script"
  export K6_NO_USAGE_REPORT=true LOADTEST_SUMMARY_OUT="$out"
  if ! k6 run --summary-export "$out.export" "$script"; then
    echo "  (scenario $name failed a threshold or stopped)"
    status=1
  fi
done

echo "----"
echo "Done. Summaries in load-tests/results/"
exit "$status"
