#!/usr/bin/env bash
#
# Two-session proof for migration 0389 (order secrets, expand). pgTAP runs in
# ONE session, so it cannot show what generate_order_packing_slips does while
# another writer holds the order row.
#
#   1. Two mints of the same order at once. Session A (a manager) mints and
#      keeps its transaction open; session B (another manager) mints the same
#      order. B waits on A's row lock, then re-mints. After both: the order
#      column is sha256 of the side table's token, and A's token (whose
#      sha256 A's call returned) no longer matches: a printed QR from the
#      first mint is void, the regenerate rule.
#   2. A mint holds the order while reopen_picking waits (2a), and reopen
#      holds it while a mint waits (2b). 2a: after both, the order is back in
#      picking with no token and the side token is stale (its sha256 matches
#      nothing). 2b: the mint reads the reopened order under the lock and is
#      refused P0001 packing_slips_not_ready, and nothing is written.
#   3. A no-lock copy of the mint (a throwaway function, dropped by the EXIT
#      trap) in 2b's race passes its status check on the stale read and is
#      then refused by the transition trigger, P0001 invalid_status_transition,
#      which the app does not word (a 500). The lock is what makes the gate's
#      answer the right one; mutation M1 (the mint without its row lock) fails
#      2b for the same reason.
#   4. Why FOR NO KEY UPDATE and not FOR UPDATE: a side-table insert's foreign
#      key check takes FOR KEY SHARE on the order row. A transaction that holds
#      the order row FOR NO KEY UPDATE (the mint's lock) and then upserts the
#      side row does not block order_return_token_ensure's insert, and neither
#      waits on the other in a cycle (4a). The same steps with FOR UPDATE
#      deadlock (4b, kept as the evidence for the choice; Postgres aborts one
#      side with 40P01, which PostgREST would retry forever).
#   5. No session outside 4b ever sees 40001 or 40P01, and nothing deadlocks.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0389 applied. Fixtures are committed under the 03891111-... namespace
# and removed at the start, at the end and by the EXIT trap, as is the
# throwaway function. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0389_mint_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03891111-0000-0000-0000-00000000000a'
MGR='03891111-0000-0000-0000-0000000000a1'
MGR2='03891111-0000-0000-0000-0000000000a2'
WH='03891111-0000-0000-0000-0000000000b1'
ITEM='03891111-0000-0000-0000-0000000000c1'
O1='03891111-0000-0000-0000-0000000000d1'
O2='03891111-0000-0000-0000-0000000000d2'
O3='03891111-0000-0000-0000-0000000000d3'
O4='03891111-0000-0000-0000-0000000000d4'
O5='03891111-0000-0000-0000-0000000000d5'
O6='03891111-0000-0000-0000-0000000000d6'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
has() { grep -cF -- "$1" "$2"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
# The order column, and whether the side token is live (its sha256 is the
# column). Never prints a token: only digests' equality and nullness.
live()  { q "select coalesce((o.signature_token = encode(extensions.digest(s.signature_token, 'sha256'), 'hex'))::text, 'null') from public.order_requests o left join public.order_request_secrets s on s.order_request_id = o.id where o.id = '$1'"; }
status_of() { q "select status || '/' || coalesce(case when signature_token is null then 'no-token' else 'token' end, '') from public.order_requests where id = '$1'"; }
side_set()  { q "select (count(*) filter (where s.signature_token is not null))::text from public.order_request_secrets s where s.order_request_id = '$1'"; }
wait_sleeping() {
  local _
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = 'PgSleep'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public.zz_0389_mint_nolock(uuid);
delete from public.order_request_secrets where organization_id = '$ORG';
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from public.order_request_secrets where organization_id = '$ORG') + (select count(*) from pg_proc where proname = 'zz_0389_mint_nolock')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows or functions"; return 1; fi
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

cleanup || exit 1

if [ "$(q "select count(*) from pg_proc where proname = 'generate_order_packing_slips'")" != "1" ]; then
  echo "0389 is not applied on this stack (no generate_order_packing_slips)"; exit 1
fi

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0389-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0389-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0389 Two Session Org', '0389-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',  'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0389 2S Main', 'WH-0389-2S', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  ('$ITEM', '$ORG', '$WH', '2S secrets item', 'SKU-0389-2S', 100, 'active');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, approved_by, approved_at)
select v.id, '$ORG', '$WH', 'picking_complete', 'internal', '$MGR', 'pickup', '$MGR', now()
  from (values ('$O1'::uuid), ('$O2'::uuid), ('$O3'::uuid), ('$O4'::uuid), ('$O5'::uuid), ('$O6'::uuid)) v(id);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select v.id, '$ITEM', 5
  from (values ('$O1'::uuid), ('$O2'::uuid), ('$O3'::uuid), ('$O4'::uuid), ('$O5'::uuid), ('$O6'::uuid)) v(id);
-- O3 and O4 are minted before their races (committed), as a manager.
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select public.generate_order_packing_slips('$O3');
select public.generate_order_packing_slips('$O4');
commit;
SQL
then
  echo "fixture setup failed"; exit 1
fi

# as_user_sql <user id> <application_name|-> <statements>: the SQL of one
# transaction as that member (authenticated, with claims).
as_user_sql() {
  local sub="$1" app="$2" body="$3"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "set local role authenticated;" \
    "set local \"request.jwt.claim.role\" to 'authenticated';" \
    "set local \"request.jwt.claim.sub\" to '$sub';" \
    "$body" \
    "commit;"
}

# race <tag> <A's statements> <B's statements>: A runs (as MGR) and then
# sleeps 3 s holding its transaction; once A sits in pg_sleep, B runs (as
# MGR2). Records how long B took.
race() {
  local tag="$1" a="$2" b="$3"
  ( as_user_sql "$MGR" "0389-race-$tag-A" "$a
select pg_sleep(3);" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 ) &
  local pid=$!
  wait_sleeping "0389-race-$tag-A" || bad "$tag: session A never reached its pg_sleep (it did not take the row lock)"
  local t0; t0=$(now_ms)
  as_user_sql "$MGR2" - "$b" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B.out" 2>&1
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}

# ═══ 1. Two mints at once ═════════════════════════════════════════════════
echo "== 1. two managers mint the same order at once"
race twomint \
  "select 'A=' || r.signature_token from public.generate_order_packing_slips('$O1') r;" \
  "select 'B=' || r.signature_token from public.generate_order_packing_slips('$O1') r;"
WAITED="$(cat "$TMP/twomint.waited")"
A_DIGEST="$(sed -n 's/^A=//p' "$TMP/twomint.A.out")"
B_DIGEST="$(sed -n 's/^B=//p' "$TMP/twomint.B.out")"
check "1a: both minted (two 64-hex digests returned)" \
  "$(printf '%s\n%s\n' "$A_DIGEST" "$B_DIGEST" | grep -cE '^[0-9a-f]{64}$')" "2"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's order-row lock ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: the order column is B's digest, and sha256 of the side token" \
  "$(q "select (signature_token = '$B_DIGEST')::text from public.order_requests where id = '$O1'")/$(live "$O1")" "true/true"
check "1d: A's token no longer matches (its digest is not the column, nor the side token's)" \
  "$(q "select (o.signature_token = '$A_DIGEST')::text || '/' || (encode(extensions.digest(s.signature_token, 'sha256'), 'hex') = '$A_DIGEST')::text from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = '$O1'")" \
  "false/false"
check "1e: the order is packing_slip_generated with a token" "$(status_of "$O1")" "packing_slip_generated/token"

# ═══ 2a. A mint holds the order; reopen_picking waits ═════════════════════
echo "== 2a. a mint holds the order while reopen_picking waits"
race mintfirst \
  "select 'A=' || r.status from public.generate_order_packing_slips('$O2') r;" \
  "select 'B=' || r.status from public.reopen_picking('$O2', 'Miscount') r;"
WAITED="$(cat "$TMP/mintfirst.waited")"
check "2a-1: A minted" "$(grep -c '^A=packing_slip_generated$' "$TMP/mintfirst.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "2a-2: reopen waited for the mint's row lock ($WAITED ms)"; else bad "2a-2: reopen did not wait ($WAITED ms)"; fi
check "2a-3: reopen then went through" "$(grep -c '^B=picking_in_progress$' "$TMP/mintfirst.B.out")" "1"
check "2a-4: the order is back in picking with no token" "$(status_of "$O2")" "picking_in_progress/no-token"
check "2a-5: the side token is left behind and stale (its sha256 matches no column)" "$(side_set "$O2")/$(live "$O2")" "1/null"

# ═══ 2b. reopen_picking holds the order; a mint waits ═════════════════════
echo "== 2b. reopen_picking holds the order while a mint waits"
BEFORE_SIDE="$(q "select md5(signature_token) from public.order_request_secrets where order_request_id = '$O3'")"
race reopenfirst \
  "select 'A=' || r.status from public.reopen_picking('$O3', 'Miscount') r;" \
  "select 'B=' || r.status from public.generate_order_packing_slips('$O3') r;"
WAITED="$(cat "$TMP/reopenfirst.waited")"
check "2b-1: reopen went through" "$(grep -c '^A=picking_in_progress$' "$TMP/reopenfirst.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "2b-2: the mint waited for reopen's row lock ($WAITED ms)"; else bad "2b-2: the mint did not wait ($WAITED ms)"; fi
check "2b-3: the mint read the reopened order under its lock: P0001 packing_slips_not_ready (the app's 'after picking is complete' words)" \
  "$(has 'ERROR:  P0001: packing_slips_not_ready' "$TMP/reopenfirst.B.out"),$(has 'DETAIL:  picking_in_progress' "$TMP/reopenfirst.B.out")" "1,1"
check "2b-4: nothing was written: picking, no token, the side token unchanged" \
  "$(status_of "$O3")/$(q "select md5(signature_token) from public.order_request_secrets where order_request_id = '$O3'")" \
  "picking_in_progress/no-token/$BEFORE_SIDE"

# ═══ 3. The same race against a no-lock copy of the mint ══════════════════
echo "== 3. a no-lock copy of the mint (throwaway) in 2b's race"
if ! "${PSQL[@]}" >/dev/null 2>"$TMP/nolock.create.err" <<'SQL'
create function public.zz_0389_mint_nolock(p_id uuid)
returns public.order_requests
language plpgsql security definer
set search_path = public, extensions, pg_temp
set lock_timeout = '5s'
as $$
declare v_uid uuid := auth.uid(); v_org uuid; v_row public.order_requests%rowtype; v_raw text;
begin
  select o.organization_id into v_org from public.order_requests o where o.id = p_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  -- THE MUTATION: no row lock, so the checks below read a stale row.
  select * into v_row from public.order_requests o where o.id = p_id;
  if v_row.status not in ('picking_complete', 'packing_slip_generated') then
    raise exception 'packing_slips_not_ready' using errcode = 'P0001', hint = 'packing_slips_not_ready', detail = v_row.status;
  end if;
  v_raw := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.order_request_secrets (order_request_id, organization_id, signature_token)
  values (p_id, v_row.organization_id, v_raw)
  on conflict (order_request_id) do update set signature_token = excluded.signature_token, updated_at = now();
  update public.order_requests o
     set status = 'packing_slip_generated', packing_slip_generated_at = now(), packing_slip_generated_by = v_uid,
         signature_token = encode(extensions.digest(v_raw, 'sha256'), 'hex'),
         signature_token_expires_at = now() + interval '30 days'
   where o.id = p_id
  returning o.* into v_row;
  return v_row;
end;
$$;
revoke all on function public.zz_0389_mint_nolock(uuid) from public, anon;
grant execute on function public.zz_0389_mint_nolock(uuid) to authenticated;
SQL
then
  bad "3: could not create the throwaway function: $(tr '\n' ' ' < "$TMP/nolock.create.err")"
else
  race nolock \
    "select 'A=' || r.status from public.reopen_picking('$O4', 'Miscount') r;" \
    "select 'B=' || r.status from public.zz_0389_mint_nolock('$O4') r;"
  check "3a: reopen went through" "$(grep -c '^A=picking_in_progress$' "$TMP/nolock.A.out")" "1"
  check "3b: the no-lock mint passed its status check on the stale row and was refused by the transition trigger instead: P0001 invalid_status_transition (an unworded 500 in the app)" \
    "$(has 'ERROR:  P0001: invalid_status_transition' "$TMP/nolock.B.out"),$(has 'packing_slips_not_ready' "$TMP/nolock.B.out")" "1,0"
  check "3c: the transaction rolled back whole (picking, no token)" "$(status_of "$O4")" "picking_in_progress/no-token"
fi
q "drop function if exists public.zz_0389_mint_nolock(uuid)" >/dev/null

# ═══ 4. The row lock's strength against a side-table insert ═══════════════
# lock_then_upsert <tag> <lock clause>: A (postgres) locks O5/O6's row with
# the given clause, sleeps 3 s, then upserts its side row (the mint's order of
# operations); B (service_role) calls order_return_token_ensure on the same
# order meanwhile. deadlock_timeout is the default (1 s).
lock_then_upsert() {
  local tag="$1" order="$2" clause="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A4.out" 2>&1 <<SQL
set application_name to '0389-lock-$tag-A';
begin;
select 'A-lock' from public.order_requests where id = '$order' $clause;
select pg_sleep(3);
insert into public.order_request_secrets (order_request_id, organization_id, signature_token)
values ('$order', '$ORG', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (order_request_id) do update set signature_token = excluded.signature_token, updated_at = now();
select 'A-done';
commit;
SQL
  ) &
  local pid=$!
  wait_sleeping "0389-lock-$tag-A" || bad "4-$tag: session A never reached its pg_sleep"
  local t0; t0=$(now_ms)
  "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B4.out" 2>&1 <<SQL
begin;
set local role service_role;
select 'B=' || coalesce(public.order_return_token_ensure('$order')::text, 'null');
select pg_sleep(2);
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited4"
}

echo "== 4a. FOR NO KEY UPDATE (the mint's lock): the ensure's insert is not blocked, nothing deadlocks"
lock_then_upsert nokey "$O5" "for no key update"
check "4a-1: the ensure returned a token" "$(grep -cE '^B=[0-9a-f-]{36}$' "$TMP/nokey.B4.out")" "1"
check "4a-2: the locking session then finished its upsert" "$(grep -c '^A-done$' "$TMP/nokey.A4.out")" "1"
check "4a-3: no deadlock, no 40P01" "$(cat "$TMP/nokey.A4.out" "$TMP/nokey.B4.out" | grep -ciE 'deadlock|40P01')" "0"
check "4a-4: the side row holds both tokens" \
  "$(q "select (return_token is not null)::text || '/' || (signature_token is not null)::text from public.order_request_secrets where order_request_id = '$O5'")" "true/true"

echo "== 4b. FOR UPDATE (the plan's first draft): the same steps deadlock (kept as the evidence for the choice)"
lock_then_upsert forupdate "$O6" "for update"
check "4b-1: one side was aborted as a deadlock (40P01)" \
  "$(cat "$TMP/forupdate.A4.out" "$TMP/forupdate.B4.out" | grep -c 'ERROR:  40P01: deadlock detected')" "1"

# ═══ 5. No retryable error anywhere else ══════════════════════════════════
echo "== 5. no 40001 or 40P01, and no deadlock, outside 4b"
check "5a: no 40001 or 40P01" "$(cat "$TMP"/*.A.out "$TMP"/*.B.out "$TMP"/nokey.*.out | grep -cE '40001|40P01')" "0"
check "5b: no deadlock reported" "$(cat "$TMP"/*.A.out "$TMP"/*.B.out "$TMP"/nokey.*.out | grep -ci 'deadlock')" "0"
# The fixtures' raw side tokens go to a file in the script's private temp
# directory (never printed), and no session's output may contain one.
q "select s.signature_token from public.order_request_secrets s where s.organization_id = '$ORG' and s.signature_token is not null" > "$TMP/raw-tokens"
check "5c: no session's output carried a raw token (only digests were printed)" \
  "$(cat "$TMP"/*.out | grep -cFf "$TMP/raw-tokens")" "0"
rm -f "$TMP/raw-tokens"

cleanup || FAILS=$((FAILS + 1))

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
