#!/usr/bin/env bash
#
# Two-session proof for migration 0373's push-time lock order. pgTAP runs in
# ONE session and after the migration is applied, so it cannot show what
# happens while the push and a stock write hold locks at the same time.
#
# The push adds a column to stock_movements (ACCESS EXCLUSIVE until COMMIT)
# and then creates the scope-cache forget triggers on locations,
# organization_members, user_warehouse_assignments, user_profiles and
# warehouses (SHARE ROW EXCLUSIVE on each). User paths take ROW EXCLUSIVE on
# stock_movements and on those tables in BOTH orders:
#   * locations, then stock_movements: every null-location increment
#     (ensure_*_placement_locations, then the movement insert);
#   * stock_movements, then locations: the pre-0373 return restock (the
#     movement insert, then its ensure_*), kept as a shape any future path
#     may take;
#   * a membership write and a movement in one transaction, either order.
# Without a lock prelude, a +1 in flight when the push starts deadlocks: the
# push holds stock_movements and waits for locations, the +1 holds locations
# and waits for stock_movements (40P01, which PostgREST does not retry).
#
# The migration's prelude (the `do $lock$ ... end $lock$;` block, extracted
# from the file below) waits for stock_movements while holding nothing, then
# takes the other five NOWAIT, so the push never waits while holding a lock a
# user transaction needs. The only failure left is 55P03 (retry the push).
#
# Each scenario runs the migration's own statement shapes (a probe column and
# probe triggers, rolled back) against a user write. Checks: no session ever
# sees 40P01, the user write always completes, and the push either completes
# or fails with 55P03.
#
# The push also runs the migration's OWN stamp-trigger statement, extracted
# from the file (CREATE OR REPLACE TRIGGER). On Supabase, supautils makes a
# DROP TRIGGER run as postgres take ACCESS EXCLUSIVE on every auth, storage
# and realtime table in supautils.drop_trigger_grants, and wait for them,
# after the prelude. auth.users' triggers write user_profiles, so:
#   * s6: a transaction that read auth.users and then writes user_profiles
#     deadlocks a DROP TRIGGER push (it waits for auth.users while holding
#     user_profiles);
#   * s7: any auth reader holds a DROP TRIGGER push for up to lock_timeout
#     (5 s, then 55P03) while it holds stock_movements. s7 requires the push
#     to COMPLETE.
#
# MUTATION RECORD (live, lean 0373; each killed, the file's prelude green
# three runs in a row):
#   no prelude                                              -> s1, s3, s4 (40P01)
#   stock_movements, then the five WITHOUT nowait           -> s1, s4 (40P01)
#   the five (nowait) first, then stock_movements           -> s2, s5 (40P01)
#   the stamp trigger as DROP TRIGGER + CREATE TRIGGER      -> s6 (40P01), s7 (55P03)
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures live under the 03731111-... namespace and are removed at the start
# and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0373_push_lock_order.sh
#        PRELUDE='<sql>' bash ...   (override the prelude, for mutation runs)
#        STAMP='<sql>' bash ...     (override the stamp-trigger statement)

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
if [ -z "${STAMP+x}" ]; then
  STAMP="$(awk '/^(drop|create( or replace)?) trigger trg_zz_stock_movements_via_ledger/{on=1} on{print} on && /execute function public\.tg_stock_movements_via_ledger\(\);/{exit}' "$MIGRATION")"
fi
if [ -z "$STAMP" ]; then echo "no stamp-trigger statement found in $MIGRATION"; exit 1; fi

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
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

# The push: the migration's prelude, then its ADD COLUMN and forget-trigger
# shapes. The sleep stands in for the rest of the file.
push_sql() {
  cat <<SQL
begin;
set lock_timeout = '5s';
$PRELUDE
alter table public.stock_movements add column draw_0373_2s integer;
$STAMP
select pg_sleep(1.5);
create trigger trg_0373_2s_probe after insert or update or delete on public.organization_members
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_0373_2s_probe after insert or update or delete on public.user_warehouse_assignments
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_0373_2s_probe after update of disabled_at on public.user_profiles
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_0373_2s_probe after update of organization_id on public.warehouses
  for each statement execute function ledger.tg_forget_draw_scope();
create trigger trg_0373_2s_probe after update of warehouse_id on public.locations
  for each statement execute function ledger.tg_forget_draw_scope();
select 'push done';
rollback;
SQL
}

ENSURE="select public.ensure_warehouse_placement_locations('$WH');"
MOVEMENT="insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, reason)
  values ('$ORG', '$X', 'adjust', 1, 0, 1, '0373 two-session');"
MEMBER="update public.organization_members set role = role where organization_id = '$ORG';"
AUTH_READ="select count(*) from auth.users;"
PROFILE="update public.user_profiles set id = id where false;"

# run_case <name> <user sql> <user first: yes|no> [push must complete: yes]
run_case() {
  local name="$1" user_sql="$2" user_first="$3" must_complete="${4:-no}"
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
  if [ "$must_complete" = yes ]; then
    check "$name: the push completed (it never waits for the auth reader)" "$push" "done"
  elif [ "$push" = done ] || [ "$push" = 55P03 ]; then ok "$name: the push completed or failed fast with 55P03 ($push)"
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

# 2. A write that inserts its movement first reaches locations while the
#    push waits for stock_movements. Taking the five up front deadlocks here.
echo "== 2. movement first (stock_movements, then locations), the write is in flight"
run_case s2 "begin;
$MOVEMENT
select pg_sleep(1);
$ENSURE
select 'user done';
rollback;" yes

# 3. A +1 starts while the push is running.
echo "== 3. increment shape, the write starts during the push"
run_case s3 "begin;
$ENSURE
$MOVEMENT
select 'user done';
rollback;" no

# 4. A membership write, then a movement, in flight.
echo "== 4. membership first (organization_members, then stock_movements), the write is in flight"
run_case s4 "begin;
$MEMBER
select pg_sleep(1);
$MOVEMENT
select 'user done';
rollback;" yes

# 5. A movement, then a membership write, in flight.
echo "== 5. movement first (stock_movements, then organization_members), the write is in flight"
run_case s5 "begin;
$MOVEMENT
select pg_sleep(1);
$MEMBER
select 'user done';
rollback;" yes

# 6. An auth reader that then writes user_profiles (the shape of auth.users'
#    own triggers), in flight: a DROP TRIGGER push would wait for auth.users
#    while holding user_profiles.
echo "== 6. auth.users read, then a user_profiles write, the write is in flight"
run_case s6 "begin;
$AUTH_READ
select pg_sleep(1);
$PROFILE
select 'user done';
rollback;" yes

# 7. A long auth reader (longer than the push's lock_timeout): the push must
#    not wait for it at all.
echo "== 7. a 6 s reader of auth.users, in flight"
run_case s7 "begin;
$AUTH_READ
select pg_sleep(6);
select 'user done';
rollback;" yes yes

if [ "$FAILS" -gt 0 ]; then
  echo "--- session output ---"
  for f in s1 s2 s3 s4 s5 s6 s7; do
    echo "[$f user]"; cat "$TMP/$f.user.out" 2>/dev/null
    echo "[$f push]"; cat "$TMP/$f.push.out" 2>/dev/null
  done
fi

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left behind" \
  "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"
check "cleanup: the probe column and triggers are gone" \
  "$(q "select (not exists (select 1 from pg_attribute where attrelid = 'public.stock_movements'::regclass and attname = 'draw_0373_2s' and not attisdropped) and not exists (select 1 from pg_trigger where tgname = 'trg_0373_2s_probe'))::text")" "true"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all two-session checks passed"
