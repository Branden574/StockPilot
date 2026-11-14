#!/usr/bin/env bash
#
# Lock footprint of migration 0458 (an organization that has members keeps an
# owner). The push runs the whole file as one batch, so every table lock a
# statement takes is held until the file commits. CREATE CONSTRAINT TRIGGER
# takes SHARE ROW EXCLUSIVE on public.organization_members (it conflicts with
# every write of the table, ROW EXCLUSIVE, and with no read); COMMENT ON
# TRIGGER takes SHARE UPDATE EXCLUSIVE on the same table; CREATE FUNCTION,
# REVOKE and COMMENT ON FUNCTION lock no table; the preflight reads catalogs
# only. The file takes its one table lock first, in a NOWAIT prelude
# (`do $lock$ ... end $lock$;`, the 0390 pattern): a busy table fails one
# attempt, the attempt's subtransaction rolls back, and the prelude retries
# after a pause, up to 40 times, holding no table lock in between. This
# proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs.
#   1b. The prelude takes SHARE ROW EXCLUSIVE on public.organization_members
#       and nothing else.
#   1c. No statement after the prelude locks a table the prelude did not lock
#       (so the file can never wait while holding one; one table only, so
#       there is no lock order to get wrong).
#   2.  The hold, from the prelude to the end of the file, is under 100 ms.
#   3.  A writer with an open transaction on public.organization_members (ROW
#       EXCLUSIVE), held longer than the retries last: the file retries,
#       holds NO table lock whenever it is paused between attempts (sampled
#       from pg_locks), and fails 55P03 after its bounded retries, writing
#       nothing.
#   3b. The same writer held only 0.6 s: the file retries past it and runs to
#       the end.
#   3c. A reader with an open transaction on the table (ACCESS SHARE): the
#       file does not wait for it at all.
#   6.  While the file holds its lock (an artificial 1 s), a new reader of the
#       table reads at once and a new writer waits only for the hold.
#
# The migration sessions ALWAYS roll back, so the script changes nothing and
# writes no rows. It needs the pre-0458 head (no owner-present triggers).
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack). Exit status 0 = every check
# passed.
#
# Usage: bash scripts/db-concurrency/0458_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rename.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_organization_keeps_an_owner.sql' | sort | tail -n 1)}"
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

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the organization keeps an owner migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_SQL="select count(*) from pg_trigger where tgrelid = 'public.organization_members'::regclass and tgname like 'organization\_members\_owner\_present\_%'"
STATE_BEFORE="$(q "$STATE_SQL")"
echo "local head $HEAD_NOW; owner-present triggers present: $STATE_BEFORE; file $(basename "$MIG")"
if [ "$STATE_BEFORE" != "0" ]; then
  echo "needs the pre-0458 head (supabase db reset --local --version <the migration before it>)"
  exit 1
fi

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
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: before the prelude the file holds no table lock"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "public.organization_members:ShareRowExclusiveLock" ]; then
    ok "1b: the prelude takes exactly public.organization_members, SHARE ROW EXCLUSIVE"
  else
    bad "1b: the prelude took: $PRELUDE"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks a table it did not lock (at the end: $END)"
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

# ── 3. An open transaction on the table ─────────────────────────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0458-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply|nowait>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0458-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0458-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
  case "$expect" in
    (fail)
      if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err" \
         && [ $((t1 - t0)) -ge 1500 ] && [ $((t1 - t0)) -lt 10000 ]; then
        ok "3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused ($sleeping paused samples, 0 locks), then failed 55P03 and wrote nothing"
      else
        bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi;;
    (apply)
      if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
        ok "3 $label: the holder let go after ${secs} s and the file retried past it, ran to the end after $((t1 - t0)) ms ($sleeping paused samples, 0 locks while paused; rolled back)"
      else
        bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi;;
    (nowait)
      if [ $rc -eq 0 ] && [ "$sleeping" -eq 0 ] && [ $((t1 - t0)) -lt 1500 ]; then
        ok "3 $label: the file did not wait for the open reader and ran to the end after $((t1 - t0)) ms (rolled back)"
      else
        bad "3 $label: rc $rc after $((t1 - t0)) ms, $sleeping paused samples: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi;;
  esac
  wait "$hp"
}
run_behind members-writer "lock table public.organization_members in row exclusive mode;" 9 fail
run_behind 3b-short-members-writer "lock table public.organization_members in row exclusive mode;" 0.6 apply
run_behind 3c-members-reader "select count(*) from public.organization_members;" 3 nowait

# ── 6. While the file holds its lock ─────────────────────────────────────
{
  echo "set application_name = '0458-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping 0458-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.organization_members;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 500 ]; then
    ok "6: a new reader of public.organization_members read at once ($((t1 - t0)) ms)"
  else
    bad "6: a new reader: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nbegin;\nlock table public.organization_members in row exclusive mode;\nselect 'write:ok';\nrollback;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "write:ok" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "6: a new writer of public.organization_members waited for the hold only ($((t1 - t0)) ms)"
  else
    bad "6: a new writer: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/6m.err"; then bad "6: the migration session reported: $(tr '\n' ' ' < "$TMP/6m.err")"; fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_AFTER="$(q "$STATE_SQL")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$STATE_AFTER" = "$STATE_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, no owner-present trigger)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, owner-present triggers $STATE_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
