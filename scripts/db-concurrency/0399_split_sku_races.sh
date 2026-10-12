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
#   7. A record leaves the caller's scope between the first checks and the
#      row lock (fix round 1, SEC-1). A staff member assigned to the
#      warehouse for charter CHB only (so it reads the warehouse's no-charter
#      records and CHB's, never CHA's, and may write the warehouse) splits
#      one no-charter record of a three-record SKU; the split pauses right
#      after its first scope check (a planted pause in caller_can_write_item,
#      this race only); another session commits a move of that record into
#      CHA; the split then takes its lock and is refused item_changed,
#      because the scope is checked again under the lock. Without that
#      recheck the split would write the moved record: its two siblings are
#      still readable, so not_shared does not fire. The staff member's reads
#      are checked before and after the move (fix round 2, R2-1: an
#      assignment with NO charter means every charter at the warehouse,
#      0229/0310, and would never lose the moved record). The plant is
#      removed right after, by cleanup at the start and end, and by the
#      EXIT trap.
#   8. No session ever sees 40001 or 40P01, and 0234 holds at the end.
#
# After the races (PR stage, evidence review EV-2) the log records what the run
# left: the md5 of every 0399 function's body (to compare with the kit's), that
# no planted function is left, the fixture rows left after cleanup (0), and the
# run's wall time.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0399 applied. Fixtures are committed under the 03991111-... namespace
# and removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# First run at the test stage (2026-10-12, all checks passed); run again at
# the PR stage.
#
# Usage: bash scripts/db-concurrency/0399_split_sku_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03991111-0000-0000-0000-00000000000a'
MGR='03991111-0000-0000-0000-0000000000a1'
MGR2='03991111-0000-0000-0000-0000000000a2'
STF='03991111-0000-0000-0000-0000000000a3'
CHA='03991111-0000-0000-0000-0000000000c1'
CHB='03991111-0000-0000-0000-0000000000c2'
WH='03991111-0000-0000-0000-0000000000b1'
# One pair per race, so each starts from a known state.
P1A='03991111-0000-0000-0000-000000000101'; P1B='03991111-0000-0000-0000-000000000102'
P2A='03991111-0000-0000-0000-000000000201'; P2B='03991111-0000-0000-0000-000000000202'
P3A='03991111-0000-0000-0000-000000000301'; P3B='03991111-0000-0000-0000-000000000302'; P3C='03991111-0000-0000-0000-000000000303'
P4A='03991111-0000-0000-0000-000000000401'; P4B='03991111-0000-0000-0000-000000000402'; P4C='03991111-0000-0000-0000-000000000403'
P5A='03991111-0000-0000-0000-000000000501'; P5B='03991111-0000-0000-0000-000000000502'; P5C='03991111-0000-0000-0000-000000000503'
P6A='03991111-0000-0000-0000-000000000601'; P6B='03991111-0000-0000-0000-000000000602'
P7A='03991111-0000-0000-0000-000000000701'; P7B='03991111-0000-0000-0000-000000000702'
P8A='03991111-0000-0000-0000-000000000801'; P8B='03991111-0000-0000-0000-000000000802'; P8C='03991111-0000-0000-0000-000000000803'

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

# Race 7's planted pause: caller_can_write_item renamed aside and wrapped.
# unplant puts the real function back (its grants and comment travel with it)
# and is safe to run when nothing is planted.
unplant() {
  "${PSQL[@]}" >/dev/null <<'SQL'
do $u$
begin
  if to_regprocedure('public._zz0399_cciw_real(uuid)') is not null then
    drop function if exists public.caller_can_write_item(uuid);
    alter function public._zz0399_cciw_real(uuid) rename to caller_can_write_item;
  end if;
end
$u$;
SQL
}
plant() {
  "${PSQL[@]}" >/dev/null <<'SQL'
begin;
alter function public.caller_can_write_item(uuid) rename to _zz0399_cciw_real;
create function public.caller_can_write_item(p_item_id uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $p$
declare v boolean := public._zz0399_cciw_real(p_item_id);
begin
  -- Race 7 only: pause once per transaction, AFTER the first (step 8) answer,
  -- so another session can commit a move before the split takes its row lock.
  if current_setting('application_name') = 'rscope'
     and coalesce(current_setting('zz0399.paused', true), '') = '' then
    perform set_config('zz0399.paused', 'yes', true);
    perform pg_sleep(1.5);
  end if;
  return v;
end
$p$;
revoke all on function public.caller_can_write_item(uuid) from public, anon, service_role;
grant execute on function public.caller_can_write_item(uuid) to authenticated;
commit;
SQL
}

cleanup() {
  if ! unplant 2>"$TMP/unplant.err"; then
    echo "unplant failed (caller_can_write_item may still be wrapped):"; cat "$TMP/unplant.err"; return 1
  fi
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.audit_logs where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2', '$STF');
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

T_START=$(now_ms)
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
  ('$MGR2', '0399-2s-mgr2@test.local', '{}'::jsonb),
  ('$STF',  '0399-2s-stf@test.local',  '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0399 Two Session Org', '0399-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now()),
  ('$ORG', '$STF', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0399 2S Main', 'WH-0399-2S', 'active');
-- Race 7: the staff member is assigned to the warehouse for charter CHB
-- only. That reads the warehouse's no-charter records
-- (rls_inv_read_assigned_warehouse_ids) and CHB's (rls_inv_read_warehouse_
-- charter_ids), never CHA's, and still writes the warehouse
-- (user_can_access_warehouse needs only an assignment row). An assignment
-- with NO charter would read every charter here (0229/0310
-- rls_inv_read_full_warehouse_ids) and never lose the moved record (fix
-- round 2, R2-1). CHA is the charter a record is moved into.
insert into public.charters (id, organization_id, name, code, status) values
  ('$CHA', '$ORG', '0399 2S North', 'C0399-2S', 'active'),
  ('$CHB', '$ORG', '0399 2S South', 'C0399-2S-S', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  ('$ORG', '$WH', '$CHA'),
  ('$ORG', '$WH', '$CHB');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  ('$ORG', '$STF', '$WH', '$CHB', true);
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
  ('$P7B', '$ORG', '$WH', 'X0399-R7', 'Race seven', 1, 3, 'active', '7-B', now() - interval '1 day'),
  ('$P8A', '$ORG', '$WH', 'X0399-R8', 'Race eight', 1, 3, 'active', '8-A', now() - interval '3 days'),
  ('$P8B', '$ORG', '$WH', 'X0399-R8', 'Race eight', 1, 3, 'active', '8-B', now() - interval '2 days'),
  ('$P8C', '$ORG', '$WH', 'X0399-R8', 'Race eight', 1, 3, 'active', '8-C', now() - interval '1 day');
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
# stf_sees <sku>: the id suffixes of that SKU's live records the staff member
# reads, through RLS and through caller_can_read_item, as "rls;ccri".
stf_sees() {
  as_user - "$STF" "select 'V=' || coalesce((select string_agg(right(i.id::text, 3), ',' order by i.id) from public.inventory_items i where i.sku = '$1' and i.deleted_at is null), '-') || ';' || coalesce((select string_agg(right(i.id::text, 3), ',' order by i.id) from public.inventory_items i where i.sku = '$1' and i.deleted_at is null and public.caller_can_read_item(i.id)), '-');" rollback \
    | sed -n 's/^V=//p'
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

# ═══ 7. A record leaves the caller's scope between the checks and the lock ═
check "7: before the move the staff member reads all three records (no-charter)" "$(stf_sees X0399-R8)" "801,802,803;801,802,803"
if plant 2>"$TMP/plant.err"; then
  ( as_user rscope "$STF" "$(split_sql "$STF" "$P8B" X0399-R8 "$(key 9)")" > "$TMP/rscope.out" ) &
  if wait_for rscope Timeout PgSleep; then
    ok "7: the split paused after its first scope check (step 8 passed)"
  else
    bad "7: the split never reached its planted pause"
  fi
  # Another session (the superuser: no lock to wait on, the split holds no row
  # yet) commits a move of P8B into a charter the staff member cannot read.
  T0=$(now_ms)
  q "update public.inventory_items set charter_id = '$CHA' where id = '$P8B'" >/dev/null
  T1=$(now_ms)
  if [ $((T1 - T0)) -lt 1000 ]; then ok "7: the move committed at once ($((T1 - T0)) ms)"; else bad "7: the move waited $((T1 - T0)) ms"; fi
  wait
  unplant || bad "7: unplant failed"
  check "7: after the move the staff member no longer reads P8B (it is in CHA)" "$(stf_sees X0399-R8)" "801,803;801,803"
  check "7: the split is refused item_changed under the lock (the scope is checked again)" "$(refused rscope P0001 item_changed)" "1/1"
  check "7: nothing written: P8B keeps its SKU, no audit row, no request row; the siblings are untouched" \
    "$(sku_of "$P8B")/$(audits_of "$P8B")/$(q "select count(*) from public.item_grouping_requests where organization_id = '$ORG' and key = '$(key 9)'")/$(sku_of "$P8A")/$(sku_of "$P8C")" \
    "X0399-R8/0/0/X0399-R8/X0399-R8"
  check "7: the real caller_can_write_item is back" \
    "$(q "select (to_regprocedure('public._zz0399_cciw_real(uuid)') is null and has_function_privilege('authenticated', 'public.caller_can_write_item(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.caller_can_write_item(uuid)', 'EXECUTE'))::text")" \
    "true"
else
  bad "7: could not plant the pause: $(cat "$TMP/plant.err")"
fi

# ═══ 8. Never 40001 or 40P01; 0234 holds ══════════════════════════════════
if grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "8: a session saw 40001 or 40P01: $(grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "8: no session saw 40001 or 40P01"
fi
check "8: 0234 holds" "$(q "select count(*) from (select sku, charter_id, bin_location from public.inventory_items where organization_id = '$ORG' and deleted_at is null group by 1, 2, 3 having count(*) > 1) d")" "0"

# ═══ After: what the run left (PR stage, EV-2) ═════════════════════════════
wait
unplant || bad "after: unplant failed"
echo "after: 0399 function md5s: $(q "select string_agg(p.proname || '=' || md5(p.prosrc), ' ' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_item\_grouping\_%' or p.proname in ('split_item_sku', 'caller_can_write_item'))")"
check "after: no planted function is left" "$(q "select count(*) from pg_proc where proname like '\_zz0399\_%'")" "0"
if cleanup; then ok "after: cleanup removed every fixture"; else bad "after: cleanup failed"; fi
check "after: fixture rows left (items, requests, audit rows, the organization, the users)" \
  "$(q "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.item_grouping_requests where organization_id = '$ORG') + (select count(*) from public.audit_logs where organization_id = '$ORG') + (select count(*) from public.organizations where id = '$ORG') + (select count(*) from auth.users where id in ('$MGR', '$MGR2', '$STF'))")" "0"
echo "wall time: $(( ($(now_ms) - T_START) / 1000 )) s"

echo
if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
exit "$FAILS"
