#!/usr/bin/env bash
#
# Two-session proof for migration 0369 (Phase 0 S5-C). pgTAP runs in ONE
# session, so it cannot show what these two properties are about: what happens
# while ANOTHER transaction holds a lock.
#
#   1. A record waits for an in-flight post of the same item (the rebase
#      trigger reads on-hand FOR SHARE) and is measured against the POSTED
#      quantity. Without FOR SHARE the record reads the pre-post quantity and
#      stamps a baseline after the post's movement, so the superseded guard
#      misses it and the second count applies the same correction again.
#   2. Two overlapping posts never deadlock (lines are processed in item_id
#      order). The second one is refused as superseded (P0001), never 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03691111-… namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0369_count_overlap.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORG='03691111-0000-0000-0000-00000000000a'
MGR='03691111-0000-0000-0000-0000000000a1'
STF='03691111-0000-0000-0000-0000000000a2'
WH='03691111-0000-0000-0000-0000000000b1'
RACK='03691111-0000-0000-0000-0000000000e1'
X='03691111-0000-0000-0000-0000000000c1'
Y='03691111-0000-0000-0000-0000000000c2'
W='03691111-0000-0000-0000-0000000000c3'
CC_A='03691111-0000-0000-0000-0000000000d1'
CC_B='03691111-0000-0000-0000-0000000000d2'
CC_1='03691111-0000-0000-0000-0000000000d3'
CC_2='03691111-0000-0000-0000-0000000000d4'
LN_A='03691111-0000-0000-0000-000000000101'
LN_B='03691111-0000-0000-0000-000000000102'

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
  # Lines and counts first: the organization cascade would otherwise SET NULL
  # a line's counted_location_id after its count row is gone, which the
  # line-update trigger refuses (cycle_count_not_found).
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.cycle_count_lines
 where cycle_count_id in (select id from public.cycle_counts where organization_id = '$ORG');
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$STF');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR', '0369-2s-mgr@test.local', '{}'::jsonb),
  ('$STF', '0369-2s-stf@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0369 Two Session Org', '0369-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()), ('$ORG', '$STF', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status)
  values ('$WH', '$ORG', '0369 2S Main', 'WH-0369-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary)
  values ('$ORG', '$STF', '$WH', true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values ('$RACK', '$ORG', '$WH', '2S-A', 'shelf', 'rack');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$X', '$ORG', '$WH', '2S item X', 'SKU-0369-2S-X', 20, 'active'),
  ('$Y', '$ORG', '$WH', '2S item Y', 'SKU-0369-2S-Y', 20, 'active'),
  ('$W', '$ORG', '$WH', '2S item W', 'SKU-0369-2S-W', 20, 'active');
delete from public.item_stock_levels where item_id in ('$X', '$Y', '$W');
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  ('$ORG', '$X', '$RACK', 20), ('$ORG', '$Y', '$RACK', 20), ('$ORG', '$W', '$RACK', 20);
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by) values
  ('$CC_A', '$ORG', '$WH', 'in_progress', 'selection', '$MGR'),
  ('$CC_B', '$ORG', '$WH', 'in_progress', 'selection', '$MGR'),
  ('$CC_1', '$ORG', '$WH', 'in_progress', 'selection', '$MGR'),
  ('$CC_2', '$ORG', '$WH', 'in_progress', 'selection', '$MGR');
insert into public.cycle_count_lines (id, cycle_count_id, item_id, warehouse_id, expected_quantity) values
  ('$LN_A', '$CC_A', '$W', '$WH', 20),
  ('$LN_B', '$CC_B', '$W', '$WH', 20);
-- Count 1 lists X then Y; count 2 lists Y then X (opposite physical order).
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  ('$CC_1', '$X', '$WH', 20);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  ('$CC_1', '$Y', '$WH', 20);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  ('$CC_2', '$Y', '$WH', 20);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  ('$CC_2', '$X', '$WH', 20);
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# ═══ 1. A record waits for an in-flight post ══════════════════════════════
echo "== 1. a record of item W waits for count A's open post of W"
"${PSQL[@]}" >/dev/null <<SQL
begin; $(as_user "$STF")
update public.cycle_count_lines set counted_quantity = 22, counted_by = '$STF', counted_at = now() where id = '$LN_A';
commit;
SQL

# Session A: post count A (+2 on W) and hold the transaction open for 3 s.
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/postA.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
select (public.post_cycle_count('$CC_A')).status;
select pg_sleep(3);
commit;
SQL
) &
PID_A=$!
sleep 1

# Session B: record count B's line for W while A's post is still open.
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/recB.out" 2>&1 <<SQL
begin; $(as_user "$STF")
update public.cycle_count_lines set counted_quantity = 22, counted_by = '$STF', counted_at = now() where id = '$LN_B';
commit;
SQL
T1=$(now_ms)
wait "$PID_A"

check "1a: count A posted" "$(grep -c completed "$TMP/postA.out")" "1"
# Session A holds its post open ~3 s and B starts ~1 s in, so B waits ~2 s.
if [ $((T1 - T0)) -ge 1500 ]; then ok "1b: the record waited for the open post ($((T1 - T0)) ms)"; else bad "1b: the record did not wait ($((T1 - T0)) ms)"; fi
check "1c: the record is measured against the posted quantity" \
  "$(q "select expected_quantity::int from public.cycle_count_lines where id = '$LN_B'")" "22"
check "1d: its baseline is after count A's movement" \
  "$(q "select (select baseline_at from public.cycle_count_lines where id = '$LN_B') > max(created_at) from public.stock_movements where item_id = '$W' and reference_id = '$CC_A'")" "t"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/postB.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
select (public.post_cycle_count('$CC_B')).status;
commit;
SQL
check "1e: count B posts" "$(grep -c completed "$TMP/postB.out")" "1"
check "1f: W is 22, the correction applied once" \
  "$(q "select quantity_on_hand::int from public.inventory_items where id = '$W'")" "22"
check "1g: count B moved nothing" \
  "$(q "select count(*) from public.stock_movements where reference_id = '$CC_B'")" "0"

# ═══ 2. Overlapping posts never deadlock ══════════════════════════════════
echo "== 2. counts 1 and 2 both hold X and Y (in opposite line order) and post at once"
"${PSQL[@]}" >/dev/null <<SQL
begin; $(as_user "$STF")
update public.cycle_count_lines set counted_quantity = 22, counted_by = '$STF', counted_at = now() where cycle_count_id = '$CC_1';
commit;
begin; $(as_user "$STF")
update public.cycle_count_lines set counted_quantity = 22, counted_by = '$STF', counted_at = now() where cycle_count_id = '$CC_2';
commit;
SQL

# Without an ORDER BY the line loop follows whatever order the plan yields,
# and on these few rows the planner happens to walk the (cycle_count_id,
# item_id) index, which is item order by accident. Plans change with data, so
# both posts are forced onto the plan that reads lines in their physical order
# (count 2: Y, then X). Only the function's own ORDER BY keeps them apart then.
FORCE_PHYSICAL_ORDER="set local enable_indexscan = off; set local enable_indexonlyscan = off; set local enable_bitmapscan = off; set local enable_hashjoin = off; set local enable_mergejoin = off;"

# Session L holds X's holding row, so post 1 stops INSIDE X (item lock held).
( "${PSQL[@]}" > "$TMP/lock.out" 2>&1 <<SQL
begin;
select location_id from public.item_stock_levels where item_id = '$X' for update;
select pg_sleep(3);
commit;
SQL
) &
PID_L=$!
sleep 0.5
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/post1.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
$FORCE_PHYSICAL_ORDER
select (public.post_cycle_count('$CC_1')).status;
commit;
SQL
) &
PID_1=$!
sleep 0.5
# Post 2 starts while post 1 holds X. In item_id order it queues on X; in its
# physical line order (Y first) it would take Y and deadlock with post 1.
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/post2.out" 2>&1 <<SQL
begin; $(as_user "$MGR")
$FORCE_PHYSICAL_ORDER
select (public.post_cycle_count('$CC_2')).status;
commit;
SQL
) &
PID_2=$!
wait "$PID_L" "$PID_1" "$PID_2"

check "2-: the lock holder held X's holding rows" "$(grep -c ERROR "$TMP/lock.out")" "0"
check "2a: no session hit a deadlock (40P01)" "$(cat "$TMP/post1.out" "$TMP/post2.out" | grep -c 40P01)" "0"
check "2b: count 1 posted" "$(grep -c completed "$TMP/post1.out")" "1"
check "2c: count 2 was refused as superseded (P0001)" \
  "$(grep -cE 'P0001: cycle_count_line_superseded: SKU-0369-2S-X' "$TMP/post2.out")" "1"
check "2d: X and Y hold 22 each (each correction applied once)" \
  "$(q "select string_agg(quantity_on_hand::int::text, ',' order by sku) from public.inventory_items where id in ('$X', '$Y')")" "22,22"

if [ "$FAILS" -gt 0 ]; then
  echo "--- session output ---"
  for f in postA recB postB post1 post2 lock; do echo "[$f]"; cat "$TMP/$f.out" 2>/dev/null; done
fi

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left behind" \
  "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all two-session checks passed"
