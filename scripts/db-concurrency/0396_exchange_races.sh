#!/usr/bin/env bash
#
# Two-session proof for migration 0396 (returns RX-2: exchanges for staff and
# the counter; the linked replacement order and the return-first gate).
# pgTAP runs in ONE session, so it cannot show what the exchange functions do
# while another session holds the RMA row or the replacement order's row
# (returns plan 3.7, items 1, 2, 6, 7, 8 and 9, with exchanges; both orders
# of each pair).
#
#   1. Approve with an exchange against approve (two managers, one expected
#      revision). 1a: the same decision: B waits on the RMA row, then replays
#      A's answer; ONE replacement order, ONE hold of one unit. 1b: a
#      different decision (B declines the exchange): B waits, then is refused
#      return_changed; A's replacement stands.
#   2. Approve with an exchange against cancel_return. 2a: A approves and
#      holds; B's cancel at revision 0 waits, then return_changed; one live
#      replacement. 2b: A cancels and holds; B's approval waits, then
#      invalid_status_transition: no replacement order exists.
#   6. The replacement's pick slip against the RMA cancel (released early so
#      the gate is open), both orders, no deadlock. 6a: the pick slip holds
#      the order; the cancel waits on it (RMA row, then the replacement), then
#      finds it on a pick slip (undrawn) and cancels it: every hold released.
#      6b: the cancel holds; the pick slip's compare-and-set update waits,
#      then matches no row (the order is cancelled).
#   7. Substitution against complete_picking (X-2). 7a: the substitution
#      holds (old order cancelled undrawn, new one held); complete_picking
#      waits on the old order, then refuses invalid_status_transition: no
#      draw. 7b: complete_picking holds (the batch drawn); the substitution
#      waits, then refuses replacement_already_drawn: one order, its draw.
#   8. cancel_return_replacement against complete_picking (X-2). 8a: the
#      cancel holds; complete_picking waits, then refuses: nothing drawn, every
#      hold released. 8b: complete_picking holds; the cancel waits, then takes
#      the drawn branch: the batch back to Staging on record, the order
#      cancelled, holdings equal on hand.
#   9. receive_return against release_return_replacement_early. 9a: the
#      receipt holds; the release waits, then answers not needed (changed
#      false). 9b: the release holds; the receipt waits, then receives; one
#      released_early decision.
#  11. Two RMAs, one item (desk check F4): approval against approval. 11a: a
#      third session holds item K; B approves an RMA whose replacement is K
#      and L (it waits on K); A approves another RMA with "Add a replacement"
#      of L (it waits on B). Once K is free both finish: B first, then A. The
#      exchange writers take the order-number lock and then every item FOR
#      UPDATE in id order BEFORE any row naming an item, so A never holds a
#      key-share lock on L that B's approve_partial needs (without that, B
#      waits on A's key-share lock while A waits on B's order-number lock:
#      40P01). 11b: A's approval with an added L commits after a pause; B's
#      approval for L waits, then finishes.
#  12. Approval against substitution, same item (desk check F4). 12a: the
#      third session holds K; B substitutes K for one line of an RMA whose
#      replacement is L and N (it waits on K); A approves another RMA with an
#      added L (it waits on B); both finish. 12b: A's substitution to L
#      commits after a pause; B's approval with an added L waits, then
#      finishes.
#  10. No session ever sees 40001 or 40P01, nothing deadlocks, and on hand
#      equals the sum of holdings for every fixture item.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0396 applied. Fixtures are committed under the 03971111-... namespace
# and removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: bash scripts/db-concurrency/0396_exchange_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03971111-0000-0000-0000-00000000000a'
MGR='03971111-0000-0000-0000-0000000000a1'
MGR2='03971111-0000-0000-0000-0000000000a2'
WH='03971111-0000-0000-0000-0000000000b1'
R1='03971111-0000-0000-0000-000000000c31'
R2='03971111-0000-0000-0000-000000000c32'
IM='03971111-0000-0000-0000-0000000000e1'
IL='03971111-0000-0000-0000-0000000000e2'
INAVY='03971111-0000-0000-0000-0000000000e3'
# F4: K sorts before L (the blocker holds K while L is the contended item);
# N is a substitution's source; M2 is the second original line's item.
IK='03971111-0000-0000-0000-0000000000e0'
IN='03971111-0000-0000-0000-0000000000e4'
IM2='03971111-0000-0000-0000-0000000000e5'
ORDER='03971111-0000-0000-0000-000000000101'
ORDER2='03971111-0000-0000-0000-000000000102'
L='03971111-0000-0000-0000-000000000201'
L2A='03971111-0000-0000-0000-000000000202'
L2B='03971111-0000-0000-0000-000000000203'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '03972222-0000-4000-8000-%012d' "$1"; }

# Reads (as the superuser).
status_of()   { q "select status from public.returns where id = '$1'"; }
rl_of()       { q "select id from public.return_lines where return_id = '$1'"; }
xl_of()       { q "select id from public.return_exchange_lines where return_id = '$1'"; }
repl_of()     { q "select coalesce((select id::text from public.order_requests where replacement_for_return_id = '$1' and status not in ('cancelled', 'denied')), 'none')"; }
repl_count()  { q "select count(*) from public.order_requests where replacement_for_return_id = '$1'"; }
live_count()  { q "select count(*) from public.order_requests where replacement_for_return_id = '$1' and status not in ('cancelled', 'denied')"; }
order_status() { q "select status from public.order_requests where id = '$1'"; }
holds_of()    { q "select coalesce(trim_scale(sum(quantity))::text, '0') from public.stock_reservations where order_request_id = '$1' and released_at is null"; }
holds_rma()   { q "select coalesce(trim_scale(sum(sr.quantity))::text, '0') from public.stock_reservations sr join public.order_requests o on o.id = sr.order_request_id where o.replacement_for_return_id = '$1' and sr.released_at is null"; }
on_hand()     { q "select trim_scale(quantity_on_hand)::text from public.inventory_items where id = '$1'"; }
picks_of()    { q "select count(*) from public.stock_movements where reference_type = 'order_request' and reference_id = '$1' and quantity_change < 0"; }
decisions()   { q "select count(*) from public.return_decisions where return_id = '$1' and kind = '$2'"; }
staging_of()  { q "select coalesce(trim_scale(sum(s.quantity))::text, '0') from public.item_stock_levels s join public.locations l on l.id = s.location_id where s.item_id = '$1' and l.kind = 'staging'"; }

# The request bodies (camelCase, as the service sends them).
body_ex() { printf '{"reasonCode":"other","lines":[{"orderRequestLineId":"%s","quantity":1,"disposition":"restock","exchange":{"itemId":"%s"}}]}' "$1" "$2"; }
dec_ex()  { printf '{"lines":[{"returnLineId":"%s","disposition":"restock","restock":{"target":"staging"}}],"exchange":[{"action":"approve","exchangeLineId":"%s"}],"replacement":{"whenShort":"refuse"}}' "$1" "$2"; }
dec_decline() { printf '{"lines":[{"returnLineId":"%s","disposition":"restock","restock":{"target":"staging"}}],"exchange":[{"action":"decline","exchangeLineId":"%s","reason":"Race decline"}],"replacement":{"whenShort":"refuse"}}' "$1" "$2"; }

create_sql()  { printf "select 'R=' || public.create_return_request('%s', '%s'::jsonb, '%s')::text;" "$ORDER" "$(body_ex "$2" "$3")" "$1"; }
approve_sql() { printf "select 'R=' || public.approve_return('%s', %s, '%s'::jsonb, false)::text;" "$1" "$2" "$3"; }
cancel_sql()  { printf "select 'R=' || public.cancel_return('%s', %s, 'Race cancel')::text;" "$1" "$2"; }
receive_sql() { printf "select 'R=' || public.receive_return('%s')::text;" "$1"; }
# The release names the replacement the caller saw (desk check F7): here the
# live one, read in the same transaction before the call.
release_sql() { printf "select 'R=' || public.release_return_replacement_early('%s', (select o.id from public.order_requests o where o.replacement_for_return_id = '%s' and o.status not in ('cancelled', 'denied')), 'Customer is completing an in-person exchange today.')::text;" "$1" "$1"; }
change_sql()  { printf "select 'R=' || public.change_return_replacement('%s', %s, '[{\"exchangeLineId\":\"%s\",\"itemId\":\"%s\"}]'::jsonb, 'Race swap', 'refuse', null)::text;" "$1" "$2" "$3" "$4"; }
cancel_repl_sql() { printf "select 'R=' || public.cancel_return_replacement('%s', %s, 'Race cancel replacement')::text;" "$1" "$2"; }
pick_sql()    { printf "select 'R=' || (public.complete_picking('%s')).status;" "$1"; }
# The web's generatePickSlip: a compare-and-set update as the member.
slip_sql()    { printf "with u as (update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = now(), pick_slip_generated_by = auth.uid() where id = '%s' and status = 'approved' returning 1) select 'S=' || count(*) from u;" "$1"; }

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

cleanup() {
  # One statement removes the RMAs, the order lines and the orders: a
  # replacement order references its RMA (NO ACTION) while the RMA references
  # its original order, so neither side can go first; the key checks run at
  # the end of the statement, as an organization delete's do.
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

if [ "$(q "select count(*) from pg_proc where proname = 'change_return_replacement' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "0396 is not applied on this stack (no public.change_return_replacement)"; exit 1
fi

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

# ═══ Fixture: one picked and handed-over order; replacement stock on a rack ══
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0396-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0396-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0396 Two Session Org', '0396-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  ('$ORG', 'returns', true, 'optional', '{}'::jsonb),
  ('$ORG', 'orders', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0396 2S Main', 'WH-0396-2S', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  ('$R1', '$ORG', '$WH', '31-C', 'shelf', 'rack', now() - interval '30 minutes'),
  ('$R2', '$ORG', '$WH', '12-B', 'shelf', 'rack', now() - interval '29 minutes');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id) values
  ('$IM',    '$ORG', '$WH', '0396-2S-M',    '2S shirt M',    20, 'active', 'none', '$R1'),
  ('$IL',    '$ORG', '$WH', '0396-2S-L',    '2S shirt L',    30, 'active', 'none', '$R2'),
  ('$INAVY', '$ORG', '$WH', '0396-2S-NAVY', '2S shirt navy', 10, 'active', 'none', '$R2'),
  ('$IK',    '$ORG', '$WH', '0396-2S-K',    '2S shirt K',    10, 'active', 'none', '$R2'),
  ('$IN',    '$ORG', '$WH', '0396-2S-N',    '2S shirt N',    10, 'active', 'none', '$R2'),
  ('$IM2',   '$ORG', '$WH', '0396-2S-M2',   '2S shirt M2',    0, 'active', 'none', null);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$ORDER', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup'),
  ('$ORDER2', '$ORG', '$WH', 'completed', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  ('$L', '$ORDER', '$IM', 12, 0),
  ('$L2A', '$ORDER2', '$IM', 40, 40),
  ('$L2B', '$ORDER2', '$IM2', 40, 40);
SQL
then
  echo "fixture setup failed"; exit 1
fi
as_user - "$MGR" "select 'P=' || (public.complete_picking('$ORDER')).status;" > "$TMP/pick.out"
q "update public.order_requests set status = 'packing_slip_generated' where id = '$ORDER'" >/dev/null
q "update public.order_requests set status = 'staged_for_pickup' where id = '$ORDER'" >/dev/null
as_user - "$MGR" "select 'P=' || (public.confirm_physical_signature('$ORDER', 'Race tester')).status;" > "$TMP/sign.out"
if [ "$(sed -n 's/^P=//p' "$TMP/pick.out")/$(sed -n 's/^P=//p' "$TMP/sign.out")" != "picking_complete/completed" ]; then
  echo "fixture: the pick or the hand-over failed:"; cat "$TMP/pick.out" "$TMP/sign.out"; exit 1
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

N=0
# new_ex <key number>: a committed one-unit exchange RMA for the L size; prints its id.
new_ex() {
  N=$((N + 1))
  as_user - "$MGR" "$(create_sql "$(key "$1")" "$L" "$IL")" > "$TMP/new.$N.out"
  sed -n 's/^R=//p' "$TMP/new.$N.out" | jget returnId
}
# approve_ex_now <rma>: committed approval of the exchange as requested; prints the status.
approve_ex_now() {
  N=$((N + 1))
  as_user - "$MGR" "$(approve_sql "$1" 0 "$(dec_ex "$(rl_of "$1")" "$(xl_of "$1")")")" > "$TMP/ap.$N.out"
  sed -n 's/^R=//p' "$TMP/ap.$N.out" | jget status
}
release_now() {
  N=$((N + 1))
  as_user - "$MGR" "$(release_sql "$1")" > "$TMP/rel.$N.out"
  sed -n 's/^R=//p' "$TMP/rel.$N.out" | jget changed
}
slip_now() {
  N=$((N + 1))
  as_user - "$MGR" "$(slip_sql "$1")" > "$TMP/slip.$N.out"
  sed -n 's/^S=//p' "$TMP/slip.$N.out"
}
# ready_to_pick <label> <key number>: sets R to an exchange RMA approved,
# released early, its replacement on a pick slip (checked here, in this shell,
# so a failed setup counts).
ready_to_pick() {
  R="$(new_ex "$2")"
  check "$1: set up (approved, released early, the replacement on a pick slip)" \
    "$(approve_ex_now "$R")/$(release_now "$R")/$(slip_now "$(repl_of "$R")")" "approved/true/1"
}

# race <tag> <A's user> <A's statements> <A's end> <B's user> <B's statements>:
# A runs, then sleeps 3 s holding its transaction (and its locks); once A sits
# in pg_sleep, B runs. Records how long B took.
race() {
  local tag="$1" au="$2" a="$3" aend="$4" bu="$5" b="$6"
  ( as_user "0396-race-$tag-A" "$au" "$a
select pg_sleep(3);" "$aend" > "$TMP/$tag.A.out" ) &
  local pid=$!
  wait_for "0396-race-$tag-A" Timeout PgSleep || bad "$tag: session A never reached its pg_sleep"
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

# ═══ 1. Approve with an exchange against approve ═════════════════════════
echo "== 1a. two managers approve the same exchange decision at once"
R="$(new_ex 1)"
D="$(dec_ex "$(rl_of "$R")" "$(xl_of "$R")")"
race appsame "$MGR" "$(approve_sql "$R" 0 "$D")" commit "$MGR2" "$(approve_sql "$R" 0 "$D")"
check "1a: A approved (changed true, revision 1)" "$(ans appsame A | jget changed replay revision)" "true/false/1"
check "1a: B replayed A's answer (changed false, replay true)" "$(ans appsame B | jget changed replay revision)" "false/true/1"
check "1a: both answers name the same replacement order" \
  "$([ "$(ans appsame A | jget replacement.orderId)" = "$(ans appsame B | jget replacement.orderId)" ] && echo same || echo different)" "same"
waited appsame "1a"
check "1a: one replacement order, one hold of one unit, one replacement_issued" \
  "$(repl_count "$R")/$(holds_rma "$R")/$(decisions "$R" replacement_issued)" "1/1/1"

echo "== 1b. approve as requested against declining the exchange"
R="$(new_ex 2)"
RL="$(rl_of "$R")"; XL="$(xl_of "$R")"
race appdiff "$MGR" "$(approve_sql "$R" 0 "$(dec_ex "$RL" "$XL")")" commit "$MGR2" "$(approve_sql "$R" 0 "$(dec_decline "$RL" "$XL")")"
check "1b: A approved with a replacement" "$(ans appdiff A | jget changed revision)" "true/1"
check "1b: B is refused return_changed" "$(refused appdiff B P0001 return_changed)" "1/1"
waited appdiff "1b"
check "1b: A's replacement stands, one hold; the line approved" \
  "$(live_count "$R")/$(holds_rma "$R")/$(q "select status from public.return_exchange_lines where id = '$XL'")" "1/1/approved"

# ═══ 2. Approve with an exchange against cancel_return ════════════════════
echo "== 2a. the approval holds; a cancel at revision 0 waits"
R="$(new_ex 3)"
race appcan "$MGR" "$(approve_sql "$R" 0 "$(dec_ex "$(rl_of "$R")" "$(xl_of "$R")")")" commit "$MGR2" "$(cancel_sql "$R" 0)"
check "2a: A approved" "$(ans appcan A | jget changed status)" "true/approved"
check "2a: the cancel is refused return_changed" "$(refused appcan B P0001 return_changed)" "1/1"
waited appcan "2a"
check "2a: the RMA stays approved with one live replacement, one hold" "$(status_of "$R")/$(live_count "$R")/$(holds_rma "$R")" "approved/1/1"

echo "== 2b. the cancel holds; the approval waits"
R="$(new_ex 4)"
race canapp "$MGR" "$(cancel_sql "$R" 0)" commit "$MGR2" "$(approve_sql "$R" 0 "$(dec_ex "$(rl_of "$R")" "$(xl_of "$R")")")"
check "2b: A cancelled" "$(ans canapp A | jget changed status)" "true/cancelled"
check "2b: the approval is refused invalid_status_transition" "$(refused canapp B P0001 invalid_status_transition)" "1/1"
waited canapp "2b"
check "2b: no replacement order, no hold; the exchange line cancelled" \
  "$(repl_count "$R")/$(holds_rma "$R")/$(q "select status from public.return_exchange_lines where return_id = '$R'")" "0/0/cancelled"

# ═══ 6. The replacement's pick slip against the RMA cancel ════════════════
echo "== 6a. the pick slip holds the replacement; the RMA cancel waits"
R="$(new_ex 5)"
check "6a: set up (approved, released early)" "$(approve_ex_now "$R")/$(release_now "$R")" "approved/true"
O="$(repl_of "$R")"
race slipcancel "$MGR" "$(slip_sql "$O")" commit "$MGR2" "$(cancel_sql "$R" 1)"
check "6a: the pick slip went through" "$(sed -n 's/^S=//p' "$TMP/slipcancel.A.out")" "1"
check "6a: the cancel then cancelled the RMA" "$(ans slipcancel B | jget changed status)" "true/cancelled"
waited slipcancel "6a"
check "6a: the replacement is cancelled from its pick slip (undrawn): no hold, no draw" \
  "$(order_status "$O")/$(holds_of "$O")/$(picks_of "$O")" "cancelled/0/0"

echo "== 6b. the RMA cancel holds; the pick slip's compare-and-set waits"
R="$(new_ex 6)"
check "6b: set up (approved, released early)" "$(approve_ex_now "$R")/$(release_now "$R")" "approved/true"
O="$(repl_of "$R")"
race cancelslip "$MGR" "$(cancel_sql "$R" 1)" commit "$MGR2" "$(slip_sql "$O")"
check "6b: A cancelled the RMA" "$(ans cancelslip A | jget changed status)" "true/cancelled"
check "6b: the pick slip matched no row (the order was cancelled meanwhile)" "$(sed -n 's/^S=//p' "$TMP/cancelslip.B.out")" "0"
waited cancelslip "6b"
check "6b: the replacement is cancelled, no hold" "$(order_status "$O")/$(holds_of "$O")" "cancelled/0"

# ═══ 7. Substitution against complete_picking (X-2) ══════════════════════
echo "== 7a. the substitution holds; complete_picking waits on the old order"
ready_to_pick 7a 7
O="$(repl_of "$R")"; Q0="$(on_hand "$IL")"
race swappick "$MGR" "$(change_sql "$R" 1 "$(xl_of "$R")" "$INAVY")" commit "$MGR2" "$(pick_sql "$O")"
check "7a: A substituted (mode substitute, the old order cancelled)" "$(ans swappick A | jget changed mode cancelledOrderId)" "true/substitute/$O"
check "7a: complete_picking is refused invalid_status_transition" "$(grep -c 'ERROR:.*invalid_status_transition' "$TMP/swappick.B.out")" "1"
waited swappick "7a"
N7="$(repl_of "$R")"
check "7a: the old order cancelled with no hold and no draw; the new order holds the navy unit" \
  "$(order_status "$O")/$(holds_of "$O")/$(picks_of "$O")/$(holds_of "$N7")/$(q "select item_id from public.order_request_lines where order_request_id = '$N7'")" \
  "cancelled/0/0/1/$INAVY"
check "7a: the L size never left the shelf" "$(on_hand "$IL")" "$Q0"

echo "== 7b. complete_picking holds; the substitution waits, then is refused"
ready_to_pick 7b 8
O="$(repl_of "$R")"; Q0="$(on_hand "$IL")"
race pickswap "$MGR" "$(pick_sql "$O")" commit "$MGR2" "$(change_sql "$R" 1 "$(xl_of "$R")" "$INAVY")"
check "7b: A picked" "$(ans pickswap A)" "picking_complete"
check "7b: the substitution is refused replacement_already_drawn" "$(refused pickswap B P0001 replacement_already_drawn)" "1/1"
waited pickswap "7b"
check "7b: one order, picked; the L size drawn once; no second order" \
  "$(order_status "$O")/$(picks_of "$O")/$(python3 -c "print(int(float('$Q0') - float('$(on_hand "$IL")')))")/$(repl_count "$R")" "picking_complete/1/1/1"

# ═══ 8. cancel_return_replacement against complete_picking (X-2) ══════════
echo "== 8a. the replacement cancel holds; complete_picking waits"
ready_to_pick 8a 9
O="$(repl_of "$R")"; Q0="$(on_hand "$IL")"
race cancelpick "$MGR" "$(cancel_repl_sql "$R" 1)" commit "$MGR2" "$(pick_sql "$O")"
check "8a: A cancelled the replacement (undrawn)" "$(ans cancelpick A | jget changed drawn)" "true/false"
check "8a: complete_picking is refused invalid_status_transition" "$(grep -c 'ERROR:.*invalid_status_transition' "$TMP/cancelpick.B.out")" "1"
waited cancelpick "8a"
check "8a: nothing drawn, every hold released, the RMA still approved" \
  "$(order_status "$O")/$(holds_of "$O")/$(picks_of "$O")/$(on_hand "$IL")/$(status_of "$R")" "cancelled/0/0/$Q0/approved"

echo "== 8b. complete_picking holds; the replacement cancel waits, then takes the drawn branch"
ready_to_pick 8b 10
O="$(repl_of "$R")"; Q0="$(on_hand "$IL")"; S0="$(staging_of "$IL")"
race pickcancel "$MGR" "$(pick_sql "$O")" commit "$MGR2" "$(cancel_repl_sql "$R" 1)"
check "8b: A picked" "$(ans pickcancel A)" "picking_complete"
check "8b: the cancel took the drawn branch" "$(ans pickcancel B | jget changed drawn)" "true/true"
waited pickcancel "8b"
check "8b: the order cancelled; the batch back in Staging on record; on hand as before" \
  "$(order_status "$O")/$(python3 -c "print(int(float('$(staging_of "$IL")') - float('$S0')))")/$(on_hand "$IL")" "cancelled/1/$Q0"

# ═══ 9. receive_return against the early release ═════════════════════════
echo "== 9a. the receipt holds; the release waits, then answers not needed"
R="$(new_ex 11)"
check "9a: set up (approved)" "$(approve_ex_now "$R")" "approved"
race recrel "$MGR" "$(receive_sql "$R")" commit "$MGR2" "$(release_sql "$R")"
check "9a: A received" "$(ans recrel A | jget changed status)" "true/received"
check "9a: the release answers not needed (changed false)" "$(ans recrel B | jget changed reason)" "false/not_needed"
waited recrel "9a"
check "9a: no released_early decision" "$(decisions "$R" released_early)" "0"

echo "== 9b. the release holds; the receipt waits, then receives"
R="$(new_ex 12)"
check "9b: set up (approved)" "$(approve_ex_now "$R")" "approved"
race relrec "$MGR" "$(release_sql "$R")" commit "$MGR2" "$(receive_sql "$R")"
check "9b: A released" "$(ans relrec A | jget changed)" "true"
check "9b: B received" "$(ans relrec B | jget changed status)" "true/received"
waited relrec "9b"
check "9b: one released_early decision, one received" "$(decisions "$R" released_early)/$(decisions "$R" received)" "1/1"

# ═══ 11-12. Two RMAs, one item: approval and substitution (desk check F4) ══
# Requests built in SQL from the RMA's own rows (the member reads them).
create2_sql() { # create2_sql <key> <item for line A> <item for line B>: two exchange lines on ORDER2
  printf "select 'R=' || public.create_return_request('%s', '%s'::jsonb, '%s')::text;" "$ORDER2" \
    "{\"reasonCode\":\"other\",\"lines\":[{\"orderRequestLineId\":\"$L2A\",\"quantity\":1,\"disposition\":\"restock\",\"exchange\":{\"itemId\":\"$2\"}},{\"orderRequestLineId\":\"$L2B\",\"quantity\":1,\"disposition\":\"restock\",\"exchange\":{\"itemId\":\"$3\"}}]}" "$1"
}
create_ro_sql() { # create_ro_sql <key>: a return-only line on ORDER2
  printf "select 'R=' || public.create_return_request('%s', '%s'::jsonb, '%s')::text;" "$ORDER2" \
    "{\"reasonCode\":\"other\",\"lines\":[{\"orderRequestLineId\":\"$L2A\",\"quantity\":1,\"disposition\":\"restock\"}]}" "$1"
}
lines_json() { # every line of the RMA to Staging
  printf "(select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'disposition', 'restock', 'restock', jsonb_build_object('target', 'staging'))) from public.return_lines rl where rl.return_id = '%s')" "$1"
}
approve_all_sql() { # approve every requested exchange line as requested
  printf "select 'R=' || public.approve_return('%s', 0, jsonb_build_object('lines', %s, 'exchange', coalesce((select jsonb_agg(jsonb_build_object('exchangeLineId', xl.id, 'action', 'approve')) from public.return_exchange_lines xl where xl.return_id = '%s' and xl.status = 'requested'), '[]'::jsonb), 'replacement', jsonb_build_object('whenShort', 'refuse')), false)::text;" "$1" "$(lines_json "$1")" "$1"
}
add_sql() { # approve a return-only RMA with "Add a replacement" of <item>
  printf "select 'R=' || public.approve_return('%s', 0, jsonb_build_object('lines', %s, 'exchange', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'action', 'add', 'itemId', '%s')) from public.return_lines rl where rl.return_id = '%s'), 'replacement', jsonb_build_object('whenShort', 'refuse')), false)::text;" "$1" "$(lines_json "$1")" "$2" "$1"
}
swap_sql() { # change_return_replacement: the line now approved for <from> becomes <to>
  printf "select 'R=' || public.change_return_replacement('%s', 1, (select jsonb_agg(jsonb_build_object('exchangeLineId', xl.id, 'itemId', '%s')) from public.return_exchange_lines xl where xl.return_id = '%s' and xl.approved_item_id = '%s'), 'Race swap', 'refuse', null)::text;" "$1" "$3" "$1" "$2"
}
member_now() { # member_now <statements>: one committed member transaction; prints its answer
  N=$((N + 1))
  as_user - "$MGR" "$1" > "$TMP/m.$N.out"
  sed -n 's/^R=//p' "$TMP/m.$N.out"
}
new2() { member_now "$(create2_sql "$(key "$1")" "$2" "$3")" | jget returnId; }
new_ro() { member_now "$(create_ro_sql "$(key "$1")")" | jget returnId; }
deadlocked() { # deadlocked <tag>: how many of the sessions saw a deadlock or a retryable class
  cat "$TMP/$1".*.out | grep -cE '40P01|40001|deadlock'
}
# three <tag> <B's user> <B's statements> <A's user> <A's statements>: the
# blocker holds K FOR UPDATE for 4 s; B starts and waits on a lock; A starts
# and waits on a lock; then K is released and both finish.
three() {
  local tag="$1"
  ( printf '%s\n' "set application_name to '0396-race-$tag-C';" "begin;" \
      "select 'C=' || count(*) from (select 1 from public.inventory_items where id = '$IK' for update) k;" \
      "select pg_sleep(4);" "commit;" | "${PSQL[@]}" > "$TMP/$tag.C.out" 2>&1 ) &
  local pc=$!
  wait_for "0396-race-$tag-C" Timeout PgSleep || bad "$tag: the blocker never held K"
  ( as_user "0396-race-$tag-B" "$2" "$3" commit > "$TMP/$tag.B.out" ) &
  local pb=$!
  wait_for "0396-race-$tag-B" Lock || bad "$tag: B never waited on a lock"
  ( as_user "0396-race-$tag-A" "$4" "$5" commit > "$TMP/$tag.A.out" ) &
  local pa=$!
  wait_for "0396-race-$tag-A" Lock || bad "$tag: A never waited on a lock"
  wait "$pc" "$pb" "$pa"
}

echo "== 11a. approval (K and L, waits on K) against approval with an added L"
RB="$(new2 13 "$IK" "$IL")"
RA="$(new_ro 14)"
check "11a: set up (B's RMA asks for K and L; A's is return only)" "$(q "select count(*) from public.return_exchange_lines where return_id = '$RB'")/$(q "select count(*) from public.return_exchange_lines where return_id = '$RA'")" "2/0"
three r11a "$MGR2" "$(approve_all_sql "$RB")" "$MGR" "$(add_sql "$RA" "$IL")"
check "11a: no session deadlocked or saw a retryable class (never 40P01)" "$(deadlocked r11a)" "0"
check "11a: B approved, its replacement holds K and L" "$(ans r11a B | jget changed status)/$(holds_rma "$RB")" "true/approved/2"
check "11a: A approved with the added L, held once" "$(ans r11a A | jget changed status)/$(holds_rma "$RA")" "true/approved/1"
check "11a: one live replacement each" "$(live_count "$RB")/$(live_count "$RA")" "1/1"

echo "== 11b. approval with an added L holds; another approval for L waits"
RA="$(new_ro 15)"
RB="$(new2 16 "$IL" "$IN")"
race r11b "$MGR" "$(add_sql "$RA" "$IL")" commit "$MGR2" "$(approve_all_sql "$RB")"
check "11b: A approved with the added L" "$(ans r11b A | jget changed status)" "true/approved"
check "11b: B approved after A" "$(ans r11b B | jget changed status)" "true/approved"
waited r11b "11b"
check "11b: no session deadlocked (never 40P01); each replacement held" "$(deadlocked r11b)/$(holds_rma "$RA")/$(holds_rma "$RB")" "0/1/2"

echo "== 12a. substitution (to K, waits on K) against approval with an added L"
RS="$(new2 17 "$IL" "$IN")"
check "12a: set up (the RMA approved for L and N, its replacement held)" "$(member_now "$(approve_all_sql "$RS")" | jget status)/$(holds_rma "$RS")" "approved/2"
RA="$(new_ro 18)"
three r12a "$MGR2" "$(swap_sql "$RS" "$IN" "$IK")" "$MGR" "$(add_sql "$RA" "$IL")"
check "12a: no session deadlocked or saw a retryable class (never 40P01)" "$(deadlocked r12a)" "0"
check "12a: B substituted (K and L held on the new replacement)" "$(ans r12a B | jget changed mode)/$(holds_rma "$RS")/$(live_count "$RS")" "true/substitute/2/1"
check "12a: A approved with the added L, held once" "$(ans r12a A | jget changed status)/$(holds_rma "$RA")" "true/approved/1"

echo "== 12b. a substitution to L holds; an approval with an added L waits"
RS="$(new2 19 "$IN" "$INAVY")"
check "12b: set up (the RMA approved for N and navy)" "$(member_now "$(approve_all_sql "$RS")" | jget status)" "approved"
RA="$(new_ro 20)"
race r12b "$MGR" "$(swap_sql "$RS" "$IN" "$IL")" commit "$MGR2" "$(add_sql "$RA" "$IL")"
check "12b: A substituted N for L" "$(ans r12b A | jget changed mode)" "true/substitute"
check "12b: B approved with the added L after A" "$(ans r12b B | jget changed status)" "true/approved"
waited r12b "12b"
check "12b: no session deadlocked (never 40P01); one live replacement each" "$(deadlocked r12b)/$(live_count "$RS")/$(live_count "$RA")" "0/1/1"

# ═══ 10. No retryable SQLSTATE; holdings equal on hand ════════════════════
echo "== 10. no 40001 / 40P01, no deadlock; on hand = the sum of holdings"
check "10: no session saw 40001 or 40P01 or a deadlock" \
  "$(cat "$TMP"/*.out | grep -cE '40001|40P01|deadlock')" "0"
check "10: on hand equals the sum of holdings for every fixture item" \
  "$(q "select count(*) from public.inventory_items i where i.organization_id = '$ORG' and i.quantity_on_hand <> (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = i.id)")" "0"
check "10: never two live replacements for one RMA" \
  "$(q "select count(*) from (select replacement_for_return_id from public.order_requests where organization_id = '$ORG' and replacement_for_return_id is not null and status not in ('cancelled', 'denied') group by 1 having count(*) > 1) x")" "0"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
