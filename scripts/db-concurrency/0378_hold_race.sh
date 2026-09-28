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
#   No session running the real function (1, 3, 4, 5a) ever sees 40001 or
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
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
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
  ('$I10',  '$ORG', '$WH', '2S pair 5b',  'SKU-0378-2S10', 8,  'active');
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
  ('$X5B', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  ('$X',   '$ITEM', 10), ('$Y',   '$ITEM', 10),
  ('$X2',  '$ITEM', 10), ('$Y2',  '$ITEM', 10),
  ('$P3',  '$I1', 5), ('$P3',  '$I2', 5), ('$X3',  '$I1', 5), ('$X3',  '$I2', 5),
  ('$P4',  '$I3', 5), ('$P4',  '$I4', 5), ('$X4',  '$I3', 5), ('$X4',  '$I4', 5),
  ('$P5A', '$I5', 5), ('$P5A', '$I6', 5), ('$X5A', '$I5', 5), ('$X5A', '$I6', 5),
  ('$P5B', '$I7', 5), ('$P5B', '$I8', 5), ('$X5B', '$I7', 5), ('$X5B', '$I8', 5);
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
  "$(has 'A={"held": [{"added": 10' "$TMP/real.A.out"),$(has '"itemId": "'"$ITEM"'"}], "stillShort": []}' "$TMP/real.A.out")" "1,1"
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

check "no session running the real function saw 40001 or 40P01 (1, 3, 4, 5a)" \
  "$(cat "$TMP"/real.*.out "$TMP"/apfirst.*.out "$TMP"/holdfirst.*.out "$TMP"/asc.*.out | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left" "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"

if [ "$FAILS" -eq 0 ]; then echo "PASS: all checks"; exit 0; else echo "FAILED: $FAILS check(s)"; exit 1; fi
