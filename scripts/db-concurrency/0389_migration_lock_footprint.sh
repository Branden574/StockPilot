#!/usr/bin/env bash
#
# Lock footprint of migration 0389 (order secrets, expand). The push runs the
# whole file as one transaction, so every table lock a statement takes is held
# until the file commits. 0389 writes no row; its only locks on existing
# tables come from CREATE TABLE's two foreign keys (RI triggers added to
# order_requests and organizations: SHARE ROW EXCLUSIVE) and COMMENT ON
# COLUMN order_requests.signature_token (SHARE UPDATE EXCLUSIVE). This proves
# that the file never takes a lock that stops order READS (order pages, the
# RLS subqueries on order lines, report exports) or an order RPC's row lock:
#
#   1. At the end of the file, neither ACCESS EXCLUSIVE (blocks every SELECT)
#      nor EXCLUSIVE (blocks SELECT ... FOR UPDATE) is held on any table that
#      existed before it (order_requests, organizations, any other). The new
#      table's own locks are listed and allowed (no one else can see it).
#   2. A reader with an open transaction on order_requests and organizations
#      (a long report export at push time) does not stall the file.
#   3. A WRITER with an open transaction on order_requests makes the file wait
#      at most lock_timeout (5 s) and fail cleanly with 55P03, writing
#      nothing (never 40001/40P01): retry the push off-peak.
#   4. While the file holds its locks, a new reader reads order_requests and
#      organizations at once, and an order RPC's row lock (SELECT ... FOR NO
#      KEY UPDATE, ROW SHARE) is granted at once; a write waits (lock timeout
#      at 1 s), the footprint the migration header states. No row lock is
#      waited on by the file, so no deadlock with an order RPC is possible.
#
# The migration session ALWAYS rolls back, so the script changes nothing. It
# needs the pre-0389 head (the production push condition: the file creates a
# table and cannot be re-applied on top of itself). LOCAL stack only (docker
# container supabase_db_stockpilot). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0389_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$REPO/supabase/migrations/0389_order_secrets_expand.sql"
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
HAS_TABLE="$(q "select count(*) from pg_class where oid = to_regclass('public.order_request_secrets')")"
echo "local head $HEAD_NOW; order_request_secrets present: $HAS_TABLE"
if [ "$HAS_TABLE" != "0" ]; then
  echo "needs the pre-0389 head (supabase db reset --local --version <the migration before 0389>, then the QA reseed)"
  exit 1
fi
ORDER_ID="$(q "select id from public.order_requests order by created_at limit 1")"
[ -n "$ORDER_ID" ] || { echo "the local stack has no order to lock (seed it first)"; exit 1; }

# ── 1. The locks the file holds at its end ───────────────────────────────
{
  echo "begin;"
  cat "$MIG"
  echo "select coalesce(string_agg(c.relname || '=' || l.mode, ',' order by c.relname, l.mode), 'none')"
  echo "  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace"
  echo " where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted and n.nspname = 'public' and c.relkind in ('r', 'p');"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
LOCKS="$(tail -n 1 "$TMP/1.out")"
echo "   table locks at the end of the file: $LOCKS"
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
else
  OLD_TABLE_LOCKS="$(printf '%s' "$LOCKS" | tr ',' '\n' | grep -v '^order_request_secrets=' || true)"
  if printf '%s\n' "$OLD_TABLE_LOCKS" | grep -Eq '=(AccessExclusiveLock|ExclusiveLock)$'; then
    bad "1: the file holds a lock that blocks reads or row locks on an existing table: $OLD_TABLE_LOCKS"
  else
    ok "1: no ACCESS EXCLUSIVE or EXCLUSIVE lock on any existing table ($(printf '%s' "$OLD_TABLE_LOCKS" | tr '\n' ' '))"
  fi
  if printf '%s\n' "$OLD_TABLE_LOCKS" | grep -qv -E '^(order_requests|organizations)='; then
    bad "1b: the file locks a table other than order_requests and organizations: $OLD_TABLE_LOCKS"
  else
    ok "1b: the only existing tables it locks are order_requests and organizations"
  fi
fi

# ── 2. A reader holding an open transaction does not stall the file ──────
"${PSQL[@]}" > "$TMP/2r.out" 2>&1 <<'SQL' &
set application_name = '0389-lock-reader';
begin;
select count(*) from public.order_requests;
select count(*) from public.organizations;
select pg_sleep(7);
commit;
SQL
BG+=("$!")
if ! wait_sleeping 0389-lock-reader; then
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
    ok "2: with a reader's transaction open on order_requests and organizations the file ran to the end in $((t1 - t0)) ms"
  fi
fi
wait "${BG[0]}" 2> /dev/null

# ── 3. A writer holding an open transaction: the file fails 55P03, cleanly ─
"${PSQL[@]}" > "$TMP/3w.out" 2>&1 <<SQL &
set application_name = '0389-lock-writer';
begin;
update public.order_requests set internal_notes = internal_notes where id = '$ORDER_ID';
select pg_sleep(9);
rollback;
SQL
BG+=("$!")
if ! wait_sleeping 0389-lock-writer; then
  bad "3: the writer never reached pg_sleep"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3m.out" 2> "$TMP/3m.err"
  rc=$?
  t1="$(now_ms)"
  if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3m.err" && [ $((t1 - t0)) -ge 4500 ] && [ $((t1 - t0)) -lt 8000 ]; then
    ok "3: behind an open order write the file waited its lock_timeout and failed cleanly with 55P03 after $((t1 - t0)) ms"
  else
    bad "3: behind an open order write: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3m.err")"
  fi
  if grep -qE '40001|40P01' "$TMP/3m.err"; then bad "3b: a retryable SQLSTATE appeared"; else ok "3b: no 40001 or 40P01"; fi
fi
wait "${BG[1]}" 2> /dev/null

# ── 4. While the file holds its locks: reads and row locks go, writes wait ─
{
  echo "set application_name = '0389-lock-migration';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(6);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/4m.out" 2> "$TMP/4m.err" &
BG+=("$!")
if ! wait_sleeping 0389-lock-migration; then
  bad "4: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/4m.err")"
else
  t0="$(now_ms)"
  R="$("${PSQL[@]}" 2>&1 <<'SQL'
set lock_timeout = '2s';
select 'read:' || ((select count(*) from public.order_requests) >= 0 and (select count(*) from public.organizations) >= 0)::text;
SQL
)"
  t1="$(now_ms)"
  if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1500 ]; then
    ok "4a: a new reader read order_requests and organizations in $((t1 - t0)) ms while the file held its locks"
  else
    bad "4a: a new reader was blocked while the file held its locks ($((t1 - t0)) ms): $R"
  fi
  t0="$(now_ms)"
  RL="$("${PSQL[@]}" 2>&1 <<SQL
set lock_timeout = '2s';
begin;
select 'rowlock:' || count(*)::text from (select 1 from public.order_requests where id = '$ORDER_ID' for no key update) x;
rollback;
SQL
)"
  t1="$(now_ms)"
  if [ "$RL" = "rowlock:1" ] && [ $((t1 - t0)) -lt 1500 ]; then
    ok "4b: an order RPC's row lock (FOR NO KEY UPDATE) was granted in $((t1 - t0)) ms while the file held its locks"
  else
    bad "4b: an order row lock waited on the file ($((t1 - t0)) ms): $RL"
  fi
  W="$("${PSQL[@]}" 2>&1 <<'SQL'
set lock_timeout = '1s';
update public.order_requests set internal_notes = internal_notes where false;
SQL
)"
  if printf '%s' "$W" | grep -q 'canceling statement due to lock timeout'; then
    ok "4c: a write waits while the file holds SHARE ROW EXCLUSIVE (lock timeout at 1 s, as the header states)"
  else
    bad "4c: a write did not wait on the file's SHARE ROW EXCLUSIVE lock: $W"
  fi
fi
wait "${BG[2]}" 2> /dev/null
if grep -q . "$TMP/4m.err"; then
  bad "4: the migration session reported: $(tr '\n' ' ' < "$TMP/4m.err")"
fi

# Nothing was applied: the head is as it was and the table does not exist.
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
TABLE_AFTER="$(q "select count(*) from pg_class where oid = to_regclass('public.order_request_secrets')")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$TABLE_AFTER" = "0" ]; then
  ok "the stack is unchanged (head $HEAD_NOW, no order_request_secrets)"
else
  bad "the stack changed under the script (head $HEAD_AFTER, order_request_secrets present: $TABLE_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
