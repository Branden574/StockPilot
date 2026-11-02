#!/usr/bin/env bash
#
# Two-session proofs for migration 0429 (B94: removing a member releases their
# open work; the number is provisional until the kit assigns it). pgTAP runs
# in ONE session, so it cannot show a removal racing an assignment, an account
# deletion or a held row.
#
#   1.  Counts (assign_cycle_count). It checks the assignee's membership
#       without locking the membership row (0282), so:
#       1a. the removal committed first: assigning a count to the removed
#           person is refused (invalid_assignee);
#       1b. the assignment committed first: the removal releases it;
#       1c. the RESIDUAL WINDOW: the removal is open (its release has run)
#           while another count is assigned to the same person and commits;
#           when the removal commits, that count is left on a non-member, the
#           state that exists before 0429. Asserted exactly, so the note in
#           0429's header stays true (closing it is a separate item);
#       1d. the removal is open holding the person's own count (its release
#           updated it); assigning that count to them waits on the row, then
#           is refused once the removal commits. Nothing is stranded.
#   2.  Picks (assign_picking, 0390): 2a refused after the removal; 2c the
#       residual window, asserted as in 1c.
#   3.  Deliveries (assign_order_delivery, 0390): 3a refused after the removal
#       (driver_not_member); 3c the residual window, asserted as in 1c.
#   4.  Removal and account deletion of the same person, both orders. Both
#       lock the person's membership row first (0393's lock loop takes it FOR
#       NO KEY UPDATE; the removal deletes it), so the second waits for the
#       first and nothing deadlocks: 4a removal first, then the deletion goes
#       through; 4b deletion first, then the removal deletes nothing. Either
#       way the work is released once and the account is gone.
#   5.  A count row held FOR UPDATE elsewhere for 8 s: the removal waits on it
#       in the release, gives up at the trigger's lock_timeout (5 s) with
#       55P03, and nothing is kept: the membership, the count and the audit
#       log are as before.
#   6.  No session ever saw 40001 or 40P01.
#
# Runs against the LOCAL stack only (CONTAINER, default
# supabase_db_stockpilot; the migration scratch stack is supabase_db_spmig,
# run it holding that stack's slot) with 0429 applied. Fixtures live under
# the 04290000-... namespace and are removed at the start, at the end and by
# the EXIT trap. Exit status 0 = every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0429_member_release_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04290000-0000-0000-0000-00000000000a'
OWN='04290000-0000-0000-0000-0000000000a0'
ADM='04290000-0000-0000-0000-0000000000a1'
SUB='04290000-0000-0000-0000-0000000000a2'
SUB2='04290000-0000-0000-0000-0000000000a3'
SUB3='04290000-0000-0000-0000-0000000000a4'
HOLD='04290000-0000-0000-0000-0000000000a5'
WH='04290000-0000-0000-0000-0000000000c1'
CH='04290000-0000-0000-0000-0000000000c2'
C_OWN='04290000-0000-0000-0000-0000000000d1'
C_FREE='04290000-0000-0000-0000-0000000000d2'
P_FREE='04290000-0000-0000-0000-0000000000e1'
D_FREE='04290000-0000-0000-0000-0000000000e2'
USERS="'$OWN','$ADM','$SUB','$SUB2','$SUB3','$HOLD'"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
wait_event() { # wait_event <application_name> <wait_event>
  local _
  for _ in $(seq 1 200); do
    [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ] && return 0
    sleep 0.05
  done
  return 1
}
wait_locked() { # wait_locked <application_name>: until it waits on a lock
  local _
  for _ in $(seq 1 200); do
    [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ] && return 0
    sleep 0.05
  done
  return 1
}
# One session: <app> <sub or empty for postgres> <sql> [seconds to hold before commit]
# As `authenticated` with that JWT subject when a sub is given.
session() {
  local as=""
  [ -n "$2" ] && as="set local role authenticated; select set_config('request.jwt.claim.sub', '$2', true); select set_config('request.jwt.claim.role', 'authenticated', true);"
  printf "set application_name to '%s';\nbegin;\n%s\n%s\nselect pg_sleep(%s);\ncommit;\n" "$1" "$as" "$3" "${4:-0}" \
    | "${PSQL[@]}" > "$TMP/$1.out" 2>&1
}
err_of() { grep -m1 -oE 'ERROR: +[^:]+' "$TMP/$1.out" | sed 's/ERROR: *//' ; }
remove_sql() { echo "delete from public.organization_members where organization_id = '$ORG' and user_id = '$1';"; }
member() { q "select count(*) from public.organization_members where organization_id = '$ORG' and user_id = '$1'"; }
released_rows() { q "select count(*) from public.audit_logs where organization_id = '$ORG' and metadata ->> 'released_user_id' = '$1'"; }

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.notifications where organization_id = '$ORG';
delete from public.audit_logs where organization_id = '$ORG';
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.organizations where id = '$ORG') + (select count(*) from auth.users where id in ($USERS))")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}
# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() { wait 2>/dev/null; cleanup >/dev/null 2>&1; rm -rf "$TMP"; }
trap on_exit EXIT

if [ "$(q "select count(*) from pg_trigger where tgname = 'trg_organization_members_release_open_work'")" != "1" ]; then
  echo "needs 0429 applied (the trigger trg_organization_members_release_open_work)"; exit 1
fi
cleanup || exit 1

# The fixture, and a reset to it between cases: the subject (SUB, SUB2, SUB3)
# a staff member of ORG with warehouse access, owning count C_OWN; C_FREE,
# P_FREE (picking) and D_FREE (staged for delivery) assigned to nobody.
fixture() {
  "${PSQL[@]}" >/dev/null <<SQL || { echo "the fixture failed"; exit 1; }
insert into auth.users (id, email, raw_user_meta_data) values
  ('$OWN', 'r429-own@b94.test', '{}'), ('$ADM', 'r429-adm@b94.test', '{}'), ('$SUB', 'r429-sub@b94.test', '{}'),
  ('$SUB2', 'r429-sub2@b94.test', '{}'), ('$SUB3', 'r429-sub3@b94.test', '{}'), ('$HOLD', 'r429-hold@b94.test', '{}')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values ('$ORG', 'R429', 'r429') on conflict (id) do nothing;
insert into public.organization_modules (organization_id, module_id, enabled, tier) values ('$ORG', 'orders', true, 'optional')
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$OWN', 'owner', now()), ('$ORG', '$ADM', 'admin', now())
  on conflict (organization_id, user_id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', 'R429', 'WH-R429', 'active')
  on conflict (id) do nothing;
insert into public.charters (id, organization_id, name, code, status) values ('$CH', '$ORG', 'R429 Charter', 'CH-R429', 'active')
  on conflict (id) do nothing;
SQL
}
reset_subject() { # reset_subject <subject>: a member again, C_OWN theirs, the free rows free
  "${PSQL[@]}" >/dev/null <<SQL || { echo "the reset of $1 failed"; exit 1; }
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$1', 'staff', now())
  on conflict (organization_id, user_id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary)
  select '$ORG', '$1', '$WH', true
   where not exists (select 1 from public.user_warehouse_assignments where user_id = '$1' and warehouse_id = '$WH');
delete from public.audit_logs where organization_id = '$ORG';
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.order_requests where organization_id = '$ORG';
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at,
                                 assigned_to, assignment_claimed_at, assignment_claimed_by, assignment_version) values
  ('$C_OWN',  '$ORG', '$WH', 'in_progress', 'warehouse', '$ADM', now(), '$1', now(), '$ADM', 1),
  ('$C_FREE', '$ORG', '$WH', 'in_progress', 'warehouse', '$ADM', now(), null, null, null, 1);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, pick_slip_generated_by, pick_slip_generated_at) values
  ('$P_FREE', '$ORG', '$WH', 'picking_in_progress', 'internal', '$ADM', 'pickup', null, '$ADM', now(), '$ADM', now()),
  ('$D_FREE', '$ORG', '$WH', 'staged_for_delivery', 'internal', '$ADM', 'delivery', '$CH', '$ADM', now(), '$ADM', now());
SQL
}
fixture
# shellcheck disable=SC2329 # the readers are passed by name to race_kind
count_on() { q "select coalesce(assigned_to::text, 'null') from public.cycle_counts where id = '$1'"; }
# shellcheck disable=SC2329
picker_on() { q "select coalesce(assigned_picker_id::text, 'null') from public.order_requests where id = '$1'"; }
# shellcheck disable=SC2329
driver_on() { q "select coalesce(assigned_delivery_user_id::text, 'null') from public.order_requests where id = '$1'"; }

# Case <tag> <assign sql for SUB> <reader of the row> <row id> <refusal>
#   a: removal committed, then the assignment: refused.
#   c: removal open 2 s; the assignment runs and commits meanwhile; then the
#      removal commits: the row is left on the non-member (the residual).
race_kind() {
  local tag="$1" assign="$2" reader="$3" row="$4" refusal="$5"

  reset_subject "$SUB"
  session "${tag}a-remove" "$ADM" "$(remove_sql "$SUB")"
  session "${tag}a-assign" "$ADM" "$assign"
  check "${tag}a: removal first, then the assignment is refused" "$(err_of "${tag}a-assign")" "$refusal"
  check "${tag}a: the row stays free" "$($reader "$row")" "null"

  reset_subject "$SUB"
  ( session "${tag}c-remove" "$ADM" "$(remove_sql "$SUB")" 2 ) &
  local rpid=$!
  wait_event "${tag}c-remove" PgSleep || bad "${tag}c: the removal never reached its hold"
  session "${tag}c-assign" "$ADM" "$assign"
  wait "$rpid"
  if grep -q ERROR "$TMP/${tag}c-assign.out" "$TMP/${tag}c-remove.out"; then
    bad "${tag}c: $(grep -h ERROR "$TMP/${tag}c-assign.out" "$TMP/${tag}c-remove.out" | head -2 | tr '\n' ' ')"
  fi
  check "${tag}c: RESIDUAL (documented in 0429): an assignment that commits while the removal is open is left on the non-member" \
    "$(member "$SUB")/$($reader "$row")" "0/$SUB"
}

echo "== 1. counts (assign_cycle_count)"
race_kind 1 "select assigned_to from public.assign_cycle_count('$C_FREE', '$SUB');" count_on "$C_FREE" "invalid_assignee"

reset_subject "$SUB"
session 1b-assign "$ADM" "select assigned_to from public.assign_cycle_count('$C_FREE', '$SUB');"
session 1b-remove "$ADM" "$(remove_sql "$SUB")"
check "1b: assignment first, then the removal releases it (and its own count)" "$(count_on "$C_FREE")/$(count_on "$C_OWN")" "null/null"

reset_subject "$SUB"
( session 1d-remove "$ADM" "$(remove_sql "$SUB")" 2 ) &
RPID=$!
wait_event 1d-remove PgSleep || bad "1d: the removal never reached its hold"
MS0=$(now_ms)
session 1d-assign "$ADM" "select assigned_to from public.assign_cycle_count('$C_OWN', '$SUB');"
MS1=$(now_ms)
wait "$RPID"
check "1d: assigning the count the removal released waits on its row, then is refused" "$(err_of 1d-assign)" "invalid_assignee"
if [ $((MS1 - MS0)) -ge 1000 ]; then ok "1d: it waited $((MS1 - MS0)) ms"; else bad "1d: it did not wait ($((MS1 - MS0)) ms)"; fi
check "1d: nothing stranded" "$(count_on "$C_OWN")" "null"

echo "== 2. picks (assign_picking)"
race_kind 2 "select assigned_picker_id from public.assign_picking('$P_FREE', '$SUB');" picker_on "$P_FREE" "invalid_picker"

echo "== 3. deliveries (assign_order_delivery)"
race_kind 3 "select assigned_delivery_user_id from public.assign_order_delivery('$D_FREE', '$SUB');" driver_on "$D_FREE" "driver_not_member"

echo "== 4. removal and account deletion of the same person"
reset_subject "$SUB2"
( session 4a-remove "$ADM" "$(remove_sql "$SUB2")" 2 ) &
RPID=$!
wait_event 4a-remove PgSleep || bad "4a: the removal never reached its hold"
( session 4a-delete "" "delete from auth.users where id = '$SUB2';" ) &
DPID=$!
if wait_locked 4a-delete; then ok "4a: the account deletion waits for the removal"; else bad "4a: the account deletion did not wait"; fi
wait "$RPID" "$DPID"
check "4a: removal first: both go through, the work released once, the account gone" \
  "$(err_of 4a-remove)|$(err_of 4a-delete)|$(count_on "$C_OWN")|$(released_rows "$SUB2")|$(q "select count(*) from auth.users where id = '$SUB2'")" "||null|2|0"

reset_subject "$SUB3"
( session 4b-delete "" "delete from auth.users where id = '$SUB3';" 2 ) &
DPID=$!
wait_event 4b-delete PgSleep || bad "4b: the account deletion never reached its hold"
( session 4b-remove "$ADM" "$(remove_sql "$SUB3")" ) &
RPID=$!
if wait_locked 4b-remove; then ok "4b: the removal waits for the account deletion"; else bad "4b: the removal did not wait"; fi
wait "$RPID" "$DPID"
check "4b: deletion first: both finish, the removal deletes nothing and writes nothing, the count released by 0393" \
  "$(err_of 4b-remove)|$(err_of 4b-delete)|$(count_on "$C_OWN")|$(released_rows "$SUB3")|$(q "select count(*) from auth.users where id = '$SUB3'")" "||null|0|0"

echo "== 5. a count row held elsewhere"
reset_subject "$SUB"
( session 5-holder "" "select 1 from public.cycle_counts where id = '$C_OWN' for update;" 8 ) &
HPID=$!
wait_event 5-holder PgSleep || bad "5: the holder never reached its sleep"
MS0=$(now_ms)
session 5-remove "$ADM" "$(remove_sql "$SUB")"
MS1=$(now_ms)
wait "$HPID"
check "5: the removal gives up with 55P03" "$(grep -c 'lock timeout' "$TMP/5-remove.out")" "1"
if [ $((MS1 - MS0)) -ge 4500 ] && [ $((MS1 - MS0)) -lt 7500 ]; then ok "5: after $((MS1 - MS0)) ms (lock_timeout 5s)"; else bad "5: after $((MS1 - MS0)) ms"; fi
check "5: nothing kept: still a member, the count still theirs, no audit row" \
  "$(member "$SUB")/$(count_on "$C_OWN")/$(released_rows "$SUB")" "1/$SUB/0"

if cat "$TMP"/*.out | grep -qE '40001|40P01|deadlock|could not serialize'; then bad "6: a session saw 40001 or 40P01"; else ok "6: no session saw 40001 or 40P01"; fi

cleanup || bad "cleanup"
echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
