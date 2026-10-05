#!/usr/bin/env bash
#
# Lock footprint of migration 0394 (every member can delete their account).
# The push runs the whole file as one batch, so every table lock a statement
# takes is held until the file commits. 0394 touches 23 tables, two of them
# read by nearly every request (user_profiles through RLS and the session,
# auth.users through every sign-in), so the file takes every lock in one
# NOWAIT prelude with a bounded retry and never waits while holding one (the
# 0390/0391 pattern): a busy table fails an attempt at once, its
# subtransaction releases what it took, and after 40 busy attempts the file
# raises 55P03 and applies nothing. This proves, with every migration session
# ALWAYS rolled back:
#
#   1a. The prelude takes ACCESS EXCLUSIVE on the 16 marked tables,
#       order_requests (the F12 CHECK swap), delivery_locations (key swap),
#       user_profiles (the key swaps add and drop RI triggers on it) and
#       auth.users (schedule_events' keys reference it; the new trigger), and
#       SHARE ROW EXCLUSIVE on user_permission_overrides,
#       role_permission_overrides and order_submissions (one new key each),
#       and nothing else outside the catalogs.
#   1b. No statement after the prelude locks a table the prelude did not
#       lock, so the file never waits while holding a lock (plan 11.3 step 5:
#       no deadlock with live traffic is possible).
#   2.  The hold, from the end of the prelude to the end of the file (every
#       table, auth.users and user_profiles included, is held for exactly
#       this long), is under 300 ms on the local stack. Printed per run.
#   3.  An open reader on user_profiles (ACCESS SHARE, any request's RLS
#       read) held 9 s: the file retries, holds NO table lock while paused
#       between attempts (sampled from pg_locks), and fails 55P03 after its
#       40 attempts, applying nothing. The reader is never blocked.
#   3b. The same reader held only 0.6 s: the file retries past it and runs to
#       the end.
#   4.  A sign-in's write on auth.users (ROW EXCLUSIVE, last_sign_in_at) held
#       0.6 s: the same, the file runs to the end.
#   5.  A reader that arrives while the file holds its locks (the file paused
#       1 s right after its prelude) waits for the file, then completes once
#       the file's transaction ends: the stall is bounded by the hold.
#   6.  The plan's deadlock shape (11.3 step 5): a session that holds
#       user_profiles ACCESS SHARE and then reads receipts after the file
#       started. With the prelude the file never holds receipts while waiting
#       for user_profiles, so neither session sees 40P01 and both complete.
#   7.  No session in any case sees 40P01 or a deadlock, and nothing applied.
#
# LOCAL stack only (docker container supabase_db_stockpilot), pre-0394 head
# (supabase db reset --local --version <the migration before 0394>).
# Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0394_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
# GoTrue writes auth.users as supabase_auth_admin (peer auth refuses it on the
# socket; the container trusts 127.0.0.1).
PSQL_AUTH=(docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U supabase_auth_admin -d postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(ls "$REPO"/supabase/migrations/*_account_deletion_for_everyone.sql)"
TMP="$(mktemp -d)"
HOLD_BUDGET_MS="${HOLD_BUDGET_MS:-300}"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf 'note   %s\n' "$*"; }
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
applied() { q "select count(*) from pg_proc where proname = 'tg_auth_users_before_delete'"; }
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$(applied)" != "0" ]; then
  echo "needs the pre-0394 head (supabase db reset --local --version <the migration before 0394>)"; exit 1
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
AE_TABLES='order_requests stock_movements audit_logs approvals cycle_count_ai_scans po_imports putaway_moves receipts
size_count_training_samples organization_invites platform_admin_audit returns uom_conversions org_connections
organization_modules carrier_shipments delivery_locations user_profiles schedule_events auth.users'
SRE_TABLES='user_permission_overrides role_permission_overrides order_submissions'
EXPECTED="$( { for t in $AE_TABLES; do echo "$t=AccessExclusiveLock"; done; for t in $SRE_TABLES; do echo "$t=ShareRowExclusiveLock"; done; } | sort | paste -sd, -)"

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
if [ -z "$AFTER" ]; then bad "1a: the file did not run: $(tail -5 "$TMP/one.out")"; fi
SAME="$(python3 - "$AFTER" "$EXPECTED" <<'PY'
import sys
got = set(filter(None, sys.argv[1].split(',')))
want = set(filter(None, sys.argv[2].split(',')))
print('yes' if got == want else 'no: extra ' + ','.join(sorted(got - want)) + ' missing ' + ','.join(sorted(want - got)))
PY
)"
if [ "$SAME" = "yes" ]; then ok "1a: the prelude took exactly the 20 ACCESS EXCLUSIVE and 3 SHARE ROW EXCLUSIVE table locks"; else bad "1a: $SAME"; fi
EXTRA="$(python3 - "$AFTER" "$ATEND" <<'PY'
import sys
held = {a.split('=')[0] for a in filter(None, sys.argv[1].split(','))}
print(','.join(sorted(a for a in filter(None, sys.argv[2].split(',')) if a.split('=')[0] not in held)))
PY
)"
if [ -z "$EXTRA" ]; then ok "1b: nothing after the prelude locked a table the prelude had not locked"; else bad "1b: also locked $EXTRA"; fi
note "1b: modes added after the prelude on tables it holds: $(python3 - "$AFTER" "$ATEND" <<'PY'
import sys
before = set(filter(None, sys.argv[1].split(',')))
print(','.join(sorted(set(filter(None, sys.argv[2].split(','))) - before)) or 'none')
PY
)"
T0="$(sed -n 's/^T0=//p' "$TMP/one.out")"; T1="$(sed -n 's/^T1=//p' "$TMP/one.out")"
if [ -n "$T0" ] && [ -n "$T1" ]; then
  HOLD=$((T1 - T0))
  if [ "$HOLD" -lt "$HOLD_BUDGET_MS" ]; then ok "2: every lock held from the prelude to the end for $HOLD ms (budget $HOLD_BUDGET_MS ms)"; else bad "2: held $HOLD ms (budget $HOLD_BUDGET_MS ms)"; fi
else
  bad "2: no timing: $(grep -m3 ERROR "$TMP/one.out")"
fi
[ "$(applied)" = "0" ] && ok "   (rolled back: nothing applied)"

# ═══ 3 to 6 ═══════════════════════════════════════════════════════════════
holder() { # holder <app> <seconds> <statement>: one statement, then sleep, then rollback
  ( printf "set application_name to '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$1" "$3" "$2" | "${PSQL[@]}" > "$TMP/$1.out" 2>&1 ) &
}
holder_auth() { # holder_auth <app> <seconds> <statement>: the same, as GoTrue's role
  ( printf "set application_name to '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$1" "$3" "$2" | "${PSQL_AUTH[@]}" > "$TMP/$1.out" 2>&1 ) &
}
run_file() { # run_file <tag> [pause-after-prelude-seconds]: the whole file, rolled back
  {
    echo "set application_name to 'mig-$1';"
    echo "begin;"
    cat "$TMP/head.sql"
    if [ -n "${2:-}" ]; then echo "select pg_sleep($2);"; fi
    cat "$TMP/tail.sql"
    echo "select 'DONE';"
    echo "rollback;"
  } | "${PSQL[@]}" > "$TMP/mig-$1.out" 2>&1
}
PROFILE_READ="select count(*) from public.user_profiles;"
SIGNIN_WRITE="update auth.users set last_sign_in_at = last_sign_in_at where id = (select id from auth.users order by id limit 1);"

echo "== 3. a reader holds user_profiles for 9 s"
holder long-reader 9 "$PROFILE_READ"
wait_app long-reader PgSleep || bad "3: the reader never reached its sleep"
T0=$(now_ms)
( run_file long ) &
MPID=$!
PAUSED=0; HELD_WHILE_PAUSED=0
while kill -0 "$MPID" 2>/dev/null; do
  if [ "$(q "select count(*) from pg_stat_activity where application_name = 'mig-long' and wait_event = 'PgSleep'")" = "1" ]; then
    PAUSED=$((PAUSED + 1))
    n="$(q "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid join pg_class c on c.oid = l.relation
             where a.application_name = 'mig-long' and l.locktype = 'relation'
               and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) and c.relkind in ('r', 'p')")"
    [ "$n" != "0" ] && HELD_WHILE_PAUSED=$((HELD_WHILE_PAUSED + 1))
  fi
  sleep 0.05
done
T1=$(now_ms)
wait
if grep -qE 'could not obtain lock|55P03' "$TMP/mig-long.out"; then ok "3: the file gave up with 55P03 after $((T1 - T0)) ms"; else bad "3: no 55P03: $(tail -3 "$TMP/mig-long.out")"; fi
if [ "$PAUSED" -gt 3 ] && [ "$HELD_WHILE_PAUSED" = "0" ]; then ok "3: $PAUSED paused samples, 0 with a table lock held"; else bad "3: paused samples $PAUSED, holding a lock in $HELD_WHILE_PAUSED"; fi
grep -q '^DONE$' "$TMP/mig-long.out" && bad "3: the file ran to the end"
if grep -q 'ERROR' "$TMP/long-reader.out"; then bad "3: the reader saw an error: $(grep -m1 ERROR "$TMP/long-reader.out")"; else ok "3: the reader was never blocked or refused"; fi

echo "== 3b. the same reader for 0.6 s"
holder short-reader 0.6 "$PROFILE_READ"
wait_app short-reader PgSleep || bad "3b: the reader never reached its sleep"
T0=$(now_ms); run_file short; T1=$(now_ms)
if grep -q '^DONE$' "$TMP/mig-short.out"; then ok "3b: retried past it and ran to the end in $((T1 - T0)) ms"; else bad "3b: $(tail -3 "$TMP/mig-short.out")"; fi
wait

echo "== 4. a sign-in's write on auth.users for 0.6 s"
holder_auth signin 0.6 "$SIGNIN_WRITE"
wait_app signin PgSleep || bad "4: the sign-in never reached its sleep"
run_file signin
if grep -q '^DONE$' "$TMP/mig-signin.out"; then ok "4: retried past it and ran to the end"; else bad "4: $(tail -3 "$TMP/mig-signin.out")"; fi
wait

echo "== 5. a reader arriving while the file holds its locks (paused 1 s after the prelude)"
( run_file paused 1 ) &
MPID=$!
wait_app mig-paused PgSleep || bad "5: the file never reached its pause"
T0=$(now_ms)
printf "set application_name to 'late-reader';\nselect 'R=' || count(*) from public.user_profiles;\n" | "${PSQL[@]}" > "$TMP/late-reader.out" 2>&1
T1=$(now_ms)
wait "$MPID"
if grep -q '^DONE$' "$TMP/mig-paused.out"; then ok "5: the file ran to the end"; else bad "5: $(tail -3 "$TMP/mig-paused.out")"; fi
if grep -q '^R=' "$TMP/late-reader.out" && [ $((T1 - T0)) -ge 300 ] && [ $((T1 - T0)) -lt 3000 ]; then
  ok "5: the late reader waited $((T1 - T0)) ms (the hold) and then completed"
else
  bad "5: late reader: $((T1 - T0)) ms, $(tail -2 "$TMP/late-reader.out")"
fi

echo "== 6. the plan's deadlock shape: user_profiles held, then receipts read, while the file runs"
( printf "set application_name to 'cycle-reader';\nbegin;\n%s\nselect pg_sleep(1.5);\nselect 'C=' || count(*) from public.receipts;\ncommit;\n" "$PROFILE_READ" \
    | "${PSQL[@]}" > "$TMP/cycle-reader.out" 2>&1 ) &
CPID=$!
wait_app cycle-reader PgSleep || bad "6: the reader never reached its sleep"
run_file cycle
wait "$CPID"
if grep -q '^DONE$' "$TMP/mig-cycle.out"; then ok "6: the file ran to the end after the reader finished"; else bad "6: $(tail -3 "$TMP/mig-cycle.out")"; fi
if grep -q '^C=' "$TMP/cycle-reader.out"; then ok "6: the reader completed"; else bad "6: reader: $(tail -2 "$TMP/cycle-reader.out")"; fi

echo "== 7. invariants"
if cat "$TMP"/*.out | grep -qE '40P01|deadlock'; then bad "7: a session saw 40P01"; else ok "7: no session saw 40P01 or a deadlock"; fi
if cat "$TMP"/*.out | grep -q '40001'; then bad "7: a session saw 40001"; else ok "7: no session saw 40001"; fi
if [ "$(applied)" = "0" ]; then ok "7: every migration session rolled back: nothing applied"; else bad "7: 0394 objects exist after the runs"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
