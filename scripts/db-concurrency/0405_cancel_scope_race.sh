#!/usr/bin/env bash
#
# Two-session proofs for migration 0405 (security slice E): an approver's
# cancel asks write access to the order's warehouse, decided on the order row
# cancel_order_request locks. pgTAP runs in ONE session, so it cannot show the
# race this closes (stockpilot-work/six/followups.md, RACE, low): the service
# reads the approver's own order as pending approval (the requester's cancel,
# no warehouse asked), someone approves it, and only then does the cancel
# reach the database.
#
#   1.  The race. A (a manager) approves the scoped approver's own pending
#       order in warehouse B and keeps its transaction open; B (the scoped
#       approver: staff assigned to warehouse A, granted orders:approve)
#       cancels it. B waits on A's row lock, then reads "approved" under its
#       own lock and is refused 42501 forbidden, hint warehouse_write. The
#       order ends approved, by A.
#   2.  The control: the same in warehouse A, their own warehouse. B waits,
#       then cancels the approved order (an approver's cancel where they
#       work). The order ends cancelled, by B.
#   3.  The other order: B cancels their own pending order in warehouse B
#       first (the requester's cancel, no warehouse asked) and keeps its
#       transaction open; A's approval waits, then is refused
#       invalid_status_transition. The order ends cancelled, by B.
#   4.  The mutation the term exists for: a copy of cancel_order_request with
#       the slice E warehouse term taken out (production's body, before
#       0405), in a probe schema, raced exactly as case 1: B's cancel goes
#       through after A's approval, so the scoped approver cancels an
#       approved order of a warehouse they do not work in. The real function
#       (case 1) refuses it. The probe schema is dropped at the end.
#   5.  No session ever saw 40001 or 40P01.
#
# Runs against a LOCAL stack only, with 0405 applied (CONTAINER, default the
# dev stack's supabase_db_stockpilot; the migration scratch stack is
# supabase_db_spmig). Fixtures live under the 04051111-... namespace and are
# removed at the start, at the end and by the EXIT trap. Exit status 0 = every
# check passed.
#
# Usage: bash scripts/db-concurrency/0405_cancel_scope_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04051111-0000-0000-0000-00000000000a'
MGR='04051111-0000-0000-0000-0000000000a1'
STFAP='04051111-0000-0000-0000-0000000000a2'
WHA='04051111-0000-0000-0000-0000000000c1'
WHB='04051111-0000-0000-0000-0000000000c2'
ITA='04051111-0000-0000-0000-0000000000c3'
ITB='04051111-0000-0000-0000-0000000000c4'
O1='04051111-0000-0000-0000-0000000000d1'
O2='04051111-0000-0000-0000-0000000000d2'
O3='04051111-0000-0000-0000-0000000000d3'
O4='04051111-0000-0000-0000-0000000000d4'
USERS="'$MGR','$STFAP'"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
has() { grep -cF -- "$1" "$2"; }
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
wait_locked() { # until that backend waits on a lock (any lock type)
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
# An order's status, who approved it and who cancelled it.
ostate() {
  q "select o.status || '/' || coalesce(o.approved_by::text, 'null') || '/' || coalesce(o.cancelled_by::text, 'null')
       from public.order_requests o where o.id = '$1'"
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop schema if exists zz_probe_0405 cascade;
delete from public.notifications where organization_id = '$ORG';
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
                                 + (select count(*) from auth.users where id in ($USERS))
                                 + (select count(*) from pg_namespace where nspname = 'zz_probe_0405')")"
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

if [ "$(q "select count(*) from pg_proc where proname = 'cancel_order_request' and prosrc like '%Slice E: an approver''s cancel asks write access%'")" != "1" ]; then
  echo "0405 is not applied on this stack"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',   '0405-2s-mgr@test.local',   '{}'::jsonb),
  ('$STFAP', '0405-2s-stfap@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0405 Two Session Org', '0405-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',   'manager', now()),
  ('$ORG', '$STFAP', 'staff',   now());
insert into public.warehouses (id, organization_id, name, code, status) values
  ('$WHA', '$ORG', '0405 2S Main',  'WH-0405-2SA', 'active'),
  ('$WHB', '$ORG', '0405 2S Annex', 'WH-0405-2SB', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  ('$ORG', '$STFAP', '$WHA', true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  ('$ORG', '$STFAP', 'orders:approve', true);
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITA', '$ORG', '$WHA', '2S main item',  'SKU-0405-2SA', 100, 'active'),
  ('$ITB', '$ORG', '$WHB', '2S annex item', 'SKU-0405-2SB', 100, 'active');
-- The scoped approver's own pending orders: O1, O3 and O4 in warehouse B,
-- O2 in warehouse A.
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select v.id, '$ORG', v.wh, 'pending_approval', 'internal', '$STFAP', 'pickup'
  from (values ('$O1'::uuid, '$WHB'::uuid), ('$O2'::uuid, '$WHA'::uuid), ('$O3'::uuid, '$WHB'::uuid),
               ('$O4'::uuid, '$WHB'::uuid)) v(id, wh);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select v.id, v.it, 2
  from (values ('$O1'::uuid, '$ITB'::uuid), ('$O2'::uuid, '$ITA'::uuid), ('$O3'::uuid, '$ITB'::uuid),
               ('$O4'::uuid, '$ITB'::uuid)) v(id, it);
SQL
then
  echo "fixture setup failed"; exit 1
fi

as_user() { # the user's claims, as authenticated (PostgREST's shape)
  printf "set local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\n" "$1"
}

# race <case> <order> <cancel function>: A approves and holds; B cancels.
race_approve_then_cancel() {
  local c="$1" o="$2" fn="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$c.A.out" 2>&1 <<SQL
set application_name to '0405-race-$c-A';
begin;
$(as_user "$MGR")
select 'A=' || r.status from public.approve_order_request('$o') r;
select pg_sleep(2);
commit;
SQL
  ) &
  local pa=$!
  wait_sleeping "0405-race-$c-A" || bad "$c: session A never reached its pg_sleep"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$c.B.out" 2>&1 <<SQL
set application_name to '0405-race-$c-B';
begin;
$(as_user "$STFAP")
select 'B=' || r.status from $fn('$o', 'Changed my mind') r;
commit;
SQL
  ) &
  local pb=$!
  if wait_locked "0405-race-$c-B"; then ok "$c: B's cancel waits on A's row lock"; else bad "$c: B never waited on the row lock"; fi
  wait "$pa"; wait "$pb"
}

# ═══ 1. The race: approved under the cancel's feet, in warehouse B ════════
echo "== 1. A approves the scoped approver's own pending order in warehouse B; B's cancel waits"
race_approve_then_cancel 1 "$O1" public.cancel_order_request
check "1: A approved it" "$(grep -c '^A=approved$' "$TMP/1.A.out")" "1"
check "1: B was refused (hint warehouse_write)" "$(has 'warehouse_write' "$TMP/1.B.out")" "1"
check "1: B's refusal is 42501" "$(has '42501' "$TMP/1.B.out")" "1"
check "1: the order stays approved, by A, cancelled by no one" "$(ostate "$O1")" "approved/$MGR/null"

# ═══ 2. The control: the same in their own warehouse ═════════════════════
echo "== 2. the same in warehouse A, where the scoped approver works"
race_approve_then_cancel 2 "$O2" public.cancel_order_request
check "2: A approved it" "$(grep -c '^A=approved$' "$TMP/2.A.out")" "1"
check "2: B cancelled it after A committed" "$(grep -c '^B=cancelled$' "$TMP/2.B.out")" "1"
check "2: the order ends cancelled by B" "$(ostate "$O2")" "cancelled/$MGR/$STFAP"

# ═══ 3. The requester's cancel first ══════════════════════════════════════
echo "== 3. B cancels their own pending order in warehouse B first; A's approval waits"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.B.out" 2>&1 <<SQL
set application_name to '0405-race-3-B';
begin;
$(as_user "$STFAP")
select 'B=' || r.status from public.cancel_order_request('$O3', 'Changed my mind') r;
select pg_sleep(2);
commit;
SQL
) &
PB=$!
wait_sleeping 0405-race-3-B || bad "3: session B never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.A.out" 2>&1 <<SQL
set application_name to '0405-race-3-A';
begin;
$(as_user "$MGR")
select 'A=' || r.status from public.approve_order_request('$O3') r;
commit;
SQL
) &
PA=$!
if wait_locked 0405-race-3-A; then ok "3: A's approval waits on B's cancel"; else bad "3: A never waited"; fi
wait "$PB"; wait "$PA"
check "3: B cancelled their own pending order (no warehouse asked)" "$(grep -c '^B=cancelled$' "$TMP/3.B.out")" "1"
check "3: A was refused invalid_status_transition" "$(has 'invalid_status_transition' "$TMP/3.A.out")" "1"
check "3: the order ends cancelled by B, never approved" "$(ostate "$O3")" "cancelled/null/$STFAP"

# ═══ 4. The mutation: production's body raced the same way ════════════════
echo "== 4. a copy of cancel_order_request without the slice E warehouse term, raced as in case 1"
if ! "${PSQL[@]}" >/dev/null 2>"$TMP/4.setup.err" <<'SQL'
create schema zz_probe_0405;
grant usage on schema zz_probe_0405 to authenticated;
do $probe$
declare
  v_def text := pg_get_functiondef('public.cancel_order_request(uuid, text)'::regprocedure);
  v_cut text := substring(v_def from '\n  -- Slice E: an approver''s cancel asks write access.*?\n  end if;\n');
begin
  if v_cut is null then
    raise exception 'probe: the slice E cancel term was not found';
  end if;
  v_def := replace(v_def, v_cut, E'\n');
  v_def := replace(v_def, 'FUNCTION public.cancel_order_request(', 'FUNCTION zz_probe_0405.cancel_order_request(');
  execute v_def;
end $probe$;
revoke all on function zz_probe_0405.cancel_order_request(uuid, text) from public, anon;
grant execute on function zz_probe_0405.cancel_order_request(uuid, text) to authenticated;
SQL
then
  bad "4: the probe copy could not be made: $(cat "$TMP/4.setup.err")"
else
  check "4: the probe has no warehouse term" \
    "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'zz_probe_0405' and p.prosrc like '%user_can_access_warehouse%'")" "0"
  race_approve_then_cancel 4 "$O4" zz_probe_0405.cancel_order_request
  check "4: A approved it" "$(grep -c '^A=approved$' "$TMP/4.A.out")" "1"
  check "4: without the term B's cancel goes through" "$(grep -c '^B=cancelled$' "$TMP/4.B.out")" "1"
  check "4: the scoped approver cancelled warehouse B's approved order (what case 1 refuses)" "$(ostate "$O4")" "cancelled/$MGR/$STFAP"
fi

# ═══ 5. Never a retryable error ═══════════════════════════════════════════
echo "== 5. no session saw 40001 or 40P01"
check "5: no 40001/40P01 in any session's output" "$(cat "$TMP"/*.out | grep -cE '40001|40P01|could not serialize|deadlock detected')" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
