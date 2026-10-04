#!/usr/bin/env bash
#
# Lock footprint of migration 0391 (place_order_request, order_submissions).
# The push runs the whole file as one batch, so every table lock a statement
# takes is held until the file commits. The table's two foreign keys add RI
# triggers to organizations and order_requests (SHARE ROW EXCLUSIVE), and on
# this image (17.6.1.166, supautils 3.4.0) CREATE POLICY and COMMENT ON POLICY
# also take ACCESS EXCLUSIVE on every table supautils.policy_grants lists for
# the role (auth, storage, realtime). A file that held order_requests and then
# waited for auth.users could close a cycle with an account deletion (which
# deletes auth.users, then nulls order_requests.requester_user_id), so the file
# takes every lock in one NOWAIT prelude and never waits holding one. This
# proves, with the migration session ALWAYS rolled back:
#
#   1a. The prelude takes SHARE ROW EXCLUSIVE on organizations and
#       order_requests, ACCESS SHARE on inventory_items and
#       order_request_lines (read when the SQL-language functions are
#       created), and ACCESS EXCLUSIVE on every existing table in
#       supautils.policy_grants for the role, and nothing else outside the
#       catalogs.
#   1b. No statement after the prelude locks a table that existed before the
#       file, beyond what the prelude took (the new table's own locks aside),
#       so the file can never wait while holding a lock.
#   2.  The hold, from the end of the prelude to the end of the file, is
#       under 200 ms.
#   3.  An open writer on order_requests (a row lock: ROW EXCLUSIVE) held 9 s:
#       the file retries, holds NO table lock while paused between attempts
#       (sampled from pg_locks), and fails 55P03 after its 40 attempts,
#       applying nothing.
#   3b. The same writer held only 0.6 s: the file retries past it and runs to
#       the end.
#   4.  An open auth.users reader (an account deletion's or a sign-in's lock
#       shape) held 0.6 s: the same, the file runs to the end; nobody sees
#       40P01.
#
# LOCAL stack only (docker container supabase_db_stockpilot), pre-0391 head.
# Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0391_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(ls "$REPO"/supabase/migrations/*_place_order_request.sql)"
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
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$(q "select count(*) from pg_proc where proname = 'place_order_request'")" != "0" ]; then
  echo "needs the pre-0391 head (supabase db reset --local --version <the migration before 0391>)"; exit 1
fi

# The file split at the end of its prelude.
python3 - "$MIG" "$TMP" <<'PY'
import sys
src = open(sys.argv[1]).read()
end = src.index('end $lock$;') + len('end $lock$;')
open(sys.argv[2] + '/head.sql', 'w').write(src[:end])
open(sys.argv[2] + '/tail.sql', 'w').write(src[end:])
PY

LOCKS_SQL="select coalesce(string_agg(c.oid::regclass::text || '=' || l.mode, ',' order by c.oid::regclass::text, l.mode), '')
  from pg_locks l join pg_class c on c.oid = l.relation
 where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
   and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
   and c.relkind in ('r', 'p')"
EXPECTED="$(q "select string_agg(x, ',' order by x) from (
  select 'order_requests=ShareRowExclusiveLock' x union all select 'organizations=ShareRowExclusiveLock'
  union all select 'inventory_items=AccessShareLock' union all select 'order_request_lines=AccessShareLock'
  union all
  select to_regclass(t)::text || '=AccessExclusiveLock'
    from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb)) t
   where to_regclass(t) is not null) s")"
echo "supautils policy_grants tables for this role: $(q "select count(*) from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb)) t where to_regclass(t) is not null")"

# ═══ 1 and 2 ══════════════════════════════════════════════════════════════
echo "== 1-2. what the prelude takes, and what the rest of the file adds"
{
  echo "begin;"
  cat "$TMP/head.sql"
  echo "select 'AFTER_PRELUDE=' || ($LOCKS_SQL);"
  echo "select 'T0=' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/tail.sql"
  echo "select 'T1=' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'AT_END=' || ($LOCKS_SQL);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/one.out" 2>&1
AFTER="$(sed -n 's/^AFTER_PRELUDE=//p' "$TMP/one.out")"
ATEND="$(sed -n 's/^AT_END=//p' "$TMP/one.out")"
SAME="$(python3 - "$AFTER" "$EXPECTED" <<'PY'
import sys
print('yes' if set(filter(None, sys.argv[1].split(','))) == set(filter(None, sys.argv[2].split(','))) else 'no')
PY
)"
if [ "$SAME" = "yes" ]; then ok "1a: the prelude took exactly organizations and order_requests (SHARE ROW EXCLUSIVE), inventory_items and order_request_lines (ACCESS SHARE) and the policy_grants tables (ACCESS EXCLUSIVE)"; else bad "1a: got '$AFTER', want '$EXPECTED'"; fi
# A table the rest of the file locked that the prelude had not locked in any
# mode (a weaker lock on a table the prelude holds more strongly never waits).
EXTRA="$(python3 - "$AFTER" "$ATEND" <<'PY'
import sys
held = {a.split('=')[0] for a in filter(None, sys.argv[1].split(','))}
extra = sorted(a for a in filter(None, sys.argv[2].split(','))
               if a.split('=')[0] not in held and not a.startswith('order_submissions'))
print(','.join(extra))
PY
)"
if [ -z "$EXTRA" ]; then ok "1b: nothing after the prelude locked a pre-existing table it had not locked"; else bad "1b: also locked $EXTRA"; fi
HOLD=$(( $(sed -n 's/^T1=//p' "$TMP/one.out") - $(sed -n 's/^T0=//p' "$TMP/one.out") ))
if [ "$HOLD" -lt 200 ]; then ok "2: held from the prelude to the end for $HOLD ms"; else bad "2: held $HOLD ms"; fi
[ "$(q "select count(*) from pg_proc where proname = 'place_order_request'")" = "0" ] && ok "   (rolled back: nothing applied)"

# ═══ 3 and 3b: a writer on order_requests ═════════════════════════════════
holder() { # holder <app> <seconds> <statement>
  ( printf "set application_name to '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$1" "$3" "$2" | "${PSQL[@]}" > "$TMP/$1.out" 2>&1 ) &
}
run_file() { # run_file <tag>: the whole file in a rolled-back transaction
  { echo "set application_name to 'mig-$1';"; echo "begin;"; cat "$MIG"; echo "select 'DONE';"; echo "rollback;"; } | "${PSQL[@]}" > "$TMP/mig-$1.out" 2>&1
}
ORDER_ROW="update public.order_requests set updated_at = updated_at where id = (select id from public.order_requests limit 1);"

echo "== 3. a writer holds order_requests for 9 s"
holder long-writer 9 "$ORDER_ROW"
wait_app long-writer PgSleep || bad "3: the writer never reached its sleep"
T0=$(now_ms)
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
T1=$(now_ms)
wait
if grep -q 'ERROR:  could not obtain lock' "$TMP/mig-long.out" || grep -q '55P03' "$TMP/mig-long.out"; then ok "3: the file gave up with 55P03 after $((T1 - T0)) ms"; else bad "3: no 55P03: $(tail -3 "$TMP/mig-long.out")"; fi
if [ "$PAUSED" -gt 3 ] && [ "$HELD_WHILE_PAUSED" = "0" ]; then ok "3: $PAUSED paused samples, 0 with a table lock held"; else bad "3: paused samples $PAUSED, holding a lock in $HELD_WHILE_PAUSED"; fi
grep -q '^DONE$' "$TMP/mig-long.out" && bad "3: the file ran to the end"

echo "== 3b. the same writer for 0.6 s"
holder short-writer 0.6 "$ORDER_ROW"
wait_app short-writer PgSleep || bad "3b: the writer never reached its sleep"
T0=$(now_ms); run_file short; T1=$(now_ms)
if grep -q '^DONE$' "$TMP/mig-short.out"; then ok "3b: retried past it and ran to the end in $((T1 - T0)) ms"; else bad "3b: $(tail -3 "$TMP/mig-short.out")"; fi
wait

echo "== 4. an auth.users reader for 0.6 s"
holder auth-reader 0.6 "select count(*) from auth.users;"
wait_app auth-reader PgSleep || bad "4: the reader never reached its sleep"
run_file auth
if grep -q '^DONE$' "$TMP/mig-auth.out"; then ok "4: retried past it and ran to the end"; else bad "4: $(tail -3 "$TMP/mig-auth.out")"; fi
wait
if cat "$TMP"/*.out | grep -qE '40P01|deadlock'; then bad "no session may see 40P01"; else ok "no session saw 40P01 or a deadlock"; fi
[ "$(q "select count(*) from pg_proc where proname = 'place_order_request'")" = "0" ] && ok "every migration session rolled back: nothing applied"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
