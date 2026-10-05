#!/usr/bin/env bash
#
# Lock footprint of migration 0395 (order and stock guards, small fixes slice
# 2). The push runs the whole file as one batch, so every table lock a
# statement takes is held until the file commits. CREATE TRIGGER takes SHARE
# ROW EXCLUSIVE on inventory_items; ALTER POLICY takes ACCESS EXCLUSIVE on its
# table, and on this image (17.6.1.166, supautils 3.4.0) supautils also takes
# ACCESS EXCLUSIVE on every table supautils.policy_grants lists for the role
# (auth, storage, realtime). No order of the two order tables is deadlock-free
# by itself (partial_pick_line locks a line, then its order; cancel and the
# signature lock the order, then its lines), and a stock write holds an
# inventory_items row while it may go on to an order table, so the file takes
# every lock in one NOWAIT prelude (`do $lock$ ... end $lock$;`, the 0390 one)
# and never waits holding one. A busy table fails one attempt; the attempt's
# subtransaction rolls back (releasing what it took) and the prelude retries
# after a pause, up to 40 times, holding no table lock in between. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the functions, grants and comments lock nothing).
#   1b. The prelude takes SHARE ROW EXCLUSIVE on inventory_items, ACCESS
#       EXCLUSIVE on order_requests and order_request_lines, and ACCESS
#       EXCLUSIVE on every existing table in supautils.policy_grants for the
#       role, and nothing else.
#   1c. No statement after the prelude locks a table the prelude did not lock
#       (so the file can never wait while holding one).
#   2.  The hold, from the prelude to the end of the file, is under 100 ms.
#   3.  A holder with an open transaction on order_requests (a reader), on
#       order_request_lines (a row lock), on auth.users (a reader) or on
#       inventory_items (a stock write: ROW EXCLUSIVE), held longer than the
#       retries last: the file retries, holds NO table lock whenever it is
#       paused between attempts (sampled from pg_locks), and fails 55P03 after
#       its bounded retries (40 attempts), writing nothing.
#   3b. The same order reader held only 0.6 s: the file retries past it and
#       runs to the end (the retry turns a busy instant into a clean apply).
#   4.  The cancel shape (order row locked, then its lines), 5. the
#       partial-pick shape (a line locked, then its order) and 5b. the stock
#       shape (an item updated, then its order locked), each with the first
#       lock held when the file starts: the write completes with no error (no
#       40P01), and the file, which never waits holding a lock, either runs to
#       the end once the write commits or fails 55P03; never 40P01.
#   6.  While the file holds its locks (an artificial 1 s), a new order reader
#       and a new auth.users reader wait only for the hold, then read; a new
#       inventory_items reader does not wait at all (SHARE ROW EXCLUSIVE lets
#       plain reads through).
#   7.  CONTROL, the hazard the prelude removes: the same file with the prelude
#       cut out and lock_timeout 5s, against the cancel shape. The file holds
#       order_request_lines (altered first) and waits for order_requests; the
#       cancel then waits for the lines; Postgres ends one side with 40P01.
#       Required: at least one 40P01 here (if this ever stops reproducing, the
#       hazard analysis in the migration header needs re-reading).
#
# The migration sessions ALWAYS roll back, so the script changes nothing but
# its own fixture rows (removed at the start, the end and by the EXIT trap).
# It needs the pre-0395 head. LOCAL stack only (docker container
# supabase_db_stockpilot). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0395_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rebase.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_order_stock_guards.sql' | sort | tail -n 1)}"
TMP="$(mktemp -d)"
BG=()

ORG='03962222-0000-0000-0000-00000000000a'
REQ='03962222-0000-0000-0000-0000000000a1'
WH='03962222-0000-0000-0000-0000000000c1'
ITEM='03962222-0000-0000-0000-0000000000c2'
ORD='03962222-0000-0000-0000-0000000000d1'
LINE='03962222-0000-0000-0000-0000000000e1'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
wait_sleeping() {
  local _ n
  for _ in $(seq 1 100); do
    n="$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = 'PgSleep'")"
    [ "$n" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}
cleanup_rows() {
  "${PSQL[@]}" >/dev/null 2>&1 <<SQL
delete from public.order_request_lines where order_request_id = '$ORD';
delete from public.order_requests where organization_id = '$ORG';
delete from public.item_stock_levels where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$REQ';
SQL
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local p
  for p in "${BG[@]:-}"; do [ -n "$p" ] && wait "$p" 2> /dev/null; done
  cleanup_rows
  rm -rf "$TMP"
}
trap cleanup EXIT

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the order stock guards migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_FN="$(q "select count(*) from pg_proc where proname = 'tg_inventory_items_no_delete_with_stock'")"
echo "local head $HEAD_NOW; tg_inventory_items_no_delete_with_stock present: $HAS_FN; file $(basename "$MIG")"
if [ "$HAS_FN" != "0" ]; then
  echo "needs the pre-0395 head (supabase db reset --local --version <the migration before it>, then the QA reseed)"
  exit 1
fi
POL_BEFORE="$(q "select md5(string_agg(policyname || coalesce(qual, '') || coalesce(with_check, ''), '' order by policyname)) from pg_policies where tablename in ('order_requests', 'order_request_lines')")"

cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$REQ', '0395-lock-req@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0395 Lock Org', '0395-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$REQ', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0395 Lock Main', 'WH-0395-LK', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', 'Lock item', 'SKU-0395-LK', 10, 'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
  values ('$ORD', '$ORG', '$WH', 'pending_approval', 'internal', '$REQ', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested) values ('$LINE', '$ORD', '$ITEM', 1);
SQL

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || { echo "no lock prelude in $MIG"; exit 1; }
head -n $((P0 - 1)) "$MIG" > "$TMP/part1.sql"
sed -n "${P0},${P1}p" "$MIG" > "$TMP/prelude.sql"
tail -n +$((P1 + 1)) "$MIG" > "$TMP/part3.sql"
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"

# ── 1 and 2. What the prelude takes, and that nothing comes after it ──────
{
  echo "begin;"
  cat "$TMP/part1.sql"
  echo "select 'BEFORE|' || coalesce(($LOCKS_SQL), 'none');"
  echo "select 'T0|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/prelude.sql"
  echo "select 'PRELUDE|' || coalesce(($LOCKS_SQL), 'none');"
  echo "select 'EXPECTED|' || string_agg(x, ',' order by x) from (
          select 'public.inventory_items:ShareRowExclusiveLock' as x
          union all select 'public.order_request_lines:AccessExclusiveLock'
          union all select 'public.order_requests:AccessExclusiveLock'
          union all select n.nspname || '.' || c.relname || ':AccessExclusiveLock'
            from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb)) t(name)
            join pg_class c on c.oid = to_regclass(t.name) join pg_namespace n on n.oid = c.relnamespace) e;"
  cat "$TMP/part3.sql"
  echo "select 'T1|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'END|' || coalesce(($LOCKS_SQL), 'none');"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
else
  BEFORE="$(sed -n 's/^BEFORE|//p' "$TMP/1.out")"
  PRELUDE="$(sed -n 's/^PRELUDE|//p' "$TMP/1.out")"
  EXPECTED="$(sed -n 's/^EXPECTED|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the functions, grants and comments lock no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly the order tables, inventory_items (share row exclusive) and the $(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vc '^public\.') supautils.policy_grants tables"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks a table it did not lock"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 100 ]; then
    ok "2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "2: the prelude to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3. An open transaction on a table the prelude needs ─────────────────
# The file's session is named so its locks can be sampled while it pauses
# between attempts (wait_event PgSleep inside the prelude).
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0395-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0395-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0395-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3-$label.m.out" 2> "$TMP/3-$label.m.err" &
  local mp=$!
  # Sample the file's locks while it runs: whenever it is paused between
  # attempts it must hold no table lock outside the catalogs.
  local samples=0 sleeping=0 held=0 r
  while kill -0 "$mp" 2> /dev/null; do
    r="$(q "$LOCKS_OF_SLEEPING_FILE")"
    samples=$((samples + 1))
    sleeping=$((sleeping + ${r%%|*}))
    held=$((held + ${r##*|}))
    sleep 0.05
  done
  wait "$mp"
  rc=$?
  t1="$(now_ms)"
  if [ "$held" -ne 0 ]; then
    bad "3 $label: while paused between attempts the file held $held table lock(s)"
  elif [ "$expect" = "fail" ] && [ "$sleeping" -lt 1 ]; then
    bad "3 $label: never saw the file pause between attempts ($samples samples)"
  fi
  if [ "$expect" = "fail" ]; then
    if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err" \
       && [ $((t1 - t0)) -ge 1500 ] && [ $((t1 - t0)) -lt 10000 ]; then
      ok "3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused ($sleeping paused samples, 0 locks), then failed 55P03 and wrote nothing"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  else
    if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
      ok "3 $label: the holder let go after ${secs} s and the file retried past it, ran to the end after $((t1 - t0)) ms ($sleeping paused samples, 0 locks while paused; rolled back)"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  fi
  # The next case must meet its own holder only.
  wait "$hp"
}
run_behind order-reader "select count(*) from public.order_requests;" 9 fail
run_behind line-lock "select 1 from public.order_request_lines where id = '$LINE' for update;" 9 fail
run_behind auth-reader "select count(*) from auth.users;" 9 fail
run_behind stock-write "update public.inventory_items set name = name where id = '$ITEM';" 9 fail
run_behind 3b-short-order-reader "select count(*) from public.order_requests;" 0.6 apply

# ── 4 and 5. The two deadlock shapes, each already holding its first lock ─
shape() { # shape <label> <first lock sql> <second step sql>
  local label="$1" app="0395-lock-shape-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(1.5);\n%s\ncommit;\nselect 'SHAPE_DONE';\n" "$app" "$2" "$3" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.s.out" 2>&1 &
  local sp=$!
  if ! wait_sleeping "$app"; then bad "$label: the order write never reached pg_sleep"; wait "$sp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.m.out" 2> "$TMP/$label.m.err"
  rc=$?
  t1="$(now_ms)"
  wait "$sp"
  if grep -qE '40P01|40001|deadlock' "$TMP/$label.m.err"; then
    bad "$label: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/$label.m.err" | cut -c1-300)"
  elif [ $rc -eq 0 ]; then
    ok "$label: the file retried until the order write committed, then ran to the end after $((t1 - t0)) ms (rolled back), no 40P01"
  elif grep -q '55P03' "$TMP/$label.m.err"; then
    ok "$label: the file failed 55P03 after $((t1 - t0)) ms, no 40P01"
  else
    bad "$label: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/$label.m.err" | cut -c1-300)"
  fi
  if grep -q '^SHAPE_DONE$' "$TMP/$label.s.out" && ! grep -qE '40P01|40001|deadlock' "$TMP/$label.s.out"; then
    ok "$label: the order write completed, no 40P01"
  else
    bad "$label: the order write: $(tr '\n' ' ' < "$TMP/$label.s.out" | cut -c1-300)"
  fi
}
shape "4-cancel-shape" \
  "select 1 from public.order_requests where id = '$ORD' for update;" \
  "update public.order_request_lines set quantity_picked = null where order_request_id = '$ORD';"
shape "5-partial-pick-shape" \
  "select 1 from public.order_request_lines where id = '$LINE' for update;" \
  "select 1 from public.order_requests where id = '$ORD' for update;"
shape "5b-stock-shape" \
  "update public.inventory_items set name = name where id = '$ITEM';" \
  "select 1 from public.order_requests where id = '$ORD' for update;"

# ── 6. While the file holds its locks, new readers wait only for the hold ─
{
  echo "set application_name = '0395-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping 0395-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  for target in public.order_requests auth.users; do
    t0="$(now_ms)"
    R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    t1="$(now_ms)"
    if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
      ok "6: a new reader of $target waited for the hold only and read after $((t1 - t0)) ms"
    else
      bad "6: a new reader of $target: $R after $((t1 - t0)) ms"
    fi
  done
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.inventory_items;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 500 ]; then
    ok "6: a new reader of public.inventory_items did not wait for the hold ($((t1 - t0)) ms)"
  else
    bad "6: a new reader of public.inventory_items: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/6m.err"; then bad "6: the migration session reported: $(tr '\n' ' ' < "$TMP/6m.err")"; fi

# ── 7. CONTROL: without the prelude the cancel shape deadlocks ────────────
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "7: could not build the no-prelude control file"
else
  printf "set application_name = '0395-lock-control';\nbegin;\nselect 1 from public.order_requests where id = '%s' for update;\nselect pg_sleep(1.5);\nupdate public.order_request_lines set quantity_picked = null where order_request_id = '%s';\ncommit;\nselect 'SHAPE_DONE';\n" "$ORD" "$ORD" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.s.out" 2>&1 &
  sp=$!
  if wait_sleeping 0395-lock-control; then
    { echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.m.out" 2> "$TMP/7.m.err"
    wait "$sp"
    S40="$(grep -c '40P01' "$TMP/7.s.out" || true)"
    M40="$(grep -c '40P01' "$TMP/7.m.err" || true)"
    if [ $((S40 + M40)) -ge 1 ]; then
      ok "7: without the prelude one side got 40P01 (order write: $S40, file: $M40): the hazard is real, and the prelude removes it (case 4)"
    else
      bad "7: the control did not reproduce the deadlock (order write: $(tr '\n' ' ' < "$TMP/7.s.out" | cut -c1-200); file: $(tr '\n' ' ' < "$TMP/7.m.err" | cut -c1-200))"
    fi
  else
    bad "7: the control order write never reached pg_sleep"
    wait "$sp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
FN_AFTER="$(q "select count(*) from pg_proc where proname = 'tg_inventory_items_no_delete_with_stock'")"
POL_AFTER="$(q "select md5(string_agg(policyname || coalesce(qual, '') || coalesce(with_check, ''), '' order by policyname)) from pg_policies where tablename in ('order_requests', 'order_request_lines')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$FN_AFTER" = "0" ] && [ "$POL_AFTER" = "$POL_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, no 0395 trigger function, the order policies as before)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, functions $FN_AFTER, policies changed: $([ "$POL_AFTER" = "$POL_BEFORE" ] && echo no || echo yes))"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
