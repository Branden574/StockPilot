#!/usr/bin/env bash
#
# Lock footprint of migration 0388 (explicit order numbers, requester
# deletion). The push runs the whole file as one transaction, so every table
# lock a statement takes is held until the file commits. Unlike 0387, 0388
# must take ACCESS EXCLUSIVE on order_requests: ADD COLUMN and the CHECK swap
# (validated under the same lock) need it. The file therefore does its
# lock-free work first (functions, grants) and one ALTER TABLE last, and sets
# lock_timeout 2s so it never queues for long behind a reader. This proves:
#
#   1. At the end of the file the only relation locks held on public tables
#      are on order_requests, and they are ACCESS EXCLUSIVE (the ALTER) plus
#      SHARE ROW EXCLUSIVE (the trigger), SHARE UPDATE EXCLUSIVE (COMMENT ON
#      COLUMN) and ACCESS SHARE (COMMENT ON CONSTRAINT looks the constraint up
#      through its table), all subsumed by the first. No other table is
#      locked, and the functions and grants before the ALTER lock nothing.
#   2. The ACCESS EXCLUSIVE hold, from the ALTER to the end of the file, is
#      under 100 ms locally (about 6 ms measured at design time).
#   3. A reader with an open transaction on order_requests (a long report
#      export at push time) makes the file fail 55P03 after about 2 s
#      (lock_timeout), writing nothing; it is re-run later. A reader that
#      arrives while the file waits is held only until the file gives up.
#   4. A new reader arriving while the file holds its locks waits only for
#      the hold (here an artificial 1 s), then reads.
#
# The migration session ALWAYS rolls back, so the script changes nothing. It
# needs the pre-0388 head (the production push condition: the file adds a
# column and cannot be re-applied on top of itself). LOCAL stack only (docker
# container supabase_db_stockpilot). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0388_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$REPO/supabase/migrations/0388_order_number_and_requester_deletion.sql"
TMP="$(mktemp -d)"
BG=()

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
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local p
  for p in "${BG[@]:-}"; do [ -n "$p" ] && wait "$p" 2> /dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

[ -f "$MIG" ] || { echo "missing $MIG"; exit 1; }
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
HAS_COL="$(q "select count(*) from pg_attribute where attrelid = 'public.order_requests'::regclass and attname = 'requester_deleted_at' and not attisdropped")"
echo "local head $HEAD_NOW; requester_deleted_at present: $HAS_COL"
if [ "$HAS_COL" != "0" ]; then
  echo "needs the pre-0388 head (supabase db reset --local --version 0387, then the QA reseed)"
  exit 1
fi

# The file split at its one ALTER TABLE (part 2 = the ALTER to the end).
ALTER_LINE="$(grep -n '^alter table public.order_requests$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$ALTER_LINE" ] || { echo "no ALTER TABLE line in $MIG"; exit 1; }
head -n $((ALTER_LINE - 1)) "$MIG" > "$TMP/part1.sql"
tail -n +"$ALTER_LINE" "$MIG" > "$TMP/part2.sql"

# ── 1 and 2. The locks at the end of the file; the ACCESS EXCLUSIVE hold ─
{
  echo "begin;"
  cat "$TMP/part1.sql"
  echo "select 'BEFORE_ALTER|' || coalesce(string_agg(distinct c.relname || ':' || l.mode, ',' order by c.relname || ':' || l.mode), 'none')"
  echo "  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace"
  echo " where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted and n.nspname = 'public';"
  echo "select 'T0|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/part2.sql"
  echo "select 'T1|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'END|' || coalesce(string_agg(distinct c.relname || ':' || l.mode, ',' order by c.relname || ':' || l.mode), 'none')"
  echo "  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace"
  echo " where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted and n.nspname = 'public';"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
else
  BEFORE="$(sed -n 's/^BEFORE_ALTER|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then
    ok "1a: the functions and grants take no lock on any public table (before the ALTER: $BEFORE)"
  else
    bad "1a: before the ALTER the file already holds: $BEFORE"
  fi
  OTHER="$(printf '%s' "$END" | tr ',' '\n' | grep -v '^order_requests:' || true)"
  MODES="$(printf '%s' "$END" | tr ',' '\n' | sed -n 's/^order_requests://p' | sort | tr '\n' ',' | sed 's/,$//')"
  if [ -n "$OTHER" ]; then
    bad "1b: the file locks another public table: $(printf '%s' "$OTHER" | tr '\n' ' ')"
  elif ! printf '%s' "$MODES" | grep -q 'AccessExclusiveLock' || ! printf '%s' "$MODES" | grep -q 'ShareRowExclusiveLock'; then
    bad "1b: order_requests locks are not ACCESS EXCLUSIVE + SHARE ROW EXCLUSIVE: $MODES"
  elif printf '%s' "$MODES" | tr ',' '\n' | grep -Evq '^(AccessExclusiveLock|ShareRowExclusiveLock|ShareUpdateExclusiveLock|AccessShareLock)$'; then
    bad "1b: an unexpected lock mode on order_requests: $MODES"
  else
    ok "1b: at the end of the file only order_requests is locked: $MODES"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 100 ]; then
    ok "2: the ALTER to the end of the file took $((T1 - T0)) ms (the ACCESS EXCLUSIVE hold before commit)"
  else
    bad "2: the ALTER to the end of the file took $((T1 - T0)) ms"
  fi
fi

# ── 3. A reader's open transaction: the file fails 55P03 at ~2 s ─────────
"${PSQL[@]}" > "$TMP/3r.out" 2>&1 <<'SQL' &
set application_name = '0388-lock-reader';
begin;
select count(*) from public.order_requests;
select pg_sleep(6);
commit;
SQL
BG+=("$!")
if ! wait_sleeping 0388-lock-reader; then
  bad "3: the reader never reached pg_sleep"
else
  { echo "set application_name = '0388-lock-migration-3';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3m.out" 2> "$TMP/3m.err" &
  MPID=$!
  # A reader arriving while the file waits behind the first one.
  sleep 0.5
  t0="$(now_ms)"
  R="$("${PSQL[@]}" 2>&1 <<'SQL'
set lock_timeout = '5s';
select 'read:' || (count(*) >= 0)::text from public.order_requests;
SQL
)"
  t1="$(now_ms)"
  wait "$MPID"
  rc=$?
  if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3m.err"; then
    ok "3a: with a reader's transaction open the file failed 55P03 (lock_timeout 2s) and wrote nothing"
  else
    bad "3a: the file did not fail 55P03 behind the reader (rc $rc): $(tr '\n' ' ' < "$TMP/3m.err")"
  fi
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 2500 ]; then
    ok "3b: a reader arriving while the file waited read after $((t1 - t0)) ms (held at most until the file gave up)"
  else
    bad "3b: a reader arriving while the file waited: $R after $((t1 - t0)) ms"
  fi
fi
wait "${BG[0]}" 2> /dev/null

# ── 4. While the file holds its locks, a new reader waits only for the hold
{
  echo "set application_name = '0388-lock-migration-4';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/4m.out" 2> "$TMP/4m.err" &
BG+=("$!")
if ! wait_sleeping 0388-lock-migration-4; then
  bad "4: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/4m.err")"
else
  t0="$(now_ms)"
  R="$("${PSQL[@]}" 2>&1 <<'SQL'
set lock_timeout = '3s';
select 'read:' || (count(*) >= 0)::text from public.order_requests;
SQL
)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
    ok "4: a new reader waited for the 1 s hold only and read after $((t1 - t0)) ms"
  else
    bad "4: a new reader while the file held its locks: $R after $((t1 - t0)) ms"
  fi
fi
wait "${BG[1]}" 2> /dev/null
if grep -q . "$TMP/4m.err"; then
  bad "4: the migration session reported: $(tr '\n' ' ' < "$TMP/4m.err")"
fi

# Nothing was applied.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
COL_AFTER="$(q "select count(*) from pg_attribute where attrelid = 'public.order_requests'::regclass and attname = 'requester_deleted_at' and not attisdropped")"
FN_AFTER="$(q "select count(*) from pg_proc where proname in ('account_deletion_check', 'tg_order_requests_requester_deleted')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$COL_AFTER" = "0" ] && [ "$FN_AFTER" = "0" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, no 0388 column or function)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, column $COL_AFTER, functions $FN_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
