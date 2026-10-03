#!/usr/bin/env bash
#
# Two-session proof for migration 0387 (S0, the order workflow guard). pgTAP
# runs in ONE session, so it cannot show what a raw PATCH does while an
# approval holds the order row, or an approval while a raw write holds it.
#
#   1. Session A (a manager) runs approve_order_request and keeps its
#      transaction open; session B (a second manager) PATCHes the same order
#      with status approved AND approved_by/approved_at (a forged approval).
#      B is refused at once with 42501 permission denied (the column
#      privilege is checked before any row is touched, so B never waits).
#      After both: the approver is A, and the holds are A's.
#   1b. The same race, but B PATCHes status cancelled (pending -> cancelled is
#      an RPC-owned edge either way). B waits on A's row lock, then sees A's
#      approved row and is refused by the guard: 42501
#      order_status_through_rpc_only, hint status_through_rpc_only (approved ->
#      cancelled would skip the hold release). After both: still approved by
#      A, and A's holds are not released.
#   2. The same race, B PATCHes status approved only. B waits, then finds the
#      order already approved: approved -> approved is no edge, so it passes
#      the guard and changes nothing but updated_at (status, approver,
#      approval time and holds are A's). A no-op is harmless.
#   3. Session A raw-denies the order (pending -> denied, an allowlisted edge)
#      and keeps its transaction open; session B calls approve_order_request.
#      B waits on the order-row lock, then reads denied and is refused: P0001
#      invalid_status_transition. Nothing is held.
#   4. No session ever sees 40001 or 40P01, and nothing deadlocks.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03871111-... namespace and removed at the
# start, at the end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0387_workflow_guard_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03871111-0000-0000-0000-00000000000a'
MGR='03871111-0000-0000-0000-0000000000a1'
MGR2='03871111-0000-0000-0000-0000000000a2'
WH='03871111-0000-0000-0000-0000000000b1'
ITEM='03871111-0000-0000-0000-0000000000c1'
O1='03871111-0000-0000-0000-0000000000d1'
O1B='03871111-0000-0000-0000-0000000000d2'
O2='03871111-0000-0000-0000-0000000000d3'
O3='03871111-0000-0000-0000-0000000000d4'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
# has <fixed text> <file>: how many lines carry the text (no regex, no quoting traps).
has() { grep -cF -- "$1" "$2"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
# An order's status / approver / approval time, and its active holds.
state()   { q "select status || '/' || coalesce(approved_by::text, 'null') || '/' || coalesce(approved_at::text, 'null') from public.order_requests where id = '$1'"; }
held_for() { q "select coalesce(sum(quantity), 0)::int from public.stock_reservations where order_request_id = '$1' and released_at is null"; }

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.stock_reservations where organization_id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

# The EXIT trap removes this script's fixture rows however it ends (a
# failure, Ctrl-C, SIGTERM, a harness timeout; bash runs it on INT, TERM and
# HUP), so an interrupted run never leaves its org on the shared local stack.
# SIGKILL cannot be trapped: the next run's opening cleanup removes them.
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

cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0387-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0387-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0387 Two Session Org', '0387-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',  'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0387 2S Main', 'WH-0387-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', '2S guard item', 'SKU-0387-2S', 100, 'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select v.id, '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'
  from (values ('$O1'::uuid), ('$O1B'::uuid), ('$O2'::uuid), ('$O3'::uuid)) v(id);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select v.id, '$ITEM', 5
  from (values ('$O1'::uuid), ('$O1B'::uuid), ('$O2'::uuid), ('$O3'::uuid)) v(id);
SQL
then
  echo "fixture setup failed"; exit 1
fi

# approve_vs_patch <tag> <order> <B's SET list>: A (MGR) approves the order
# through the RPC and holds its transaction 3 s; at 1 s, B (MGR2) sends a raw
# PATCH of the order with the given SET list, as authenticated. Records how
# long B took.
approve_vs_patch() {
  local tag="$1" o="$2" set_list="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || r.status || '|' || r.approved_at::text from public.approve_order_request('$o') r;
select pg_sleep(3);
commit;
SQL
  ) &
  local pid=$!
  sleep 1
  local t0; t0=$(now_ms)
  "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR2';
update public.order_requests set $set_list where id = '$o' returning 'B=' || status;
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# ═══ 1. A forged approval while the real one is in flight ═════════════════
echo "== 1. approve_order_request holds the order; a raw PATCH forges approved, approved_by and approved_at meanwhile"
approve_vs_patch forge "$O1" "status = 'approved', approved_by = '$MGR2', approved_at = now()"
WAITED="$(cat "$TMP/forge.waited")"
check "1a: A approved" "$(grep -c '^A=approved|' "$TMP/forge.A.out")" "1"
check "1b: B was refused: 42501 permission denied (the column privilege)" \
  "$(has 'ERROR:  42501: permission denied for table order_requests' "$TMP/forge.B.out")" "1"
if [ "$WAITED" -lt 1500 ]; then ok "1c: B was refused before touching the row, without waiting ($WAITED ms)"; else bad "1c: B waited ($WAITED ms)"; fi
check "1d: the order is approved by A, at A's time" \
  "$(state "$O1")" "approved/$MGR/$(sed -n 's/^A=approved|//p' "$TMP/forge.A.out")"
check "1e: the holds are A's (5)" "$(held_for "$O1")" "5"

# ═══ 1b. A raw cancel waits for the approval, then is refused ═════════════
echo "== 1b. approve_order_request holds the order; a raw PATCH to cancelled meanwhile"
approve_vs_patch cancel "$O1B" "status = 'cancelled'"
WAITED="$(cat "$TMP/cancel.waited")"
check "1b-a: A approved" "$(grep -c '^A=approved|' "$TMP/cancel.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "1b-b: B waited for A's order-row lock ($WAITED ms)"; else bad "1b-b: B did not wait ($WAITED ms)"; fi
check "1b-c: B was then refused by the guard on A's approved row: 42501 order_status_through_rpc_only, hint status_through_rpc_only" \
  "$(has 'ERROR:  42501: order_status_through_rpc_only' "$TMP/cancel.B.out"),$(has 'HINT:  status_through_rpc_only' "$TMP/cancel.B.out")" "1,1"
check "1b-d: the order is still approved by A" \
  "$(state "$O1B")" "approved/$MGR/$(sed -n 's/^A=approved|//p' "$TMP/cancel.A.out")"
check "1b-e: A's holds were not released (5)" "$(held_for "$O1B")" "5"

# ═══ 2. A raw approve after the real one is a no-op ═══════════════════════
echo "== 2. approve_order_request holds the order; a raw PATCH {status: approved} meanwhile"
approve_vs_patch noop "$O2" "status = 'approved'"
WAITED="$(cat "$TMP/noop.waited")"
check "2a: A approved" "$(grep -c '^A=approved|' "$TMP/noop.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "2b: B waited for A's order-row lock ($WAITED ms)"; else bad "2b: B did not wait ($WAITED ms)"; fi
check "2c: B went through as a no-op (approved -> approved is no edge)" "$(grep -c '^B=approved$' "$TMP/noop.B.out")" "1"
check "2d: status, approver and approval time are A's" \
  "$(state "$O2")" "approved/$MGR/$(sed -n 's/^A=approved|//p' "$TMP/noop.A.out")"
check "2e: the holds are A's (5)" "$(held_for "$O2")" "5"

# ═══ 3. A raw deny first, the approval meanwhile ══════════════════════════
echo "== 3. a raw deny (allowlisted edge) holds the order; approve_order_request meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/deny.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
update public.order_requests set status = 'denied', denied_reason = 'Out of season'
 where id = '$O3' and status = 'pending_approval' returning 'A=' || status;
select pg_sleep(3);
commit;
SQL
) &
PID=$!
sleep 1
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/deny.B.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR2';
select 'B=' || r.status from public.approve_order_request('$O3') r;
commit;
SQL
T1=$(now_ms)
wait "$PID"
WAITED=$((T1 - T0))
check "3a: the raw deny went through (an allowlisted edge)" "$(grep -c '^A=denied$' "$TMP/deny.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "3b: the approval waited for the deny's order-row lock ($WAITED ms)"; else bad "3b: the approval did not wait ($WAITED ms)"; fi
check "3c: the approval was refused: P0001 invalid_status_transition" \
  "$(has 'ERROR:  P0001: invalid_status_transition' "$TMP/deny.B.out")" "1"
check "3d: the order stays denied, with no approver" "$(state "$O3")" "denied/null/null"
check "3e: nothing is held" "$(held_for "$O3")" "0"

# ═══ 4. No retryable error anywhere ═══════════════════════════════════════
echo "== 4. no 40001 or 40P01 in any session, and no deadlock"
check "4a: no 40001 or 40P01" "$(cat "$TMP"/*.A.out "$TMP"/*.B.out | grep -cE '40001|40P01')" "0"
check "4b: no deadlock reported" "$(cat "$TMP"/*.A.out "$TMP"/*.B.out | grep -ci 'deadlock')" "0"

cleanup || FAILS=$((FAILS + 1))

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
