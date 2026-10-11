#!/usr/bin/env bash
#
# Lock footprint of migration 0398 (returns RX-4, the contract): two REVOKE
# statements between a catalog-only preflight and post-check. GRANT and REVOKE
# update the catalog only and take no lock on the table, so the file needs no
# lock prelude. Written at the RX-4 desk stage (2026-10-11) and RUN AT THE TEST
# STAGE.
#
#   1.  The whole file holds no lock on any table outside the catalogs.
#   2.  While a reader of returns, a writer of returns (a row update) and a
#       writer of return_lines each hold an open transaction, the file runs to
#       the end at once (it never queues behind them), and they finish too.
#
# The migration session ALWAYS rolls back. It needs the pre-0398 head with 0397
# applied. LOCAL stack only (docker container supabase_db_stockpilot). Exit
# status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0398_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(ls "$REPO"/supabase/migrations/*_returns_contract.sql 2>/dev/null | head -n 1)"
TMP="$(mktemp -d)"

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
cleanup() { wait 2> /dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_returns_contract.sql"; exit 1; }
if [ "$(q "select has_table_privilege('authenticated', 'public.returns', 'INSERT')")" != "t" ] \
   || [ "$(q "select count(*) from pg_proc where proname = 'close_return_replacement_rest'")" = "0" ]; then
  echo "needs the pre-0398 head with 0397 applied (supabase db reset --local --version <the migration before 0398>)"
  exit 1
fi
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"

# ── 1. No table lock ─────────────────────────────────────────────────────
{ echo "begin;"; cat "$MIG"; echo "select 'END|' || coalesce(($LOCKS_SQL), 'none');"; echo "rollback;"; } \
  | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
if [ $? -ne 0 ]; then
  bad "1: the file failed: $(tr '\n' ' ' < "$TMP/1.err" | cut -c1-300)"
elif [ "$(sed -n 's/^END|//p' "$TMP/1.out")" = "none" ]; then
  ok "1: the whole file holds no lock on any table outside the catalogs"
else
  bad "1: the file holds: $(sed -n 's/^END|//p' "$TMP/1.out")"
fi

# ── 2. Never queues behind readers or writers of the return tables ───────
RMA="$(q "select id from public.returns order by created_at limit 1")"
RL="$(q "select id from public.return_lines order by created_at limit 1")"
holders=()
hold() { # hold <label> <sql>
  local app="0398-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(4);\ncommit;\nselect 'HOLDER_DONE';\n" "$app" "$2" \
    | "${PSQL[@]}" > "$TMP/2-$1.out" 2>&1 &
  holders+=($!)
  wait_sleeping "$app" || bad "2 $1: the holder never reached pg_sleep"
}
hold reader "select count(*) from public.returns;"
if [ -n "$RMA" ]; then hold writer "update public.returns set updated_at = updated_at where id = '$RMA';"; fi
if [ -n "$RL" ]; then hold line-writer "update public.return_lines set quantity = quantity where id = '$RL';"; fi
t0="$(now_ms)"
{ echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2.m.out" 2> "$TMP/2.m.err"
rc=$?
t1="$(now_ms)"
if [ $rc -eq 0 ] && [ $((t1 - t0)) -lt 1500 ]; then
  ok "2: with a reader and writers of both tables open, the file ran to the end in $((t1 - t0)) ms (rolled back)"
else
  bad "2: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/2.m.err" | cut -c1-300)"
fi
for p in "${holders[@]}"; do wait "$p"; done
for f in "$TMP"/2-*.out; do
  if grep -q 'HOLDER_DONE' "$f"; then ok "2: $(basename "$f" .out) finished"; else bad "2: $(basename "$f" .out) did not finish: $(tr '\n' ' ' < "$f" | cut -c1-200)"; fi
done
[ -n "$RMA" ] || echo "note: no RMA on this stack, the writer case was skipped (seed one first)"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
