#!/usr/bin/env bash
#
# Two-session proof for migration 0378 (F2-2, hold_order_stock). pgTAP runs in
# ONE session, so it cannot show what happens while two holds, or a hold and
# an approval, hold locks at the same time.
#
#   1. Two orders hold the last 10 of one item at the same moment. Session A
#      holds order X and keeps its transaction open; session B holds order Y
#      meanwhile. B waits on A's item lock, then reads A's hold and holds
#      nothing (10 still short). The total held stays 10, what is on hand.
#   2. The same race against a COPY of the function with the items' FOR
#      UPDATE taken out (a throwaway public._probe_hold_nolock, dropped at the
#      end): B reads before A commits, sees no hold, and holds 10 too. 20 are
#      held against 10 on hand. This is the mutation the item lock exists for.
#   3. approve_order_request first, hold_order_stock meanwhile, on two shared
#      items: the hold waits, then takes only what approve left. No 40P01.
#   4. hold_order_stock first, approve_order_request meanwhile, on two shared
#      items: approve waits, then refuses (insufficient_stock, P0001) because
#      the hold took the stock. No 40P01.
#   5. Lock order at its worst: a hold-shaped probe that takes the items' locks
#      ONE AT A TIME with a pause between them (public._probe_hold_paced, the
#      function's own statements, dropped at the end), started first, with
#      approve_order_request started during the pause:
#        a. in id order (the function's order, and approve's): approve waits
#           for the first item and both finish. No 40P01.
#        b. MUTATION, in descending id order: the probe holds item 2 and waits
#           for item 1, approve holds item 1 and waits for item 2: Postgres
#           kills one with 40P01 (deadlock_detected), which PostgREST does not
#           retry. This is what taking the items in id order prevents.
#   6. complete_picking against a hold (complete_picking takes the same locks
#      in the same order: the order row, then the items by id):
#        a. complete_picking on one order first, a hold on another order that
#           shares its two items meanwhile: the hold waits, then holds only
#           what the pick left on hand (3 of each) and says 2 of each are still
#           short.
#        b. the hold first, complete_picking on the other order meanwhile:
#           complete_picking waits, then completes; the hold keeps the 3 of
#           each it took, no more than is left on hand.
#        c. the SAME order, the hold first: it tops the order up (3 + 5), then
#           complete_picking waits, picks, and releases every hold the order
#           had, the new ones included.
#        d. the SAME order, complete_picking first: the hold then finds the
#           order picked and refuses (P0001 hold_not_applicable, detail
#           picking_complete), holding nothing.
#        e. the SAME order, cancel first: the hold refuses (hold_not_applicable,
#           detail cancelled), holding nothing.
#        f. MUTATION of d: a copy that reads the status WITHOUT locking the
#           order row (public._probe_hold_unlocked_status, dropped at the end)
#           reads "pick slip generated" while the pick is still running, waits
#           on the items, and then holds stock for an order that is already
#           picked: a hold nothing will ever release. Taking the order row
#           lock before the status check is what prevents it.
#   No session running the real function (1, 3, 4, 5a, 6) ever sees 40001 or
#   40P01, and every item ends with no more held than is on hand.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03781111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0378_hold_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORG='03781111-0000-0000-0000-00000000000a'
MGR='03781111-0000-0000-0000-0000000000a1'
WH='03781111-0000-0000-0000-0000000000b1'
ITEM='03781111-0000-0000-0000-0000000000c1'
I1='03781111-0000-0000-0000-0000000000c2'
I2='03781111-0000-0000-0000-0000000000c3'
I3='03781111-0000-0000-0000-0000000000c4'
I4='03781111-0000-0000-0000-0000000000c5'
I5='03781111-0000-0000-0000-0000000000c6'
I6='03781111-0000-0000-0000-0000000000c7'
I7='03781111-0000-0000-0000-0000000000c8'
I8='03781111-0000-0000-0000-0000000000c9'
I9='03781111-0000-0000-0000-0000000000ca'
I10='03781111-0000-0000-0000-0000000000cb'
X='03781111-0000-0000-0000-0000000000d1'
Y='03781111-0000-0000-0000-0000000000d2'
X2='03781111-0000-0000-0000-0000000000d3'
Y2='03781111-0000-0000-0000-0000000000d4'
P3='03781111-0000-0000-0000-0000000000d5'
X3='03781111-0000-0000-0000-0000000000d6'
P4='03781111-0000-0000-0000-0000000000d7'
X4='03781111-0000-0000-0000-0000000000d8'
P5A='03781111-0000-0000-0000-0000000000d9'
X5A='03781111-0000-0000-0000-0000000000da'
P5B='03781111-0000-0000-0000-0000000000db'
X5B='03781111-0000-0000-0000-0000000000dc'
# Section 6: items (8 on hand each) and orders.
J1='03781111-0000-0000-0000-0000000000e1'
J2='03781111-0000-0000-0000-0000000000e2'
J3='03781111-0000-0000-0000-0000000000e3'
J4='03781111-0000-0000-0000-0000000000e4'
K1='03781111-0000-0000-0000-0000000000e5'
K2='03781111-0000-0000-0000-0000000000e6'
K3='03781111-0000-0000-0000-0000000000e7'
K4='03781111-0000-0000-0000-0000000000e8'
L1='03781111-0000-0000-0000-0000000000e9'
L2='03781111-0000-0000-0000-0000000000ea'
C6A='03781111-0000-0000-0000-0000000000f1'
H6A='03781111-0000-0000-0000-0000000000f2'
C6B='03781111-0000-0000-0000-0000000000f3'
H6B='03781111-0000-0000-0000-0000000000f4'
S6C='03781111-0000-0000-0000-0000000000f5'
S6D='03781111-0000-0000-0000-0000000000f6'
S6E='03781111-0000-0000-0000-0000000000f7'
S6F='03781111-0000-0000-0000-0000000000f8'
M1='03781111-0000-0000-0000-0000000000eb'
M2='03781111-0000-0000-0000-0000000000ec'

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
# Active holds on one item, and on it for one order.
held()     { q "select coalesce(sum(quantity), 0)::int from public.stock_reservations where item_id = '$1' and released_at is null"; }
held_for() { q "select coalesce(sum(quantity), 0)::int from public.stock_reservations where item_id = '$1' and order_request_id = '$2' and released_at is null"; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_hold_nolock(uuid);
drop function if exists public._probe_hold_paced(uuid, boolean);
drop function if exists public._probe_hold_unlocked_status(uuid);
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
  # Section 6's picks write ledger rows; the org delete must have taken them
  # (and everything else under the org) with it.
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.stock_movements where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0378-2s-mgr@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0378 Two Session Org', '0378-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0378 2S Main', 'WH-0378-2S', 'active');
-- ITEM: the last 10 (sections 1 and 2). I1..I10: pairs of 8 on hand (3 to 5b).
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', '2S last ten', 'SKU-0378-2S',   10, 'active'),
  ('$I1',   '$ORG', '$WH', '2S pair 1a',  'SKU-0378-2S1',  8,  'active'),
  ('$I2',   '$ORG', '$WH', '2S pair 1b',  'SKU-0378-2S2',  8,  'active'),
  ('$I3',   '$ORG', '$WH', '2S pair 2a',  'SKU-0378-2S3',  8,  'active'),
  ('$I4',   '$ORG', '$WH', '2S pair 2b',  'SKU-0378-2S4',  8,  'active'),
  ('$I5',   '$ORG', '$WH', '2S pair 3a',  'SKU-0378-2S5',  8,  'active'),
  ('$I6',   '$ORG', '$WH', '2S pair 3b',  'SKU-0378-2S6',  8,  'active'),
  ('$I7',   '$ORG', '$WH', '2S pair 4a',  'SKU-0378-2S7',  8,  'active'),
  ('$I8',   '$ORG', '$WH', '2S pair 4b',  'SKU-0378-2S8',  8,  'active'),
  ('$I9',   '$ORG', '$WH', '2S pair 5a',  'SKU-0378-2S9',  8,  'active'),
  ('$I10',  '$ORG', '$WH', '2S pair 5b',  'SKU-0378-2S10', 8,  'active'),
  ('$J1',   '$ORG', '$WH', '2S pick 1a',  'SKU-0378-2SJ1', 8,  'active'),
  ('$J2',   '$ORG', '$WH', '2S pick 1b',  'SKU-0378-2SJ2', 8,  'active'),
  ('$J3',   '$ORG', '$WH', '2S pick 2a',  'SKU-0378-2SJ3', 8,  'active'),
  ('$J4',   '$ORG', '$WH', '2S pick 2b',  'SKU-0378-2SJ4', 8,  'active'),
  ('$K1',   '$ORG', '$WH', '2S pick 3a',  'SKU-0378-2SK1', 8,  'active'),
  ('$K2',   '$ORG', '$WH', '2S pick 3b',  'SKU-0378-2SK2', 8,  'active'),
  ('$K3',   '$ORG', '$WH', '2S pick 4a',  'SKU-0378-2SK3', 8,  'active'),
  ('$K4',   '$ORG', '$WH', '2S pick 4b',  'SKU-0378-2SK4', 8,  'active'),
  ('$L1',   '$ORG', '$WH', '2S pick 5a',  'SKU-0378-2SL1', 8,  'active'),
  ('$L2',   '$ORG', '$WH', '2S pick 5b',  'SKU-0378-2SL2', 8,  'active'),
  ('$M1',   '$ORG', '$WH', '2S pick 6a',  'SKU-0378-2SM1', 8,  'active'),
  ('$M2',   '$ORG', '$WH', '2S pick 6b',  'SKU-0378-2SM2', 8,  'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$X',   '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$Y',   '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$X2',  '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$Y2',  '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P3',  '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$X3',  '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P4',  '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$X4',  '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P5A', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$X5A', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P5B', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$X5B', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$C6A', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup'),
  ('$H6A', '$ORG', '$WH', 'approved',            'internal', '$MGR', 'pickup'),
  ('$C6B', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup'),
  ('$H6B', '$ORG', '$WH', 'approved',            'internal', '$MGR', 'pickup'),
  ('$S6C', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup'),
  ('$S6D', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup'),
  ('$S6E', '$ORG', '$WH', 'approved',            'internal', '$MGR', 'pickup'),
  ('$S6F', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  ('$X',   '$ITEM', 10), ('$Y',   '$ITEM', 10),
  ('$X2',  '$ITEM', 10), ('$Y2',  '$ITEM', 10),
  ('$P3',  '$I1', 5), ('$P3',  '$I2', 5), ('$X3',  '$I1', 5), ('$X3',  '$I2', 5),
  ('$P4',  '$I3', 5), ('$P4',  '$I4', 5), ('$X4',  '$I3', 5), ('$X4',  '$I4', 5),
  ('$P5A', '$I5', 5), ('$P5A', '$I6', 5), ('$X5A', '$I5', 5), ('$X5A', '$I6', 5),
  ('$P5B', '$I7', 5), ('$P5B', '$I8', 5), ('$X5B', '$I7', 5), ('$X5B', '$I8', 5),
  ('$C6A', '$J1', 5), ('$C6A', '$J2', 5), ('$H6A', '$J1', 5), ('$H6A', '$J2', 5),
  ('$C6B', '$J3', 5), ('$C6B', '$J4', 5), ('$H6B', '$J3', 5), ('$H6B', '$J4', 5),
  ('$S6C', '$K1', 5), ('$S6C', '$K2', 5),
  ('$S6D', '$K3', 5), ('$S6D', '$K4', 5),
  ('$S6E', '$L1', 5), ('$S6E', '$L2', 5),
  ('$S6F', '$M1', 5), ('$S6F', '$M2', 5);
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# race <tag> <sqlA> <sqlB>: A runs its call and holds its transaction 3 s;
# B runs its call at 1 s. Both as the manager.
race() {
  local tag="$1" a="$2" b="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || ($a)::text;
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
set local "request.jwt.claim.sub" to '$MGR';
select 'B=' || ($b)::text;
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# paced <tag> <ascending true|false> <order X> <pending P>: the paced probe
# holds X first (one item lock, a 2 s pause, the next); approve P starts at
# 0.7 s, inside the pause.
paced() {
  local tag="$1" asc="$2" x="$3" p="$4"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
set deadlock_timeout = '500ms';
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || (public._probe_hold_paced('$x', $asc))::text;
commit;
SQL
  ) &
  local pid=$!
  sleep 0.7
  "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B.out" 2>&1 <<SQL
set deadlock_timeout = '500ms';
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'B=' || (public.approve_order_request('$p')).status;
commit;
SQL
  wait "$pid"
}

# ═══ 1. Two holds race for the last 10 ════════════════════════════════════
echo "== 1. two orders hold the last 10 of one item at the same moment"
race real "public.hold_order_stock('$X')" "public.hold_order_stock('$Y')"
WAITED="$(cat "$TMP/real.waited")"
check "1a: A held all 10" "$(held_for "$ITEM" "$X")" "10"
check "1a: and said so, with nothing short" \
  "$(has 'A={"held": [{"added": 10' "$TMP/real.A.out"),$(has '"itemId": "'"$ITEM"'"}], "stillShort": [], "hiddenHeldItems": 0, "hiddenShortItems": 0}' "$TMP/real.A.out")" "1,1"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's item lock ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: B then held nothing and says 10 are still short" \
  "$(has 'B={"held": [], "stillShort": [{"itemId": "'"$ITEM"'", "quantity": 10' "$TMP/real.B.out")" "1"
check "1c: B holds nothing" "$(held_for "$ITEM" "$Y")" "0"
check "1d: 10 held in all, what is on hand" "$(held "$ITEM")" "10"

# ═══ 2. The mutation: no item lock ════════════════════════════════════════
echo "== 2. the same race against a copy with the items' FOR UPDATE removed"
q "delete from public.stock_reservations where organization_id = '$ORG'" >/dev/null
q "select pg_get_functiondef('public.hold_order_stock(uuid)'::regprocedure)" > "$TMP/real.sql"
python3 - "$TMP/real.sql" "$TMP/nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
lock = "     order by ii.id\n       for update\n  loop"
assert d.count(lock) == 1, d.count(lock)
d = d.replace(lock, "     order by ii.id\n  loop").replace('public.hold_order_stock(', 'public._probe_hold_nolock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/nolock.sql" || bad "2: could not create the lock-less copy"
q "revoke all on function public._probe_hold_nolock(uuid) from public, anon; grant execute on function public._probe_hold_nolock(uuid) to authenticated" >/dev/null
race nolock "public._probe_hold_nolock('$X2')" "public._probe_hold_nolock('$Y2')"
check "2a: A held 10" "$(held_for "$ITEM" "$X2")" "10"
check "2b: B ALSO held 10 (it read before A committed)" "$(held_for "$ITEM" "$Y2")" "10"
check "2c: 20 held against 10 on hand: this is what the item lock prevents" "$(held "$ITEM")" "20"

# ═══ 3. approve first, hold meanwhile ═════════════════════════════════════
echo "== 3. approve_order_request first, hold_order_stock meanwhile, on two shared items"
race apfirst "(public.approve_order_request('$P3')).status" "public.hold_order_stock('$X3')"
WAITED="$(cat "$TMP/apfirst.waited")"
check "3a: approve went through" "$(grep -c '^A=approved' "$TMP/apfirst.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "3b: the hold waited for approve's item locks ($WAITED ms)"; else bad "3b: the hold did not wait ($WAITED ms)"; fi
check "3c: the hold took only what approve left (3 of each)" \
  "$(held_for "$I1" "$X3"),$(held_for "$I2" "$X3")" "3,3"
check "3d: no more held than on hand (8 of each)" "$(held "$I1"),$(held "$I2")" "8,8"

# ═══ 4. hold first, approve meanwhile ═════════════════════════════════════
echo "== 4. hold_order_stock first, approve_order_request meanwhile, on two shared items"
race holdfirst "public.hold_order_stock('$X4')" "(public.approve_order_request('$P4')).status"
WAITED="$(cat "$TMP/holdfirst.waited")"
check "4a: the hold took 5 of each" "$(held_for "$I3" "$X4"),$(held_for "$I4" "$X4")" "5,5"
if [ "$WAITED" -ge 1500 ]; then ok "4b: approve waited for the hold's item locks ($WAITED ms)"; else bad "4b: approve did not wait ($WAITED ms)"; fi
check "4c: approve then refused: 5 wanted, 3 free (P0001 insufficient_stock)" \
  "$(grep -cE 'P0001: insufficient_stock' "$TMP/holdfirst.B.out")" "1"
check "4d: no more held than on hand (5 of 8 each)" "$(held "$I3"),$(held "$I4")" "5,5"

# ═══ 5. Lock order at its worst ═══════════════════════════════════════════
echo "== 5. a hold that takes its item locks one at a time, approve started in the pause"
# The function's own statements, with the item locks taken one per statement
# and a 2 s pause after the first; p_ascending picks the order.
q "select pg_get_functiondef('public.hold_order_stock(uuid)'::regprocedure)" > "$TMP/real2.sql"
python3 - "$TMP/real2.sql" "$TMP/paced.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
cur = "     order by ii.id\n       for update\n  loop\n"
assert d.count(cur) == 1, d.count(cur)
d = d.replace(cur,
  "     order by case when p_ascending then ii.id end asc, case when not p_ascending then ii.id end desc\n"
  "  loop\n"
  "    perform 1 from public.inventory_items where id = v_item.id for update;\n"
  "    perform pg_sleep(2);\n", 1)
d = d.replace('public.hold_order_stock(p_order_id uuid)', 'public._probe_hold_paced(p_order_id uuid, p_ascending boolean)', 1)
assert '_probe_hold_paced' in d
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/paced.sql" || bad "5: could not create the paced copy"
q "revoke all on function public._probe_hold_paced(uuid, boolean) from public, anon; grant execute on function public._probe_hold_paced(uuid, boolean) to authenticated" >/dev/null

paced asc true "$X5A" "$P5A"
check "5a: in id order the paced hold finished" "$(grep -c '^A={' "$TMP/asc.A.out")" "1"
check "5a: and approve waited, then refused (5 wanted, 3 free)" "$(grep -cE 'P0001: insufficient_stock' "$TMP/asc.B.out")" "1"
check "5a: neither saw 40P01" "$(cat "$TMP/asc.A.out" "$TMP/asc.B.out" | grep -c '40P01')" "0"
check "5a: the paced hold took 5 of each, and approve nothing (it refused)" "$(held_for "$I5" "$X5A"),$(held_for "$I6" "$X5A"),$(held_for "$I5" "$P5A"),$(held_for "$I6" "$P5A")" "5,5,0,0"

paced desc false "$X5B" "$P5B"
check "5b: MUTATION, in descending id order: one of the two was killed with 40P01 (deadlock_detected)" \
  "$(cat "$TMP/desc.A.out" "$TMP/desc.B.out" | grep -c '40P01')" "1"

# ═══ 6. complete_picking against a hold ═══════════════════════════════════
echo "== 6. complete_picking and a hold at the same moment (other order, and the same order)"
on_hand()   { q "select trim_scale(quantity_on_hand)::text from public.inventory_items where id = '$1'"; }
# The picking orders hold what approve would have (5 + 5); S6C was held for 2
# of K1 only (a line raised after approval, never held). Planted here, after
# section 2 cleared the org's holds.
"${PSQL[@]}" >/dev/null <<SQL || bad "6: could not plant the holds"
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity) values
  ('$ORG', '$J1', '$WH', '$C6A', 5), ('$ORG', '$J2', '$WH', '$C6A', 5),
  ('$ORG', '$J3', '$WH', '$C6B', 5), ('$ORG', '$J4', '$WH', '$C6B', 5),
  ('$ORG', '$K1', '$WH', '$S6C', 2),
  ('$ORG', '$K3', '$WH', '$S6D', 5), ('$ORG', '$K4', '$WH', '$S6D', 5),
  ('$ORG', '$L1', '$WH', '$S6E', 5), ('$ORG', '$L2', '$WH', '$S6E', 5),
  ('$ORG', '$M1', '$WH', '$S6F', 5), ('$ORG', '$M2', '$WH', '$S6F', 5);
SQL

race cpfirst "(public.complete_picking('$C6A')).status" "public.hold_order_stock('$H6A')"
WAITED="$(cat "$TMP/cpfirst.waited")"
check "6a: complete_picking went through" "$(grep -c '^A=picking_complete' "$TMP/cpfirst.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "6a: the hold waited for complete_picking's locks ($WAITED ms)"; else bad "6a: the hold did not wait ($WAITED ms)"; fi
check "6a: the pick took 5 of each (3 left on hand)" "$(on_hand "$J1"),$(on_hand "$J2")" "3,3"
check "6a: the hold then took only what the pick left (3 of each)" "$(held_for "$J1" "$H6A"),$(held_for "$J2" "$H6A")" "3,3"
check "6a: and says 2 of each are still short" \
  "$(has '"stillShort": [{"itemId": "'"$J1"'", "quantity": 2' "$TMP/cpfirst.B.out"),$(has '{"itemId": "'"$J2"'", "quantity": 2' "$TMP/cpfirst.B.out")" "1,1"
check "6a: the picked order holds nothing any more" "$(held_for "$J1" "$C6A"),$(held_for "$J2" "$C6A")" "0,0"

race cphold "public.hold_order_stock('$H6B')" "(public.complete_picking('$C6B')).status"
WAITED="$(cat "$TMP/cphold.waited")"
check "6b: the hold took what the picking order had not (3 of each)" "$(held_for "$J3" "$H6B"),$(held_for "$J4" "$H6B")" "3,3"
if [ "$WAITED" -ge 1500 ]; then ok "6b: complete_picking waited for the hold's locks ($WAITED ms)"; else bad "6b: complete_picking did not wait ($WAITED ms)"; fi
check "6b: then completed" "$(grep -c '^B=picking_complete' "$TMP/cphold.B.out")" "1"
check "6b: the hold keeps its 3 of each, all that is left on hand" "$(held "$J3"):$(on_hand "$J3"),$(held "$J4"):$(on_hand "$J4")" "3:3,3:3"

race samehold "public.hold_order_stock('$S6C')" "(public.complete_picking('$S6C')).status"
check "6c: the hold topped the order up first (3 more of K1, 5 of K2)" \
  "$(has '"added": 3' "$TMP/samehold.A.out"),$(has '"added": 5' "$TMP/samehold.A.out")" "1,1"
check "6c: complete_picking then picked the order" "$(grep -c '^B=picking_complete' "$TMP/samehold.B.out"),$(on_hand "$K1"),$(on_hand "$K2")" "1,3,3"
check "6c: and released every hold it had, the new ones included" "$(held_for "$K1" "$S6C"),$(held_for "$K2" "$S6C")" "0,0"

race samecp "(public.complete_picking('$S6D')).status" "public.hold_order_stock('$S6D')"
check "6d: complete_picking first" "$(grep -c '^A=picking_complete' "$TMP/samecp.A.out")" "1"
check "6d: the hold then refuses: P0001 hold_not_applicable, detail picking_complete" \
  "$(grep -c 'P0001: hold_not_applicable' "$TMP/samecp.B.out"),$(grep -c 'DETAIL:  picking_complete' "$TMP/samecp.B.out")" "1,1"
check "6d: and holds nothing" "$(held_for "$K3" "$S6D"),$(held_for "$K4" "$S6D")" "0,0"

race samecancel "(public.cancel_order_request('$S6E', '0378 race')).status" "public.hold_order_stock('$S6E')"
check "6e: cancel first" "$(grep -c '^A=cancelled' "$TMP/samecancel.A.out")" "1"
check "6e: the hold then refuses: hold_not_applicable, detail cancelled" \
  "$(grep -c 'P0001: hold_not_applicable' "$TMP/samecancel.B.out"),$(grep -c 'DETAIL:  cancelled' "$TMP/samecancel.B.out")" "1,1"
check "6e: and holds nothing" "$(held_for "$L1" "$S6E"),$(held_for "$L2" "$S6E")" "0,0"

# 6f. The mutation: the status read without the order row lock.
q "select pg_get_functiondef('public.hold_order_stock(uuid)'::regprocedure)" > "$TMP/real3.sql"
python3 - "$TMP/real3.sql" "$TMP/unlocked.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
lock = "   where o.id = p_order_id\n     for update;\n"
assert d.count(lock) == 1, d.count(lock)
d = d.replace(lock, "   where o.id = p_order_id;\n", 1)
d = d.replace('public.hold_order_stock(p_order_id uuid)', 'public._probe_hold_unlocked_status(p_order_id uuid)', 1)
assert '_probe_hold_unlocked_status' in d
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/unlocked.sql" || bad "6f: could not create the unlocked-status copy"
q "revoke all on function public._probe_hold_unlocked_status(uuid) from public, anon; grant execute on function public._probe_hold_unlocked_status(uuid) to authenticated" >/dev/null
race mutcp "(public.complete_picking('$S6F')).status" "public._probe_hold_unlocked_status('$S6F')"
check "6f: MUTATION: complete_picking went through" "$(grep -c '^A=picking_complete' "$TMP/mutcp.A.out")" "1"
check "6f: MUTATION: the copy read the old status and held 3 of each for a PICKED order (a stranded hold)" \
  "$(q "select status from public.order_requests where id = '$S6F'"):$(held_for "$M1" "$S6F"),$(held_for "$M2" "$S6F")" "picking_complete:3,3"

check "6: no item holds more than it has on hand" \
  "$(q "select count(*) from public.inventory_items ii where ii.id in ('$J1', '$J2', '$J3', '$J4', '$K1', '$K2', '$K3', '$K4', '$L1', '$L2') and (select coalesce(sum(r.quantity), 0) from public.stock_reservations r where r.item_id = ii.id and r.released_at is null) > ii.quantity_on_hand")" "0"

check "no session running the real function saw 40001 or 40P01 (1, 3, 4, 5a, 6)" \
  "$(cat "$TMP"/real.*.out "$TMP"/apfirst.*.out "$TMP"/holdfirst.*.out "$TMP"/asc.*.out "$TMP"/cpfirst.*.out "$TMP"/cphold.*.out "$TMP"/samehold.*.out "$TMP"/samecp.*.out "$TMP"/samecancel.*.out | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left" "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"

if [ "$FAILS" -eq 0 ]; then echo "PASS: all checks"; exit 0; else echo "FAILED: $FAILS check(s)"; exit 1; fi
