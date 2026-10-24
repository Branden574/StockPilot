#!/usr/bin/env bash
#
# Lock footprint of migration 0405 (security slice E). The file restates six
# order functions and their comments and nothing else: CREATE OR REPLACE
# FUNCTION and COMMENT ON FUNCTION lock no table, and a call of a function
# takes no lock on it, so a call in flight never holds the file up and the
# file never holds a call up. Checked:
#
#   1a. Run as one transaction, the file holds no lock on any table outside
#       the catalogs.
#   1b. Its only object locks are COMMENT's ShareUpdateExclusiveLock on the
#       six functions (a lock only other DDL on the same function waits for).
#   2.  The file runs in under 250 ms on the local stack.
#   3.  A call in flight: a manager's cancel_order_request waits on its order
#       row (held by a third session) while the file runs. The file finishes
#       under its 900 ms lock_timeout and the call is still waiting when it
#       does; the call then finishes.
#   4.  No session saw 55P03 (lock_timeout), 40001 or 40P01.
#
# The migration sessions ALWAYS roll back. Runs against a LOCAL stack only,
# with 0405 applied (running the file again is the same statements; CONTAINER
# as in 0405_cancel_scope_race.sh, default the dev stack's
# supabase_db_stockpilot; the migration scratch stack is supabase_db_spmig).
# Fixtures live under the 04052222-... namespace and are removed at the
# start, at the end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0405_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(ls "$REPO"/supabase/migrations/*_order_functions_warehouse_scope.sql 2>/dev/null | head -n 1)"
TMP="$(mktemp -d)"

ORG='04052222-0000-0000-0000-00000000000a'
MGR='04052222-0000-0000-0000-0000000000a1'
WH='04052222-0000-0000-0000-0000000000c1'
IT='04052222-0000-0000-0000-0000000000c3'
O1='04052222-0000-0000-0000-0000000000d1'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
below() { # below <label> <actual ms> <limit ms>
  if [ -n "$2" ] && [ "$2" -lt "$3" ]; then ok "$1 ($2 ms < $3 ms)"; else bad "$1: got '$2' ms, want under $3 ms"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
wait_event() { # wait_event <application_name> <wait_event>
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
waiting_on_lock() { q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'"; }
wait_locked() {
  local _
  for _ in $(seq 1 200); do
    [ "$(waiting_on_lock "$1")" = "1" ] && return 0
    sleep 0.05
  done
  return 1
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.notifications where organization_id = '$ORG';
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.order_requests where organization_id = '$ORG')
                  + (select count(*) from auth.users where id = '$MGR')")"
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

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_order_functions_warehouse_scope.sql"; exit 1; }
if [ "$(q "select count(*) from pg_proc where proname = 'cancel_order_request' and prosrc like '%Slice E: an approver''s cancel asks write access%'")" != "1" ]; then
  echo "0405 is not applied on this stack"; exit 1
fi
if grep -qiE '^[[:space:]]*(begin|commit|rollback|start transaction)[[:space:]]*;' "$MIG"; then
  echo "the file has its own transaction control: this script wraps it in one"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0405-fp-mgr@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0405 Footprint Org', '0405-footprint');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0405 FP Main', 'WH-0405-FP', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$IT', '$ORG', '$WH', 'FP item', 'SKU-0405-FP', 100, 'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
  values ('$O1', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values ('$O1', '$IT', 2);
SQL
then
  echo "fixture setup failed"; exit 1
fi

LOCKS_SQL="select 'tables=' || coalesce(string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode), 'none')
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
select 'objects=' || count(*) || '/' || count(*) filter (where l.classid = 'pg_proc'::regclass and l.mode = 'ShareUpdateExclusiveLock'
         and l.objid in (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public'
                            and p.proname in ('approve_order_request', 'approve_partial', 'cancel_order_request',
                                              'close_partial', 'reopen_picking', 'resume_fulfillment')))
  from pg_locks l where l.locktype = 'object' and l.pid = pg_backend_pid() and l.granted;
select 'ms=' || round(extract(epoch from clock_timestamp() - now()) * 1000);"

# The file in one transaction, its locks read before the rollback.
run_file() { # run_file <application_name> <out>
  { echo "set application_name to '$1';"; echo "begin;"; cat "$MIG"; echo "$LOCKS_SQL"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$2" 2>&1
}

# ═══ 1 and 2. The file alone ══════════════════════════════════════════════
echo "== 1-2. the file in one transaction, rolled back"
if run_file 0405-fp-alone "$TMP/alone.out"; then ok "1: the file ran"; else bad "1: the file failed: $(cat "$TMP/alone.out")"; fi
check "1a: no lock on a table outside the catalogs" "$(grep '^tables=' "$TMP/alone.out")" "tables=none"
check "1b: object locks: COMMENT's ShareUpdateExclusiveLock on the six functions, nothing else" "$(grep '^objects=' "$TMP/alone.out")" "objects=6/6"
below "2: the file runs fast" "$(grep '^ms=' "$TMP/alone.out" | cut -d= -f2)" 250

# ═══ 3. A call in flight ══════════════════════════════════════════════════
echo "== 3. the file while a manager's cancel waits on its order row"
( "${PSQL[@]}" > "$TMP/holder.out" 2>&1 <<SQL
set application_name to '0405-fp-holder';
begin;
select 'H=' || id from public.order_requests where id = '$O1' for update;
select pg_sleep(3);
rollback;
SQL
) &
PH=$!
wait_event 0405-fp-holder PgSleep || bad "3: the holder never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/call.out" 2>&1 <<SQL
set application_name to '0405-fp-call';
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || r.status from public.cancel_order_request('$O1', 'Footprint check') r;
rollback;
SQL
) &
PA=$!
if wait_locked 0405-fp-call; then ok "3: the cancel waits on the order row"; else bad "3: the cancel never waited on the row"; fi
if run_file 0405-fp-file "$TMP/file.out"; then ok "3: the file ran while the cancel was in flight"; else bad "3: the file failed: $(cat "$TMP/file.out")"; fi
check "3: the cancel was still waiting when the file finished" "$(waiting_on_lock 0405-fp-call)" "1"
below "3: the file finished under its lock_timeout" "$(grep '^ms=' "$TMP/file.out" | cut -d= -f2)" 900
check "3: no lock on a table outside the catalogs" "$(grep '^tables=' "$TMP/file.out")" "tables=none"
wait "$PH"; wait "$PA"
check "3: the cancel then finished" "$(grep -c '^A=cancelled$' "$TMP/call.out")" "1"
check "3: the order is unchanged (every session rolled back)" "$(q "select status from public.order_requests where id = '$O1'")" "pending_approval"

# ═══ 4. Never a lock timeout or a retryable error ═════════════════════════
echo "== 4. no session saw 55P03, 40001 or 40P01"
check "4: none in any session's output" "$(cat "$TMP"/*.out | grep -cE '55P03|40001|40P01|lock timeout|could not serialize|deadlock detected')" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
