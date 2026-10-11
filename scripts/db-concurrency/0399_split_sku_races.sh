#!/usr/bin/env bash
#
# Two-session proof for migration 0399 (Ungroup: split_item_sku). pgTAP runs
# in ONE session, so it cannot show what the split does while another session
# holds an item row or the organization's grouping lock (design 3.2, lock
# order; critique D2).
#
#   1. Split against split, the same record, two keys. A splits and holds
#      (pauses before commit); B's split waits on the organization's grouping
#      advisory lock, then is refused item_changed (the SKU it saw is gone).
#      One new SKU, one audit row.
#   2. Split against split, the same key and body (a double tap). B waits on
#      the grouping lock, then replays A's answer: the same new SKU, replay
#      true, one audit row, one request row.
#   3. update()'s Model B fan-out FIRST. A service-role UPDATE of a shared
#      field over every other row of the SKU (the fan-out's exact shape:
#      inventory.ts, sku = original, deleted_at is null, id <> target) holds
#      its row locks; the split of one of those rows answers 55P03 busy AT
#      ONCE (it never waits on an item row). After the fan-out commits, the
#      same key applies (the cost changed, the SKU did not).
#   4. update()'s fan-out re-keying the SKU FIRST: the split answers busy;
#      after the fan-out commits, the same key is refused item_changed (the
#      SKU the caller saw is gone), and nothing is half-written.
#   5. The split FIRST. A splits and holds; the fan-out (a cost edit on a
#      sibling, keyed on the original SKU) waits on the split row, then skips
#      it (Postgres re-checks the WHERE on the committed row: its SKU is no
#      longer the original), so the split record keeps its own cost and SKU
#      and the siblings get the cost.
#   6. update()'s TARGET-row write (the RLS client, as the member) against the
#      split, both orders: the split waits for nobody; the target write waits
#      for the split and then applies to the split row with its new SKU.
#   7. No session ever sees 40001 or 40P01, and 0234 holds at the end.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0399 applied. Fixtures are committed under the 03991111-... namespace
# and removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# NOT RUN at the authoring stage (desk only; the local stack is held by
# another job). It runs at the test stage.
#
# Usage: bash scripts/db-concurrency/0399_split_sku_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03991111-0000-0000-0000-00000000000a'
MGR='03991111-0000-0000-0000-0000000000a1'
MGR2='03991111-0000-0000-0000-0000000000a2'
WH='03991111-0000-0000-0000-0000000000b1'
# One pair per race, so each starts from a known state.
P1A='03991111-0000-0000-0000-000000000101'; P1B='03991111-0000-0000-0000-000000000102'
P2A='03991111-0000-0000-0000-000000000201'; P2B='03991111-0000-0000-0000-000000000202'
P3A='03991111-0000-0000-0000-000000000301'; P3B='03991111-0000-0000-0000-000000000302'; P3C='03991111-0000-0000-0000-000000000303'
P4A='03991111-0000-0000-0000-000000000401'; P4B='03991111-0000-0000-0000-000000000402'; P4C='03991111-0000-0000-0000-000000000403'
P5A='03991111-0000-0000-0000-000000000501'; P5B='03991111-0000-0000-0000-000000000502'; P5C='03991111-0000-0000-0000-000000000503'
P6A='03991111-0000-0000-0000-000000000601'; P6B='03991111-0000-0000-0000-000000000602'
P7A='03991111-0000-0000-0000-000000000701'; P7B='03991111-0000-0000-0000-000000000702'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '03992222-0000-4000-8000-%012d' "$1"; }
sku_of() { q "select sku from public.inventory_items where id = '$1'"; }
cost_of() { q "select trim_scale(unit_cost)::text from public.inventory_items where id = '$1'"; }
audits_of() { q "select count(*) from public.audit_logs where organization_id = '$ORG' and event = 'inventory.item.ungrouped' and metadata->>'entity_id' = '$1'"; }

# split_sql <actor> <item> <expected sku> <key>: the request as core builds it.
split_sql() {
  printf "select 'R=' || public.split_item_sku('{\"action\":\"split_sku\",\"organization_id\":\"%s\",\"actor_user_id\":\"%s\",\"surface\":\"web\",\"item_ids\":[\"%s\"],\"expected_skus\":{\"%s\":\"%s\"}}'::jsonb, '%s')::text;" \
    "$ORG" "$1" "$2" "$2" "$3" "$4"
}

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
delete from public.audit_logs where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.item_grouping_requests where organization_id = '$ORG')")"
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

if [ "$(q "select count(*) from pg_proc where proname = 'split_item_sku' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "0399 is not applied on this stack (no public.split_item_sku)"; exit 1
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
# as_svc <application_name> <statements>: one transaction as the service role
# (the admin client InventoryService.update() fans out with).
as_svc() {
  printf '%s\n' "set application_name to '$1';" "begin;" "set local role service_role;" "$2" "commit;" \
    | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
# The fan-out's exact shape (inventory.ts update(), the admin client).
fanout_sql() { # fanout_sql <original sku> <target id> <set clause>
  printf "update public.inventory_items set %s, updated_by = '%s' where organization_id = '%s' and sku = '%s' and deleted_at is null and id <> '%s';" \
    "$3" "$MGR" "$ORG" "$1" "$2"
}

# ═══ Fixture ═══════════════════════════════════════════════════════════════
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0399-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0399-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0399 Two Session Org', '0399-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0399 2S Main', 'WH-0399-2S', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, unit_cost, quantity_on_hand, status, bin_location, created_at) values
  ('$P1A', '$ORG', '$WH', 'X0399-R1', 'Race one',   1, 3, 'active', '1-A', now() - interval '2 days'),
  ('$P1B', '$ORG', '$WH', 'X0399-R1', 'Race one',   1, 3, 'active', '1-B', now() - interval '1 day'),
  ('$P2A', '$ORG', '$WH', 'X0399-R2', 'Race two',   1, 3, 'active', '2-A', now() - interval '2 days'),
  ('$P2B', '$ORG', '$WH', 'X0399-R2', 'Race two',   1, 3, 'active', '2-B', now() - interval '1 day'),
  ('$P3A', '$ORG', '$WH', 'X0399-R3', 'Race three', 1, 3, 'active', '3-A', now() - interval '3 days'),
  ('$P3B', '$ORG', '$WH', 'X0399-R3', 'Race three', 1, 3, 'active', '3-B', now() - interval '2 days'),
  ('$P3C', '$ORG', '$WH', 'X0399-R3', 'Race three', 1, 3, 'active', '3-C', now() - interval '1 day'),
  ('$P4A', '$ORG', '$WH', 'X0399-R4', 'Race four',  1, 3, 'active', '4-A', now() - interval '3 days'),
  ('$P4B', '$ORG', '$WH', 'X0399-R4', 'Race four',  1, 3, 'active', '4-B', now() - interval '2 days'),
  ('$P4C', '$ORG', '$WH', 'X0399-R4', 'Race four',  1, 3, 'active', '4-C', now() - interval '1 day'),
  ('$P5A', '$ORG', '$WH', 'X0399-R5', 'Race five',  1, 3, 'active', '5-A', now() - interval '3 days'),
  ('$P5B', '$ORG', '$WH', 'X0399-R5', 'Race five',  1, 3, 'active', '5-B', now() - interval '2 days'),
  ('$P5C', '$ORG', '$WH', 'X0399-R5', 'Race five',  1, 3, 'active', '5-C', now() - interval '1 day'),
  ('$P6A', '$ORG', '$WH', 'X0399-R6', 'Race six',   1, 3, 'active', '6-A', now() - interval '2 days'),
  ('$P6B', '$ORG', '$WH', 'X0399-R6', 'Race six',   1, 3, 'active', '6-B', now() - interval '1 day'),
  ('$P7A', '$ORG', '$WH', 'X0399-R7', 'Race seven', 1, 3, 'active', '7-A', now() - interval '2 days'),
  ('$P7B', '$ORG', '$WH', 'X0399-R7', 'Race seven', 1, 3, 'active', '7-B', now() - interval '1 day');
SQL
then
  echo "fixture setup failed"; exit 1
fi

ans() { sed -n 's/^R=//p' "$TMP/$1.out"; }
jget() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "null")
out = []
for path in sys.argv[1:]:
    v = d
    for part in path.split("."):
        if isinstance(v, list):
            v = v[int(part)] if part.isdigit() and int(part) < len(v) else None
        else:
            v = v.get(part) if isinstance(v, dict) else None
    out.append("-" if v is None else json.dumps(v) if isinstance(v, bool) else str(v))
print("/".join(out))
' "$@"
}
refused() { # refused <tag> <sqlstate> <hint>: 1/1 when that output carries both
  printf '%s/%s' "$(grep -c "ERROR:  $2" "$TMP/$1.out")" "$(grep -c "HINT:  $3" "$TMP/$1.out")"
}

# ═══ 1. Split against split, the same record, two keys ═════════════════════
( as_user r1a "$MGR" "$(split_sql "$MGR" "$P1B" X0399-R1 "$(key 1)") select pg_sleep(1.5);" > "$TMP/r1a.out" ) &
wait_for r1a Timeout PgSleep || bad "1: A never reached its pause"
( as_user r1b "$MGR2" "$(split_sql "$MGR2" "$P1B" X0399-R1 "$(key 2)")" > "$TMP/r1b.out" ) &
if wait_for r1b Lock advisory; then ok "1: B waits on the organization's grouping lock"; else bad "1: B did not wait on the advisory lock"; fi
wait
check "1: A split P1B" "$(ans r1a | jget items.0.kept replay)" "false/false"
check "1: B is refused item_changed after A commits" "$(refused r1b P0001 item_changed)" "1/1"
check "1: one new SKU on P1B, P1A kept" "$(test "$(sku_of "$P1B")" != X0399-R1 && echo new)/$(sku_of "$P1A")" "new/X0399-R1"
check "1: one audit row" "$(audits_of "$P1B")" "1"

# ═══ 2. The same key and body twice (a double tap) ════════════════════════
( as_user r2a "$MGR" "$(split_sql "$MGR" "$P2B" X0399-R2 "$(key 3)") select pg_sleep(1.5);" > "$TMP/r2a.out" ) &
wait_for r2a Timeout PgSleep || bad "2: A never reached its pause"
( as_user r2b "$MGR" "$(split_sql "$MGR" "$P2B" X0399-R2 "$(key 3)")" > "$TMP/r2b.out" ) &
if wait_for r2b Lock advisory; then ok "2: B waits on the grouping lock"; else bad "2: B did not wait on the advisory lock"; fi
wait
check "2: B replays A's answer" "$(ans r2b | jget replay items.0.after_sku)" "true/$(ans r2a | jget items.0.after_sku)"
check "2: the SKU is A's, one audit row, one request row" \
  "$(test "$(sku_of "$P2B")" = "$(ans r2a | jget items.0.after_sku)" && echo same)/$(audits_of "$P2B")/$(q "select count(*) from public.item_grouping_requests where organization_id = '$ORG' and key = '$(key 3)'")" \
  "same/1/1"

# ═══ 3. update()'s fan-out FIRST (a cost edit): the split is busy at once ══
( as_svc r3u "$(fanout_sql X0399-R3 "$P3A" "unit_cost = 7") select pg_sleep(2);" > "$TMP/r3u.out" ) &
wait_for r3u Timeout PgSleep || bad "3: the fan-out never reached its pause"
T0=$(now_ms)
as_user r3s "$MGR" "$(split_sql "$MGR" "$P3B" X0399-R3 "$(key 4)")" > "$TMP/r3s.out"
T1=$(now_ms)
check "3: the split answers 55P03 busy" "$(refused r3s 55P03 busy)" "1/1"
if [ $((T1 - T0)) -lt 1000 ]; then ok "3: at once ($((T1 - T0)) ms; the fan-out held for 2 s)"; else bad "3: the split waited $((T1 - T0)) ms"; fi
wait
as_user r3s2 "$MGR" "$(split_sql "$MGR" "$P3B" X0399-R3 "$(key 4)")" > "$TMP/r3s2.out"
check "3: the same key applies after the fan-out commits" "$(ans r3s2 | jget replay items.0.kept)" "false/false"
check "3: the split record keeps the fan-out's cost; the siblings keep the SKU" \
  "$(cost_of "$P3B")/$(cost_of "$P3C")/$(sku_of "$P3A")/$(sku_of "$P3C")" "7/7/X0399-R3/X0399-R3"

# ═══ 4. update()'s fan-out re-keying the SKU FIRST ════════════════════════
( as_svc r4u "update public.inventory_items set sku = 'X0399-R4-NEW', updated_by = '$MGR' where id = '$P4A'; $(fanout_sql X0399-R4 "$P4A" "sku = 'X0399-R4-NEW'") select pg_sleep(2);" > "$TMP/r4u.out" ) &
wait_for r4u Timeout PgSleep || bad "4: the re-key never reached its pause"
as_user r4s "$MGR" "$(split_sql "$MGR" "$P4B" X0399-R4 "$(key 5)")" > "$TMP/r4s.out"
check "4: the split answers 55P03 busy while the re-key holds" "$(refused r4s 55P03 busy)" "1/1"
wait
as_user r4s2 "$MGR" "$(split_sql "$MGR" "$P4B" X0399-R4 "$(key 5)")" > "$TMP/r4s2.out"
check "4: after the re-key the same key is item_changed" "$(refused r4s2 P0001 item_changed)" "1/1"
check "4: the group moved together and nothing was split" \
  "$(sku_of "$P4A")/$(sku_of "$P4B")/$(sku_of "$P4C")/$(audits_of "$P4B")" "X0399-R4-NEW/X0399-R4-NEW/X0399-R4-NEW/0"

# ═══ 5. The split FIRST; the fan-out waits, then skips the split row ══════
( as_user r5s "$MGR" "$(split_sql "$MGR" "$P5B" X0399-R5 "$(key 6)") select pg_sleep(1.5);" > "$TMP/r5s.out" ) &
wait_for r5s Timeout PgSleep || bad "5: the split never reached its pause"
( as_svc r5u "$(fanout_sql X0399-R5 "$P5A" "unit_cost = 9")" > "$TMP/r5u.out" ) &
if wait_for r5u Lock transactionid; then ok "5: the fan-out waits on the split row"; else bad "5: the fan-out did not wait"; fi
wait
check "5: the split applied" "$(ans r5s | jget items.0.kept)" "false"
check "5: the fan-out skipped the split row (its SKU changed) and reached the sibling" \
  "$(cost_of "$P5B")/$(cost_of "$P5C")/$(sku_of "$P5C")" "1/9/X0399-R5"

# ═══ 6. update()'s target-row write, both orders ══════════════════════════
target_sql() { printf "with u as (update public.inventory_items set name = '%s' where organization_id = '%s' and id = '%s' returning sku) select 'T=' || sku from u;" "$1" "$ORG" "$2"; }
( as_user r6t "$MGR2" "$(target_sql 'Race six renamed' "$P6B") select pg_sleep(1.5);" > "$TMP/r6t.out" ) &
wait_for r6t Timeout PgSleep || bad "6a: the target write never reached its pause"
as_user r6s "$MGR" "$(split_sql "$MGR" "$P6B" X0399-R6 "$(key 7)")" > "$TMP/r6s.out"
check "6a: the target write holds; the split is busy at once" "$(refused r6s 55P03 busy)" "1/1"
wait
( as_user r7s "$MGR" "$(split_sql "$MGR" "$P7B" X0399-R7 "$(key 8)") select pg_sleep(1.5);" > "$TMP/r7s.out" ) &
wait_for r7s Timeout PgSleep || bad "6b: the split never reached its pause"
( as_user r7t "$MGR2" "$(target_sql 'Race seven renamed' "$P7B")" > "$TMP/r7t.out" ) &
if wait_for r7t Lock transactionid; then ok "6b: the target write waits on the split"; else bad "6b: the target write did not wait"; fi
wait
check "6b: the target write then applies to the split row, with its new SKU" \
  "$(sed -n 's/^T=//p' "$TMP/r7t.out")/$(q "select name from public.inventory_items where id = '$P7B'")" \
  "$(ans r7s | jget items.0.after_sku)/Race seven renamed"

# ═══ 7. Never 40001 or 40P01; 0234 holds ══════════════════════════════════
if grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "7: a session saw 40001 or 40P01: $(grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "7: no session saw 40001 or 40P01"
fi
check "7: 0234 holds" "$(q "select count(*) from (select sku, charter_id, bin_location from public.inventory_items where organization_id = '$ORG' and deleted_at is null group by 1, 2, 3 having count(*) > 1) d")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
exit "$FAILS"
