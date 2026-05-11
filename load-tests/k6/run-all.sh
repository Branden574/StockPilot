#!/usr/bin/env bash
# Run every k6 scenario sequentially against $BASE_URL.
#
# Each scenario writes a JSON summary to load-tests/results/ named by
# scenario + timestamp. Failures don't abort — we still want to see
# results from the scenarios that DID succeed.
#
# Required env: BASE_URL, plus per-scenario auth env (see each script
# header comment).
#
# Run:
#   BASE_URL=https://preview-xxx.vercel.app \
#     SUPABASE_ACCESS_TOKEN=... \
#     SUPABASE_AUTH_COOKIE='...' \
#     ITEM_IDS=... SHIPMENT_IDS=... \
#     ./load-tests/k6/run-all.sh

set -u

if [ -z "${BASE_URL:-}" ]; then
  echo "BASE_URL is required" >&2
  exit 1
fi

# Hard-stop on prod unless explicitly opted in. Saves you from
# muscle-memory disasters.
if [[ "$BASE_URL" == *"stockpilotusa.com"* ]] && [ "${ALLOW_PROD:-0}" != "1" ]; then
  echo "Refusing to load-test against production ($BASE_URL)." >&2
  echo "If you really mean it: ALLOW_PROD=1 ./load-tests/k6/run-all.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/../.." || exit 1

mkdir -p load-tests/results
ts="$(date +%Y%m%d-%H%M%S)"

scenarios=(
  "01-anon-marketing"
  "02-signin"
  "03-inventory-list"
  "04-search-palette"
  "05-item-detail"
  "06-inventory-write"
  "07-procedure-list"
  "08-shipment-detail"
)

for name in "${scenarios[@]}"; do
  script="load-tests/k6/scenarios/${name}.js"
  out="load-tests/results/${name}-${ts}.json"
  echo "----"
  echo "Running $script"
  echo "Summary -> $out"
  k6 run --summary-export "$out" "$script" || echo "  (scenario $name failed or was skipped)"
done

echo "----"
echo "Done. Summaries in load-tests/results/"
