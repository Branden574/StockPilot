#!/usr/bin/env bash
#
# Two-session proof for migration 0383 (F2-4, revise_order_needed_by). pgTAP
# runs in ONE session, so it cannot show what happens when two approvers
# change the same order's needed-by at the same moment.
#
#   1. Two revisions of one order, both made against the SAME value (each
#      approver opened the dialog before the other saved). Session A revises
#      to day +5 and keeps its transaction open; session B revises to day +6
#      meanwhile. B waits on A's order-row lock, then reads A's committed
#      value, which is no longer the one it was made against: B is refused
#      with P0001 needed_by_changed, detail = A's value, and writes nothing.
#      Exactly one wins: the order and its event hold A's value, the event's
#      reminder stamps are cleared once.
#   2. The same race against a COPY of the function with the order row's FOR
#      UPDATE taken out (a throwaway public._probe_revise_nolock, dropped by
#      the EXIT trap however the script ends): B reads the value before A
#      commits, passes the stale check, waits only at its own UPDATE, and then
#      overwrites A. Both answer changed: true, and A's change is lost without
#      anyone being told. This is the mutation the lock exists for.
#   3. cancel_order_request first, a revision meanwhile: the revision waits,
#      then finds the order cancelled and is refused (P0001 order_closed,
#      detail cancelled); the date stays.
#   No session running the real function ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03831111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0383_needed_by_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
# Section 2 creates a throwaway SECURITY DEFINER copy of the real function
# with its lock taken out, executable by authenticated. The EXIT trap drops it
# however the script ends (a failure, Ctrl-C, SIGTERM, a harness timeout;
# bash runs it on INT, TERM and HUP), so an interrupted run never leaves it on
# the shared local stack. SIGKILL cannot be trapped: the next run's cleanup
# drops it first.
# shellcheck disable=SC2329 # called from the EXIT trap below
drop_probes() {
  "${PSQL[@]}" -c "drop function if exists public._probe_revise_nolock(uuid, timestamptz, timestamptz, text, text)" >/dev/null 2>&1
}
trap 'drop_probes; rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

ORG='03831111-0000-0000-0000-00000000000a'
MGR='03831111-0000-0000-0000-0000000000a1'
MGR2='03831111-0000-0000-0000-0000000000a2'
WH='03831111-0000-0000-0000-0000000000b1'
O1='03831111-0000-0000-0000-0000000000d1'
O2='03831111-0000-0000-0000-0000000000d2'
O3='03831111-0000-0000-0000-0000000000d3'
E1='03831111-0000-0000-0000-0000000000e1'
E2='03831111-0000-0000-0000-0000000000e2'

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
# The order's needed-by and its event's start, as day offsets from BASE.
day_of() { q "select extract(day from (needed_by - '$BASE'::timestamptz))::int from public.order_requests where id = '$1'"; }
event_day() { q "select extract(day from (starts_at - '$BASE'::timestamptz))::int from public.schedule_events where id = '$1'"; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_revise_nolock(uuid, timestamptz, timestamptz, text, text);
delete from public.schedule_events where organization_id = '$ORG';
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from public.schedule_events where organization_id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

cleanup || exit 1

# The base instant (midnight UTC, 10 days ahead) every needed-by here is
# counted from, as a literal so every session reads the same value.
BASE="$(q "select to_char(date_trunc('day', now() at time zone 'UTC') + interval '10 days', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")"
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0383-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0383-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0383 Two Session Org', '0383-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',  'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0383 2S Main', 'WH-0383-2S', 'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, needed_by)
select v.id, '$ORG', '$WH', 'approved', 'internal', '$MGR', 'pickup', '$BASE'::timestamptz
  from (values ('$O1'::uuid), ('$O2'::uuid), ('$O3'::uuid)) v(id);
insert into public.schedule_events (id, organization_id, title, starts_at, warehouse_id, details, status, order_request_id,
                                    created_by, updated_by, reminded_24h_at, reminded_1h_at)
select v.ev, '$ORG', '2S pickup', '$BASE'::timestamptz, '$WH', 'old', 'scheduled', v.o, '$MGR', '$MGR', now(), now()
  from (values ('$E1'::uuid, '$O1'::uuid), ('$E2'::uuid, '$O2'::uuid)) v(ev, o);
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# race <tag> <fn> <order> <A's day> <B's day>: A (the manager) revises to day
# +A and holds its transaction 3 s; B (the second manager) revises to day +B
# at 1 s. Both are made against the order's CURRENT value (day +0).
race() {
  local tag="$1" fn="$2" o="$3" da="$4" db="$5"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || public.$fn('$o', '$BASE'::timestamptz + interval '$da days',
                         '$BASE'::timestamptz, 'Session A', 'A details')::text;
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
set local "request.jwt.claim.sub" to '$MGR2';
select 'B=' || public.$fn('$o', '$BASE'::timestamptz + interval '$db days',
                         '$BASE'::timestamptz, 'Session B', 'B details')::text;
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# ═══ 1. Two revisions against the same value ══════════════════════════════
echo "== 1. two approvers revise the same order against the same value at the same moment"
race real revise_order_needed_by "$O1" 5 6
WAITED="$(cat "$TMP/real.waited")"
check "1a: A changed it" "$(has 'A={"status": "approved", "changed": true' "$TMP/real.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's order-row lock ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: B was refused: needed_by_changed (P0001)" \
  "$(has 'ERROR:  P0001: needed_by_changed' "$TMP/real.B.out")" "1"
check "1d: B's refusal names the value A saved (so B's screen can load it)" \
  "$(grep -F 'DETAIL:' "$TMP/real.B.out" | sed -E 's/^.*DETAIL: +//')" \
  "$(q "select to_jsonb('$BASE'::timestamptz + interval '5 days') #>> '{}'")"
check "1e: exactly one won: the order holds A's day (+5)" "$(day_of "$O1")" "5"
check "1f: and its event moved to A's day with A's description" \
  "$(event_day "$E1"),$(q "select details from public.schedule_events where id = '$E1'")" "5,A details"
check "1g: the event's reminder stamps are cleared" \
  "$(q "select (reminded_24h_at is null and reminded_1h_at is null)::text from public.schedule_events where id = '$E1'")" "true"
check "1h: no 40001 or 40P01 in either session" \
  "$(cat "$TMP/real.A.out" "$TMP/real.B.out" | grep -cE '40001|40P01')" "0"

# ═══ 2. The mutation: no order-row lock ═══════════════════════════════════
echo "== 2. the same race against a copy with the order row's FOR UPDATE removed"
q "select pg_get_functiondef('public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)'::regprocedure)" > "$TMP/real.sql"
python3 - "$TMP/real.sql" "$TMP/nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
lock = "   where o.id = p_id\n     for update;"
assert d.count(lock) == 1, d.count(lock)
d = d.replace(lock, "   where o.id = p_id;").replace('public.revise_order_needed_by(', 'public._probe_revise_nolock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/nolock.sql" || bad "2: could not create the lock-less copy"
q "revoke all on function public._probe_revise_nolock(uuid, timestamptz, timestamptz, text, text) from public, anon; grant execute on function public._probe_revise_nolock(uuid, timestamptz, timestamptz, text, text) to authenticated" >/dev/null
race nolock _probe_revise_nolock "$O2" 5 6
check "2a: A answered changed" "$(has 'A={"status": "approved", "changed": true' "$TMP/nolock.A.out")" "1"
check "2b: B ALSO answered changed (it read the value before A committed)" \
  "$(has 'B={"status": "approved", "changed": true' "$TMP/nolock.B.out")" "1"
check "2c: A's change was lost without a word: the order holds B's day (+6)" "$(day_of "$O2")" "6"

# ═══ 3. cancel first, a revision meanwhile ════════════════════════════════
echo "== 3. cancel_order_request first, a revision meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/cancel.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || (public.cancel_order_request('$O3', 'Race proof')).status;
select pg_sleep(3);
commit;
SQL
) &
PID=$!
sleep 1
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/cancel.B.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR2';
select 'B=' || public.revise_order_needed_by('$O3', '$BASE'::timestamptz + interval '5 days',
                                             '$BASE'::timestamptz, 'Late', null)::text;
commit;
SQL
wait "$PID"
check "3a: the cancel went through" "$(grep -c '^A=cancelled' "$TMP/cancel.A.out")" "1"
check "3b: the revision waited, then was refused: order_closed (P0001), detail cancelled" \
  "$(has 'ERROR:  P0001: order_closed' "$TMP/cancel.B.out"),$(has 'DETAIL:  cancelled' "$TMP/cancel.B.out")" "1,1"
check "3c: the date stayed" "$(day_of "$O3")" "0"
check "3d: no 40001 or 40P01" "$(cat "$TMP/cancel.A.out" "$TMP/cancel.B.out" | grep -cE '40001|40P01')" "0"

drop_probes
cleanup || FAILS=$((FAILS + 1))
check "the probe copy is gone" \
  "$(q "select count(*) from pg_proc where proname like '\\_probe\\_revise%'")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
