#!/usr/bin/env bash
#
# Lock footprint of the S47 migration
# (supabase/migrations/*_act_as_expiry_in_access_gates.sql). The file
# restates six functions and comments three of them, and nothing else.
# What it locks:
#
#   - public.warehouses, organization_members, user_profiles and
#     user_warehouse_assignments, AccessShareLock, held to commit. The three
#     SQL-language bodies (user_can_access_warehouse,
#     user_can_access_inventory, my_warehouse_ids) are parsed when they are
#     created (check_function_bodies, on by default and in the push), and the
#     parse opens every table a body reads. AccessShareLock conflicts only
#     with ACCESS EXCLUSIVE: no read, write, row lock or autovacuum waits for
#     it, and the file waits only behind an ACCESS EXCLUSIVE on one of the
#     four that is held or queued (an ALTER TABLE, VACUUM FULL, another
#     migration), where its 900 ms lock_timeout ends it with 55P03 and
#     nothing applied.
#   - COMMENT ON FUNCTION's ShareUpdateExclusiveLock on
#     user_can_access_warehouse, user_can_access_inventory and ledger._seal,
#     held to commit (only other DDL on the same function waits).
#   - Nothing else: the preflight reads catalogs only, and the three plpgsql
#     bodies (user_can_see_item_category, ledger._seal, the maintenance guard)
#     are checked for syntax only, so the tables they read are not opened.
#
# A call of a function takes no lock on it, so a call in flight never holds
# the file up and the file never holds a call up. Checked:
#
#   1a. Run as one transaction, the file holds at its end AccessShareLock on
#       the four tables, and no other lock on a table outside the catalogs.
#   1b. Its only object locks are COMMENT's three ShareUpdateExclusiveLocks,
#       on the three commented functions.
#   2.  The file runs in under 250 ms on the local stack.
#   3.  A call in flight: a manager's claim_picking waits on its order row
#       (held by a third session) while the file runs. The file finishes under
#       its 900 ms lock_timeout and the claim is still waiting when it does;
#       the claim then finishes (it calls user_can_access_inventory, which the
#       file restates).
#   4.  No session in checks 1-3 saw 55P03 (lock_timeout), 40001 or 40P01.
#   5.  The four tables it waits for: with ACCESS EXCLUSIVE held on each of
#       them in turn elsewhere, the file run as the push runs it (one
#       transaction, committed at its end) waits on an AccessShareLock on that
#       table in user_can_access_warehouse's statement (the first body that
#       reads it), and ends with 55P03 at its lock_timeout, in under 2 s,
#       keeping nothing.
#   6.  No other table: with ACCESS EXCLUSIVE held on every other table in
#       public and ledger (maintenance_requests, locations and
#       user_category_assignments, which the plpgsql bodies read, included),
#       the file runs to its end under its lock_timeout.
#   7.  A file that fails applies nothing: with COMMENT's lock on ledger._seal
#       (the file's last statement) held elsewhere, the file restates all six
#       bodies, then ends with 55P03 on that comment; the six functions'
#       pg_proc rows and comment rows are the row versions they were (xmin),
#       so the push can simply be run again. Control: the same file with
#       nothing held, read inside its own transaction before its rollback,
#       rewrote the six pg_proc rows and the three comments (the witness sees
#       a kept statement).
#
# Every migration session rolls back, so the script changes nothing but its
# own fixture rows. The file's preflight refuses a second run, so this runs
# against a LOCAL stack at the head before the S47 migration (the script
# stops if any of the six bodies already carries an S47 line). CONTAINER as
# in the other scripts here (default the dev stack's supabase_db_stockpilot;
# the migration scratch stack is supabase_db_spmig). Fixtures live under the
# 54702222-... namespace and are removed at the start, at the end and by the
# EXIT trap. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/*_migration_lock_footprint.sh for the
# file that carries the S47 migration's number (MIG=<path> for another copy)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# MIG may name a mutated copy of the file, to prove a check sees what it says.
# Otherwise the migration is found by its name, whatever number it ships with.
MIG="${MIG:-}"
if [ -z "$MIG" ]; then
  for f in "$REPO"/supabase/migrations/*_act_as_expiry_in_access_gates.sql; do MIG="$f"; break; done
fi
TMP="$(mktemp -d)"

ORG='54702222-0000-0000-0000-00000000000a'
MGR='54702222-0000-0000-0000-0000000000a1'
WH='54702222-0000-0000-0000-0000000000c1'
O1='54702222-0000-0000-0000-0000000000d1'

SIX="'public.user_can_access_warehouse(uuid,uuid,text)'::regprocedure,
     'public.user_can_access_inventory(uuid,uuid,uuid,text)'::regprocedure,
     'public.my_warehouse_ids()'::regprocedure,
     'public.user_can_see_item_category(uuid,uuid,uuid)'::regprocedure,
     'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])'::regprocedure,
     'public.tg_maintenance_requests_guard()'::regprocedure"
FOUR="public.organization_members public.user_profiles public.user_warehouse_assignments public.warehouses"

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

# The six functions' pg_proc row versions and comment row versions, one
# '<function>=<pg_proc xmin>:<comment xmin or ->' each, ';' between them: a statement of the
# file that is kept rewrites them (CREATE OR REPLACE and COMMENT write a new
# row version), so equal xmins mean nothing kept.
ROWS_SQL="select string_agg(p.oid::regprocedure::text || '=' || p.xmin::text || ':' || coalesce(d.xmin::text, '-'), ';'
                  order by p.oid::regprocedure::text)
  from pg_proc p
  left join pg_description d on d.objoid = p.oid and d.classoid = 'pg_proc'::regclass and d.objsubid = 0
 where p.oid in ($SIX)"
row_versions() { q "$ROWS_SQL"; }
changed_rows() { # changed_rows <before> <after>: how many of the twelve row versions differ
  python3 - "$1" "$2" <<'PY'
import sys
def parts(s):
    out = {}
    for item in s.split(';'):
        fn, versions = item.rsplit('=', 1)
        proc, desc = versions.split(':')
        out[fn + '/proc'] = proc
        out[fn + '/comment'] = desc
    return out
b, a = parts(sys.argv[1]), parts(sys.argv[2])
print(sum(1 for k in b if b[k] != a.get(k)) if set(b) == set(a) else 'shape changed')
PY
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.notifications where organization_id = '$ORG';
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.order_requests where organization_id = '$ORG')
                  + (select count(*) from public.organizations where id = '$ORG')
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

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_act_as_expiry_in_access_gates.sql"; exit 1; }
if [ "$(q "select count(*) from pg_proc where oid in ($SIX)")" != "6" ]; then
  echo "one of the six functions the file restates is missing on this stack"; exit 1
fi
if [ "$(q "select count(*) from pg_proc where oid in ($SIX) and prosrc like '%-- S47%'")" != "0" ]; then
  echo "the S47 migration is already applied on this stack (its preflight refuses a second run): use the head before it"; exit 1
fi
if grep -qiE '^[[:space:]]*(begin|commit|rollback|start transaction)[[:space:]]*;' "$MIG"; then
  echo "the file has its own transaction control: this script wraps it in one"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', 's47-fp-mgr@s47.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', 'S47 Footprint Org', 's47-footprint');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', 'S47 FP Main', 'WH-S47-FP', 'active');
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type, assigned_picker_id)
  values ('$O1', '$ORG', '$WH', 'pick_slip_generated', '$MGR', 'internal', 'pickup', null);
SQL
then
  echo "fixture setup failed"; exit 1
fi

LOCKS_SQL="select 'tables=' || coalesce(string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode), 'none')
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
select 'objects=' || count(*) || '/' || count(*) filter (where l.classid = 'pg_proc'::regclass and l.mode = 'ShareUpdateExclusiveLock'
         and l.objid in ('public.user_can_access_warehouse(uuid,uuid,text)'::regprocedure,
                         'public.user_can_access_inventory(uuid,uuid,uuid,text)'::regprocedure,
                         'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])'::regprocedure))
  from pg_locks l where l.locktype = 'object' and l.pid = pg_backend_pid() and l.granted;
select 'ms=' || round(extract(epoch from clock_timestamp() - now()) * 1000);"

# The file in one transaction, its locks (and, with a third argument, the
# six functions' row versions as this transaction sees them) read before the
# rollback.
run_file() { # run_file <application_name> <out> [rows]
  { echo "set application_name to '$1';"; echo "begin;"; cat "$MIG"; echo "$LOCKS_SQL"
    if [ -n "${3:-}" ]; then echo "select 'rows=' || ($ROWS_SQL);"; fi
    echo "rollback;"; } \
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
if run_file s47-fp-alone "$TMP/alone.out"; then ok "1: the file ran"; else bad "1: the file failed: $(cat "$TMP/alone.out")"; fi
check "1a: tables held at the end: AccessShareLock on the four tables the SQL bodies read, nothing else" \
  "$(grep '^tables=' "$TMP/alone.out")" \
  "tables=public.organization_members:AccessShareLock,public.user_profiles:AccessShareLock,public.user_warehouse_assignments:AccessShareLock,public.warehouses:AccessShareLock"
check "1b: object locks: COMMENT's ShareUpdateExclusiveLock on the three commented functions, nothing else" "$(grep '^objects=' "$TMP/alone.out")" "objects=3/3"
below "2: the file runs fast" "$(grep '^ms=' "$TMP/alone.out" | cut -d= -f2)" 250

# ═══ 3. A call in flight ══════════════════════════════════════════════════
echo "== 3. the file while a manager's claim_picking waits on its order row"
( "${PSQL[@]}" > "$TMP/holder.out" 2>&1 <<SQL
set application_name to 's47-fp-holder';
begin;
select 'H=' || id from public.order_requests where id = '$O1' for update;
select pg_sleep(3);
rollback;
SQL
) &
PH=$!
wait_event s47-fp-holder PgSleep || bad "3: the holder never reached its pg_sleep"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/call.out" 2>&1 <<SQL
set application_name to 's47-fp-call';
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || coalesce(r.assigned_picker_id::text, 'none') from public.claim_picking('$O1') r;
rollback;
SQL
) &
PA=$!
if wait_locked s47-fp-call; then ok "3: the claim waits on the order row"; else bad "3: the claim never waited on the row"; fi
if run_file s47-fp-file "$TMP/file.out"; then ok "3: the file ran while the claim was in flight"; else bad "3: the file failed: $(cat "$TMP/file.out")"; fi
check "3: the claim was still waiting when the file finished" "$(waiting_on_lock s47-fp-call)" "1"
below "3: the file finished under its lock_timeout" "$(grep '^ms=' "$TMP/file.out" | cut -d= -f2)" 900
wait "$PH"; wait "$PA"
check "3: the claim then finished" "$(grep -c "^A=$MGR\$" "$TMP/call.out")" "1"
check "3: the order is unchanged (every session rolled back)" \
  "$(q "select coalesce(assigned_picker_id::text, 'none') from public.order_requests where id = '$O1'")" "none"

# ═══ 4. Never a lock timeout or a retryable error ═════════════════════════
echo "== 4. no session in checks 1-3 saw 55P03, 40001 or 40P01"
check "4: none in any session's output" "$(cat "$TMP"/*.out | grep -cE '55P03|40001|40P01|lock timeout|could not serialize|deadlock detected')" "0"

# ═══ 5. The four tables the file waits for ════════════════════════════════
for t in $FOUR; do
  echo "== 5. ACCESS EXCLUSIVE held on $t: the file, run as the push runs it"
  tag="${t#public.}"
  before="$(row_versions)"
  hold "s47-fp-ae-$tag" "lock table $t in access exclusive mode;" 4 "$TMP/ae-holder-$tag.log" &
  PH=$!
  wait_event "s47-fp-ae-$tag" PgSleep || bad "5 $tag: the holder never got its lock: $(cat "$TMP/ae-holder-$tag.log")"
  observe_wait "s47-fp-ae-file-$tag" 'create or replace function public\.user_can_access_warehouse\(' "$TMP/ae-observed-$tag.log" &
  PO=$!
  t0=$(now_ms); push_file "s47-fp-ae-file-$tag" "$TMP/ae-file-$tag.x55"; rc=$?; t1=$(now_ms)
  wait "$PO"; wait "$PH"
  check "5 $tag: it waits on an AccessShareLock on $tag, and nothing else" "$(grep '^waits=' "$TMP/ae-observed-$tag.log")" "waits=relation:$tag:AccessShareLock"
  check "5 $tag: in user_can_access_warehouse's statement" "$(grep '^statement=' "$TMP/ae-observed-$tag.log")" "statement=1"
  check "5 $tag: the file ends with 55P03 (psql exit 3)" "$rc:$(grep -c '55P03' "$TMP/ae-file-$tag.x55")" "3:1"
  below "5 $tag: it gives up at its lock_timeout" "$((t1 - t0))" 2000
  check "5 $tag: nothing kept (the six functions' pg_proc and comment row versions)" "$(changed_rows "$before" "$(row_versions)")" "0"
done

# ═══ 6. No other table ════════════════════════════════════════════════════
echo "== 6. ACCESS EXCLUSIVE held on every other table in public and ledger: the file, rolled back"
OTHERS_WHERE="c.relkind in ('r', 'p') and n.nspname in ('public', 'ledger')
  and (n.nspname, c.relname) not in (('public', 'organization_members'), ('public', 'user_profiles'),
                                     ('public', 'user_warehouse_assignments'), ('public', 'warehouses'))"
OTHERS="$(q "select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where $OTHERS_WHERE")"
NOTHERS="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where $OTHERS_WHERE")"
check "6: maintenance_requests, locations and user_category_assignments are among them" \
  "$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where $OTHERS_WHERE
          and c.relname in ('maintenance_requests', 'locations', 'user_category_assignments')")" "3"
hold s47-fp-others-holder "lock table $OTHERS in access exclusive mode;" 3 "$TMP/others-holder.log" &
PH=$!
if wait_event s47-fp-others-holder PgSleep; then
  ok "6: another session holds ACCESS EXCLUSIVE on $NOTHERS tables"
else
  bad "6: the holder never got its locks: $(cat "$TMP/others-holder.log")"
fi
if run_file s47-fp-others "$TMP/others.log"; then ok "6: the file ran"; else bad "6: the file failed: $(cat "$TMP/others.log")"; fi
below "6: under its lock_timeout" "$(grep '^ms=' "$TMP/others.log" | cut -d= -f2)" 900
check "6: the holder still held them when the file finished" "$(q "select count(*) from pg_stat_activity where application_name = 's47-fp-others-holder' and wait_event = 'PgSleep'")" "1"
wait "$PH"

# ═══ 7. A file that fails applies nothing ═════════════════════════════════
echo "== 7. COMMENT's lock on ledger._seal held elsewhere: the file, run as the push runs it"
before="$(row_versions)"
hold s47-fp-late-holder "comment on function ledger._seal(uuid, uuid, uuid, text, public.stock_draw_holding[], uuid[]) is 'held by the S47 footprint check';" 4 "$TMP/late-holder.log" &
PH=$!
wait_event s47-fp-late-holder PgSleep || bad "7: the holder never got its lock: $(cat "$TMP/late-holder.log")"
observe_wait s47-fp-late-file 'comment on function ledger\._seal\(' "$TMP/late-observed.log" &
PO=$!
push_file s47-fp-late-file "$TMP/late-file.x55"; rc=$?
wait "$PO"; wait "$PH"
check "7: it reached the last statement, ledger._seal's comment" "$(grep '^statement=' "$TMP/late-observed.log")" "statement=1"
check "7: there it waits on that function's ShareUpdateExclusiveLock" "$(grep '^waits=' "$TMP/late-observed.log")" "waits=object:-:ShareUpdateExclusiveLock"
check "7: the file ends with 55P03 (psql exit 3)" "$rc:$(grep -c '55P03' "$TMP/late-file.x55")" "3:1"
check "7: nothing kept: the six bodies and two comments it wrote are rolled back" "$(changed_rows "$before" "$(row_versions)")" "0"
echo "== 7. control: the same file with nothing held, its row versions read inside its own transaction"
if run_file s47-fp-control "$TMP/control.log" rows; then ok "7: control: the file ran"; else bad "7: control: the file failed: $(cat "$TMP/control.log")"; fi
check "7: control: inside it, the six pg_proc rows and the three comments are new row versions (the witness sees a kept statement)" \
  "$(changed_rows "$before" "$(grep '^rows=' "$TMP/control.log" | cut -d= -f2-)")" "9"
check "7: control: and after its rollback, none is" "$(changed_rows "$before" "$(row_versions)")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
