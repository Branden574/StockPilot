#!/usr/bin/env bash
#
# Two-session proof for migration 0385 (F2-5, draft_order_shortfall_pos).
# pgTAP runs in ONE session, so it cannot show what happens when two buyers
# (or a buyer and the daily auto-reorder) draft the same shortfall at the same
# moment.
#
#   1. Two buyers draft the same order's whole shortfall (10) with different
#      idempotency keys. Session A drafts and keeps its transaction open;
#      session B meanwhile waits on the reorder drafts' advisory lock, then
#      recomputes in a snapshot that sees A's draft: B is refused with P0001
#      shortfall_changed, detail {item: 0}, and writes nothing. Exactly one PO
#      line exists for the item.
#   2. The same race against a COPY of the function with the advisory lock
#      taken out (a throwaway public._probe_shortfall_nolock, dropped by the
#      EXIT trap however the script ends; its PO numbers are made unique so
#      the unique PO-number index cannot stand in for the lock): B reads
#      before A commits and drafts the same 10 again. Two PO lines, 20
#      units for a shortfall of 10: the mutation the lock exists for.
#   3. A reorder draft racing a shortfall draft, both orders:
#      a. shortfall first: the reorder draft (save_purchase_order_draft with
#         p_skip_items_on_open_po, the "Draft PO from suggestions" path) waits
#         on the same lock, then leaves the item off (it is on the shortfall's
#         draft): id null, skipped_item_ids [item];
#      b. reorder first (4 of a shortfall of 10): the shortfall draft of 10
#         waits, then is refused with shortfall_changed, detail {item: 6}.
#      No item is drafted twice.
#   4. The same key twice at once (a double tap): B waits on A's key row, then
#      answers A's result (replay: true, the same PO) and writes nothing.
#   No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03851111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0385_shortfall_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
# Section 2 creates a throwaway SECURITY INVOKER copy of the real function
# with its lock taken out, executable by authenticated. The EXIT trap drops it
# however the script ends (a failure, Ctrl-C, SIGTERM, a harness timeout;
# bash runs it on INT, TERM and HUP), so an interrupted run never leaves it on
# the shared local stack. SIGKILL cannot be trapped: the next run's cleanup
# drops it first.
# shellcheck disable=SC2329 # called from the EXIT trap below
drop_probes() {
  "${PSQL[@]}" -c "drop function if exists public._probe_shortfall_nolock(uuid, jsonb, text)" >/dev/null 2>&1
}
trap 'drop_probes; rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

ORG='03851111-0000-0000-0000-00000000000a'
MGR='03851111-0000-0000-0000-0000000000a1'
MGR2='03851111-0000-0000-0000-0000000000a2'
WH='03851111-0000-0000-0000-0000000000b1'
SUP='03851111-0000-0000-0000-0000000000c1'
I1='03851111-0000-0000-0000-000000000f01'
I2='03851111-0000-0000-0000-000000000f02'
I3='03851111-0000-0000-0000-000000000f03'
I4='03851111-0000-0000-0000-000000000f04'
I5='03851111-0000-0000-0000-000000000f05'
O1='03851111-0000-0000-0000-0000000000d1'
O2='03851111-0000-0000-0000-0000000000d2'
O3='03851111-0000-0000-0000-0000000000d3'
O4='03851111-0000-0000-0000-0000000000d4'
O5='03851111-0000-0000-0000-0000000000d5'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
# has <fixed text> <file>: how many lines carry the text (no regex, no quoting traps).
has() { grep -cF -- "$1" "$2"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
# Units of an item on this org's PO lines (every status but cancelled).
units_on_pos() {
  q "select coalesce(sum(i.quantity_ordered), 0)::int || '/' || count(*)
       from public.purchase_order_items i join public.purchase_orders p on p.id = i.purchase_order_id
      where p.organization_id = '$ORG' and p.status <> 'cancelled' and i.item_id = '$1'"
}
line() { printf '[{"item_id": "%s", "quantity": %s}]' "$1" "$2"; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_shortfall_nolock(uuid, jsonb, text);
delete from public.purchase_order_items where organization_id = '$ORG';
delete from public.purchase_orders where organization_id = '$ORG';
delete from public.idempotency_keys where organization_id = '$ORG';
delete from public.order_request_lines where order_request_id in (select id from public.order_requests where organization_id = '$ORG');
delete from public.order_requests where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.suppliers where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.purchase_orders where organization_id = '$ORG') + (select count(*) from public.order_requests where organization_id = '$ORG') + (select count(*) from public.inventory_items where organization_id = '$ORG')")"
  if [ "$left" != "0" ]; then echo "cleanup left $left fixture rows"; return 1; fi
}

cleanup || exit 1

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0385-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0385-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0385 Two Session Org', '0385-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR',  'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0385 2S Main', 'WH-0385-2S', 'active');
insert into public.suppliers (id, organization_id, name) values ('$SUP', '$ORG', '0385 2S Supplier');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, supplier_id, unit_cost)
select v.id, '$ORG', '$WH', 'X0385-2S-' || right(v.id::text, 3), '2S item ' || right(v.id::text, 3), 0, 'active', '$SUP', 1
  from (values ('$I1'::uuid), ('$I2'::uuid), ('$I3'::uuid), ('$I4'::uuid), ('$I5'::uuid)) v(id);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select v.id, '$ORG', '$WH', 'pending_approval', 'internal', '$MGR', 'pickup'
  from (values ('$O1'::uuid), ('$O2'::uuid), ('$O3'::uuid), ('$O4'::uuid), ('$O5'::uuid)) v(id);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  ('$O1', '$I1', 10), ('$O2', '$I2', 10), ('$O3', '$I3', 10), ('$O4', '$I4', 10), ('$O5', '$I5', 10);
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# race <tag> <A's statement> <B's statement>: A (the first manager) runs its
# statement and holds its transaction 3 s; B (the second manager) runs its
# statement at 1 s. Each statement's answer is printed as A=… / B=….
race() {
  local tag="$1" sa="$2" sb="$3"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR';
select 'A=' || ($sa)::text;
select pg_sleep(3);
commit;
SQL
  ) &
  local pid=$!
  sleep 1
  local t0; t0=$(now_ms)
  "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B.out" 2>&1 <<SQL
begin;
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '$MGR2';
select 'B=' || ($sb)::text;
commit;
SQL
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
draft() { # draft <fn> <order> <item> <qty> <key>
  printf "public.%s('%s', '%s'::jsonb, '%s')" "$1" "$2" "$(line "$3" "$4")" "$5"
}
reorder() { # reorder <item> <qty> <po number>
  printf "public.save_purchase_order_draft('%s', null, '%s', '%s', null, null, null, 'reorder', '[{\"item_id\": \"%s\", \"quantity_ordered\": %s, \"unit_cost\": 1}]'::jsonb, '{}'::uuid[], null, true)" \
    "$ORG" "$3" "$SUP" "$1" "$2"
}

# ═══ 1. Two buyers, the same shortfall ════════════════════════════════════
echo "== 1. two buyers draft the same order's whole shortfall at the same moment"
race real "$(draft draft_order_shortfall_pos "$O1" "$I1" 10 k-1a)" "$(draft draft_order_shortfall_pos "$O1" "$I1" 10 k-1b)"
WAITED="$(cat "$TMP/real.waited")"
check "1a: A drafted the 10" "$(has '"replay": false' "$TMP/real.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "1b: B waited for A's reorder lock ($WAITED ms)"; else bad "1b: B did not wait ($WAITED ms)"; fi
check "1c: B was refused: shortfall_changed (P0001)" "$(has 'ERROR:  P0001: shortfall_changed' "$TMP/real.B.out")" "1"
check "1d: B's refusal carries the current numbers: nothing left to draft" \
  "$(grep -F 'DETAIL:' "$TMP/real.B.out" | sed -E 's/^.*DETAIL: +//')" "{\"$I1\": 0}"
check "1e: exactly one PO line exists for the item, 10 units" "$(units_on_pos "$I1")" "10/1"
check "1f: B's key was rolled back with its refusal" \
  "$(q "select count(*) from public.idempotency_keys where organization_id = '$ORG' and key = 'k-1b'")" "0"
check "1g: no 40001 or 40P01 in either session" "$(cat "$TMP/real.A.out" "$TMP/real.B.out" | grep -cE '40001|40P01')" "0"

# ═══ 2. The mutation: no lock ═════════════════════════════════════════════
echo "== 2. the same race against a copy with the advisory lock removed"
q "select pg_get_functiondef('public.draft_order_shortfall_pos(uuid, jsonb, text)'::regprocedure)" > "$TMP/real.sql"
python3 - "$TMP/real.sql" "$TMP/nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
lock = "  perform pg_advisory_xact_lock(\n    hashtextextended('save_purchase_order_draft:reorder:' || v_org::text, 0));"
num = "    v_no := public.next_po_number(v_org);"
assert d.count(lock) == 1, d.count(lock)
assert d.count(num) == 1, d.count(num)
d = d.replace(lock, "  -- probe: no lock")
# Unique numbers, so the PO-number index cannot stand in for the lock.
d = d.replace(num, "    v_no := 'PO-PROBE-' || gen_random_uuid()::text;")
d = d.replace('public.draft_order_shortfall_pos(', 'public._probe_shortfall_nolock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/nolock.sql" || bad "2: could not create the lock-less copy"
q "revoke all on function public._probe_shortfall_nolock(uuid, jsonb, text) from public, anon; grant execute on function public._probe_shortfall_nolock(uuid, jsonb, text) to authenticated" >/dev/null
race nolock "$(draft _probe_shortfall_nolock "$O2" "$I2" 10 k-2a)" "$(draft _probe_shortfall_nolock "$O2" "$I2" 10 k-2b)"
check "2a: A drafted the 10" "$(has '"replay": false' "$TMP/nolock.A.out")" "1"
check "2b: B ALSO drafted 10 (it read the shortfall before A committed)" "$(has '"replay": false' "$TMP/nolock.B.out")" "1"
check "2c: two PO lines, 20 units, for a shortfall of 10: ordered twice" "$(units_on_pos "$I2")" "20/2"
drop_probes

# ═══ 3. A reorder draft racing a shortfall draft ══════════════════════════
echo "== 3a. shortfall draft first, a reorder draft of the same item meanwhile"
race shortfall_first "$(draft draft_order_shortfall_pos "$O3" "$I3" 10 k-3a)" "$(reorder "$I3" 7 PO-0385-2S-R1)"
check "3a-1: the shortfall draft wrote its 10" "$(has '"replay": false' "$TMP/shortfall_first.A.out")" "1"
WAITED="$(cat "$TMP/shortfall_first.waited")"
if [ "$WAITED" -ge 1500 ]; then ok "3a-2: the reorder draft waited for the shortfall's lock ($WAITED ms)"; else bad "3a-2: it did not wait ($WAITED ms)"; fi
# The expected answer in a variable: an escaped quote inside "$(...)" is
# parsed differently by bash and would make this check vacuous.
SKIPPED_ANSWER="B={\"id\": null, \"stamped\": 0, \"stamp_error\": null, \"skipped_item_ids\": [\"$I3\"]}"
check "3a-3: then it left the item off (it is on the shortfall's draft): no PO, the item skipped" \
  "$(has "$SKIPPED_ANSWER" "$TMP/shortfall_first.B.out")" "1"
check "3a-4: one PO line, 10 units" "$(units_on_pos "$I3")" "10/1"

echo "== 3b. a reorder draft of 4 first, a shortfall draft of 10 meanwhile"
race reorder_first "$(reorder "$I4" 4 PO-0385-2S-R2)" "$(draft draft_order_shortfall_pos "$O4" "$I4" 10 k-3b)"
WAITED="$(cat "$TMP/reorder_first.waited")"
check "3b-1: the reorder draft wrote its 4" "$(grep -c '^A={"id": "' "$TMP/reorder_first.A.out")" "1"
if [ "$WAITED" -ge 1500 ]; then ok "3b-2: the shortfall draft waited for the reorder lock ($WAITED ms)"; else bad "3b-2: it did not wait ($WAITED ms)"; fi
check "3b-3: then it was refused with the new number: 6 draftable" \
  "$(has 'ERROR:  P0001: shortfall_changed' "$TMP/reorder_first.B.out"),$(grep -F 'DETAIL:' "$TMP/reorder_first.B.out" | sed -E 's/^.*DETAIL: +//')" \
  "1,{\"$I4\": 6}"
check "3b-4: one PO line, the reorder's 4" "$(units_on_pos "$I4")" "4/1"
check "3-5: no 40001 or 40P01" \
  "$(cat "$TMP/shortfall_first.A.out" "$TMP/shortfall_first.B.out" "$TMP/reorder_first.A.out" "$TMP/reorder_first.B.out" | grep -cE '40001|40P01')" "0"

# ═══ 4. The same key twice at once ════════════════════════════════════════
echo "== 4. a double tap: the same key and request from two sessions at once"
race samekey "$(draft draft_order_shortfall_pos "$O5" "$I5" 10 k-4)" "$(draft draft_order_shortfall_pos "$O5" "$I5" 10 k-4)"
WAITED="$(cat "$TMP/samekey.waited")"
if [ "$WAITED" -ge 1500 ]; then ok "4a: B waited for A's key ($WAITED ms)"; else bad "4a: B did not wait ($WAITED ms)"; fi
check "4b: B answered A's result as a replay" "$(has '"replay": true' "$TMP/samekey.B.out")" "1"
A_PO="$(grep -oE '"purchaseOrderId": "[0-9a-f-]+"' "$TMP/samekey.A.out")"
B_PO="$(grep -oE '"purchaseOrderId": "[0-9a-f-]+"' "$TMP/samekey.B.out")"
check "4c: the same purchase order in both answers" "$([ -n "$A_PO" ] && [ "$A_PO" = "$B_PO" ] && echo same || echo "differ: $A_PO / $B_PO")" "same"
check "4d: one PO line, 10 units" "$(units_on_pos "$I5")" "10/1"
check "4e: no 40001 or 40P01" "$(cat "$TMP/samekey.A.out" "$TMP/samekey.B.out" | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "the probe copy is gone" "$(q "select count(*) from pg_proc where proname like '\\_probe\\_shortfall%'")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
