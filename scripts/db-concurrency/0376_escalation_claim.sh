#!/usr/bin/env bash
#
# Two-session proof for migration 0376 (F1-5, escalate to maintenance): two
# people pressing "Escalate to maintenance" on the same exception at the same
# moment start exactly ONE escalation. pgTAP runs in ONE session, so it
# cannot show this.
#
#   1. Session A claims the occurrence and holds its transaction open;
#      session B claims it meanwhile. B waits on A's row lock, then sees A's
#      claim and is refused (P0001, hint escalation_in_progress). Exactly one
#      claim stands, and it is A's.
#   2. The same race against a COPY of the claim function with the row lock
#      taken out (a throwaway public._probe_escalation_claim_nolock, dropped
#      at the end): B reads the row before A commits, sees no claim, and both
#      sessions are told "claimed" (B's claim silently replaces A's), so both
#      would go on to create a maintenance request. This is the mutation the
#      lock exists for.
#   3. Two finishes race to link ONE request to two occurrences of the same
#      item (the caller holds both claims): each locks only its own row, so
#      nothing but the UNIQUE index can see the other's link. A links and
#      holds its transaction open; B waits on the index, then is refused
#      (P0001, hint request_not_eligible) once A commits. Exactly one
#      occurrence links the request.
#   4. The same race with the index made plain (non-unique, restored at the
#      end): both finishes link the one request. This is what the unique
#      index prevents.
#   5. One person claims two occurrences at the same moment: A claims and
#      holds its transaction open; B (the same person) claims another
#      occurrence meanwhile. B waits on the per-caller lock, then sees A's
#      live claim and is refused (P0001, hint
#      escalation_in_progress_elsewhere).
#   6. The same race against a COPY of the claim with the per-caller lock
#      taken out (public._probe_escalation_claim_nouserlock, dropped at the
#      end): neither sees the other's uncommitted claim and both are told
#      "claimed", so parallel calls would slip past the one-live-claim rule.
#   No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03761111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0376_escalation_claim.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORG='03761111-0000-0000-0000-00000000000a'
STA='03761111-0000-0000-0000-0000000000a1'
STB='03761111-0000-0000-0000-0000000000a2'
WH='03761111-0000-0000-0000-0000000000b1'
ITEM='03761111-0000-0000-0000-0000000000c1'
ITEM2='03761111-0000-0000-0000-0000000000c2'
ITEM3='03761111-0000-0000-0000-0000000000c3'
ITEM4='03761111-0000-0000-0000-0000000000c4'
OCC='03761111-0000-0000-0000-0000000000d1'
OCC2='03761111-0000-0000-0000-0000000000d2'
OCC3='03761111-0000-0000-0000-0000000000d3'
OCC4='03761111-0000-0000-0000-0000000000d4'
OCC5='03761111-0000-0000-0000-0000000000d5'
OCC6='03761111-0000-0000-0000-0000000000d6'
OCC7='03761111-0000-0000-0000-0000000000d7'
OCC8='03761111-0000-0000-0000-0000000000d8'
OCC9='03761111-0000-0000-0000-0000000000d9'
OCC10='03761111-0000-0000-0000-0000000000da'
REQ='03761111-0000-0000-0000-0000000000e1'
REQ2='03761111-0000-0000-0000-0000000000e2'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

# Every claim in the fixture org cleared, so each section starts with none
# (one person holds at most one live claim: a leftover would refuse the next).
clear_claims() {
  q "update public.exception_occurrences set escalation_claimed_by = null, escalation_claimed_at = null where organization_id = '$ORG'" >/dev/null
}
# Claims for A (STA) on the given occurrences, as the owner (as if two
# escalations of one item were under way).
claim_for_a() {
  local ids="$1"
  q "update public.exception_occurrences set escalation_claimed_by = '$STA', escalation_claimed_at = now() where id in ($ids)" >/dev/null
}


cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_escalation_claim_nolock(uuid);
drop function if exists public._probe_escalation_claim_nouserlock(uuid);
delete from public.exception_occurrence_events where organization_id = '$ORG';
delete from public.exception_occurrences where organization_id = '$ORG';
delete from public.maintenance_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$STA', '$STB');
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$STA', '0376-2s-a@test.local', '{}'::jsonb),
  ('$STB', '0376-2s-b@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0376 Two Session Org', '0376-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$STA', 'staff', now()),
  ('$ORG', '$STB', 'staff', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  ('$ORG', 'maintenance_requests', true, 'optional')
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0376 2S Main', 'WH-0376-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  ('$ORG', '$STA', '$WH', true),
  ('$ORG', '$STB', '$WH', true);
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM',  '$ORG', '$WH', '2S item',   'SKU-0376-2S',  0, 'active'),
  ('$ITEM2', '$ORG', '$WH', '2S item 2', 'SKU-0376-2S2', 0, 'active'),
  ('$ITEM3', '$ORG', '$WH', '2S item 3', 'SKU-0376-2S3', 0, 'active'),
  ('$ITEM4', '$ORG', '$WH', '2S item 4', 'SKU-0376-2S4', 0, 'active');
-- OCC3/OCC4 and OCC7/OCC8: two rules on one item, for the racing finishes
-- (claimed by A just before each race). OCC5/OCC6 and OCC9/OCC10: two open
-- occurrences for one person's parallel claims.
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id, first_seen_at, last_seen_at) values
  ('$OCC',   '$ORG', 1,  'label_mismatch', '$ITEM',  null, '$WH', now(), now()),
  ('$OCC2',  '$ORG', 2,  'label_mismatch', '$ITEM2', null, '$WH', now(), now()),
  ('$OCC3',  '$ORG', 3,  'label_mismatch', '$ITEM3', null, '$WH', now(), now()),
  ('$OCC4',  '$ORG', 4,  'over_reserved',  '$ITEM3', null, '$WH', now(), now()),
  ('$OCC5',  '$ORG', 5,  'over_reserved',  '$ITEM',  null, '$WH', now(), now()),
  ('$OCC6',  '$ORG', 6,  'over_reserved',  '$ITEM2', null, '$WH', now(), now()),
  ('$OCC7',  '$ORG', 7,  'label_mismatch', '$ITEM4', null, '$WH', now(), now()),
  ('$OCC8',  '$ORG', 8,  'over_reserved',  '$ITEM4', null, '$WH', now(), now()),
  ('$OCC9',  '$ORG', 9,  'count_variance',  '$ITEM',  null, '$WH', now(), now()),
  ('$OCC10', '$ORG', 10, 'count_variance',  '$ITEM2', null, '$WH', now(), now());
-- A's own fresh requests (as the owner; the 0362 guard is for API roles).
insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description, related_item_id, status) values
  ('$REQ',  '$ORG', '$STA', 'A', 'Inventory issue', 'Two rules, one request', '$ITEM3', 'saved'),
  ('$REQ2', '$ORG', '$STA', 'A', 'Inventory issue', 'Two rules, one request', '$ITEM4', 'saved');
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# race <fn> <occurrence> <tag>: A claims and holds 3 s; B claims at 1 s.
race() {
  local fn="$1" occ="$2" tag="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$STA';
select 'A=' || ((public.$fn('$occ'))->>'state');
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
set local "request.jwt.claim.sub" to '$STB';
select 'B=' || ((public.$fn('$occ'))->>'state');
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# ═══ 1. The real function ═════════════════════════════════════════════════
echo "== 1. A claims and holds its transaction; B claims the same occurrence meanwhile"
race exception_escalation_claim "$OCC" real
WAITED="$(cat "$TMP/real.waited")"
check "1a: A claimed" "$(grep -c '^A=claimed' "$TMP/real.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's lock ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: B was refused with escalation_in_progress" \
  "$(grep -cE 'P0001: escalation_in_progress' "$TMP/real.B.out")" "1"
check "1d: the one claim that stands is A's" \
  "$(q "select escalation_claimed_by from public.exception_occurrences where id = '$OCC'")" "$STA"

# ═══ 2. The mutation: the same function without the row lock ═════════════
echo "== 2. the same race against a copy with the FOR UPDATE removed"
q "select pg_get_functiondef('public.exception_escalation_claim(uuid)'::regprocedure)" > "$TMP/real.sql"
python3 - "$TMP/real.sql" "$TMP/nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
assert d.count('\n   for update;') == 1, d.count('\n   for update;')
d = d.replace('\n   for update;', ';').replace('public.exception_escalation_claim(', 'public._probe_escalation_claim_nolock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/nolock.sql" || { bad "2: could not create the lock-less copy"; }
q "revoke all on function public._probe_escalation_claim_nolock(uuid) from public, anon; grant execute on function public._probe_escalation_claim_nolock(uuid) to authenticated" >/dev/null
clear_claims
race _probe_escalation_claim_nolock "$OCC2" nolock
WAITED="$(cat "$TMP/nolock.waited")"
check "2a: A was told claimed" "$(grep -c '^A=claimed' "$TMP/nolock.A.out")" "1"
check "2b: B was ALSO told claimed (two escalations would start: this is what the lock prevents)" \
  "$(grep -c '^B=claimed' "$TMP/nolock.B.out")" "1"
check "2c: and B's claim silently replaced A's" \
  "$(q "select escalation_claimed_by from public.exception_occurrences where id = '$OCC2'")" "$STB"

# fin_race <occA> <occB> <request> <tag>: A (as STA) links and holds 3 s;
# B (as STA too, who holds both claims) links the same request at 1 s.
fin_race() {
  local occa="$1" occb="$2" req="$3" tag="$4"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$STA';
select 'A=' || ((public.exception_escalation_finish('$occa', '$req'))->>'state');
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
set local "request.jwt.claim.sub" to '$STA';
select 'B=' || ((public.exception_escalation_finish('$occb', '$req'))->>'state');
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# same_caller_race <fn> <occA> <occB> <tag>: STA claims occA and holds 3 s;
# STA claims occB at 1 s.
same_caller_race() {
  local fn="$1" occa="$2" occb="$3" tag="$4"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$STA';
select 'A=' || ((public.$fn('$occa'))->>'state');
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
set local "request.jwt.claim.sub" to '$STA';
select 'B=' || ((public.$fn('$occb'))->>'state');
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

UNIQ_SQL="create unique index exc_occ_maintenance_request_uniq on public.exception_occurrences (maintenance_request_id) where maintenance_request_id is not null"
PLAIN_SQL="create index exc_occ_maintenance_request_uniq on public.exception_occurrences (maintenance_request_id) where maintenance_request_id is not null"

# ═══ 3. Two finishes race to link one request ═════════════════════════════
echo "== 3. two finishes link ONE request to two occurrences of the same item at the same moment"
clear_claims
claim_for_a "'$OCC3', '$OCC4'"
fin_race "$OCC3" "$OCC4" "$REQ" uniq
WAITED="$(cat "$TMP/uniq.waited")"
check "3a: A linked" "$(grep -c '^A=linked' "$TMP/uniq.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "3b: B waited on the unique index ($WAITED ms)"; else bad "3b: B did not wait ($WAITED ms)"; fi
check "3c: B was refused with request_not_eligible" \
  "$(grep -cE 'P0001: request_not_eligible' "$TMP/uniq.B.out")" "1"
check "3d: exactly one occurrence links the request, and it is A's" \
  "$(q "select string_agg(id::text, ',') from public.exception_occurrences where maintenance_request_id = '$REQ'")" "$OCC3"
check "3e: exactly one escalated event names the request" \
  "$(q "select count(*) from public.exception_occurrence_events where maintenance_request_id = '$REQ'")" "1"

# ═══ 4. The mutation: a plain (non-unique) index ══════════════════════════
echo "== 4. the same race with the link index made plain (restored right after)"
clear_claims
claim_for_a "'$OCC7', '$OCC8'"
q "drop index public.exc_occ_maintenance_request_uniq; $PLAIN_SQL" >/dev/null
fin_race "$OCC7" "$OCC8" "$REQ2" plain
q "delete from public.exception_occurrence_events where maintenance_request_id = '$REQ2'; update public.exception_occurrences set maintenance_request_id = null, escalation_number = null, escalation_request_created_at = null, escalated_at = null, escalated_by = null where maintenance_request_id = '$REQ2'" >/dev/null
q "drop index public.exc_occ_maintenance_request_uniq; $UNIQ_SQL" >/dev/null
check "4a: A was told linked" "$(grep -c '^A=linked' "$TMP/plain.A.out")" "1"
check "4b: B was ALSO told linked (one request on two occurrences: this is what the unique index prevents)" \
  "$(grep -c '^B=linked' "$TMP/plain.B.out")" "1"
check "4c: the unique index is back" \
  "$(q "select indisunique from pg_index where indexrelid = 'public.exc_occ_maintenance_request_uniq'::regclass")" "t"

# ═══ 5. One person, two claims at once ════════════════════════════════════
echo "== 5. one person claims two occurrences at the same moment"
clear_claims
same_caller_race exception_escalation_claim "$OCC5" "$OCC6" userlock
WAITED="$(cat "$TMP/userlock.waited")"
check "5a: A claimed" "$(grep -c '^A=claimed' "$TMP/userlock.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "5b: B waited on the per-caller lock ($WAITED ms)"; else bad "5b: B did not wait ($WAITED ms)"; fi
check "5c: B was refused with escalation_in_progress_elsewhere" \
  "$(grep -cE 'P0001: escalation_in_progress_elsewhere' "$TMP/userlock.B.out")" "1"
check "5d: the person holds one claim of the two" \
  "$(q "select count(*) from public.exception_occurrences where id in ('$OCC5', '$OCC6') and escalation_claimed_by = '$STA'")" "1"

# ═══ 6. The mutation: the claim without the per-caller lock ═══════════════
echo "== 6. the same race against a copy with the per-caller lock removed"
q "select pg_get_functiondef('public.exception_escalation_claim(uuid)'::regprocedure)" > "$TMP/real2.sql"
python3 - "$TMP/real2.sql" "$TMP/nouserlock.sql" <<'PYCOPY'
import sys
d = open(sys.argv[1]).read()
lock = "\n  perform pg_advisory_xact_lock(hashtextextended('exc_escalation_claim:' || v_uid::text, 0));"
assert d.count(lock) == 1, d.count(lock)
d = d.replace(lock, '', 1).replace('public.exception_escalation_claim(', 'public._probe_escalation_claim_nouserlock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PYCOPY
"${PSQL[@]}" >/dev/null < "$TMP/nouserlock.sql" || { bad "6: could not create the copy without the per-caller lock"; }
q "revoke all on function public._probe_escalation_claim_nouserlock(uuid) from public, anon; grant execute on function public._probe_escalation_claim_nouserlock(uuid) to authenticated" >/dev/null
clear_claims
same_caller_race _probe_escalation_claim_nouserlock "$OCC9" "$OCC10" nouserlock
check "6a: A was told claimed" "$(grep -c '^A=claimed' "$TMP/nouserlock.A.out")" "1"
check "6b: B was ALSO told claimed (two live claims for one person: this is what the lock prevents)" \
  "$(grep -c '^B=claimed' "$TMP/nouserlock.B.out")" "1"

check "no session saw 40001 or 40P01" \
  "$(cat "$TMP"/*.out | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left" "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"

if [ "$FAILS" -eq 0 ]; then echo "PASS: all checks"; exit 0; else echo "FAILED: $FAILS check(s)"; exit 1; fi
