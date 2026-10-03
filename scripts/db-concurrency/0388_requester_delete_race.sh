#!/usr/bin/env bash
#
# Two-session proofs for migration 0388 (a requester's account can be
# deleted; account_deletion_check; explicit order numbers refused). pgTAP runs
# in ONE session, so it cannot show a deletion racing an order write, or the
# deletion check racing a row lock.
#
#   1.  Session A (a manager) approves the requester's pending order and keeps
#       its transaction open; session B (supabase_auth_admin, as GoTrue)
#       deletes the requester's account. B waits for A, then completes: the
#       order is approved by A with A's holds, the requester is gone and the
#       order carries the marker.
#   1b. The deadlock ordering (critique K2): A locks the order FOR UPDATE and
#       sleeps; B deletes the requester (its cascade has deleted the profile
#       and waits on A's order row); A then approves, and its notify trigger
#       needs the requester's profile, which B holds. Postgres detects the
#       cycle and ends exactly ONE session with 40P01 "deadlock detected"
#       (raised by the server, never by a function); the other completes, and
#       nothing is half-applied.
#   2.  Session A (supabase_auth_admin) deletes a requester and keeps its
#       transaction open; session B, holding that requester's still-valid JWT,
#       calls create_order_request: it waits on the key-share check of the
#       profile and fails 23503 once A commits (no hang). A raw insert naming
#       order_number from the same requester is refused 42501 at once,
#       without waiting.
#   3.  Session A holds FOR UPDATE on one of a requester's orders; session B
#       (service_role) runs account_deletion_check: it gives up after its
#       900 ms lock budget and answers deletable:false with sqlstate 55P03
#       (well under 2 s). A is unaffected and nothing persists.
#   3b. The deadlock ordering with the CHECK as B: B waits on A's order row
#       first, so its 900 ms budget (below deadlock_timeout, 1 s) ends its
#       wait before A's wait can complete a cycle: B answers 55P03, A's
#       approval then completes, and no session sees 40P01.
#   3c. The reverse start order (A waits on B first): a third session C holds
#       the requester's membership row so B's cascade pauses AFTER deleting
#       the profile; A approves (and waits on B's profile); then C lets B go
#       on to A's order row. Now A waited first, so A's deadlock check fires
#       before B's lock budget ends: A is the victim (40P01, server-raised),
#       B's dry run completes and is undone. The script records which
#       session lost; the checks are the invariants: at most one 40P01, never
#       from account_deletion_check, never 40001, nothing half-applied.
#   4.  Two concurrent create_order_request calls in one organization get
#       distinct consecutive numbers (unchanged behaviour).
#   5.  No function raises 40001 or 40P01: the only 40P01 lines are the
#       server's own deadlock reports in 1b and 3c.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0388 applied. Fixtures live under the 03881111-... namespace and are
# removed at the start, at the end and by the EXIT trap. Exit status 0 = every
# check passed.
#
# Usage: bash scripts/db-concurrency/0388_requester_delete_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
# GoTrue deletes accounts as supabase_auth_admin (peer auth refuses it on the
# socket; the container trusts 127.0.0.1).
PSQL_AUTH=(docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U supabase_auth_admin -d postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03881111-0000-0000-0000-00000000000a'
MGR='03881111-0000-0000-0000-0000000000a1'
REQ1='03881111-0000-0000-0000-0000000000b1'
REQ1B='03881111-0000-0000-0000-0000000000b2'
REQ2='03881111-0000-0000-0000-0000000000b3'
REQ3='03881111-0000-0000-0000-0000000000b4'
REQ3B='03881111-0000-0000-0000-0000000000b5'
REQ3C='03881111-0000-0000-0000-0000000000b6'
WH='03881111-0000-0000-0000-0000000000c1'
ITEM='03881111-0000-0000-0000-0000000000c2'
O1='03881111-0000-0000-0000-0000000000d1'
O1B='03881111-0000-0000-0000-0000000000d2'
O3='03881111-0000-0000-0000-0000000000d4'
O3B='03881111-0000-0000-0000-0000000000d5'
O3C='03881111-0000-0000-0000-0000000000d6'
USERS="'$MGR','$REQ1','$REQ1B','$REQ2','$REQ3','$REQ3B','$REQ3C'"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf 'note   %s\n' "$*"; }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
has() { grep -cF -- "$1" "$2"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
# An order's status / requester / marker set / active holds.
ostate() {
  q "select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || (o.requester_deleted_at is not null)::text
            || '/' || (select coalesce(sum(r.quantity), 0)::int from public.stock_reservations r
                        where r.order_request_id = o.id and r.released_at is null)
       from public.order_requests o where o.id = '$1'"
}
users_left() { q "select count(*) from auth.users where id = '$1'"; }
# wait_event <application_name> <event>: until that backend waits on it.
wait_event() {
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
wait_sleeping() { wait_event "$1" PgSleep; }

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.order_requests where organization_id = '$ORG')
                                 + (select count(*) from public.inventory_items where organization_id = '$ORG')
                                 + (select count(*) from public.stock_reservations where organization_id = '$ORG')
                                 + (select count(*) from auth.users where id in ($USERS))")"
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

if [ "$(q "select count(*) from pg_proc where proname = 'account_deletion_check'")" != "1" ]; then
  echo "0388 is not applied on the local stack"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',   '0388-2s-mgr@test.local',   '{}'::jsonb),
  ('$REQ1',  '0388-2s-req1@test.local',  '{}'::jsonb),
  ('$REQ1B', '0388-2s-req1b@test.local', '{}'::jsonb),
  ('$REQ2',  '0388-2s-req2@test.local',  '{}'::jsonb),
  ('$REQ3',  '0388-2s-req3@test.local',  '{}'::jsonb),
  ('$REQ3B', '0388-2s-req3b@test.local', '{}'::jsonb),
  ('$REQ3C', '0388-2s-req3c@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0388 Two Session Org', '0388-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',   'manager', now()),
  ('$ORG', '$REQ1',  'staff',   now()),
  ('$ORG', '$REQ1B', 'staff',   now()),
  ('$ORG', '$REQ2',  'staff',   now()),
  ('$ORG', '$REQ3',  'staff',   now()),
  ('$ORG', '$REQ3B', 'staff',   now()),
  ('$ORG', '$REQ3C', 'staff',   now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0388 2S Main', 'WH-0388-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', '2S deletion item', 'SKU-0388-2S', 100, 'active');
-- Internal self-submits with no email on the row: before 0388 deleting any of
-- these requesters failed 23514 order_requests_identity_chk.
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select v.id, '$ORG', '$WH', 'pending_approval', 'internal', v.req, 'pickup'
  from (values ('$O1'::uuid, '$REQ1'::uuid), ('$O1B'::uuid, '$REQ1B'::uuid), ('$O3'::uuid, '$REQ3'::uuid),
               ('$O3B'::uuid, '$REQ3B'::uuid), ('$O3C'::uuid, '$REQ3C'::uuid)) v(id, req);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select v.id, '$ITEM', 5
  from (values ('$O1'::uuid), ('$O1B'::uuid), ('$O3'::uuid), ('$O3B'::uuid), ('$O3C'::uuid)) v(id);
SQL
then
  echo "fixture setup failed"; exit 1
fi

as_mgr() { # the manager's claims, as authenticated (PostgREST's shape)
  printf "set local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\n" "$MGR"
}
as_service() {
  printf "set local role service_role;\nset local \"request.jwt.claim.role\" to 'service_role';\nset local \"request.jwt.claim.sub\" to '';\n"
}

# ═══ 1. Approve, then the requester's account is deleted meanwhile ════════
echo "== 1. approve_order_request holds the order; the requester's account is deleted meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1.A.out" 2>&1 <<SQL
set application_name to '0388-race-1-A';
begin;
$(as_mgr)
select 'A=' || r.status from public.approve_order_request('$O1') r;
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0388-race-1-A || bad "1: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL_AUTH[@]}" -v VERBOSITY=verbose > "$TMP/1.B.out" 2>&1 <<SQL
begin;
delete from auth.users where id = '$REQ1' returning 'B=deleted';
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "1a: A approved" "$(has 'A=approved' "$TMP/1.A.out")" "1"
check "1b: B (supabase_auth_admin) deleted the account" "$(has 'B=deleted' "$TMP/1.B.out")" "1"
if [ $((T1 - T0)) -ge 1500 ]; then ok "1c: B waited for A ($((T1 - T0)) ms)"; else bad "1c: B did not wait ($((T1 - T0)) ms)"; fi
check "1d: the order is approved with A's holds, no requester, marked" "$(ostate "$O1")" "approved/null/true/5"
check "1e: the account is gone" "$(users_left "$REQ1")" "0"

# ═══ 1b. The deadlock ordering, with a real deletion ══════════════════════
echo "== 1b. A locks the order and approves after B's deletion is waiting on it"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1b.A.out" 2>&1 <<SQL
set application_name to '0388-race-1b-A';
begin;
$(as_mgr)
select 'A=locked' from public.order_requests where id = '$O1B' for update;
select pg_sleep(2.5);
select 'A=' || r.status from public.approve_order_request('$O1B') r;
commit;
SQL
) &
PID=$!
wait_sleeping 0388-race-1b-A || bad "1b: session A never reached its pg_sleep"
"${PSQL_AUTH[@]}" -v VERBOSITY=verbose > "$TMP/1b.B.out" 2>&1 <<SQL
set application_name to '0388-race-1b-B';
begin;
delete from auth.users where id = '$REQ1B' returning 'B=deleted';
commit;
SQL
wait "$PID"
A_DL="$(has '40P01: deadlock detected' "$TMP/1b.A.out")"
B_DL="$(has '40P01: deadlock detected' "$TMP/1b.B.out")"
check "1b-a: exactly one session got 40P01 deadlock detected (server-raised)" "$((A_DL + B_DL))" "1"
if [ "$A_DL" = "1" ]; then
  note "1b: the approve was the victim (as in the critique's reproduction)"
  check "1b-b: B's deletion completed" "$(has 'B=deleted' "$TMP/1b.B.out")" "1"
  check "1b-c: nothing of A's approval remains: still pending, no holds; the requester gone and the order marked" \
    "$(ostate "$O1B")" "pending_approval/null/true/0"
  check "1b-d: the account is gone" "$(users_left "$REQ1B")" "0"
else
  note "1b: the deletion was the victim"
  check "1b-b: A's approval completed" "$(has 'A=approved' "$TMP/1b.A.out")" "1"
  check "1b-c: nothing of B's deletion remains: approved with A's holds, the requester still linked, no marker" \
    "$(ostate "$O1B")" "approved/$REQ1B/false/5"
  check "1b-d: the account is intact" "$(users_left "$REQ1B")" "1"
fi
check "1b-e: the 40P01 came from the server's deadlock detector, not a function body (no RAISE context)" \
  "$(cat "$TMP/1b.A.out" "$TMP/1b.B.out" | grep -c 'PL/pgSQL function account_deletion_check')" "0"

# ═══ 2. The account is deleted while its holder places an order ═══════════
echo "== 2. the requester's account is being deleted; their still-valid JWT places an order meanwhile"
( "${PSQL_AUTH[@]}" -v VERBOSITY=verbose > "$TMP/2.A.out" 2>&1 <<SQL
set application_name to '0388-race-2-A';
begin;
delete from auth.users where id = '$REQ2' returning 'A=deleted';
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0388-race-2-A || bad "2: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2.B2.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$REQ2';
insert into public.order_requests (organization_id, warehouse_id, requester_user_id, source, status, fulfillment_type, order_number)
values ('$ORG', '$WH', '$REQ2', 'internal', 'pending_approval', 'pickup', 9223372036854775807);
commit;
SQL
T1=$(now_ms)
check "2a: the raw insert naming order_number is refused 42501 (column privilege)" \
  "$(has 'ERROR:  42501: permission denied for table order_requests' "$TMP/2.B2.out")" "1"
if [ $((T1 - T0)) -lt 1500 ]; then ok "2b: refused at once, without waiting ($((T1 - T0)) ms)"; else bad "2b: it waited ($((T1 - T0)) ms)"; fi
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2.B.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$REQ2';
select 'B=' || r.order_number from public.create_order_request(
  jsonb_build_object('organization_id', '$ORG', 'warehouse_id', '$WH', 'requester_user_id', '$REQ2', 'fulfillment_type', 'pickup'),
  jsonb_build_array(jsonb_build_object('item_id', '$ITEM', 'quantity', 1))) r;
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "2c: A deleted the account" "$(has 'A=deleted' "$TMP/2.A.out")" "1"
check "2d: create_order_request failed 23503 once A committed (no order for a deleted account)" \
  "$(has 'ERROR:  23503:' "$TMP/2.B.out")" "1"
if [ $((T1 - T0)) -ge 1000 ]; then ok "2e: it waited for A's deletion ($((T1 - T0)) ms), then failed cleanly"; else bad "2e: it did not wait ($((T1 - T0)) ms)"; fi
check "2f: no order exists for the deleted requester" \
  "$(q "select count(*) from public.order_requests where organization_id = '$ORG' and requester_user_id = '$REQ2'")" "0"

# ═══ 3. The check against a row lock ══════════════════════════════════════
echo "== 3. a session holds FOR UPDATE on one of the requester's orders; account_deletion_check meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.A.out" 2>&1 <<SQL
set application_name to '0388-race-3-A';
begin;
$(as_mgr)
select 'A=locked' from public.order_requests where id = '$O3' for update;
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0388-race-3-A || bad "3: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.B.out" 2>&1 <<SQL
begin;
$(as_service)
select 'B=' || public.account_deletion_check('$REQ3')::text;
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "3a: the check answered deletable:false with sqlstate 55P03 (its lock budget)" \
  "$(grep -c '^B=.*"sqlstate": "55P03".*"deletable": false' "$TMP/3.B.out")" "1"
if [ $((T1 - T0)) -lt 2000 ]; then ok "3b: within its 900 ms budget plus overhead ($((T1 - T0)) ms)"; else bad "3b: it took $((T1 - T0)) ms"; fi
check "3c: A was unaffected" "$(has 'A=locked' "$TMP/3.A.out"),$(grep -c 'ERROR' "$TMP/3.A.out")" "1,0"
check "3d: nothing persisted: the account, the requester link, no marker" \
  "$(users_left "$REQ3")/$(ostate "$O3")" "1/pending_approval/$REQ3/false/0"

# ═══ 3b. The deadlock ordering with the check as B ════════════════════════
echo "== 3b. A locks the order and approves after account_deletion_check is waiting on it"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3b.A.out" 2>&1 <<SQL
set application_name to '0388-race-3b-A';
begin;
$(as_mgr)
select 'A=locked' from public.order_requests where id = '$O3B' for update;
select pg_sleep(2.5);
select 'A=' || r.status from public.approve_order_request('$O3B') r;
commit;
SQL
) &
PID=$!
wait_sleeping 0388-race-3b-A || bad "3b: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3b.B.out" 2>&1 <<SQL
begin;
$(as_service)
select 'B=' || public.account_deletion_check('$REQ3B')::text;
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "3b-a: the check gave up with 55P03 before A's approval could close a cycle" \
  "$(grep -c '^B=.*"sqlstate": "55P03"' "$TMP/3b.B.out")" "1"
if [ $((T1 - T0)) -lt 2000 ]; then ok "3b-b: the check answered in $((T1 - T0)) ms"; else bad "3b-b: the check took $((T1 - T0)) ms"; fi
check "3b-c: A's approval then completed" "$(has 'A=approved' "$TMP/3b.A.out")" "1"
check "3b-d: no 40P01 in either session" "$(cat "$TMP/3b.A.out" "$TMP/3b.B.out" | grep -c '40P01')" "0"
check "3b-e: approved with A's holds; the account and its link intact, no marker" \
  "$(users_left "$REQ3B")/$(ostate "$O3B")" "1/approved/$REQ3B/false/5"

# ═══ 3c. The reverse start order: A waits on the check first ══════════════
echo "== 3c. reverse order: the check pauses after deleting the profile; A waits on it; then the check reaches A's row"
# A controller session holds two advisory locks that gate A and C, and steps
# the race from one DO block (millisecond timing, no shell round trips), so
# every release happens well inside the check's 900 ms budget.
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3c.CTL.out" 2>&1 <<'SQL'
set application_name to '0388-race-3c-ctl';
select 'CTL=locked', pg_advisory_lock(38803) is null, pg_advisory_lock(38804) is null;
do $$
declare
  tb timestamptz;
  ta timestamptz;
  i int;
begin
  -- 1. B has deleted the profile and waits on C's membership row.
  for i in 1..2000 loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity
                       where application_name = '0388-race-3c-B' and wait_event = 'transactionid');
    perform pg_sleep(0.01);
  end loop;
  tb := clock_timestamp();
  -- 2. A approves now; its notify trigger then waits on B's deleted profile.
  perform pg_advisory_unlock(38803);
  for i in 1..300 loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity
                       where application_name = '0388-race-3c-A' and wait_event = 'transactionid');
    perform pg_sleep(0.01);
  end loop;
  ta := clock_timestamp();
  -- 3. A waited first; give it a lead, then let C commit so B goes on to A's row.
  perform pg_sleep(0.4);
  perform pg_advisory_unlock(38804);
  raise notice 'CTL a_waits_after_ms=% c_released_after_ms=%',
    round(extract(epoch from ta - tb) * 1000), round(extract(epoch from clock_timestamp() - tb) * 1000);
end $$;
SQL
) &
PIDCTL=$!
# Start A and C only once the controller holds both gates (it is then in its
# polling loop, so it sees B the moment B starts waiting).
GATES=0
for _ in $(seq 1 200); do
  GATES="$(q "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid
               where a.application_name = '0388-race-3c-ctl' and l.locktype = 'advisory' and l.granted
                 and l.objid in (38803, 38804)")"
  [ "$GATES" = "2" ] && break
  sleep 0.05
done
[ "$GATES" = "2" ] || bad "3c: the controller never took its gates"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3c.A.out" 2>&1 <<SQL
set application_name to '0388-race-3c-A';
begin;
$(as_mgr)
select 'A=locked' from public.order_requests where id = '$O3C' for update;
select pg_advisory_lock(38803) is null;
select 'A=' || r.status from public.approve_order_request('$O3C') r;
commit;
SQL
) &
PIDA=$!
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3c.C.out" 2>&1 <<SQL
set application_name to '0388-race-3c-C';
begin;
select 'C=locked' from public.organization_members where user_id = '$REQ3C' for update;
select pg_advisory_lock(38804) is null;
commit;
SQL
) &
PIDC=$!
wait_event 0388-race-3c-A advisory || bad "3c: A never waited on its gate"
wait_event 0388-race-3c-C advisory || bad "3c: C never waited on its gate"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3c.B.out" 2>&1 <<SQL
set application_name to '0388-race-3c-B';
begin;
$(as_service)
select 'B=' || public.account_deletion_check('$REQ3C')::text;
commit;
SQL
) &
PIDB=$!
wait "$PIDA" "$PIDB" "$PIDC" "$PIDCTL"
C_AFTER="$(sed -n 's/.*CTL a_waits_after_ms=[0-9]* c_released_after_ms=\([0-9]*\).*/\1/p' "$TMP/3c.CTL.out" | head -n 1)"
note "3c: controller: $(grep -o 'CTL a_waits_after_ms=[0-9]* c_released_after_ms=[0-9]*' "$TMP/3c.CTL.out" | head -n 1)"
REVERSED=0
if [ -n "$C_AFTER" ] && [ "$C_AFTER" -lt 900 ]; then REVERSED=1; fi
A_DL="$(has '40P01: deadlock detected' "$TMP/3c.A.out")"
B_55="$(grep -c '^B=.*"sqlstate": "55P03"' "$TMP/3c.B.out")"
B_OK="$(grep -c '^B={"deletable": true}$' "$TMP/3c.B.out")"
if [ "$REVERSED" = "1" ]; then
  if [ "$A_DL" = "1" ]; then
    note "3c: observed: A waited first and was the deadlock victim (40P01); the check completed its dry run"
    check "3c-a: the check answered deletable (its dry run ran to the end and was undone)" "$B_OK" "1"
    check "3c-b: nothing of A's approval remains: pending, no holds; the account and its link intact, no marker" \
      "$(users_left "$REQ3C")/$(ostate "$O3C")" "1/pending_approval/$REQ3C/false/0"
  else
    note "3c: observed: the check gave up first (55P03) and A's approval completed"
    check "3c-a: the check answered 55P03" "$B_55" "1"
    check "3c-b: approved with A's holds; the account and its link intact, no marker" \
      "$(users_left "$REQ3C")/$(ostate "$O3C")" "1/approved/$REQ3C/false/5"
  fi
else
  bad "3c: the reverse ordering was not reached in time (the gate polls were too slow); rerun"
fi
check "3c-c: at most one session saw 40P01, and the check itself never raised" \
  "$((A_DL > 1 ? 9 : A_DL))/$(grep -c 'ERROR' "$TMP/3c.B.out")" "$A_DL/0"
check "3c-d: C and the controller were untouched by the race" \
  "$(grep -c 'ERROR' "$TMP/3c.C.out")/$(grep -c 'ERROR' "$TMP/3c.CTL.out")" "0/0"

# ═══ 4. Numbering is unchanged ════════════════════════════════════════════
echo "== 4. two concurrent create_order_request calls in one organization"
NMAX="$(q "select coalesce(max(order_number), 0) from public.order_requests where organization_id = '$ORG'")"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.A.out" 2>&1 <<SQL
set application_name to '0388-race-4-A';
begin;
$(as_mgr)
select 'A=' || r.order_number from public.create_order_request(
  jsonb_build_object('organization_id', '$ORG', 'warehouse_id', '$WH', 'requester_user_id', '$MGR', 'fulfillment_type', 'pickup'),
  jsonb_build_array(jsonb_build_object('item_id', '$ITEM', 'quantity', 1))) r;
select pg_sleep(2);
commit;
SQL
) &
PID=$!
wait_sleeping 0388-race-4-A || bad "4: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.B.out" 2>&1 <<SQL
begin;
$(as_mgr)
select 'B=' || r.order_number from public.create_order_request(
  jsonb_build_object('organization_id', '$ORG', 'warehouse_id', '$WH', 'requester_user_id', '$MGR', 'fulfillment_type', 'pickup'),
  jsonb_build_array(jsonb_build_object('item_id', '$ITEM', 'quantity', 1))) r;
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "4a: distinct consecutive numbers" \
  "$(sed -n 's/^A=//p' "$TMP/4.A.out"),$(sed -n 's/^B=//p' "$TMP/4.B.out")" "$((NMAX + 1)),$((NMAX + 2))"
if [ $((T1 - T0)) -ge 1000 ]; then ok "4b: the second waited on the per-organization number lock ($((T1 - T0)) ms)"; else bad "4b: the second did not wait ($((T1 - T0)) ms)"; fi

# ═══ 5. Error classes ═════════════════════════════════════════════════════
echo "== 5. no 40001 anywhere; 40P01 only as the server's deadlock report in 1b and 3c"
check "5a: no 40001 in any session" "$(cat "$TMP"/*.out | grep -c '40001')" "0"
check "5b: no 40P01 outside 1b and 3c" \
  "$(cat "$TMP"/1.*.out "$TMP"/2.*.out "$TMP"/3.*.out "$TMP"/3b.*.out "$TMP"/4.*.out | grep -c '40P01')" "0"
check "5c: account_deletion_check never raised in any session" \
  "$(cat "$TMP"/3.B.out "$TMP"/3b.B.out "$TMP"/3c.B.out | grep -c 'ERROR')" "0"

cleanup || FAILS=$((FAILS + 1))

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
