#!/usr/bin/env bash
#
# Lock footprint of migration 0394 (returns RX-1). The push runs the whole
# file as one batch, so every table lock a statement takes is held until the
# file commits. ALTER POLICY and CREATE POLICY take ACCESS EXCLUSIVE on their
# table, and on this image (supautils 3.4.0) supautils also takes ACCESS
# EXCLUSIVE on every table supautils.policy_grants lists for the role (auth,
# storage, realtime). The new decision log's foreign keys add RI triggers on
# organizations, inventory_items and order_requests (SHARE ROW EXCLUSIVE),
# and the RMA functions lock an RMA row and then items, so the file takes
# every lock in one NOWAIT prelude (`do $lock$ ... end $lock$;`) and never
# waits holding one. A busy table fails one attempt; the attempt's
# subtransaction rolls back (releasing what it took) and the prelude retries
# after a pause, up to 40 times, holding no table lock in between. This
# proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight, the plpgsql functions, their grants and
#       comments lock nothing).
#   1b. The prelude takes ACCESS EXCLUSIVE on returns, return_lines and
#       notification_preferences, SHARE ROW EXCLUSIVE on organizations,
#       inventory_items and order_requests, and ACCESS EXCLUSIVE on every
#       existing table in supautils.policy_grants for the role, and nothing
#       else.
#   1c. No statement after the prelude locks an existing table the prelude did
#       not lock (the decision log it creates is new, so nobody else can wait
#       on it).
#   2.  The hold, from the prelude to the end of the file, is under 250 ms on
#       the local stack (production holds 6 RMAs on 2026-10-04).
#   3.  A reader with an open transaction on returns, a writer on
#       order_requests, or a reader of auth.users, held longer than the
#       retries last: the file retries, holds NO table lock whenever it is
#       paused between attempts (sampled from pg_locks), and fails 55P03 after
#       its bounded retries (40 attempts), writing nothing.
#   3b. The same returns reader held only 0.6 s: the file retries past it and
#       runs to the end.
#   4.  The RMA-function shape (an RMA row locked, then an item updated) and
#       5. the reverse shape (an item updated, then an RMA row updated), each
#       with the first lock held when the file starts: the user's write
#       completes with no error (no 40P01), and the file, which never waits
#       holding a lock, either runs to the end once the write commits or fails
#       55P03; never 40P01.
#   6.  While the file holds its locks (an artificial 1 s), a new returns
#       reader and a new auth.users reader wait only for the hold, then read;
#       a new inventory_items reader is not blocked at all (SHARE ROW
#       EXCLUSIVE lets plain reads through: the stock screens keep reading
#       during the push).
#   7.  CONTROL, the hazard the prelude removes: the same file with the prelude
#       cut out and lock_timeout 5s, against shape 5. The file holds returns
#       (its keys are built first) and waits for inventory_items (the decision
#       log's foreign key); the user's write then waits for returns; Postgres
#       ends one side with 40P01. Required: at least one 40P01 here (if this
#       ever stops reproducing, the hazard analysis in the migration header
#       needs re-reading).
#
# The migration sessions ALWAYS roll back, so the script changes nothing but
# its own fixture rows (removed at the start, the end and by the EXIT trap).
# It needs the pre-0394 head. LOCAL stack only (docker container
# supabase_db_stockpilot). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0394_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$REPO/supabase/migrations/0394_returns_lifecycle_original_rack.sql"
TMP="$(mktemp -d)"
BG=()

ORG='03952222-0000-0000-0000-00000000000a'
MGR='03952222-0000-0000-0000-0000000000a1'
WH='03952222-0000-0000-0000-0000000000c1'
ITEM='03952222-0000-0000-0000-0000000000c2'
ORD='03952222-0000-0000-0000-0000000000d1'
LINE='03952222-0000-0000-0000-0000000000e1'
RMA='03952222-0000-0000-0000-0000000000f1'

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
delete from public.returns where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id = '$ORD';
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
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

[ -f "$MIG" ] || { echo "missing $MIG"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_FN="$(q "select count(*) from pg_proc where proname = 'close_return'")"
echo "local head $HEAD_NOW; close_return present: $HAS_FN"
if [ "$HAS_FN" != "0" ]; then
  echo "needs the pre-0394 head (supabase db reset --local --version <the migration before 0394>, then the QA reseed)"
  exit 1
fi
POL_BEFORE="$(q "select md5(string_agg(policyname || coalesce(qual, '') || coalesce(with_check, ''), '' order by policyname)) from pg_policies where tablename in ('returns', 'return_lines')")"

cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0394-lock-mgr@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0394 Lock Org', '0394-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0394 Lock Main', 'WH-0394-LK', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', 'Lock item', 'SKU-0394-LK', 10, 'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
  values ('$ORD', '$ORG', '$WH', 'completed', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values ('$LINE', '$ORD', '$ITEM', 1, 1);
insert into public.returns (id, organization_id, order_request_id, return_number, status, source)
  values ('$RMA', '$ORG', '$ORD', 'RMA-LOCK-0394', 'requested', 'internal');
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
          union all select 'public.notification_preferences:AccessExclusiveLock'
          union all select 'public.order_requests:ShareRowExclusiveLock'
          union all select 'public.organizations:ShareRowExclusiveLock'
          union all select 'public.return_lines:AccessExclusiveLock'
          union all select 'public.returns:AccessExclusiveLock'
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
    ok "1a: the preflight, the functions, their grants and comments lock no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly the RMA tables and notification_preferences (exclusive), organizations, inventory_items and order_requests (share row exclusive) and the $(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vc '^public\.') supautils.policy_grants tables"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  # The decision log is created by this file: a lock on it can block no one.
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END") | grep -vx 'public.return_decisions')"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks an existing table it did not lock"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 250 ]; then
    ok "2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "2: the prelude to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3. An open transaction on a table the prelude needs ─────────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0394-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0394-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0394-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3-$label.m.out" 2> "$TMP/3-$label.m.err" &
  local mp=$!
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
  wait "$hp"
}
run_behind returns-reader "select count(*) from public.returns;" 9 fail
run_behind order-writer "update public.order_requests set notes = notes where id = '$ORD';" 9 fail
run_behind auth-reader "select count(*) from auth.users;" 9 fail
run_behind 3b-short-returns-reader "select count(*) from public.returns;" 0.6 apply

# ── 4 and 5. The two deadlock shapes, each already holding its first lock ─
shape() { # shape <label> <first lock sql> <second step sql>
  local label="$1" app="0394-lock-shape-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(1.5);\n%s\ncommit;\nselect 'SHAPE_DONE';\n" "$app" "$2" "$3" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.s.out" 2>&1 &
  local sp=$!
  if ! wait_sleeping "$app"; then bad "$label: the user write never reached pg_sleep"; wait "$sp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.m.out" 2> "$TMP/$label.m.err"
  rc=$?
  t1="$(now_ms)"
  wait "$sp"
  if grep -qE '40P01|40001|deadlock' "$TMP/$label.m.err"; then
    bad "$label: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/$label.m.err" | cut -c1-300)"
  elif [ $rc -eq 0 ]; then
    ok "$label: the file retried until the user write committed, then ran to the end after $((t1 - t0)) ms (rolled back), no 40P01"
  elif grep -q '55P03' "$TMP/$label.m.err"; then
    ok "$label: the file failed 55P03 after $((t1 - t0)) ms, no 40P01"
  else
    bad "$label: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/$label.m.err" | cut -c1-300)"
  fi
  if grep -q '^SHAPE_DONE$' "$TMP/$label.s.out" && ! grep -qE '40P01|40001|deadlock' "$TMP/$label.s.out"; then
    ok "$label: the user write completed, no 40P01"
  else
    bad "$label: the user write: $(tr '\n' ' ' < "$TMP/$label.s.out" | cut -c1-300)"
  fi
}
shape "4-rma-then-item" \
  "select 1 from public.returns where id = '$RMA' for update;" \
  "update public.inventory_items set updated_at = updated_at where id = '$ITEM';"
shape "5-item-then-rma" \
  "update public.inventory_items set updated_at = updated_at where id = '$ITEM';" \
  "update public.returns set notes = notes where id = '$RMA';"

# ── 6. While the file holds its locks, readers wait only for the hold ─────
{
  echo "set application_name = '0394-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping 0394-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.inventory_items;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 300 ]; then
    ok "6: a new inventory_items reader is not blocked by the hold ($((t1 - t0)) ms)"
  else
    bad "6: a new inventory_items reader: $R after $((t1 - t0)) ms"
  fi
  for target in public.returns auth.users; do
    t0="$(now_ms)"
    R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    t1="$(now_ms)"
    if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
      ok "6: a new reader of $target waited for the hold only and read after $((t1 - t0)) ms"
    else
      bad "6: a new reader of $target: $R after $((t1 - t0)) ms"
    fi
  done
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/6m.err"; then bad "6: the migration session reported: $(tr '\n' ' ' < "$TMP/6m.err")"; fi

# ── 7. CONTROL: without the prelude shape 5 deadlocks ─────────────────────
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock\$' "$TMP/no-prelude.sql" || [ "$(grep -c "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql")" != "2" ]; then
  bad "7: could not build the no-prelude control file"
else
  printf "set application_name = '0394-lock-control';\nbegin;\nupdate public.inventory_items set updated_at = updated_at where id = '%s';\nselect pg_sleep(1.5);\nupdate public.returns set notes = notes where id = '%s';\ncommit;\nselect 'SHAPE_DONE';\n" "$ITEM" "$RMA" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.s.out" 2>&1 &
  sp=$!
  if wait_sleeping 0394-lock-control; then
    { echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.m.out" 2> "$TMP/7.m.err"
    wait "$sp"
    S40="$(grep -c '40P01' "$TMP/7.s.out" || true)"
    M40="$(grep -c '40P01' "$TMP/7.m.err" || true)"
    if [ $((S40 + M40)) -ge 1 ]; then
      ok "7: without the prelude one side got 40P01 (user write: $S40, file: $M40): the hazard is real, and the prelude removes it (case 5)"
    else
      bad "7: the control did not reproduce the deadlock (user write: $(tr '\n' ' ' < "$TMP/7.s.out" | cut -c1-200); file: $(tr '\n' ' ' < "$TMP/7.m.err" | cut -c1-200))"
    fi
  else
    bad "7: the control user write never reached pg_sleep"
    wait "$sp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
FN_AFTER="$(q "select count(*) from pg_proc where proname in ('close_return', 'approve_return', 'return_line_sources')")"
TBL_AFTER="$(q "select count(*) from pg_class where relname in ('return_decisions', 'return_overview')")"
POL_AFTER="$(q "select md5(string_agg(policyname || coalesce(qual, '') || coalesce(with_check, ''), '' order by policyname)) from pg_policies where tablename in ('returns', 'return_lines')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$FN_AFTER" = "0" ] && [ "$TBL_AFTER" = "0" ] && [ "$POL_AFTER" = "$POL_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, no 0394 function or table, the RMA policies as before)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, functions $FN_AFTER, tables $TBL_AFTER, policies changed: $([ "$POL_AFTER" = "$POL_BEFORE" ] && echo no || echo yes))"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
