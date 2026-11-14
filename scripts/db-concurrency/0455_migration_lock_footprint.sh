#!/usr/bin/env bash
#
# Lock footprint of migration 0455 (this script finds the file by its name,
# *_session_factor_helper.sql, not by its number). The file runs a catalog
# preflight, creates schema gate and two PL/pgSQL functions in it, and
# writes their revokes, grants and comments. What it locks:
#
#   - No table, at any point. The preflight reads catalogs only: to_regclass
#     and has_table_privilege take no lock on auth.mfa_factors. CREATE
#     FUNCTION checks a PL/pgSQL body by parsing it, without opening a table
#     (neither body declares %TYPE or %ROWTYPE).
#   - Object locks on the new schema and functions (ShareUpdateExclusiveLock;
#     nobody else can see them before commit), and an AccessShareLock on
#     four roles, held to commit: postgres (the new objects' owner) and each
#     grantee (anon, authenticated, service_role). PostgreSQL locks a role
#     while it records a dependency on it, so only a DROP ROLE of one of them
#     would wait.
#
# Checked:
#
#   0.  The stack is at the state before the file (no schema gate), and the
#       file has no transaction control of its own.
#   1.  Run as one transaction, rolled back: after its preflight and at its
#       end the file holds no table lock outside the catalogs, and its object
#       locks are exactly the expected set.
#   2.  It runs in under 250 ms.
#   3.  No table at any point: with ACCESS EXCLUSIVE held by another session
#       on every table in public, ledger, auth and extensions that postgres
#       may lock (auth.mfa_factors among them; all but auth.schema_migrations,
#       which belongs to the auth server), the file runs to its end under its
#       lock_timeout. Check 1 reads only the locks still held at the end; this
#       is the check that sees a lock the file takes and releases.
#   4.  The preflight refuses a second run: with the file applied earlier in
#       the same transaction, a second copy stops with 55000 (hint
#       gate_helper_preflight) naming the schema; nothing is kept.
#   5.  A file that fails applies nothing: while another open transaction has
#       created a schema named gate and not committed, the file run as the
#       push runs it passes its preflight (the other schema is not visible
#       yet), waits in its CREATE SCHEMA on that transaction and ends with
#       55P03 at its lock_timeout; no schema gate exists afterwards.
#   6.  No session in checks 1-3 saw 55P03, 40001 or 40P01.
#
# Every migration session rolls back or fails; the stack is left as it was.
# Runs against a LOCAL stack only (CONTAINER, default the dev stack's
# supabase_db_stockpilot; the migration scratch stack is supabase_db_spmig),
# at the state before the file. It plants no row. Exit status 0 = every
# check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0455_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# MIG may name a mutated copy of the file, to prove a check sees what it says.
MIG="${MIG:-}"
if [ -z "$MIG" ]; then
  for f in "$REPO"/supabase/migrations/*_session_factor_helper.sql; do [ -f "$f" ] && MIG="$f" && break; done
fi
TMP="$(mktemp -d)"

EXPECTED_OBJECTS='objects=object:pg_authid:anon:AccessShareLock,object:pg_authid:authenticated:AccessShareLock,object:pg_authid:postgres:AccessShareLock,object:pg_authid:service_role:AccessShareLock'

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

# A session that runs <sql> and sleeps, then rolls back.
hold() { # hold <application_name> <sql> <seconds> <out>
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

gate_state() { q "select coalesce((select 'gate:' || n.oid::text from pg_namespace n where n.nspname = 'gate'), 'none')"; }

# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() {
  wait 2>/dev/null
  rm -rf "$TMP"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ═══ 0. Preconditions ═════════════════════════════════════════════════════
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_session_factor_helper.sql"; exit 1; }
if [ "$(gate_state)" != "none" ]; then
  echo "needs the state before the file: schema gate must not exist"; exit 1
fi
if grep -qiE '^[[:space:]]*(begin|commit|rollback|start transaction)[[:space:]]*;' "$MIG"; then
  echo "the file has its own transaction control: this script wraps it in one"; exit 1
fi
PRE_END="$(awk '/^\$gate_pre\$;$/ { print NR; exit }' "$MIG")"
[ -n "$PRE_END" ] || { echo "could not find the end of the preflight block (\$gate_pre\$;) in the file"; exit 1; }
echo "local head $(q "select max(version) from supabase_migrations.schema_migrations"); file $(basename "$MIG")"

TABLES_SQL="select 'tables=' || coalesce(string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode), 'none')
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');"
# Object locks on anything that existed before the file (a role, a schema or
# a function of someone else's); locks on the file's own new schema and
# functions are listed apart, since no other session can see those objects.
OBJECTS_SQL="select 'objects=' || coalesce(string_agg(x, ',' order by x), 'none')
  from (select l.locktype || ':' || coalesce(l.classid::regclass::text, '-') || ':'
               || coalesce(case when l.classid = 'pg_proc'::regclass then l.objid::regprocedure::text
                                when l.classid = 'pg_authid'::regclass then l.objid::regrole::text
                                when l.classid = 'pg_namespace'::regclass then l.objid::regnamespace::text end,
                           l.objid::text, '-')
               || ':' || l.mode as x
          from pg_locks l
         where l.pid = pg_backend_pid() and l.granted
           and l.locktype not in ('relation', 'virtualxid', 'transactionid')
           and not (l.classid = 'pg_namespace'::regclass and l.objid = to_regnamespace('gate'))
           and not (l.classid = 'pg_proc'::regclass
                    and l.objid in (select p.oid from pg_proc p where p.pronamespace = to_regnamespace('gate')))) s;"
NEW_OBJECTS_SQL="select 'new_objects=' || coalesce(string_agg(x, ',' order by x), 'none')
  from (select l.locktype || ':' || l.classid::regclass::text || ':'
               || case when l.classid = 'pg_proc'::regclass then l.objid::regprocedure::text
                       else l.objid::regnamespace::text end || ':' || l.mode as x
          from pg_locks l
         where l.pid = pg_backend_pid() and l.granted
           and ((l.classid = 'pg_namespace'::regclass and l.objid = to_regnamespace('gate'))
             or (l.classid = 'pg_proc'::regclass
                 and l.objid in (select p.oid from pg_proc p where p.pronamespace = to_regnamespace('gate'))))) s;"
MS_SQL="select 'ms=' || round(extract(epoch from clock_timestamp() - now()) * 1000);"

# The file in one transaction, its locks read after the preflight and at the
# end, rolled back.
run_file() { # run_file <application_name> <out>
  { echo "set application_name to '$1';"; echo "begin;"
    head -n "$PRE_END" "$MIG"
    echo "${TABLES_SQL/tables=/pre_tables=}"
    tail -n +"$((PRE_END + 1))" "$MIG"
    echo "$TABLES_SQL"; echo "$OBJECTS_SQL"; echo "$NEW_OBJECTS_SQL"; echo "$MS_SQL"; echo "rollback;"; } \
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
if run_file 0455-fp-alone "$TMP/alone.out"; then ok "1: the file ran"; else bad "1: the file failed: $(cat "$TMP/alone.out")"; fi
check "1: after the preflight, no table lock outside the catalogs" "$(grep '^pre_tables=' "$TMP/alone.out")" "pre_tables=none"
check "1: at the end, no table lock outside the catalogs" "$(grep '^tables=' "$TMP/alone.out")" "tables=none"
check "1: the object locks at the end on anything that existed before are on the four roles" \
  "$(grep '^objects=' "$TMP/alone.out")" "$EXPECTED_OBJECTS"
echo "       (locks on the file's own new objects, which no other session can see: $(grep '^new_objects=' "$TMP/alone.out"))"
below "2: the file runs fast" "$(grep '^ms=' "$TMP/alone.out" | cut -d= -f2)" 250
check "2: rolled back: no schema gate" "$(gate_state)" "none"

# ═══ 3. No table at any point ═════════════════════════════════════════════
echo "== 3. ACCESS EXCLUSIVE held on every table in public, ledger, auth and extensions that postgres may lock: the file, rolled back"
# LOCK ... ACCESS EXCLUSIVE needs UPDATE, DELETE, TRUNCATE or MAINTAIN on the table.
IN_SCHEMAS="c.relkind in ('r', 'p') and n.nspname in ('public', 'ledger', 'auth', 'extensions')"
LOCKABLE="(has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE')
           or has_table_privilege(c.oid, 'TRUNCATE') or has_table_privilege(c.oid, 'MAINTAIN'))"
ALL="$(q "select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace where $IN_SCHEMAS and $LOCKABLE")"
NALL="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where $IN_SCHEMAS and $LOCKABLE")"
check "3: the only table there postgres may not lock is the auth server's own" \
  "$(q "select coalesce(string_agg(n.nspname || '.' || c.relname, ','), 'none')
          from pg_class c join pg_namespace n on n.oid = c.relnamespace where $IN_SCHEMAS and not $LOCKABLE")" "auth.schema_migrations"
check "3: auth.mfa_factors is among the held tables" \
  "$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where $IN_SCHEMAS and $LOCKABLE and n.nspname = 'auth' and c.relname = 'mfa_factors'")" "1"
hold 0455-fp-all-holder "lock table $ALL in access exclusive mode;" 3 "$TMP/all-holder.out" &
PH=$!
if wait_event 0455-fp-all-holder PgSleep; then
  ok "3: another session holds ACCESS EXCLUSIVE on $NALL tables"
else
  bad "3: the holder never got its locks: $(cat "$TMP/all-holder.out")"
fi
if run_file 0455-fp-all "$TMP/all.out"; then ok "3: the file ran to its end"; else bad "3: the file failed: $(cat "$TMP/all.out")"; fi
below "3: under its lock_timeout" "$(grep '^ms=' "$TMP/all.out" | cut -d= -f2)" 900
check "3: the holder still held them when the file finished" "$(q "select count(*) from pg_stat_activity where application_name = '0455-fp-all-holder' and wait_event = 'PgSleep'")" "1"
wait "$PH"

# ═══ 4. The preflight refuses a second run ════════════════════════════════
echo "== 4. a second run stops the file before it changes anything"
{ echo "begin;"; cat "$MIG"; cat "$MIG"; echo "select 'DONE';"; echo "rollback;"; } \
  | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/second.x55" 2>&1
if grep -q 'ERROR:  55000' "$TMP/second.x55" && grep -q 'HINT:  gate_helper_preflight' "$TMP/second.x55" \
   && grep -qF 'schema gate already exists' "$TMP/second.x55" && ! grep -q '^DONE$' "$TMP/second.x55"; then
  ok "4: 55000 gate_helper_preflight naming 'schema gate already exists'"
else
  bad "4: $(grep -E 'ERROR|HINT' "$TMP/second.x55" | head -3 | tr '\n' ' ')"
fi
check "4: nothing kept" "$(gate_state)" "none"

# ═══ 5. A file that fails applies nothing ═════════════════════════════════
echo "== 5. another open transaction has created a schema named gate: the file, run as the push runs it"
hold 0455-fp-ns-holder "create schema gate;" 4 "$TMP/ns-holder.log" &
PH=$!
wait_event 0455-fp-ns-holder PgSleep || bad "5: the holder never reached its pg_sleep: $(cat "$TMP/ns-holder.log")"
observe_wait 0455-fp-ns-file 'create schema gate' "$TMP/ns-observed.log" &
PO=$!
t0=$(now_ms); push_file 0455-fp-ns-file "$TMP/ns-file.x55"; rc=$?; t1=$(now_ms)
wait "$PO"; wait "$PH"
check "5: its preflight passed and it waited in its CREATE SCHEMA" "$(grep '^statement=' "$TMP/ns-observed.log")" "statement=1"
check "5: on the other transaction" "$(grep '^waits=' "$TMP/ns-observed.log")" "waits=transactionid:-:ShareLock"
check "5: the file ends with 55P03 (psql exit 3)" "$rc:$(grep -c '55P03' "$TMP/ns-file.x55")" "3:1"
below "5: it gives up at its lock_timeout" "$((t1 - t0))" 2000
check "5: nothing kept (no schema gate)" "$(gate_state)" "none"

# ═══ 6. Never a lock timeout or a retryable error ═════════════════════════
echo "== 6. no session in checks 1-3 saw 55P03, 40001 or 40P01"
check "6: none in any session's output" "$(cat "$TMP"/*.out | grep -cE '55P03|40001|40P01|lock timeout|could not serialize|deadlock detected')" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
exit "$FAILS"
