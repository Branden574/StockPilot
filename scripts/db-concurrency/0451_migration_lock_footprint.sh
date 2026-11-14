#!/usr/bin/env bash
#
# Lock footprint of migration 0451 (order photo audience and grants, docket
# S3c). The push runs the whole file as one batch, so every table lock a
# statement takes is held until the file commits. The policy statements take
# ACCESS EXCLUSIVE on order_request_attachments, schedule_events and
# storage.objects, and supautils takes ACCESS EXCLUSIVE on every table
# supautils.policy_grants lists for the role on any policy statement; the
# unique index takes SHARE on order_request_attachments; creating the SQL
# helpers and the attachments insert check reads order_requests and bundles
# (ACCESS SHARE) and storage.objects (already held ACCESS EXCLUSIVE). The
# file takes every one of these in one NOWAIT prelude (`do $lock451$ ...
# end $lock451$;`, the 0404/0415 pattern) and never waits holding one. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight reads the catalogs only, in a block it
#       always undoes).
#   1b. The prelude takes ACCESS SHARE on order_requests and bundles, ACCESS
#       EXCLUSIVE on order_request_attachments, schedule_events and
#       storage.objects, and ACCESS EXCLUSIVE on every existing table in
#       supautils.policy_grants for the role, and nothing else.
#   1c. No statement after the prelude locks a table the prelude did not lock.
#   2.  The hold, from the prelude to the end of the file, is under 200 ms.
#   3.  A holder with an open transaction on order_request_attachments,
#       schedule_events or storage.objects (a reader), held longer than the
#       retries last: the file retries, holds NO table lock whenever it is
#       paused between attempts (sampled from pg_locks), and fails 55P03 after
#       its bounded retries (40 attempts), writing nothing.
#   3b. The same attachments reader held only 0.6 s: the file retries past it
#       and runs to the end.
#   5.  While the file holds its locks (an artificial 1 s), a new reader of
#       order_request_attachments, schedule_events or storage.objects waits
#       only for the hold, then reads; a new reader of order_requests does not
#       wait at all (ACCESS SHARE).
#
# The migration sessions ALWAYS roll back, so the script changes nothing.
# It needs the pre-0451 head. LOCAL stack only (docker container
# supabase_db_stockpilot by default; CONTAINER=<name> for another local
# stack). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0451_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rebase.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_order_photo_audience_and_grants.sql' | sort | tail -n 1)}"
TMP="$(mktemp -d)"
BG=()

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
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local p
  for p in "${BG[@]:-}"; do [ -n "$p" ] && wait "$p" 2> /dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the order photo audience migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_IT="$(q "select count(*) from pg_proc where proname = 'order_signature_photo_reader'")"
STATE_SQL="select md5(string_agg(x, '|' order by x)) from (
  select n.nspname || '.' || c.relname || '.' || pol.polname || ':' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
         || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') as x
    from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
   where pol.polrelid in ('public.order_request_attachments'::regclass, 'public.schedule_events'::regclass)
      or (pol.polrelid = 'storage.objects'::regclass and pol.polname like 'order-attachments %')
  union all
  select c.oid::regclass::text || ':' || coalesce(c.relacl::text, '') from pg_class c
   where c.oid in ('public.order_request_attachments'::regclass, 'public.shipments'::regclass,
                   'public.shipment_lines'::regclass, 'public.order_requests'::regclass)
  union all
  select 'index:' || (to_regclass('public.order_request_attachments_storage_path_key') is not null)::text) s"
echo "local head $HEAD_NOW; 0451 helper present: $HAS_IT; file $(basename "$MIG")"
if [ "$HAS_IT" != "0" ]; then
  echo "needs the pre-0451 head (supabase db reset --local --version <the migration before it>)"
  exit 1
fi
STATE_BEFORE="$(q "$STATE_SQL")"

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock451$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock451\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock451\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
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
          select distinct x from (
            select 'public.order_requests:AccessShareLock' as x
            union all select 'public.bundles:AccessShareLock'
            union all select 'public.order_request_attachments:AccessExclusiveLock'
            union all select 'public.schedule_events:AccessExclusiveLock'
            union all select 'storage.objects:AccessExclusiveLock'
            union all select n.nspname || '.' || c.relname || ':AccessExclusiveLock'
              from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb)) t(name)
              join pg_class c on c.oid = to_regclass(t.name) join pg_namespace n on n.oid = c.relnamespace) u) e;"
  cat "$TMP/part3.sql"
  echo "select 'T1|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'END|' || coalesce(($LOCKS_SQL), 'none');"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
POLICY_GRANT_TABLES=0
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
else
  BEFORE="$(sed -n 's/^BEFORE|//p' "$TMP/1.out")"
  PRELUDE="$(sed -n 's/^PRELUDE|//p' "$TMP/1.out")"
  EXPECTED="$(sed -n 's/^EXPECTED|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  POLICY_GRANT_TABLES="$(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vc '^public\.\|^storage\.objects:')"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the preflight locks no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly order_requests and bundles (access share), order_request_attachments, schedule_events and storage.objects (access exclusive) and the $POLICY_GRANT_TABLES other supautils.policy_grants tables"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks a table it did not lock (held at the end: $END)"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 200 ]; then
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
 where a.application_name like '0451-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0451-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0451-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
run_behind attachments-reader "select count(*) from public.order_request_attachments;" 9 fail
run_behind schedule-reader "select count(*) from public.schedule_events;" 9 fail
run_behind storage-reader "select count(*) from storage.objects;" 9 fail
run_behind 3b-short-attachments-reader "select count(*) from public.order_request_attachments;" 0.6 apply

# ── 5. While the file holds its locks, new readers wait only for the hold ─
{
  echo "set application_name = '0451-lock-migration-5';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/5m.out" 2> "$TMP/5m.err" &
BG+=("$!")
if ! wait_sleeping 0451-lock-migration-5; then
  bad "5: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/5m.err")"
else
  for target in public.order_request_attachments public.schedule_events storage.objects; do
    t0="$(now_ms)"
    R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    t1="$(now_ms)"
    if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
      ok "5: a new reader of $target waited for the hold only and read after $((t1 - t0)) ms"
    else
      bad "5: a new reader of $target: $R after $((t1 - t0)) ms"
    fi
  done
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.order_requests;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 500 ]; then
    ok "5: a new reader of public.order_requests did not wait for the hold ($((t1 - t0)) ms)"
  else
    bad "5: a new reader of public.order_requests: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/5m.err"; then bad "5: the migration session reported: $(tr '\n' ' ' < "$TMP/5m.err")"; fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_AFTER="$(q "$STATE_SQL")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$STATE_AFTER" = "$STATE_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW; the attachment, schedule and bucket policies, the table privileges and the absent index as before)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, state changed: $([ "$STATE_AFTER" = "$STATE_BEFORE" ] && echo no || echo yes))"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
