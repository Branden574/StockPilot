#!/usr/bin/env bash
#
# Lock footprint of the notice audience migration (docket S36, part a;
# supabase/migrations/*_notice_audience_follows_permission.sql, found by name
# so a renumber at ship time needs no edit here). The push runs the whole file
# as one batch, so every lock is held until the file commits. The file creates
# and replaces functions and comments only: plpgsql bodies are checked for
# syntax, but a SQL body is parse-analysed when created (check_function_bodies),
# which takes ACCESS SHARE on every table it names. This proves:
#
#   1a. At the end of the file (before commit) it holds, outside the catalogs,
#       ACCESS SHARE on exactly the five tables its SQL bodies name
#       (organization_members, user_profiles, user_permission_overrides,
#       role_permission_overrides, role_default_permissions) and nothing else:
#       no lock at all on order_requests, purchase_orders or receipts, and
#       nothing stronger than ACCESS SHARE anywhere.
#   1b. The whole file takes under 1 s here (the hold before commit).
#   2.  While the file holds its locks (an artificial 1.5 s before rollback),
#       other sessions do not wait: a new order (its notify trigger runs the
#       old body until the file commits), a write to a membership row, a FOR
#       UPDATE on one, and a read of every table it locks.
#   3.  A transaction still open after it inserted an order (so it ran the
#       notify trigger) and wrote a membership row does not hold the file up:
#       replacing a function never waits for a caller.
#   4.  A held ACCESS EXCLUSIVE on organization_members (an ALTER TABLE, say)
#       longer than lock_timeout: the file waits 900 ms and fails 55P03, never
#       40P01 or 40001, and nothing is applied.
#   5.  Nothing was applied: every run rolls back; the head and the five
#       restated bodies are as they were.
#
# Run it on a stack at the head BEFORE this migration (its preflight refuses a
# stack where it is applied). Its own fixture rows (an organization in its own
# namespace) are removed at the start, the end and by the EXIT trap. LOCAL
# stack only.
#
# Usage: bash scripts/db-concurrency/0422_migration_lock_footprint.sh
#        CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0422_migration_lock_footprint.sh
#        (the migration scratch stack; run it holding that stack's slot)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$(ls "$REPO"/supabase/migrations/*_notice_audience_follows_permission.sql 2> /dev/null | head -n 1)"
TMP="$(mktemp -d)"
BG=()

ORG='a36a4444-0000-0000-0000-00000000000a'
MGR='a36a4444-0000-0000-0000-0000000000a1'
STF='a36a4444-0000-0000-0000-0000000000a2'
WH='a36a4444-0000-0000-0000-0000000000c1'

FAILS=0
ok() { printf 'ok     %s\n' "$*"; }
bad() {
  printf 'FAIL   %s\n' "$*"
  FAILS=$((FAILS + 1))
}
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
  "${PSQL[@]}" > /dev/null 2>&1 << SQL
delete from public.notifications where organization_id = '$ORG';
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$STF');
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

[ -n "$MIG" ] && [ -f "$MIG" ] || {
  echo "missing supabase/migrations/*_notice_audience_follows_permission.sql"
  exit 1
}
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
APPLIED="$(q "select count(*) from pg_proc where oid = to_regprocedure('public._notify_recipients_with_permission(uuid,text)')")"
echo "local head $HEAD_NOW; migration $(basename "$MIG"); already applied: $APPLIED"
[ "$APPLIED" = "0" ] || {
  echo "the stack already has this migration: reset it to the head before it"
  exit 1
}
BODIES_SQL="select string_agg(p.proname || '=' || md5(p.prosrc), ',' order by p.proname)
  from pg_proc p where p.pronamespace = 'public'::regnamespace
   and p.proname in ('_notify_order_request_changes', '_notify_recipients', '_notify_po_status',
                     '_notify_receipt_posted', '_notify_replacement_order_changes')"
BODIES_BEFORE="$(q "$BODIES_SQL")"

cleanup_rows
"${PSQL[@]}" > /dev/null << SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR', 'mgr.s36a-lock@example.test', '{}'::jsonb),
  ('$STF', 'stf.s36a-lock@example.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', 'S36a Lock Org', 's36a-lock');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$STF', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', 'S36a Lock Main', 'WH-S36A-LK', 'active');
SQL

LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"
ORDER_INSERT="insert into public.order_requests (organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type)
  values ('$ORG', '$WH', 'pending_approval', 'internal', '$STF', 'Lock Person', 'pickup')"

# ── 1. What the file holds at its end, and for how long ──────────────────
{
  echo "begin;"
  echo "select 'T0|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$MIG"
  echo "select 'T1|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'END|' || coalesce(($LOCKS_SQL), 'none');"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err" | cut -c1-400)"
else
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  EXPECTED='public.organization_members:AccessShareLock,public.role_default_permissions:AccessShareLock,public.role_permission_overrides:AccessShareLock,public.user_permission_overrides:AccessShareLock,public.user_profiles:AccessShareLock'
  if [ "$END" = "$EXPECTED" ]; then
    ok "1a: at its end the file holds ACCESS SHARE on exactly the five tables its SQL bodies name, nothing on order_requests, purchase_orders or receipts"
  else
    bad "1a: at its end the file holds: $END; expected: $EXPECTED"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 1000 ]; then
    ok "1b: the whole file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "1b: the whole file took $((T1 - T0)) ms"
  fi
fi

# ── 2. While the file holds its locks, nobody waits ──────────────────────
{
  echo "set application_name = 's36a-lock-file-2';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1.5);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/2m.out" 2> "$TMP/2m.err" &
BG+=("$!")
if ! wait_sleeping s36a-lock-file-2; then
  bad "2: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/2m.err" | cut -c1-300)"
else
  timed() { # timed <label> <sql> <expected output>
    local t0 t1 r
    t0="$(now_ms)"
    r="$(printf "set lock_timeout = '3s';\nbegin;\n%s;\nrollback;\n" "$2" | "${PSQL[@]}" 2>&1)"
    t1="$(now_ms)"
    if [ "$r" = "$3" ] && [ $((t1 - t0)) -lt 400 ]; then
      ok "2 $1: went through at once ($((t1 - t0)) ms) while the file held its locks"
    else
      bad "2 $1: '$r' after $((t1 - t0)) ms"
    fi
  }
  timed "a new order (the notify trigger fires)" "$ORDER_INSERT returning 'inserted'" "inserted"
  timed "a membership write" "update public.organization_members set role = role where organization_id = '$ORG' and user_id = '$STF' returning 'updated'" "updated"
  timed "a FOR UPDATE on a membership row" "select 'locked:' || count(*) from (select 1 from public.organization_members where organization_id = '$ORG' for update) x" "locked:2"
  timed "a read of the five tables" "select 'read:' || ((select count(*) from public.organization_members) + (select count(*) from public.user_profiles) + (select count(*) from public.user_permission_overrides) + (select count(*) from public.role_permission_overrides) + (select count(*) from public.role_default_permissions) >= 0)::text" "read:true"
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/2m.err"; then bad "2: the migration session reported: $(tr '\n' ' ' < "$TMP/2m.err" | cut -c1-300)"; fi

# ── 3. A caller with an open transaction does not hold the file up ───────
printf "set application_name = 's36a-lock-caller';\nbegin;\n%s;\nupdate public.organization_members set role = role where organization_id = '%s' and user_id = '%s';\nselect pg_sleep(4);\nrollback;\n" "$ORDER_INSERT" "$ORG" "$MGR" \
  | "${PSQL[@]}" > "$TMP/3c.out" 2>&1 &
BG+=("$!")
if ! wait_sleeping s36a-lock-caller; then
  bad "3: the caller never reached pg_sleep: $(tr '\n' ' ' < "$TMP/3c.out" | cut -c1-300)"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" > "$TMP/3m.out" 2> "$TMP/3m.err"
  rc=$?
  t1="$(now_ms)"
  if [ $rc -eq 0 ] && [ $((t1 - t0)) -lt 1500 ]; then
    ok "3: with a caller's transaction open (an order inserted, a membership row written) the file ran to the end in $((t1 - t0)) ms"
  else
    bad "3: with a caller open the file: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3m.err" | cut -c1-300)"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()

# ── 4. Behind an ACCESS EXCLUSIVE holder the file fails 55P03 ─────────────
printf "set application_name = 's36a-lock-alter';\nbegin;\nlock table public.organization_members in access exclusive mode;\nselect pg_sleep(8);\nrollback;\n" \
  | "${PSQL[@]}" > "$TMP/4h.out" 2>&1 &
BG+=("$!")
if ! wait_sleeping s36a-lock-alter; then
  bad "4: the holder never reached pg_sleep: $(tr '\n' ' ' < "$TMP/4h.out" | cut -c1-300)"
else
  t0="$(now_ms)"
  { echo "begin;"; cat "$MIG"; echo "rollback;"; } | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4m.out" 2> "$TMP/4m.err"
  rc=$?
  t1="$(now_ms)"
  if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/4m.err" && ! grep -qE '40P01|40001' "$TMP/4m.err" \
    && [ $((t1 - t0)) -ge 800 ] && [ $((t1 - t0)) -lt 3000 ]; then
    ok "4: behind an ACCESS EXCLUSIVE holder the file waited $((t1 - t0)) ms and failed 55P03 (lock_timeout), never 40P01 or 40001"
  else
    bad "4: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/4m.err" | cut -c1-300)"
  fi
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()

# ── 5. Nothing was applied ───────────────────────────────────────────────
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
BODIES_AFTER="$(q "$BODIES_SQL")"
APPLIED_AFTER="$(q "select count(*) from pg_proc where oid in (to_regprocedure('public._notify_recipients_with_permission(uuid,text)'), to_regprocedure('public._notify_is_current_member(uuid,uuid)'))")"
if [ "$HEAD_AFTER" = "$HEAD_NOW" ] && [ "$BODIES_AFTER" = "$BODIES_BEFORE" ] && [ "$APPLIED_AFTER" = "0" ]; then
  ok "5: the stack is unchanged (head $HEAD_NOW; the five restated bodies as they were; neither new function exists)"
else
  bad "5: the stack changed under the script (head $HEAD_AFTER; bodies changed: $([ "$BODIES_AFTER" = "$BODIES_BEFORE" ] && echo no || echo yes); new functions: $APPLIED_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
