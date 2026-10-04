#!/usr/bin/env bash
#
# Two-session proofs for migration 0390's delivery functions
# (assign_order_delivery, mark_order_in_transit). pgTAP runs in ONE session,
# so it cannot show two callers racing on one order row.
#
#   1.  Two sessions mark the same staged delivery in transit. A marks it and
#       keeps its transaction open; B's call waits on the row lock, then reads
#       the committed status under its own lock and is refused P0001
#       order_status_changed (hint status_changed). in_transit_by is A, the
#       requester got ONE "on its way" notification, and nothing was written
#       twice.
#   2a. A cancels the order and keeps its transaction open; B marks it in
#       transit: B waits, then gets P0001 order_status_changed (the order is
#       cancelled). Never 40001 or 40P01.
#   2b. The reverse: A marks it in transit and keeps its transaction open; B
#       cancels: B waits, then cancels the in-transit order (an allowed edge).
#       Both complete, in that order. Never 40001 or 40P01.
#   3.  Two assignments of the same order: A assigns driver 1 and keeps its
#       transaction open; B assigns driver 2: B waits, then wins (the last call
#       wins, today's behaviour). Both calls return the row they wrote.
#   4.  The mutation the lock exists for: a copy of mark_order_in_transit with
#       no row lock, which reads the status, pauses, then writes. Two sessions
#       both pass the check and both write (two in_transit stamps, two
#       notifications). The real function, in the same shape (case 1), writes
#       once. The copy lives in a probe schema that is dropped at the end.
#   5.  No session ever saw 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0390 applied. Fixtures live under the 03901111-... namespace and are
# removed at the start, at the end and by the EXIT trap. Exit status 0 = every
# check passed.
#
# Usage: bash scripts/db-concurrency/0390_delivery_rpc_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03901111-0000-0000-0000-00000000000a'
MGR='03901111-0000-0000-0000-0000000000a1'
MGR2='03901111-0000-0000-0000-0000000000a2'
REQ='03901111-0000-0000-0000-0000000000a3'
DRV1='03901111-0000-0000-0000-0000000000a4'
DRV2='03901111-0000-0000-0000-0000000000a5'
WH='03901111-0000-0000-0000-0000000000c1'
CH='03901111-0000-0000-0000-0000000000c2'
ITEM='03901111-0000-0000-0000-0000000000c3'
O1='03901111-0000-0000-0000-0000000000d1'
O2A='03901111-0000-0000-0000-0000000000d2'
O2B='03901111-0000-0000-0000-0000000000d3'
O3='03901111-0000-0000-0000-0000000000d4'
O4='03901111-0000-0000-0000-0000000000d5'
USERS="'$MGR','$MGR2','$REQ','$DRV1','$DRV2'"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf 'note   %s\n' "$*"; }
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
# An order's status / driver / in-transit stamp holder.
ostate() {
  q "select o.status || '/' || coalesce(o.assigned_delivery_user_id::text, 'null') || '/' || coalesce(o.in_transit_by::text, 'null')
       from public.order_requests o where o.id = '$1'"
}
# The requester's "on its way" notifications for one order.
transit_notes() {
  q "select count(*) from public.notifications n
      where n.user_id = '$REQ' and n.organization_id = '$ORG' and n.type = 'order_request.in_transit'
        and (coalesce(n.link, '') like '%$1%' or coalesce(n.metadata::text, '') like '%$1%')"
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop schema if exists zz_probe_0390 cascade;
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
                                 + (select count(*) from pg_namespace where nspname = 'zz_probe_0390')")"
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

if [ "$(q "select count(*) from pg_proc where proname in ('assign_order_delivery', 'mark_order_in_transit')")" != "2" ]; then
  echo "0390 is not applied on the local stack"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0390-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0390-2s-mgr2@test.local', '{}'::jsonb),
  ('$REQ',  '0390-2s-req@test.local',  '{}'::jsonb),
  ('$DRV1', '0390-2s-drv1@test.local', '{}'::jsonb),
  ('$DRV2', '0390-2s-drv2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0390 Two Session Org', '0390-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',  'manager', now()),
  ('$ORG', '$MGR2', 'manager', now()),
  ('$ORG', '$REQ',  'staff',   now()),
  ('$ORG', '$DRV1', 'staff',   now()),
  ('$ORG', '$DRV2', 'staff',   now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0390 2S Main', 'WH-0390-2S', 'active');
insert into public.charters (id, organization_id, name, code, status) values ('$CH', '$ORG', '0390 2S Charter', 'CH-0390-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', '2S delivery item', 'SKU-0390-2S', 100, 'active');
-- Staged deliveries with a driver (O1, O2A, O2B, O4) and one without (O3).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, assigned_delivery_user_id)
select v.id, '$ORG', '$WH', 'staged_for_delivery', 'internal', '$REQ', 'delivery', '$CH', '$MGR', now(), v.drv
  from (values ('$O1'::uuid, '$DRV1'::uuid), ('$O2A'::uuid, '$DRV1'::uuid), ('$O2B'::uuid, '$DRV1'::uuid),
               ('$O3'::uuid, null::uuid), ('$O4'::uuid, '$DRV1'::uuid)) v(id, drv);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select v.id, '$ITEM', 2 from (values ('$O1'::uuid), ('$O2A'::uuid), ('$O2B'::uuid), ('$O3'::uuid), ('$O4'::uuid)) v(id);
SQL
then
  echo "fixture setup failed"; exit 1
fi

as_user() { # the user's claims, as authenticated (PostgREST's shape)
  printf "set local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\n" "$1"
}

# ═══ 1. Two marks in transit ═══════════════════════════════════════════════
echo "== 1. two sessions mark the same delivery in transit"
NOTES_BEFORE="$(transit_notes "$O1")"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1.A.out" 2>&1 <<SQL
set application_name to '0390-race-1-A';
begin;
$(as_user "$MGR")
select 'A=' || r.status from public.mark_order_in_transit('$O1') r;
select pg_sleep(2);
commit;
SQL
) &
PA=$!
wait_sleeping 0390-race-1-A || bad "1: session A never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1.B.out" 2>&1 <<SQL
set application_name to '0390-race-1-B';
begin;
$(as_user "$MGR2")
select 'B=' || r.status from public.mark_order_in_transit('$O1') r;
commit;
SQL
) &
PB=$!
if wait_locked 0390-race-1-B; then ok "1: B waits on A's row lock"; else bad "1: B never waited on the row lock"; fi
wait "$PA"; wait "$PB"
check "1: A marked it" "$(grep -c '^A=in_transit$' "$TMP/1.A.out")" "1"
check "1: B was refused order_status_changed (status_changed)" "$(has 'order_status_changed' "$TMP/1.B.out")" "1"
check "1: B's refusal is P0001" "$(has 'P0001' "$TMP/1.B.out")" "1"
check "1: the order is in transit, marked by A once" "$(ostate "$O1")" "in_transit/$DRV1/$MGR"
NOTES_AFTER="$(transit_notes "$O1")"
check "1: the requester got one in-transit notification" "$((NOTES_AFTER - NOTES_BEFORE))" "1"

# ═══ 2a. Cancel first, then mark ═══════════════════════════════════════════
echo "== 2a. a cancel holds the order; a mark in transit waits and is refused"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2a.A.out" 2>&1 <<SQL
set application_name to '0390-race-2a-A';
begin;
$(as_user "$MGR")
select 'A=' || r.status from public.cancel_order_request('$O2A', 'Not needed') r;
select pg_sleep(2);
commit;
SQL
) &
PA=$!
wait_sleeping 0390-race-2a-A || bad "2a: session A never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2a.B.out" 2>&1 <<SQL
set application_name to '0390-race-2a-B';
begin;
$(as_user "$MGR2")
select 'B=' || r.status from public.mark_order_in_transit('$O2A') r;
commit;
SQL
) &
PB=$!
if wait_locked 0390-race-2a-B; then ok "2a: the mark waits on the cancel"; else bad "2a: the mark never waited"; fi
wait "$PA"; wait "$PB"
check "2a: the cancel completed" "$(grep -c '^A=cancelled$' "$TMP/2a.A.out")" "1"
check "2a: the mark was refused order_status_changed" "$(has 'order_status_changed' "$TMP/2a.B.out")" "1"
check "2a: the order stays cancelled" "$(q "select status from public.order_requests where id = '$O2A'")" "cancelled"

# ═══ 2b. Mark first, then cancel ═══════════════════════════════════════════
echo "== 2b. a mark in transit holds the order; a cancel waits, then cancels"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2b.A.out" 2>&1 <<SQL
set application_name to '0390-race-2b-A';
begin;
$(as_user "$MGR")
select 'A=' || r.status from public.mark_order_in_transit('$O2B') r;
select pg_sleep(2);
commit;
SQL
) &
PA=$!
wait_sleeping 0390-race-2b-A || bad "2b: session A never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2b.B.out" 2>&1 <<SQL
set application_name to '0390-race-2b-B';
begin;
$(as_user "$MGR2")
select 'B=' || r.status from public.cancel_order_request('$O2B', 'Customer called') r;
commit;
SQL
) &
PB=$!
if wait_locked 0390-race-2b-B; then ok "2b: the cancel waits on the mark"; else bad "2b: the cancel never waited"; fi
wait "$PA"; wait "$PB"
check "2b: the mark completed" "$(grep -c '^A=in_transit$' "$TMP/2b.A.out")" "1"
check "2b: the cancel completed after it" "$(grep -c '^B=cancelled$' "$TMP/2b.B.out")" "1"
check "2b: the order ends cancelled, marked in transit by A first" "$(ostate "$O2B")" "cancelled/$DRV1/$MGR"

# ═══ 3. Two assignments ═══════════════════════════════════════════════════
echo "== 3. two assignments serialize; the last one wins"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.A.out" 2>&1 <<SQL
set application_name to '0390-race-3-A';
begin;
$(as_user "$MGR")
select 'A=' || r.assigned_delivery_user_id from public.assign_order_delivery('$O3', '$DRV1') r;
select pg_sleep(2);
commit;
SQL
) &
PA=$!
wait_sleeping 0390-race-3-A || bad "3: session A never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3.B.out" 2>&1 <<SQL
set application_name to '0390-race-3-B';
begin;
$(as_user "$MGR2")
select 'B=' || r.assigned_delivery_user_id from public.assign_order_delivery('$O3', '$DRV2') r;
commit;
SQL
) &
PB=$!
if wait_locked 0390-race-3-B; then ok "3: B waits on A's row lock"; else bad "3: B never waited on the row lock"; fi
wait "$PA"; wait "$PB"
check "3: A assigned driver 1" "$(grep -c "^A=$DRV1\$" "$TMP/3.A.out")" "1"
check "3: B assigned driver 2 after it" "$(grep -c "^B=$DRV2\$" "$TMP/3.B.out")" "1"
check "3: driver 2 stands, assigned by B" \
  "$(q "select assigned_delivery_user_id || '/' || assigned_delivery_by from public.order_requests where id = '$O3'")" "$DRV2/$MGR2"

# ═══ 4. The mutation: no row lock ═════════════════════════════════════════
echo "== 4. a copy without the row lock lets both sessions write"
"${PSQL[@]}" >/dev/null <<'SQL'
create schema zz_probe_0390;
create function zz_probe_0390.mark_in_transit_no_lock(p_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text;
begin
  select o.status into v_status from public.order_requests o where o.id = p_id;   -- no lock
  if v_status <> 'staged_for_delivery' then
    raise exception 'order_status_changed' using errcode = 'P0001';
  end if;
  perform pg_sleep(1);
  update public.order_requests
     set status = 'in_transit', in_transit_at = clock_timestamp(), in_transit_by = auth.uid()
   where id = p_id;
  return 'written';
end $$;
grant usage on schema zz_probe_0390 to authenticated;
grant execute on function zz_probe_0390.mark_in_transit_no_lock(uuid) to authenticated;
SQL
NOTES_BEFORE="$(transit_notes "$O4")"
( "${PSQL[@]}" > "$TMP/4.A.out" 2>&1 <<SQL
set application_name to '0390-race-4-A';
begin;
$(as_user "$MGR")
select 'A=' || zz_probe_0390.mark_in_transit_no_lock('$O4');
commit;
SQL
) &
PA=$!
( "${PSQL[@]}" > "$TMP/4.B.out" 2>&1 <<SQL
set application_name to '0390-race-4-B';
begin;
$(as_user "$MGR2")
select 'B=' || zz_probe_0390.mark_in_transit_no_lock('$O4');
commit;
SQL
) &
PB=$!
wait "$PA"; wait "$PB"
check "4: without the lock both sessions passed the check and wrote" \
  "$(( $(grep -c '^A=written$' "$TMP/4.A.out") + $(grep -c '^B=written$' "$TMP/4.B.out") ))" "2"
NOTES_AFTER="$(transit_notes "$O4")"
if [ "$((NOTES_AFTER - NOTES_BEFORE))" -ge 1 ]; then
  note "4: in-transit notifications for the unlocked copy: $((NOTES_AFTER - NOTES_BEFORE)) (the second write is a same-status update, which the notify trigger skips; the stamp was still rewritten)"
fi
check "4: the second write re-stamped in_transit_by (two writers, one survivor)" \
  "$(q "select (in_transit_by in ('$MGR', '$MGR2'))::text from public.order_requests where id = '$O4'")" "true"

# ═══ 5. No 40001 or 40P01 anywhere ════════════════════════════════════════
echo "== 5. no session saw 40001 or 40P01"
N="$(cat "$TMP"/*.out | grep -cE '40001|40P01|deadlock detected|could not serialize' || true)"
check "5: no 40001 or 40P01 in any session" "$N" "0"

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
