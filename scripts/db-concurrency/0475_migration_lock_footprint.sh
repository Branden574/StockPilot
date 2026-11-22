#!/usr/bin/env bash
#
# Lock footprint of the passkeys migration (supabase/migrations/*_passkeys.sql)
# and of the rollback written in its header. The push runs the whole file as
# one batch, so every table lock a statement takes is held until the file
# commits. The file needs three existing tables: public.user_profiles and
# public.organizations SHARE ROW EXCLUSIVE (the new tables' foreign keys:
# writers wait, readers do not) and public.platform_settings ACCESS
# EXCLUSIVE (three new columns: everyone waits). A file that took one of them
# and then waited for another would make every writer of the first queue
# behind it for the whole wait, so the file takes the three in one NOWAIT
# prelude (`do $lock_pk$ ... end $lock_pk$;`, the 0467 one) and never waits
# holding one. A busy table fails one attempt; the attempt's subtransaction
# rolls back (releasing what it took) and the prelude retries after a pause,
# up to 40 times, holding no table lock in between.
#
# Default (the head BEFORE this migration) proves:
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight reads catalogs only).
#   1b. The prelude takes exactly user_profiles and organizations SHARE ROW
#       EXCLUSIVE and platform_settings ACCESS EXCLUSIVE.
#   1c. No statement after the prelude locks an existing table the prelude
#       did not lock (the four tables the file creates are left out). Tables,
#       not modes; the file's full list at the end is printed.
#   1d. Inside the transaction the file made its four tables, fifteen
#       functions and three platform_settings columns.
#   2.  The hold, from the prelude to the end of the file, is under 250 ms
#       (the time is printed; the migration's LOCKS note states it).
#   3.  A writer of user_profiles, a writer of organizations, and a reader
#       and a writer of platform_settings, each with an open transaction held
#       longer than the retries last: the file retries, holds NO table lock
#       whenever it is paused between attempts (sampled from pg_locks), and
#       fails 55P03 after its bounded retries, writing nothing.
#   3b. A profile writer held only 0.6 s: the file retries past it and runs
#       to the end.
#   4.  A reader of user_profiles, a reader of organizations and a row lock
#       on a profile (FOR NO KEY UPDATE) with open transactions: the file
#       does not wait for them at all and runs to the end with no retry.
#   6.  While the file holds its locks (an artificial 1 s): new readers of
#       user_profiles and organizations read without waiting (lock_timeout
#       100ms); a new reader of platform_settings and a new writer of
#       user_profiles cannot start within 100 ms, and with room to wait the
#       writer starts when the hold ends.
#   7.  CONTROL, the hazard the prelude removes: the same file with the
#       prelude cut out and lock_timeout 5s, with a writer holding
#       public.organizations. The switch table's foreign key waits for it
#       while the file already holds public.user_profiles (the script prints
#       what it holds), and a new writer of public.user_profiles queues behind
#       the file for most of the wait. Required: the file held at least one
#       table while waiting, and the new writer waited at least 1.5 s.
#
# ROLLBACK=1 (the head WITH this migration) measures the rollback text in the
# migration's header, run inside BEGIN ... ROLLBACK:
#   R1. Its lock line takes exactly the seven tables ACCESS EXCLUSIVE.
#   R2. After the whole rollback it holds no table outside those seven.
#   R3. The drops alone (the lock line cut out) take ACCESS EXCLUSIVE on
#       user_profiles, organizations and platform_settings: the measurement
#       the header's ROLLBACK note states.
#   R4. Inside the transaction every object of the file is gone, the three
#       platform_settings columns included.
#   R5. With a reader holding user_profiles, the rollback fails at once with
#       55P03 (NOWAIT: nothing waits behind it) and drops nothing.
#
# The "writers" here take the table lock a write takes (ROW EXCLUSIVE) and
# write nothing. The migration and rollback sessions ALWAYS roll back, so the
# script changes nothing and writes no rows. LOCAL stack only: DB_URL=<postgres
# URL of a local stack> (the migration scratch stack is
# postgresql://postgres:postgres@127.0.0.1:56422/postgres), or
# CONTAINER=<docker container> (default supabase_db_stockpilot). Exit status
# 0 = every check passed.
#
# Usage: [ROLLBACK=1] DB_URL=... bash scripts/db-concurrency/0475_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rename.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
if [ -n "${DB_URL:-}" ]; then
  case "$DB_URL" in
    *@127.0.0.1:*|*@localhost:*) ;;
    *) echo "DB_URL must point at a local stack (127.0.0.1 or localhost)"; exit 1 ;;
  esac
  PSQL=(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -At)
else
  PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
fi
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_passkeys.sql' | sort | tail -n 1)}"
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

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the passkeys migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
NEW_TABLES="'member_passkeys', 'passkey_bridges', 'passkey_challenges', 'organization_passkey_switches'"
# The twenty-two objects the file creates (four tables, fifteen functions,
# three platform_settings columns): 0 before it, 22 after.
STATE_SQL="select (select count(*) from pg_class c
                    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ($NEW_TABLES))
                + (select count(*) from pg_proc p
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('my_passkeys', 'passkey_add_allowed', 'passkey_register',
                                        'issue_passkey_challenge', 'take_passkey_challenge',
                                        'passkey_mark_removed', 'passkey_remove_all',
                                        'consume_recovery_code_with_passkeys', 'passkey_replace_bridge',
                                        'passkey_drop_bridge', 'passkey_account_states',
                                        'passkey_bridge_sessions', 'passkey_end_bridge_session',
                                        'purge_passkey_records', '_passkey_bridge_factor_ok'))
                + (select count(*) from pg_attribute a
                    where a.attrelid = 'public.platform_settings'::regclass and a.attnum > 0 and not a.attisdropped
                      and a.attname in ('passkeys_on', 'passkey_adds_on', 'passkey_check_ends_sessions'))"
STATE_BEFORE="$(q "$STATE_SQL")"
echo "local head $HEAD_NOW; objects of this migration present: $STATE_BEFORE of 22; file $(basename "$MIG")"
# Existing tables (outside the catalogs), and the four the file makes left out.
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')
   and not (n.nspname = 'public' and c.relname in ($NEW_TABLES))"
ALL_LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"
rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }

# ═══ ROLLBACK mode ═══════════════════════════════════════════════════════════
if [ "${ROLLBACK:-}" = "1" ]; then
  if [ "$STATE_BEFORE" != "22" ]; then
    echo "ROLLBACK=1 needs the head with this migration applied (22 objects; found $STATE_BEFORE)"
    exit 1
  fi
  # The rollback block of the header: from "begin;" to "commit;", the comment
  # prefix taken off; then without begin and commit.
  sed -n '/^--     begin;$/,/^--     commit;$/p' "$MIG" | sed 's/^--     //' > "$TMP/rollback.sql"
  grep -vE '^(begin|commit);$' "$TMP/rollback.sql" > "$TMP/rollback-body.sql"
  awk 'BEGIN{skip=0} /^lock table only/{skip=1} skip==0{print} skip==1 && /nowait;$/{skip=0}' "$TMP/rollback-body.sql" > "$TMP/rollback-nolock.sql"
  LOCK_LINE="$(awk 'BEGIN{on=0} /^lock table only/{on=1} on==1{print} on==1 && /nowait;$/{on=0}' "$TMP/rollback-body.sql")"
  if [ -z "$LOCK_LINE" ] || ! grep -q 'drop table if exists public.member_passkeys' "$TMP/rollback-body.sql"; then
    echo "could not read the rollback block from $MIG"; exit 1
  fi
  echo "       rollback block: $(grep -c . "$TMP/rollback.sql") lines"
  EXPECT_R1="public.member_passkeys:AccessExclusiveLock,public.organization_passkey_switches:AccessExclusiveLock,public.organizations:AccessExclusiveLock,public.passkey_bridges:AccessExclusiveLock,public.passkey_challenges:AccessExclusiveLock,public.platform_settings:AccessExclusiveLock,public.user_profiles:AccessExclusiveLock"
  {
    echo "begin;"
    echo "set local lock_timeout = '900ms';"
    echo "$LOCK_LINE"
    echo "select 'R1|' || coalesce(($ALL_LOCKS_SQL), 'none');"
    grep -v '^set local lock_timeout' "$TMP/rollback-nolock.sql"
    echo "select 'R2|' || coalesce(($ALL_LOCKS_SQL), 'none');"
    echo "select 'R4|' || ($STATE_SQL);"
    echo "rollback;"
  } | "${PSQL[@]}" > "$TMP/r1.out" 2> "$TMP/r1.err"
  rc=$?
  if [ $rc -ne 0 ]; then
    bad "R1: the rollback did not run: $(tr '\n' ' ' < "$TMP/r1.err" | cut -c1-300)"
  else
    R1="$(sed -n 's/^R1|//p' "$TMP/r1.out")"
    R2="$(sed -n 's/^R2|//p' "$TMP/r1.out")"
    R4="$(sed -n 's/^R4|//p' "$TMP/r1.out")"
    if [ "$R1" = "$EXPECT_R1" ]; then ok "R1: the rollback's lock line takes exactly the seven tables, ACCESS EXCLUSIVE"; else bad "R1: the lock line took: $R1"; fi
    EXTRA="$(comm -13 <(rels "$R1") <(rels "$R2"))"
    if [ -z "$EXTRA" ]; then ok "R2: after every drop the rollback holds no other table (at the end: $R2)"; else bad "R2: the drops also locked: $(printf '%s' "$EXTRA" | tr '\n' ' ')"; fi
    if [ "$R4" = "0" ]; then ok "R4: inside the transaction every table, function and column of the file is gone (rolled back)"; else bad "R4: $R4 objects left inside the transaction"; fi
  fi
  {
    echo "begin;"
    grep -v '^set local lock_timeout' "$TMP/rollback-nolock.sql"
    echo "select 'R3|' || coalesce(($LOCKS_SQL), 'none');"
    echo "rollback;"
  } | "${PSQL[@]}" > "$TMP/r3.out" 2> "$TMP/r3.err"
  R3="$(sed -n 's/^R3|//p' "$TMP/r3.out")"
  R3_TABLES="$(rels "$R3" | tr '\n' ' ')"
  R3_AEL="$(printf '%s' "$R3" | tr ',' '\n' | grep -c ':AccessExclusiveLock$')"
  if [ "$R3_TABLES" = "public.organizations public.platform_settings public.user_profiles " ] && [ "$R3_AEL" = "3" ]; then
    ok "R3: the drops alone take ACCESS EXCLUSIVE on user_profiles, organizations and platform_settings ($R3)"
  else
    bad "R3: the drops alone took on existing tables: $R3 $(tr '\n' ' ' < "$TMP/r3.err" | cut -c1-200)"
  fi
  printf "set application_name = 'pk-rb-reader';\nbegin;\nselect count(*) from public.user_profiles;\nselect pg_sleep(3);\ncommit;\n" \
    | "${PSQL[@]}" > /dev/null 2>&1 &
  hp=$!
  if ! wait_sleeping pk-rb-reader; then
    bad "R5: the reader never reached pg_sleep"
  else
    t0="$(now_ms)"
    { cat "$TMP/rollback.sql" | sed 's/^commit;$/rollback;/'; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/r5.out" 2> "$TMP/r5.err"
    rc=$?
    t1="$(now_ms)"
    if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/r5.err" && [ $((t1 - t0)) -lt 500 ] && [ "$(q "$STATE_SQL")" = "22" ]; then
      ok "R5: with a reader holding user_profiles the rollback failed at once ($((t1 - t0)) ms, 55P03) and dropped nothing"
    else
      bad "R5: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/r5.err" | cut -c1-200); objects: $(q "$STATE_SQL")"
    fi
  fi
  wait "$hp"
  STATE_AFTER="$(q "$STATE_SQL")"
  if [ "$STATE_AFTER" = "22" ] && [ "$(q "select max(version) from supabase_migrations.schema_migrations")" = "$HEAD_NOW" ]; then
    ok "the stack is unchanged (head $HEAD_NOW, all 22 objects)"
  else
    bad "the stack changed under the script (objects present: $STATE_AFTER)"
  fi
  if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
  echo "$FAILS CHECK(S) FAILED"; exit 1
fi

# ═══ Default: the first apply ════════════════════════════════════════════════
if [ "$STATE_BEFORE" != "0" ]; then
  echo "needs the head before this migration (supabase db reset --local --version <the migration before it>)"
  exit 1
fi

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock_pk$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock_pk\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock_pk\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || { echo "no lock prelude in $MIG"; exit 1; }
head -n $((P0 - 1)) "$MIG" > "$TMP/part1.sql"
sed -n "${P0},${P1}p" "$MIG" > "$TMP/prelude.sql"
tail -n +$((P1 + 1)) "$MIG" > "$TMP/part3.sql"
EXPECTED="public.organizations:ShareRowExclusiveLock,public.platform_settings:AccessExclusiveLock,public.user_profiles:ShareRowExclusiveLock"

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
  echo "select 'ALL|' || coalesce(($ALL_LOCKS_SQL), 'none');"
  echo "select 'MADE|' || ($STATE_SQL);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err" | cut -c1-400)"
else
  BEFORE="$(sed -n 's/^BEFORE|//p' "$TMP/1.out")"
  PRELUDE="$(sed -n 's/^PRELUDE|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  ALL="$(sed -n 's/^ALL|//p' "$TMP/1.out")"
  MADE="$(sed -n 's/^MADE|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then ok "1a: the preflight locks no table"; else bad "1a: before the prelude the file already holds: $BEFORE"; fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly user_profiles and organizations SHARE ROW EXCLUSIVE and platform_settings ACCESS EXCLUSIVE"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks an existing table it did not lock (existing tables at the end: $END)"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  echo "       every table lock the file holds at its end, the new tables included: $ALL"
  if [ "$MADE" = "22" ]; then ok "1d: inside the transaction the file made its four tables, fifteen functions and three columns"; else bad "1d: inside the transaction the file made $MADE of 22 objects"; fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 250 ]; then
    ok "2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before the push's history row and the commit)"
  else
    bad "2: the prelude to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3 and 4. An open transaction on a table the prelude needs ─────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like 'pk-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply|apply-now>
  local label="$1" holder="$2" secs="$3" expect="$4" app="pk-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "$label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = 'pk-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
  wait "$hp"
}
run_behind 3-profile-writer "lock table public.user_profiles in row exclusive mode;" 9 fail
run_behind 3-organization-writer "lock table public.organizations in row exclusive mode;" 9 fail
run_behind 3-settings-reader "select count(*) from public.platform_settings;" 9 fail
run_behind 3-settings-writer "lock table public.platform_settings in row exclusive mode;" 9 fail
run_behind 3b-short-profile-writer "lock table public.user_profiles in row exclusive mode;" 0.6 apply
run_behind 4-profile-reader "select count(*) from public.user_profiles;" 3 apply-now
run_behind 4-organization-reader "select count(*) from public.organizations;" 3 apply-now
run_behind 4-profile-row-lock "select count(*) from (select 1 from public.user_profiles limit 1 for no key update) x;" 3 apply-now

# ── 6. While the file holds its locks ─────────────────────────────────────
{
  echo "set application_name = 'pk-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping pk-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  for target in public.user_profiles public.organizations; do
    R="$(printf "set lock_timeout = '100ms';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    if [ "$R" = "read:true" ]; then ok "6: a new reader of $target read without waiting for the hold (lock_timeout 100ms)"; else bad "6: a new reader of $target: $R"; fi
  done
  R="$(printf "set lock_timeout = '100ms';\nselect 'read:' || (count(*) >= 0)::text from public.platform_settings;\n" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1)"
  if printf '%s' "$R" | grep -q '55P03'; then ok "6: a new reader of public.platform_settings cannot start within 100 ms of the hold (55P03)"; else bad "6: a new reader of public.platform_settings: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-200)"; fi
  R="$(printf "set lock_timeout = '100ms';\nbegin;\nlock table public.user_profiles in row exclusive mode;\nselect 'wrote';\nrollback;\n" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1)"
  if printf '%s' "$R" | grep -q '55P03' && ! printf '%s' "$R" | grep -q '^wrote$'; then
    ok "6: a new writer of public.user_profiles cannot start within 100 ms of the hold (55P03)"
  else
    bad "6: a new writer of public.user_profiles with lock_timeout 100ms: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-200)"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '5s';\nbegin;\nlock table public.user_profiles in row exclusive mode;\nselect 'wrote';\nrollback;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  STILL="$(q "select count(*) from pg_stat_activity where application_name = 'pk-lock-migration-6'")"
  if [ "$R" = "wrote" ] && [ $((t1 - t0)) -lt 2500 ] && [ "$STILL" = "0" ]; then
    ok "6: with room to wait, a new writer of public.user_profiles started when the hold ended (after $((t1 - t0)) ms)"
  else
    bad "6: a new writer of public.user_profiles with lock_timeout 5s: $R after $((t1 - t0)) ms (migration session still there: $STILL)"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/6m.err"; then bad "6: the migration session reported: $(tr '\n' ' ' < "$TMP/6m.err" | cut -c1-200)"; fi

# ── 7. CONTROL: without the prelude, a writer queues behind a waiting file ─
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock_pk\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "7: could not build the no-prelude control file"
else
  printf "set application_name = 'pk-lock-control-holder';\nbegin;\nlock table public.organizations in row exclusive mode;\nselect pg_sleep(4);\ncommit;\n" \
    | "${PSQL[@]}" > "$TMP/7.h.out" 2>&1 &
  hp=$!
  if ! wait_sleeping pk-lock-control-holder; then
    bad "7: the organizations holder never reached pg_sleep"
    wait "$hp"
  else
    { echo "set application_name = 'pk-lock-control-file';"; echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } \
      | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.m.out" 2> "$TMP/7.m.err" &
    mp=$!
    WAITING_FOR="" HELD=""
    for _ in $(seq 1 60); do
      WAITING_FOR="$(q "select string_agg(n.nspname || '.' || c.relname, ',') from pg_locks l
                          join pg_stat_activity a on a.pid = l.pid
                          join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
                         where a.application_name = 'pk-lock-control-file' and l.locktype = 'relation' and not l.granted")"
      if [ -n "$WAITING_FOR" ]; then
        HELD="$(q "select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) from pg_locks l
                     join pg_stat_activity a on a.pid = l.pid
                     join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
                    where a.application_name = 'pk-lock-control-file' and l.locktype = 'relation' and l.granted
                      and c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema')
                      and not (n.nspname = 'public' and c.relname in ($NEW_TABLES))")"
        break
      fi
      sleep 0.05
    done
    if [ -z "$WAITING_FOR" ]; then
      bad "7: the file never waited for public.organizations (stderr: $(tr '\n' ' ' < "$TMP/7.m.err" | cut -c1-200))"
    elif [ -z "$HELD" ]; then
      bad "7: the file waited for $WAITING_FOR holding no existing table, so the control did not reproduce the hazard"
    else
      echo "       7: the file waits for $WAITING_FOR while holding: $HELD"
      t0="$(now_ms)"
      R="$(printf "set lock_timeout = '10s';\nbegin;\nlock table public.user_profiles in row exclusive mode;\nselect 'wrote';\nrollback;\n" | "${PSQL[@]}" 2>&1)"
      t1="$(now_ms)"
      if [ "$R" = "wrote" ] && [ $((t1 - t0)) -ge 1500 ]; then
        ok "7: without the prelude a new writer of public.user_profiles queued behind the waiting file for $((t1 - t0)) ms: the hazard is real, and the prelude removes it (cases 3 and 6)"
      else
        bad "7: a new writer of public.user_profiles: $R after $((t1 - t0)) ms (expected a wait of 1.5 s or more)"
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
  ok "the stack is unchanged (head $HEAD_NOW, none of the 22 objects)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, objects present: $STATE_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
