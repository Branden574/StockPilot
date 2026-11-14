#!/usr/bin/env bash
#
# Lock footprint of the S42 migration
# (supabase/migrations/*_release_cycle_count_assignee_check.sql). The file
# restates release_cycle_count and gives it a comment, and nothing else.
# What it locks:
#
#   - public.cycle_counts, AccessShareLock, released at once. Checking the
#     body compiles it (check_function_bodies, on by default and in the
#     push), and the body declares public.cycle_counts%rowtype, so the
#     compile loads that row type's description, which opens the table with
#     AccessShareLock and closes it again. The lock conflicts only with
#     ACCESS EXCLUSIVE: no read, write, row lock or autovacuum waits for it,
#     and the file waits only behind an ACCESS EXCLUSIVE on cycle_counts that
#     is held or queued (an ALTER TABLE, VACUUM FULL, another migration),
#     where its 900 ms lock_timeout ends it with 55P03 and nothing applied.
#   - COMMENT ON FUNCTION's ShareUpdateExclusiveLock on release_cycle_count,
#     held to commit (only other DDL on the same function waits).
#
# A call of a function takes no lock on it, so a release in flight never
# holds the file up and the file never holds a release up. Checked:
#
#   1a. Run as one transaction, the file holds no table lock outside the
#       catalogs at its end (the AccessShareLock is already released).
#   1b. Its only object lock is COMMENT's ShareUpdateExclusiveLock on
#       release_cycle_count (a lock only other DDL on the function waits for).
#   2.  The file runs in under 250 ms on the local stack.
#   3.  A release in flight: a manager's release_cycle_count waits on its
#       count row (held by a third session) while the file runs. The file
#       finishes under its 900 ms lock_timeout and the release is still
#       waiting when it does; the release then finishes.
#   4.  No session in checks 1-3 saw 55P03 (lock_timeout), 40001 or 40P01.
#   5.  The one table it waits for: with ACCESS EXCLUSIVE held on
#       public.cycle_counts elsewhere, the file run as the push runs it (one
#       transaction, committed at its end) waits on an AccessShareLock on
#       cycle_counts in release_cycle_count's statement, and ends with 55P03
#       at its lock_timeout, in under 2 s, keeping nothing.
#   6.  No other table: with ACCESS EXCLUSIVE held on every other table in
#       public and ledger, the file runs to its end under its lock_timeout.
#   7.  A file that fails applies nothing: with COMMENT's lock on
#       release_cycle_count held elsewhere, the file restates the body, then
#       ends with 55P03 on the comment; the function's pg_proc row and
#       comment row are the row versions they were (xmin), so the push can
#       simply be run again. Control: the same file committed rewrites both
#       rows (the witness sees a kept statement).
#
# The migration sessions roll back, except check 7's control, which commits
# the file itself: the stack already has it, so no body or comment text
# changes. Runs against a LOCAL stack only, with the S42 migration applied
# (running the file again is the same statements; CONTAINER as in the race
# script beside this one, default the dev stack's supabase_db_stockpilot; the
# migration scratch stack is supabase_db_spmig). Fixtures live under the
# 54202222-... namespace and are removed at the start, at the end and by the
# EXIT trap. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/*_migration_lock_footprint.sh for the
# file that carries the S42 migration's number

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# MIG may name a mutated copy of the file, to prove a check sees what it says.
# Otherwise the migration is found by its name, whatever number it ships with.
MIG="${MIG:-}"
if [ -z "$MIG" ]; then
  for f in "$REPO"/supabase/migrations/*_release_cycle_count_assignee_check.sql; do MIG="$f"; break; done
fi
TMP="$(mktemp -d)"

ORG='54202222-0000-0000-0000-00000000000a'
MGR='54202222-0000-0000-0000-0000000000a1'
WH='54202222-0000-0000-0000-0000000000c1'
C1='54202222-0000-0000-0000-0000000000d1'

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

# The function's pg_proc row and comment row versions: a statement of the
# file that is kept rewrites them (CREATE OR REPLACE and COMMENT write a new
# row version even for the same text), so equal xmins mean nothing kept.
ROWS_SQL="select p.xmin::text || ':' || coalesce(d.xmin::text, '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  left join pg_description d on d.objoid = p.oid and d.classoid = 'pg_proc'::regclass and d.objsubid = 0
 where n.nspname = 'public' and p.proname = 'release_cycle_count'"
row_versions() { q "$ROWS_SQL"; }
changed_rows() { # changed_rows <before> <after>: how many of the two row versions differ
  local n=0 bp bd ap ad
  IFS=':' read -r bp bd <<< "$1"
  IFS=':' read -r ap ad <<< "$2"
  [ "$bp" = "$ap" ] || n=$((n + 1))
  [ "$bd" = "$ad" ] || n=$((n + 1))
  echo "$n"
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.notifications where organization_id = '$ORG';
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.cycle_counts where organization_id = '$ORG')
                  + (select count(*) from auth.users where id = '$MGR')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
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

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_release_cycle_count_assignee_check.sql"; exit 1; }
if [ "$(q "select count(*) from pg_proc where proname = 'release_cycle_count' and prosrc like '%S42: a count nobody is assigned to%'")" != "1" ]; then
  echo "the S42 migration is not applied on this stack"; exit 1
fi
# Step 7's control commits this file again. On a stack where a later
# migration restated release_cycle_count (the S87 lookup block), that would
# put this file's body back, so the script refuses there.
if [ "$(q "select count(*) from pg_proc where proname = 'release_cycle_count' and prosrc like '%-- S87:%'")" != "0" ]; then
  echo "a later migration restated release_cycle_count: this script would put the 0419 body back; run it on a stack at 0419"; exit 1
fi
if grep -qiE '^[[:space:]]*(begin|commit|rollback|start transaction)[[:space:]]*;' "$MIG"; then
  echo "the file has its own transaction control: this script wraps it in one"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', 's42-fp-mgr@s42.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', 'S42 Footprint Org', 's42-footprint');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', 'S42 FP Main', 'WH-S42-FP', 'active');
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, started_by, assigned_to, assignment_claimed_at, assignment_claimed_by,
   assignment_version)
  values ('$C1', '$ORG', '$WH', 'in_progress', '$MGR', '$MGR', now(), '$MGR', 1);
SQL
then
  echo "fixture setup failed"; exit 1
fi

LOCKS_SQL="select 'tables=' || coalesce(string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode), 'none')
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
select 'objects=' || count(*) || '/' || count(*) filter (where l.classid = 'pg_proc'::regclass and l.mode = 'ShareUpdateExclusiveLock'
         and l.objid = 'public.release_cycle_count(uuid, text)'::regprocedure)
  from pg_locks l where l.locktype = 'object' and l.pid = pg_backend_pid() and l.granted;
select 'ms=' || round(extract(epoch from clock_timestamp() - now()) * 1000);"

# The file in one transaction, its locks read before the rollback.
run_file() { # run_file <application_name> <out>
  { echo "set application_name to '$1';"; echo "begin;"; cat "$MIG"; echo "$LOCKS_SQL"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$2" 2>&1
}

# The file as the push runs it: one transaction, committed if it reaches its
# end (the CLI sends each migration file as one implicitly transactional
# batch). Used only where the file is expected to fail, and by check 7's
# control on a stack that already has it.
push_file() { # push_file <application_name> <out>
  { echo "set application_name to '$1';"; echo "begin;"; cat "$MIG"; echo "commit;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$2" 2>&1
}

# ═══ 1 and 2. The file alone ══════════════════════════════════════════════
echo "== 1-2. the file in one transaction, rolled back"
if run_file s42-fp-alone "$TMP/alone.out"; then ok "1: the file ran"; else bad "1: the file failed: $(cat "$TMP/alone.out")"; fi
check "1a: no table lock outside the catalogs is still held at the end (cycle_counts' AccessShareLock is released at once; check 5 sees it)" "$(grep '^tables=' "$TMP/alone.out")" "tables=none"
check "1b: object locks: COMMENT's ShareUpdateExclusiveLock on release_cycle_count, nothing else" "$(grep '^objects=' "$TMP/alone.out")" "objects=1/1"
below "2: the file runs fast" "$(grep '^ms=' "$TMP/alone.out" | cut -d= -f2)" 250

# ═══ 3. A release in flight ═══════════════════════════════════════════════
echo "== 3. the file while a manager's release waits on its count row"
( "${PSQL[@]}" > "$TMP/holder.out" 2>&1 <<SQL
set application_name to 's42-fp-holder';
begin;
select 'H=' || id from public.cycle_counts where id = '$C1' for update;
select pg_sleep(3);
rollback;
SQL
) &
PH=$!
wait_event s42-fp-holder PgSleep || bad "3: the holder never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/call.out" 2>&1 <<SQL
set application_name to 's42-fp-call';
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || coalesce(r.assigned_to::text, 'none') || '/' || r.assignment_version
  from public.release_cycle_count('$C1', 'Footprint check') r;
rollback;
SQL
) &
PA=$!
if wait_locked s42-fp-call; then ok "3: the release waits on the count row"; else bad "3: the release never waited on the row"; fi
if run_file s42-fp-file "$TMP/file.out"; then ok "3: the file ran while the release was in flight"; else bad "3: the file failed: $(cat "$TMP/file.out")"; fi
check "3: the release was still waiting when the file finished" "$(waiting_on_lock s42-fp-call)" "1"
below "3: the file finished under its lock_timeout" "$(grep '^ms=' "$TMP/file.out" | cut -d= -f2)" 900
check "3: no lock on a table outside the catalogs" "$(grep '^tables=' "$TMP/file.out")" "tables=none"
wait "$PH"; wait "$PA"
check "3: the release then finished" "$(grep -c '^A=none/2$' "$TMP/call.out")" "1"
check "3: the count is unchanged (every session rolled back)" \
  "$(q "select coalesce(assigned_to::text, 'none') || '/' || assignment_version from public.cycle_counts where id = '$C1'")" "$MGR/1"

# ═══ 4. Never a lock timeout or a retryable error ═════════════════════════
echo "== 4. no session in checks 1-3 saw 55P03, 40001 or 40P01"
check "4: none in any session's output" "$(cat "$TMP"/*.out | grep -cE '55P03|40001|40P01|lock timeout|could not serialize|deadlock detected')" "0"

# ═══ 5. The one table the file waits for ══════════════════════════════════
echo "== 5. ACCESS EXCLUSIVE held on public.cycle_counts: the file, run as the push runs it"
before="$(row_versions)"
hold s42-fp-ae-holder "lock table public.cycle_counts in access exclusive mode;" 4 "$TMP/ae-holder.log" &
PH=$!
wait_event s42-fp-ae-holder PgSleep || bad "5: the holder never got its lock: $(cat "$TMP/ae-holder.log")"
observe_wait s42-fp-ae-file 'CREATE OR REPLACE FUNCTION public\.release_cycle_count\(' "$TMP/ae-observed.log" &
PO=$!
t0=$(now_ms); push_file s42-fp-ae-file "$TMP/ae-file.x55"; rc=$?; t1=$(now_ms)
wait "$PO"; wait "$PH"
check "5: it waits on an AccessShareLock on cycle_counts, and nothing else" "$(grep '^waits=' "$TMP/ae-observed.log")" "waits=relation:cycle_counts:AccessShareLock"
check "5: in release_cycle_count's statement" "$(grep '^statement=' "$TMP/ae-observed.log")" "statement=1"
check "5: compiling release_cycle_count's body is what waited" "$(grep -c 'compilation of PL/pgSQL function "release_cycle_count"' "$TMP/ae-file.x55")" "1"
check "5: the file ends with 55P03 (psql exit 3)" "$rc:$(grep -c '55P03' "$TMP/ae-file.x55")" "3:1"
below "5: it gives up at its lock_timeout" "$((t1 - t0))" 2000
check "5: nothing kept (the function's pg_proc and comment row versions)" "$(changed_rows "$before" "$(row_versions)")" "0"

# ═══ 6. No other table ════════════════════════════════════════════════════
echo "== 6. ACCESS EXCLUSIVE held on every other table in public and ledger: the file, rolled back"
OTHERS_WHERE="c.relkind in ('r', 'p') and n.nspname in ('public', 'ledger') and (n.nspname, c.relname) <> ('public', 'cycle_counts')"
OTHERS="$(q "select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where $OTHERS_WHERE")"
NOTHERS="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where $OTHERS_WHERE")"
hold s42-fp-others-holder "lock table $OTHERS in access exclusive mode;" 3 "$TMP/others-holder.log" &
PH=$!
if wait_event s42-fp-others-holder PgSleep; then
  ok "6: another session holds ACCESS EXCLUSIVE on $NOTHERS tables"
else
  bad "6: the holder never got its locks: $(cat "$TMP/others-holder.log")"
fi
if run_file s42-fp-others "$TMP/others.log"; then ok "6: the file ran"; else bad "6: the file failed: $(cat "$TMP/others.log")"; fi
below "6: under its lock_timeout" "$(grep '^ms=' "$TMP/others.log" | cut -d= -f2)" 900
check "6: the holder still held them when the file finished" "$(q "select count(*) from pg_stat_activity where application_name = 's42-fp-others-holder' and wait_event = 'PgSleep'")" "1"
wait "$PH"

# ═══ 7. A file that fails applies nothing ═════════════════════════════════
echo "== 7. COMMENT's lock on release_cycle_count held elsewhere: the file, run as the push runs it"
before="$(row_versions)"
hold s42-fp-late-holder "comment on function public.release_cycle_count(uuid, text) is 'held by the S42 footprint check';" 4 "$TMP/late-holder.log" &
PH=$!
wait_event s42-fp-late-holder PgSleep || bad "7: the holder never got its lock: $(cat "$TMP/late-holder.log")"
observe_wait s42-fp-late-file 'comment on function public\.release_cycle_count\(' "$TMP/late-observed.log" &
PO=$!
push_file s42-fp-late-file "$TMP/late-file.x55"; rc=$?
wait "$PO"; wait "$PH"
check "7: it reached the last statement, release_cycle_count's comment" "$(grep '^statement=' "$TMP/late-observed.log")" "statement=1"
check "7: there it waits on that function's ShareUpdateExclusiveLock" "$(grep '^waits=' "$TMP/late-observed.log")" "waits=object:-:ShareUpdateExclusiveLock"
check "7: the file ends with 55P03 (psql exit 3)" "$rc:$(grep -c '55P03' "$TMP/late-file.x55")" "3:1"
check "7: nothing kept: the body it restated is rolled back" "$(changed_rows "$before" "$(row_versions)")" "0"
echo "== 7. control: the same file committed with nothing held (the stack has it already: the same text)"
if push_file s42-fp-control "$TMP/control.log"; then ok "7: control: the file committed"; else bad "7: control: the file failed: $(cat "$TMP/control.log")"; fi
check "7: control: both row versions rewritten (the witness sees a kept statement)" "$(changed_rows "$before" "$(row_versions)")" "2"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
