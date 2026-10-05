#!/usr/bin/env bash
#
# Two-session proof for migration 0395 (returns RX-1: every RMA transition
# through a gated function; Original rack). pgTAP runs in ONE session, so it
# cannot show what the RMA functions do while another session holds the RMA
# row, a rack row or the create key (returns plan 3.7, items 1 to 5, both
# orders of each pair).
#
#   1. Approve against approve (two managers, one expected revision). 1a: the
#      same decision: B waits on the RMA row, then replays A's answer
#      (changed false, replay true); one approved decision. 1b: a different
#      decision: B waits, then is refused return_changed; A's plan stands.
#   2. Approve against cancel, both orders. 2a: A approves and holds; B's
#      cancel (expected revision 0) waits, then is refused return_changed; the
#      RMA stays approved. 2b: A cancels and holds; B's approve waits, then is
#      refused invalid_status_transition and leaves no key behind; the RMA
#      stays cancelled.
#   3. Close against close: B waits, then answers changed false ("already
#      closed"); exactly one return movement, the line applied once,
#      returned_quantity +1 once.
#   4. Close against a rack archive, both orders. 4a: the close holds the
#      rack FOR SHARE; the archive (standing in for LocationsService.archive's
#      update after its emptiness check passed) waits, then commits: the unit
#      is on the rack and the archive came after it (the pre-existing archive
#      race, follow-up 13.1, recorded rather than fixed here). 4b: the archive
#      holds; the close waits on the rack row, then re-derives its legs under
#      the lock, sees the archive and refuses restock_location_unavailable:
#      nothing moves, the RMA stays received.
#   5. Create replay. 5a: the same key from two sessions: B waits on the key,
#      then replays A's RMA (one RMA). 5b: two different keys, each for the
#      whole line: the fulfilled cap's order-line lock serialises them and
#      the second is refused return_exceeds_fulfilled (one RMA).
#   6. A destination change against the close: A plans Staging and holds; B's
#      close with the plan sequence it read before waits, then is refused
#      return_plan_changed and moves nothing.
#   7. A lock held past lock_timeout (5 s): the second caller gets 55P03 and
#      writes nothing.
#   8. No session ever sees 40001 or 40P01, nothing deadlocks, and on hand
#      equals the sum of holdings for every fixture item.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0395 applied. Fixtures are committed under the 03951111-... namespace
# and removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: bash scripts/db-concurrency/0395_return_close_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03951111-0000-0000-0000-00000000000a'
MGR='03951111-0000-0000-0000-0000000000a1'
MGR2='03951111-0000-0000-0000-0000000000a2'
WH='03951111-0000-0000-0000-0000000000b1'
R1='03951111-0000-0000-0000-000000000c31'
RA='03951111-0000-0000-0000-000000000c32'
RB='03951111-0000-0000-0000-000000000c33'
IT='03951111-0000-0000-0000-0000000000e1'
IT4A='03951111-0000-0000-0000-0000000000e2'
IT4B='03951111-0000-0000-0000-0000000000e3'
IT5A='03951111-0000-0000-0000-0000000000e4'
IT5B='03951111-0000-0000-0000-0000000000e5'
ORDER='03951111-0000-0000-0000-000000000101'
L='03951111-0000-0000-0000-000000000201'
L4A='03951111-0000-0000-0000-000000000202'
L4B='03951111-0000-0000-0000-000000000203'
L5A='03951111-0000-0000-0000-000000000204'
L5B='03951111-0000-0000-0000-000000000205'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '03952222-0000-4000-8000-%012d' "$1"; }

# Reads (as the superuser).
status_of()  { q "select status from public.returns where id = '$1'"; }
rl_of()      { q "select id from public.return_lines where return_id = '$1'"; }
rmas()       { q "select count(*) from public.returns where organization_id = '$ORG'"; }
moves_for()  { q "select count(*) from public.stock_movements where reference_type = 'return' and reference_id = '$1'"; }
held()       { q "select coalesce((select trim_scale(quantity)::text from public.item_stock_levels where item_id = '$1' and location_id = '$2'), '0')"; }
on_hand()    { q "select trim_scale(quantity_on_hand)::text from public.inventory_items where id = '$1'"; }
returned()   { q "select trim_scale(returned_quantity)::text from public.order_request_lines where id = '$1'"; }
decisions()  { q "select count(*) from public.return_decisions where return_id = '$1' and kind = '$2'"; }
plan_seq()   { q "select coalesce(max(seq), 0) from public.return_decisions where return_id = '$1' and kind = 'disposition_planned'"; }
live_target() { q "select coalesce((select restock_target from public.return_decisions where return_id = '$1' and kind = 'disposition_planned' order by seq desc limit 1), 'none')"; }
approve_keys() { q "select count(*) from public.idempotency_keys where organization_id = '$ORG' and scope = 'return_approval' and key like '$1:%'"; }

# The request bodies (camelCase, as the service sends them).
body_one() { printf '{"reasonCode":"other","lines":[{"orderRequestLineId":"%s","quantity":1,"disposition":"restock"}]}' "$1"; }
dec_one()  { printf '{"lines":[{"returnLineId":"%s","disposition":"restock","restock":{"target":"%s"}}]}' "$1" "$2"; }

create_sql()  { printf "select 'R=' || public.create_return_request('%s', '%s'::jsonb, '%s')::text;" "$ORDER" "$(body_one "$2")" "$1"; }
approve_sql() { printf "select 'R=' || public.approve_return('%s', %s, '%s'::jsonb, false)::text;" "$1" "$2" "$3"; }
cancel_sql()  { printf "select 'R=' || public.cancel_return('%s', %s, 'Race cleanup')::text;" "$1" "$2"; }
receive_sql() { printf "select 'R=' || public.receive_return('%s')::text;" "$1"; }
close_sql()   { printf "select 'R=' || public.close_return('%s', null, %s)::text;" "$1" "${2:-null}"; }
plan_sql()    { printf "select 'R=' || public.plan_return_dispositions('%s', '[{\"returnLineId\":\"%s\",\"disposition\":\"restock\",\"restock\":{\"target\":\"%s\"}}]'::jsonb)::text;" "$1" "$2" "$3"; }

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
delete from public.returns where organization_id = '$ORG';
delete from public.idempotency_keys where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  # The picks and closes write ledger rows; the org delete must have taken
  # them (and everything else under the org) with it.
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.returns where organization_id = '$ORG') + (select count(*) from public.return_decisions where organization_id = '$ORG') + (select count(*) from public.stock_movements where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG')")"
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

if [ "$(q "select count(*) from pg_proc where proname = 'close_return' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "0395 is not applied on this stack (no public.close_return)"; exit 1
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
# as_su <application_name|-> <statements> [end]: one transaction as the
# superuser (the archive's stand-in).
as_su() {
  local app="$1" body="$2" end="${3:-commit}"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "$body" \
    "$end;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}

# ═══ Fixture: one picked and handed-over order ════════════════════════════
# Mirrors the pgTAP file's section S: complete_picking draws every line from
# its rack (recorded draws), the paper signature hands the order over.
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0395-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0395-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0395 Two Session Org', '0395-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings)
values ('$ORG', 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0395 2S Main', 'WH-0395-2S', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  ('$R1', '$ORG', '$WH', '31-C', 'shelf', 'rack', now() - interval '30 minutes'),
  ('$RA', '$ORG', '$WH', '32-A', 'shelf', 'rack', now() - interval '29 minutes'),
  ('$RB', '$ORG', '$WH', '33-B', 'shelf', 'rack', now() - interval '28 minutes');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id) values
  ('$IT',   '$ORG', '$WH', '0395-2S',    '2S return shirt',         20, 'active', 'none', '$R1'),
  ('$IT4A', '$ORG', '$WH', '0395-2S-4A', '2S return shirt archive', 2,  'active', 'none', '$RA'),
  ('$IT4B', '$ORG', '$WH', '0395-2S-4B', '2S return shirt archive2', 2, 'active', 'none', '$RB'),
  ('$IT5A', '$ORG', '$WH', '0395-2S-5A', '2S return shirt key',     2,  'active', 'none', '$R1'),
  ('$IT5B', '$ORG', '$WH', '0395-2S-5B', '2S return shirt cap',     2,  'active', 'none', '$R1');
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$ORDER', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  ('$L',   '$ORDER', '$IT',   10, 0),
  ('$L4A', '$ORDER', '$IT4A', 1,  0),
  ('$L4B', '$ORDER', '$IT4B', 1,  0),
  ('$L5A', '$ORDER', '$IT5A', 1,  0),
  ('$L5B', '$ORDER', '$IT5B', 1,  0);
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
check "fixture: every pick carries its recorded draw" \
  "$(q "select count(*) from public.stock_movements where reference_type = 'order_request' and reference_id = '$ORDER' and movement_type = 'transfer' and quantity_change < 0 and via_ledger and draw is not null")" "5"

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
# refused <tag> <side> <sqlstate> <hint>: 1/1 when that session's output
# carries the error and its hint.
refused() {
  printf '%s/%s' "$(grep -c "ERROR:  $3" "$TMP/$1.$2.out")" "$(grep -c "HINT:  $4" "$TMP/$1.$2.out")"
}

# new_rma <key number> <line>: a committed one-unit RMA (requested); prints its id.
N=0
new_rma() {
  N=$((N + 1))
  as_user - "$MGR" "$(create_sql "$(key "$1")" "$2")" > "$TMP/new.$N.out"
  sed -n 's/^R=//p' "$TMP/new.$N.out" | jget returnId
}
# approve_now <rma> <target>, receive_now <rma>: committed, sequential.
approve_now() {
  N=$((N + 1))
  as_user - "$MGR" "$(approve_sql "$1" 0 "$(dec_one "$(rl_of "$1")" "$2")")" > "$TMP/ap.$N.out"
  sed -n 's/^R=//p' "$TMP/ap.$N.out" | jget status
}
receive_now() {
  N=$((N + 1))
  as_user - "$MGR" "$(receive_sql "$1")" > "$TMP/rc.$N.out"
  sed -n 's/^R=//p' "$TMP/rc.$N.out" | jget status
}

# race <tag> <A's user> <A's statements> <A's end> <B's user> <B's statements>:
# A runs, then sleeps 3 s holding its transaction (and its locks); once A sits
# in pg_sleep, B runs. Records how long B took. A user of '-' runs that side
# as the superuser.
race() {
  local tag="$1" au="$2" a="$3" aend="$4" bu="$5" b="$6"
  if [ "$au" = "-" ]; then
    ( as_su "0395-race-$tag-A" "$a
select pg_sleep(3);" "$aend" > "$TMP/$tag.A.out" ) &
  else
    ( as_user "0395-race-$tag-A" "$au" "$a
select pg_sleep(3);" "$aend" > "$TMP/$tag.A.out" ) &
  fi
  local pid=$!
  wait_for "0395-race-$tag-A" Timeout PgSleep || bad "$tag: session A never reached its pg_sleep"
  local t0; t0=$(now_ms)
  if [ "$bu" = "-" ]; then
    as_su - "$b" > "$TMP/$tag.B.out"
  else
    as_user - "$bu" "$b" > "$TMP/$tag.B.out"
  fi
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
waited() { # waited <tag> <label>
  local w; w="$(cat "$TMP/$1.waited")"
  if [ "$w" -ge 1500 ]; then ok "$2: B waited for A ($w ms)"; else bad "$2: B did not wait ($w ms)"; fi
}

# ═══ 1. Approve against approve ═══════════════════════════════════════════
echo "== 1a. two managers approve the same decision at once"
R="$(new_rma 1 "$L")"
D="$(dec_one "$(rl_of "$R")" original)"
race appsame "$MGR" "$(approve_sql "$R" 0 "$D")" commit "$MGR2" "$(approve_sql "$R" 0 "$D")"
check "1a: A approved (changed true, revision 1)" "$(ans appsame A | jget changed replay revision)" "true/false/1"
check "1a: B replayed A's answer (changed false, replay true)" "$(ans appsame B | jget changed replay revision)" "false/true/1"
waited appsame "1a"
check "1a: one approved decision, one key, the RMA approved" "$(decisions "$R" approved)/$(approve_keys "$R")/$(status_of "$R")" "1/1/approved"

echo "== 1b. two managers approve different decisions at once"
R="$(new_rma 2 "$L")"
RL="$(rl_of "$R")"
race appdiff "$MGR" "$(approve_sql "$R" 0 "$(dec_one "$RL" original)")" commit "$MGR2" "$(approve_sql "$R" 0 "$(dec_one "$RL" staging)")"
check "1b: A approved" "$(ans appdiff A | jget changed revision)" "true/1"
check "1b: B is refused return_changed" "$(refused appdiff B P0001 return_changed)" "1/1"
waited appdiff "1b"
check "1b: one approved decision; A's plan (original) stands" "$(decisions "$R" approved)/$(live_target "$R")" "1/original"

# ═══ 2. Approve against cancel ════════════════════════════════════════════
echo "== 2a. approve holds; cancel at the same revision waits"
R="$(new_rma 3 "$L")"
race appcan "$MGR" "$(approve_sql "$R" 0 "$(dec_one "$(rl_of "$R")" original)")" commit "$MGR2" "$(cancel_sql "$R" 0)"
check "2a: A approved" "$(ans appcan A | jget changed status)" "true/approved"
check "2a: the cancel is refused return_changed" "$(refused appcan B P0001 return_changed)" "1/1"
waited appcan "2a"
check "2a: the RMA stays approved; no cancelled decision" "$(status_of "$R")/$(decisions "$R" cancelled)" "approved/0"

echo "== 2b. cancel holds; approve waits"
R="$(new_rma 4 "$L")"
race canapp "$MGR" "$(cancel_sql "$R" 0)" commit "$MGR2" "$(approve_sql "$R" 0 "$(dec_one "$(rl_of "$R")" original)")"
check "2b: A cancelled" "$(ans canapp A | jget changed status)" "true/cancelled"
check "2b: the approve is refused invalid_status_transition" "$(refused canapp B P0001 invalid_status_transition)" "1/1"
waited canapp "2b"
check "2b: the RMA stays cancelled; no approval and no key left behind" \
  "$(status_of "$R")/$(decisions "$R" approved)/$(approve_keys "$R")" "cancelled/0/0"

# ═══ 3. Close against close ═══════════════════════════════════════════════
echo "== 3. two closes of one received RMA"
R="$(new_rma 5 "$L")"
check "3: set up (approved to the original rack, received)" "$(approve_now "$R" original)/$(receive_now "$R")" "approved/received"
H0="$(held "$IT" "$R1")"; Q0="$(on_hand "$IT")"; RQ0="$(returned "$L")"
race closeclose "$MGR" "$(close_sql "$R")" commit "$MGR2" "$(close_sql "$R")"
check "3: A closed" "$(ans closeclose A | jget changed status)" "true/closed"
check "3: B answers already closed (changed false)" "$(ans closeclose B | jget changed status)" "false/closed"
waited closeclose "3"
check "3: one return movement, 31-C +1, on hand +1, returned +1 once" \
  "$(moves_for "$R")/$(( $(held "$IT" "$R1") - H0 ))/$(( $(on_hand "$IT") - Q0 ))/$(python3 -c "print(int(float('$(returned "$L")') - float('$RQ0')))")" "1/1/1/1"
check "3: one closed decision" "$(decisions "$R" closed)" "1"

# ═══ 4. Close against a rack archive ══════════════════════════════════════
echo "== 4a. the close holds the rack; the archive waits"
R="$(new_rma 6 "$L4A")"
check "4a: set up (approved to 32-A, received)" "$(approve_now "$R" original)/$(receive_now "$R")" "approved/received"
H0="$(held "$IT4A" "$RA")"
race closearch "$MGR" "$(close_sql "$R")" commit - "update public.locations set deleted_at = now() where id = '$RA';"
check "4a: the close went through, to 32-A" "$(ans closearch A | jget changed status)/$(( $(held "$IT4A" "$RA") - H0 ))" "true/closed/1"
waited closearch "4a"
check "4a: the archive committed after the close (the follow-up 13.1 race, recorded)" \
  "$(q "select (deleted_at is not null)::text from public.locations where id = '$RA'")/$(grep -c 'ERROR' "$TMP/closearch.B.out")" "true/0"

echo "== 4b. the archive holds; the close waits, then refuses"
R="$(new_rma 7 "$L4B")"
check "4b: set up (approved to 33-B, received)" "$(approve_now "$R" original)/$(receive_now "$R")" "approved/received"
item_snap() { printf '%s|%s|%s' "$(on_hand "$1")" "$(held "$1" "$2")" "$(q "select count(*) from public.stock_movements where item_id = '$1'")"; }
S0="$(item_snap "$IT4B" "$RB")"
race archclose - "update public.locations set deleted_at = now() where id = '$RB';" commit "$MGR" "$(close_sql "$R")"
check "4b: the close is refused restock_location_unavailable" "$(refused archclose B P0001 restock_location_unavailable)" "1/1"
check "4b: the refusal names the archived rack" "$(grep -c '"rule": "archived"' "$TMP/archclose.B.out")" "1"
waited archclose "4b"
check "4b: nothing moved; the RMA stays received; the line unapplied" \
  "$(item_snap "$IT4B" "$RB")/$(status_of "$R")/$(q "select applied::text from public.return_lines where return_id = '$R'")" \
  "$S0/received/false"

# ═══ 5. Create replay ═════════════════════════════════════════════════════
echo "== 5a. the same create key from two sessions"
K="$(key 50)"
M0="$(rmas)"
race createkey "$MGR" "$(create_sql "$K" "$L5A")" commit "$MGR" "$(create_sql "$K" "$L5A")"
A_ID="$(ans createkey A | jget returnId)"
B_ID="$(ans createkey B | jget returnId)"
check "5a: A created (replay false)" "$(ans createkey A | jget changed replay)" "true/false"
check "5a: B replayed A's RMA (the same id)" "$(ans createkey B | jget changed replay)/$([ "$A_ID" = "$B_ID" ] && echo same || echo different)" "false/true/same"
waited createkey "5a"
check "5a: exactly one RMA" "$(( $(rmas) - M0 ))" "1"

echo "== 5b. two keys, each for the whole line"
M0="$(rmas)"
race createcap "$MGR" "$(create_sql "$(key 51)" "$L5B")" commit "$MGR2" "$(create_sql "$(key 52)" "$L5B")"
check "5b: A created" "$(ans createcap A | jget changed)" "true"
check "5b: B is refused return_exceeds_fulfilled" "$(grep -c 'ERROR:  P0001' "$TMP/createcap.B.out")/$(grep -c 'return_exceeds_fulfilled' "$TMP/createcap.B.out")" "1/1"
waited createcap "5b"
check "5b: exactly one RMA" "$(( $(rmas) - M0 ))" "1"

# ═══ 6. A destination change against the close ════════════════════════════
echo "== 6. a re-plan holds; the close with the old plan sequence waits"
R="$(new_rma 8 "$L")"
check "6: set up (approved to the original rack, received)" "$(approve_now "$R" original)/$(receive_now "$R")" "approved/received"
SEQ0="$(plan_seq "$R")"
M0="$(moves_for "$R")"
race planclose "$MGR" "$(plan_sql "$R" "$(rl_of "$R")" staging)" commit "$MGR2" "$(close_sql "$R" "$SEQ0")"
check "6: A planned Staging" "$(ans planclose A | jget changed appended)" "true/1"
check "6: the close is refused return_plan_changed" "$(refused planclose B P0001 return_plan_changed)" "1/1"
waited planclose "6"
check "6: nothing moved; the RMA stays received; the live plan is Staging" "$(( $(moves_for "$R") - M0 ))/$(status_of "$R")/$(live_target "$R")" "0/received/staging"

# ═══ 7. A lock held past lock_timeout ═════════════════════════════════════
echo "== 7. the RMA row held past 5 s"
( as_user "0395-long-A" "$MGR" "$(close_sql "$R")
select pg_sleep(7);" > "$TMP/long.A.out" ) &
PID=$!
wait_for "0395-long-A" Timeout PgSleep || bad "7: session A never reached its pg_sleep"
T0=$(now_ms)
as_user - "$MGR2" "$(close_sql "$R")" > "$TMP/long.B.out"
T1=$(now_ms)
check "7: B is refused 55P03 (lock_not_available)" "$(grep -c 'ERROR:  55P03' "$TMP/long.B.out")" "1"
if [ $((T1 - T0)) -ge 4500 ] && [ $((T1 - T0)) -lt 6900 ]; then ok "7: after about 5 s ($((T1 - T0)) ms)"; else bad "7: B returned after $((T1 - T0)) ms"; fi
wait "$PID"
check "7: A's close committed alone (to Staging, the live plan)" "$(status_of "$R")/$(moves_for "$R")/$(decisions "$R" closed)" "closed/1/1"

# ═══ 8. No retryable SQLSTATE; holdings equal on hand ═════════════════════
echo "== 8. no 40001 / 40P01, no deadlock; on hand = the sum of holdings"
check "8: no session saw 40001 or 40P01 or a deadlock" \
  "$(cat "$TMP"/*.out | grep -cE '40001|40P01|deadlock')" "0"
check "8: on hand equals the sum of holdings for every fixture item" \
  "$(q "select count(*) from public.inventory_items i where i.organization_id = '$ORG' and i.quantity_on_hand <> (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = i.id)")" "0"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
