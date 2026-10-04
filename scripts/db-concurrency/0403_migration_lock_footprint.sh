#!/usr/bin/env bash
#
# Lock footprint of migration 0393 (order signature images). The push runs the
# whole file as one batch, so every lock is held until the file commits. The
# file's data block rewrites the order rows that hold an image, so before
# anything else touches a table it takes, in one NOWAIT prelude (`do
# $c393_lock$ ... end $c393_lock$;`), EXCLUSIVE on order_requests (critique
# K3) and order_request_secrets, and FOR KEY SHARE on the organizations its
# side-table inserts reference; it never waits holding a lock. Its CREATE OR
# REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on order_requests after the
# prelude, which the prelude's EXCLUSIVE already covers. This proves:
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs.
#   1b. The prelude takes exactly: EXCLUSIVE on order_requests and
#       order_request_secrets, and ROW SHARE (the row locks' table lock) on
#       organizations.
#   1c. Nothing after the prelude locks a table the prelude did not lock, and
#       at the end of the file no table is held ACCESS EXCLUSIVE: a plain read
#       of an order never waits for the push.
#   2.  The hold, from the prelude to the end of the file, is under 1 s here.
#   3.  A transaction holding a row of order_requests, an uncommitted side-table
#       row (order_return_token_ensure's shape) or an organization row FOR
#       UPDATE (an organization being deleted), held longer than the retries
#       last: the file retries, holds NO table lock whenever it is paused
#       between attempts (sampled from pg_locks), and fails 55P03 after 40
#       attempts, writing nothing. 3d: the same order write held 0.6 s: the
#       file retries past it and runs to the end.
#   4.  A plain reader of order_requests with an open transaction: the file
#       does not wait for it at all (EXCLUSIVE is compatible with ACCESS SHARE).
#   5.  The shape of an order write that locks a row the move rewrites (FOR
#       UPDATE, then the UPDATE) already holding it when the file starts: the
#       row writer completes with no error and the file either runs to the end
#       once it committed or fails 55P03; never 40P01 on either side.
#   6.  While the file holds its locks (an artificial 1 s), a new order reader
#       reads at once, while a new order write and a FOR UPDATE row lock wait
#       for the hold and then go through.
#   7.  CONTROL, the hazard K3 names: the same file with the prelude cut out
#       and lock_timeout 5s, against that shape. DISABLE TRIGGER's SHARE ROW
#       EXCLUSIVE is compatible with the writer's row lock, the file's side
#       insert (its foreign-key check) then waits for the row, and the
#       writer's UPDATE waits for the table: Postgres ends one side with
#       40P01. Required: at least one 40P01 here.
#
# Every migration session ROLLS BACK, so the script changes nothing but its
# own fixture rows (an organization in its own namespace with stored images;
# removed at the start, the end and by the EXIT trap). It runs at any head
# from 0392 on (each run is rolled back; the data block re-runs over the
# fixtures only, and over any other order with an image on its row, which a
# fresh reset with the QA seed has none of: checked below). LOCAL stack only
# (docker container supabase_db_stockpilot). Exit status 0 = every check
# passed.
#
# Usage: bash scripts/db-concurrency/0393_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$REPO/supabase/migrations/0393_order_signature_images.sql"
TMP="$(mktemp -d)"
BG=()

ORG='03934444-0000-0000-0000-00000000000a'
REQ='03934444-0000-0000-0000-0000000000a1'
WH='03934444-0000-0000-0000-0000000000c1'
LIVE='03934444-0000-0000-0000-0000000000d1'
IMG2='03934444-0000-0000-0000-0000000000d2'
SIDEX='03934444-0000-0000-0000-0000000000d4'

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
delete from public.order_requests where organization_id = '$ORG';
delete from public.notifications where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id = '$REQ';
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

[ -f "$MIG" ] || { echo "missing $MIG"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_SIDE="$(q "select count(*) from pg_class where oid = to_regclass('public.order_request_secrets')")"
echo "local head $HEAD_NOW; order_request_secrets present: $HAS_SIDE"
[ "$HAS_SIDE" = "1" ] || { echo "needs 0389 or later (the side table)"; exit 1; }

cleanup_rows
# Any OTHER order the data block would rewrite (an image on its row): none on
# a fresh reset with the QA seed. Refuse to run otherwise.
OTHERS="$(q "select count(*) from public.order_requests o where o.signature_data_url is not null")"
if [ "$OTHERS" != "0" ]; then
  echo "the stack holds $OTHERS order(s) with an image on the row: reset the stack (QA reseed) first"
  exit 1
fi

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$REQ', '0393-lock-req@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0393 Lock Org', '0393-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG', '$REQ', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0393 Lock Main', 'WH-0393-LK', 'active');
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type,
   signed_at, signature_method, signature_data_url) values
  ('$LIVE', '$ORG', '$WH', 'completed', 'internal', '$REQ', 'pickup', now(), 'digital', 'data:image/png;base64,' || repeat('Q', 300)),
  ('$IMG2', '$ORG', '$WH', 'completed', 'internal', '$REQ', 'pickup', now(), 'digital', 'data:image/png;base64,' || repeat('R', 300)),
  ('$SIDEX','$ORG', '$WH', 'approved',  'internal', '$REQ', 'pickup', null, null, null);
SQL
FIXTURE_SQL="select md5(coalesce(string_agg(to_jsonb(o)::text, '' order by o.id), ''))
              || md5(coalesce((select string_agg(to_jsonb(s)::text, '' order by s.order_request_id) from public.order_request_secrets s
                                where s.organization_id = '$ORG'), ''))
              from public.order_requests o where o.organization_id = '$ORG'"
FIXTURE_BEFORE="$(q "$FIXTURE_SQL")"

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $c393_lock$ dollar tag, not an expansion
P0="$(grep -n '^do \$c393_lock\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$c393_lock\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || { echo "no lock prelude in $MIG"; exit 1; }
head -n $((P0 - 1)) "$MIG" > "$TMP/part1.sql"
sed -n "${P0},${P1}p" "$MIG" > "$TMP/prelude.sql"
tail -n +$((P1 + 1)) "$MIG" > "$TMP/part3.sql"
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"

# ── 1 and 2. What the prelude takes, and what follows it ──────────────────
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
  EXPECTED='public.order_request_secrets:ExclusiveLock,public.order_requests:ExclusiveLock,public.organizations:RowShareLock'
  if [ "$BEFORE" = "none" ]; then
    ok "1a: before the prelude the file locks no table"
  else
    bad "1a: before the prelude the file already holds: $BEFORE"
  fi
  # The prelude's own reads of order_requests add ACCESS SHARE; compare the
  # modes that matter (everything but AccessShareLock).
  PRELUDE_STRONG="$(printf '%s' "$PRELUDE" | tr ',' '\n' | grep -v ':AccessShareLock$' | sort | paste -sd, -)"
  if [ "$PRELUDE_STRONG" = "$EXPECTED" ]; then
    ok "1b: the prelude takes exactly EXCLUSIVE on order_requests and order_request_secrets and ROW SHARE on organizations"
  else
    bad "1b: the prelude took: $PRELUDE_STRONG; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ] && ! printf '%s' "$END" | grep -q 'AccessExclusiveLock'; then
    ok "1c: nothing after the prelude locks a new table, and nothing is held ACCESS EXCLUSIVE ($END)"
  else
    bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' '); at the end: $END"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 1000 ]; then
    ok "2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "2: the prelude to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3. An open transaction on something the prelude needs ───────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0393-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0393-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0393-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
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
      ok "3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused ($sleeping paused samples), then failed 55P03 and wrote nothing"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  else
    if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
      ok "3 $label: the holder let go after ${secs} s and the file retried past it, ran to the end after $((t1 - t0)) ms (rolled back)"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  fi
  wait "$hp"
}
run_behind 3a-order-write "update public.order_requests set internal_notes = internal_notes where id = '$SIDEX';" 9 fail
run_behind 3b-side-insert "insert into public.order_request_secrets (order_request_id, organization_id, return_token) values ('$SIDEX', '$ORG', gen_random_uuid());" 9 fail
run_behind 3c-org-for-update "select 1 from public.organizations where id = '$ORG' for update;" 9 fail
run_behind 3d-short-order-write "update public.order_requests set internal_notes = internal_notes where id = '$SIDEX';" 0.6 apply

# ── 4. A plain reader does not hold the file up ──────────────────────────
printf "set application_name = '0393-lock-reader';\nbegin;\nselect count(*) from public.order_requests;\nselect pg_sleep(6);\ncommit;\n" \
  | "${PSQL[@]}" > "$TMP/4r.out" 2>&1 &
BG+=("$!")
if ! wait_sleeping 0393-lock-reader; then
  bad "4: the reader never reached pg_sleep"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" > "$TMP/4m.out" 2> "$TMP/4m.err"
  rc=$?
  t1="$(now_ms)"
  if [ $rc -eq 0 ] && [ $((t1 - t0)) -lt 1500 ]; then
    ok "4: with a reader's transaction open on order_requests the file ran to the end in $((t1 - t0)) ms (EXCLUSIVE does not wait for reads)"
  else
    bad "4: with a reader open the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/4m.err" | cut -c1-300)"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()

# ── 5. The row writer shape already holding its row ───────────────────────
printf "set application_name = '0393-lock-writer';\nbegin;\nselect 1 from public.order_requests where id = '%s' for update;\nselect pg_sleep(1.5);\nupdate public.order_requests set internal_notes = 'handed over' where id = '%s';\nrollback;\nselect 'SHAPE_DONE';\n" "$LIVE" "$LIVE" \
  | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/5.s.out" 2>&1 &
sp=$!
if ! wait_sleeping 0393-lock-writer; then
  bad "5: the row writer never reached pg_sleep"
  wait "$sp"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/5.m.out" 2> "$TMP/5.m.err"
  rc=$?
  t1="$(now_ms)"
  wait "$sp"
  if grep -qE '40P01|40001|deadlock' "$TMP/5.m.err"; then
    bad "5: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/5.m.err" | cut -c1-300)"
  elif [ $rc -eq 0 ]; then
    ok "5: the file retried until the row writer finished, then ran to the end after $((t1 - t0)) ms (rolled back), no 40P01"
  elif grep -q '55P03' "$TMP/5.m.err"; then
    ok "5: the file failed 55P03 after $((t1 - t0)) ms, no 40P01"
  else
    bad "5: the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/5.m.err" | cut -c1-300)"
  fi
  if grep -q '^SHAPE_DONE$' "$TMP/5.s.out" && ! grep -qE '40P01|40001|deadlock|ERROR' "$TMP/5.s.out"; then
    ok "5: the row writer's row lock and write went through, no 40P01"
  else
    bad "5: the row writer: $(tr '\n' ' ' < "$TMP/5.s.out" | cut -c1-300)"
  fi
fi

# ── 6. While the file holds its locks ────────────────────────────────────
{
  echo "set application_name = '0393-lock-migration-6';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/6m.out" 2> "$TMP/6m.err" &
BG+=("$!")
if ! wait_sleeping 0393-lock-migration-6; then
  bad "6: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/6m.err")"
else
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from public.order_requests;\n" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 400 ]; then
    ok "6a: a new order reader read at once ($((t1 - t0)) ms) while the file held its locks"
  else
    bad "6a: a new order reader: $R after $((t1 - t0)) ms"
  fi
  t0="$(now_ms)"
  R="$(printf "set lock_timeout = '3s';\nbegin;\nselect 'locked:' || count(*)::text from public.order_requests where id = '%s' for update;\nrollback;\n" "$SIDEX" | "${PSQL[@]}" 2>&1)"
  t1="$(now_ms)"
  if [ "$R" = "locked:1" ] && [ $((t1 - t0)) -ge 300 ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "6b: a FOR UPDATE row lock waited for the hold ($((t1 - t0)) ms) and then went through (K3: no RPC holds a row while the file waits for it)"
  else
    bad "6b: a FOR UPDATE row lock: $R after $((t1 - t0)) ms"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/6m.err"; then bad "6: the migration session reported: $(tr '\n' ' ' < "$TMP/6m.err")"; fi

# ── 7. CONTROL: without the prelude the row writer shape deadlocks ────────
sed -e "${P0},${P1}d" -e "s/^set lock_timeout = '900ms';$/set lock_timeout = '5s';/" "$MIG" > "$TMP/no-prelude.sql"
# shellcheck disable=SC2016  # the same literal tag
if grep -q 'do \$c393_lock\$' "$TMP/no-prelude.sql" || ! grep -q "^set lock_timeout = '5s';$" "$TMP/no-prelude.sql"; then
  bad "7: could not build the no-prelude control file"
else
  printf "set application_name = '0393-lock-control';\nbegin;\nselect 1 from public.order_requests where id = '%s' for update;\nselect pg_sleep(1.5);\nupdate public.order_requests set internal_notes = 'handed over' where id = '%s';\nrollback;\nselect 'SHAPE_DONE';\n" "$LIVE" "$LIVE" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.s.out" 2>&1 &
  sp=$!
  if wait_sleeping 0393-lock-control; then
    { echo "begin;"; cat "$TMP/no-prelude.sql"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7.m.out" 2> "$TMP/7.m.err"
    wait "$sp"
    S40="$(grep -c '40P01' "$TMP/7.s.out" || true)"
    M40="$(grep -c '40P01' "$TMP/7.m.err" || true)"
    if [ $((S40 + M40)) -ge 1 ]; then
      ok "7: without the prelude one side got 40P01 (row writer: $S40, file: $M40): the K3 hazard is real, and the prelude removes it (case 5)"
    else
      bad "7: the control did not reproduce the deadlock (row writer: $(tr '\n' ' ' < "$TMP/7.s.out" | cut -c1-200); file: $(tr '\n' ' ' < "$TMP/7.m.err" | cut -c1-200))"
    fi
  else
    bad "7: the control row writer never reached pg_sleep"
    wait "$sp"
  fi
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
FIXTURE_AFTER="$(q "$FIXTURE_SQL")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$FIXTURE_AFTER" = "$FIXTURE_BEFORE" ]; then
  ok "the stack is unchanged (head $HEAD_NOW; every fixture order, side row and shipment byte for byte as planted)"
else
  bad "the stack changed under the script (head $HEAD_AFTER; fixtures changed: $([ "$FIXTURE_AFTER" = "$FIXTURE_BEFORE" ] && echo no || echo yes))"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
