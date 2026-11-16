#!/usr/bin/env bash
#
# Lock footprint of migration 0466 (retry keys written by their functions).
# The push runs the whole file as one batch, so every table lock a statement
# takes is held until the file commits. The preflight reads catalogs only;
# CREATE OR REPLACE FUNCTION (plpgsql), the guard function's REVOKE and the
# COMMENTs take no table lock; CREATE OR REPLACE TRIGGER takes SHARE ROW
# EXCLUSIVE on idempotency_keys. The file takes that one lock in a NOWAIT
# prelude (`do $lock_s96b$ ... end $lock_s96b$;`, the 0390, 0415, 0421 and
# 0464 pattern) and never waits holding one. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight, the four functions, the guard function and
#       their post-conditions).
#   1b. The prelude takes SHARE ROW EXCLUSIVE on idempotency_keys and nothing
#       else.
#   1c. No statement after the prelude locks a table the prelude did not lock
#       (the trigger and the post-conditions).
#   2.  The hold, from the prelude to the end of the file, is under 100 ms.
#   3.  A holder with an open transaction that has written a key row (an
#       insert, an update), held longer than the retries last: the file
#       retries, holds NO table lock whenever it is paused between attempts
#       (sampled from pg_locks), fails 55P03 after its bounded retries (40
#       attempts) and writes nothing; while it retries, a new reader of
#       idempotency_keys reads and a new key-row writer writes at once (the
#       file is never queued for the lock).
#   3b. The same insert held only 0.6 s: the file retries past it and runs to
#       the end.
#   3c. An open reader of idempotency_keys, and an open transaction that has
#       written a receipt-side table (bundle_distributions), do not hold the
#       file: it runs to the end at once.
#   4.  The keyed call shape (the key row written, then, after a pause, the
#       key row completed), with the key row written when the file starts:
#       the file retries past it and runs to the end; the call then completes
#       its key row with no error; never 40P01.
#   5.  While the file holds its lock (an artificial 1 s), a new reader of
#       idempotency_keys does not wait at all, and a new key-row writer waits
#       only for the hold, then writes.
#   6.  CONTROL, what the prelude avoids: the same file with the prelude cut
#       out and lock_timeout 5s, behind a key-row writer that holds for 3 s.
#       The file queues for SHARE ROW EXCLUSIVE, and a new key-row writer
#       (lock_timeout 1s) queued behind it is refused 55P03. Required: that
#       refusal (case 3 shows the prelude lets the same writer through).
#
# The migration sessions ALWAYS roll back, so the script changes nothing but
# its own fixture rows (removed at the start, the end and by the EXIT trap).
# It needs the pre-0466 head. LOCAL stack only (docker container
# supabase_db_stockpilot by default; CONTAINER=<name> for another local
# stack). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0466_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rebase.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_retry_keys_written_by_their_functions.sql' | sort | tail -n 1)}"
TMP="$(mktemp -d)"
BG=()

ORG='04663333-0000-0000-0000-00000000000a'
WH='04663333-0000-0000-0000-0000000000c1'
ITEM='04663333-0000-0000-0000-0000000000c2'
BN='04663333-0000-0000-0000-0000000000d1'

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
key_row() { # key_row <key>: a key row insert, as the table owner
  printf "insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type) values ('%s', 'targeted_recount', '%s', 'h', 'in_progress', 'cycle_count');" "$ORG" "$1"
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
HAS_GUARD="$(q "select count(*) from pg_trigger where tgrelid = 'public.idempotency_keys'::regclass and tgname = 'trg_zz_idempotency_keys_guard'")"
STATE_SQL="select md5(string_agg(x, '|' order by x)) from (
  select p.oid::regprocedure::text || ':' || md5(p.prosrc) as x from pg_proc p
   where p.oid in ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure,
                   'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
                   'public.start_targeted_recount(uuid,uuid[],uuid[],text,text)'::regprocedure,
                   'public.draft_order_shortfall_pos(uuid,jsonb,text)'::regprocedure)
  union all
  select 'fn:' || coalesce(to_regprocedure('public.tg_idempotency_keys_guard()')::text, '-')
  union all
  select 'acl:' || coalesce(relacl::text, '') from pg_class where oid = 'public.idempotency_keys'::regclass
  union all
  select 'tg:' || tgname from pg_trigger where tgrelid = 'public.idempotency_keys'::regclass and not tgisinternal) s"
echo "local head $HEAD_NOW; idempotency_keys guard present: $HAS_GUARD; file $(basename "$MIG")"
if [ "$HAS_GUARD" != "0" ]; then
  echo "needs the pre-0466 head (supabase db reset --local --version <the migration before it>)"
  exit 1
fi
STATE_BEFORE="$(q "$STATE_SQL")"

cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into public.organizations (id, name, slug) values ('$ORG', '0466 Lock Org', '0466-lock');
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0466 Lock Main', 'WH-0466-LK', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', 'Lock kit part', 'SKU-0466-LK', 10, 'active');
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  ('$BN', '$ORG', '0466 Lock kit', 'KIT-0466-LK', true, false);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values ('$BN', '$ITEM', 1, false);
insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type) values
  ('$ORG', 'targeted_recount', '0466-lock-upd', 'h', 'in_progress', 'cycle_count');
SQL

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock_s96b$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock_s96b\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock_s96b\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
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
    ok "1a: the preflight, the four functions, the guard function and their post-conditions lock no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ "$PRELUDE" = "public.idempotency_keys:ShareRowExclusiveLock" ]; then
    ok "1b: the prelude takes exactly idempotency_keys (share row exclusive)"
  else
    bad "1b: the prelude took: $PRELUDE"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "1c: nothing after the prelude locks a table it did not lock (the trigger, the post-conditions); at the end: $END"
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

# ── 3. An open transaction on idempotency_keys ───────────────────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0466-lock-file-%'"
N=0
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply|free>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0466-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0466-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3-$label.m.out" 2> "$TMP/3-$label.m.err" &
  local mp=$!
  local samples=0 sleeping=0 held=0 r reader_ok=0 reader_bad=0 writer_ok=0 writer_bad=0 rd
  while kill -0 "$mp" 2> /dev/null; do
    r="$(q "$LOCKS_OF_SLEEPING_FILE")"
    samples=$((samples + 1))
    sleeping=$((sleeping + ${r%%|*}))
    held=$((held + ${r##*|}))
    if [ "$expect" = "fail" ] && [ $((samples % 10)) = 3 ]; then
      rd="$(printf "set lock_timeout = '300ms';\nselect 'read:' || (count(*) >= 0)::text from public.idempotency_keys;\n" | "${PSQL[@]}" 2>&1)"
      if [ "$rd" = "read:true" ]; then reader_ok=$((reader_ok + 1)); else reader_bad=$((reader_bad + 1)); fi
      N=$((N + 1))
      rd="$(printf "set lock_timeout = '300ms';\nbegin;\n%s\nrollback;\nselect 'wrote';\n" "$(key_row "0466-lock-new-$label-$N")" | "${PSQL[@]}" 2>&1)"
      if [ "$rd" = "wrote" ]; then writer_ok=$((writer_ok + 1)); else writer_bad=$((writer_bad + 1)); fi
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
      if [ "$reader_ok" -ge 1 ] && [ "$reader_bad" -eq 0 ] && [ "$writer_ok" -ge 1 ] && [ "$writer_bad" -eq 0 ]; then
        ok "3 $label: while the file retried, $reader_ok new reader(s) of idempotency_keys read and $writer_ok new key-row writer(s) wrote at once (lock_timeout 300ms)"
      else
        bad "3 $label: while the file retried: readers $reader_ok read, $reader_bad refused; writers $writer_ok wrote, $writer_bad refused"
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
run_behind key-row-insert "$(key_row 0466-lock-hold)" 9 fail
run_behind key-row-update "update public.idempotency_keys set status = 'completed' where organization_id = '$ORG' and key = '0466-lock-upd';" 9 fail
run_behind 3b-short-insert "$(key_row 0466-lock-short)" 0.6 apply
run_behind 3c-key-reader "select count(*) from public.idempotency_keys;" 4 free
run_behind 3c-distribution-writer "insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values ('$ORG', '$BN', '$WH', 1, '0466 lock holder');" 4 free

# ── 4. The keyed call shape, its key row already written ─────────────────
SEND_FIRST="$(key_row 0466-lock-shape)"
SEND_REST="update public.idempotency_keys set status = 'completed' where organization_id = '$ORG' and key = '0466-lock-shape';"
printf "set application_name = '0466-lock-shape';\nbegin;\n%s\nselect pg_sleep(1.5);\n%s\nrollback;\nselect 'SHAPE_DONE';\n" "$SEND_FIRST" "$SEND_REST" \
  | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.s.out" 2>&1 &
sp=$!
if ! wait_sleeping 0466-lock-shape; then
  bad "4: the call never reached pg_sleep"
  wait "$sp"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "select pg_sleep(0.3);"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.m.out" 2> "$TMP/4.m.err"
  rc=$?
  t1="$(now_ms)"
  wait "$sp"
  if [ $rc -eq 0 ] && ! grep -qE '40P01|40001|deadlock|55P03' "$TMP/4.m.err"; then
    ok "4: the file retried past the call that held its key row and ran to the end after $((t1 - t0)) ms (rolled back), no 40P01"
  else
    bad "4: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/4.m.err" | cut -c1-300)"
  fi
  if grep -q '^SHAPE_DONE$' "$TMP/4.s.out" && ! grep -qE '40P01|40001|deadlock|ERROR' "$TMP/4.s.out"; then
    ok "4: the call then completed its key row with no error, no 40P01"
  else
    bad "4: the call: $(tr '\n' ' ' < "$TMP/4.s.out" | cut -c1-300)"
  fi
fi

# ── 5. While the file holds its lock, readers and writers ─────────────────
{
  echo "set application_name = '0466-lock-migration-5';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/5m.out" 2> "$TMP/5m.err" &
BG+=("$!")
if ! wait_sleeping 0466-lock-migration-5; then
  bad "5: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/5m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.idempotency_keys;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 500 ]; then
    ok "5: a new reader of public.idempotency_keys did not wait for the hold ($((t1 - t0)) ms)"
  else
    bad "5: a new reader of public.idempotency_keys: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nbegin;\n%s\nrollback;\nselect 'wrote';\n" "$(key_row 0466-lock-5)" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "wrote" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "5: a new key-row writer waited for the hold only and wrote after $((t1 - t0)) ms"
  else
    bad "5: a new key-row writer: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/5m.err"; then bad "5: the migration session reported: $(tr '\n' ' ' < "$TMP/5m.err")"; fi

# ── 6. CONTROL: without the prelude the file queues, and writers queue behind it ─
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$lock_s96b\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "6: could not build the no-prelude control file"
else
  printf "set application_name = '0466-lock-control';\nbegin;\n%s\nselect pg_sleep(3);\nrollback;\n" "$(key_row 0466-lock-control)" \
    | "${PSQL[@]}" > "$TMP/6.h.out" 2>&1 &
  hp=$!
  if wait_sleeping 0466-lock-control; then
    { echo "set application_name = '0466-lock-control-file';"; echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } \
      | "${PSQL[@]}" > "$TMP/6.m.out" 2> "$TMP/6.m.err" &
    mp=$!
    for _ in $(seq 1 50); do
      [ "$(q "select count(*) from pg_stat_activity where application_name = '0466-lock-control-file' and wait_event_type = 'Lock'")" = "1" ] && break
      sleep 0.05
    done
    R="$(printf "set lock_timeout = '1s';\nbegin;\n%s\nrollback;\nselect 'wrote';\n" "$(key_row 0466-lock-control-2)" | "${PSQL[@]}" 2>&1)"
    wait "$mp"
    wait "$hp"
    if printf '%s' "$R" | grep -q 'lock timeout'; then
      ok "6: without the prelude the file queued for the lock and a new key-row writer behind it was refused 55P03 (the prelude never queues: case 3)"
    else
      bad "6: the control did not show the queue (writer: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-200))"
    fi
  else
    bad "6: the control holder never reached pg_sleep"
    wait "$hp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
STATE_AFTER="$(q "$STATE_SQL")"
LEFT="$(q "select (select count(*) from public.bundle_distributions where organization_id = '$ORG') + (select count(*) from public.idempotency_keys where organization_id = '$ORG' and key <> '0466-lock-upd')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$STATE_AFTER" = "$STATE_BEFORE" ] && [ "$LEFT" = "0" ]; then
  ok "the stack is unchanged (head $HEAD_NOW; the four bodies, the table's grants and triggers as before, no guard function; no row written)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, state changed: $([ "$STATE_AFTER" = "$STATE_BEFORE" ] && echo no || echo yes), rows left: $LEFT)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
