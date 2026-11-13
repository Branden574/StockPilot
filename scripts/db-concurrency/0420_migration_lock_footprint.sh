#!/usr/bin/env bash
#
# Lock footprint of migration 0420 (the permission override UPDATE rules ask
# what the DELETE rules ask, docket S62). The push runs the whole file as one
# batch, so every table lock a statement takes is held until the file
# commits. DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on
# public.user_permission_overrides and public.role_permission_overrides, and
# on this image (supautils 3.4.0) supautils also takes ACCESS EXCLUSIVE on
# every table supautils.policy_grants lists for the role (auth, storage,
# realtime: auth.users and auth.sessions among them). The preflight reads
# catalogs and deparses the rules in a block it always undoes. A file that
# took one of those tables and then waited for another would make every
# reader of the first (has_permission reads both override tables inside many
# rules; a sign-in reads auth.users) queue behind it for the whole wait, so
# the file takes every lock in one NOWAIT prelude (`do $lock_s62$ ... end
# $lock_s62$;`, the 0390, 0395, 0400 and 0415 one) and never waits holding
# one. A busy table fails one attempt; the attempt's subtransaction rolls back
# (releasing what it took) and the prelude retries after a pause, up to 40
# times, holding no table lock in between. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight's deparse ran in its undone block).
#   1b. The prelude takes ACCESS EXCLUSIVE on the two override tables and on
#       every existing table in supautils.policy_grants for the role, and
#       nothing else. Control: that list holds at least 20 tables here, so the
#       check is not judging the two tables alone.
#   1c. No statement after the prelude locks a table the prelude did not lock
#       (so the file can never wait while holding one). Tables, not modes.
#   2.  The hold, from the prelude to the end of the file, is under 100 ms.
#   3.  A holder with an open transaction on public.user_permission_overrides
#       (a reader), on auth.users (a reader) or on realtime.subscription (a
#       reader), held longer than the retries last: the file retries, holds NO
#       table lock whenever it is paused between attempts (sampled from
#       pg_locks), and fails 55P03 after its bounded retries (40 attempts),
#       writing nothing.
#   3b. The same override reader held only 0.6 s: the file retries past it
#       and runs to the end (the retry turns a busy instant into a clean
#       apply).
#   6.  While the file holds its locks (an artificial 1 s), a new reader of
#       public.role_permission_overrides and a new auth.users reader wait only
#       for the hold, then read.
#   7.  CONTROL, the hazard the prelude removes: the same file with the
#       prelude cut out and lock_timeout 5s, with a reader holding auth.users.
#       The rule statement holds the tables it locked before auth.users while
#       it waits for it (the script prints them: that is the order the kit's
#       lock set records), and a new reader of one of them (an override table
#       when it is among them) queues behind the file for most of the wait.
#       Required: the file held at least one table while waiting, and the new
#       reader waited at least 1.5 s (if this ever stops reproducing, the
#       hazard analysis in the migration header needs re-reading).
#
# The migration sessions ALWAYS roll back, so the script changes nothing and
# writes no rows. It needs the pre-0420 head. LOCAL stack only (docker
# container supabase_db_stockpilot by default; CONTAINER=<name> for another
# local stack). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0420_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rename.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_permission_override_updates_follow_0322.sql' | sort | tail -n 1)}"
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

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the permission override UPDATE rules migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_SQL="select md5(coalesce((select string_agg(pol.polname || ':' || pg_get_expr(pol.polqual, pol.polrelid) || ':'
                                                 || pg_get_expr(pol.polwithcheck, pol.polrelid), '|' order by pol.polname)
                                  from pg_policy pol
                                 where pol.polrelid in ('public.user_permission_overrides'::regclass,
                                                        'public.role_permission_overrides'::regclass)
                                   and pol.polcmd = 'w'), '-'))"
OLD_POLICY="$(q "select count(*) from pg_policy pol where pol.polrelid in ('public.user_permission_overrides'::regclass, 'public.role_permission_overrides'::regclass) and pol.polcmd = 'w' and pg_get_expr(pol.polqual, pol.polrelid) not like '%has_permission%'")"
echo "local head $HEAD_NOW; UPDATE rules whose USING does not ask has_permission yet: $OLD_POLICY of 2; file $(basename "$MIG")"
if [ "$OLD_POLICY" != "2" ]; then
  echo "needs the pre-0420 head (supabase db reset --local --version <the migration before it>, then the QA reseed)"
  exit 1
fi
STATE_BEFORE="$(q "$STATE_SQL")"

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock_s62$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock_s62\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock_s62\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
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
          select 'public.role_permission_overrides:AccessExclusiveLock' as x
          union select 'public.user_permission_overrides:AccessExclusiveLock'
          union select n.nspname || '.' || c.relname || ':AccessExclusiveLock'
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
  NGRANTS="$(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vcE '^public\.(role|user)_permission_overrides:')"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the preflight locks no table (its deparse ran in the undone block)"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$NGRANTS" -lt 20 ]; then
    bad "1b control: supautils.policy_grants lists only $NGRANTS existing tables for this role here (expected 20 or more): 1b and 1c would judge the two override tables alone"
  elif [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly the two override tables and the $NGRANTS supautils.policy_grants tables, ACCESS EXCLUSIVE"
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
 where a.application_name like '0420-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0420-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0420-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
run_behind override-reader "select count(*) from public.user_permission_overrides;" 9 fail
run_behind auth-reader "select count(*) from auth.users;" 9 fail
run_behind realtime-reader "select count(*) from realtime.subscription;" 9 fail
run_behind 3b-short-override-reader "select count(*) from public.user_permission_overrides;" 0.6 apply

# ── 6. While the file holds its locks, new readers wait only for the hold ─
{
  echo "set application_name = '0420-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping 0420-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  for target in public.role_permission_overrides auth.users; do
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

# ── 7. CONTROL: without the prelude, a reader queues behind a waiting file ─
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock_s62\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "7: could not build the no-prelude control file"
else
  printf "set application_name = '0420-lock-control-holder';\nbegin;\nselect count(*) from auth.users;\nselect pg_sleep(4);\ncommit;\n" \
    | "${PSQL[@]}" > "$TMP/7.h.out" 2>&1 &
  hp=$!
  if ! wait_sleeping 0420-lock-control-holder; then
    bad "7: the auth.users holder never reached pg_sleep"
    wait "$hp"
  else
    { echo "set application_name = '0420-lock-control-file';"; echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } \
      | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.m.out" 2> "$TMP/7.m.err" &
    mp=$!
    # Wait until the file is blocked on a table, then read what it holds.
    WAITING_FOR="" HELD=""
    for _ in $(seq 1 60); do
      WAITING_FOR="$(q "select string_agg(n.nspname || '.' || c.relname, ',') from pg_locks l
                          join pg_stat_activity a on a.pid = l.pid
                          join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
                         where a.application_name = '0420-lock-control-file' and l.locktype = 'relation' and not l.granted")"
      if [ -n "$WAITING_FOR" ]; then
        HELD="$(q "select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) from pg_locks l
                     join pg_stat_activity a on a.pid = l.pid
                     join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
                    where a.application_name = '0420-lock-control-file' and l.locktype = 'relation' and l.granted
                      and c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema')")"
        break
      fi
      sleep 0.05
    done
    if [ -z "$WAITING_FOR" ]; then
      bad "7: the file never waited for auth.users (stderr: $(tr '\n' ' ' < "$TMP/7.m.err" | cut -c1-200))"
    elif [ -z "$HELD" ]; then
      bad "7: the file waited for $WAITING_FOR holding no table, so the control did not reproduce the hazard"
    else
      echo "       7: the file waits for $WAITING_FOR while holding: $HELD"
      TARGET="$(printf '%s' "$HELD" | tr ',' '\n' | grep -m 1 -xE 'public\.(role|user)_permission_overrides' || printf '%s' "$HELD" | tr ',' '\n' | head -n 1)"
      t0="$(now_ms)"
      R="$(printf "set lock_timeout = '10s';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$TARGET" | "${PSQL[@]}" 2>&1)"
      t1="$(now_ms)"
      if [ "$R" = "read:true" ] && [ $((t1 - t0)) -ge 1500 ]; then
        ok "7: without the prelude a new reader of $TARGET queued behind the waiting file for $((t1 - t0)) ms: the hazard is real, and the prelude removes it (cases 3 and 6)"
      else
        bad "7: a new reader of $TARGET: $R after $((t1 - t0)) ms (expected a wait of 1.5 s or more)"
      fi
    fi
    wait "$mp"
    wait "$hp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_AFTER="$(q "$STATE_SQL")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$STATE_AFTER" = "$STATE_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, the two UPDATE rules as before)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, rules changed: $([ "$STATE_AFTER" = "$STATE_BEFORE" ] && echo no || echo yes))"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
