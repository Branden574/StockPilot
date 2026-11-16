#!/usr/bin/env bash
#
# Lock footprint of migration 0464 (retry keys match their record). The push
# runs the whole file as one batch, so every table lock a statement takes is
# held until the file commits. The preflight reads catalogs only; CREATE OR
# REPLACE FUNCTION (plpgsql) and the REVOKEs on idempotency_keys take no table
# lock; ALTER TABLE ... ADD COLUMN takes ACCESS EXCLUSIVE on
# bundle_distributions. The file takes that one lock in a NOWAIT prelude
# (`do $lock_s96$ ... end $lock_s96$;`, the 0390, 0415 and 0421 pattern) and
# never waits holding one. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight, both functions and their post-conditions).
#   1b. The prelude takes ACCESS EXCLUSIVE on bundle_distributions and
#       nothing else.
#   1c. No statement after the prelude locks a table the prelude did not lock
#       (the column, its comment, the REVOKEs on idempotency_keys and the
#       post-conditions). The column's COMMENT takes SHARE UPDATE EXCLUSIVE
#       on bundle_distributions, which the prelude already holds in ACCESS
#       EXCLUSIVE mode.
#   2.  The hold, from the prelude to the end of the file, is under 100 ms.
#   3.  A holder with an open transaction on bundle_distributions (a
#       distribution's insert, a reader), held longer than the retries last:
#       the file retries, holds NO table lock whenever it is paused between
#       attempts (sampled from pg_locks), fails 55P03 after its bounded
#       retries (40 attempts) and writes nothing; while it retries a new
#       reader of bundle_distributions reads at once (the file is never
#       queued for the lock).
#   3b. The same insert held only 0.6 s: the file retries past it and runs to
#       the end.
#   3c. An open transaction that has written a key row (idempotency_keys) does
#       not hold the file: it runs to the end at once.
#   4.  The keyed hand-out shape (the key row written, then, after a pause,
#       the distribution inserted), with the key row written when the file
#       starts: the file runs to the end, the hand-out then inserts its
#       distribution with no error; never 40P01.
#   5.  While the file holds its lock (an artificial 1 s), a new reader of
#       bundle_distributions waits only for the hold, then reads; a new reader
#       of idempotency_keys does not wait at all.
#   6.  CONTROL, what the prelude avoids: the same file with the prelude cut
#       out and lock_timeout 5s, behind a reader of bundle_distributions that
#       holds for 3 s. The file queues for ACCESS EXCLUSIVE, and a new reader
#       (lock_timeout 1s) queued behind it is refused 55P03. Required: that
#       refusal (case 3 shows the prelude lets the same reader through).
#
# The migration sessions ALWAYS roll back, so the script changes nothing but
# its own fixture rows (removed at the start, the end and by the EXIT trap).
# It needs the pre-0464 head. LOCAL stack only (docker container
# supabase_db_stockpilot by default; CONTAINER=<name> for another local
# stack). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0464_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rebase.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_retry_keys_match_their_record.sql' | sort | tail -n 1)}"
TMP="$(mktemp -d)"
BG=()

ORG='04643333-0000-0000-0000-00000000000a'
MGR='04643333-0000-0000-0000-0000000000a1'
WH='04643333-0000-0000-0000-0000000000c1'
ITEM='04643333-0000-0000-0000-0000000000c2'
BN='04643333-0000-0000-0000-0000000000d1'

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
delete from public.idempotency_keys where organization_id = '$ORG';
delete from public.bundle_distributions where organization_id = '$ORG';
delete from public.bundle_components where bundle_id = '$BN';
delete from public.bundles where organization_id = '$ORG';
delete from public.item_stock_levels where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
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

{ [ -n "$MIG" ] && [ -f "$MIG" ]; } || { echo "missing the retry keys migration ($MIG)"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_COL="$(q "select count(*) from pg_attribute where attrelid = 'public.bundle_distributions'::regclass and attname = 'idempotency_key' and not attisdropped")"
STATE_SQL="select md5(string_agg(x, '|' order by x)) from (
  select p.oid::regprocedure::text || ':' || md5(p.prosrc) as x from pg_proc p
   where p.oid in ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure,
                   'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure)
  union all
  select 'acl:' || coalesce(relacl::text, '') from pg_class where oid in ('public.idempotency_keys'::regclass, 'public.bundle_distributions'::regclass)
  union all
  select 'col:' || attname from pg_attribute where attrelid = 'public.bundle_distributions'::regclass and attnum > 0 and not attisdropped) s"
echo "local head $HEAD_NOW; bundle_distributions.idempotency_key present: $HAS_COL; file $(basename "$MIG")"
if [ "$HAS_COL" != "0" ]; then
  echo "needs the pre-0464 head (supabase db reset --local --version <the migration before it>)"
  exit 1
fi
STATE_BEFORE="$(q "$STATE_SQL")"

cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$MGR', '0464-lock-mgr@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0464 Lock Org', '0464-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$MGR', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0464 Lock Main', 'WH-0464-LK', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', 'Lock kit part', 'SKU-0464-LK', 10, 'active');
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  ('$BN', '$ORG', '0464 Lock kit', 'KIT-0464-LK', true, false);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values ('$BN', '$ITEM', 1, false);
SQL

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock_s96$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock_s96\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock_s96\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || { echo "no lock prelude in $MIG"; exit 1; }
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
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the preflight, the two functions and their post-conditions lock no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "public.bundle_distributions:AccessExclusiveLock" ]; then
    ok "1b: the prelude takes exactly bundle_distributions (access exclusive)"
  else
    bad "1b: the prelude took: $PRELUDE"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks a table it did not lock (the column, its comment, the REVOKEs, the post-conditions); at the end: $END"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 100 ]; then
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
 where a.application_name like '0464-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply|free>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0464-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0464-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3-$label.m.out" 2> "$TMP/3-$label.m.err" &
  local mp=$!
  local samples=0 sleeping=0 held=0 r reader_ok=0 reader_bad=0 rd
  while kill -0 "$mp" 2> /dev/null; do
    r="$(q "$LOCKS_OF_SLEEPING_FILE")"
    samples=$((samples + 1))
    sleeping=$((sleeping + ${r%%|*}))
    held=$((held + ${r##*|}))
    if [ "$expect" = "fail" ] && [ $((samples % 10)) = 3 ]; then
      rd="$(printf "set lock_timeout = '300ms';\nselect 'read:' || (count(*) >= 0)::text from public.bundle_distributions;\n" | "${PSQL[@]}" 2>&1)"
      if [ "$rd" = "read:true" ]; then reader_ok=$((reader_ok + 1)); else reader_bad=$((reader_bad + 1)); fi
    fi
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
  case "$expect" in
    fail)
      if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err" \
         && [ $((t1 - t0)) -ge 1500 ] && [ $((t1 - t0)) -lt 10000 ]; then
        ok "3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused ($sleeping paused samples, 0 locks), then failed 55P03 and wrote nothing"
      else
        bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi
      if [ "$reader_ok" -ge 1 ] && [ "$reader_bad" -eq 0 ]; then
        ok "3 $label: while the file retried, $reader_ok new reader(s) of bundle_distributions read at once (lock_timeout 300ms)"
      else
        bad "3 $label: new readers while the file retried: $reader_ok read, $reader_bad refused"
      fi
      ;;
    apply)
      if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
        ok "3 $label: the holder let go after ${secs} s and the file retried past it, ran to the end after $((t1 - t0)) ms ($sleeping paused samples, 0 locks while paused; rolled back)"
      else
        bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi
      ;;
    free)
      if [ $rc -eq 0 ] && [ "$sleeping" -eq 0 ] && [ $((t1 - t0)) -lt 1500 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
        ok "3 $label: the file did not wait for it and ran to the end after $((t1 - t0)) ms (rolled back)"
      else
        bad "3 $label: rc $rc after $((t1 - t0)) ms, $sleeping paused samples: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
      fi
      ;;
  esac
  wait "$hp"
}
run_behind distribution-insert "insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values ('$ORG', '$BN', '$WH', 1, '0464 lock holder');" 9 fail
run_behind distribution-reader "select count(*) from public.bundle_distributions;" 9 fail
run_behind 3b-short-insert "insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values ('$ORG', '$BN', '$WH', 1, '0464 lock holder');" 0.6 apply
run_behind 3c-key-row-writer "insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type) values ('$ORG', 'bundle_distribution', '0464-lock-k', 'h', 'in_progress', 'bundle_distribution');" 4 free

# ── 4. The keyed hand-out shape, its key row already written ─────────────
SEND_FIRST="insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type) values ('$ORG', 'bundle_distribution', '0464-lock-shape', 'h', 'in_progress', 'bundle_distribution');"
SEND_REST="insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values ('$ORG', '$BN', '$WH', 1, '0464 lock shape');
update public.idempotency_keys set status = 'completed' where organization_id = '$ORG' and key = '0464-lock-shape';"
printf "set application_name = '0464-lock-shape';\nbegin;\n%s\nselect pg_sleep(1.5);\n%s\nrollback;\nselect 'SHAPE_DONE';\n" "$SEND_FIRST" "$SEND_REST" \
  | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.s.out" 2>&1 &
sp=$!
if ! wait_sleeping 0464-lock-shape; then
  bad "4: the hand-out never reached pg_sleep"
  wait "$sp"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "select pg_sleep(0.3);"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.m.out" 2> "$TMP/4.m.err"
  rc=$?
  t1="$(now_ms)"
  wait "$sp"
  if [ $rc -eq 0 ] && ! grep -qE '40P01|40001|deadlock|55P03' "$TMP/4.m.err"; then
    ok "4: the file ran to the end after $((t1 - t0)) ms while the hand-out held its key row (rolled back), no 40P01"
  else
    bad "4: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/4.m.err" | cut -c1-300)"
  fi
  if grep -q '^SHAPE_DONE$' "$TMP/4.s.out" && ! grep -qE '40P01|40001|deadlock|ERROR' "$TMP/4.s.out"; then
    ok "4: the hand-out then inserted its distribution and completed its key row with no error, no 40P01"
  else
    bad "4: the hand-out: $(tr '\n' ' ' < "$TMP/4.s.out" | cut -c1-300)"
  fi
fi

# ── 5. While the file holds its lock, readers ─────────────────────────────
{
  echo "set application_name = '0464-lock-migration-5';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/5m.out" 2> "$TMP/5m.err" &
BG+=("$!")
if ! wait_sleeping 0464-lock-migration-5; then
  bad "5: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/5m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.bundle_distributions;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "5: a new reader of public.bundle_distributions waited for the hold only and read after $((t1 - t0)) ms"
  else
    bad "5: a new reader of public.bundle_distributions: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.idempotency_keys;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 500 ]; then
    ok "5: a new reader of public.idempotency_keys did not wait for the hold ($((t1 - t0)) ms)"
  else
    bad "5: a new reader of public.idempotency_keys: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/5m.err"; then bad "5: the migration session reported: $(tr '\n' ' ' < "$TMP/5m.err")"; fi

# ── 6. CONTROL: without the prelude the file queues, and readers queue behind it ─
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock_s96\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "6: could not build the no-prelude control file"
else
  printf "set application_name = '0464-lock-control';\nbegin;\nselect count(*) from public.bundle_distributions;\nselect pg_sleep(3);\nrollback;\n" \
    | "${PSQL[@]}" > "$TMP/6.h.out" 2>&1 &
  hp=$!
  if wait_sleeping 0464-lock-control; then
    { echo "set application_name = '0464-lock-control-file';"; echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } \
      | "${PSQL[@]}" > "$TMP/6.m.out" 2> "$TMP/6.m.err" &
    mp=$!
    for _ in $(seq 1 50); do
      [ "$(q "select count(*) from pg_stat_activity where application_name = '0464-lock-control-file' and wait_event_type = 'Lock'")" = "1" ] && break
      sleep 0.05
    done
    R="$(printf "set lock_timeout = '1s';\nselect 'read:' || (count(*) >= 0)::text from public.bundle_distributions;\n" | "${PSQL[@]}" 2>&1)"
    wait "$mp"
    wait "$hp"
    if printf '%s' "$R" | grep -q 'lock timeout'; then
      ok "6: without the prelude the file queued for the lock and a new reader behind it was refused 55P03 (the prelude never queues: case 3)"
    else
      bad "6: the control did not show the queue (reader: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-200))"
    fi
  else
    bad "6: the control holder never reached pg_sleep"
    wait "$hp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_AFTER="$(q "$STATE_SQL")"
LEFT="$(q "select (select count(*) from public.bundle_distributions where organization_id = '$ORG') + (select count(*) from public.idempotency_keys where organization_id = '$ORG')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$STATE_AFTER" = "$STATE_BEFORE" ] && [ "$LEFT" = "0" ]; then
  ok "the stack is unchanged (head $HEAD_NOW; both bodies, both tables' grants and bundle_distributions' columns as before; no row written)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, state changed: $([ "$STATE_AFTER" = "$STATE_BEFORE" ] && echo no || echo yes), rows left: $LEFT)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
