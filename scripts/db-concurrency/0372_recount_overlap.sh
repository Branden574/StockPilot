#!/usr/bin/env bash
#
# Two-session proof for migration 0372 (F1-2, targeted recount). pgTAP runs in
# ONE session, so it cannot show what these properties are about: what happens
# while ANOTHER transaction is still starting a recount.
#
#   1. Two concurrent starts for one item make exactly ONE count. Session A
#      recounts an occurrence of item X and holds its transaction open;
#      session B asks for item X alone (no occurrence, so the org's sync lock
#      is not what serializes it: only the per-item advisory lock is). B waits
#      for A, then finds X in A's count and links to it instead of starting a
#      second one. Without the lock, B cannot see A's uncommitted count and
#      starts its own: two open counts of X.
#   2. A double tap with the SAME idempotency key: the second call waits on
#      the key (INSERT ... ON CONFLICT DO NOTHING) and answers with the first
#      call's count as a replay, never a unique-violation error.
#   3. A recount that names occurrences holds the org's exceptions_sync lock
#      until it commits, so a sync that starts meanwhile waits for it and then
#      applies normally (no crosswise row locks between the recount's links
#      and the sync's multi-row updates, and no resolve between the recount's
#      read and its link). The recount here names an occurrence it skips (a
#      label rule is not recountable), so it holds no occurrence row lock:
#      only the advisory lock can make the sync wait.
#   No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03721111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0372_recount_overlap.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORG='03721111-0000-0000-0000-00000000000a'
MGR='03721111-0000-0000-0000-0000000000a1'
MGR2='03721111-0000-0000-0000-0000000000a2'
WH='03721111-0000-0000-0000-0000000000b1'
X='03721111-0000-0000-0000-0000000000c1'
Y='03721111-0000-0000-0000-0000000000c2'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

as_user() { # as_user <uuid>: the session preamble for a signed-in API caller
  printf "set local role authenticated;\nselect set_config('request.jwt.claim.sub', '%s', true);\nselect set_config('request.jwt.claim.role', 'authenticated', true);\n" "$1"
}

cleanup() {
  # Lines and counts first (the organization cascade would otherwise SET NULL
  # a line's counted_location_id after its count row is gone, which the
  # line-update trigger refuses).
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.cycle_count_lines
 where cycle_count_id in (select id from public.cycle_counts where organization_id = '$ORG');
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0372-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0372-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0372 Two Session Org', '0372-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()), ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status)
  values ('$WH', '$ORG', '0372 2S Main', 'WH-0372-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$X', '$ORG', '$WH', '2S item X', 'SKU-0372-2S-X', 10, 'active'),
  ('$Y', '$ORG', '$WH', '2S item Y', 'SKU-0372-2S-Y', 10, 'active');
-- The occurrences (count_variance on X, label_mismatch on Y), raised the way
-- the system raises them.
set role service_role;
select public.exceptions_sync(
  '$ORG', now() - interval '10 minutes',
  array['count_variance', 'label_mismatch'], '{}', '{}',
  jsonb_build_array(
    jsonb_build_object('rule', 'count_variance', 'itemId', '$X', 'locationId', null, 'facts', '{}'::jsonb),
    jsonb_build_object('rule', 'label_mismatch', 'itemId', '$Y', 'locationId', null, 'facts', '{}'::jsonb)),
  '[]'::jsonb);
reset role;
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi
OCC="$(q "select id from public.exception_occurrences where organization_id = '$ORG' and item_id = '$X'")"
LBL="$(q "select id from public.exception_occurrences where organization_id = '$ORG' and item_id = '$Y'")"
if [ -z "$OCC" ] || [ -z "$LBL" ]; then echo "fixture occurrences missing"; cleanup; exit 1; fi

# ═══ 1. Two concurrent starts for one item ════════════════════════════════
echo "== 1. A recounts X's occurrence and holds its transaction; B asks for item X meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/startA.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
select 'A=' || public.start_targeted_recount('$ORG', array['$OCC']::uuid[], null, 'Recount: 2S item X', 'two-session-a')::text;
select pg_sleep(3);
commit;
SQL
) &
PID_A=$!
sleep 1

T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/startB.out" 2>&1 <<SQL
begin; $(as_user "$MGR2")
select 'B=' || public.start_targeted_recount('$ORG', null, array['$X']::uuid[], 'Recount: 2S item X', 'two-session-b')::text;
commit;
SQL
T1=$(now_ms)
wait "$PID_A"

RA="$(sed -n 's/^A=//p' "$TMP/startA.out")"
RB="$(sed -n 's/^B=//p' "$TMP/startB.out")"
CC_A="$(q "select ('$RA'::jsonb)->>'cycleCountId'")"
check "1a: A created a count" "$(q "select ('$RA'::jsonb)->>'created'")" "true"
# A holds its transaction ~3 s and B starts ~1 s in, so B waits ~2 s.
if [ $((T1 - T0)) -ge 1500 ]; then ok "1b: B waited for A ($((T1 - T0)) ms)"; else bad "1b: B did not wait ($((T1 - T0)) ms)"; fi
check "1c: B created no count" "$(q "select ('$RB'::jsonb)->>'created'")" "false"
check "1d: B reports X as already being counted in A's count" \
  "$(q "select ('$RB'::jsonb)#>>'{linkedExisting,0,cycleCountId}' = '$CC_A'")" "t"
check "1e: exactly one open count holds X" \
  "$(q "select count(*) from public.cycle_count_lines l join public.cycle_counts c on c.id = l.cycle_count_id where c.organization_id = '$ORG' and c.status = 'in_progress' and l.item_id = '$X'")" "1"
check "1f: the occurrence has one recount_linked event, to A's count" \
  "$(q "select count(*) || ':' || bool_and(cycle_count_id = '$CC_A') from public.exception_occurrence_events where occurrence_id = '$OCC' and kind = 'recount_linked'")" "1:true"

# ═══ 2. A double tap with the same idempotency key ════════════════════════
echo "== 2. two calls with the same key for item Y, the second while the first is open"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/tapA.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
select 'A=' || public.start_targeted_recount('$ORG', null, array['$Y']::uuid[], 'Recount: 2S item Y', 'two-session-same')::text;
select pg_sleep(3);
commit;
SQL
) &
PID_A=$!
sleep 1
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/tapB.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
select 'B=' || public.start_targeted_recount('$ORG', null, array['$Y']::uuid[], 'Recount: 2S item Y', 'two-session-same')::text;
commit;
SQL
wait "$PID_A"
TA="$(sed -n 's/^A=//p' "$TMP/tapA.out")"
TB="$(sed -n 's/^B=//p' "$TMP/tapB.out")"
check "2a: the second tap got an answer, not an error" "$(grep -c ERROR "$TMP/tapB.out")" "0"
check "2b: the second tap is a replay of the first tap's count" \
  "$(q "select (('$TB'::jsonb)->>'replay') || ':' || ((('$TB'::jsonb)->>'cycleCountId') = (('$TA'::jsonb)->>'cycleCountId'))")" "true:true"
check "2c: exactly one open count holds Y" \
  "$(q "select count(*) from public.cycle_count_lines l join public.cycle_counts c on c.id = l.cycle_count_id where c.organization_id = '$ORG' and c.status = 'in_progress' and l.item_id = '$Y'")" "1"

# ═══ 3. A recount naming occurrences holds the sync off ═══════════════════
echo "== 3. a recount naming an occurrence is open (3 s); a system sync starts meanwhile"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/holdA.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
select 'A=' || public.start_targeted_recount('$ORG', array['$LBL']::uuid[], null, null, 'two-session-sync')::text;
select pg_sleep(3);
commit;
SQL
) &
PID_A=$!
sleep 1
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/sync.out" 2>&1 <<SQL
begin;
set local role service_role;
select 'S=' || public.exceptions_sync(
  '$ORG', now(), array['count_variance', 'label_mismatch'], '{}', '{}',
  jsonb_build_array(
    jsonb_build_object('rule', 'count_variance', 'itemId', '$X', 'locationId', null, 'facts', '{}'::jsonb),
    jsonb_build_object('rule', 'label_mismatch', 'itemId', '$Y', 'locationId', null, 'facts', '{}'::jsonb)),
  '[]'::jsonb)::text;
commit;
SQL
T1=$(now_ms)
wait "$PID_A"
check "3a: the recount skipped the label occurrence (no link, so no row lock)" \
  "$(q "select ('$(sed -n 's/^A=//p' "$TMP/holdA.out")'::jsonb)#>>'{skipped,0,reason}'")" "not_recountable"
if [ $((T1 - T0)) -ge 1500 ]; then ok "3b: the sync waited for the recount ($((T1 - T0)) ms)"; else bad "3b: the sync did not wait ($((T1 - T0)) ms)"; fi
check "3c: then it applied (both seen again, nothing resolved)" \
  "$(q "select (('$(sed -n 's/^S=//p' "$TMP/sync.out")'::jsonb)->>'seen') || ':' || (('$(sed -n 's/^S=//p' "$TMP/sync.out")'::jsonb)->>'resolved')")" "2:0"

check "no session hit 40001 or 40P01" \
  "$(cat "$TMP"/startA.out "$TMP"/startB.out "$TMP"/tapA.out "$TMP"/tapB.out "$TMP"/holdA.out "$TMP"/sync.out | grep -cE '40001|40P01')" "0"

if [ "$FAILS" -gt 0 ]; then
  echo "--- session output ---"
  for f in startA startB tapA tapB holdA sync; do echo "[$f]"; cat "$TMP/$f.out" 2>/dev/null; done
fi

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left behind" \
  "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all two-session checks passed"
