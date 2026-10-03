#!/usr/bin/env bash
#
# Lock footprint of migration 0387 (S0, the order workflow guard). The push
# runs the whole file as one transaction, so every table lock a statement
# takes is held until the file commits. This proves that the file never takes
# a lock that stops order READS (order pages, the RLS subqueries on
# order_request_lines and order_request_attachments, report exports):
#
#   1. One session runs the file inside a transaction and lists the relation
#      locks it then holds on public.order_requests. Neither ACCESS EXCLUSIVE
#      (blocks every SELECT) nor EXCLUSIVE (blocks SELECT ... FOR UPDATE) may
#      appear. Expected: SHARE ROW EXCLUSIVE (CREATE OR REPLACE TRIGGER) and
#      SHARE UPDATE EXCLUSIVE (COMMENT ON COLUMN).
#   2. A reader holds an open transaction that has read order_requests (a
#      long report export at push time). The file still runs to the end
#      within its lock_timeout instead of queueing behind the reader (and
#      making every new order read queue behind it).
#   3. While the file's transaction holds its locks, a new reader still reads
#      order_requests at once. A writer waits (SHARE ROW EXCLUSIVE conflicts
#      with ROW EXCLUSIVE), which is the footprint the migration header
#      states: writes wait while the file runs.
#
# The migration session ALWAYS rolls back, so the script changes nothing. It
# runs at either local head: before 0387 (the production push condition) or
# with 0387 applied (a re-apply, as the revert lab does). LOCAL stack only
# (docker container supabase_db_stockpilot). Exit status 0 = every check
# passed.
#
# Usage: bash scripts/db-concurrency/0387_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$REPO/supabase/migrations/0387_order_workflow_guard.sql"
TMP="$(mktemp -d)"
BG=()

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
# wait_sleeping <application_name>: until that backend sits in pg_sleep.
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
HAS_GUARD="$(q "select count(*) from pg_trigger where tgrelid = 'public.order_requests'::regclass and tgname = 'trg_order_requests_workflow_guard'")"
echo "local head $HEAD_NOW; guard trigger present: $HAS_GUARD (0 = the production push condition, 1 = a re-apply)"

# ── 1. The locks the file holds on order_requests at its end ─────────────
{
  echo "begin;"
  cat "$MIG"
  echo "select coalesce(string_agg(distinct mode, ',' order by mode), 'none') from pg_locks"
  echo " where locktype = 'relation' and relation = 'public.order_requests'::regclass and pid = pg_backend_pid() and granted;"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
MODES="$(tail -n 1 "$TMP/1.out")"
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
elif printf '%s' "$MODES" | grep -Eq '(^|,)(AccessExclusiveLock|ExclusiveLock)(,|$)'; then
  bad "1: the file holds a lock that blocks order reads on order_requests: $MODES"
else
  ok "1: locks held on order_requests at the end of the file: $MODES (no ACCESS EXCLUSIVE, no EXCLUSIVE)"
fi

# ── 2. A reader holding an open transaction does not stall the file ──────
"${PSQL[@]}" > "$TMP/2r.out" 2>&1 <<'SQL' &
set application_name = '0387-lock-reader';
begin;
select count(*) from public.order_requests;
select pg_sleep(7);
commit;
SQL
BG+=("$!")
if ! wait_sleeping 0387-lock-reader; then
  bad "2: the reader never reached pg_sleep"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" > "$TMP/2m.out" 2> "$TMP/2m.err"
  rc=$?
  t1="$(now_ms)"
  if [ $rc -ne 0 ]; then
    bad "2: with a reader open the file failed after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/2m.err")"
  elif [ $((t1 - t0)) -ge 3000 ]; then
    bad "2: with a reader open the file took $((t1 - t0)) ms (it queued behind the reader)"
  else
    ok "2: with a reader's transaction open on order_requests the file ran to the end in $((t1 - t0)) ms"
  fi
fi
wait "${BG[0]}" 2> /dev/null

# ── 3. While the file holds its locks, a new reader reads at once ────────
{
  echo "set application_name = '0387-lock-migration';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(6);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/3m.out" 2> "$TMP/3m.err" &
BG+=("$!")
if ! wait_sleeping 0387-lock-migration; then
  bad "3: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/3m.err")"
else
  t0="$(now_ms)"
  R="$("${PSQL[@]}" 2>&1 <<'SQL'
set lock_timeout = '2s';
select 'read:' || (count(*) >= 0)::text from public.order_requests;
SQL
)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1500 ]; then
    ok "3: a new reader read order_requests in $((t1 - t0)) ms while the file held its locks"
  else
    bad "3: a new reader was blocked while the file held its locks ($((t1 - t0)) ms): $R"
  fi
  W="$("${PSQL[@]}" 2>&1 <<'SQL'
set lock_timeout = '1s';
update public.order_requests set internal_notes = internal_notes where false;
SQL
)"
  if printf '%s' "$W" | grep -q 'canceling statement due to lock timeout'; then
    ok "3b: a writer waits while the file holds SHARE ROW EXCLUSIVE (lock timeout at 1 s, as the header states)"
  else
    bad "3b: a writer did not wait on the file's SHARE ROW EXCLUSIVE lock: $W"
  fi
fi
wait "${BG[1]}" 2> /dev/null
if grep -q . "$TMP/3m.err"; then
  bad "3: the migration session reported: $(tr '\n' ' ' < "$TMP/3m.err")"
fi

# Nothing was applied: the head and the trigger are as they were.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
GUARD_AFTER="$(q "select count(*) from pg_trigger where tgrelid = 'public.order_requests'::regclass and tgname = 'trg_order_requests_workflow_guard'")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$GUARD_AFTER" = "$HAS_GUARD" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, guard trigger present: $HAS_GUARD)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, guard trigger present: $GUARD_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
