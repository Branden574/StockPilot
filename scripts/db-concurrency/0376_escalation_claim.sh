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
OCC='03761111-0000-0000-0000-0000000000d1'
OCC2='03761111-0000-0000-0000-0000000000d2'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_escalation_claim_nolock(uuid);
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
  ('$ITEM2', '$ORG', '$WH', '2S item 2', 'SKU-0376-2S2', 0, 'active');
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id, first_seen_at, last_seen_at) values
  ('$OCC',  '$ORG', 1, 'label_mismatch', '$ITEM',  null, '$WH', now(), now()),
  ('$OCC2', '$ORG', 2, 'label_mismatch', '$ITEM2', null, '$WH', now(), now());
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
race _probe_escalation_claim_nolock "$OCC2" nolock
WAITED="$(cat "$TMP/nolock.waited")"
check "2a: A was told claimed" "$(grep -c '^A=claimed' "$TMP/nolock.A.out")" "1"
check "2b: B was ALSO told claimed (two escalations would start: this is what the lock prevents)" \
  "$(grep -c '^B=claimed' "$TMP/nolock.B.out")" "1"
check "2c: and B's claim silently replaced A's" \
  "$(q "select escalation_claimed_by from public.exception_occurrences where id = '$OCC2'")" "$STB"

check "no session saw 40001 or 40P01" \
  "$(cat "$TMP"/*.out | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left" "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"

if [ "$FAILS" -eq 0 ]; then echo "PASS: all checks"; exit 0; else echo "FAILED: $FAILS check(s)"; exit 1; fi
