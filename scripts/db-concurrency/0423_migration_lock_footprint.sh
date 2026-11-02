#!/usr/bin/env bash
#
# Lock footprint of migration 0423 (purchase order write scope, docket S46;
# the file is found by its name, so a renumber at push time needs no edit
# here). The push runs the whole file as one batch, so every table lock a
# statement takes is held until the file commits. DROP POLICY, CREATE POLICY,
# ALTER POLICY and COMMENT ON POLICY take ACCESS EXCLUSIVE on their table
# (purchase_orders, purchase_order_items, recurring_po_templates,
# po_attachments, storage.objects, and checklist_runs when the receiving
# checklist is in), CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
# purchase_orders and recurring_po_templates, supautils takes ACCESS EXCLUSIVE
# on every table supautils.policy_grants lists for the role (auth, storage,
# realtime) on each policy statement, and the new policy expressions read
# locations (ACCESS SHARE) and purchase_orders while they are parsed. The
# functions of the review round (2026-11-02) are plpgsql and lock nothing.
# The app reads purchase_order_items and then purchase_orders
# (the open-PO read, the cancel keep-checks, the reports), and a raw line
# write takes FOR SHARE on its purchase order after the line. So the file
# takes every lock in one NOWAIT prelude (`do $lock46$ ... end $lock46$;`)
# and never waits holding one. A busy table fails one attempt; the attempt's
# subtransaction rolls back (releasing what it took) and the prelude retries
# after a pause, up to 40 times, holding no table lock in between. This
# proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight, next_po_number, the review round's
#       functions, their grants and their comments lock nothing).
#   1b. The prelude takes ACCESS SHARE on locations, ACCESS EXCLUSIVE on
#       purchase_orders, purchase_order_items, recurring_po_templates,
#       po_attachments, storage.objects (and checklist_runs when it exists)
#       and on every existing table in supautils.policy_grants for the role,
#       and nothing else.
#   1c. No statement after the prelude takes a lock the prelude does not
#       cover (a new table, or a stronger mode on a table it holds below
#       ACCESS EXCLUSIVE), so the file can never wait while holding one.
#   2.  The hold, from the prelude to the end of the file, is under 250 ms on
#       the local stack.
#   3.  A purchase order reader, a line writer, an attachment reader, a
#       template writer or a reader of auth.users, held
#       longer than the retries last: the file retries, holds NO table lock
#       whenever it is paused between attempts (sampled from pg_locks), and
#       fails 55P03 after its bounded retries (40 attempts), writing nothing.
#   3b. The same purchase order reader held only 0.6 s: the file retries past
#       it and runs to the end.
#   4.  The app's shapes, each already holding its first lock when the file
#       starts: lines read, then the purchase order read (the open-PO read);
#       a line written, then its purchase order FOR SHARE (the line guard);
#       and the reverse, a purchase order written, then its lines read. The
#       person's transaction completes with no error (no 40P01), and the
#       file, which never waits holding a lock, either runs to the end once it
#       committed or fails 55P03; never 40P01.
#   5.  While the file holds its locks (an artificial 1 s), a new purchase
#       order reader and a new reader of auth.users wait only for the hold,
#       then read.
#   6.  CONTROL, the hazard the prelude removes: the same file with the prelude
#       cut out and lock_timeout 5s, against the first shape of 4. The file
#       holds purchase_orders (its policies are replaced first) and waits for
#       purchase_order_items; the reader then waits for purchase_orders;
#       Postgres ends one side with 40P01. Required: at least one 40P01 here
#       (if this ever stops reproducing, the hazard analysis in the migration
#       header needs re-reading).
#
# The migration sessions ALWAYS roll back, so the script changes nothing but
# its own fixture rows (removed at the start, the end and by the EXIT trap).
# It needs the head just before the purchase order write scope migration.
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack, holding its slot). Exit status 0
# = every check passed.
#
# Usage: bash scripts/db-concurrency/0423_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rebase.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_po_write_scope.sql' | sort | tail -n 1)}"
TMP="$(mktemp -d)"
BG=()

ORG='04234646-0000-0000-0000-00000000000a'
MGR='04234646-0000-0000-0000-0000000000a1'
WH='04234646-0000-0000-0000-0000000000c1'
LOC='04234646-0000-0000-0000-0000000000c2'
ITEM='04234646-0000-0000-0000-0000000000c3'
PO='04234646-0000-0000-0000-0000000000d1'
LINE='04234646-0000-0000-0000-0000000000d2'

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
cleanup_rows() {
  "${PSQL[@]}" >/dev/null 2>&1 <<SQL
delete from public.purchase_order_items where organization_id = '$ORG';
delete from public.purchase_orders where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.locations where organization_id = '$ORG';
delete from public.warehouses where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$MGR';
SQL
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local p
  for p in "${BG[@]:-}"; do [ -n "$p" ] && wait "$p" 2> /dev/null; done
  cleanup_rows
  rm -rf "$TMP"
}
trap cleanup EXIT

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the purchase order write scope migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_OLD="$(q "select count(*) from pg_policy where polname in ('purchase_orders_write', 'purchase_order_items_write')")"
STATE_SQL="select md5(string_agg(x, '|' order by x)) from (
  select tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || '|' || coalesce(with_check, '') as x
    from pg_policies
   where (schemaname = 'public' and tablename in ('purchase_orders', 'purchase_order_items', 'checklist_runs',
                                                  'recurring_po_templates', 'po_attachments'))
      or (schemaname = 'storage' and tablename = 'objects' and policyname like 'po-attachments %')
  union all
  select p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' || coalesce(p.proacl::text, '')
    from pg_proc p
   where p.oid in ('public.next_po_number(uuid)'::regprocedure, 'ledger.reverse_receipt(uuid,text)'::regprocedure,
                   'public._notify_po_status()'::regprocedure, 'public._notify_receipt_posted()'::regprocedure,
                   'public.po_status_in_org(uuid,uuid)'::regprocedure)
      or p.proname in ('_po_readable_by', 'po_attachment_object_visible', 'tg_po_destination_write_guard')
  union all
  select 'trigger:' || tgrelid::regclass::text || '.' || tgname
    from pg_trigger where tgname = 'trg_po_destination_write_guard') s"
echo "local head $HEAD_NOW; FOR ALL purchase order policies present: $HAS_OLD; file $(basename "$MIG")"
if [ "$HAS_OLD" != "2" ]; then
  echo "needs the head before the purchase order write scope migration (supabase db reset --local --version <the migration before it>)"
  exit 1
fi
STATE_BEFORE="$(q "$STATE_SQL")"

cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0423-lock-mgr@example.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0423 Lock Org', '0423-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0423 Lock Main', 'WH-0423-LK', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type) values ('$LOC', '$ORG', '$WH', '0423 Lock Bin', 'bin');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', 'Lock item', 'SKU-0423-LK', 0, 'active');
insert into public.purchase_orders (id, organization_id, po_number, status, destination_location_id)
  values ('$PO', '$ORG', 'PO-0423-LK', 'draft', '$LOC');
insert into public.purchase_order_items (id, organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
  values ('$LINE', '$ORG', '$PO', '$ITEM', 1, 1);
SQL

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock46$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock46\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^\$lock46\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
{ [ -n "$P0" ] && [ -n "$P1" ]; } || { echo "no lock prelude in $MIG"; exit 1; }
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
  echo "select 'EXPECTED|' || string_agg(distinct x, ',' order by x) from (
          select 'public.locations:AccessShareLock' as x
          union all select 'public.purchase_order_items:AccessExclusiveLock'
          union all select 'public.purchase_orders:AccessExclusiveLock'
          union all select 'public.recurring_po_templates:AccessExclusiveLock'
          union all select 'public.po_attachments:AccessExclusiveLock'
          union all select 'storage.objects:AccessExclusiveLock'
          union all select 'public.checklist_runs:AccessExclusiveLock' where to_regclass('public.checklist_runs') is not null
          union all select n.nspname || '.' || c.relname || ':AccessExclusiveLock'
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
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the preflight, next_po_number, the review round's functions, their grants and their comments lock no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "$EXPECTED" ]; then
    CR=""
    case ",$EXPECTED," in *",public.checklist_runs:AccessExclusiveLock,"*) CR=" and checklist_runs" ;; esac
    ok "1b: the prelude takes exactly locations (access share), the purchase order, template and attachment tables$CR and storage.objects (access exclusive) and the $(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vc '^public\.') storage and supautils.policy_grants tables"
  else
    bad "1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  # Every lock held at the end must be one the prelude took, or any lock on a
  # table the prelude already holds ACCESS EXCLUSIVE (which covers every mode).
  AE_HELD="$(printf '%s' "$PRELUDE" | tr ',' '\n' | sed -n 's/:AccessExclusiveLock$//p' | sort -u)"
  NEW="$(comm -13 <(printf '%s' "$PRELUDE" | tr ',' '\n' | sort -u) <(printf '%s' "$END" | tr ',' '\n' | sort -u) \
         | while IFS= read -r pair; do
             rel="${pair%%:*}"
             printf '%s\n' "$AE_HELD" | grep -qxF "$rel" || printf '%s\n' "$pair"
           done)"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude takes a lock the prelude does not cover"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 250 ]; then
    ok "2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "2: the prelude to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3. An open transaction on a table the prelude needs ─────────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0423-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0423-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0423-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
  wait "$hp"
}
run_behind po-reader "select count(*) from public.purchase_orders where organization_id = '$ORG';" 9 fail
run_behind line-writer "update public.purchase_order_items set quantity_ordered = quantity_ordered where id = '$LINE';" 9 fail
run_behind auth-reader "select count(*) from auth.users;" 9 fail
run_behind attachment-reader "select count(*) from public.po_attachments;" 9 fail
run_behind template-writer "update public.recurring_po_templates set name = name where organization_id = '$ORG';" 9 fail
run_behind 3b-short-po-reader "select count(*) from public.purchase_orders where organization_id = '$ORG';" 0.6 apply

# ── 4. The app's shapes, each already holding its first lock ──────────────
shape() { # shape <label> <first lock sql> <second step sql>
  local label="$1" app="0423-lock-shape-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(1.5);\n%s\ncommit;\nselect 'SHAPE_DONE';\n" "$app" "$2" "$3" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.s.out" 2>&1 &
  local sp=$!
  if ! wait_sleeping "$app"; then bad "$label: the person's transaction never reached pg_sleep"; wait "$sp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.m.out" 2> "$TMP/$label.m.err"
  rc=$?
  t1="$(now_ms)"
  wait "$sp"
  if grep -qE '40P01|40001|deadlock' "$TMP/$label.m.err"; then
    bad "$label: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/$label.m.err" | cut -c1-300)"
  elif [ $rc -eq 0 ]; then
    ok "$label: the file retried until the person's transaction committed, then ran to the end after $((t1 - t0)) ms (rolled back), no 40P01"
  elif grep -q '55P03' "$TMP/$label.m.err"; then
    ok "$label: the file failed 55P03 after $((t1 - t0)) ms, no 40P01"
  else
    bad "$label: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/$label.m.err" | cut -c1-300)"
  fi
  if grep -q '^SHAPE_DONE$' "$TMP/$label.s.out" && ! grep -qE '40P01|40001|deadlock' "$TMP/$label.s.out"; then
    ok "$label: the person's transaction completed, no 40P01"
  else
    bad "$label: the person's transaction: $(tr '\n' ' ' < "$TMP/$label.s.out" | cut -c1-300)"
  fi
}
shape "4a-lines-then-po" \
  "select count(*) from public.purchase_order_items where purchase_order_id = '$PO';" \
  "select count(*) from public.purchase_orders where id = '$PO';"
shape "4b-line-write-then-po-for-share" \
  "update public.purchase_order_items set quantity_ordered = quantity_ordered where id = '$LINE';" \
  "select count(*) from (select 1 from public.purchase_orders where id = '$PO' for share) s;"
shape "4c-po-write-then-lines" \
  "update public.purchase_orders set notes = notes where id = '$PO';" \
  "select count(*) from public.purchase_order_items where purchase_order_id = '$PO';"

# ── 5. While the file holds its locks, readers wait for the hold only ─────
{
  echo "set application_name = '0423-lock-migration-5';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/5m.out" 2> "$TMP/5m.err" &
BG+=("$!")
if ! wait_sleeping 0423-lock-migration-5; then
  bad "5: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/5m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.purchase_orders where organization_id = '%s';\n" "$ORG" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "5: a new purchase order reader waited for the hold only and read after $((t1 - t0)) ms"
  else
    bad "5: a new purchase order reader: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from auth.users;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "5: a new reader of auth.users waited for the hold only and read after $((t1 - t0)) ms"
  else
    bad "5: a new reader of auth.users: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/5m.err"; then bad "5: the migration session reported: $(tr '\n' ' ' < "$TMP/5m.err")"; fi

# ── 6. CONTROL: without the prelude the first shape deadlocks ─────────────
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock46\$' "$TMP/no-prelude.sql" || [ "$(grep -c "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql")" != "1" ]; then
  bad "6: could not build the no-prelude control file"
else
  printf "set application_name = '0423-lock-control';\nbegin;\nselect count(*) from public.purchase_order_items where purchase_order_id = '%s';\nselect pg_sleep(1.5);\nselect count(*) from public.purchase_orders where id = '%s';\ncommit;\nselect 'SHAPE_DONE';\n" "$PO" "$PO" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/6.s.out" 2>&1 &
  sp=$!
  if wait_sleeping 0423-lock-control; then
    { echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/6.m.out" 2> "$TMP/6.m.err"
    wait "$sp"
    S40="$(grep -c '40P01' "$TMP/6.s.out" || true)"
    M40="$(grep -c '40P01' "$TMP/6.m.err" || true)"
    if [ $((S40 + M40)) -ge 1 ]; then
      ok "6: without the prelude one side got 40P01 (the reader: $S40, the file: $M40): the hazard is real, and the prelude removes it (4a)"
    else
      bad "6: the control did not reproduce the deadlock (reader: $(tr '\n' ' ' < "$TMP/6.s.out" | cut -c1-200); file: $(tr '\n' ' ' < "$TMP/6.m.err" | cut -c1-200))"
    fi
  else
    bad "6: the control reader never reached pg_sleep"
    wait "$sp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_AFTER="$(q "$STATE_SQL")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$STATE_AFTER" = "$STATE_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW; the policies, functions and triggers the file touches as before, state $STATE_BEFORE)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, state $STATE_AFTER, was $STATE_BEFORE)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
