#!/usr/bin/env bash
#
# Two-session proof for migration 0393's capture trigger
# (trg_order_requests_signature_image_capture). confirm_order_signature
# (frozen) still writes the image onto the order row; the trigger moves it to
# order_request_secrets before the row is stored, and resume_fulfillment's
# reset clears the side copy. pgTAP runs in ONE session, so it cannot show
# what happens when two of these meet:
#
#   1. Two hand-overs of the same order with the same token at once (a double
#      tap, two devices): one records the hand-over, the other waits on the
#      row and then returns null (the order is signed); exactly one image is
#      in the side table (the winner's), and none on the row.
#   2. A hand-over that leaves units owed (backordered) holding its
#      transaction while resume_fulfillment waits: after both, the order is
#      back to the pick slip with signed_at null, and its side image is gone
#      with it (no image survives a reset hand-over).
#   3. The return prompt's order_return_token_ensure on an order whose
#      hand-over is in progress (the capture trigger is updating the order's
#      side row under the hand-over's FOR UPDATE): ensure waits for the
#      hand-over's side row, then answers; neither side sees 40P01. (Every
#      signable order has a side row since 0392 (its signature token), so the
#      capture's write is an UPDATE of that row: the shape tested here. A
#      signable order without one, whose hand-over and ensure would each hold
#      what the other needs, does not exist: 0392's R5 and its data block
#      check it.)
#   4. No session ever sees 40001 or 40P01.
#
# LOCAL stack only (docker container supabase_db_stockpilot) with 0393
# applied. Fixtures are committed under the 03933333-... namespace and removed
# at the start, at the end and by the EXIT trap. Never prints a token or an
# image: booleans, counts and statuses. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0393_capture_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='03933333-0000-0000-0000-00000000000a'
MGR='03933333-0000-0000-0000-0000000000a1'
REQ='03933333-0000-0000-0000-0000000000a2'
WH='03933333-0000-0000-0000-0000000000b1'
ITEM='03933333-0000-0000-0000-0000000000c1'
O1='03933333-0000-0000-0000-0000000000d1'
O2='03933333-0000-0000-0000-0000000000d2'
O3='03933333-0000-0000-0000-0000000000d3'
L2='03933333-0000-0000-0000-0000000000e2'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
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
wait_blocked() {
  local _
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
# The order row's image, and the side table's, as booleans only.
images() { q "select (o.signature_data_url is null)::text || '/' || coalesce((s.signature_data_url is not null)::text, 'no side row') || '/' || (o.signed_at is not null)::text from public.order_requests o left join public.order_request_secrets s on s.order_request_id = o.id where o.id = '$1'"; }
side_image_is() { q "select (signature_data_url = 'data:image/png;base64,' || repeat('$2', 200))::text from public.order_request_secrets where order_request_id = '$1'"; }

cleanup_rows() {
  "${PSQL[@]}" >/dev/null 2>&1 <<SQL
delete from public.stock_reservations where organization_id = '$ORG';
delete from public.order_requests where organization_id = '$ORG';
delete from public.inventory_items where organization_id = '$ORG';
delete from public.notifications where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$REQ');
SQL
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  wait 2> /dev/null
  cleanup_rows
  rm -rf "$TMP"
}
trap cleanup EXIT

HAS="$(q "select count(*) from pg_trigger where tgname = 'trg_order_requests_signature_image_capture'")"
[ "$HAS" = "1" ] || { echo "needs 0393 on the local stack"; exit 1; }
cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR', '0393-race-mgr@test.local', '{}'::jsonb),
  ('$REQ', '0393-race-req@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0393 Race Org', '0393-race');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$REQ', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0393 Race Main', 'WH-0393-RC', 'active');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values ('$ITEM', '$ORG', '$WH', '0393-RACE', 'Race item', 30, 'active', 'none');
-- Each signable order is shaped as 0389's mint leaves it: the column holds
-- sha256 of the side table's raw token.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, approved_by, approved_at,
   signature_token, signature_token_expires_at) values
  ('$O1', '$ORG', '$WH', 'staged_for_pickup', 'internal', '$REQ', 'pickup', '$MGR', now(),
   encode(extensions.digest(repeat('6a', 32), 'sha256'), 'hex'), now() + interval '1 day'),
  ('$O2', '$ORG', '$WH', 'staged_for_pickup', 'internal', '$REQ', 'pickup', '$MGR', now(),
   encode(extensions.digest(repeat('6b', 32), 'sha256'), 'hex'), now() + interval '1 day'),
  ('$O3', '$ORG', '$WH', 'staged_for_pickup', 'internal', '$REQ', 'pickup', '$MGR', now(),
   encode(extensions.digest(repeat('6c', 32), 'sha256'), 'hex'), now() + interval '1 day');
insert into public.order_request_secrets (order_request_id, organization_id, signature_token) values
  ('$O1', '$ORG', repeat('6a', 32)),
  ('$O2', '$ORG', repeat('6b', 32)),
  ('$O3', '$ORG', repeat('6c', 32));
-- O2 owes units after the hand-over (10 requested, 4 picked): it forks to backordered.
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values ('$L2', '$O2', '$ITEM', 10, 0, 4);
SQL

handover() { # handover <label> <order> <raw pair> <image char> <hold seconds>
  printf "set application_name = '0393-race-%s';\nbegin;\nset local role service_role;\nselect 'H=' || coalesce(public.confirm_order_signature('%s', encode(extensions.digest(repeat('%s', 32), 'sha256'), 'hex'), 'Pat Signer', 'pat@example.com', 'data:image/png;base64,' || repeat('%s', 200))::text, 'null');\nselect pg_sleep(%s);\ncommit;\n" \
    "$1" "$2" "$3" "$4" "$5" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$1.out" 2>&1
}

# ── 1. Two hand-overs of one order with one token ────────────────────────
handover 1a "$O1" 6a A 2 &
P1=$!
if wait_sleeping 0393-race-1a; then
  handover 1b "$O1" 6a B 0 &
  P2=$!
  if wait_blocked 0393-race-1b; then ok "1: the second hand-over waits on the first's row lock"; else bad "1: the second hand-over never waited"; fi
  wait "$P1"; wait "$P2"
  check "1: the first records the hand-over" "$(grep -c "^H=$ORG$" "$TMP/1a.out")" "1"
  check "1: the second finds the order signed and records nothing" "$(grep -c '^H=null$' "$TMP/1b.out")" "1"
  check "1: no image on the row; one in the side table; signed" "$(images "$O1")" "true/true/true"
  check "1: the side image is the winner's" "$(side_image_is "$O1" A)" "true"
else
  bad "1: the first hand-over never reached pg_sleep: $(tr '\n' ' ' < "$TMP/1a.out" | cut -c1-300)"
  wait "$P1"
fi

# ── 2. A backordering hand-over holding while resume_fulfillment waits ───
handover 2a "$O2" 6b C 2 &
P1=$!
if wait_sleeping 0393-race-2a; then
  printf "set application_name = '0393-race-2b';\nbegin;\nset local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\nselect 'R=' || r.status from public.resume_fulfillment('%s') r;\ncommit;\n" "$MGR" "$O2" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2b.out" 2>&1 &
  P2=$!
  if wait_blocked 0393-race-2b; then ok "2: resume_fulfillment waits on the hand-over's row lock"; else bad "2: resume_fulfillment never waited"; fi
  wait "$P1"; wait "$P2"
  check "2: the hand-over recorded a partial hand-over" "$(grep -c "^H=$ORG$" "$TMP/2a.out")" "1"
  check "2: resume then reopened the pick" "$(grep -c '^R=pick_slip_generated$' "$TMP/2b.out")" "1"
  check "2: no image on the row, none left in the side table, signed_at reset" "$(images "$O2")" "true/false/false"
else
  bad "2: the hand-over never reached pg_sleep: $(tr '\n' ' ' < "$TMP/2a.out" | cut -c1-300)"
  wait "$P1"
fi

# ── 3. The return prompt's mint while a hand-over holds the side row ─────
handover 3a "$O3" 6c D 2 &
P1=$!
if wait_sleeping 0393-race-3a; then
  printf "set application_name = '0393-race-3b';\nset role service_role;\nselect 'E=' || (public.order_return_token_ensure('%s') is not null)::text;\n" "$O3" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3b.out" 2>&1 &
  P2=$!
  if wait_blocked 0393-race-3b; then ok "3: the return-token mint waits on the hand-over's side row"; else bad "3: the return-token mint never waited"; fi
  wait "$P1"; wait "$P2"
  check "3: the hand-over recorded the order" "$(grep -c "^H=$ORG$" "$TMP/3a.out")" "1"
  check "3: the return-token mint then answered a token" "$(grep -c '^E=true$' "$TMP/3b.out")" "1"
  check "3: the side row keeps the image and gains the return token" \
    "$(q "select (signature_data_url is not null)::text || '/' || (return_token is not null)::text from public.order_request_secrets where order_request_id = '$O3'")" "true/true"
else
  bad "3: the hand-over never reached pg_sleep: $(tr '\n' ' ' < "$TMP/3a.out" | cut -c1-300)"
  wait "$P1"
fi

# ── 4. No 40001 / 40P01 anywhere ─────────────────────────────────────────
if grep -lE '40P01|40001|deadlock|serialization' "$TMP"/*.out > /dev/null 2>&1; then
  bad "4: a session saw 40001/40P01: $(grep -lE '40P01|40001|deadlock|serialization' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "4: no session saw 40001 or 40P01"
fi
if grep -lE 'ERROR' "$TMP"/*.out > /dev/null 2>&1; then
  bad "4: a session reported an error: $(grep -hE 'ERROR' "$TMP"/*.out | head -n 3 | cut -c1-200 | tr '\n' ' ')"
else
  ok "4: no session reported an error"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
