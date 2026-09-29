#!/usr/bin/env bash
#
# Two-session proof for migration 0375 (F1-4, photo evidence): the cap of 8
# live photos per occurrence holds when two photos are recorded at once.
# pgTAP runs in ONE session, so it cannot show this.
#
#   1. Seven photos are on an occurrence. Session A records the 8th and holds
#      its transaction open; session B records a 9th meanwhile. B waits on
#      A's lock on the occurrence row, then counts A's photo and is refused
#      (P0001, hint evidence_limit_reached). Exactly 8 live photos remain.
#   2. The same race against a COPY of the record function with the row lock
#      taken out (a throwaway public._probe_evidence_record_nolock, dropped at
#      the end): B no longer waits, counts 7 because A has not committed, and
#      both insert: 9 live photos. This is the mutation the lock exists for.
#   No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03751111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0375_evidence_cap.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
# The race sections create throwaway SECURITY DEFINER copies of real functions
# with a lock taken out, some executable by authenticated. The EXIT trap drops
# them however the script ends (a failure, Ctrl-C, SIGTERM, a harness timeout;
# bash runs it on INT, TERM and HUP), so an interrupted run never leaves one on
# the shared local stack. SIGKILL cannot be trapped: the next run's cleanup
# drops them first.
# shellcheck disable=SC2329 # called from the EXIT trap below
drop_probes() {
  "${PSQL[@]}" -c "drop function if exists public._probe_evidence_record_nolock(uuid, uuid, text, text, text, bigint, timestamptz, text)" >/dev/null 2>&1
}
trap 'drop_probes; rm -rf "$TMP"' EXIT

ORG='03751111-0000-0000-0000-00000000000a'
STF='03751111-0000-0000-0000-0000000000a1'
WH='03751111-0000-0000-0000-0000000000b1'
ITEM='03751111-0000-0000-0000-0000000000c1'
ITEM2='03751111-0000-0000-0000-0000000000c2'
OCC='03751111-0000-0000-0000-0000000000d1'
OCC2='03751111-0000-0000-0000-0000000000d2'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

# {org}/{occurrence}/{uuid}.jpg with the uuid made from n (hex).
path() { printf '%s/%s/%08x-0000-4000-8000-%012x.jpg' "$ORG" "$1" "$2" "$2"; }
thumb() { printf '%s/%s/%08x-0000-4000-8000-%012x-thumb.webp' "$ORG" "$1" "$2" "$2"; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_evidence_record_nolock(uuid, uuid, text, text, text, bigint, timestamptz, text);
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$STF';
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$STF', '0375-2s-stf@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0375 Two Session Org', '0375-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$STF', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0375 2S Main', 'WH-0375-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values ('$ORG', '$STF', '$WH', true);
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM',  '$ORG', '$WH', '2S item',  'SKU-0375-2S',  0, 'active'),
  ('$ITEM2', '$ORG', '$WH', '2S item 2', 'SKU-0375-2S2', 0, 'active');
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id, first_seen_at, last_seen_at) values
  ('$OCC',  '$ORG', 1, 'label_mismatch', '$ITEM',  null, '$WH', now(), now()),
  ('$OCC2', '$ORG', 2, 'label_mismatch', '$ITEM2', null, '$WH', now(), now());
set role service_role;
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 1)',  '$(thumb "$OCC" 1)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 2)',  '$(thumb "$OCC" 2)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 3)',  '$(thumb "$OCC" 3)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 4)',  '$(thumb "$OCC" 4)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 5)',  '$(thumb "$OCC" 5)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 6)',  '$(thumb "$OCC" 6)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC',  '$STF', '$(path "$OCC" 7)',  '$(thumb "$OCC" 7)',  'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 1)', '$(thumb "$OCC2" 1)', 'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 2)', '$(thumb "$OCC2" 2)', 'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 3)', '$(thumb "$OCC2" 3)', 'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 4)', '$(thumb "$OCC2" 4)', 'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 5)', '$(thumb "$OCC2" 5)', 'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 6)', '$(thumb "$OCC2" 6)', 'image/jpeg', 1000);
select public.exception_evidence_record('$OCC2', '$STF', '$(path "$OCC2" 7)', '$(thumb "$OCC2" 7)', 'image/jpeg', 1000);
reset role;
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi
check "setup: seven live photos on each occurrence" \
  "$(q "select string_agg(n::text, ',' order by occurrence_id) from (select occurrence_id, count(*) n from public.exception_evidence where organization_id = '$ORG' and removed_at is null group by 1) s")" "7,7"

# race <fn> <occurrence> <tag>: A records #8 and holds 3 s; B records #9 at 1 s.
race() {
  local fn="$1" occ="$2" tag="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin; set local role service_role;
select 'A=' || (public.$fn('$occ', '$STF', '$(path "$occ" 8)', '$(thumb "$occ" 8)', 'image/jpeg', 1000)).id;
select pg_sleep(3);
commit;
SQL
  ) &
  local pid=$!
  sleep 1
  local t0; t0=$(now_ms)
  "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B.out" 2>&1 <<SQL
begin; set local role service_role;
select 'B=' || (public.$fn('$occ', '$STF', '$(path "$occ" 9)', '$(thumb "$occ" 9)', 'image/jpeg', 1000)).id;
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# ═══ 1. The real function ═════════════════════════════════════════════════
echo "== 1. A records the 8th photo and holds its transaction; B records a 9th meanwhile"
race exception_evidence_record "$OCC" real
WAITED="$(cat "$TMP/real.waited")"
check "1a: A recorded the 8th photo" "$(grep -c '^A=' "$TMP/real.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's lock ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: B was refused with evidence_limit_reached" \
  "$(grep -cE 'P0001: evidence_limit_reached' "$TMP/real.B.out")" "1"
check "1d: exactly 8 live photos remain" \
  "$(q "select count(*) from public.exception_evidence where occurrence_id = '$OCC' and removed_at is null")" "8"
check "1e: and exactly 8 evidence_added events" \
  "$(q "select count(*) from public.exception_occurrence_events where occurrence_id = '$OCC' and kind = 'evidence_added'")" "8"

# ═══ 2. The mutation: the same function without the row lock ═════════════
echo "== 2. the same race against a copy with the FOR UPDATE removed"
q "select pg_get_functiondef('public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)'::regprocedure)" > "$TMP/real.sql"
python3 - "$TMP/real.sql" "$TMP/nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
assert d.count(' for update;') == 1, d.count(' for update;')
d = d.replace(' for update;', ';').replace('public.exception_evidence_record(', 'public._probe_evidence_record_nolock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/nolock.sql" || { bad "2: could not create the lock-less copy"; }
q "grant execute on function public._probe_evidence_record_nolock(uuid, uuid, text, text, text, bigint, timestamptz, text) to service_role" >/dev/null
race _probe_evidence_record_nolock "$OCC2" nolock
WAITED="$(cat "$TMP/nolock.waited")"
if [ "$WAITED" -lt 1500 ]; then ok "2a: without the lock B did not wait ($WAITED ms)"; else bad "2a: B still waited ($WAITED ms)"; fi
check "2b: both sessions recorded a photo" \
  "$(( $(grep -c '^A=' "$TMP/nolock.A.out") + $(grep -c '^B=' "$TMP/nolock.B.out") ))" "2"
check "2c: the cap is broken: 9 live photos (this is what the lock prevents)" \
  "$(q "select count(*) from public.exception_evidence where occurrence_id = '$OCC2' and removed_at is null")" "9"

check "no session hit 40001 or 40P01" \
  "$(cat "$TMP"/real.A.out "$TMP"/real.B.out "$TMP"/nolock.A.out "$TMP"/nolock.B.out | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: the lock-less copy is gone" \
  "$(q "select count(*) from pg_proc where proname = '_probe_evidence_record_nolock'")" "0"

if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed"
  exit 1
fi
echo "all checks passed"
