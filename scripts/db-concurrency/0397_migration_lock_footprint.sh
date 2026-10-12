#!/usr/bin/env bash
#
# Lock footprint of migration 0397 (returns RX-4, the follow-ups). The push
# runs the whole file as one batch, so every table lock a statement takes is
# held until the file commits. The functions (plpgsql) lock no table; the
# only table statement is the ALTER TABLE on return_decisions (its kind CHECK
# and the new shape CHECK), which takes ACCESS EXCLUSIVE there, so the file
# takes that lock in one NOWAIT prelude (`do $lock$ ... end $lock$;`) and never
# waits holding one. No policy statement, so supautils takes nothing more.
# Written at the RX-4 desk stage (2026-10-11) and RUN AT THE TEST STAGE.
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight, the functions, their grants and comments).
#   1b. The prelude takes ACCESS EXCLUSIVE on return_decisions and nothing
#       else.
#   1c. No statement after the prelude locks another existing table.
#   2.  The hold, from the prelude to the end of the file, is under 250 ms on
#       the local stack.
#   3.  A reader of return_decisions with an open transaction, held longer
#       than the retries last: the file retries, holds NO table lock whenever
#       it is paused between attempts, and fails 55P03, writing nothing.
#       3b: the same reader held 0.6 s: the file retries past it and runs to
#       the end.
#
# The migration sessions ALWAYS roll back. It needs the pre-0397 head with
# 0396 applied. LOCAL stack only (docker container supabase_db_stockpilot).
# Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0397_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(ls "$REPO"/supabase/migrations/*_returns_followups.sql 2>/dev/null | head -n 1)"
TMP="$(mktemp -d)"

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
cleanup() { wait 2> /dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_returns_followups.sql"; exit 1; }
HAS_NEW="$(q "select count(*) from pg_proc where proname = 'close_return_replacement_rest'")"
HAS_RX2="$(q "select count(*) from pg_proc where proname = 'change_return_replacement'")"
if [ "$HAS_NEW" != "0" ] || [ "$HAS_RX2" = "0" ]; then
  echo "needs the pre-0397 head with RX-2 applied (supabase db reset --local --version <the migration before 0397>)"
  exit 1
fi

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

# ── 1 and 2 ──────────────────────────────────────────────────────────────
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
  if [ "$BEFORE" = "none" ]; then ok "1a: the preflight, the functions, their grants and comments lock no table"
  else bad "1a: before the prelude the file already holds: $BEFORE"; fi
  if [ "$PRELUDE" = "public.return_decisions:AccessExclusiveLock" ]; then ok "1b: the prelude takes exactly return_decisions (exclusive)"
  else bad "1b: the prelude took: $PRELUDE"; fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then ok "1c: nothing after the prelude locks another existing table"
  else bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"; fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 250 ]; then ok "2: the prelude to the end of the file took $((T1 - T0)) ms"
  else bad "2: the prelude to the end of the file took $((T1 - T0)) ms"; fi
fi

# ── 3. An open transaction on return_decisions ───────────────────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0397-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0397-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0397-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
    if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err"; then
      ok "3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused, then failed 55P03 and wrote nothing"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  else
    if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
      ok "3 $label: the file retried past the holder and ran to the end after $((t1 - t0)) ms (rolled back)"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  fi
  wait "$hp"
}
run_behind decisions-reader "select count(*) from public.return_decisions;" 9 fail
run_behind 3b-short-decisions-reader "select count(*) from public.return_decisions;" 0.6 apply

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
