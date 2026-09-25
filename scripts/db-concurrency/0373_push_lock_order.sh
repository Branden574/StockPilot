#!/usr/bin/env bash
#
# Two-session proof for migration 0373's push-time lock order. pgTAP runs in
# ONE session and after the migration is applied, so it cannot show what
# happens while the push and a stock write hold locks at the same time.
#
# The push builds a unique index on stock_movements (SHARE until COMMIT) and
# then creates a table with foreign keys to stock_movements and locations
# (SHARE ROW EXCLUSIVE on both). User paths take ROW EXCLUSIVE on those two
# tables in BOTH orders:
#   * locations, then stock_movements: every null-location increment
#     (ensure_*_placement_locations, then the movement insert);
#   * stock_movements, then locations: process_return_disposition (the
#     movement insert, then the restock's ensure_*).
# Without a lock prelude, a +1 that starts during the index build takes
# locations, waits for stock_movements behind the push, and the push then
# waits for locations: deadlock (40P01), which PostgREST does not retry and
# the push runbook did not expect. Taking both locks up front in one fixed
# order does not fix it either (the return shape then deadlocks).
#
# The migration's prelude (the `do $lock$ ... end $lock$;` block, extracted
# from the file below) waits for stock_movements while holding nothing, then
# takes locations NOWAIT, so the push never waits while holding a lock a user
# transaction needs. The only failure left is 55P03 (retry the push).
#
# Each scenario runs the migration's own statement shapes (renamed, rolled
# back) against a user write. Checks: no session ever sees 40P01, the user
# write always completes, and the push either completes or fails with 55P03.
#
# MUTATION RECORD (live, 2026-09-25; each killed, the file's prelude green
# three runs in a row):
#   no prelude (the reviewed file)                          -> s1, s3 (40P01)
#   lock locations, stock_movements up front, both waiting  -> s2 (40P01)
#   stock_movements, then locations WITHOUT nowait          -> s1 (40P01)
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures live under the 03731111-... namespace and are removed at the start
# and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0373_push_lock_order.sh
#        PRELUDE='<sql>' bash ...   (override the prelude, for mutation runs)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -At)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/0373_draw_provenance.sql"

ORG='03731111-0000-0000-0000-00000000000a'
WH='03731111-0000-0000-0000-0000000000b1'
X='03731111-0000-0000-0000-0000000000c1'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }

if [ -z "${PRELUDE+x}" ]; then
  PRELUDE="$(awk '/^do \$lock\$/{on=1} on{print} /^end \$lock\$;/{on=0}' "$MIGRATION")"
fi
if [ -z "$PRELUDE" ]; then
  echo "note: no lock prelude in $MIGRATION (running the bare statement order)"
fi

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop table if exists public.smh_0373_2s;
drop index if exists public.smh_0373_2s_key;
delete from public.stock_movements where organization_id = '$ORG';
delete from public.item_stock_levels where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.locations where organization_id = '$ORG';
delete from public.warehouses where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into public.organizations (id, name, slug) values ('$ORG', '0373 Two Session Org', '0373-two-session');
insert into public.warehouses (id, organization_id, name, code, status)
  values ('$WH', '$ORG', '0373 2S Main', 'WH-0373-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status)
  values ('$X', '$ORG', '$WH', '2S item X', 'SKU-0373-2S-X', 0, 'active');
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# The push: the migration's prelude, then its index and table shapes. The
# sleep stands in for the index build on production's stock_movements.
push_sql() {
  cat <<SQL
begin;
set lock_timeout = '5s';
$PRELUDE
create unique index smh_0373_2s_key on public.stock_movements (id, organization_id, item_id);
select pg_sleep(1.5);
create table public.smh_0373_2s (
  movement_id     uuid not null,
  organization_id uuid not null,
  item_id         uuid not null,
  location_id     uuid,
  constraint smh_0373_2s_movement_fk foreign key (movement_id, organization_id, item_id)
    references public.stock_movements (id, organization_id, item_id)
    on delete cascade deferrable initially deferred,
  constraint smh_0373_2s_location_fk foreign key (location_id)
    references public.locations (id) on delete set null
);
select 'push done';
rollback;
SQL
}

ENSURE="select public.ensure_warehouse_placement_locations('$WH');"
MOVEMENT="insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, reason)
  values ('$ORG', '$X', 'adjust', 1, 0, 1, '0373 two-session');"

# run_case <name> <user sql> <user first: yes|no>
run_case() {
  local name="$1" user_sql="$2" user_first="$3"
  if [ "$user_first" = yes ]; then
    ( "${PSQL[@]}" > "$TMP/$name.user.out" 2>&1 <<<"$user_sql" ) &
    local pid_u=$!
    sleep 0.3
    ( push_sql | "${PSQL[@]}" > "$TMP/$name.push.out" 2>&1 ) &
    local pid_p=$!
  else
    ( push_sql | "${PSQL[@]}" > "$TMP/$name.push.out" 2>&1 ) &
    local pid_p=$!
    sleep 0.3
    ( "${PSQL[@]}" > "$TMP/$name.user.out" 2>&1 <<<"$user_sql" ) &
    local pid_u=$!
  fi
  wait "$pid_u" "$pid_p"

  check "$name: no session hit a deadlock (40P01)" \
    "$(cat "$TMP/$name.user.out" "$TMP/$name.push.out" | grep -c 40P01)" "0"
  check "$name: the user write completed" "$(grep -c '^user done$' "$TMP/$name.user.out")" "1"
  local push
  if grep -q '^push done$' "$TMP/$name.push.out"; then push=done
  elif grep -q '55P03' "$TMP/$name.push.out" && [ "$(grep -c ERROR "$TMP/$name.push.out")" = 1 ]; then push=55P03
  else push=other; fi
  if [ "$push" = done ] || [ "$push" = 55P03 ]; then ok "$name: the push completed or failed fast with 55P03 ($push)"
  else bad "$name: the push ended some other way"; fi
}

# 1. A null-location +1 is between its ensure_* (locations) and its movement
#    insert when the push starts.
echo "== 1. increment shape (locations, then stock_movements), the write is in flight"
run_case s1 "begin;
$ENSURE
select pg_sleep(1);
$MOVEMENT
select 'user done';
rollback;" yes

# 2. A return restock has inserted its movement and reaches its ensure_*
#    while the push waits for stock_movements. Taking both locks up front
#    (locations first) deadlocks here.
echo "== 2. return shape (stock_movements, then locations), the write is in flight"
run_case s2 "begin;
$MOVEMENT
select pg_sleep(1);
$ENSURE
select 'user done';
rollback;" yes

# 3. A +1 starts while the push is building the index (the reviewer's
#    window: the whole index build).
echo "== 3. increment shape, the write starts during the index build"
run_case s3 "begin;
$ENSURE
$MOVEMENT
select 'user done';
rollback;" no

if [ "$FAILS" -gt 0 ]; then
  echo "--- session output ---"
  for f in s1 s2 s3; do
    echo "[$f user]"; cat "$TMP/$f.user.out" 2>/dev/null
    echo "[$f push]"; cat "$TMP/$f.push.out" 2>/dev/null
  done
fi

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left behind" \
  "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"
check "cleanup: the probe index and table are gone" \
  "$(q "select (to_regclass('public.smh_0373_2s_key') is null and to_regclass('public.smh_0373_2s') is null)::text")" "true"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all two-session checks passed"
