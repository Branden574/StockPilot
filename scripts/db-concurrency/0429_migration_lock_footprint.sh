#!/usr/bin/env bash
#
# Lock footprint of migration 0429 (B94: member removal releases open work;
# the number is provisional until the kit assigns it). The push runs the whole
# file as one batch, so every lock is held until the file commits. The file
# creates two functions (no table lock) and one trigger on
# organization_members (CREATE TRIGGER: SHARE ROW EXCLUSIVE; COMMENT ON
# TRIGGER: SHARE UPDATE EXCLUSIVE, which the first already covers). Its NOWAIT
# prelude (`do $b94_lock$ ... end $b94_lock$;`) takes SHARE ROW EXCLUSIVE on
# organization_members first, retried up to 40 times holding nothing between
# attempts, so the file never waits holding a lock. This proves, with every
# migration session ROLLED BACK:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs.
#   1b. The prelude takes exactly SHARE ROW EXCLUSIVE on organization_members.
#   1c. Nothing after the prelude locks a table the prelude did not lock.
#   2.  The hold, from the prelude to the end of the file, is under 1 s here.
#   3.  An open membership write (ROW EXCLUSIVE, the shape of Team's Remove or
#       a role change) held 9 s: the file retries, holds NO table lock while
#       paused between attempts (sampled from pg_locks), and fails 55P03
#       after its 40 attempts, applying nothing.
#   3b. The same write held 0.6 s: the file retries past it and runs to the
#       end.
#   4.  Open readers that only read or row-lock memberships (a plain SELECT,
#       FOR SHARE, and FOR NO KEY UPDATE, the account deletion's lock): the
#       file does not wait for them at all (SHARE ROW EXCLUSIVE is compatible
#       with ACCESS SHARE and ROW SHARE).
#   5.  While the file holds its lock (an artificial 1 s hold), a new reader
#       and a FOR NO KEY UPDATE row lock go through at once, and a membership
#       write waits for the hold and then goes through.
#   6.  No session sees 40P01.
#
# LOCAL stack only (CONTAINER, default supabase_db_stockpilot; the migration
# scratch stack is supabase_db_spmig, run it holding that stack's slot), at
# the head before 0429. Exit status 0 = every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0429_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG=""
for f in "$REPO"/supabase/migrations/*_member_removal_releases_open_work.sql; do [ -f "$f" ] && MIG="$f" && break; done
TMP="$(mktemp -d)"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
wait_app() { # wait_app <application_name> <wait_event>
  local _
  for _ in $(seq 1 100); do
    [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}
wait_locked() { # wait_locked <application_name>: until it waits on a lock
  local _
  for _ in $(seq 1 100); do
    [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ] && return 0
    sleep 0.05
  done
  return 1
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_member_removal_releases_open_work.sql"; exit 1; }
applied() { q "select count(*) from pg_proc where proname in ('tg_organization_members_release_open_work', 'member_open_work') and pronamespace = 'public'::regnamespace"; }
if [ "$(applied)" != "0" ]; then
  echo "needs the head before 0429 (supabase db reset --local --version <the migration before it>)"; exit 1
fi
echo "local head $(q "select max(version) from supabase_migrations.schema_migrations"); organization_members rows $(q "select count(*) from public.organization_members")"

# The file split before and after its prelude.
python3 - "$MIG" "$TMP" <<'PY'
import sys
src = open(sys.argv[1]).read()
a = src.index('do $b94_lock$')
b = src.index('end $b94_lock$;') + len('end $b94_lock$;')
open(sys.argv[2] + '/pre.sql', 'w').write(src[:a])
open(sys.argv[2] + '/lock.sql', 'w').write(src[a:b])
open(sys.argv[2] + '/tail.sql', 'w').write(src[b:])
PY
[ -s "$TMP/pre.sql" ] && [ -s "$TMP/lock.sql" ] && [ -s "$TMP/tail.sql" ] || { echo "could not split the file at its prelude"; exit 1; }

LOCKS_SQL="select coalesce(string_agg(distinct c.oid::regclass::text || '=' || l.mode, ',' order by c.oid::regclass::text || '=' || l.mode), '')
  from pg_locks l join pg_class c on c.oid = l.relation
 where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
   and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
   and c.relkind in ('r', 'p')"

# ═══ 1 and 2 ═══════════════════════════════════════════════════════════════
echo "== 1-2. what the file takes before, in and after its prelude"
{
  echo "begin;"
  cat "$TMP/pre.sql"
  echo "select 'BEFORE_PRELUDE=' || ($LOCKS_SQL);"
  cat "$TMP/lock.sql"
  echo "select 'AFTER_PRELUDE=' || ($LOCKS_SQL);"
  echo "select 'T0=' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/tail.sql"
  echo "select 'T1=' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'AT_END=' || ($LOCKS_SQL);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/one.out" 2>&1
BEFORE="$(sed -n 's/^BEFORE_PRELUDE=//p' "$TMP/one.out")"
AFTER="$(sed -n 's/^AFTER_PRELUDE=//p' "$TMP/one.out")"
ATEND="$(sed -n 's/^AT_END=//p' "$TMP/one.out")"
grep -q '^AT_END=' "$TMP/one.out" || bad "the file did not run to the end: $(tail -5 "$TMP/one.out" | tr '\n' ' ')"
if grep -q '^BEFORE_PRELUDE=$' "$TMP/one.out"; then ok "1a: nothing before the prelude took a table lock"; else bad "1a: before the prelude: '$BEFORE'"; fi
if [ "$AFTER" = "organization_members=ShareRowExclusiveLock" ]; then ok "1b: the prelude took exactly $AFTER"; else bad "1b: the prelude took '$AFTER'"; fi
EXTRA="$(python3 - "$AFTER" "$ATEND" <<'PY'
import sys
held = {a.split('=')[0] for a in filter(None, sys.argv[1].split(','))}
print(','.join(sorted(a for a in filter(None, sys.argv[2].split(',')) if a.split('=')[0] not in held)))
PY
)"
if [ -z "$EXTRA" ]; then ok "1c: nothing after the prelude locked another table (at the end: $ATEND)"; else bad "1c: also locked $EXTRA"; fi
HOLD=$(( $(sed -n 's/^T1=//p' "$TMP/one.out") - $(sed -n 's/^T0=//p' "$TMP/one.out") ))
if [ "$HOLD" -lt 1000 ]; then ok "2: held from the prelude to the end for $HOLD ms"; else bad "2: held $HOLD ms"; fi
[ "$(applied)" = "0" ] && ok "   (rolled back: nothing applied)"

# ═══ 3 and 3b: an open membership write ═══════════════════════════════════
holder() { # holder <app> <seconds> <statement>
  ( printf "set application_name to '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$1" "$3" "$2" | "${PSQL[@]}" > "$TMP/$1.out" 2>&1 ) &
}
run_file() { # run_file <tag> [hold seconds]: the whole file in a rolled-back transaction
  { echo "set application_name to 'mig-$1';"; echo "begin;"; cat "$MIG"; echo "select 'DONE';"
    [ -n "${2:-}" ] && echo "select pg_sleep($2);"; echo "rollback;"; } | "${PSQL[@]}" > "$TMP/mig-$1.out" 2>&1
}
MEMBER_WRITE="update public.organization_members set role = role where false;"

echo "== 3. a membership write held for 9 s"
holder long-writer 9 "lock table only public.organization_members in row exclusive mode;"
wait_app long-writer PgSleep || bad "3: the writer never reached its sleep"
MS0=$(now_ms)
( run_file long ) &
MPID=$!
PAUSED=0; HELD_WHILE_PAUSED=0
while kill -0 "$MPID" 2>/dev/null; do
  if [ "$(q "select count(*) from pg_stat_activity where application_name = 'mig-long' and wait_event = 'PgSleep'")" = "1" ]; then
    PAUSED=$((PAUSED + 1))
    n="$(q "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid join pg_class c on c.oid = l.relation where a.application_name = 'mig-long' and l.locktype = 'relation' and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) and c.relkind in ('r', 'p')")"
    [ "$n" != "0" ] && HELD_WHILE_PAUSED=$((HELD_WHILE_PAUSED + 1))
  fi
  sleep 0.05
done
MS1=$(now_ms)
wait
if grep -qE '55P03|could not obtain lock on relation' "$TMP/mig-long.out"; then ok "3: the file gave up with 55P03 after $((MS1 - MS0)) ms"; else bad "3: no 55P03: $(tail -3 "$TMP/mig-long.out" | tr '\n' ' ')"; fi
if [ "$PAUSED" -gt 3 ] && [ "$HELD_WHILE_PAUSED" = "0" ]; then ok "3: $PAUSED paused samples, 0 with a table lock held"; else bad "3: paused samples $PAUSED, holding a lock in $HELD_WHILE_PAUSED"; fi
grep -q '^DONE$' "$TMP/mig-long.out" && bad "3: the file ran to the end"

echo "== 3b. the same write held for 0.6 s"
holder short-writer 0.6 "lock table only public.organization_members in row exclusive mode;"
wait_app short-writer PgSleep || bad "3b: the writer never reached its sleep"
MS0=$(now_ms); run_file short; MS1=$(now_ms)
if grep -q '^DONE$' "$TMP/mig-short.out"; then ok "3b: retried past it and ran to the end in $((MS1 - MS0)) ms"; else bad "3b: $(tail -3 "$TMP/mig-short.out" | tr '\n' ' ')"; fi
wait

# ═══ 4. readers and row locks do not stop the file ════════════════════════
echo "== 4. open readers and row lockers of memberships"
holder plain-reader 3 "select count(*) from public.organization_members;"
holder share-locker 3 "select count(*) from (select 1 from public.organization_members limit 5 for share) s;"
holder nokey-locker 3 "select count(*) from (select 1 from public.organization_members limit 5 for no key update) s;"
if ! { wait_app plain-reader PgSleep && wait_app share-locker PgSleep && wait_app nokey-locker PgSleep; }; then bad "4: a reader never reached its sleep"; fi
MS0=$(now_ms); run_file readers; MS1=$(now_ms)
if grep -q '^DONE$' "$TMP/mig-readers.out" && [ $((MS1 - MS0)) -lt 2000 ]; then
  ok "4: the file ran to the end in $((MS1 - MS0)) ms beside a reader, a FOR SHARE and a FOR NO KEY UPDATE"
else
  bad "4: $((MS1 - MS0)) ms: $(tail -3 "$TMP/mig-readers.out" | tr '\n' ' ')"
fi
wait

# ═══ 5. what waits while the file holds its lock ══════════════════════════
echo "== 5. traffic while the file holds its lock for 1 s"
( run_file hold 1 ) &
wait_app mig-hold PgSleep || bad "5: the file never reached its hold"
timed() { # timed <tag> <statement>: ms to run it in its own transaction
  local t0 t1
  t0=$(now_ms)
  printf "set application_name to '%s';\nbegin;\n%s\nrollback;\n" "$1" "$2" | "${PSQL[@]}" > "$TMP/$1.out" 2>&1
  t1=$(now_ms)
  echo $((t1 - t0))
}
R="$(timed during-read "select count(*) from public.organization_members;")"
K="$(timed during-nokey "select count(*) from (select 1 from public.organization_members limit 5 for no key update) s;")"
( timed during-write "$MEMBER_WRITE" > "$TMP/during-write.ms" ) &
WPID=$!
if wait_locked during-write; then ok "5: a membership write waits for the hold"; else bad "5: the membership write did not wait"; fi
wait "$WPID"
wait
if [ "$R" -lt 500 ] && [ "$K" -lt 500 ]; then ok "5: a reader ($R ms) and a FOR NO KEY UPDATE ($K ms) did not wait"; else bad "5: reader $R ms, row lock $K ms"; fi
if ! grep -q ERROR "$TMP/during-write.out"; then ok "5: the write went through after the hold ($(cat "$TMP/during-write.ms") ms)"; else bad "5: $(cat "$TMP/during-write.out")"; fi

if cat "$TMP"/*.out | grep -qE '40P01|deadlock'; then bad "6: a session saw 40P01"; else ok "6: no session saw 40P01 or a deadlock"; fi
[ "$(applied)" = "0" ] && ok "every migration session rolled back: nothing applied"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
