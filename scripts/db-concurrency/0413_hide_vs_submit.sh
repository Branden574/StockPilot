#!/usr/bin/env bash
#
# Two-session proof for migration 0413 (ordering visibility). pgTAP runs in
# ONE session, so it cannot show what a submission does while another session
# holds a hide (or the reverse), or that the gate's lock is the right one.
#
#   1. Hide holds first. A manager hides two items (one call) and keeps the
#      transaction open; a staff member's place_order_request for both waits
#      (on the item row lock the gate takes), and once the hide commits it is
#      refused and recorded as item_not_orderable {item: hidden_from_orders}
#      for both. No order header, no line.
#   2. Submit holds first. The staff member places an order for two items and
#      keeps the transaction open; the manager's hide of both waits, then
#      commits after the order: the order stands (existing history), a new
#      submission for them is refused, and the order placed before the hide
#      approves, picks and is signed for normally.
#   3. A hide that cannot get its row lock within lock_timeout (3 s) answers
#      55P03 with nothing changed and nothing audited.
#   4. Add items: a hide that commits after add_order_request_lines topped up
#      one line and before it inserts the next (a local probe pauses the call
#      between the two) leaves the order exactly as it was: the top-up is
#      undone, no new line, the call answers order_item_hidden.
#   5. Lock strength: a plain item UPDATE held open (FOR NO KEY UPDATE) does
#      not delay a submission for that item (the gate takes FOR KEY SHARE,
#      the FK check's own lock); a hide does (case 1 observes the wait).
#   6. A forged foreign id never takes a row lock in another organization:
#      with that row locked by another session, the hide answers P0002 at
#      once, naming only the caller's id.
#   7. A record moved out of a delegated member's read scope by another
#      session between the call's start and its lock (the mover holds the
#      row, the hide waits, the mover commits) is refused, not written.
#   8. No session ever sees 40001 or 40P01; no orphan order header remains.
#   9. A hide and a show of one record by two members serialize: the show
#      waits on the hide's row lock, then applies on top (one audit row each).
#
# LOCAL stack only (CONTAINER, default supabase_db_stockpilot; the migration
# scratch stack is supabase_db_spmig) with 0413 applied. Fixtures are
# committed under the 04132222-... namespace and removed at the start, at the
# end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0413_hide_vs_submit.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04132222-0000-0000-0000-00000000000a'
ORG2='04132222-0000-0000-0000-00000000000b'
MGR='04132222-0000-0000-0000-0000000000a1'
STF='04132222-0000-0000-0000-0000000000a2'
STFA='04132222-0000-0000-0000-0000000000a3'
MGR2='04132222-0000-0000-0000-0000000000a4'
WH='04132222-0000-0000-0000-0000000000d1'
WH2='04132222-0000-0000-0000-0000000000d2'
WHB='04132222-0000-0000-0000-0000000000d3'
RACK='04132222-0000-0000-0000-0000000000e1'
A1='04132222-0000-0000-0000-000000000101'
A2='04132222-0000-0000-0000-000000000102'
B1='04132222-0000-0000-0000-000000000103'
B2='04132222-0000-0000-0000-000000000104'
C1='04132222-0000-0000-0000-000000000105'
T1='04132222-0000-0000-0000-000000000106'
X1='04132222-0000-0000-0000-000000000107'
P1='04132222-0000-0000-0000-000000000108'
M1='04132222-0000-0000-0000-000000000109'
A3='04132222-0000-0000-0000-00000000010a'
F1='04132222-0000-0000-0000-00000000010b'
OADD='04132222-0000-0000-0000-000000000201'
LT='04132222-0000-0000-0000-000000000301'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '04133333-0000-4000-8000-%012d' "$1"; }
op()  { printf '04134444-0000-4000-8000-%012d' "$1"; }

# A request for place_order_request (snake_case, as the service builds it).
req() { # req <item> [item]
  local lines="jsonb_build_object('item_id', '$1', 'quantity', 1)"
  [ -n "${2:-}" ] && lines="$lines, jsonb_build_object('item_id', '$2', 'quantity', 1)"
  printf "jsonb_build_object('organization_id', '%s', 'placer_user_id', '%s', 'surface', 'app', 'warehouse_id', '%s', 'fulfillment_type', 'pickup', 'delivery_charter_id', null, 'on_behalf_name', null, 'on_behalf_email', null, 'notes', null, 'needed_by', null, 'lines', jsonb_build_array(%s))" \
    "$ORG" "$STF" "$WH" "$lines"
}
place_sql() { printf "select 'R=' || public.place_order_request(%s, '%s')::text;" "$(req "$2" "${3:-}")" "$1"; }
hide_sql()  { printf "select 'R=' || public.set_order_catalog_visibility('%s', array[%s]::uuid[], %s, '%s', 'web')::text;" "$ORG" "$1" "$2" "$3"; }

# wait_for <application_name> <wait_event_type> [wait_event]: until that
# session waits on it.
wait_for() {
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

# as_user <application_name|-> <user> <statements> [end]: one transaction as
# that member (authenticated, with claims); end is commit or rollback.
as_user() {
  local app="$1" sub="$2" body="$3" end="${4:-commit}"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "set local role authenticated;" \
    "set local \"request.jwt.claim.role\" to 'authenticated';" \
    "set local \"request.jwt.claim.sub\" to '$sub';" \
    "$body" \
    "$end;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
# as_postgres <application_name> <statements> [end]
as_postgres() {
  printf '%s\n' "set application_name to '$1';" "begin;" "$2" "${3:-commit};" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
ans() { sed -n 's/^R=//p' "$1"; }
jget() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "null")
out = []
for path in sys.argv[1:]:
    v = d
    for part in path.split("."):
        v = v.get(part) if isinstance(v, dict) else None
    out.append("-" if v is None else json.dumps(v, sort_keys=True) if isinstance(v, (bool, dict, list)) else str(v))
print("/".join(out))
' "$@"
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop trigger if exists trg_zz_0413_probe_pause on public.order_request_lines;
drop function if exists public._zz0413_probe_pause();
delete from public.stock_reservations where organization_id in ('$ORG', '$ORG2');
delete from public.order_submissions where organization_id in ('$ORG', '$ORG2');
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id in ('$ORG', '$ORG2'));
delete from public.order_requests where organization_id in ('$ORG', '$ORG2');
delete from public.organizations where id in ('$ORG', '$ORG2');
delete from auth.users where id in ('$MGR', '$STF', '$STFA', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.order_requests where organization_id in ('$ORG', '$ORG2')) + (select count(*) from public.inventory_items where organization_id in ('$ORG', '$ORG2'))")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() {
  wait 2>/dev/null
  cleanup >/dev/null 2>&1
  if [ -n "${KEEP_TMP:-}" ]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cleanup || exit 1

if [ "$(q "select count(*) from pg_proc where proname = 'set_order_catalog_visibility' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "0413 is not applied on this stack (no public.set_order_catalog_visibility)"; exit 1
fi

# ═══ Fixture ═══════════════════════════════════════════════════════════════
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0413-2s-mgr@ordvis.test',  '{}'::jsonb),
  ('$STF',  '0413-2s-stf@ordvis.test',  '{}'::jsonb),
  ('$STFA', '0413-2s-stfa@ordvis.test', '{}'::jsonb),
  ('$MGR2', '0413-2s-mgr2@ordvis.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  ('$ORG',  '0413 Two Session Org',   '0413-two-session'),
  ('$ORG2', '0413 Two Session Other', '0413-two-session-other');
update public.organizations set mfa_policy = 'optional' where id in ('$ORG', '$ORG2');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG',  '$MGR',  'manager', now()),
  ('$ORG',  '$STF',  'staff',   now()),
  ('$ORG',  '$STFA', 'staff',   now()),
  ('$ORG2', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  ('$WH',  '$ORG',  '0413 2S Main',  'WH-0413-2S',  'active'),
  ('$WH2', '$ORG',  '0413 2S Annex', 'WH-0413-2S2', 'active'),
  ('$WHB', '$ORG2', '0413 2S Other', 'WH-0413-2SB', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  ('$ORG', '$STF',  '$WH', true),
  ('$ORG', '$STFA', '$WH', true);
-- StockPilot's exception for the delegated staff member (written as postgres).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  ('$ORG', '$STFA', 'orders:manage_catalog_visibility', true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  ('$RACK', '$ORG', '$WH', '41-A', 'shelf', 'rack');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id) values
  ('$A1', '$ORG', '$WH', '0413-2S-A1', '2S item A1', 10, 'active', 'none', '$RACK'),
  ('$A2', '$ORG', '$WH', '0413-2S-A2', '2S item A2', 10, 'active', 'none', '$RACK'),
  ('$B1', '$ORG', '$WH', '0413-2S-B1', '2S item B1', 10, 'active', 'none', '$RACK'),
  ('$B2', '$ORG', '$WH', '0413-2S-B2', '2S item B2', 10, 'active', 'none', '$RACK'),
  ('$C1', '$ORG', '$WH', '0413-2S-C1', '2S item C1', 10, 'active', 'none', '$RACK'),
  ('$T1', '$ORG', '$WH', '0413-2S-T1', '2S item T1', 10, 'active', 'none', '$RACK'),
  ('$X1', '$ORG', '$WH', '0413-2S-X1', '2S item X1', 10, 'active', 'none', '$RACK'),
  ('$P1', '$ORG', '$WH', '0413-2S-P1', '2S item P1', 10, 'active', 'none', '$RACK'),
  ('$M1', '$ORG', '$WH', '0413-2S-M1', '2S item M1', 0,  'active', 'none', null),
  ('$A3', '$ORG', '$WH', '0413-2S-A3', '2S item A3', 10, 'active', 'none', '$RACK'),
  ('$F1', '$ORG2', '$WHB', '0413-2S-F1', '2S other item', 10, 'active', 'none', null);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$OADD', '$ORG', '$WH', 'pending_approval', 'internal', '$STF', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested) values
  ('$LT', '$OADD', '$T1', 1);
SQL
then
  echo "fixture setup failed"; exit 1
fi

# ═══ 1. Hide holds first ═══════════════════════════════════════════════════
echo "== 1. a hide of two items holds; a submission for both waits, then is refused"
as_user h1 "$MGR" "$(hide_sql "'$A1', '$A2'" false "$(op 1)") select pg_sleep(2);" > "$TMP/1.h.out" &
HP=$!
wait_for h1 Timeout PgSleep || bad "1: the hide never reached its pause"
MS0=$(now_ms)
as_user s1 "$STF" "$(place_sql "$(key 1)" "$A1" "$A2")" > "$TMP/1.s.out" &
SP=$!
if wait_for s1 Lock; then ok "1: the submission waits on a lock while the hide is open"; else bad "1: the submission never waited"; fi
wait "$HP" "$SP"
MS1=$(now_ms)
check "1: the hide changed both" "$(ans "$TMP/1.h.out" | jget changed)" "[\"$A1\", \"$A2\"]"
check "1: the submission is refused as item_not_orderable, both items hidden_from_orders" \
  "$(ans "$TMP/1.s.out" | jget outcome refusal.reason refusal.detail)" \
  "refused/item_not_orderable/{\"$A1\": \"hidden_from_orders\", \"$A2\": \"hidden_from_orders\"}"
check "1: the refusal is recorded under the key and no order exists" \
  "$(q "select (select outcome from public.order_submissions where key = '$(key 1)') || '/' || (select count(*) from public.order_request_lines l join public.order_requests r on r.id = l.order_request_id where r.organization_id = '$ORG' and l.item_id in ('$A1', '$A2'))")" \
  "refused/0"
if [ $((MS1 - MS0)) -ge 1000 ]; then ok "1: the submission finished only after the hide committed ($((MS1 - MS0)) ms)"; else bad "1: finished in $((MS1 - MS0)) ms"; fi

# ═══ 2. Submit holds first ════════════════════════════════════════════════
echo "== 2. a submission for two items holds; the hide waits, then commits after the order"
as_user s2 "$STF" "$(place_sql "$(key 2)" "$B1" "$B2") select pg_sleep(2);" > "$TMP/2.s.out" &
SP=$!
wait_for s2 Timeout PgSleep || bad "2: the submission never reached its pause"
as_user h2 "$MGR" "$(hide_sql "'$B1', '$B2'" false "$(op 2)")" > "$TMP/2.h.out" &
HP=$!
if wait_for h2 Lock; then ok "2: the hide waits on the order's item locks"; else bad "2: the hide never waited"; fi
wait "$SP" "$HP"
check "2: the order was placed (existing history)" "$(ans "$TMP/2.s.out" | jget outcome)" "placed"
check "2: then the hide changed both" "$(ans "$TMP/2.h.out" | jget changed)" "[\"$B1\", \"$B2\"]"
ORDER2="$(ans "$TMP/2.s.out" | jget order.id)"
as_user - "$STF" "$(place_sql "$(key 3)" "$B1")" > "$TMP/2.s2.out"
check "2: a new submission for a now-hidden item is refused" "$(ans "$TMP/2.s2.out" | jget outcome refusal.reason)" "refused/item_not_orderable"
as_user - "$MGR" "select 'A=' || (public.approve_order_request('$ORDER2')).status;" > "$TMP/2.ap.out"
check "2: the order placed before the hide approves" "$(sed -n 's/^A=//p' "$TMP/2.ap.out")" "approved"
q "update public.order_requests set status = 'pick_slip_generated' where id = '$ORDER2'" >/dev/null
as_user - "$MGR" "select 'P=' || (public.complete_picking('$ORDER2')).status;" > "$TMP/2.pick.out"
q "update public.order_requests set status = 'packing_slip_generated' where id = '$ORDER2'" >/dev/null
q "update public.order_requests set status = 'staged_for_pickup' where id = '$ORDER2'" >/dev/null
as_user - "$MGR" "select 'P=' || (public.confirm_physical_signature('$ORDER2', 'Race tester')).status;" > "$TMP/2.sign.out"
check "2: and it is picked and signed for" "$(sed -n 's/^P=//p' "$TMP/2.pick.out")/$(sed -n 's/^P=//p' "$TMP/2.sign.out")" "picking_complete/completed"

# ═══ 3. lock_timeout ══════════════════════════════════════════════════════
echo "== 3. a submission holds the item past the hide's lock_timeout"
as_user s3 "$STF" "$(place_sql "$(key 4)" "$C1") select pg_sleep(5);" rollback > "$TMP/3.s.out" &
SP=$!
wait_for s3 Timeout PgSleep || bad "3: the submission never reached its pause"
MS0=$(now_ms)
as_user - "$MGR" "$(hide_sql "'$C1'" false "$(op 3)")" > "$TMP/3.h.out"
MS1=$(now_ms)
wait "$SP"
check "3: the hide answers 55P03 (busy, retryable)" "$(grep -c 'ERROR:  55P03' "$TMP/3.h.out")" "1"
if [ $((MS1 - MS0)) -ge 2500 ] && [ $((MS1 - MS0)) -lt 4500 ]; then ok "3: after about 3 s ($((MS1 - MS0)) ms)"; else bad "3: answered after $((MS1 - MS0)) ms"; fi
check "3: nothing changed and nothing was audited" \
  "$(q "select (select order_catalog_visible::text from public.inventory_items where id = '$C1') || '/' || (select count(*) from public.audit_logs where organization_id = '$ORG' and metadata->>'entity_id' = '$C1')")" \
  "true/0"

# ═══ 4. Add items: a hide between the top-up and the insert ═══════════════
echo "== 4. add_order_request_lines pauses after its top-up; a hide of the next item commits meanwhile"
# Local probe only: pause the call right after the top-up of T1 (T1 < X1, so
# the top-up comes first). Dropped below and by cleanup.
q "create function public._zz0413_probe_pause() returns trigger language plpgsql set search_path = public as \$\$ begin if new.item_id = '$T1' then perform pg_sleep(2); end if; return new; end \$\$;" >/dev/null
q "create trigger trg_zz_0413_probe_pause after update on public.order_request_lines for each row execute function public._zz0413_probe_pause();" >/dev/null
as_user s4 "$STF" "select 'R=' || public.add_order_request_lines('$OADD', '[{\"itemId\": \"$T1\", \"quantity\": 4}, {\"itemId\": \"$X1\", \"quantity\": 1}]'::jsonb)::text;" > "$TMP/4.s.out" &
SP=$!
wait_for s4 Timeout PgSleep || bad "4: the add never reached its pause"
ok "4: the add is paused after its top-up of the first item"
as_user - "$MGR" "$(hide_sql "'$X1'" false "$(op 4)")" > "$TMP/4.h.out"
check "4: the hide of the next item commits meanwhile" "$(ans "$TMP/4.h.out" | jget changed)" "[\"$X1\"]"
wait "$SP"
check "4: the add answers order_item_hidden for that item" "$(grep -c "HINT:  order_item_hidden" "$TMP/4.s.out")/$(grep -c "DETAIL:  $X1" "$TMP/4.s.out")" "1/1"
check "4: zero rows changed: the top-up is undone, no new line" \
  "$(q "select (select trim_scale(quantity_requested)::text from public.order_request_lines where id = '$LT') || '/' || (select count(*) from public.order_request_lines where order_request_id = '$OADD')")" \
  "1/1"
q "drop trigger trg_zz_0413_probe_pause on public.order_request_lines; drop function public._zz0413_probe_pause();" >/dev/null

# ═══ 5. Lock strength ══════════════════════════════════════════════════════
echo "== 5. a plain item UPDATE held open does not delay a submission"
as_postgres u5 "update public.inventory_items set reorder_point = coalesce(reorder_point, 0) + 1 where id = '$P1'; select pg_sleep(3);" rollback > "$TMP/5.u.out" &
UP=$!
wait_for u5 Timeout PgSleep || bad "5: the item update never reached its pause"
MS0=$(now_ms)
as_user - "$STF" "$(place_sql "$(key 5)" "$P1")" > "$TMP/5.s.out"
MS1=$(now_ms)
wait "$UP"
check "5: the submission is placed" "$(ans "$TMP/5.s.out" | jget outcome)" "placed"
if [ $((MS1 - MS0)) -lt 1500 ]; then ok "5: without waiting for the item update ($((MS1 - MS0)) ms; it held the row 3 s)"; else bad "5: took $((MS1 - MS0)) ms"; fi

# ═══ 6. A foreign id never locks another org's row ═══════════════════════
echo "== 6. another org's row is locked elsewhere; the hide naming it answers at once"
as_postgres l6 "select 1 from public.inventory_items where id = '$F1' for update; select pg_sleep(4);" rollback > "$TMP/6.l.out" &
LP=$!
wait_for l6 Timeout PgSleep || bad "6: the locker never reached its pause"
MS0=$(now_ms)
as_user h6 "$MGR" "$(hide_sql "'$A3', '$F1'" false "$(op 6)")" > "$TMP/6.h.out" &
HP=$!
# Sample pg_locks while the hide runs: a row lock it tried to take on the
# other org's row would show as an ungranted transactionid (or tuple) lock
# of the hide's backend, waiting on the locker.
WAITS=0
for _ in $(seq 1 30); do
  W="$(q "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.application_name = 'h6' and not l.granted")"
  WAITS=$((WAITS + W))
  kill -0 "$HP" 2>/dev/null || break
  sleep 0.05
done
wait "$HP"
MS1=$(now_ms)
wait "$LP"
check "6: pg_locks never showed the hide waiting for a lock" "$WAITS" "0"
check "6: the hide is refused naming only the foreign id" "$(grep -c "HINT:  order_catalog_items_unavailable" "$TMP/6.h.out")/$(grep -c "DETAIL:  \[\"$F1\"\]" "$TMP/6.h.out")" "1/1"
if [ $((MS1 - MS0)) -lt 1500 ]; then ok "6: at once: it never waited on the other org's row ($((MS1 - MS0)) ms)"; else bad "6: took $((MS1 - MS0)) ms"; fi
check "6: nothing changed" "$(q "select order_catalog_visible::text from public.inventory_items where id = '$A3'")" "true"

# ═══ 7. A record moved out of scope between the call and its lock ════════
echo "== 7. a mover holds a record; the delegated member's hide waits; the record leaves their warehouse"
as_postgres v7 "update public.inventory_items set warehouse_id = '$WH2' where id = '$M1'; select pg_sleep(2);" > "$TMP/7.v.out" &
VP=$!
wait_for v7 Timeout PgSleep || bad "7: the mover never reached its pause"
as_user h7 "$STFA" "$(hide_sql "'$M1'" false "$(op 7)")" > "$TMP/7.h.out" &
HP=$!
if wait_for h7 Lock; then ok "7: the hide waits on the mover's row"; else bad "7: the hide never waited"; fi
wait "$VP" "$HP"
check "7: the hide is refused (the record is no longer in the member's read scope)" \
  "$(grep -c "HINT:  order_catalog_items_unavailable" "$TMP/7.h.out")/$(grep -c "DETAIL:  \[\"$M1\"\]" "$TMP/7.h.out")" "1/1"
check "7: not written" "$(q "select order_catalog_visible::text || '/' || (warehouse_id = '$WH2')::text from public.inventory_items where id = '$M1'")" "true/true"

# ═══ 9. Hide against show ════════════════════════════════════════════════
echo "== 9. a hide holds; a show of the same record by another member waits, then applies on top"
as_user h9 "$MGR" "$(hide_sql "'$A3'" false "$(op 9)") select pg_sleep(2);" > "$TMP/9.h.out" &
HP=$!
wait_for h9 Timeout PgSleep || bad "9: the hide never reached its pause"
as_user s9 "$STFA" "$(hide_sql "'$A3'" true "$(op 10)")" > "$TMP/9.s.out" &
SP=$!
if wait_for s9 Lock; then ok "9: the show waits on the hide's row lock"; else bad "9: the show never waited"; fi
wait "$HP" "$SP"
check "9: the hide changed it, then the show changed it back (serial, last writer wins)" \
  "$(ans "$TMP/9.h.out" | jget changed)/$(ans "$TMP/9.s.out" | jget changed)/$(q "select order_catalog_visible::text from public.inventory_items where id = '$A3'")" \
  "[\"$A3\"]/[\"$A3\"]/true"
check "9: two audit rows, one per change" \
  "$(q "select count(*) from public.audit_logs where organization_id = '$ORG' and event = 'item.order_visibility_changed' and metadata->>'entity_id' = '$A3'")" "2"

# ═══ 8. Never 40001 / 40P01, no orphan header ═════════════════════════════
echo "== 8. no retryable class, no orphan"
if grep -lE 'ERROR:  (40001|40P01)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "8: some session saw 40001 or 40P01: $(grep -lE 'ERROR:  (40001|40P01)' "$TMP"/*.out | tr '\n' ' ')"
else
  ok "8: no session saw 40001 or 40P01"
fi
check "8: no order header without a line" \
  "$(q "select count(*) from public.order_requests r where r.organization_id = '$ORG' and not exists (select 1 from public.order_request_lines l where l.order_request_id = r.id)")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
exit $(( FAILS > 0 ))
