#!/usr/bin/env bash
#
# Two-session proof for migration 0391 (phone ordering PO-2: one create path,
# no duplicate order). pgTAP runs in ONE session, so it cannot show what
# place_order_request and withdraw_order_submission do while another session
# holds the submission key's advisory lock, or what a late original does.
#
#   1. Two sessions send one key with one body. 1a: session A places and
#      keeps its transaction open; session B waits on the key's lock, then
#      replays A's order (replay true, the same order id): one order. 1b: A
#      places and ROLLS BACK; B, which waited, then creates the order itself
#      (replay false): one order.
#   2. A placement and a withdraw race; exactly one outcome either way. 2a: A
#      places and holds; B's withdraw waits and answers placed with A's order
#      (writes nothing). 2b: A withdraws and holds; B's placement waits and
#      answers withdrawn: no order.
#   3. The judge's case: session A is held in the service BEFORE it reaches
#      the lock (its transaction is open, it has not called the function);
#      session B withdraws and commits; A then answers withdrawn and places
#      nothing.
#   4. A refused resend, then a withdraw, then the late original: B's resend
#      is refused before the lock (22023, a shape refusal: writes nothing),
#      B withdraws, and the original A (held before the lock) answers
#      withdrawn with no order.
#   5. A key's lock held past lock_timeout (5 s): B gets 55P03 and writes
#      nothing; A's placement then commits alone.
#   6. Replay first, in real time: A places with a needed-by 3 seconds ahead
#      and commits; 4 seconds later the same body under the same key replays
#      the order instead of answering needed_by_past.
#   7. No session ever sees 40001 or 40P01, and nothing deadlocks.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0391 applied. Fixtures are committed under the 03911111-... namespace
# and removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: bash scripts/db-concurrency/0391_place_order_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03911111-0000-0000-0000-00000000000a'
STF='03911111-0000-0000-0000-0000000000a1'
WH='03911111-0000-0000-0000-0000000000b1'
ITEM='03911111-0000-0000-0000-0000000000c1'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '03912222-0000-4000-8000-%012d' "$1"; }
orders()      { q "select count(*) from public.order_requests where organization_id = '$ORG'"; }
submissions() { q "select count(*) from public.order_submissions where organization_id = '$ORG'"; }
outcome_of()  { q "select coalesce((select outcome from public.order_submissions where organization_id = '$ORG' and key = '$1'), 'none')"; }

# The request for one line of the item (snake_case, as the service builds it).
req() { # req <quantity> [needed_by literal or null]
  local nb="${2:-null}"
  printf "jsonb_build_object('organization_id', '%s', 'placer_user_id', '%s', 'surface', 'app', 'warehouse_id', '%s', 'fulfillment_type', 'pickup', 'delivery_charter_id', null, 'on_behalf_name', null, 'on_behalf_email', null, 'notes', null, 'needed_by', %s, 'lines', jsonb_build_array(jsonb_build_object('item_id', '%s', 'quantity', %s)))" \
    "$ORG" "$STF" "$WH" "$nb" "$ITEM" "$1"
}
place_sql()    { printf "select 'R=' || public.place_order_request(%s, '%s')::text;" "$(req "$2" "${3:-null}")" "$1"; }
withdraw_sql() { printf "select 'R=' || public.withdraw_order_submission('%s', '%s', 'app')::text;" "$ORG" "$1"; }

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
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.order_submissions where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$STF';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from public.order_submissions where organization_id = '$ORG')")"
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

if [ "$(q "select count(*) from pg_proc where proname = 'place_order_request'")" != "1" ]; then
  echo "0391 is not applied on this stack (no place_order_request)"; exit 1
fi

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$STF', '0391-2s-stf@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0391 Two Session Org', '0391-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$STF', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0391 2S Main', 'WH-0391-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values ('$ORG', '$STF', '$WH', true);
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', '2S order item', 'SKU-0391-2S', 100, 'active');
SQL
then
  echo "fixture setup failed"; exit 1
fi

# as_user <application_name|-> <statements> [end]: one transaction as the
# staff member (authenticated, with claims); end is commit or rollback.
as_user() {
  local app="$1" body="$2" end="${3:-commit}"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "set local role authenticated;" \
    "set local \"request.jwt.claim.role\" to 'authenticated';" \
    "set local \"request.jwt.claim.sub\" to '$STF';" \
    "$body" \
    "$end;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}

# race <tag> <A's statements> <A's end> <B's statements>: A runs, then sleeps
# 3 s holding its transaction (and the key's lock); once A sits in pg_sleep,
# B runs. Records how long B took.
race() {
  local tag="$1" a="$2" aend="$3" b="$4"
  ( as_user "0391-race-$tag-A" "$a
select pg_sleep(3);" "$aend" > "$TMP/$tag.A.out" ) &
  local pid=$!
  wait_for "0391-race-$tag-A" Timeout PgSleep || bad "$tag: session A never reached its pg_sleep"
  local t0; t0=$(now_ms)
  as_user - "$b" > "$TMP/$tag.B.out"
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
ans() { sed -n 's/^R=//p' "$TMP/$1.$2.out"; }
# jget <dotted path> [more paths]: the values at those paths of the JSON on
# stdin, joined by '/' (booleans as true/false; a missing value is '-').
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

# ═══ 1. Two sessions, one key ═════════════════════════════════════════════
echo "== 1a. one key from two sessions: B waits, then replays A's order"
K1="$(key 1)"
O0="$(orders)"
race samekey "$(place_sql "$K1" 2)" commit "$(place_sql "$K1" 2)"
A_ID="$(ans samekey A | jget order.id)"
B_ID="$(ans samekey B | jget order.id)"
check "1a: A placed (replay false)" "$(ans samekey A | jget outcome replay)" "placed/false"
check "1a: B replayed A's order (replay true, the same id)" "$(ans samekey B | jget outcome replay)/$([ "$A_ID" = "$B_ID" ] && echo same || echo different)" "placed/true/same"
WAITED="$(cat "$TMP/samekey.waited")"
if [ "$WAITED" -ge 1500 ]; then ok "1a: B waited for the key's lock ($WAITED ms)"; else bad "1a: B did not wait ($WAITED ms)"; fi
check "1a: exactly one order and one placed row" "$(( $(orders) - O0 ))/$(outcome_of "$K1")" "1/placed"

echo "== 1b. A places and rolls back; B, which waited, creates it"
K2="$(key 2)"
O0="$(orders)"
race rollback "$(place_sql "$K2" 3)" rollback "$(place_sql "$K2" 3)"
check "1b: A answered placed, then rolled back" "$(ans rollback A | jget outcome)" "placed"
check "1b: B created it (replay false)" "$(ans rollback B | jget outcome replay)" "placed/false"
check "1b: exactly one order and one placed row" "$(( $(orders) - O0 ))/$(outcome_of "$K2")" "1/placed"

# ═══ 2. A placement and a withdraw race ═══════════════════════════════════
echo "== 2a. A places and holds; B withdraws"
K3="$(key 3)"
O0="$(orders)"; S0="$(submissions)"
race placefirst "$(place_sql "$K3" 1)" commit "$(withdraw_sql "$K3")"
check "2a: the withdraw waited, then answered placed with A's order" \
  "$(ans placefirst B | jget outcome)/$( [ "$(ans placefirst A | jget order.id)" = "$(ans placefirst B | jget order.id)" ] && echo same || echo different)" "placed/same"
check "2a: one order, one row (the withdraw wrote nothing)" "$(( $(orders) - O0 ))/$(( $(submissions) - S0 ))/$(outcome_of "$K3")" "1/1/placed"

echo "== 2b. A withdraws and holds; B places"
K4="$(key 4)"
O0="$(orders)"
race withdrawfirst "$(withdraw_sql "$K4")" commit "$(place_sql "$K4" 1)"
check "2b: the placement waited, then answered withdrawn" "$(ans withdrawfirst B)" '{"outcome": "withdrawn"}'
WAITED="$(cat "$TMP/withdrawfirst.waited")"
if [ "$WAITED" -ge 1500 ]; then ok "2b: B waited for the key's lock ($WAITED ms)"; else bad "2b: B did not wait ($WAITED ms)"; fi
check "2b: no order; the key is withdrawn" "$(( $(orders) - O0 ))/$(outcome_of "$K4")" "0/withdrawn"

# ═══ 3. Held before the lock while the other session withdraws ════════════
echo "== 3. the original is held before the lock; a withdraw commits first"
K5="$(key 5)"
O0="$(orders)"
( as_user "0391-held-A" "select pg_sleep(3);
$(place_sql "$K5" 1)" > "$TMP/held.A.out" ) &
PID=$!
wait_for "0391-held-A" Timeout PgSleep || bad "3: session A never reached its pg_sleep"
as_user - "$(withdraw_sql "$K5")" > "$TMP/held.B.out"
wait "$PID"
check "3: the withdraw recorded withdrawn" "$(ans held B)" '{"outcome": "withdrawn"}'
check "3: the late original answers withdrawn" "$(ans held A)" '{"outcome": "withdrawn"}'
check "3: no order" "$(( $(orders) - O0 ))/$(outcome_of "$K5")" "0/withdrawn"

# ═══ 4. A refused resend, a withdraw, then the late original ═════════════
echo "== 4. a refused resend, then a withdraw, then the late original"
K6="$(key 6)"
O0="$(orders)"; S0="$(submissions)"
( as_user "0391-late-A" "select pg_sleep(4);
$(place_sql "$K6" 1)" > "$TMP/late.A.out" ) &
PID=$!
wait_for "0391-late-A" Timeout PgSleep || bad "4: session A never reached its pg_sleep"
as_user - "$(place_sql "$K6" 0)" > "$TMP/late.resend.out"
check "4: the resend is refused before the lock (22023 order_invalid quantity) and writes nothing" \
  "$(grep -c 'ERROR:  22023' "$TMP/late.resend.out")/$(grep -c 'HINT:  order_invalid' "$TMP/late.resend.out")/$(( $(submissions) - S0 ))" "1/1/0"
as_user - "$(withdraw_sql "$K6")" > "$TMP/late.withdraw.out"
wait "$PID"
check "4: the withdraw recorded withdrawn" "$(ans late withdraw)" '{"outcome": "withdrawn"}'
check "4: the late original answers withdrawn" "$(ans late A)" '{"outcome": "withdrawn"}'
check "4: no order" "$(( $(orders) - O0 ))/$(outcome_of "$K6")" "0/withdrawn"

# ═══ 5. The lock held past lock_timeout ═══════════════════════════════════
echo "== 5. the key's lock held past 5 s"
K7="$(key 7)"
O0="$(orders)"; S0="$(submissions)"
( as_user "0391-long-A" "$(place_sql "$K7" 1)
select pg_sleep(7);" > "$TMP/long.A.out" ) &
PID=$!
wait_for "0391-long-A" Timeout PgSleep || bad "5: session A never reached its pg_sleep"
T0=$(now_ms)
as_user - "$(place_sql "$K7" 1)" > "$TMP/long.B.out"
T1=$(now_ms)
check "5: B is refused 55P03 (lock_not_available)" "$(grep -c 'ERROR:  55P03' "$TMP/long.B.out")" "1"
if [ $((T1 - T0)) -ge 4500 ] && [ $((T1 - T0)) -lt 6900 ]; then ok "5: after about 5 s ($((T1 - T0)) ms)"; else bad "5: B returned after $((T1 - T0)) ms"; fi
wait "$PID"
check "5: A's placement committed alone; B wrote nothing" "$(( $(orders) - O0 ))/$(( $(submissions) - S0 ))/$(outcome_of "$K7")" "1/1/placed"

# ═══ 6. Replay first, in real time ════════════════════════════════════════
echo "== 6. a needed-by that has since passed still replays"
K8="$(key 8)"
NB="$(q "select to_char((clock_timestamp() + interval '3 seconds') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")"
as_user - "$(place_sql "$K8" 1 "'$NB'")" > "$TMP/nb.first.out"
check "6: placed with a needed-by 3 seconds ahead" "$(ans nb first | jget outcome replay)" "placed/false"
sleep 4
as_user - "$(place_sql "$K8" 1 "'$NB'")" > "$TMP/nb.again.out"
check "6: 4 seconds later the same body replays (not needed_by_past)" \
  "$(ans nb again | jget outcome replay)/$( [ "$(ans nb first | jget order.id)" = "$(ans nb again | jget order.id)" ] && echo same || echo different)" "placed/true/same"
as_user - "$(place_sql "$(key 9)" 1 "'$NB'")" > "$TMP/nb.fresh.out"
check "6: control: a new key with that needed-by is needed_by_past" "$(ans nb fresh | jget outcome refusal.reason)" "refused/needed_by_past"

# ═══ 7. No retryable SQLSTATE anywhere ════════════════════════════════════
echo "== 7. no 40001 / 40P01, no deadlock"
check "7: no session saw 40001 or 40P01 or a deadlock" \
  "$(cat "$TMP"/*.out | grep -cE '40001|40P01|deadlock')" "0"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
