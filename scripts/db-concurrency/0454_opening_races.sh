#!/usr/bin/env bash
#
# Two-session proof for open_item_stock (opening stock through the stock
# ledger, docket S8). pgTAP runs in ONE session, so it cannot show what two
# openings do when they meet:
#
#   1. Two openings of the same new item at once (two requests of its
#      creator). The first holds the item's row (FOR UPDATE) until it
#      commits; the second waits for that row, then reads the committed item
#      (stock on hand, one movement) and is refused opening_stock_refused.
#      The item ends with the first quantity only: one holding, one
#      movement, on-hand equal to the movement.
#   2. The organization's first Unplaced location, created by two openings at
#      once (two members, two items with no warehouse, an organization with
#      no organization-level Unplaced yet). The second waits on the first's
#      uncommitted Unplaced row, then finds it (ON CONFLICT DO NOTHING and a
#      second read) instead of failing 23505: both items open, both holdings
#      are at the one Unplaced, and the organization has exactly one.
#   3. No session sees 40001 or 40P01.
#
# Runs against a LOCAL stack only (docker container supabase_db_stockpilot by
# default; CONTAINER=<name> for another local stack) with open_item_stock
# applied. Fixtures are committed under the 04545555-... namespace and removed
# at the start, at the end and by the EXIT trap. Exit status 0 = every check
# passed.
#
# Usage: bash scripts/db-concurrency/0454_opening_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04545555-0000-4000-8000-00000000000a'
U1='04545555-0000-4000-8000-0000000000a1'
U2='04545555-0000-4000-8000-0000000000a2'
WH='04545555-0000-4000-8000-0000000000b1'
I1='04545555-0000-4000-8000-000000000101'
N1='04545555-0000-4000-8000-000000000201'
N2='04545555-0000-4000-8000-000000000202'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

wait_for() { # wait_for <application_name> <wait_event_type> [wait_event]
  local _ cond="application_name = '$1' and wait_event_type = '$2'"
  if [ -n "${3:-}" ]; then cond="$cond and wait_event = '$3'"; fi
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where $cond")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.stock_movements where organization_id = '$ORG';
delete from public.item_stock_levels where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.audit_logs where organization_id = '$ORG';
delete from public.user_warehouse_assignments where organization_id = '$ORG';
delete from public.locations where organization_id = '$ORG';
delete from public.warehouses where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$U1', '$U2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.locations where organization_id = '$ORG') + (select count(*) from public.organizations where id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() {
  wait 2>/dev/null
  cleanup >/dev/null 2>&1
  rm -rf "$TMP"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ "$(q "select count(*) from pg_proc where oid = to_regprocedure('public.open_item_stock(uuid,jsonb)')")" != "1" ]; then
  echo "open_item_stock is not applied on this stack"; exit 1
fi
cleanup || exit 1
T_START=$(now_ms)

# open_as <application_name> <user> <item> <quantity> <seconds held after the
# call>: one transaction as that member (authenticated, with claims), which
# opens the item, keeps its locks for the pause, then commits.
open_as() {
  printf '%s\n' \
    "set application_name to '$1';" \
    "begin;" \
    "set local role authenticated;" \
    "set local \"request.jwt.claim.role\" to 'authenticated';" \
    "set local \"request.jwt.claim.sub\" to '$2';" \
    "select 'R=' || count(*) from public.open_item_stock('$ORG', '[{\"itemId\": \"$3\", \"quantity\": $4}]'::jsonb);" \
    "select pg_sleep($5);" \
    "commit;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
st() { # on-hand | holdings | movements | sum of movements
  q "select (select quantity_on_hand::text from public.inventory_items where id = '$1') || '|'
         || coalesce((select sum(quantity)::text from public.item_stock_levels where item_id = '$1'), 'none') || '|'
         || (select count(*) from public.stock_movements where item_id = '$1') || '|'
         || coalesce((select sum(quantity_change)::text from public.stock_movements where item_id = '$1'), '0')"
}

# ═══ Fixture ═══════════════════════════════════════════════════════════════
# Two staff members (staff hold stock:adjust), one warehouse, and three new
# items at 0: I1 in the warehouse (U1's), N1 (U1's) and N2 (U2's) with no
# warehouse. The organization has no organization-level Unplaced yet.
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$U1', '0454-2s-u1@test.local', '{}'::jsonb),
  ('$U2', '0454-2s-u2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0454 Two Session Org', '0454-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$U1', 'staff', now()),
  ('$ORG', '$U2', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0454 2S Main', 'WH-0454-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  ('$ORG', '$U1', '$WH', true),
  ('$ORG', '$U2', '$WH', true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by, created_at) values
  ('$I1', '$ORG', '$WH', 'X0454-I1', 'Opened twice',    0, 'active', 'product', '$U1', now()),
  ('$N1', '$ORG', null,  'X0454-N1', 'No warehouse one', 0, 'active', 'product', '$U1', now()),
  ('$N2', '$ORG', null,  'X0454-N2', 'No warehouse two', 0, 'active', 'product', '$U2', now());
SQL
then
  echo "fixture setup failed"; exit 1
fi
check "0: the organization has no organization-level Unplaced yet" \
  "$(q "select count(*) from public.locations where organization_id = '$ORG' and warehouse_id is null and kind = 'unplaced'")" "0"

# ═══ 1. Two openings of one item at once ══════════════════════════════════
( open_as s1-a "$U1" "$I1" 3 2 > "$TMP/s1-a.out" ) &
wait_for s1-a Timeout PgSleep || bad "1: the first opening never reached its pause"
( open_as s1-b "$U1" "$I1" 4 0 > "$TMP/s1-b.out" ) &
if wait_for s1-b Lock; then ok "1: the second opening waits for the item's row"; else bad "1: the second opening did not wait for the item's row"; fi
wait
check "1: the first opening opened its line" "$(grep -c '^R=1$' "$TMP/s1-a.out")/$(grep -c 'ERROR' "$TMP/s1-a.out")" "1/0"
check "1: the second is refused opening_stock_refused once the first commits" \
  "$(grep -c 'ERROR:  42501: opening_stock_refused' "$TMP/s1-b.out")/$(grep -c '^R=' "$TMP/s1-b.out")" "1/0"
check "1: the item holds the first quantity only, with one movement" "$(st "$I1")" "3.0000|3.0000|1|3.0000"

# ═══ 2. The organization's first Unplaced, created by two openings at once ═
( open_as s2-a "$U1" "$N1" 5 2 > "$TMP/s2-a.out" ) &
wait_for s2-a Timeout PgSleep || bad "2: the first opening never reached its pause"
( open_as s2-b "$U2" "$N2" 6 0 > "$TMP/s2-b.out" ) &
if wait_for s2-b Lock; then ok "2: the second opening waits on the first's new Unplaced"; else bad "2: the second opening did not wait on the first's Unplaced"; fi
wait
check "2: both openings opened their line" \
  "$(grep -c '^R=1$' "$TMP/s2-a.out")/$(grep -c '^R=1$' "$TMP/s2-b.out")/$(cat "$TMP"/s2-*.out | grep -c 'ERROR')" "1/1/0"
check "2: no 23505 was raised" "$(cat "$TMP"/s2-*.out | grep -c '23505')" "0"
check "2: the organization has exactly one organization-level Unplaced" \
  "$(q "select count(*) from public.locations where organization_id = '$ORG' and warehouse_id is null and kind = 'unplaced'")" "1"
check "2: both holdings are at it" \
  "$(q "select count(distinct s.location_id) || '/' || bool_and(l.warehouse_id is null and l.kind = 'unplaced')::text from public.item_stock_levels s join public.locations l on l.id = s.location_id where s.item_id in ('$N1', '$N2')")" "1/true"
check "2: each item is recorded in full" "$(st "$N1"),$(st "$N2")" "5.0000|5.0000|1|5.0000,6.0000|6.0000|1|6.0000"

# ═══ 3. No serialization failures, no deadlocks ═══════════════════════════
if grep -lE '40001|40P01|deadlock' "$TMP"/*.out > /dev/null 2>&1; then
  bad "3: a session saw 40001 or 40P01: $(grep -lE '40001|40P01|deadlock' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "3: no session saw 40001 or 40P01"
fi

echo
echo "wall time $(( $(now_ms) - T_START )) ms"
if cleanup; then ok "cleanup left no fixture rows"; else bad "cleanup"; fi
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
