#!/usr/bin/env bash
#
# Lock footprint of the migration with which the database records role and
# sign-in policy changes in the audit log
# (supabase/migrations/*_role_and_sign_in_policy_changes_recorded_by_database.sql).
# The push runs the whole file as one batch, so every table lock a statement
# takes is held until the file commits. CREATE TRIGGER takes SHARE ROW
# EXCLUSIVE on its table: public.organizations, public.organization_members
# and public.audit_logs. That mode makes writers of the table wait and lets
# readers through. There is no rule statement, so supautils takes nothing.
# A file that took one of those tables and then waited for another would
# make every writer of the first queue behind it for the whole wait, so the
# file takes the three in one NOWAIT prelude (`do $lock_rec$ ... end
# $lock_rec$;`, the 0390, 0395, 0420 and 0423 one) and never waits holding
# one. A busy table fails one attempt; the attempt's subtransaction rolls
# back (releasing what it took) and the prelude retries after a pause, up to
# 40 times, holding no table lock in between. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight reads catalogs only).
#   1b. The prelude takes SHARE ROW EXCLUSIVE on the three tables, and
#       nothing else.
#   1c. No statement after the prelude locks a table the prelude did not lock
#       (so the file can never wait while holding one). Tables, not modes.
#   2.  The hold, from the prelude to the end of the file, is under 100 ms.
#   3.  A writer with an open transaction on public.audit_logs, on
#       public.organization_members or on public.organizations, held longer
#       than the retries last: the file retries, holds NO table lock whenever
#       it is paused between attempts (sampled from pg_locks), and fails
#       55P03 after its bounded retries (40 attempts), writing nothing.
#   3b. The same audit_logs writer held only 0.6 s: the file retries past it
#       and runs to the end (the retry turns a busy instant into a clean
#       apply).
#   4.  A reader with an open transaction on public.organization_members
#       (the table row rules read on every request): the file does not wait
#       for it at all, and runs to the end with no retry.
#   6.  While the file holds its locks (an artificial 1 s): a new reader of
#       each of the three tables reads without waiting (lock_timeout 100ms);
#       a new writer of public.audit_logs cannot start within 100 ms, and
#       with room to wait it starts when the hold ends.
#   7.  CONTROL, the hazard the prelude removes: the same file with the
#       prelude cut out and lock_timeout 5s, with a writer holding
#       public.organization_members. The second CREATE TRIGGER waits for it
#       while the file already holds public.organizations (the script prints
#       what it holds), and a new writer of public.organizations queues
#       behind the file for most of the wait. Required: the file held at
#       least one table while waiting, and the new writer waited at least
#       1.5 s (if this ever stops reproducing, the hazard analysis in the
#       migration header needs re-reading).
#
# The "writers" here take the table lock a write takes (ROW EXCLUSIVE) and
# write nothing. The migration sessions ALWAYS roll back, so the script
# changes nothing and writes no rows. It needs the head before this
# migration. LOCAL stack only (docker container supabase_db_stockpilot by
# default; CONTAINER=<name> for another local stack, the migration scratch
# stack is supabase_db_spmig). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/*_migration_lock_footprint.sh (the file
# carries the migration's number; MIG=<path> runs it against the file under
# another number after a rename.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_role_and_sign_in_policy_changes_recorded_by_database.sql' | sort | tail -n 1)}"
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

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the recorded changes migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
# The six objects the file creates: 0 before it, 6 after.
STATE_SQL="select (select count(*) from pg_proc p
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('tg_record_mfa_policy_change', 'tg_record_member_role_change',
                                        'tg_audit_logs_fold_app_copy'))
                + (select count(*) from pg_trigger t
                    where not t.tgisinternal
                      and t.tgname in ('trg_zz_record_mfa_policy_change', 'trg_zz_record_member_role_change',
                                       'zz_fold_app_copy'))"
STATE_BEFORE="$(q "$STATE_SQL")"
echo "local head $HEAD_NOW; functions and triggers of this migration present: $STATE_BEFORE of 6; file $(basename "$MIG")"
if [ "$STATE_BEFORE" != "0" ]; then
  echo "needs the head before this migration (supabase db reset --local --version <the migration before it>)"
  exit 1
fi

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock_rec$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock_rec\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock_rec\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || { echo "no lock prelude in $MIG"; exit 1; }
head -n $((P0 - 1)) "$MIG" > "$TMP/part1.sql"
sed -n "${P0},${P1}p" "$MIG" > "$TMP/prelude.sql"
tail -n +$((P1 + 1)) "$MIG" > "$TMP/part3.sql"
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"
EXPECTED="public.audit_logs:ShareRowExclusiveLock,public.organization_members:ShareRowExclusiveLock,public.organizations:ShareRowExclusiveLock"

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
  echo "select 'MADE|' || ($STATE_SQL);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
else
  BEFORE="$(sed -n 's/^BEFORE|//p' "$TMP/1.out")"
  PRELUDE="$(sed -n 's/^PRELUDE|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  MADE="$(sed -n 's/^MADE|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the preflight locks no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly the three tables, SHARE ROW EXCLUSIVE"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks a table it did not lock (at the end: $END)"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  if [ "$MADE" = "6" ]; then
    ok "1d: inside the transaction the file made its three functions and three triggers"
  else
    bad "1d: inside the transaction the file made $MADE of 6 objects"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 100 ]; then
    ok "2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "2: the prelude to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3 and 4. An open transaction on a table the prelude needs ─────────────
# The file's session is named so its locks can be sampled while it pauses
# between attempts (wait_event PgSleep inside the prelude).
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like 'rec-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply|apply-now>
  local label="$1" holder="$2" secs="$3" expect="$4" app="rec-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = 'rec-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
  local holder_still
  holder_still="$(q "select count(*) from pg_stat_activity where application_name = '$app' and wait_event = 'PgSleep'")"
  if [ "$held" -ne 0 ]; then
    bad "$label: while paused between attempts the file held $held table lock(s)"
  elif [ "$expect" = "fail" ] && [ "$sleeping" -lt 1 ]; then
    bad "$label: never saw the file pause between attempts ($samples samples)"
  fi
  case "$expect" in
    fail)
      if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err" \
         && [ $((t1 - t0)) -ge 1500 ] && [ $((t1 - t0)) -lt 10000 ]; then
        ok "$label: the file retried for $((t1 - t0)) ms holding no table lock while paused ($sleeping paused samples, 0 locks), then failed 55P03 and wrote nothing"
      else
        bad "$label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi
      ;;
    apply)
      if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
        ok "$label: the holder let go after ${secs} s and the file retried past it, ran to the end after $((t1 - t0)) ms ($sleeping paused samples, 0 locks while paused; rolled back)"
      else
        bad "$label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi
      ;;
    apply-now)
      if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err" && [ "$sleeping" -eq 0 ] && [ "$holder_still" = "1" ]; then
        ok "$label: the file ran to the end in $((t1 - t0)) ms while the holder's transaction was still open, with no retry (rolled back)"
      else
        bad "$label: rc $rc after $((t1 - t0)) ms, $sleeping paused samples, holder still open: $holder_still: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi
      ;;
  esac
  # The next case must meet its own holder only.
  wait "$hp"
}
run_behind 3-audit-writer "lock table public.audit_logs in row exclusive mode;" 9 fail
run_behind 3-member-writer "lock table public.organization_members in row exclusive mode;" 9 fail
run_behind 3-organization-writer "lock table public.organizations in row exclusive mode;" 9 fail
run_behind 3b-short-audit-writer "lock table public.audit_logs in row exclusive mode;" 0.6 apply
run_behind 4-member-reader "select count(*) from public.organization_members;" 3 apply-now

# ── 6. While the file holds its locks: readers pass, writers wait for it ──
{
  echo "set application_name = 'rec-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping rec-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  for target in public.organizations public.organization_members public.audit_logs; do
    R="$(printf "set lock_timeout = '100ms';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    if [ "$R" = "read:true" ]; then
      ok "6: a new reader of $target read without waiting for the hold (lock_timeout 100ms)"
    else
      bad "6: a new reader of $target: $R"
    fi
  done
  R="$(printf "set lock_timeout = '100ms';\nbegin;\nlock table public.audit_logs in row exclusive mode;\nselect 'wrote';\nrollback;\n" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1)"
  if printf '%s' "$R" | grep -q '55P03' && ! printf '%s' "$R" | grep -q '^wrote$'; then
    ok "6: a new writer of public.audit_logs cannot start within 100 ms of the hold (55P03)"
  else
    bad "6: a new writer of public.audit_logs with lock_timeout 100ms: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-200)"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '5s';\nbegin;\nlock table public.audit_logs in row exclusive mode;\nselect 'wrote';\nrollback;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  STILL="$(q "select count(*) from pg_stat_activity where application_name = 'rec-lock-migration-6'")"
  if [ "$R" = "wrote" ] && [ $((t1 - t0)) -lt 2500 ] && [ "$STILL" = "0" ]; then
    ok "6: with room to wait, a new writer of public.audit_logs started when the hold ended (after $((t1 - t0)) ms)"
  else
    bad "6: a new writer of public.audit_logs with lock_timeout 5s: $R after $((t1 - t0)) ms (migration session still there: $STILL)"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/6m.err"; then bad "6: the migration session reported: $(tr '\n' ' ' < "$TMP/6m.err")"; fi

# ── 7. CONTROL: without the prelude, a writer queues behind a waiting file ─
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock_rec\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "7: could not build the no-prelude control file"
else
  printf "set application_name = 'rec-lock-control-holder';\nbegin;\nlock table public.organization_members in row exclusive mode;\nselect pg_sleep(4);\ncommit;\n" \
    | "${PSQL[@]}" > "$TMP/7.h.out" 2>&1 &
  hp=$!
  if ! wait_sleeping rec-lock-control-holder; then
    bad "7: the organization_members holder never reached pg_sleep"
    wait "$hp"
  else
    { echo "set application_name = 'rec-lock-control-file';"; echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } \
      | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.m.out" 2> "$TMP/7.m.err" &
    mp=$!
    # Wait until the file is blocked on a table, then read what it holds.
    WAITING_FOR="" HELD=""
    for _ in $(seq 1 60); do
      WAITING_FOR="$(q "select string_agg(n.nspname || '.' || c.relname, ',') from pg_locks l
                          join pg_stat_activity a on a.pid = l.pid
                          join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
                         where a.application_name = 'rec-lock-control-file' and l.locktype = 'relation' and not l.granted")"
      if [ -n "$WAITING_FOR" ]; then
        HELD="$(q "select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) from pg_locks l
                     join pg_stat_activity a on a.pid = l.pid
                     join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
                    where a.application_name = 'rec-lock-control-file' and l.locktype = 'relation' and l.granted
                      and c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema')")"
        break
      fi
      sleep 0.05
    done
    if [ -z "$WAITING_FOR" ]; then
      bad "7: the file never waited for public.organization_members (stderr: $(tr '\n' ' ' < "$TMP/7.m.err" | cut -c1-200))"
    elif [ -z "$HELD" ]; then
      bad "7: the file waited for $WAITING_FOR holding no table, so the control did not reproduce the hazard"
    else
      echo "       7: the file waits for $WAITING_FOR while holding: $HELD"
      TARGET="$(printf '%s' "$HELD" | tr ',' '\n' | head -n 1)"
      t0="$(now_ms)"
      R="$(printf "set lock_timeout = '10s';\nbegin;\nlock table %s in row exclusive mode;\nselect 'wrote';\nrollback;\n" "$TARGET" | "${PSQL[@]}" 2>&1)"
      t1="$(now_ms)"
      if [ "$R" = "wrote" ] && [ $((t1 - t0)) -ge 1500 ]; then
        ok "7: without the prelude a new writer of $TARGET queued behind the waiting file for $((t1 - t0)) ms: the hazard is real, and the prelude removes it (cases 3 and 6)"
      else
        bad "7: a new writer of $TARGET: $R after $((t1 - t0)) ms (expected a wait of 1.5 s or more)"
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
  ok "the stack is unchanged (head $HEAD_NOW, none of the six objects)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, objects present: $STATE_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
