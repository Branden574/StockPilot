#!/usr/bin/env bash
#
# Lock footprint of migration 0456 (this script finds the file by its name,
# *_recovery_code_check_counts_attempts.sql, not by its number).
# The file runs a catalog preflight, restates consume_mfa_recovery_code(text)
# with the count before the comparison, restates the function's revoke and
# grant, and gives it a comment. What it locks:
#
#   - No table, at any point. The preflight reads catalogs only. Checking the
#     body (check_function_bodies, on in the push) parses it without opening
#     a table: it declares no %ROWTYPE or %TYPE. REVOKE and GRANT write only
#     the function's catalog row.
#   - Two object locks, held to commit: GRANT's AccessShareLock on the role
#     authenticated (PostgreSQL locks a role while it records a dependency on
#     it, so only a DROP ROLE of authenticated would wait), and COMMENT ON
#     FUNCTION's ShareUpdateExclusiveLock on consume_mfa_recovery_code(text)
#     (only other DDL on the same function waits). No call, read or write
#     waits for either. CREATE OR REPLACE and REVOKE hold none.
#
# A call of the function takes no lock on it, so a call in flight never holds
# the file up and the file never holds a call up. Checked:
#
#   0.  The stack is at the state before the file (the function's body is
#       0103's, md5 17f25531), and the file has no transaction control of its
#       own.
#   1.  Run as one transaction, rolled back: after its preflight and at its
#       end the file holds no table lock outside the catalogs, and its only
#       object locks are the two above.
#   2.  It runs in under 250 ms.
#   3.  A call in flight: a call with one of the account's codes waits on the
#       account's code rows (held by a third session) while the file runs.
#       The file finishes under its 900 ms lock_timeout, the call is still
#       waiting when it does, and the call then answers true.
#   4.  A call while the file's transaction is open (run to its end and paused
#       before it ends): a call with that code answers true and finishes
#       while the file is still open.
#   5.  No table at any point: with ACCESS EXCLUSIVE held by another session
#       on every table in public, ledger, auth and extensions that postgres
#       may lock (all but auth.schema_migrations, which belongs to the auth
#       server), the file runs to its end under its lock_timeout. Check 1
#       reads only the locks still held at the end; this is the check that
#       sees a lock the file takes and releases.
#   6.  The preflight refuses drift: with the body, the ACL or the
#       search_path changed earlier in the same transaction, the counter's
#       body changed, or the file run a second time, it stops with 55000
#       (hint recovery_code_attempts_preflight) naming what differs, before
#       any change; nothing is applied.
#   7.  A file that fails applies nothing: while another open transaction is
#       changing the function's catalog row, the file run as the push runs it
#       passes its preflight, waits in its CREATE OR REPLACE on that
#       transaction and ends with 55P03 at its lock_timeout; the function's
#       row is the version it was.
#   8.  No session in checks 1-5 saw 55P03, 40001 or 40P01.
#
# Every migration session and every call rolls back or fails; the stack is
# left as it was. Runs against a LOCAL stack only (CONTAINER, default the dev
# stack's supabase_db_stockpilot; the migration scratch stack is
# supabase_db_spmig), at the state before the file (MIG may name the file
# when it is kept outside supabase/migrations for that). The fixture account
# lives under the 0456a0f0-... namespace and is removed, with its codes and
# its count, at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0456_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# MIG may name a mutated copy of the file, to prove a check sees what it says.
MIG="${MIG:-}"
if [ -z "$MIG" ]; then
  for f in "$REPO"/supabase/migrations/*_recovery_code_check_counts_attempts.sql; do [ -f "$f" ] && MIG="$f" && break; done
fi
TMP="$(mktemp -d)"

FN='public.consume_mfa_recovery_code(text)'
OLD_MD5='17f255317559b1f06dfaa19e6440859b'
U='0456a0f0-0000-4000-8000-0000000000f1'
EXPECTED_OBJECTS='objects=object:pg_authid:authenticated:AccessShareLock,object:pg_proc:consume_mfa_recovery_code(text):ShareUpdateExclusiveLock'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
below() { # below <label> <actual ms> <limit ms>
  if [ -n "$2" ] && [ "$2" -lt "$3" ]; then ok "$1 ($2 ms < $3 ms)"; else bad "$1: got '$2' ms, want under $3 ms"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
wait_event() { # wait_event <application_name> <wait_event>
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
waiting_on_lock() { q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'"; }
wait_locked() {
  local _
  for _ in $(seq 1 200); do
    [ "$(waiting_on_lock "$1")" = "1" ] && return 0
    sleep 0.05
  done
  return 1
}
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

# A session that takes <lock sql> and sleeps, then rolls back.
hold() { # hold <application_name> <lock sql> <seconds> <out>
  "${PSQL[@]}" > "$4" 2>&1 <<SQL
set application_name to '$1';
set lock_timeout = '2s';
begin;
$2
select 'H=locked';
select pg_sleep($3);
rollback;
SQL
}

# What a session waits for, once it waits: its ungranted locks, and whether
# its statement starts with <regex>. Written to <out>.
observe_wait() { # observe_wait <application_name> <statement regex> <out>
  if wait_locked "$1"; then
    q "select 'waits=' || string_agg(l.locktype || ':' || coalesce(l.relation::regclass::text, '-') || ':' || l.mode, ',' order by l.mode)
         from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where a.application_name = '$1' and not l.granted" > "$3"
    q "select 'statement=' || count(*) from pg_stat_activity
        where application_name = '$1' and query ~* '^\s*$2'" >> "$3"
  else
    echo "waits=never" > "$3"
  fi
}

# The fixture account's codes, made once (an aal2 call, committed); the
# first of them, sorted, is the code the calls below check. Never printed.
setup_sql() {
  cat <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$U', 'attempts-footprint@example.test', '{}'::jsonb);
begin;
set local role authenticated;
set local "request.jwt.claim.sub" to '$U';
set local "request.jwt.claims" to '{"sub": "$U", "role": "authenticated", "aal": "aal2"}';
select 'CODE=' || min(code) from public.generate_mfa_recovery_codes();
commit;
SQL
}

# One aal1 call of the function with that code as the fixture account,
# rolled back: '<tag>=<answer>'.
call_sql() { # call_sql <application_name> <tag>
  cat <<SQL
set application_name to '$1';
begin;
set local role authenticated;
set local "request.jwt.claim.sub" to '$U';
set local "request.jwt.claims" to '{"sub": "$U", "role": "authenticated", "aal": "aal1"}';
select '$2=' || public.consume_mfa_recovery_code('$CODE')::text;
rollback;
SQL
}

body_md5() { q "select md5(prosrc) from pg_proc where oid = '$FN'::regprocedure"; }
acl() { q "select coalesce(proacl::text, '') from pg_proc where oid = '$FN'::regprocedure"; }
row_version() { q "select xmin::text || '/' || md5(prosrc) || '/' || coalesce(proacl::text, '') from pg_proc where oid = '$FN'::regprocedure"; }
codes_sum() { q "select coalesce(md5(string_agg(id::text || code_hash || coalesce(used_at::text, '-'), ',' order by id)), 'none') from public.mfa_recovery_codes where user_id = '$U'"; }

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.rate_limit_buckets where key = 'mfa-recovery-fn:$U';
delete from public.mfa_recovery_codes where user_id = '$U';
delete from auth.users where id = '$U';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  if [ "$(q "select count(*) from auth.users where id = '$U'")" != "0" ]; then echo "cleanup left the fixture account"; return 1; fi
}

# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() {
  wait 2>/dev/null
  cleanup >/dev/null 2>&1
  rm -rf "$TMP"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ═══ 0. Preconditions ═════════════════════════════════════════════════════
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_recovery_code_check_counts_attempts.sql"; exit 1; }
if [ "$(body_md5)" != "$OLD_MD5" ]; then
  echo "needs the state before the file: the function's body must be 0103's (md5 $OLD_MD5), not $(body_md5)"; exit 1
fi
if grep -qiE '^[[:space:]]*(begin|commit|rollback|start transaction)[[:space:]]*;' "$MIG"; then
  echo "the file has its own transaction control: this script wraps it in one"; exit 1
fi
PRE_END="$(awk '/^\$attempts_pre\$;$/ { print NR; exit }' "$MIG")"
[ -n "$PRE_END" ] || { echo "could not find the end of the preflight block (\$attempts_pre\$;) in the file"; exit 1; }
cleanup || exit 1
ACL0="$(acl)"
echo "local head $(q "select max(version) from supabase_migrations.schema_migrations"); file $(basename "$MIG"); ACL $ACL0"

if ! setup_sql | "${PSQL[@]}" > "$TMP/setup.log" 2>&1; then
  echo "fixture setup failed: $(grep -v '^CODE=' "$TMP/setup.log")"; exit 1
fi
CODE="$(grep '^CODE=' "$TMP/setup.log" | cut -d= -f2)"
[ -n "$CODE" ] || { echo "fixture setup made no code"; exit 1; }
check "0: the fixture account holds ten unused codes" "$(q "select count(*) from public.mfa_recovery_codes where user_id = '$U' and used_at is null")" "10"
SUM0="$(codes_sum)"

TABLES_SQL="select 'tables=' || coalesce(string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode), 'none')
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');"
OBJECTS_SQL="select 'objects=' || coalesce(string_agg(x, ',' order by x), 'none')
  from (select l.locktype || ':' || coalesce(l.classid::regclass::text, '-') || ':'
               || coalesce(case when l.classid = 'pg_proc'::regclass then l.objid::regprocedure::text
                                when l.classid = 'pg_authid'::regclass then l.objid::regrole::text end,
                           l.objid::text, '-')
               || ':' || l.mode as x
          from pg_locks l
         where l.pid = pg_backend_pid() and l.granted
           and l.locktype not in ('relation', 'virtualxid', 'transactionid')) s;"
MS_SQL="select 'ms=' || round(extract(epoch from clock_timestamp() - now()) * 1000);"

# The file in one transaction, its locks read after the preflight and at the
# end, rolled back.
run_file() { # run_file <application_name> <out>
  { echo "set application_name to '$1';"; echo "begin;"
    head -n "$PRE_END" "$MIG"
    echo "${TABLES_SQL/tables=/pre_tables=}"
    tail -n +"$((PRE_END + 1))" "$MIG"
    echo "$TABLES_SQL"; echo "$OBJECTS_SQL"; echo "$MS_SQL"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$2" 2>&1
}

# The file as the push runs it: one transaction, committed if it reaches its
# end (the CLI sends each migration file as one implicitly transactional
# batch). Used only where the file is expected to fail.
push_file() { # push_file <application_name> <out>
  { echo "set application_name to '$1';"; echo "begin;"; cat "$MIG"; echo "commit;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$2" 2>&1
}

# ═══ 1 and 2. The file alone ══════════════════════════════════════════════
echo "== 1-2. the file in one transaction, rolled back"
if run_file 0456-fp-alone "$TMP/alone.out"; then ok "1: the file ran"; else bad "1: the file failed: $(cat "$TMP/alone.out")"; fi
check "1: after the preflight, no table lock outside the catalogs" "$(grep '^pre_tables=' "$TMP/alone.out")" "pre_tables=none"
check "1: at the end, no table lock outside the catalogs" "$(grep '^tables=' "$TMP/alone.out")" "tables=none"
check "1: the two object locks at the end are GRANT's on the role authenticated and COMMENT's on the function" "$(grep '^objects=' "$TMP/alone.out")" "$EXPECTED_OBJECTS"
below "2: the file runs fast" "$(grep '^ms=' "$TMP/alone.out" | cut -d= -f2)" 250
check "2: rolled back: the body is still 0103's" "$(body_md5)" "$OLD_MD5"

# ═══ 3. A call in flight ══════════════════════════════════════════════════
echo "== 3. the file while a call with one of the account's codes waits on the account's code rows"
( "${PSQL[@]}" > "$TMP/holder3.out" 2>&1 <<SQL
set application_name to '0456-fp-holder';
begin;
select 'H=' || count(*) from (select id from public.mfa_recovery_codes where user_id = '$U' for update) s;
select pg_sleep(3);
rollback;
SQL
) &
PH=$!
wait_event 0456-fp-holder PgSleep || bad "3: the holder never reached its pg_sleep"
( call_sql 0456-fp-call A | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/call3.out" 2>&1 ) &
PA=$!
if wait_locked 0456-fp-call; then ok "3: the call waits on the account's code rows"; else bad "3: the call never waited on the rows"; fi
if run_file 0456-fp-file3 "$TMP/file3.out"; then ok "3: the file ran while the call was in flight"; else bad "3: the file failed: $(cat "$TMP/file3.out")"; fi
check "3: the call was still waiting when the file finished" "$(waiting_on_lock 0456-fp-call)" "1"
below "3: the file finished under its lock_timeout" "$(grep '^ms=' "$TMP/file3.out" | cut -d= -f2)" 900
check "3: no lock on a table outside the catalogs" "$(grep '^tables=' "$TMP/file3.out")" "tables=none"
wait "$PH"; wait "$PA"
check "3: the call then answered true" "$(grep -c '^A=true$' "$TMP/call3.out")" "1"
check "3: the account's codes are unchanged (every session rolled back)" "$(codes_sum)" "$SUM0"

# ═══ 4. A call while the file is open ═════════════════════════════════════
echo "== 4. a call with that code while the file's transaction is open (run to its end, paused before it ends)"
( { echo "set application_name to '0456-fp-open';"; echo "begin;"; cat "$MIG"; echo "select 'F=done';"
    echo "select pg_sleep(2);"; echo "$TABLES_SQL"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/open4.out" 2>&1 ) &
PF=$!
wait_event 0456-fp-open PgSleep || bad "4: the file never reached its pause"
t0=$(now_ms); call_sql 0456-fp-call4 B | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/call4.out" 2>&1; t1=$(now_ms)
check "4: the file was still open when the call finished" "$(q "select count(*) from pg_stat_activity where application_name = '0456-fp-open' and wait_event = 'PgSleep'")" "1"
check "4: the call answered true" "$(grep -c '^B=true$' "$TMP/call4.out")" "1"
below "4: the call took" "$((t1 - t0))" 1500
wait "$PF"
check "4: the file had run to its end" "$(grep -c '^F=done$' "$TMP/open4.out")" "1"
check "4: the open file held no table lock outside the catalogs" "$(grep '^tables=' "$TMP/open4.out")" "tables=none"
check "4: the account's codes are unchanged (every session rolled back)" "$(codes_sum)" "$SUM0"

# ═══ 5. No table at any point ═════════════════════════════════════════════
echo "== 5. ACCESS EXCLUSIVE held on every table in public, ledger, auth and extensions that postgres may lock: the file, rolled back"
# LOCK ... ACCESS EXCLUSIVE needs UPDATE, DELETE, TRUNCATE or MAINTAIN on the table.
IN_SCHEMAS="c.relkind in ('r', 'p') and n.nspname in ('public', 'ledger', 'auth', 'extensions')"
LOCKABLE="(has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE')
           or has_table_privilege(c.oid, 'TRUNCATE') or has_table_privilege(c.oid, 'MAINTAIN'))"
ALL="$(q "select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace where $IN_SCHEMAS and $LOCKABLE")"
NALL="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where $IN_SCHEMAS and $LOCKABLE")"
check "5: the only table there postgres may not lock is the auth server's own" \
  "$(q "select coalesce(string_agg(n.nspname || '.' || c.relname, ','), 'none')
          from pg_class c join pg_namespace n on n.oid = c.relnamespace where $IN_SCHEMAS and not $LOCKABLE")" "auth.schema_migrations"
hold 0456-fp-all-holder "lock table $ALL in access exclusive mode;" 3 "$TMP/all-holder.out" &
PH=$!
if wait_event 0456-fp-all-holder PgSleep; then
  ok "5: another session holds ACCESS EXCLUSIVE on $NALL tables"
else
  bad "5: the holder never got its locks: $(cat "$TMP/all-holder.out")"
fi
if run_file 0456-fp-all "$TMP/all.out"; then ok "5: the file ran to its end"; else bad "5: the file failed: $(cat "$TMP/all.out")"; fi
below "5: under its lock_timeout" "$(grep '^ms=' "$TMP/all.out" | cut -d= -f2)" 900
check "5: the holder still held them when the file finished" "$(q "select count(*) from pg_stat_activity where application_name = '0456-fp-all-holder' and wait_event = 'PgSleep'")" "1"
wait "$PH"

# ═══ 6. The preflight refuses drift ═══════════════════════════════════════
echo "== 6. a drifted body, ACL or search_path, a changed counter, or a second run, stops the file before it changes anything"
drift() { # drift <tag> <statement run first, in the same transaction>
  { echo "begin;"; echo "$2;"; cat "$MIG"; echo "select 'DONE';"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/drift-$1.x55" 2>&1
}
check_drift() { # check_drift <tag> <words the message must carry>
  if grep -q 'ERROR:  55000' "$TMP/drift-$1.x55" && grep -q 'HINT:  recovery_code_attempts_preflight' "$TMP/drift-$1.x55" \
     && grep -qF "$2" "$TMP/drift-$1.x55" && ! grep -q '^DONE$' "$TMP/drift-$1.x55"; then
    ok "6 ($1): 55000 recovery_code_attempts_preflight naming '$2'"
  else
    bad "6 ($1): $(grep -E 'ERROR|HINT' "$TMP/drift-$1.x55" | head -3 | tr '\n' ' ')"
  fi
}
# A comment added inside the body: the same behaviour, a new md5.
drift body "$(q "select regexp_replace(pg_get_functiondef('$FN'::regprocedure), '(AS [\$]function[\$])', E'\\\\1\\n-- drift probe')")"
check_drift body 'public.consume_mfa_recovery_code(text) drifted (md5 '
drift grants "grant execute on function $FN to anon"
check_drift grants 'public.consume_mfa_recovery_code(text) grants drifted ('
drift search_path "alter function $FN set search_path = public"
check_drift search_path 'search_path=public, owner postgres'
# The counter with another body (the same header): its md5 is pinned too.
drift counter "create or replace function public.increment_rate_limit(p_key text, p_limit integer, p_window_ms integer) returns table (allowed boolean, count integer, reset_at timestamptz) language plpgsql security definer set search_path = public as 'begin return; end'"
check_drift counter 'public.increment_rate_limit(text, integer, integer) drifted ('
drift second-run "$(cat "$MIG")"
check_drift second-run 'public.consume_mfa_recovery_code(text) drifted (md5 '
check "6: nothing applied (the body is still 0103's, the ACL as it was)" "$(body_md5)|$(acl)" "$OLD_MD5|$ACL0"

# ═══ 7. A file that fails applies nothing ═════════════════════════════════
echo "== 7. another open transaction changes the function's catalog row: the file, run as the push runs it"
before="$(row_version)"
hold 0456-fp-row-holder "alter function $FN cost 100;" 4 "$TMP/row-holder.log" &
PH=$!
wait_event 0456-fp-row-holder PgSleep || bad "7: the holder never reached its pg_sleep: $(cat "$TMP/row-holder.log")"
observe_wait 0456-fp-row-file 'create or replace function public\.consume_mfa_recovery_code\(' "$TMP/row-observed.log" &
PO=$!
t0=$(now_ms); push_file 0456-fp-row-file "$TMP/row-file.x55"; rc=$?; t1=$(now_ms)
wait "$PO"; wait "$PH"
check "7: its preflight passed and it waited in its CREATE OR REPLACE" "$(grep '^statement=' "$TMP/row-observed.log")" "statement=1"
check "7: on the other transaction" "$(grep '^waits=' "$TMP/row-observed.log")" "waits=transactionid:-:ShareLock"
check "7: the file ends with 55P03 (psql exit 3)" "$rc:$(grep -c '55P03' "$TMP/row-file.x55")" "3:1"
below "7: it gives up at its lock_timeout" "$((t1 - t0))" 2000
check "7: nothing kept (the function's catalog row is the version it was)" "$(row_version)" "$before"

# ═══ 8. Never a lock timeout or a retryable error ═════════════════════════
echo "== 8. no session in checks 1-5 saw 55P03, 40001 or 40P01"
check "8: none in any session's output" "$(cat "$TMP"/*.out | grep -cE '55P03|40001|40P01|lock timeout|could not serialize|deadlock detected')" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
