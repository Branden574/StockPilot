#!/usr/bin/env bash
#
# Two-session proof for migration 0404 (bundle component checks): a kit is
# never built from nothing, even when a save that makes every component
# Optional commits while the kit call is running. pgTAP runs in ONE session,
# so it cannot show what assemble_bundle and distribute_bundle do while
# another session commits between their statements.
#
# 0404 counts the required components inside the component loop, in the same
# statement that draws them, and refuses after the loop when it met none
# (bundle_no_required_components). So the count is always of the set the call
# actually drew from, whatever another session commits around it:
#
#   1. A distribution waits for its bundle row (another call holds it) while
#      a manager's save marks every component of the kit Optional and
#      commits. When the distribution goes on, every statement after the
#      bundle row reads the saved set: the distribution is refused
#      bundle_no_required_components, the optional part it drew is put back,
#      and no distribution is recorded. Before 0404 it went out made of the
#      optional part only.
#   2. The same for an assembly: refused, nothing drawn, no kit item created
#      and the bundle still links none.
#   3. The save commits while the distribution is already INSIDE its loop
#      (waiting for the required part's row, which another call holds). The
#      loop reads the set it started with, so the kit goes out WITH its
#      required part (drawn, counted, one distribution), never counted from
#      one set and drawn from another. The next distribution reads the saved
#      set and is refused.
#   4. No session ever sees 40001 or 40P01, and every save answered at once
#      (a component save never waits for a running kit call).
#
# Runs against a LOCAL stack only (docker container supabase_db_stockpilot by
# default; CONTAINER=<name> for another local stack) with 0404 applied.
# Fixtures are committed under the 04044444-... namespace and removed at the
# start, at the end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0404_kit_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04044444-0000-0000-0000-00000000000a'
MGR='04044444-0000-0000-0000-0000000000a1'
MGR2='04044444-0000-0000-0000-0000000000a2'
WH='04044444-0000-0000-0000-0000000000b1'
R1='04044444-0000-0000-0000-000000000101'; O1='04044444-0000-0000-0000-000000000102'
R2='04044444-0000-0000-0000-000000000201'; O2='04044444-0000-0000-0000-000000000202'
R3='04044444-0000-0000-0000-000000000301'; O3='04044444-0000-0000-0000-000000000302'
K1='04044444-0000-0000-0000-0000000001b1'
K2='04044444-0000-0000-0000-0000000002b1'
K3='04044444-0000-0000-0000-0000000003b1'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

wait_for() { # wait_for <application_name> <wait_event_type> [wait_event]
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
delete from public.bundle_distributions where organization_id = '$ORG';
delete from public.bundle_components where bundle_id in ('$K1', '$K2', '$K3');
delete from public.bundles where organization_id = '$ORG';
delete from public.stock_movements where organization_id = '$ORG';
delete from public.item_stock_levels where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.audit_logs where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.bundles where organization_id = '$ORG') + (select count(*) from public.bundle_distributions where organization_id = '$ORG')")"
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

if [ "$(q "select count(*) from pg_trigger where tgname = 'trg_zz_bundle_distributions_guard'")" != "1" ]; then
  echo "0404 is not applied on this stack"; exit 1
fi
cleanup || exit 1
T_START=$(now_ms)

# as_user <application_name> <user> <statements>: one transaction as that
# member (authenticated, with claims), committed.
as_user() {
  printf '%s\n' \
    "set application_name to '$1';" \
    "begin;" \
    "set local role authenticated;" \
    "set local \"request.jwt.claim.role\" to 'authenticated';" \
    "set local \"request.jwt.claim.sub\" to '$2';" \
    "$3" \
    "commit;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
# hold <application_name> <statement> <seconds>: another call holding a row
# (as the owner, the shape of a running ledger call's row lock).
hold() {
  printf '%s\n' "set application_name to '$1';" "begin;" "$2" "select pg_sleep($3);" "commit;" \
    | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
qty() { q "select quantity_on_hand::int from public.inventory_items where id = '$1'"; }
moves() { q "select count(*) from public.stock_movements where item_id in ('$1', '$2')"; }
dists() { q "select count(*) || '/' || coalesce(bool_or(shortage_recorded)::text, '-') from public.bundle_distributions where bundle_id = '$1'"; }
refused() { # refused <tag> <sqlstate> <message>: 1/1 when that output carries both
  local a=0 b=0
  grep -q "ERROR:  $2" "$TMP/$1.out" && a=1
  grep -q "$3" "$TMP/$1.out" && b=1
  printf '%s/%s' "$a" "$b"
}
optional_only() { q "select bool_and(is_optional)::text || '/' || count(*) from public.bundle_components where bundle_id = '$1'"; }

# ═══ Fixture ═══════════════════════════════════════════════════════════════
# Each kit: one required part (R) and one optional part (O), 10 of each.
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0404-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0404-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0404 Two Session Org', '0404-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0404 2S Main', 'WH-0404-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  ('$R1', '$ORG', '$WH', 'X0404-R1', 'Race one part',      10, 'active'),
  ('$O1', '$ORG', '$WH', 'X0404-O1', 'Race one extra',     10, 'active'),
  ('$R2', '$ORG', '$WH', 'X0404-R2', 'Race two part',      10, 'active'),
  ('$O2', '$ORG', '$WH', 'X0404-O2', 'Race two extra',     10, 'active'),
  ('$R3', '$ORG', '$WH', 'X0404-R3', 'Race three part',    10, 'active'),
  ('$O3', '$ORG', '$WH', 'X0404-O3', 'Race three extra',   10, 'active');
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  ('$K1', '$ORG', 'Race kit one',   'KIT-0404-R1', true, true),
  ('$K2', '$ORG', 'Race kit two',   'KIT-0404-R2', true, true),
  ('$K3', '$ORG', 'Race kit three', 'KIT-0404-R3', true, true);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  ('$K1', '$R1', 1, false), ('$K1', '$O1', 1, true),
  ('$K2', '$R2', 1, false), ('$K2', '$O2', 1, true),
  ('$K3', '$R3', 1, false), ('$K3', '$O3', 1, true);
SQL
then
  echo "fixture setup failed"; exit 1
fi

SAVE_MS=()
save_all_optional() { # save_all_optional <tag> <bundle>: the second manager's save, timed
  local t0 t1
  t0="$(now_ms)"
  as_user "$1" "$MGR2" "update public.bundle_components set is_optional = true where bundle_id = '$2';" > "$TMP/$1.out"
  t1="$(now_ms)"
  SAVE_MS+=("$1:$((t1 - t0))")
}

# ═══ 1. The save commits while a distribution waits for its bundle row ════
( hold r1-hold "select 1 from public.bundles where id = '$K1' for update;" 3 > "$TMP/r1-hold.out" ) &
wait_for r1-hold Timeout PgSleep || bad "1: the holder never reached its pause"
( as_user r1-dist "$MGR" "select 'R=' || public.distribute_bundle('$K1', 1, '$WH', false)::text;" > "$TMP/r1-dist.out" ) &
if wait_for r1-dist Lock; then ok "1: the distribution waits for its bundle row"; else bad "1: the distribution did not wait for the bundle row"; fi
save_all_optional r1-save "$K1"
if grep -q 'ERROR' "$TMP/r1-save.out"; then bad "1: the save failed: $(tr '\n' ' ' < "$TMP/r1-save.out" | cut -c1-300)"; fi
wait
check "1: the save made every component of the kit optional" "$(optional_only "$K1")" "true/2"
check "1: the distribution is refused bundle_no_required_components" "$(refused r1-dist P0001 bundle_no_required_components)" "1/1"
check "1: nothing drawn: the part and the extra still hold 10 each, no movement" "$(qty "$R1")/$(qty "$O1")/$(moves "$R1" "$O1")" "10/10/0"
check "1: no distribution recorded" "$(dists "$K1")" "0/-"

# ═══ 2. The save commits while an assembly waits for its bundle row ═══════
( hold r2-hold "select 1 from public.bundles where id = '$K2' for update;" 3 > "$TMP/r2-hold.out" ) &
wait_for r2-hold Timeout PgSleep || bad "2: the holder never reached its pause"
( as_user r2-asm "$MGR" "select 'R=' || (select phantom_qty from public.assemble_bundle('$K2', 1, '$WH'))::text;" > "$TMP/r2-asm.out" ) &
if wait_for r2-asm Lock; then ok "2: the assembly waits for its bundle row"; else bad "2: the assembly did not wait for the bundle row"; fi
save_all_optional r2-save "$K2"
if grep -q 'ERROR' "$TMP/r2-save.out"; then bad "2: the save failed: $(tr '\n' ' ' < "$TMP/r2-save.out" | cut -c1-300)"; fi
wait
check "2: the assembly is refused bundle_no_required_components" "$(refused r2-asm P0001 bundle_no_required_components)" "1/1"
check "2: nothing drawn: 10 and 10, no movement" "$(qty "$R2")/$(qty "$O2")/$(moves "$R2" "$O2")" "10/10/0"
check "2: no kit item was created and the bundle links none" \
  "$(q "select count(*) from public.inventory_items where organization_id = '$ORG' and is_bundle")/$(q "select coalesce(phantom_item_id::text, 'none') from public.bundles where id = '$K2'")" "0/none"

# ═══ 3. The save commits while the distribution is inside its loop ════════
( hold r3-hold "select 1 from public.inventory_items where id = '$R3' for update;" 3 > "$TMP/r3-hold.out" ) &
wait_for r3-hold Timeout PgSleep || bad "3: the holder never reached its pause"
( as_user r3-dist "$MGR" "select 'R=' || public.distribute_bundle('$K3', 1, '$WH', false)::text;" > "$TMP/r3-dist.out" ) &
if wait_for r3-dist Lock; then ok "3: the distribution waits inside its loop, for the required part's row"; else bad "3: the distribution did not wait for the part's row"; fi
save_all_optional r3-save "$K3"
if grep -q 'ERROR' "$TMP/r3-save.out"; then bad "3: the save failed: $(tr '\n' ' ' < "$TMP/r3-save.out" | cut -c1-300)"; fi
wait
check "3: the save made every component optional" "$(optional_only "$K3")" "true/2"
check "3: the distribution went out (the loop read the set it started with)" \
  "$(grep -c '^R=' "$TMP/r3-dist.out")/$(grep -c 'ERROR' "$TMP/r3-dist.out")" "1/0"
check "3: with its required part drawn and counted: 9 and 9, two movements, one distribution with no shortage" \
  "$(qty "$R3")/$(qty "$O3")/$(moves "$R3" "$O3")/$(dists "$K3")" "9/9/2/1/false"
as_user r3-next "$MGR" "select 'R=' || public.distribute_bundle('$K3', 1, '$WH', false)::text;" > "$TMP/r3-next.out"
check "3: the next distribution reads the saved set and is refused" "$(refused r3-next P0001 bundle_no_required_components)" "1/1"
check "3: and draws nothing" "$(qty "$R3")/$(qty "$O3")/$(moves "$R3" "$O3")/$(dists "$K3")" "9/9/2/1/false"

# ═══ 4. No serialization failures, no deadlocks; saves never waited ═══════
if grep -lE '40001|40P01|deadlock' "$TMP"/*.out > /dev/null 2>&1; then
  bad "4: a session saw 40001 or 40P01: $(grep -lE '40001|40P01|deadlock' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "4: no session saw 40001 or 40P01"
fi
slow=""
for s in "${SAVE_MS[@]}"; do
  [ "${s##*:}" -lt 1000 ] || slow="$slow $s"
done
if [ -z "$slow" ]; then
  ok "4: every save answered at once, while the kit call was still waiting (${SAVE_MS[*]} ms)"
else
  bad "4: a save waited for the kit call:$slow ms"
fi

echo
echo "wall time $(( $(now_ms) - T_START )) ms"
if cleanup; then ok "cleanup left no fixture rows"; else bad "cleanup"; fi
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
