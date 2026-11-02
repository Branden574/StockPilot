#!/usr/bin/env bash
#
# Two-session proof for the replacement guards migration (docket S7, slice
# S7a; V-1-6 and S4-1): every RMA function that touches a replacement asks
# write access to the replacement's own warehouse BEFORE its first row lock,
# so a caller who may not act is refused at once instead of queueing on the
# RMA row or the replacement row first. pgTAP runs in ONE session, so it
# cannot show the wait (supabase/tests/0425_replacement_guards.test.sql
# section V shows the refusals and V-1-7 the order in each body).
#
# Fixture: one organization with warehouses A and B. Each of the five
# functions gets its own RMA, its replacement in A, built by a manager; then
# every original is moved to B (a raw update as the superuser, the V-1 move:
# the RMA's own gates now read B, the replacement stays in A). Staff of B
# alone (returns:manage and orders:approve, assigned to B) pass the
# original's warehouse but not the replacement's.
#
#   1. For release early, Cancel replacement, Change, Close the rest and the
#      RMA cancel: a holder session keeps the RMA row FOR UPDATE for 3 s; B
#      (staff of B) calls the function and is refused 42501 warehouse_write
#      in well under the hold (no wait, no 55P03). Before S7a, B waited on
#      the RMA row and then went through (release early) or was refused only
#      after both locks (the others).
#   2. The same with the live replacement row held instead (the second lock
#      every one of them takes): refused at once.
#   3. Control: the same hold on the RMA row, and someone who writes both
#      warehouses calls the function: they wait for the holder, then the
#      call goes through (Change moves the replacement to an item of B,
#      where the original now is).
#   4. No session ever sees 40001, 40P01 or 55P03, and holdings equal stock
#      on record for every fixture item.
#
# Runs against a LOCAL stack only (CONTAINER, default the dev stack's
# supabase_db_stockpilot; the migration scratch stack is supabase_db_spmig).
# Fixtures are committed under the 04251111-... namespace and removed at the
# start, at the end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0425_replacement_warehouse_gate_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04251111-0000-0000-0000-00000000000a'
MGR='04251111-0000-0000-0000-0000000000a1'
STFB='04251111-0000-0000-0000-0000000000a2'
STFAB='04251111-0000-0000-0000-0000000000a3'
WHA='04251111-0000-0000-0000-0000000000b1'
WHB='04251111-0000-0000-0000-0000000000b2'
RA1='04251111-0000-0000-0000-000000000c31'
RA2='04251111-0000-0000-0000-000000000c12'
RB1='04251111-0000-0000-0000-000000000c41'
GRP='04251111-0000-0000-0000-000000000a01'
# The returned item (M), its group sibling (L, the replacement), one part
# item (1 in stock) for the backorder Close the rest needs, and an item of B.
IM='04251111-0000-0000-0000-0000000000e1'
IL='04251111-0000-0000-0000-0000000000e2'
IP='04251111-0000-0000-0000-0000000000f1'
IB='04251111-0000-0000-0000-0000000000f2'
USERS="'$MGR','$STFB','$STFAB'"
FNS=(release cancel_repl change rest cancel_rma)

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '04251111-0000-4000-8000-%012d' "$1"; }
order_of() { printf '04251111-0000-0000-0000-0000000001%02d' "$1"; }
line_of()  { printf '04251111-0000-0000-0000-0000000002%02d' "$1"; }

rl_of()     { q "select id from public.return_lines where return_id = '$1'"; }
xl_of()     { q "select id from public.return_exchange_lines where return_id = '$1'"; }
repl_of()   { q "select coalesce((select id::text from public.order_requests where replacement_for_return_id = '$1' and status not in ('cancelled', 'denied')), 'none')"; }
rev_of()    { q "select coalesce(max(revision), 0) from public.return_decisions where return_id = '$1' and kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled')"; }

body_ex() { printf '{"reasonCode":"other","lines":[{"orderRequestLineId":"%s","quantity":%s,"disposition":"restock","exchange":{"itemId":"%s"}}]}' "$1" "$2" "$3"; }
dec_ex()  { printf '{"lines":[{"returnLineId":"%s","disposition":"restock","restock":{"target":"staging"}}],"exchange":[{"action":"approve","exchangeLineId":"%s"}]%s}' "$1" "$2" "${3:-}"; }

wait_for() {
  local _ cond="application_name = '$1' and wait_event_type = '$2'"
  if [ -n "${3:-}" ]; then cond="$cond and wait_event = '$3'"; fi
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where $cond")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.idempotency_keys where organization_id = '$ORG';
delete from public.stock_reservations where organization_id = '$ORG';
with r as (delete from public.returns where organization_id = '$ORG' returning 1),
     l as (delete from public.order_request_lines
            where order_request_id in (select id from public.order_requests where organization_id = '$ORG') returning 1),
     o as (delete from public.order_requests where organization_id = '$ORG' returning 1)
select (select count(*) from r) + (select count(*) from l) + (select count(*) from o);
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.returns where organization_id = '$ORG') + (select count(*) from public.return_decisions where organization_id = '$ORG') + (select count(*) from public.stock_movements where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from auth.users where id in ($USERS))")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
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

if [ "$(q "select count(*) from pg_proc where proname = 'close_return_replacement_rest' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "returns RX-4 (0397) is not applied on this stack"; exit 1
fi
echo "stack: S7a gate helper present: $(q "select count(*) from pg_proc where proname = '_return_replacement_warehouse_gate'"); release_return_replacement_early md5 $(q "select md5(prosrc) from pg_proc where proname = 'release_return_replacement_early'")"

# as_role <application_name|-> <role> <user|-> <statements> [end]: one
# transaction as that role (claims set for a user), end commit or rollback.
as_role() {
  local app="$1" role="$2" sub="$3" body="$4" end="${5:-commit}"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "set local role $role;" \
    "set local \"request.jwt.claim.role\" to '$role';" \
    "$( [ "$sub" != "-" ] && printf "set local \"request.jwt.claim.sub\" to '%s';" "$sub")" \
    "$body" \
    "$end;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
as_user() { as_role "$1" authenticated "$2" "$3" "${4:-commit}"; }

# ═══ Fixture ══════════════════════════════════════════════════════════════
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',   '0425-2s-mgr@0425.test',   '{}'::jsonb),
  ('$STFB',  '0425-2s-stfb@0425.test',  '{}'::jsonb),
  ('$STFAB', '0425-2s-stfab@0425.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0425 Two Session Org', '0425-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$STFB', 'staff', now()),
  ('$ORG', '$STFAB', 'staff', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  ('$ORG', 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values
  ('$WHA', '$ORG', '0425 2S Main',   'WH-0425-2SA', 'active'),
  ('$WHB', '$ORG', '0425 2S Second', 'WH-0425-2SB', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary, charter_id) values
  ('$ORG', '$STFB',  '$WHB', true,  null),
  ('$ORG', '$STFAB', '$WHA', true,  null),
  ('$ORG', '$STFAB', '$WHB', false, null);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  ('$ORG', '$STFB',  'returns:manage', true),
  ('$ORG', '$STFB',  'orders:approve', true),
  ('$ORG', '$STFAB', 'returns:manage', true),
  ('$ORG', '$STFAB', 'orders:approve', true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  ('$RA1', '$ORG', '$WHA', '31-C', 'shelf', 'rack', now() - interval '30 minutes'),
  ('$RA2', '$ORG', '$WHA', '12-B', 'shelf', 'rack', now() - interval '29 minutes'),
  ('$RB1', '$ORG', '$WHB', '41-A', 'shelf', 'rack', now() - interval '28 minutes');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status) values
  ('$GRP', '$ORG', '2S Guard Shirt', '0425-2s|guard shirt', 'each', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id, group_id, variant_size, variant_key) values
  ('$IM', '$ORG', '$WHA', '0425-2S-M', '2S shirt',      40, 'active', 'none', '$RA1', '$GRP', 'M', 'M'),
  ('$IL', '$ORG', '$WHA', '0425-2S-L', '2S shirt',      20, 'active', 'none', '$RA2', '$GRP', 'L', 'L'),
  ('$IP', '$ORG', '$WHA', '0425-2S-P', '2S part',        1, 'active', 'none', '$RA2', null, null, null),
  ('$IB', '$ORG', '$WHB', '0425-2S-B', '2S shirt of B', 10, 'active', 'none', '$RB1', null, null, null);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$(order_of 1)', '$ORG', '$WHA', 'completed', 'internal', '$MGR', 'pickup'),
  ('$(order_of 2)', '$ORG', '$WHA', 'completed', 'internal', '$MGR', 'pickup'),
  ('$(order_of 3)', '$ORG', '$WHA', 'completed', 'internal', '$MGR', 'pickup'),
  ('$(order_of 4)', '$ORG', '$WHA', 'completed', 'internal', '$MGR', 'pickup'),
  ('$(order_of 5)', '$ORG', '$WHA', 'completed', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  ('$(line_of 1)', '$(order_of 1)', '$IM', 4, 4),
  ('$(line_of 2)', '$(order_of 2)', '$IM', 4, 4),
  ('$(line_of 3)', '$(order_of 3)', '$IM', 4, 4),
  ('$(line_of 4)', '$(order_of 4)', '$IM', 4, 4),
  ('$(line_of 5)', '$(order_of 5)', '$IM', 4, 4);
SQL
then
  echo "fixture setup failed"; exit 1
fi

jget() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "null")
out = []
for path in sys.argv[1:]:
    v = d
    for part in path.split("."):
        v = v.get(part) if isinstance(v, dict) else None
    out.append("-" if v is None else json.dumps(v) if isinstance(v, bool) else str(v))
print("/".join(out))
' "$@"
}

# exchange <n>: an RMA of 1 unit of original n for L, approved: its
# replacement approved in A, holding one L. Sets R.
exchange() {
  as_user - "$MGR" "select 'R=' || public.create_return_request('$(order_of "$1")', '$(body_ex "$(line_of "$1")" 1 "$IL")'::jsonb, '$(key "$1")')::text;" > "$TMP/mk.$1.out"
  R="$(sed -n 's/^R=//p' "$TMP/mk.$1.out" | jget returnId)"
  as_user - "$MGR" "select 'R=' || public.approve_return('$R', 0, '$(dec_ex "$(rl_of "$R")" "$(xl_of "$R")")'::jsonb, false)::text;" > "$TMP/ap.$1.out"
  check "set up $1 (an exchange approved: its replacement approved)" "$(q "select status from public.order_requests where id = '$(repl_of "$R")'")" "approved"
}
# part_handed_over <n>: an RMA of 2 units of original n for the part item (1
# in stock), approved on backorder, released early, picked, staged and signed
# (backordered: 1 handed over), then received: Close the rest's state. Sets R.
part_handed_over() {
  as_user - "$MGR" "select 'R=' || public.create_return_request('$(order_of "$1")', '$(body_ex "$(line_of "$1")" 2 "$IP")'::jsonb, '$(key "$1")')::text;" > "$TMP/mk.$1.out"
  R="$(sed -n 's/^R=//p' "$TMP/mk.$1.out" | jget returnId)"
  as_user - "$MGR" "select 'R=' || public.approve_return('$R', 0, '$(dec_ex "$(rl_of "$R")" "$(xl_of "$R")" ',"replacement":{"whenShort":"backorder"}')'::jsonb, false)::text;" > "$TMP/ap.$1.out"
  local o; o="$(repl_of "$R")"
  as_user - "$MGR" "select 'R=' || public.release_return_replacement_early('$R', '$o', 'Customer is completing an in-person exchange today.')::text;" > "$TMP/rel.$1.out"
  as_user - "$MGR" "update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = auth.uid() where id = '$o' and status = 'approved';
select 'P=' || (public.complete_picking('$o')).status;
select 'P=' || (public.generate_order_packing_slips('$o')).status;
update public.order_requests set status = 'staged_for_pickup', staged_by = auth.uid() where id = '$o';
select 'P=' || (public.confirm_physical_signature('$o', 'Race tester')).status;
select 'P=' || ((public.receive_return('$R'))->>'status');" > "$TMP/prep.$1.out"
  check "set up $1 (picked, packed, signed: backordered; the RMA received)" \
    "$(sed -n 's/^P=//p' "$TMP/prep.$1.out" | tr '\n' '/')" "picking_complete/packing_slip_generated/backordered/received/"
}

# The call under test for function <fn> on RMA <rma>.
call_sql() {
  local fn="$1" rma="$2"
  case "$fn" in
    release)     printf "select 'R=' || public.release_return_replacement_early('%s', '%s', 'Race release')::text;" "$rma" "$(repl_of "$rma")" ;;
    cancel_repl) printf "select 'R=' || public.cancel_return_replacement('%s', %s, 'Race cancel', null)::text;" "$rma" "$(rev_of "$rma")" ;;
    change)      printf "select 'R=' || public.change_return_replacement('%s', %s, '[{\"exchangeLineId\":\"%s\",\"itemId\":\"%s\"}]'::jsonb, 'Race change', 'refuse', null)::text;" "$rma" "$(rev_of "$rma")" "$(xl_of "$rma")" "$IB" ;;
    rest)        printf "select 'R=' || public.close_return_replacement_rest('%s', %s, 'Race close', null)::text;" "$rma" "$(rev_of "$rma")" ;;
    cancel_rma)  printf "select 'R=' || public.cancel_return('%s', %s, 'Race cancel return')::text;" "$rma" "$(rev_of "$rma")" ;;
  esac
}

# hold_then <tag> <row sql> <caller> <call sql>: a holder session (the
# superuser) keeps one row FOR UPDATE for 3 s; once it sits in pg_sleep, the
# caller runs. Records how long the caller took.
hold_then() {
  local tag="$1" row="$2" who="$3" call="$4"
  ( printf '%s\n' "set application_name to '0425-hold-$tag';" "begin;" "$row" "select pg_sleep(3);" "commit;" \
      | "${PSQL[@]}" > "$TMP/$tag.A.out" 2>&1 ) &
  local pid=$!
  wait_for "0425-hold-$tag" Timeout PgSleep || bad "$tag: the holder never reached its pg_sleep"
  local t0; t0=$(now_ms)
  as_user - "$who" "$call" > "$TMP/$tag.B.out"
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
refused_gate() { # refused_gate <tag>: 1/1 when the caller got 42501 warehouse_write from a warehouse gate
  printf '%s/%s' "$(grep -c "ERROR:  42501: warehouse_write" "$TMP/$1.B.out")" "$(grep -c "HINT:  warehouse_write" "$TMP/$1.B.out")"
}
fast() { # fast <tag> <label>: the caller never queued on the held row
  local w; w="$(cat "$TMP/$1.waited")"
  if [ "$w" -lt 1000 ]; then ok "$2: answered without waiting for the holder ($w ms)"; else bad "$2: waited for the holder ($w ms)"; fi
}
waited() { # waited <tag> <label>
  local w; w="$(cat "$TMP/$1.waited")"
  if [ "$w" -ge 1500 ]; then ok "$2: waited for the holder ($w ms)"; else bad "$2: did not wait ($w ms)"; fi
}

# ═══ The five RMAs, then the move ═════════════════════════════════════════
# RMAS[i] is the RMA for FNS[i] (an indexed array: macOS ships bash 3.2).
RMAS=()
exchange 1;         RMAS[0]="$R"
exchange 2;         RMAS[1]="$R"
exchange 3;         RMAS[2]="$R"
part_handed_over 4; RMAS[3]="$R"
exchange 5;         RMAS[4]="$R"
q "update public.order_requests set warehouse_id = '$WHB'
    where id in ('$(order_of 1)', '$(order_of 2)', '$(order_of 3)', '$(order_of 4)', '$(order_of 5)')" >/dev/null
check "every original moved to B; every replacement still in A" \
  "$(q "select count(*) filter (where o.warehouse_id = '$WHB' and o.replacement_for_return_id is null)
                || '/' || count(*) filter (where o.warehouse_id = '$WHA' and o.replacement_for_return_id is not null
                                           and o.status not in ('cancelled', 'denied'))
          from public.order_requests o where o.organization_id = '$ORG'")" "5/5"

for i in 0 1 2 3 4; do
  fn="${FNS[$i]}"; r="${RMAS[$i]}"; o="$(repl_of "$r")"
  echo "== $fn: staff of B, with the RMA row held"
  hold_then "$fn-rma" "select 1 from public.returns where id = '$r' for update;" "$STFB" "$(call_sql "$fn" "$r")"
  check "1 $fn: refused 42501 warehouse_write by the replacement's warehouse" "$(refused_gate "$fn-rma")" "1/1"
  fast "$fn-rma" "1 $fn"
  echo "== $fn: staff of B, with the replacement row held"
  hold_then "$fn-repl" "select 1 from public.order_requests where id = '$o' for update;" "$STFB" "$(call_sql "$fn" "$r")"
  check "2 $fn: refused 42501 warehouse_write by the replacement's warehouse" "$(refused_gate "$fn-repl")" "1/1"
  fast "$fn-repl" "2 $fn"
  echo "== $fn: control, someone who writes both warehouses, with the RMA row held"
  hold_then "$fn-ctl" "select 1 from public.returns where id = '$r' for update;" "$STFAB" "$(call_sql "$fn" "$r")"
  check "3 $fn: the call goes through" "$(sed -n 's/^R=//p' "$TMP/$fn-ctl.B.out" | jget changed)" "true"
  waited "$fn-ctl" "3 $fn"
done

# ═══ 4. Never 40001, 40P01 or 55P03; holdings equal stock on record ══════
echo "== 4. never 40001, 40P01 or 55P03; holdings equal stock on record"
if grep -l -E 'ERROR:  (40001|40P01|55P03)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "4: a session saw 40001, 40P01 or 55P03: $(grep -l -E 'ERROR:  (40001|40P01|55P03)' "$TMP"/*.out | tr '\n' ' ')"
else
  ok "4: no 40001, 40P01 or 55P03 in any session"
fi
check "4: holdings equal stock on record for every fixture item" \
  "$(q "select count(*) from public.inventory_items i where i.organization_id = '$ORG' and i.quantity_on_hand <> (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = i.id)")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
