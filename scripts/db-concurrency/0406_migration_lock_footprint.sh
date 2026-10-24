#!/usr/bin/env bash
#
# Lock footprint of migration 0406 (receiving checklist, F4-1; the file is
# found by its name, so a renumber at push time needs no edit here). The push
# runs the whole file as one batch, so every table lock a statement takes is
# held until the file commits. The two new tables' foreign keys add RI
# triggers on organizations, receipts, purchase_orders, warehouses,
# procedures and user_profiles (SHARE ROW EXCLUSIVE), and CREATE POLICY makes
# supautils take ACCESS EXCLUSIVE on every table supautils.policy_grants lists
# for the role (auth, storage, realtime). So the file takes every lock in one
# NOWAIT prelude (`do $lock$ ... end $lock$;`) and never waits holding one. A
# busy table fails one attempt; the attempt's subtransaction rolls back
# (releasing what it took) and the prelude retries after a pause, up to 40
# times, holding no table lock in between. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs.
#   1b. The prelude takes SHARE ROW EXCLUSIVE on organizations, receipts,
#       purchase_orders, warehouses, procedures and user_profiles, and ACCESS
#       EXCLUSIVE on every existing table in supautils.policy_grants for the
#       role, and nothing else.
#   1c. No statement after the prelude locks an existing table the prelude did
#       not lock (the two tables it creates are new: nobody else can wait on
#       them).
#   2.  The hold, from the prelude to the end of the file, is under 250 ms on
#       the local stack.
#   3.  A writer on user_profiles, a writer on receipts or a reader of
#       auth.users, held longer than the retries last: the file retries,
#       holds NO table lock whenever it is paused between attempts (sampled
#       from pg_locks), and fails 55P03 after its bounded retries (40
#       attempts), writing nothing.
#   3b. The same receipts writer held only 0.6 s: the file retries past it and
#       runs to the end.
#   4.  A profile updated, then a receipt updated, and 5. the reverse shape,
#       each with the first lock held when the file starts: the user's write
#       completes with no error (no 40P01), and the file, which never waits
#       holding a lock, either runs to the end once the write commits or fails
#       55P03; never 40P01.
#   6.  While the file holds its locks (an artificial 1 s), a new receipts
#       reader is not blocked at all (SHARE ROW EXCLUSIVE lets plain reads
#       through: the PO pages keep reading during the push), while a receipts
#       writer and an auth.users reader wait only for the hold.
#   7.  CONTROL, the hazard the prelude removes: the same file with the prelude
#       cut out and lock_timeout 5s, against shape 5. The file holds
#       user_profiles (checklist_versions' keys are built first) and waits for
#       receipts (checklist_runs' key); the user's write then waits for
#       user_profiles; Postgres ends one side with 40P01. Required: at least
#       one 40P01 here (if this ever stops reproducing, the hazard analysis in
#       the migration header needs re-reading).
#
# The migration sessions ALWAYS roll back, so the script changes nothing but
# its own fixture rows (removed at the start, the end and by the EXIT trap).
# It needs the head just before the receiving checklist migration. LOCAL stack
# only (docker container supabase_db_stockpilot). Exit status 0 = every check
# passed.
#
# Usage: bash scripts/db-concurrency/0406_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(find "$REPO/supabase/migrations" -name '*_receiving_checklist.sql' | sort | tail -n 1)"
TMP="$(mktemp -d)"
BG=()

ORG='04062222-0000-0000-0000-00000000000a'
MGR='04062222-0000-0000-0000-0000000000a1'
WH='04062222-0000-0000-0000-0000000000c1'
ITEM='04062222-0000-0000-0000-0000000000c2'
PO='04062222-0000-0000-0000-0000000000d1'
RCPT='04062222-0000-0000-0000-0000000000e1'

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
delete from public.receipts where organization_id = '$ORG';
delete from public.purchase_orders where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
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

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing *_receiving_checklist.sql"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_TBL="$(q "select count(*) from pg_class where relname in ('checklist_versions', 'checklist_runs')")"
echo "local head $HEAD_NOW; checklist tables present: $HAS_TBL"
if [ "$HAS_TBL" != "0" ]; then
  echo "needs the head before the receiving checklist (supabase db reset --local --version <the migration before it>, then the QA reseed)"
  exit 1
fi

cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0406-lock-mgr@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0406 Lock Org', '0406-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0406 Lock Main', 'WH-0406-LK', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', 'Lock item', 'SKU-0406-LK', 0, 'active');
insert into public.purchase_orders (id, organization_id, po_number, status) values ('$PO', '$ORG', 'PO-0406-LK', 'partially_received');
insert into public.receipts (id, organization_id, purchase_order_id, warehouse_id, receipt_number, status, received_by, immutable_hash)
  values ('$RCPT', '$ORG', '$PO', '$WH', 'R-0406-LK', 'posted', '$MGR', md5('lock'));
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
  echo "select 'EXPECTED|' || string_agg(distinct x, ',' order by x) from (
          select 'public.organizations:ShareRowExclusiveLock' as x
          union all select 'public.procedures:ShareRowExclusiveLock'
          union all select 'public.purchase_orders:ShareRowExclusiveLock'
          union all select 'public.receipts:ShareRowExclusiveLock'
          union all select 'public.user_profiles:ShareRowExclusiveLock'
          union all select 'public.warehouses:ShareRowExclusiveLock'
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
    ok "1a: the header and its setting lock no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly the six referenced tables (share row exclusive) and the $(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vc '^public\.') supautils.policy_grants tables"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  # The two tables are created by this file: a lock on them can block no one.
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END") | grep -vxE 'public\.checklist_(versions|runs)')"
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
 where a.application_name like '0406-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0406-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0406-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
run_behind profile-writer "update public.user_profiles set full_name = full_name where id = '$MGR';" 9 fail
run_behind receipt-writer "update public.receipts set notes = notes where id = '$RCPT';" 9 fail
run_behind auth-reader "select count(*) from auth.users;" 9 fail
run_behind 3b-short-receipt-writer "update public.receipts set notes = notes where id = '$RCPT';" 0.6 apply

# ── 4 and 5. The two deadlock shapes, each already holding its first lock ─
shape() { # shape <label> <first lock sql> <second step sql>
  local label="$1" app="0406-lock-shape-$1"
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
shape "4-profile-then-receipt" \
  "update public.user_profiles set full_name = full_name where id = '$MGR';" \
  "update public.receipts set notes = notes where id = '$RCPT';"
shape "5-receipt-then-profile" \
  "update public.receipts set notes = notes where id = '$RCPT';" \
  "update public.user_profiles set full_name = full_name where id = '$MGR';"

# ── 6. While the file holds its locks, readers pass and writers wait ──────
{
  echo "set application_name = '0406-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping 0406-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.receipts;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 300 ]; then
    ok "6: a new receipts reader is not blocked by the hold ($((t1 - t0)) ms)"
  else
    bad "6: a new receipts reader: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nupdate public.receipts set notes = notes where id = '%s';\nselect 'write:done';\n" "$RCPT" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "write:done" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "6: a receipts writer waited for the hold only and wrote after $((t1 - t0)) ms"
  else
    bad "6: a receipts writer: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from auth.users;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "6: a new reader of auth.users waited for the hold only and read after $((t1 - t0)) ms"
  else
    bad "6: a new reader of auth.users: $R after $((t1 - t0)) ms"
  fi
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
  printf "set application_name = '0406-lock-control';\nbegin;\nupdate public.receipts set notes = notes where id = '%s';\nselect pg_sleep(1.5);\nupdate public.user_profiles set full_name = full_name where id = '%s';\ncommit;\nselect 'SHAPE_DONE';\n" "$RCPT" "$MGR" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.s.out" 2>&1 &
  sp=$!
  if wait_sleeping 0406-lock-control; then
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
TBL_AFTER="$(q "select count(*) from pg_class where relname in ('checklist_versions', 'checklist_runs')")"
FN_AFTER="$(q "select count(*) from pg_proc where proname in ('checklist_publish', 'checklist_retire', 'receiving_check_start', 'checklist_run_save')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$TBL_AFTER" = "0" ] && [ "$FN_AFTER" = "0" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, no checklist table or function)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, tables $TBL_AFTER, functions $FN_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
