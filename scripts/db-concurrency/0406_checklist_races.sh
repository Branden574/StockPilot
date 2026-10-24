#!/usr/bin/env bash
#
# Two-session proof for migration 0398 (receiving checklist, F4-1; the number
# is fixed at push time and nothing here depends on it). pgTAP runs in ONE
# session, so it cannot show what happens when two managers act on the same
# receipt, run or checklist at the same moment.
#
#   1. Two starts for one receipt. Session A starts (inserts the run) and
#      keeps its transaction open; session B starts meanwhile, finds no run
#      (A's is not committed), waits on the receipt's unique key, then reads
#      A's run: created false, the same run id. Exactly one run; no 23505.
#   2. The mutation the ON CONFLICT clause exists for (M6): the same race
#      against a throwaway copy of receiving_check_start with ON CONFLICT
#      taken out (public._probe_check_start_noconflict, dropped by the EXIT
#      trap however the script ends): B fails 23505 unique_violation.
#   3. Two saves on one revision. A saves (revision 0 -> 1) and holds; B saves
#      on revision 0 with its own save id, waits for the run's row lock, then
#      is refused with P0001 checklist_run_changed. The run holds A's answers
#      at revision 1.
#   4. Two publishes on one expected id. A publishes version 2 (expected v1)
#      and holds; B publishes with the same expected id and its own client
#      id, waits on the checklist's advisory lock, then is refused with P0001
#      checklist_changed. Exactly one live version, and no version 3.
#   5. The same client publish id twice at once (a double tap): B waits on
#      the advisory lock, then answers A's version (a replay). One version.
#   6. A start and a publish at once: the start's insert takes only KEY SHARE
#      on the live version, which the publish's FOR NO KEY UPDATE does not
#      block: neither waits for the other (no lock edge), and the run keeps
#      the version it started on.
#   No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0398 applied. Fixtures are committed under the 03981111-... namespace
# (a receipt row inserted directly by postgres: the receipt guard holds API
# roles only, and no stock moves) and removed at the start and the end. Exit
# status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0398_checklist_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
# shellcheck disable=SC2329 # called from the EXIT trap below
drop_probes() {
  "${PSQL[@]}" -c "drop function if exists public._probe_check_start_noconflict(uuid)" >/dev/null 2>&1
}
trap 'drop_probes; rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

ORG='03981111-0000-0000-0000-00000000000a'
MGR='03981111-0000-0000-0000-0000000000a1'
MGR2='03981111-0000-0000-0000-0000000000a2'
WH='03981111-0000-0000-0000-0000000000b1'
IT='03981111-0000-0000-0000-0000000000c1'
PO='03981111-0000-0000-0000-0000000000d1'
LN='03981111-0000-0000-0000-0000000000d2'
R1='03981111-0000-0000-0000-0000000000e1'
R2='03981111-0000-0000-0000-0000000000e2'
R3='03981111-0000-0000-0000-0000000000e3'
STEPS='[{"kind": "check", "label": "Packing slip matches this purchase order", "required": true}, {"kind": "count", "label": "Number of boxes received"}]'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
has() { grep -cF -- "$1" "$2"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_check_start_noconflict(uuid);
delete from public.checklist_runs where organization_id = '$ORG';
delete from public.checklist_versions where organization_id = '$ORG';
delete from public.receipts where organization_id = '$ORG';
delete from public.purchase_order_items where organization_id = '$ORG';
delete from public.purchase_orders where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
  local left
  left="$(q "select (select count(*) from public.receipts where organization_id = '$ORG') + (select count(*) from public.checklist_versions where organization_id = '$ORG') + (select count(*) from public.organizations where id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

HAS="$(q "select count(*) from pg_proc where proname in ('receiving_check_start', 'checklist_run_save', 'checklist_publish')")"
if [ "$HAS" != "3" ]; then echo "the receiving checklist migration is not applied on the local stack"; exit 1; fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0398-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0398-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0398 Two Session Org', '0398-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',  'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  ('$ORG', 'receiving', true, 'optional', '{}'::jsonb), ('$ORG', 'purchase_orders', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0398 2S Main', 'WH-0398-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values ('$IT', '$ORG', '$WH', 'X0398-2S', '2S item', 0, 'active', 'none');
insert into public.purchase_orders (id, organization_id, po_number, status) values ('$PO', '$ORG', 'X0398-2S-PO', 'partially_received');
insert into public.purchase_order_items (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values ('$LN', '$ORG', '$PO', '$IT', 10, 0, 1);
insert into public.receipts (id, organization_id, purchase_order_id, warehouse_id, receipt_number, status, received_by, immutable_hash) values
  ('$R1', '$ORG', '$PO', '$WH', 'R-0398-2S-1', 'posted', '$MGR', md5('r1')),
  ('$R2', '$ORG', '$PO', '$WH', 'R-0398-2S-2', 'posted', '$MGR', md5('r2')),
  ('$R3', '$ORG', '$PO', '$WH', 'R-0398-2S-3', 'posted', '$MGR', md5('r3'));
SQL
then echo "fixture setup failed"; cleanup; exit 1; fi

as_mgr() { # as_mgr <user> <statement>: one statement as that manager, its text answer
  "${PSQL[@]}" -v VERBOSITY=verbose 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$1';
select ($2)::text;
commit;
SQL
}
publish() { # publish <expected or null> <client id> <title>
  local e="null"
  [ "$1" != "null" ] && e="'$1'"
  printf "(select v.id from public.checklist_publish('%s', 'receiving', '%s', '%s'::jsonb, null, %s, '%s') v)" \
    "$ORG" "$3" "$STEPS" "$e" "$2"
}
start() { printf "public.receiving_check_start('%s')" "$1"; }
save() { # save <run> <revision> <save id> <results json>
  printf "(select v.revision || '/' || v.results::text from public.checklist_run_save('%s', '%s'::jsonb, null, %s, '%s', false) v)" \
    "$1" "$4" "$2" "$3"
}

# race <tag> <A's statement> <B's statement>: A (the first manager) runs its
# statement and holds its transaction 3 s; B (the second manager) runs its
# statement at 1 s. Each answer is printed as A=... / B=....
race() {
  local tag="$1" sa="$2" sb="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || ($sa)::text;
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
select 'B=' || ($sb)::text;
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
no_retryable() { # no_retryable <label> <files...>
  local label="$1"; shift
  check "$label: no 40001 or 40P01 in either session" "$(cat "$@" | grep -cE '40001|40P01')" "0"
}

V1="$(as_mgr "$MGR" "$(publish null 03981111-0000-0000-0000-000000000101 'Race v1')" | grep -E '^[0-9a-f-]{36}$')"
if [ -z "$V1" ]; then echo "could not publish version 1"; cleanup; exit 1; fi

# ═══ 1. Two starts for one receipt ═════════════════════════════════════════
echo "== 1. two managers start the checklist for one receipt at the same moment"
race starts "$(start "$R1")" "$(start "$R1")"
WAITED="$(cat "$TMP/starts.waited")"
A_RUN="$(sed -n 's/^A=//p' "$TMP/starts.A.out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])' 2>/dev/null)"
B_JSON="$(sed -n 's/^B=//p' "$TMP/starts.B.out")"
check "1a: A made the run" "$(sed -n 's/^A=//p' "$TMP/starts.A.out" | grep -c '"created": true')" "1"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's uncommitted run ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: B answered A's run, created false" "$B_JSON" "{\"runId\": \"$A_RUN\", \"created\": false, \"versionNumber\": 1}"
check "1d: exactly one run for the receipt" "$(q "select count(*) from public.checklist_runs where receipt_id = '$R1'")" "1"
check "1e: no unique violation reached either session" "$(cat "$TMP/starts.A.out" "$TMP/starts.B.out" | grep -c '23505')" "0"
no_retryable "1f" "$TMP/starts.A.out" "$TMP/starts.B.out"

# ═══ 2. The mutation: no ON CONFLICT ════════════════════════════════════════
echo "== 2. the same race against a copy with ON CONFLICT removed"
q "select pg_get_functiondef('public.receiving_check_start(uuid)'::regprocedure)" > "$TMP/real.sql"
if ! python3 - "$TMP/real.sql" "$TMP/noconflict.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
clause = "  on conflict (receipt_id) do nothing\n"
assert d.count(clause) == 1, d.count(clause)
d = d.replace(clause, "")
d = d.replace('public.receiving_check_start(', 'public._probe_check_start_noconflict(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
then
  bad "2: could not build the probe copy"
else
  "${PSQL[@]}" < "$TMP/noconflict.sql" >/dev/null && \
    q "revoke all on function public._probe_check_start_noconflict(uuid) from public, anon; grant execute on function public._probe_check_start_noconflict(uuid) to authenticated;" >/dev/null
  race noconflict "public._probe_check_start_noconflict('$R2')" "public._probe_check_start_noconflict('$R2')"
  check "2a: without ON CONFLICT, B fails with a unique violation (23505)" "$(has 'ERROR:  23505' "$TMP/noconflict.B.out")" "1"
  check "2b: the probe still made one run (A's)" "$(q "select count(*) from public.checklist_runs where receipt_id = '$R2'")" "1"
  drop_probes
fi

# ═══ 3. Two saves on one revision ═══════════════════════════════════════════
echo "== 3. two managers save the same run on the same revision"
race saves "$(save "$A_RUN" 0 03981111-0000-0000-0000-000000000201 '{"s1": {"value": "pass"}}')" \
           "$(save "$A_RUN" 0 03981111-0000-0000-0000-000000000202 '{"s1": {"value": "fail", "note": "late"}}')"
WAITED="$(cat "$TMP/saves.waited")"
check "3a: A saved revision 1" "$(sed -n 's/^A=//p' "$TMP/saves.A.out")" '1/{"s1": {"value": "pass"}}'
if [ "$WAITED" -ge 1500 ]; then ok "3b: B waited for the run's row lock ($WAITED ms)"; else bad "3b: B did not wait ($WAITED ms)"; fi
check "3c: B was refused: checklist_run_changed (P0001)" "$(has 'ERROR:  P0001: checklist_run_changed' "$TMP/saves.B.out")" "1"
check "3d: the run holds A's answers at revision 1" \
  "$(q "select revision || '/' || results::text from public.checklist_runs where id = '$A_RUN'")" '1/{"s1": {"value": "pass"}}'
no_retryable "3e" "$TMP/saves.A.out" "$TMP/saves.B.out"

# ═══ 4. Two publishes on one expected id ═══════════════════════════════════
echo "== 4. two managers publish over the same live version"
race publishes "$(publish "$V1" 03981111-0000-0000-0000-000000000102 'Race v2 by A')" \
               "$(publish "$V1" 03981111-0000-0000-0000-000000000103 'Race v2 by B')"
WAITED="$(cat "$TMP/publishes.waited")"
V2="$(sed -n 's/^A=//p' "$TMP/publishes.A.out")"
if [ "$WAITED" -ge 1500 ]; then ok "4a: B waited for the checklist lock ($WAITED ms)"; else bad "4a: B did not wait ($WAITED ms)"; fi
check "4b: B was refused: checklist_changed (P0001)" "$(has 'ERROR:  P0001: checklist_changed' "$TMP/publishes.B.out")" "1"
check "4c: one live version, A's, and no version 3" \
  "$(q "select count(*) filter (where retired_at is null) || '/' || max(version_number) || '/' || (select title from public.checklist_versions where organization_id = '$ORG' and retired_at is null) from public.checklist_versions where organization_id = '$ORG'")" \
  "1/2/Race v2 by A"
no_retryable "4d" "$TMP/publishes.A.out" "$TMP/publishes.B.out"

# ═══ 5. The same client id twice at once ═══════════════════════════════════
echo "== 5. a double tap: the same client publish id twice"
race doubletap "$(publish "$V2" 03981111-0000-0000-0000-000000000104 'Race v3')" \
               "$(publish "$V2" 03981111-0000-0000-0000-000000000104 'Race v3')"
A_V3="$(sed -n 's/^A=//p' "$TMP/doubletap.A.out")"
check "5a: B answered A's version (a replay)" "$(sed -n 's/^B=//p' "$TMP/doubletap.B.out")" "$A_V3"
check "5b: exactly one version 3" \
  "$(q "select count(*) from public.checklist_versions where organization_id = '$ORG' and version_number = 3")" "1"
no_retryable "5c" "$TMP/doubletap.A.out" "$TMP/doubletap.B.out"

# ═══ 6. A start and a publish at once ═════════════════════════════════════
echo "== 6. a start racing a publish: neither waits"
race startpub "$(start "$R3")" "$(publish "$A_V3" 03981111-0000-0000-0000-000000000105 'Race v4')"
WAITED="$(cat "$TMP/startpub.waited")"
if [ "$WAITED" -lt 1000 ]; then ok "6a: the publish did not wait for the start ($WAITED ms)"; else bad "6a: the publish waited $WAITED ms"; fi
check "6b: the start made its run on version 3, the live one when it read" \
  "$(q "select v.version_number from public.checklist_runs r join public.checklist_versions v on v.id = r.version_id where r.receipt_id = '$R3'")" "3"
check "6c: the publish made version 4" "$(has 'B=' "$TMP/startpub.B.out")" "1"
no_retryable "6d" "$TMP/startpub.A.out" "$TMP/startpub.B.out"

cleanup || FAILS=$((FAILS + 1))
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
