#!/usr/bin/env bash
#
# Two-session proof for migration 0392 (order secrets, contract): a customer's
# hand-over, a packing-slip mint and a return-token mint racing the data move.
# pgTAP runs in ONE session, so it cannot show what happens while another
# writer holds an order row or the side table. Each case replays the
# migration's lock prelude and data block (`do $c392_lock$` and `do
# $c392_move$`, cut from the file) in session M and COMMITS it, over fixture
# orders planted fresh for the case:
#
#   1. A hand-over first: session H completes a raw-token order through
#      confirm_order_signature (the sign route's pre-0392 legacy shape) and
#      keeps its transaction open. M's NOWAIT prelude retries until H commits,
#      then applies: the order is signed, so its token is dead and is hashed in
#      place, not copied. The hand-over is recorded once; no 40P01 anywhere.
#   2. The move first: M holds its locks (EXCLUSIVE on order_requests). A
#      hand-over presenting the RAW value as the column (B's legacy branch, the
#      window between the push and the cleanup deploy) waits for M, then
#      matches nothing (the column is now the digest) and writes nothing; the
#      same hand-over with the digest (the sign route hashes a printed QR's
#      raw token) then completes. A link fails once in that window and works
#      on the retry; no 40P01.
#   3. A mint first: generate_order_packing_slips (a manager) keeps its
#      transaction open; M retries until it commits, then applies and leaves
#      the new 0389-shaped digest alone (the column is still sha256 of the side
#      token).
#   4. The move first, then a mint: the mint waits for M's lock, then mints as
#      usual; its digest and side token agree.
#   5. The move first, then order_return_token_ensure (the return prompt): it
#      waits for M (its side insert needs the side table M holds EXCLUSIVE),
#      then answers the SAME token the order column held before the move,
#      now from the side table: an emailed return link never rotates across
#      the migration.
#   6. No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# at 0391 or later (needs the side table and the 0390 RPCs). M commits, so the
# script first checks that no order outside its own namespace would be
# rewritten by the data block (a fresh reset with the QA seed has none) and
# refuses otherwise. Fixtures are committed under the 03923333-... namespace
# and removed before each case, at the end and by the EXIT trap. It never
# prints a token: only booleans, statuses and the organization id. Exit
# status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0392_secrets_contract_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$REPO/supabase/migrations/0392_order_secrets_contract.sql"
TMP="$(mktemp -d)"

ORG='03923333-0000-0000-0000-00000000000a'
MGR='03923333-0000-0000-0000-0000000000a1'
REQ='03923333-0000-0000-0000-0000000000a2'
WH='03923333-0000-0000-0000-0000000000b1'
H1='03923333-0000-0000-0000-0000000000d1'
H2='03923333-0000-0000-0000-0000000000d2'
M3='03923333-0000-0000-0000-0000000000d3'
R5='03923333-0000-0000-0000-0000000000d5'
D6='03923333-0000-0000-0000-0000000000d6'
RT5='03923333-0000-4000-8000-0000000000f5'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
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
wait_blocked() { # wait_blocked <application_name>: until it waits on a lock
  local _
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
# Whether the order column is sha256 of its side token ('null' = no side token).
live() { q "select coalesce((o.signature_token = encode(extensions.digest(s.signature_token, 'sha256'), 'hex'))::text, 'null') from public.order_requests o left join public.order_request_secrets s on s.order_request_id = o.id where o.id = '$1'"; }
# Whether the order column is sha256 of the given fixture raw (never printed).
hashed_from() { q "select (signature_token = encode(extensions.digest(repeat('$2', 32), 'sha256'), 'hex'))::text from public.order_requests where id = '$1'"; }
side_tokens() { q "select count(*) filter (where signature_token is not null)::text from public.order_request_secrets where order_request_id = '$1'"; }
status_of() { q "select status from public.order_requests where id = '$1'"; }

cleanup_rows() {
  "${PSQL[@]}" >/dev/null 2>&1 <<SQL
delete from public.order_requests where organization_id = '$ORG';
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

[ -f "$MIG" ] || { echo "missing $MIG"; exit 1; }
HAS="$(q "select count(*) from pg_proc where proname in ('generate_order_packing_slips', 'order_return_token_ensure', 'assign_order_delivery')")"
[ "$HAS" = "3" ] || { echo "needs 0390 or later on the local stack"; exit 1; }
cleanup_rows
OTHERS="$(q "select count(*) from public.order_requests o
              where (o.signature_token is not null and not exists (
                       select 1 from public.order_request_secrets s where s.order_request_id = o.id
                          and s.signature_token is not null
                          and encode(extensions.digest(s.signature_token, 'sha256'), 'hex') = o.signature_token))
                 or o.return_token is not null or o.public_track_token is not null")"
SHIPS="$(q "select count(*) from public.shipments where signature_token is not null and signature_token_expires_at < now()")"
if [ "$OTHERS" != "0" ] || [ "$SHIPS" != "0" ]; then
  echo "the stack holds $OTHERS order(s) and $SHIPS shipment(s) the committed data block would rewrite: reset the stack (QA reseed) first"
  exit 1
fi

# The prelude and the data block, as the file has them.
# shellcheck disable=SC2016  # literal dollar tags, not expansions
A="$(grep -n '^do \$c392_lock\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016
B="$(grep -n '^end \$c392_move\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$A" ] && [ -n "$B" ] || { echo "no data block in $MIG"; exit 1; }
sed -n "${A},${B}p" "$MIG" > "$TMP/replay.sql"

"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR', '0392-race-mgr@test.local', '{}'::jsonb),
  ('$REQ', '0392-race-req@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0392 Race Org', '0392-race');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$REQ', 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0392 Race Main', 'WH-0392-RC', 'active');
SQL

plant() { # every fixture order back to its pre-0392 shape
  "${PSQL[@]}" >/dev/null <<SQL
delete from public.order_requests where organization_id = '$ORG';
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, approved_by, approved_at,
   signed_at, signature_token, signature_token_expires_at, return_token) values
  ('$H1', '$ORG', '$WH', 'staged_for_pickup', 'internal', '$REQ', 'pickup', '$MGR', now(), null,  repeat('5a', 32), now() + interval '1 day', null),
  ('$H2', '$ORG', '$WH', 'staged_for_pickup', 'internal', '$REQ', 'pickup', '$MGR', now(), null,  repeat('5b', 32), now() + interval '1 day', null),
  ('$M3', '$ORG', '$WH', 'picking_complete',  'internal', '$REQ', 'pickup', '$MGR', now(), null,  null,              null,                    null),
  ('$R5', '$ORG', '$WH', 'completed',         'internal', '$REQ', 'pickup', '$MGR', now(), now(), null,              null,                    '$RT5'),
  ('$D6', '$ORG', '$WH', 'completed',         'internal', '$REQ', 'pickup', '$MGR', now(), now(), repeat('5c', 32), now() - interval '1 day', null);
SQL
}
# Session M: the replay, then an optional hold, then COMMIT.
move() { # move <label> <hold seconds>
  { echo "set application_name = '0392-race-move-$1';"; echo "set lock_timeout = '900ms';"; echo "begin;"
    cat "$TMP/replay.sql"; echo "select pg_sleep($2);"; echo "commit;"; echo "select 'MOVED';"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/move-$1.out" 2>&1
}
handover() { # handover <label> <order> <token sql expression> <hold seconds>
  printf "set application_name = '0392-race-hand-%s';\nbegin;\nset local role service_role;\nselect 'H=' || coalesce(public.confirm_order_signature('%s', %s, 'Pat Signer', 'pat@example.com', 'data:image/png;base64,AAAA')::text, 'null');\nselect pg_sleep(%s);\ncommit;\n" \
    "$1" "$2" "$3" "$4" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/hand-$1.out" 2>&1
}
mint() { # mint <label> <order> <hold seconds>
  printf "set application_name = '0392-race-mint-%s';\nbegin;\nset local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\nselect 'MINT=' || r.status from public.generate_order_packing_slips('%s') r;\nselect pg_sleep(%s);\ncommit;\n" \
    "$1" "$MGR" "$2" "$3" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/mint-$1.out" 2>&1
}

# ── 1. A hand-over holding its transaction when the move starts ─────────
plant
handover 1 "$H1" "repeat('5a', 32)" 2 &
HP=$!
if wait_sleeping 0392-race-hand-1; then
  t0="$(now_ms)"; move 1 0; t1="$(now_ms)"
  wait "$HP"
  check "1: the hand-over (raw token, before the move) recorded the order" "$(grep -c "^H=$ORG$" "$TMP/hand-1.out")" "1"
  check "1: the move waited for it and applied" "$(grep -c '^MOVED$' "$TMP/move-1.out")" "1"
  if [ $((t1 - t0)) -ge 1000 ]; then ok "1: the move retried for $((t1 - t0)) ms (NOWAIT, holding nothing) before it applied"
  else bad "1: the move did not wait for the hand-over ($((t1 - t0)) ms)"; fi
  check "1: the signed order's token is dead: hashed in place" "$(hashed_from "$H1" 5a)" "true"
  check "1: and not copied to the side table" "$(side_tokens "$H1")" "0"
  check "1: the order is completed once" "$(status_of "$H1")" "completed"
else
  bad "1: the hand-over never reached pg_sleep: $(tr '\n' ' ' < "$TMP/hand-1.out" | cut -c1-200)"
  wait "$HP"
fi

# ── 2. The move holding its locks when a raw-token hand-over arrives ─────
plant
move 2 2 &
MP=$!
if wait_sleeping 0392-race-move-2; then
  t0="$(now_ms)"; handover 2a "$H2" "repeat('5b', 32)" 0; t1="$(now_ms)"
  wait "$MP"
  check "2: the raw value no longer matches the column once the move committed: nothing recorded" "$(grep -c '^H=null$' "$TMP/hand-2a.out")" "1"
  if [ $((t1 - t0)) -ge 800 ]; then ok "2: the hand-over waited $((t1 - t0)) ms for the move's lock (EXCLUSIVE blocks its FOR UPDATE)"
  else bad "2: the hand-over did not wait for the move ($((t1 - t0)) ms)"; fi
  check "2: still unsigned and staged after the refused attempt" "$(status_of "$H2")" "staged_for_pickup"
  handover 2b "$H2" "encode(extensions.digest(repeat('5b', 32), 'sha256'), 'hex')" 0
  check "2: the retry through the digest (the sign route hashes the printed raw token) completes it" "$(grep -c "^H=$ORG$" "$TMP/hand-2b.out")" "1"
  check "2: the live token had been copied before it was hashed" "$(live "$H2")" "true"
else
  bad "2: the move never reached pg_sleep: $(tr '\n' ' ' < "$TMP/move-2.out" | cut -c1-300)"
  wait "$MP"
fi

# ── 3. A mint holding its transaction when the move starts ──────────────
plant
mint 3 "$M3" 2 &
NP=$!
if wait_sleeping 0392-race-mint-3; then
  t0="$(now_ms)"; move 3 0; t1="$(now_ms)"
  wait "$NP"
  check "3: the mint went through" "$(grep -c '^MINT=packing_slip_generated$' "$TMP/mint-3.out")" "1"
  check "3: the move waited for it and applied" "$(grep -c '^MOVED$' "$TMP/move-3.out")" "1"
  if [ $((t1 - t0)) -ge 1000 ]; then ok "3: the move retried for $((t1 - t0)) ms before it applied"
  else bad "3: the move did not wait for the mint ($((t1 - t0)) ms)"; fi
  check "3: the mint's digest was left alone (column = sha256(side token))" "$(live "$M3")" "true"
else
  bad "3: the mint never reached pg_sleep: $(tr '\n' ' ' < "$TMP/mint-3.out" | cut -c1-300)"
  wait "$NP"
fi

# ── 4. The move holding its locks when a mint arrives ───────────────────
plant
move 4 2 &
MP=$!
if wait_sleeping 0392-race-move-4; then
  mint 4 "$M3" 0 &
  NP=$!
  if wait_blocked 0392-race-mint-4; then ok "4: the mint waits on the move's lock"; else bad "4: the mint never waited on a lock"; fi
  wait "$NP"; wait "$MP"
  check "4: the mint then went through" "$(grep -c '^MINT=packing_slip_generated$' "$TMP/mint-4.out")" "1"
  check "4: its digest and side token agree" "$(live "$M3")" "true"
else
  bad "4: the move never reached pg_sleep: $(tr '\n' ' ' < "$TMP/move-4.out" | cut -c1-300)"
  wait "$MP"
fi

# ── 5. The move holding its locks when the return prompt mints ──────────
plant
move 5 2 &
MP=$!
if wait_sleeping 0392-race-move-5; then
  printf "set application_name = '0392-race-ensure-5';\nset role service_role;\nselect 'ENSURE=' || (public.order_return_token_ensure('%s') = '%s'::uuid)::text;\n" "$R5" "$RT5" \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/ensure-5.out" 2>&1 &
  EP=$!
  if wait_blocked 0392-race-ensure-5; then ok "5: the return-token mint waits on the move's lock"; else bad "5: the return-token mint never waited on a lock"; fi
  wait "$EP"; wait "$MP"
  check "5: it answers the token the order column held before the move (never rotated)" "$(grep -c '^ENSURE=true$' "$TMP/ensure-5.out")" "1"
  check "5: the order column is null" "$(q "select (return_token is null)::text from public.order_requests where id = '$R5'")" "true"
else
  bad "5: the move never reached pg_sleep: $(tr '\n' ' ' < "$TMP/move-5.out" | cut -c1-300)"
  wait "$MP"
fi

# ── 6. No 40001 / 40P01 anywhere ─────────────────────────────────────────
if grep -lE '40P01|40001|deadlock|serialization' "$TMP"/*.out > /dev/null 2>&1; then
  bad "6: a session saw 40001/40P01: $(grep -lE '40P01|40001|deadlock|serialization' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "6: no session saw 40001 or 40P01"
fi
if grep -lE '^ERROR|ERROR:' "$TMP"/*.out > /dev/null 2>&1; then
  bad "6: a session reported an error: $(grep -hE 'ERROR' "$TMP"/*.out | head -n 3 | cut -c1-200 | tr '\n' ' ')"
else
  ok "6: no session reported an error"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
