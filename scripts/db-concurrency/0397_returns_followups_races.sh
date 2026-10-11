#!/usr/bin/env bash
#
# Two-session proof for migration 0397 (returns RX-4, the follow-ups).
# pgTAP runs in ONE session, so it cannot show what "Close the rest" does
# while another session holds the RMA row or the replacement order's row, nor
# which item rows a requester create locks. Written at the RX-4 desk stage
# (2026-10-11) and RUN AT THE TEST STAGE.
#
#   R1. Close the rest against itself (a double click, or the web and the
#       phone at once). A closes and holds its transaction; B waits on the RMA
#       row, then replays (changed false): one replacement_closed decision.
#   R2. Close the rest against resume_fulfillment on the same backorder (both
#       orders). R2a: the close holds (RMA, then the order); resume waits on
#       the order row, then refuses (the order is completed): nothing resumed.
#       R2b: resume holds (the order, then items; the gate reads the RMA
#       without a lock); the close waits on the order row, then refuses
#       replacement_not_backordered: the rest stays in picking.
#   R3. Close the rest against close_return on the same RMA (both orders):
#       both take the RMA row first, so one waits; both succeed and the
#       exchange reads completed.
#   R4. No session ever sees 40001 or 40P01, nothing deadlocks, and on hand
#       equals the sum of holdings for every fixture item.
#   R5. The requester tier's lock set (RX-3 security review, finding 2).
#       R5a: a third session holds an item that is NOT one of the line's
#       options FOR UPDATE; a requester create naming it answers the one
#       generic exchange_item_not_eligible at once (it never queued on that
#       row: before RX-4 it waited for the holder, then answered the same).
#       R5b (control): the same with an item that IS an option: the create
#       waits for the holder (the key-share in id order is still taken, so
#       the lock order RX-2 proved still holds), then succeeds.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0397 applied. Fixtures are committed under the 03979999-... namespace
# and removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: bash scripts/db-concurrency/0397_returns_followups_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03979999-0000-0000-0000-00000000000a'
MGR='03979999-0000-0000-0000-0000000000a1'
MGR2='03979999-0000-0000-0000-0000000000a2'
WH='03979999-0000-0000-0000-0000000000b1'
R1='03979999-0000-0000-0000-000000000c31'
R2='03979999-0000-0000-0000-000000000c12'
GRP='03979999-0000-0000-0000-000000000a01'
# The returned item (M), its group sibling (L, an option), a plain item that
# is no option (X), and one part item per backorder (P1..P4, 1 in stock each).
IM='03979999-0000-0000-0000-0000000000e1'
IL='03979999-0000-0000-0000-0000000000e2'
IX='03979999-0000-0000-0000-0000000000e3'
IP1='03979999-0000-0000-0000-0000000000f1'
IP2='03979999-0000-0000-0000-0000000000f2'
IP3='03979999-0000-0000-0000-0000000000f3'
IP4='03979999-0000-0000-0000-0000000000f4'
IP5='03979999-0000-0000-0000-0000000000f5'
ORDER='03979999-0000-0000-0000-000000000101'
ORDERQ='03979999-0000-0000-0000-000000000102'
L='03979999-0000-0000-0000-000000000201'
LQ='03979999-0000-0000-0000-000000000202'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '03979999-0000-4000-8000-%012d' "$1"; }

status_of()    { q "select status from public.returns where id = '$1'"; }
rl_of()        { q "select id from public.return_lines where return_id = '$1'"; }
xl_of()        { q "select id from public.return_exchange_lines where return_id = '$1'"; }
repl_of()      { q "select coalesce((select id::text from public.order_requests where replacement_for_return_id = '$1' and status not in ('cancelled', 'denied')), 'none')"; }
order_status() { q "select status from public.order_requests where id = '$1'"; }
holds_of()     { q "select coalesce(trim_scale(sum(quantity))::text, '0') from public.stock_reservations where order_request_id = '$1' and released_at is null"; }
decisions()    { q "select count(*) from public.return_decisions where return_id = '$1' and kind = '$2'"; }
rev_of()       { q "select coalesce(max(revision), 0) from public.return_decisions where return_id = '$1' and kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled')"; }
xstatus()      { q "select exchange_status from public.return_overview where id = '$1'"; }

body_ex2() { printf '{"reasonCode":"other","lines":[{"orderRequestLineId":"%s","quantity":2,"disposition":"restock","exchange":{"itemId":"%s"}}]}' "$1" "$2"; }
body_req() { printf '{"reasonCode":"other","lines":[{"orderRequestLineId":"%s","quantity":1,"exchange":{"itemId":"%s"}}]}' "$1" "$2"; }
dec_backorder() { printf '{"lines":[{"returnLineId":"%s","disposition":"restock","restock":{"target":"staging"}}],"exchange":[{"action":"approve","exchangeLineId":"%s"}],"replacement":{"whenShort":"backorder"}}' "$1" "$2"; }

rest_sql()    { printf "select 'R=' || public.close_return_replacement_rest('%s', %s, 'Race close the rest', %s)::text;" "$1" "$2" "${3:-null}"; }
resume_sql()  { printf "select 'R=' || (public.resume_fulfillment('%s')).status;" "$1"; }
close_sql()   { printf "select 'R=' || public.close_return('%s')::text;" "$1"; }
req_sql()     { printf "select 'R=' || public.create_requester_return_request('%s', '%s'::jsonb, '%s', '{\"channel\":\"token\"}'::jsonb)::text;" "$ORDERQ" "$(body_req "$LQ" "$1")" "$2"; }

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

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.idempotency_keys where organization_id = '$ORG';
delete from public.stock_reservations where organization_id = '$ORG';
with r as (delete from public.returns where organization_id = '$ORG' returning 1),
     l as (delete from public.order_request_lines
            where order_request_id in (select id from public.order_requests where organization_id = '$ORG') returning 1),
     o as (delete from public.order_requests where organization_id = '$ORG' returning 1)
select (select count(*) from r) + (select count(*) from l) + (select count(*) from o);
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.returns where organization_id = '$ORG') + (select count(*) from public.return_decisions where organization_id = '$ORG') + (select count(*) from public.stock_movements where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.order_requests where organization_id = '$ORG')")"
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

cleanup || exit 1

if [ "$(q "select count(*) from pg_proc where proname = 'close_return_replacement_rest' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "0397 is not applied on this stack (no public.close_return_replacement_rest)"; exit 1
fi

# as_role <application_name|-> <role> <user|-> <statements> [end]: one
# transaction as that role (claims set for a user), end commit or rollback.
as_role() {
  local app="$1" role="$2" sub="$3" body="$4" end="${5:-commit}"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "set local role $role;" \
    "set local \"request.jwt.claim.role\" to '$role';" \
    "$( [ "$sub" != "-" ] && printf "set local \"request.jwt.claim.sub\" to '%s';" "$sub")" \
    "$body" \
    "$end;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
as_user() { as_role "$1" authenticated "$2" "$3" "${4:-commit}"; }

# ═══ Fixture ══════════════════════════════════════════════════════════════
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0397-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0397-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0397 Two Session Org', '0397-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  ('$ORG', 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0397 2S Main', 'WH-0397-2S', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  ('$R1', '$ORG', '$WH', '31-C', 'shelf', 'rack', now() - interval '30 minutes'),
  ('$R2', '$ORG', '$WH', '12-B', 'shelf', 'rack', now() - interval '29 minutes');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status) values
  ('$GRP', '$ORG', '2S Followup Shirt', '0397-2s|followup shirt', 'each', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id, group_id, variant_size, variant_key) values
  ('$IM',  '$ORG', '$WH', '0397-2S-M',  '2S shirt',   20, 'active', 'none', '$R1', '$GRP', 'M', 'M'),
  ('$IL',  '$ORG', '$WH', '0397-2S-L',  '2S shirt',   20, 'active', 'none', '$R2', '$GRP', 'L', 'L'),
  ('$IX',  '$ORG', '$WH', '0397-2S-X',  '2S plain',    5, 'active', 'none', '$R2', null, null, null),
  ('$IP1', '$ORG', '$WH', '0397-2S-P1', '2S part 1',   1, 'active', 'none', '$R2', null, null, null),
  ('$IP2', '$ORG', '$WH', '0397-2S-P2', '2S part 2',   1, 'active', 'none', '$R2', null, null, null),
  ('$IP3', '$ORG', '$WH', '0397-2S-P3', '2S part 3',   1, 'active', 'none', '$R2', null, null, null),
  ('$IP4', '$ORG', '$WH', '0397-2S-P4', '2S part 4',   1, 'active', 'none', '$R2', null, null, null),
  ('$IP5', '$ORG', '$WH', '0397-2S-P5', '2S part 5',   1, 'active', 'none', '$R2', null, null, null);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$ORDER',  '$ORG', '$WH', 'completed', 'internal', '$MGR', 'pickup'),
  ('$ORDERQ', '$ORG', '$WH', 'completed', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  ('$L',  '$ORDER',  '$IM', 40, 40),
  ('$LQ', '$ORDERQ', '$IM', 10, 10);
SQL
then
  echo "fixture setup failed"; exit 1
fi

ans() { sed -n 's/^R=//p' "$TMP/$1.$2.out"; }
jget() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "null")
out = []
for path in sys.argv[1:]:
    v = d
    for part in path.split("."):
        v = v.get(part) if isinstance(v, dict) else None
    out.append("-" if v is None else json.dumps(v) if isinstance(v, bool) else str(v))
print("/".join(out))
' "$@"
}
refused() { # refused <tag> <side> <sqlstate> <hint>: 1/1 when that output carries both
  printf '%s/%s' "$(grep -c "ERROR:  $3" "$TMP/$1.$2.out")" "$(grep -c "HINT:  $4" "$TMP/$1.$2.out")"
}

# part_handed_over <key number> <part item>: sets R to an exchange RMA of 2
# units for the part item (1 in stock), approved on backorder, released early,
# picked, staged and signed (backordered: 1 handed over, 1 never held), then
# received. Checked here, so a failed setup counts.
N=0
part_handed_over() {
  N=$((N + 1))
  as_user - "$MGR" "select 'R=' || public.create_return_request('$ORDER', '$(body_ex2 "$L" "$2")'::jsonb, '$(key "$1")')::text;" > "$TMP/mk.$N.out"
  R="$(sed -n 's/^R=//p' "$TMP/mk.$N.out" | jget returnId)"
  as_user - "$MGR" "select 'R=' || public.approve_return('$R', 0, '$(dec_backorder "$(rl_of "$R")" "$(xl_of "$R")")'::jsonb, false)::text;" > "$TMP/ap.$N.out"
  local o; o="$(repl_of "$R")"
  as_user - "$MGR" "select 'R=' || public.release_return_replacement_early('$R', '$o', 'Customer is completing an in-person exchange today.')::text;" > "$TMP/rel.$N.out"
  as_user - "$MGR" "update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = auth.uid() where id = '$o' and status = 'approved';
select 'P=' || (public.complete_picking('$o')).status;
select 'P=' || (public.generate_order_packing_slips('$o')).status;
update public.order_requests set status = 'staged_for_pickup', staged_by = auth.uid() where id = '$o';
select 'P=' || (public.confirm_physical_signature('$o', 'Race tester')).status;
select 'P=' || (public.receive_return('$R'))->>'status';" > "$TMP/prep.$N.out"
  check "set up $1 (picked, packed, signed: backordered; the RMA received)" \
    "$(sed -n 's/^P=//p' "$TMP/prep.$N.out" | tr '\n' '/')" "picking_complete/packing_slip_generated/backordered/received/"
  O="$(repl_of "$R")"
}

# race <tag> <A's user> <A's statements> <A's end> <B's user> <B's statements>:
# A runs, then sleeps 3 s holding its transaction (and its locks); once A sits
# in pg_sleep, B runs. Records how long B took.
race() {
  local tag="$1" au="$2" a="$3" aend="$4" bu="$5" b="$6"
  ( as_user "0397-race-$tag-A" "$au" "$a
select pg_sleep(3);" "$aend" > "$TMP/$tag.A.out" ) &
  local pid=$!
  wait_for "0397-race-$tag-A" Timeout PgSleep || bad "$tag: session A never reached its pg_sleep"
  local t0; t0=$(now_ms)
  as_user - "$bu" "$b" > "$TMP/$tag.B.out"
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
waited() { # waited <tag> <label>
  local w; w="$(cat "$TMP/$1.waited")"
  if [ "$w" -ge 1500 ]; then ok "$2: B waited for A ($w ms)"; else bad "$2: B did not wait ($w ms)"; fi
}

# ═══ R1. Close the rest against itself ════════════════════════════════════
echo "== R1. two closes of the same rest at once"
part_handed_over 1 "$IP1"
race twice "$MGR" "$(rest_sql "$R" "$(rev_of "$R")" "'backordered'")" commit "$MGR2" "$(rest_sql "$R" "$(rev_of "$R")" "'backordered'")"
check "R1: A closed the rest" "$(ans twice A | jget changed replay)" "true/false"
check "R1: B waited, then replayed" "$(ans twice B | jget changed replay)" "false/true"
waited twice "R1"
check "R1: the replacement completed with no hold; ONE replacement_closed" \
  "$(order_status "$O")/$(holds_of "$O")/$(decisions "$R" replacement_closed)" "completed/0/1"

# ═══ R2. Close the rest against resume_fulfillment ════════════════════════
echo "== R2a. the close holds; resume waits on the order"
part_handed_over 2 "$IP2"
q "select set_config('request.jwt.claim.sub', '$MGR', false); select public.adjust_stock('$IP2', 1, 'add', '$R2', 'Race restock', null)" >/dev/null
race closeresume "$MGR" "$(rest_sql "$R" "$(rev_of "$R")")" commit "$MGR2" "$(resume_sql "$O")"
check "R2a: A closed the rest" "$(ans closeresume A | jget changed)" "true"
check "R2a: resume is refused (the order is completed)" "$(grep -c 'ERROR:.*invalid_status_transition' "$TMP/closeresume.B.out")" "1"
waited closeresume "R2a"
check "R2a: completed, no hold, nothing resumed" "$(order_status "$O")/$(holds_of "$O")" "completed/0"

echo "== R2b. resume holds; the close waits on the order, then refuses"
part_handed_over 3 "$IP3"
q "select set_config('request.jwt.claim.sub', '$MGR', false); select public.adjust_stock('$IP3', 1, 'add', '$R2', 'Race restock', null)" >/dev/null
race resumeclose "$MGR" "$(resume_sql "$O")" commit "$MGR2" "$(rest_sql "$R" "$(rev_of "$R")")"
check "R2b: A resumed the rest into picking" "$(ans resumeclose A)" "pick_slip_generated"
check "R2b: the close is refused replacement_not_backordered" "$(refused resumeclose B P0001 replacement_not_backordered)" "1/1"
waited resumeclose "R2b"
check "R2b: no replacement_closed decision; the rest stays in picking" \
  "$(decisions "$R" replacement_closed)/$(order_status "$O")" "0/pick_slip_generated"

# ═══ R3. Close the rest against close_return ══════════════════════════════
echo "== R3a. the close of the rest holds; close_return waits on the RMA"
part_handed_over 4 "$IP4"
race restclose "$MGR" "$(rest_sql "$R" "$(rev_of "$R")")" commit "$MGR2" "$(close_sql "$R")"
check "R3a: both finish" "$(ans restclose A | jget changed)/$(ans restclose B | jget status)" "true/closed"
waited restclose "R3a"
check "R3a: the exchange reads completed" "$(xstatus "$R")" "completed"

echo "== R3b. close_return holds; the close of the rest waits, then closes a closed RMA's rest"
part_handed_over 5 "$IP5"
race closerest "$MGR" "$(close_sql "$R")" commit "$MGR2" "$(rest_sql "$R" "$(rev_of "$R")")"
check "R3b: both finish" "$(ans closerest A | jget status)/$(ans closerest B | jget changed status)" "closed/true/closed"
waited closerest "R3b"
check "R3b: the exchange reads completed" "$(xstatus "$R")" "completed"

# ═══ R5. The requester tier's lock set ═══════════════════════════════════
# hold <tag> <item>: a third session holds the item FOR UPDATE for 3 s.
hold() {
  ( printf '%s\n' "set application_name to '0397-hold-$1';" "begin;" \
      "select 1 from public.inventory_items where id = '$2' for update;" \
      "select pg_sleep(3);" "commit;" | "${PSQL[@]}" > "$TMP/hold.$1.out" 2>&1 ) &
  HOLD_PID=$!
  wait_for "0397-hold-$1" Timeout PgSleep || bad "$1: the holder never reached its pg_sleep"
}
echo "== R5a. a requester names an item that is no option while another session holds it"
hold r5a "$IX"
T0=$(now_ms)
as_role - service_role - "$(req_sql "$IX" "$(key 51)")" > "$TMP/r5a.B.out"
T1=$(now_ms)
wait "$HOLD_PID"
check "R5a: the one generic refusal" "$(refused r5a B P0001 exchange_item_not_eligible)" "1/1"
if [ $((T1 - T0)) -lt 1000 ]; then ok "R5a: answered without queuing on the held row ($((T1 - T0)) ms)"; else bad "R5a: the create waited for the holder ($((T1 - T0)) ms): it locked an item that is no option"; fi

echo "== R5b (control). the same with an item that IS an option: the create waits, then succeeds"
hold r5b "$IL"
T0=$(now_ms)
as_role - service_role - "$(req_sql "$IL" "$(key 52)")" > "$TMP/r5b.B.out"
T1=$(now_ms)
wait "$HOLD_PID"
check "R5b: the request was created" "$(sed -n 's/^R=//p' "$TMP/r5b.B.out" | jget status)" "requested"
if [ $((T1 - T0)) -ge 1500 ]; then ok "R5b: it key-shared the option first and waited for the holder ($((T1 - T0)) ms)"; else bad "R5b: it did not wait ($((T1 - T0)) ms): the option is no longer locked before the budget lock"; fi

# ═══ R4. Never 40001 or 40P01; holdings equal on hand ═════════════════════
echo "== R4. never 40001 or 40P01; holdings equal stock on record"
if grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "R4: a session saw 40001 or 40P01: $(grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out | tr '\n' ' ')"
else
  ok "R4: no 40001 or 40P01 in any session"
fi
check "R4: holdings equal stock on record for every fixture item" \
  "$(q "select count(*) from public.inventory_items i where i.organization_id = '$ORG' and i.quantity_on_hand <> (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = i.id)")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
