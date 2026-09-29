#!/usr/bin/env bash
#
# Two-session proof for F2-3 (put away and partial fulfilment from the order).
# F2-3 has NO migration: approve_partial (0365) and resume_fulfillment (0348)
# are frozen and unchanged. What this proves is the promise the screens make
# around them: the preview (core previewPartialFulfilment) is read BEFORE the
# commit, the commit re-checks inside its own transaction, and the message
# (core describePartialResult) is computed from readiness read AFTER the
# commit, so when stock moves in between the message reports the difference
# instead of echoing the preview. Numbered 0380 as the next free number at
# build time (the plan's "<next>"); it pins no migration of its own.
#
#   0. Control. A pending order asks 8 + 4 of an item with 10 on hand (two
#      lines of the same item). Preview: holds 10 of 12. Nothing moves;
#      approve_partial holds 10. Message: "Approved. Holding 10 of 12 units."
#   1. Stale, one session after the other. The same order shape; after the
#      preview is read, another session holds 2 of the 10 for an approved
#      order that owed them (hold_order_stock, F2-2). approve_partial then
#      holds 8, split between the two lines in no defined way. Message:
#      "Approved. Holding 8 of 12 units, 2 fewer than shown because stock
#      changed after you looked."
#   2. Stale, at the same moment. The other session's hold keeps its
#      transaction open; approve_partial starts meanwhile, waits on the item
#      lock, then reads the committed hold and holds 8. The same message. No
#      40001 or 40P01.
#   3. The lock, and its MUTATION. Another session inserts a 2-unit hold and
#      keeps its transaction open. An insert takes only the foreign key's
#      share lock on the item row (hold_order_stock's own FOR UPDATE would
#      block the copy's insert on that same foreign key and hide the race, so
#      the other session here is a plain insert, as postgres).
#        a. The real approve_partial waits on it (its FOR UPDATE conflicts
#           with the share lock), then reads the committed hold and holds 8.
#        b. MUTATION: a copy with the items' FOR UPDATE removed (a throwaway
#           public._probe_approve_partial_nolock, dropped at the end) does not
#           wait, reads no hold, and holds 10: 12 held against 10 on hand.
#           This is what re-checking under the lock prevents, and why the
#           preview can only ever be a preview.
#   4. Resume at the same moment. A backordered order owes 4 (10 asked, 6
#      handed over) of an item with 6 on hand. Preview: holds 4 of 4. Another
#      session holds 3 for an approved order, transaction open;
#      resume_fulfillment waits, then holds 3. Message: "Resumed. A new pick
#      slip is ready. Holding 3 of 4 units, 1 fewer than shown because stock
#      changed after you looked."
#   5. The messages. Every case's two real readiness answers (before and
#      after) and what SQL counted as held are written to a JSON file, and
#      packages/core/src/orders/partial-fulfilment.two-session.test.ts turns
#      them into the preview and the message with core, as the web page and
#      the phone do. The check fails if the message echoes the preview (the
#      mutation the unit tests also pin), and this script fails if that file
#      is skipped or runs fewer cases than were written.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03801111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0380_partial_stale.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORG='03801111-0000-0000-0000-00000000000a'
MGR='03801111-0000-0000-0000-0000000000a1'
WH='03801111-0000-0000-0000-0000000000b1'
# Items: A0 control, A1 stale (sequential), A2 stale (concurrent), A3 the
# real function against an open insert, A4 the lock-less mutation, R1 resume.
A0='03801111-0000-0000-0000-0000000000c0'
A1='03801111-0000-0000-0000-0000000000c1'
A2='03801111-0000-0000-0000-0000000000c2'
A3='03801111-0000-0000-0000-0000000000c3'
A4='03801111-0000-0000-0000-0000000000c5'
R1='03801111-0000-0000-0000-0000000000c4'
# Pending orders to approve partially, and the approved orders whose holds
# move the stock underneath them.
P0='03801111-0000-0000-0000-0000000000d0'
P1='03801111-0000-0000-0000-0000000000d1'
Y1='03801111-0000-0000-0000-0000000000e1'
P2='03801111-0000-0000-0000-0000000000d2'
Y2='03801111-0000-0000-0000-0000000000e2'
P3='03801111-0000-0000-0000-0000000000d3'
Y3='03801111-0000-0000-0000-0000000000e3'
P4='03801111-0000-0000-0000-0000000000d5'
Y4='03801111-0000-0000-0000-0000000000e5'
# The backordered order to resume, and the approved order that holds.
BO='03801111-0000-0000-0000-0000000000d4'
Z='03801111-0000-0000-0000-0000000000e4'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
# Active holds on one item, and on it for one order (whole units: every
# quantity here is whole).
held()     { q "select coalesce(sum(quantity), 0)::int from public.stock_reservations where item_id = '$1' and released_at is null"; }
held_for() { q "select coalesce(sum(quantity), 0)::int from public.stock_reservations where item_id = '$1' and order_request_id = '$2' and released_at is null"; }
status_of() { q "select status from public.order_requests where id = '$1'"; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_approve_partial_nolock(uuid);
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from public.stock_reservations where organization_id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

cleanup || exit 1

# The fixture. The approved orders Y1..Y3 and Z owe their lines UNHELD (lines
# added after approval, the F2-2 case), so hold_order_stock has something to
# hold when the other session calls it. The backordered order has handed 6 of
# 10 over, so it owes 4.
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0380-2s-mgr@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0380 Two Session Org', '0380-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0380 2S Main', 'WH-0380-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$A0', '$ORG', '$WH', '2S control',    'SKU-0380-A0', 10, 'active'),
  ('$A1', '$ORG', '$WH', '2S stale seq',  'SKU-0380-A1', 10, 'active'),
  ('$A2', '$ORG', '$WH', '2S stale conc', 'SKU-0380-A2', 10, 'active'),
  ('$A3', '$ORG', '$WH', '2S open hold',  'SKU-0380-A3', 10, 'active'),
  ('$A4', '$ORG', '$WH', '2S no lock',    'SKU-0380-A4', 10, 'active'),
  ('$R1', '$ORG', '$WH', '2S resume',     'SKU-0380-R1', 6,  'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$P0', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$P1', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$Y1', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P2', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$Y2', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P3', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$Y3', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$P4', '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'),
  ('$Y4', '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup'),
  ('$BO', '$ORG', '$WH', 'backordered',      'internal', '$MGR', 'pickup'),
  ('$Z',  '$ORG', '$WH', 'approved',         'internal', '$MGR', 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  ('$P0', '$A0', 8), ('$P0', '$A0', 4),
  ('$P1', '$A1', 8), ('$P1', '$A1', 4), ('$Y1', '$A1', 2),
  ('$P2', '$A2', 8), ('$P2', '$A2', 4), ('$Y2', '$A2', 2),
  ('$P3', '$A3', 8), ('$P3', '$A3', 4), ('$Y3', '$A3', 2),
  ('$P4', '$A4', 8), ('$P4', '$A4', 4), ('$Y4', '$A4', 2),
  ('$Z',  '$R1', 3);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  ('$BO', '$R1', 10, 6);
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# as_mgr <sql>: one statement as the manager (authenticated, the JWT's sub).
as_mgr() {
  "${PSQL[@]}" -v VERBOSITY=verbose <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
$1;
commit;
SQL
}

# facts <order> <file>: order_readiness_facts as the manager, one JSON value.
facts() {
  as_mgr "select public.order_readiness_facts('$1')::text" > "$2" 2>"$2.err"
  if [ "$(head -c 1 "$2")" != "{" ]; then bad "facts for $1 did not read: $(cat "$2" "$2.err" | head -3)"; fi
}

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

# race_pg <tag> <insert sql> <sqlB>: A (as postgres, no JWT) runs the insert
# and holds its transaction 3 s; B runs its call at 1 s as the manager.
race_pg() {
  local tag="$1" a="$2" b="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
$a;
select 'A=inserted';
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
# has <fixed text> <file>: how many lines carry the text (no regex, no quoting traps).
has() { grep -cF -- "$1" "$2"; }

# Cases for section 5: name|action|preview file|reread file|preview holds|db held|text
CASES="$TMP/cases.tsv"
: > "$CASES"
add_case() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$CASES"; }

# ═══ 0. Control: nothing moves ════════════════════════════════════════════
echo "== 0. control: preview, then approve_partial with nothing in between"
facts "$P0" "$TMP/s0.before.json"
as_mgr "select 'P=' || (public.approve_partial('$P0')).status" > "$TMP/s0.approve.out" 2>&1
check "0a: approve_partial went through" "$(grep -c '^P=approved' "$TMP/s0.approve.out")" "1"
check "0b: it held all 10 on hand, over the two lines" "$(held_for "$A0" "$P0")" "10"
facts "$P0" "$TMP/s0.after.json"
add_case "0 control: approve partial, nothing moved" approve_partial "$TMP/s0.before.json" "$TMP/s0.after.json" 10 "$(held_for "$A0" "$P0")" \
  "Approved. Holding 10 of 12 units."

# ═══ 1. Stale, sequential ═════════════════════════════════════════════════
echo "== 1. preview read, another session holds 2, then approve_partial"
facts "$P1" "$TMP/s1.before.json"
as_mgr "select 'H=' || public.hold_order_stock('$Y1')::text" > "$TMP/s1.hold.out" 2>&1
check "1a: the other session held 2 for its order" "$(held_for "$A1" "$Y1")" "2"
as_mgr "select 'P=' || (public.approve_partial('$P1')).status" > "$TMP/s1.approve.out" 2>&1
check "1b: approve_partial went through" "$(grep -c '^P=approved' "$TMP/s1.approve.out")" "1"
check "1c: it held 8, 2 fewer than the preview's 10" "$(held_for "$A1" "$P1")" "8"
check "1d: 10 held in all, what is on hand" "$(held "$A1")" "10"
facts "$P1" "$TMP/s1.after.json"
add_case "1 stale, sequential: 2 held by another session after the preview" approve_partial \
  "$TMP/s1.before.json" "$TMP/s1.after.json" 10 "$(held_for "$A1" "$P1")" \
  "Approved. Holding 8 of 12 units, 2 fewer than shown because stock changed after you looked."

# ═══ 2. Stale, concurrent ═════════════════════════════════════════════════
echo "== 2. the other session's hold still open while approve_partial runs"
facts "$P2" "$TMP/s2.before.json"
race conc "public.hold_order_stock('$Y2')" "(public.approve_partial('$P2')).status"
WAITED="$(cat "$TMP/conc.waited")"
check "2a: the hold went through, holding 2" "$(has 'A={"held": [{"added": 2' "$TMP/conc.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "2b: approve_partial waited for the hold's item lock ($WAITED ms)"; else bad "2b: approve_partial did not wait ($WAITED ms)"; fi
check "2c: then approved" "$(grep -c '^B=approved' "$TMP/conc.B.out")" "1"
check "2d: holding 8 (it read the committed hold), 10 in all" "$(held_for "$A2" "$P2"),$(held "$A2")" "8,10"
facts "$P2" "$TMP/s2.after.json"
add_case "2 stale, concurrent: approve_partial waited on the item lock, then held 2 fewer" approve_partial \
  "$TMP/s2.before.json" "$TMP/s2.after.json" 10 "$(held_for "$A2" "$P2")" \
  "Approved. Holding 8 of 12 units, 2 fewer than shown because stock changed after you looked."

# ═══ 3. The lock, and its mutation ═══════════════════════════════════════
echo "== 3a. an open insert of a hold: the real approve_partial waits for it"
INS3="insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity) values ('$ORG', '$A3', '$WH', '$Y3', 2)"
race_pg lock "$INS3" "(public.approve_partial('$P3')).status"
WAITED="$(cat "$TMP/lock.waited")"
check "3a: the insert went through" "$(grep -c '^A=inserted' "$TMP/lock.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "3a: approve_partial waited for it ($WAITED ms)"; else bad "3a: approve_partial did not wait ($WAITED ms)"; fi
check "3a: then approved, holding 8, 10 in all" "$(grep -c '^B=approved' "$TMP/lock.B.out"),$(held_for "$A3" "$P3"),$(held "$A3")" "1,8,10"

echo "== 3b. MUTATION: the same race against a copy of approve_partial without the items' FOR UPDATE"
q "select pg_get_functiondef('public.approve_partial(uuid)'::regprocedure)" > "$TMP/ap.sql"
python3 - "$TMP/ap.sql" "$TMP/ap_nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
lock = "    order by l.item_id\n    for update of ii\n  loop"
assert d.count(lock) == 1, d.count(lock)
d = d.replace(lock, "    order by l.item_id\n  loop")
head = 'public.approve_partial(p_id uuid)'
assert d.count(head) == 1, d.count(head)
d = d.replace(head, 'public._probe_approve_partial_nolock(p_id uuid)', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
if [ $? -ne 0 ]; then bad "3b: could not build the lock-less copy"; fi
"${PSQL[@]}" >/dev/null < "$TMP/ap_nolock.sql" || bad "3b: could not create the lock-less copy"
q "revoke all on function public._probe_approve_partial_nolock(uuid) from public, anon; grant execute on function public._probe_approve_partial_nolock(uuid) to authenticated" >/dev/null
INS4="insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity) values ('$ORG', '$A4', '$WH', '$Y4', 2)"
race_pg nolock "$INS4" "(public._probe_approve_partial_nolock('$P4')).status"
WAITED="$(cat "$TMP/nolock.waited")"
if [ "$WAITED" -lt 1000 ]; then ok "3b: the copy did not wait ($WAITED ms)"; else bad "3b: the copy waited ($WAITED ms)"; fi
check "3b: it held all 10 (it read before the other hold committed)" "$(held_for "$A4" "$P4")" "10"
check "3b: 12 held against 10 on hand: what the item lock and the re-check prevent" "$(held "$A4")" "12"

# ═══ 4. Resume, concurrent ════════════════════════════════════════════════
echo "== 4. resume_fulfillment while another session's hold is open"
facts "$BO" "$TMP/s4.before.json"
race resume "public.hold_order_stock('$Z')" "(public.resume_fulfillment('$BO')).status"
WAITED="$(cat "$TMP/resume.waited")"
check "4a: the hold took 3 for its order" "$(held_for "$R1" "$Z")" "3"
if [ "$WAITED" -ge 1500 ]; then ok "4b: resume_fulfillment waited for the hold's item lock ($WAITED ms)"; else bad "4b: resume did not wait ($WAITED ms)"; fi
check "4c: then resumed (a new pick slip)" "$(grep -c '^B=pick_slip_generated' "$TMP/resume.B.out")" "1"
check "4d: holding 3 of the 4 owed, 6 in all (what is on hand)" "$(held_for "$R1" "$BO"),$(held "$R1")" "3,6"
facts "$BO" "$TMP/s4.after.json"
add_case "4 resume, concurrent: 1 fewer than the preview" resume \
  "$TMP/s4.before.json" "$TMP/s4.after.json" 4 "$(held_for "$R1" "$BO")" \
  "Resumed. A new pick slip is ready. Holding 3 of 4 units, 1 fewer than shown because stock changed after you looked."

check "no session saw 40001 or 40P01 (0, 1, 2, 3a, 4)" \
  "$(cat "$TMP"/s0.approve.out "$TMP"/s1.*.out "$TMP"/conc.*.out "$TMP"/lock.*.out "$TMP"/resume.*.out | grep -cE '40001|40P01')" "0"
check "statuses after the commits" \
  "$(status_of "$P0"),$(status_of "$P1"),$(status_of "$P2"),$(status_of "$BO")" "approved,approved,approved,pick_slip_generated"

# ═══ 5. The messages, from the real answers, with core ════════════════════
echo "== 5. core: the preview and the message from the two real readiness answers"
python3 - "$CASES" "$TMP/cases.json" <<'PY'
import json, sys
cases = []
for row in open(sys.argv[1]):
    name, action, before, after, preview_holds, db_held, text = row.rstrip('\n').split('\t')
    cases.append({
        'name': name,
        'action': action,
        'preview': json.load(open(before)),
        'reread': json.load(open(after)),
        'previewHolds': float(preview_holds),
        'dbHeld': float(db_held),
        'text': text,
    })
json.dump(cases, open(sys.argv[2], 'w'))
print(len(cases))
PY
WROTE="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$TMP/cases.json" 2>/dev/null || echo 0)"
( cd "$ROOT/packages/core" && PARTIAL_STALE_CASES="$TMP/cases.json" node_modules/.bin/vitest run \
    src/orders/partial-fulfilment.two-session.test.ts ) > "$TMP/core.out" 2>&1
CORE_STATUS=$?
cat "$TMP/core.out" | grep -E 'Tests|passed|failed|skipped|Error' | head -20
check "5a: the core check ran and passed" "$CORE_STATUS" "0"
check "5b: it was not skipped" "$(grep -c 'skipped' "$TMP/core.out")" "0"
# One test per case, plus the case-count test.
check "5c: it ran every case written ($WROTE)" "$(grep -cE "Tests +$((WROTE + 1)) passed" "$TMP/core.out")" "1"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left" "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"

if [ "$FAILS" -eq 0 ]; then echo "PASS: all checks"; exit 0; else echo "FAILED: $FAILS check(s)"; exit 1; fi
