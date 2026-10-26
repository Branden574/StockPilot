#!/usr/bin/env bash
#
# Two-session proof for migration 0413 (ordering visibility) and exchanges
# (design 6.6). An exchange that staff approved in an earlier transaction is
# a commitment: hiding its item from ordering must not stop the replacement
# from being re-issued, in either commit order, while a NEW staff selection
# of the hidden item is refused.
#
#   1. Hide holds first. A manager hides the approved replacement item and
#      keeps the transaction open; another manager re-issues a cancelled
#      replacement for that item (change_return_replacement with no change):
#      it waits on the item's row lock (the exchange writers lock every item
#      FOR UPDATE in id order), then re-issues once the hide commits. One live
#      replacement order with a line for the hidden item.
#   2. Re-issue holds first. The re-issue keeps its transaction open; the
#      hide waits on the item, then commits after it. Both succeed: one live
#      replacement for the item, and the item hidden.
#   3. A new selection of the hidden item (an exchange on another order, which
#      has no approved commitment for it) is refused exchange_item_not_eligible,
#      and staff candidates no longer offer it.
#   4. No session ever sees 40001 or 40P01; no replacement order without a
#      line.
#
# LOCAL stack only (CONTAINER, default supabase_db_stockpilot; the migration
# scratch stack is supabase_db_spmig) with 0413 applied. Fixtures are
# committed under the 04135555-... namespace and removed at the start, at the
# end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0413_exchange_reissue_vs_hide.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04135555-0000-0000-0000-00000000000a'
MGR='04135555-0000-0000-0000-0000000000a1'
MGR2='04135555-0000-0000-0000-0000000000a2'
WH='04135555-0000-0000-0000-0000000000b1'
R1='04135555-0000-0000-0000-000000000c31'
R2='04135555-0000-0000-0000-000000000c32'
IM='04135555-0000-0000-0000-0000000000e1'
IL='04135555-0000-0000-0000-0000000000e2'
IS='04135555-0000-0000-0000-0000000000e3'
ORDER='04135555-0000-0000-0000-000000000101'
ORDER3='04135555-0000-0000-0000-000000000103'
L='04135555-0000-0000-0000-000000000201'
L3='04135555-0000-0000-0000-000000000204'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
key() { printf '04136666-0000-4000-8000-%012d' "$1"; }
op()  { printf '04137777-0000-4000-8000-%012d' "$1"; }

live_count() { q "select count(*) from public.order_requests where replacement_for_return_id = '$1' and status not in ('cancelled', 'denied')"; }
live_item()  { q "select coalesce(string_agg(l.item_id::text, ','), 'none') from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id where o.replacement_for_return_id = '$1' and o.status not in ('cancelled', 'denied')"; }
rl_of() { q "select id from public.return_lines where return_id = '$1'"; }
xl_of() { q "select id from public.return_exchange_lines where return_id = '$1'"; }
has() { if [[ ",$1," == *",$2,"* ]]; then echo "$3"; else echo "$4"; fi; } # has <csv> <id> <yes> <no>
visible_of() { q "select order_catalog_visible::text from public.inventory_items where id = '$1'"; }

body_ex() { printf '{"reasonCode":"other","lines":[{"orderRequestLineId":"%s","quantity":1,"disposition":"restock","exchange":{"itemId":"%s"}}]}' "$1" "$2"; }
dec_ex()  { printf '{"lines":[{"returnLineId":"%s","disposition":"restock","restock":{"target":"staging"}}],"exchange":[{"action":"approve","exchangeLineId":"%s"}],"replacement":{"whenShort":"refuse"}}' "$1" "$2"; }
create_sql()  { printf "select 'R=' || public.create_return_request('%s', '%s'::jsonb, '%s')::text;" "$1" "$(body_ex "$3" "$4")" "$2"; }
approve_sql() { printf "select 'R=' || public.approve_return('%s', %s, '%s'::jsonb, false)::text;" "$1" "$2" "$3"; }
cancel_repl_sql() { printf "select 'R=' || public.cancel_return_replacement('%s', %s, 'Race cancel replacement')::text;" "$1" "$2"; }
reissue_sql() { printf "select 'R=' || public.change_return_replacement('%s', %s, '[]'::jsonb, 'Issue it again', 'refuse')::text;" "$1" "$2"; }
hide_sql()    { printf "select 'R=' || public.set_order_catalog_visibility('%s', array['%s']::uuid[], %s, '%s', 'web')::text;" "$ORG" "$1" "$2" "$3"; }

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

as_user() {
  local app="$1" sub="$2" body="$3" end="${4:-commit}"
  printf '%s\n' \
    "$( [ "$app" != "-" ] && printf "set application_name to '%s';" "$app")" \
    "begin;" \
    "set local role authenticated;" \
    "set local \"request.jwt.claim.role\" to 'authenticated';" \
    "set local \"request.jwt.claim.sub\" to '$sub';" \
    "$body" \
    "$end;" | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}
ans() { sed -n 's/^R=//p' "$1"; }
jget() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "null")
out = []
for path in sys.argv[1:]:
    v = d
    for part in path.split("."):
        v = v.get(part) if isinstance(v, dict) else None
    out.append("-" if v is None else json.dumps(v) if isinstance(v, (bool, dict, list)) else str(v))
print("/".join(out))
' "$@"
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
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.returns where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.order_requests where organization_id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() {
  wait 2>/dev/null
  cleanup >/dev/null 2>&1
  if [ -n "${KEEP_TMP:-}" ]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cleanup || exit 1

if [ "$(q "select count(*) from pg_proc where proname = 'set_order_catalog_visibility' and pronamespace = 'public'::regnamespace")" != "1" ]; then
  echo "0413 is not applied on this stack (no public.set_order_catalog_visibility)"; exit 1
fi

# ═══ Fixture: one picked and handed-over order; replacement stock on a rack ══
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0413-ex-mgr@ordvis.test',  '{}'::jsonb),
  ('$MGR2', '0413-ex-mgr2@ordvis.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0413 Exchange Org', '0413-exchange');
update public.organizations set mfa_policy = 'optional' where id = '$ORG';
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  ('$ORG', 'returns', true, 'optional', '{}'::jsonb),
  ('$ORG', 'orders', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0413 EX Main', 'WH-0413-EX', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  ('$R1', '$ORG', '$WH', '31-C', 'shelf', 'rack', now() - interval '30 minutes'),
  ('$R2', '$ORG', '$WH', '12-B', 'shelf', 'rack', now() - interval '29 minutes');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id) values
  ('$IM', '$ORG', '$WH', '0413-EX-M', 'EX shirt M', 20, 'active', 'none', '$R1'),
  ('$IL', '$ORG', '$WH', '0413-EX-L', 'EX shirt L', 30, 'active', 'none', '$R2'),
  ('$IS', '$ORG', '$WH', '0413-EX-S', 'EX shirt S', 30, 'active', 'none', '$R2');
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  ('$ORDER', '$ORG', '$WH', 'pick_slip_generated', 'internal', '$MGR', 'pickup'),
  ('$ORDER3', '$ORG', '$WH', 'completed', 'internal', '$MGR', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  ('$L', '$ORDER', '$IM', 12, 0),
  ('$L3', '$ORDER3', '$IM', 2, 2);
SQL
then
  echo "fixture setup failed"; exit 1
fi
as_user - "$MGR" "select 'P=' || (public.complete_picking('$ORDER')).status;" > "$TMP/pick.out"
q "update public.order_requests set status = 'packing_slip_generated' where id = '$ORDER'" >/dev/null
q "update public.order_requests set status = 'staged_for_pickup' where id = '$ORDER'" >/dev/null
as_user - "$MGR" "select 'P=' || (public.confirm_physical_signature('$ORDER', 'Race tester')).status;" > "$TMP/sign.out"
if [ "$(sed -n 's/^P=//p' "$TMP/pick.out")/$(sed -n 's/^P=//p' "$TMP/sign.out")" != "picking_complete/completed" ]; then
  echo "fixture: the pick or the hand-over failed:"; cat "$TMP/pick.out" "$TMP/sign.out"; exit 1
fi

# cancelled_commitment <n>: an exchange RMA (M for L) approved in its own
# transaction (the commitment), its replacement then cancelled in another;
# sets R and REV (the revision a re-issue names).
N=0
cancelled_commitment() {
  N=$((N + 1))
  as_user - "$MGR" "$(create_sql "$ORDER" "$(key "$1")" "$L" "$IL")" > "$TMP/new.$N.out"
  R="$(ans "$TMP/new.$N.out" | jget returnId)"
  as_user - "$MGR" "$(approve_sql "$R" 0 "$(dec_ex "$(rl_of "$R")" "$(xl_of "$R")")")" > "$TMP/ap.$N.out"
  as_user - "$MGR" "$(cancel_repl_sql "$R" 1)" > "$TMP/cr.$N.out"
  REV="$(ans "$TMP/cr.$N.out" | jget revision)"
  check "setup $1: approved, then its replacement cancelled (no live replacement)" \
    "$(ans "$TMP/ap.$N.out" | jget status)/$(ans "$TMP/cr.$N.out" | jget changed)/$(live_count "$R")/$(q "select status from public.return_exchange_lines where return_id = '$R'")" \
    "approved/true/0/cancelled"
}

# ═══ 1. Hide holds first ═══════════════════════════════════════════════════
echo "== 1. a hide of the approved replacement item holds; a re-issue waits, then re-issues"
cancelled_commitment 1
RA="$R"; REVA="$REV"
as_user h1 "$MGR" "$(hide_sql "$IL" false "$(op 1)") select pg_sleep(2);" > "$TMP/1.h.out" &
HP=$!
wait_for h1 Timeout PgSleep || bad "1: the hide never reached its pause"
as_user r1 "$MGR2" "$(reissue_sql "$RA" "$REVA")" > "$TMP/1.r.out" &
RP=$!
if wait_for r1 Lock; then ok "1: the re-issue waits on the item lock while the hide is open"; else bad "1: the re-issue never waited"; fi
wait "$HP" "$RP"
check "1: the hide changed the item" "$(ans "$TMP/1.h.out" | jget changed)" "[\"$IL\"]"
check "1: then the re-issue succeeded (mode reissue)" "$(ans "$TMP/1.r.out" | jget changed mode)" "true/reissue"
check "1: one live replacement, its line for the hidden item" "$(live_count "$RA")/$(live_item "$RA")/$(visible_of "$IL")" "1/$IL/false"

# ═══ 2. Re-issue holds first ══════════════════════════════════════════════
echo "== 2. a re-issue holds; the hide waits, then commits after it"
as_user - "$MGR" "$(hide_sql "$IL" true "$(op 2)")" > "$TMP/2.show.out"
check "2: setup: the item shown again" "$(ans "$TMP/2.show.out" | jget changed)/$(visible_of "$IL")" "[\"$IL\"]/true"
cancelled_commitment 2
RB="$R"; REVB="$REV"
as_user r2 "$MGR2" "$(reissue_sql "$RB" "$REVB") select pg_sleep(2);" > "$TMP/2.r.out" &
RP=$!
wait_for r2 Timeout PgSleep || bad "2: the re-issue never reached its pause"
as_user h2 "$MGR" "$(hide_sql "$IL" false "$(op 3)")" > "$TMP/2.h.out" &
HP=$!
if wait_for h2 Lock; then ok "2: the hide waits on the re-issue's item lock"; else bad "2: the hide never waited"; fi
wait "$RP" "$HP"
check "2: the re-issue succeeded" "$(ans "$TMP/2.r.out" | jget changed mode)" "true/reissue"
check "2: then the hide changed the item" "$(ans "$TMP/2.h.out" | jget changed)" "[\"$IL\"]"
check "2: one live replacement, its line for the now-hidden item" "$(live_count "$RB")/$(live_item "$RB")/$(visible_of "$IL")" "1/$IL/false"

# ═══ 3. A new selection of the hidden item ════════════════════════════════
echo "== 3. a new staff selection of the hidden item is refused"
as_user - "$MGR" "$(create_sql "$ORDER3" "$(key 9)" "$L3" "$IL")" > "$TMP/3.c.out"
if grep -q '^R=' "$TMP/3.c.out"; then
  RC="$(ans "$TMP/3.c.out" | jget returnId)"
  as_user - "$MGR" "$(approve_sql "$RC" 0 "$(dec_ex "$(rl_of "$RC")" "$(xl_of "$RC")")")" > "$TMP/3.a.out"
  check "3: the request is recorded, the approval (the new selection) is refused exchange_item_not_eligible" \
    "$(grep -c 'HINT:  exchange_item_not_eligible' "$TMP/3.a.out")/$(live_count "$RC")" "1/0"
else
  check "3: the request naming the hidden item is refused exchange_item_not_eligible" \
    "$(grep -c 'HINT:  exchange_item_not_eligible' "$TMP/3.c.out")" "1"
fi
as_user - "$MGR" "select 'R=' || coalesce((select string_agg(s->>'itemId', ',' order by s->>'itemId') from jsonb_array_elements(public.return_exchange_candidates('$ORDER3', '$L3', 'EX shirt', 30)->'matches') s), '');" > "$TMP/3.cand.out"
CAND="$(ans "$TMP/3.cand.out")"
check "3: a staff search on the other order offers the shown record and not the hidden one" \
  "$(has "$CAND" "$IS" shown no-shown)/$(has "$CAND" "$IL" hidden-offered hidden-absent)" "shown/hidden-absent"

# ═══ 4. Never 40001 / 40P01, no empty replacement ═════════════════════════
echo "== 4. no retryable class, no empty replacement"
if grep -lE 'ERROR:  (40001|40P01)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "4: some session saw 40001 or 40P01"
else
  ok "4: no session saw 40001 or 40P01"
fi
check "4: no order without a line" \
  "$(q "select count(*) from public.order_requests r where r.organization_id = '$ORG' and not exists (select 1 from public.order_request_lines l where l.order_request_id = r.id)")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
exit $(( FAILS > 0 ))
