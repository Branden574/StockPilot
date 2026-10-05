#!/usr/bin/env bash
#
# Two-session proofs for migration 0394 (every member can delete their
# account). pgTAP runs in ONE session, so it cannot show a deletion racing an
# assignment, an edit, a member joining, an ownership transfer, a second
# owner's deletion or an "Act as" seat ending. Session B is always GoTrue's
# own role (supabase_auth_admin) deleting from auth.users, unless it is the
# deletion check (service_role).
#
#   1.  Release vs assign: A holds the subject's in-progress count FOR UPDATE
#       (the assign RPC's lock); B deletes the subject and waits. After A
#       commits, B completes: the count is released (assignee and claim
#       cleared, version + 1).
#   2.  Stamp vs edit: A (a manager) renames the subject's schedule entry and
#       holds; B deletes the subject and waits. After A commits, B completes:
#       A's title and updated_by stay, created_by is null and stamped, and
#       updated_by (now the manager) has no stamp.
#   3.  Last owner vs a joining member (the F1 residual): A inserts an
#       accepted member into a solo owner's organization and holds; B deletes
#       the solo owner without waiting (the uncommitted member is invisible).
#       After A commits the organization has one member and no owner. The
#       script asserts exactly this outcome, and nothing half-applied.
#   4.  The deletion check vs a held row lock: A holds FOR UPDATE on a
#       receipt the subject received; account_deletion_check answers 55P03
#       within its 900 ms budget, A is unaffected and nothing persists.
#   5.  Approve vs delete (0388 race 1b): A locks the requester's order,
#       sleeps, then approves; B deletes the requester meanwhile. At most one
#       session gets 40P01 (raised by the server's deadlock detector), and the
#       state matches the outcome: nothing is half-applied.
#   7a. Transfer vs deletion, deletion first: B deletes member M and holds;
#       A runs transfer_org_ownership(owner -> M), waits on M's row and fails
#       22023 once B commits. The owner is still the owner.
#   7b. Transfer first: A transfers ownership to M2 and holds; B deletes M2,
#       its lock statement waits on M2's row, then its last-owner check (a
#       new snapshot) sees M2 as the only owner and refuses
#       (organization_last_owner). M2 and the organization are intact.
#   7c. Two transfers by the same owner at once: one succeeds, the other
#       fails 42501 (the caller row is re-checked after the lock); exactly
#       one owner.
#   7d. The invited_by edge (plan 5.1): M3 invited the owner; A locks the
#       owner's row, then transfers to M3, while B's deletion of M3 nulls the
#       owner row's invited_by. The server detects the cycle and ends exactly
#       one session with 40P01; the other completes; one real owner.
#   8.  Two owners of one organization delete at once (both start orders):
#       one deletion succeeds, the other waits on the lock, re-reads and is
#       refused; the organization keeps one owner.
#   9.  Two members of one organization delete at once: neither waits, both
#       complete, no deadlock.
#   10. Deletion vs an impersonation seat ending: the only real owner (with
#       a staff member) is refused whether the seat's removal commits or
#       rolls back during the deletion.
#   11. Timing (plan 11.2): a subject named on 1,900 marked rows (1,000
#       stock movements, 900 audit rows): the check and the deletion each
#       finish under 2 s; every row is kept and stamped.
#   6.  Error classes: no 40001 anywhere; 40P01 only in 5 and 7d; no 0394
#       function body raises 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0394 applied. Fixtures live under the 03941111-... namespace and are
# removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed. A FAIL line starts with the case number.
#
# Usage: bash scripts/db-concurrency/0394_account_delete_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
# GoTrue deletes accounts as supabase_auth_admin (peer auth refuses it on the
# socket; the container trusts 127.0.0.1).
PSQL_AUTH=(docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U supabase_auth_admin -d postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

NS='03941111-0000-0000-0000'
ORG="$NS-00000000000a"; ORGB="$NS-00000000000b"; ORGC="$NS-00000000000c"; ORGC2="$NS-00000000000d"
ORGE="$NS-00000000000e"; ORGE2="$NS-00000000000f"; ORGT="$NS-000000000010"; ORGT2="$NS-000000000011"
ORGT3="$NS-000000000012"
ORGS="'$ORG','$ORGB','$ORGC','$ORGC2','$ORGE','$ORGE2','$ORGT','$ORGT2','$ORGT3'"
O="$NS-0000000000a0"; MGR="$NS-0000000000a1"; S="$NS-0000000000a2"
P1="$NS-0000000000b1"; P2="$NS-0000000000b2"; P4="$NS-0000000000b4"; P5="$NS-0000000000b5"
Q1="$NS-0000000000b6"; Q2="$NS-0000000000b7"; P11="$NS-0000000000b8"
O2="$NS-0000000000c0"; J="$NS-0000000000c1"
C1="$NS-0000000000d0"; C2="$NS-0000000000d1"; CS="$NS-0000000000d2"
C3="$NS-0000000000d3"; C4="$NS-0000000000d4"; CS2="$NS-0000000000d5"
O4="$NS-0000000000e0"; ES="$NS-0000000000e1"; PA="$NS-0000000000e2"; O5="$NS-0000000000e3"; ES2="$NS-0000000000e4"
TO="$NS-0000000000f0"; TM="$NS-0000000000f1"; TM2="$NS-0000000000f2"; TS="$NS-0000000000f3"
TO2="$NS-0000000000f4"; X1="$NS-0000000000f5"; X2="$NS-0000000000f6"
TO3="$NS-0000000000f7"; M3="$NS-0000000000f8"; TS3="$NS-0000000000f9"
USER_LIST="$O $MGR $S $P1 $P2 $P4 $P5 $Q1 $Q2 $P11 $O2 $J $C1 $C2 $CS $C3 $C4 $CS2 $O4 $ES $PA $O5 $ES2 $TO $TM $TM2 $TS $TO2 $X1 $X2 $TO3 $M3 $TS3"
USERS="$(for u in $USER_LIST; do printf "'%s'," "$u"; done | sed 's/,$//')"
WH="$NS-000000000101"; ITEM="$NS-000000000102"; PO="$NS-000000000103"
CC1="$NS-000000000201"; SE2="$NS-000000000202"; R4="$NS-000000000203"; OR5="$NS-000000000204"

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
users_left() { q "select count(*) from auth.users where id = '$1'"; }
real_owners() { # the accepted, non-seat owners of an organization, comma-separated
  q "select coalesce(string_agg(user_id::text, ',' order by user_id), '') from public.organization_members
      where organization_id = '$1' and role = 'owner' and accepted_at is not null and impersonation_expires_at is null"
}
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
wait_sleeping() { wait_event "$1" PgSleep; }
as_mgr() { # the manager's claims, as authenticated (PostgREST's shape)
  printf "set local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\n" "$MGR"
}
as_service() {
  printf "set local role service_role;\nset local \"request.jwt.claim.role\" to 'service_role';\nset local \"request.jwt.claim.sub\" to '';\n"
}
# delete_as_gotrue <app> <user> [sleep-seconds-before-commit] > out
delete_as_gotrue() {
  "${PSQL_AUTH[@]}" -v VERBOSITY=verbose <<SQL
set application_name to '$1';
begin;
delete from auth.users where id = '$2' returning 'B=deleted';
select pg_sleep(${3:-0});
commit;
SQL
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.notifications where organization_id in ($ORGS);
delete from public.stock_movements where organization_id in ($ORGS);
delete from public.audit_logs where organization_id in ($ORGS);
delete from public.receipts where organization_id in ($ORGS);
delete from public.purchase_orders where organization_id in ($ORGS);
delete from public.cycle_counts where organization_id in ($ORGS);
delete from public.schedule_events where organization_id in ($ORGS);
delete from public.stock_reservations where organization_id in ($ORGS);
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id in ($ORGS));
delete from public.order_requests where organization_id in ($ORGS);
delete from public.inventory_items where organization_id in ($ORGS);
delete from public.organizations where id in ($ORGS);
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.organizations where id in ($ORGS))
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

if [ "$(q "select count(*) from pg_trigger where tgname = 'on_auth_user_before_delete'")" != "1" ]; then
  echo "0394 is not applied on the local stack"; exit 1
fi
cleanup || exit 1

USER_VALUES="$(for u in $USER_LIST; do printf "('%s', '0394-2s-%s@test.local', '{}'::jsonb)," "$u" "${u: -2}"; done | sed 's/,$//')"
if ! "${PSQL[@]}" >"$TMP/setup.out" 2>&1 <<SQL
insert into auth.users (id, email, raw_user_meta_data) values $USER_VALUES;
insert into public.organizations (id, name, slug) values
  ('$ORG',   '0394 2S A',      '0394-2s-a'),
  ('$ORGB',  '0394 2S Solo',   '0394-2s-solo'),
  ('$ORGC',  '0394 2S Two',    '0394-2s-two'),
  ('$ORGC2', '0394 2S Two R',  '0394-2s-two-r'),
  ('$ORGE',  '0394 2S Seat',   '0394-2s-seat'),
  ('$ORGE2', '0394 2S Seat R', '0394-2s-seat-r'),
  ('$ORGT',  '0394 2S Xfer',   '0394-2s-xfer'),
  ('$ORGT2', '0394 2S Xfer 2', '0394-2s-xfer-2'),
  ('$ORGT3', '0394 2S Xfer 3', '0394-2s-xfer-3');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  ('$ORG', '$O', 'owner', now(), null), ('$ORG', '$MGR', 'manager', now(), null), ('$ORG', '$S', 'staff', now(), null),
  ('$ORG', '$P1', 'staff', now(), null), ('$ORG', '$P2', 'staff', now(), null), ('$ORG', '$P4', 'staff', now(), null),
  ('$ORG', '$P5', 'staff', now(), null), ('$ORG', '$Q1', 'staff', now(), null), ('$ORG', '$Q2', 'staff', now(), null),
  ('$ORG', '$P11', 'staff', now(), null),
  ('$ORGB', '$O2', 'owner', now(), null),
  ('$ORGC', '$C1', 'owner', now(), null), ('$ORGC', '$C2', 'owner', now(), null), ('$ORGC', '$CS', 'staff', now(), null),
  ('$ORGC2', '$C3', 'owner', now(), null), ('$ORGC2', '$C4', 'owner', now(), null), ('$ORGC2', '$CS2', 'staff', now(), null),
  ('$ORGE', '$O4', 'owner', now(), null), ('$ORGE', '$ES', 'staff', now(), null), ('$ORGE', '$PA', 'owner', now(), now() + interval '1 hour'),
  ('$ORGE2', '$O5', 'owner', now(), null), ('$ORGE2', '$ES2', 'staff', now(), null), ('$ORGE2', '$PA', 'owner', now(), now() + interval '1 hour'),
  ('$ORGT', '$TO', 'owner', now(), null), ('$ORGT', '$TM', 'staff', now(), null), ('$ORGT', '$TM2', 'staff', now(), null),
  ('$ORGT', '$TS', 'staff', now(), null),
  ('$ORGT2', '$TO2', 'owner', now(), null), ('$ORGT2', '$X1', 'staff', now(), null), ('$ORGT2', '$X2', 'staff', now(), null),
  ('$ORGT3', '$M3', 'admin', now(), null), ('$ORGT3', '$TS3', 'staff', now(), null);
-- 7d: M3 invited the owner (organization_members.invited_by, SET NULL on M3's deletion).
insert into public.organization_members (organization_id, user_id, role, accepted_at, invited_by) values
  ('$ORGT3', '$TO3', 'owner', now(), '$M3');
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0394 2S Main', 'WH-0394-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values ('$ORG', '$MGR', '$WH', true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  ('$ITEM', '$ORG', '$WH', 'SKU-0394-2S', '0394 2S item', 100, 'active', 'none');
insert into public.purchase_orders (id, organization_id, po_number, status) values ('$PO', '$ORG', 'PO-0394-2S', 'draft');
-- 1: an in-progress count assigned to P1, claimed by the manager.
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at, assigned_to,
                                 assignment_claimed_at, assignment_claimed_by) values
  ('$CC1', '$ORG', '$WH', 'in_progress', 'warehouse', '$MGR', now(), '$P1', now(), '$MGR');
-- 2: an entry P2 created and last updated.
insert into public.schedule_events (id, organization_id, title, starts_at, status, assigned_user_id, created_by, updated_by) values
  ('$SE2', '$ORG', '0394 race entry', now() + interval '1 day', 'scheduled', null, '$P2', '$P2');
-- 4: a receipt P4 received.
insert into public.receipts (id, organization_id, purchase_order_id, warehouse_id, receipt_number, received_by, immutable_hash) values
  ('$R4', '$ORG', '$PO', '$WH', 'RCV-0394-2S', '$P4', repeat('e', 64));
-- 5: P5's pending order.
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$OR5', '$ORG', '$WH', 'pending_approval', 'internal', '$P5', 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values ('$OR5', '$ITEM', 5);
-- 11: P11 named on 1,900 marked rows.
insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id)
select '$ORG', '$ITEM', 'adjust', 0, 100, 100, '$P11' from generate_series(1, 1000);
insert into public.audit_logs (organization_id, user_id, event)
select '$ORG', '$P11', 'test.0394.race' from generate_series(1, 900);
SQL
then
  echo "fixture setup failed:"; cat "$TMP/setup.out"; exit 1
fi

# ═══ 1. Release vs assign ═════════════════════════════════════════════════
echo "== 1. the subject's count is held FOR UPDATE; the subject's account is deleted meanwhile"
V0="$(q "select assignment_version from public.cycle_counts where id = '$CC1'")"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1.A.out" 2>&1 <<SQL
set application_name to '0394-race-1-A';
begin;
select 'A=locked' from public.cycle_counts where id = '$CC1' for update;
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-1-A || bad "1: session A never reached its pg_sleep"
T0=$(now_ms)
delete_as_gotrue 0394-race-1-B "$P1" > "$TMP/1.B.out" 2>&1
T1=$(now_ms)
wait "$PID"
check "1: B (supabase_auth_admin) deleted the account" "$(has 'B=deleted' "$TMP/1.B.out")" "1"
if [ $((T1 - T0)) -ge 1500 ]; then ok "1: B waited for A ($((T1 - T0)) ms)"; else bad "1: B did not wait ($((T1 - T0)) ms)"; fi
check "1: the count is released: assignee and claim cleared, version + 1" \
  "$(q "select concat_ws('/', coalesce(assigned_to::text, 'null'), coalesce(assignment_claimed_at::text, 'null'),
                         coalesce(assignment_claimed_by::text, 'null'), assignment_version - $V0) from public.cycle_counts where id = '$CC1'")" \
  "null/null/null/1"
check "1: the account is gone" "$(users_left "$P1")" "0"

# ═══ 2. Stamp vs edit ═════════════════════════════════════════════════════
echo "== 2. a manager renames the subject's schedule entry and holds; the subject's account is deleted meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2.A.out" 2>&1 <<SQL
set application_name to '0394-race-2-A';
begin;
$(as_mgr)
update public.schedule_events set title = '0394 race edited' where id = '$SE2' returning 'A=updated';
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-2-A || bad "2: session A never reached its pg_sleep"
T0=$(now_ms)
delete_as_gotrue 0394-race-2-B "$P2" > "$TMP/2.B.out" 2>&1
T1=$(now_ms)
wait "$PID"
check "2: A updated, B deleted" "$(has 'A=updated' "$TMP/2.A.out")/$(has 'B=deleted' "$TMP/2.B.out")" "1/1"
if [ $((T1 - T0)) -ge 1500 ]; then ok "2: B waited for A ($((T1 - T0)) ms)"; else bad "2: B did not wait ($((T1 - T0)) ms)"; fi
check "2: A's title and updated_by stay; created_by null and stamped; updated_by (the manager) not stamped" \
  "$(q "select concat_ws('/', title, coalesce(created_by::text, 'null'), coalesce(deleted_users ? 'created_by', false),
                         updated_by, coalesce(deleted_users ? 'updated_by', false)) from public.schedule_events where id = '$SE2'")" \
  "0394 race edited/null/t/$MGR/f"

# ═══ 3. Last owner vs a joining member (F1) ═══════════════════════════════
echo "== 3. a member joins the solo owner's organization (uncommitted); the solo owner deletes meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.A.out" 2>&1 <<SQL
set application_name to '0394-race-3-A';
begin;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORGB', '$J', 'staff', now()) returning 'A=joined';
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-3-A || bad "3: session A never reached its pg_sleep"
T0=$(now_ms)
delete_as_gotrue 0394-race-3-B "$O2" > "$TMP/3.B.out" 2>&1
T1=$(now_ms)
wait "$PID"
check "3: B deleted the solo owner, A's member joined" "$(has 'B=deleted' "$TMP/3.B.out")/$(has 'A=joined' "$TMP/3.A.out")" "1/1"
if [ $((T1 - T0)) -lt 1500 ]; then ok "3: B did not wait for the uncommitted member ($((T1 - T0)) ms)"; else bad "3: B waited ($((T1 - T0)) ms)"; fi
check "3: (the F1 residual, as documented) the organization has one accepted member and no owner" \
  "$(q "select count(*) filter (where accepted_at is not null) || '/' || count(*) filter (where role = 'owner')
          from public.organization_members where organization_id = '$ORGB'")" "1/0"
note "3: F1 remedy: the reviewed SQL runbook (plan F14) promotes the member; the trigger expired the org's pending invites"

# ═══ 4. The deletion check vs a held row lock ═════════════════════════════
echo "== 4. a receipt the subject received is held FOR UPDATE; account_deletion_check meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.A.out" 2>&1 <<SQL
set application_name to '0394-race-4-A';
begin;
select 'A=locked' from public.receipts where id = '$R4' for update;
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-4-A || bad "4: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.B.out" 2>&1 <<SQL
begin;
$(as_service)
select 'B=' || public.account_deletion_check('$P4')::text;
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "4: the check answered deletable:false with sqlstate 55P03" \
  "$(grep -c '^B=.*"sqlstate": "55P03".*"deletable": false' "$TMP/4.B.out")" "1"
if [ $((T1 - T0)) -lt 2000 ]; then ok "4: within its 900 ms budget plus overhead ($((T1 - T0)) ms)"; else bad "4: it took $((T1 - T0)) ms"; fi
check "4: A was unaffected" "$(has 'A=locked' "$TMP/4.A.out"),$(grep -c 'ERROR' "$TMP/4.A.out")" "1,0"
check "4: nothing persisted: the account, the receiver, no stamp, the membership" \
  "$(users_left "$P4")/$(q "select received_by::text || '/' || coalesce(deleted_users::text, 'null') from public.receipts where id = '$R4'")/$(q "select count(*) from public.organization_members where user_id = '$P4'")" \
  "1/$P4/null/1"

# ═══ 5. Approve vs delete ═════════════════════════════════════════════════
echo "== 5. A locks the requester's order and approves after B's deletion is waiting on it"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/5.A.out" 2>&1 <<SQL
set application_name to '0394-race-5-A';
begin;
select 'A=locked' from public.order_requests where id = '$OR5' for update;
select pg_sleep(2.5);
$(as_mgr)
select 'A=' || r.status from public.approve_order_request('$OR5') r;
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-5-A || bad "5: session A never reached its pg_sleep"
delete_as_gotrue 0394-race-5-B "$P5" > "$TMP/5.B.out" 2>&1
wait "$PID"
A_DL="$(has '40P01: deadlock detected' "$TMP/5.A.out")"
B_DL="$(has '40P01: deadlock detected' "$TMP/5.B.out")"
STATE="$(q "select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || (o.requester_deleted_at is not null)::text
              from public.order_requests o where o.id = '$OR5'")"
if [ $((A_DL + B_DL)) -gt 1 ]; then bad "5: both sessions got 40P01"; fi
if [ "$A_DL" = "1" ]; then
  note "5: the approve was the deadlock victim"
  check "5: B deleted; the order still pending, requester null and marked" "$(has 'B=deleted' "$TMP/5.B.out")/$STATE" "1/pending_approval/null/true"
elif [ "$B_DL" = "1" ]; then
  note "5: the deletion was the deadlock victim"
  check "5: A approved; the requester intact" "$(has 'A=approved' "$TMP/5.A.out")/$STATE/$(users_left "$P5")" "1/approved/$P5/false/1"
else
  note "5: no deadlock: the deletion waited for the approval"
  check "5: both completed: approved, requester null and marked" "$(has 'A=approved' "$TMP/5.A.out")/$(has 'B=deleted' "$TMP/5.B.out")/$STATE" "1/1/approved/null/true"
fi
check "5: any 40P01 came from the server's deadlock detector, not a function body" \
  "$(cat "$TMP/5.A.out" "$TMP/5.B.out" | grep -c 'PL/pgSQL function tg_auth_users_before_delete.*RAISE')" "0"

# ═══ 7a. Transfer vs deletion: deletion first ═════════════════════════════
echo "== 7a. B deletes member M and holds; A transfers ownership to M meanwhile"
( delete_as_gotrue 0394-race-7a-B "$TM" 3 > "$TMP/7a.B.out" 2>&1 ) &
PID=$!
wait_sleeping 0394-race-7a-B || bad "7a: session B never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7a.A.out" 2>&1 <<SQL
set application_name to '0394-race-7a-A';
begin;
$(as_service)
select 'A=' || public.transfer_org_ownership('$ORGT', '$TO', '$TM');
commit;
SQL
T1=$(now_ms)
wait "$PID"
check "7a: B deleted M" "$(has 'B=deleted' "$TMP/7a.B.out")" "1"
check "7a: A failed 22023 (target not an active member)" "$(grep -c 'ERROR:  22023: target user is not an active member' "$TMP/7a.A.out")" "1"
if [ $((T1 - T0)) -ge 1500 ]; then ok "7a: A waited on M's row ($((T1 - T0)) ms)"; else bad "7a: A did not wait ($((T1 - T0)) ms)"; fi
check "7a: the owner is still the only real owner" "$(real_owners "$ORGT")" "$TO"

# ═══ 7b. Transfer first ═══════════════════════════════════════════════════
echo "== 7b. A transfers ownership to M2 and holds; B deletes M2 meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7b.A.out" 2>&1 <<SQL
set application_name to '0394-race-7b-A';
begin;
$(as_service)
select 'A=' || public.transfer_org_ownership('$ORGT', '$TO', '$TM2');
select pg_sleep(3);
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-7b-A || bad "7b: session A never reached its pg_sleep"
T0=$(now_ms)
delete_as_gotrue 0394-race-7b-B "$TM2" > "$TMP/7b.B.out" 2>&1
T1=$(now_ms)
wait "$PID"
check "7b: A transferred" "$(has "A=$TM2" "$TMP/7b.A.out")" "1"
check "7b: B was refused: P0001 last_owner (the check re-read after the lock wait)" "$(grep -c 'ERROR:  P0001: last_owner' "$TMP/7b.B.out")" "1"
if [ $((T1 - T0)) -ge 1500 ]; then ok "7b: B's lock statement waited on M2's row ($((T1 - T0)) ms)"; else bad "7b: B did not wait ($((T1 - T0)) ms)"; fi
check "7b: M2 is the only real owner, the old owner an admin, M2's account intact" \
  "$(real_owners "$ORGT")/$(q "select role from public.organization_members where organization_id = '$ORGT' and user_id = '$TO'")/$(users_left "$TM2")" \
  "$TM2/admin/1"

# ═══ 7c. Two transfers by the same owner ══════════════════════════════════
echo "== 7c. the owner transfers to X1 and to X2 at once"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7c.A.out" 2>&1 <<SQL
set application_name to '0394-race-7c-A';
begin;
$(as_service)
select 'A=' || public.transfer_org_ownership('$ORGT2', '$TO2', '$X1');
select pg_sleep(2);
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-7c-A || bad "7c: session A never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7c.B.out" 2>&1 <<SQL
set application_name to '0394-race-7c-B';
begin;
$(as_service)
select 'B=' || public.transfer_org_ownership('$ORGT2', '$TO2', '$X2');
commit;
SQL
wait "$PID"
check "7c: A transferred, B failed 42501 (the caller is no longer the owner)" \
  "$(has "A=$X1" "$TMP/7c.A.out")/$(grep -c 'ERROR:  42501: caller is not the current owner' "$TMP/7c.B.out")" "1/1"
check "7c: exactly one owner, X1" "$(real_owners "$ORGT2")" "$X1"

# ═══ 7d. The invited_by edge ══════════════════════════════════════════════
echo "== 7d. A locks the owner's row and transfers to M3 (who invited the owner); B deletes M3 meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7d.A.out" 2>&1 <<SQL
set application_name to '0394-race-7d-A';
begin;
select 'A=locked' from public.organization_members where organization_id = '$ORGT3' and user_id = '$TO3' for update;
select pg_sleep(1.5);
$(as_service)
select 'A=' || public.transfer_org_ownership('$ORGT3', '$TO3', '$M3');
commit;
SQL
) &
PID=$!
wait_sleeping 0394-race-7d-A || bad "7d: session A never reached its pg_sleep"
delete_as_gotrue 0394-race-7d-B "$M3" > "$TMP/7d.B.out" 2>&1
wait "$PID"
A_DL="$(has '40P01: deadlock detected' "$TMP/7d.A.out")"
B_DL="$(has '40P01: deadlock detected' "$TMP/7d.B.out")"
if [ "$A_DL" = "1" ] && [ "$B_DL" = "0" ]; then
  note "7d: the transfer was the deadlock victim; the deletion completed"
  check "7d: M3 gone, the owner still the only real owner" "$(users_left "$M3")/$(real_owners "$ORGT3")" "0/$TO3"
elif [ "$B_DL" = "1" ] && [ "$A_DL" = "0" ]; then
  note "7d: the deletion was the deadlock victim; the transfer completed"
  check "7d: M3 is the only real owner and intact" "$(users_left "$M3")/$(real_owners "$ORGT3")" "1/$M3"
else
  note "7d: no deadlock observed (A_DL=$A_DL B_DL=$B_DL)"
  OWN="$(real_owners "$ORGT3")"
  if [ "$OWN" = "$TO3" ] || [ "$OWN" = "$M3" ]; then ok "7d: one real owner ($OWN)"; else bad "7d: owners '$OWN'"; fi
fi
if [ $((A_DL + B_DL)) -le 1 ]; then ok "7d: at most one 40P01 (server-raised)"; else bad "7d: both sessions got 40P01"; fi

# ═══ 8. Two owners delete at once (both start orders) ═════════════════════
two_owners() { # two_owners <tag> <org> <first> <second>
  ( delete_as_gotrue "0394-race-$1-A" "$3" 3 > "$TMP/$1.A.out" 2>&1 ) &
  local pid=$!
  wait_sleeping "0394-race-$1-A" || bad "$1: session A never reached its pg_sleep"
  local t0 t1
  t0=$(now_ms)
  delete_as_gotrue "0394-race-$1-B" "$4" > "$TMP/$1.B.out" 2>&1
  t1=$(now_ms)
  wait "$pid"
  check "$1: the first owner's deletion succeeded" "$(has 'B=deleted' "$TMP/$1.A.out")" "1"
  check "$1: the second waited, re-read and was refused: P0001 last_owner" "$(grep -c 'ERROR:  P0001: last_owner' "$TMP/$1.B.out")" "1"
  if [ $((t1 - t0)) -ge 1500 ]; then ok "$1: the second waited on the lock ($((t1 - t0)) ms)"; else bad "$1: the second did not wait ($((t1 - t0)) ms)"; fi
  check "$1: the organization keeps one real owner (the second)" "$(real_owners "$2")" "$4"
}
echo "== 8. two owners of one organization delete at once"
two_owners 8 "$ORGC" "$C1" "$C2"
echo "== 8. the reverse start order"
two_owners 8r "$ORGC2" "$C4" "$C3"

# ═══ 9. Two members delete at once ════════════════════════════════════════
echo "== 9. two members of one organization delete at once"
( delete_as_gotrue 0394-race-9-A "$Q1" 2 > "$TMP/9.A.out" 2>&1 ) &
PID=$!
wait_sleeping 0394-race-9-A || bad "9: session A never reached its pg_sleep"
T0=$(now_ms)
delete_as_gotrue 0394-race-9-B "$Q2" > "$TMP/9.B.out" 2>&1
T1=$(now_ms)
wait "$PID"
check "9: both deleted" "$(has 'B=deleted' "$TMP/9.A.out")/$(has 'B=deleted' "$TMP/9.B.out")/$(users_left "$Q1")/$(users_left "$Q2")" "1/1/0/0"
if [ $((T1 - T0)) -lt 1500 ]; then ok "9: the second did not wait for the first ($((T1 - T0)) ms)"; else bad "9: the second waited ($((T1 - T0)) ms)"; fi

# ═══ 10. Deletion vs an impersonation seat ending ═════════════════════════
seat_ends() { # seat_ends <tag> <org> <owner> <commit|rollback>
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$1.A.out" 2>&1 <<SQL
set application_name to '0394-race-$1-A';
begin;
delete from public.organization_members where organization_id = '$2' and user_id = '$PA' returning 'A=seat-ended';
select pg_sleep(2);
$4;
SQL
  ) &
  local pid=$!
  wait_sleeping "0394-race-$1-A" || bad "$1: session A never reached its pg_sleep"
  delete_as_gotrue "0394-race-$1-B" "$3" > "$TMP/$1.B.out" 2>&1
  wait "$pid"
  check "$1: the seat removal ran ($4)" "$(has 'A=seat-ended' "$TMP/$1.A.out")" "1"
  check "$1: the only real owner (with a staff member) is refused: P0001 last_owner" "$(grep -c 'ERROR:  P0001: last_owner' "$TMP/$1.B.out")" "1"
  check "$1: the owner and the organization are intact" "$(users_left "$3")/$(real_owners "$2")" "1/$3"
}
echo "== 10. the only real owner deletes while an Act as seat ends (commits)"
seat_ends 10 "$ORGE" "$O4" commit
echo "== 10. the same while the seat removal rolls back"
seat_ends 10r "$ORGE2" "$O5" rollback

# ═══ 11. Timing ═══════════════════════════════════════════════════════════
echo "== 11. a subject named on 1,900 marked rows: the check, then the deletion"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/11.check.out" 2>&1 <<SQL
begin;
$(as_service)
select 'C=' || public.account_deletion_check('$P11')::text;
commit;
SQL
T1=$(now_ms)
CHECK_MS=$((T1 - T0))
check "11: the check answers deletable" "$(grep -c '^C={"deletable": true}$' "$TMP/11.check.out")" "1"
if [ "$CHECK_MS" -lt 2000 ]; then ok "11: the check (a full dry run, undone) took $CHECK_MS ms"; else bad "11: the check took $CHECK_MS ms"; fi
T0=$(now_ms)
delete_as_gotrue 0394-race-11 "$P11" > "$TMP/11.delete.out" 2>&1
T1=$(now_ms)
DEL_MS=$((T1 - T0))
check "11: deleted" "$(has 'B=deleted' "$TMP/11.delete.out")" "1"
if [ "$DEL_MS" -lt 2000 ]; then ok "11: the deletion took $DEL_MS ms"; else bad "11: the deletion took $DEL_MS ms"; fi
check "11: all 1,900 rows kept, user_id null and stamped" \
  "$(q "select (select count(*) from public.stock_movements where organization_id = '$ORG' and user_id is null and deleted_users ? 'user_id' and movement_type = 'adjust' and quantity_change = 0)
              + (select count(*) from public.audit_logs where organization_id = '$ORG' and event = 'test.0394.race' and user_id is null and deleted_users ? 'user_id')")" "1900"

# ═══ 6. Error classes ═════════════════════════════════════════════════════
echo "== 6. error classes"
check "6: no 40001 in any session" "$(cat "$TMP"/*.out | grep -c '40001')" "0"
check "6: no 40P01 outside 5 and 7d" \
  "$(for f in "$TMP"/*.out; do case "$(basename "$f")" in (5.*|7d.*) ;; (*) cat "$f" ;; esac; done | grep -c '40P01')" "0"
check "6: no 0394 function body names 40001 or 40P01" \
  "$(q "select count(*) from pg_proc where oid in (to_regprocedure('public.tg_auth_users_before_delete()'), to_regprocedure('public.tg_mark_deleted_users()'),
                                                    to_regprocedure('public._account_exists(uuid)'), to_regprocedure('public._enforce_schedule_events_writer()'),
                                                    to_regprocedure('public.transfer_org_ownership(uuid,uuid,uuid)'))
                and (prosrc ~ '40001|40P01|serialization_failure|deadlock_detected')")" "0"

cleanup || FAILS=$((FAILS + 1))

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
