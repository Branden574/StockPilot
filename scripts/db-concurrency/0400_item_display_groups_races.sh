#!/usr/bin/env bash
#
# Two-session proof for migration 0400 (Group selected: apply_item_grouping).
# pgTAP runs in ONE session, so it cannot show what grouping does while
# another session holds the organization's grouping lock or an item row
# (design 3.2, lock order; brief section 7: concurrent regrouping).
#
#   1. Group against group on OVERLAPPING records, two keys, two managers. A
#      groups P1A+P1B and holds (pauses before commit); B's grouping of
#      P1B+P1C (whose screen saw P1B in no group) waits on the organization's
#      grouping advisory lock, then is refused membership_changed. One group,
#      P1C in none; B's refusal wrote nothing.
#   2. The same key and body twice (a double tap). B waits on the grouping
#      lock, then replays A's answer: the same group, replay true, one group,
#      one request row, three audit rows.
#   3. Group against Ungroup (split_item_sku), both orders. 3a: the split
#      holds; the grouping waits on the grouping lock, then applies (a
#      membership does not depend on the SKU): both records grouped, the
#      split record with its new SKU. 3b: the grouping holds; the split waits
#      on the grouping lock, then applies; the membership is unchanged.
#   4. Group against remove. A removes P4A from its group and holds; B's move
#      of P4A into a new group (its screen saw P4A in the old group) waits,
#      then is refused membership_changed; B again with a fresh screen
#      applies.
#   5. A record held by another writer (a stock function or an edit:
#      FOR UPDATE / UPDATE): the grouping answers 55P03 busy AT ONCE (FOR
#      SHARE NOWAIT: it never waits on an item row); after the writer
#      commits, the same key applies.
#   6. The grouping FIRST: while it holds its FOR SHARE locks, an edit of a
#      grouped record waits for it (the checked scope cannot change before
#      commit), then applies; the edit never blocks the grouping.
#   7. No session ever sees 40001 or 40P01; no open group is left without a
#      live record; no membership crosses organizations; no item row changed
#      except the split's SKU (3) and the edits (5, 6).
#
# After the races (fix round 1, completeness review C2, as Ungroup's PR stage
# evidence review EV-2) the log records what the run left: the md5 of every
# 0400 function's body (to compare with the kit's), that no planted function
# is left, the fixture rows left after a cleanup run in the open (0), and the
# run's wall time.
#
# The item_changed refusal (a record deleted, moved or put out of the
# caller's write scope between apply's first read and its FOR SHARE lock) is
# not raced here: that window lies between two statements of one call, and
# no session can commit into it on purpose without a pause planted inside
# the function. It is defensive (recorded in G2-NOTES, C7).
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot)
# with 0399 and 0400 applied. Fixtures are committed under the 04001111-...
# namespace and removed at the start, at the end and by the EXIT trap. Exit
# status 0 = every check passed.
#
# NOT RUN at the authoring stage (desk only; the local stack is held by
# another job). It runs at the test stage.
#
# Usage: bash scripts/db-concurrency/0400_item_display_groups_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='04001111-0000-0000-0000-00000000000a'
MGR='04001111-0000-0000-0000-0000000000a1'
MGR2='04001111-0000-0000-0000-0000000000a2'
WH='04001111-0000-0000-0000-0000000000b1'
P1A='04001111-0000-0000-0000-000000000101'; P1B='04001111-0000-0000-0000-000000000102'; P1C='04001111-0000-0000-0000-000000000103'
P2A='04001111-0000-0000-0000-000000000201'; P2B='04001111-0000-0000-0000-000000000202'
P3A='04001111-0000-0000-0000-000000000301'; P3B='04001111-0000-0000-0000-000000000302'
P3C='04001111-0000-0000-0000-000000000303'; P3D='04001111-0000-0000-0000-000000000304'
P4A='04001111-0000-0000-0000-000000000401'; P4B='04001111-0000-0000-0000-000000000402'; P4C='04001111-0000-0000-0000-000000000403'
P5A='04001111-0000-0000-0000-000000000501'; P5B='04001111-0000-0000-0000-000000000502'
P6A='04001111-0000-0000-0000-000000000601'; P6B='04001111-0000-0000-0000-000000000602'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
key() { printf '04002222-0000-4000-8000-%012d' "$1"; }
group_of() { q "select coalesce((select group_id::text from public.item_display_group_members where item_id = '$1'), 'none')"; }
sku_of() { q "select sku from public.inventory_items where id = '$1'"; }

# group_sql <actor> <ids json> <target json> <expected json> <key> [move json]:
# the request as core toGroupingRpcRequest builds it.
group_sql() {
  printf "select 'R=' || public.apply_item_grouping('{\"action\":\"group\",\"organization_id\":\"%s\",\"actor_user_id\":\"%s\",\"surface\":\"web\",\"item_ids\":%s,\"target\":%s,\"expected_groups\":%s,\"move_item_ids\":%s}'::jsonb, '%s')::text;" \
    "$ORG" "$1" "$2" "$3" "$4" "${6:-[]}" "$5"
}
remove_sql() { # remove_sql <actor> <ids json> <expected json> <key>
  printf "select 'R=' || public.apply_item_grouping('{\"action\":\"remove\",\"organization_id\":\"%s\",\"actor_user_id\":\"%s\",\"surface\":\"web\",\"item_ids\":%s,\"expected_groups\":%s}'::jsonb, '%s')::text;" \
    "$ORG" "$1" "$2" "$3" "$4"
}
split_sql() { # split_sql <actor> <item> <expected sku> <key>
  printf "select 'R=' || public.split_item_sku('{\"action\":\"split_sku\",\"organization_id\":\"%s\",\"actor_user_id\":\"%s\",\"surface\":\"web\",\"item_ids\":[\"%s\"],\"expected_skus\":{\"%s\":\"%s\"}}'::jsonb, '%s')::text;" \
    "$ORG" "$1" "$2" "$2" "$3" "$4"
}

wait_for() { # wait_for <application_name> <wait_event_type> [wait_event]
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
delete from public.audit_logs where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$MGR', '$MGR2');
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.item_display_groups where organization_id = '$ORG') + (select count(*) from public.item_grouping_requests where organization_id = '$ORG')")"
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
T_START=$(now_ms)

if [ "$(q "select count(*) from pg_proc where proname in ('apply_item_grouping', 'split_item_sku') and pronamespace = 'public'::regnamespace")" != "2" ]; then
  echo "0399 and 0400 are not both applied on this stack"; exit 1
fi

# as_user <application_name|-> <user> <statements> [end]: one transaction as
# that member (authenticated, with claims); end is commit or rollback.
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
# as_svc <application_name> <statements>: one transaction as the service role
# (the admin client; also the shape of a stock function's row lock).
as_svc() {
  printf '%s\n' "set application_name to '$1';" "begin;" "set local role service_role;" "$2" "commit;" \
    | "${PSQL[@]}" -v VERBOSITY=verbose 2>&1
}

# ═══ Fixture ═══════════════════════════════════════════════════════════════
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR',  '0400-2s-mgr@test.local',  '{}'::jsonb),
  ('$MGR2', '0400-2s-mgr2@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0400 Two Session Org', '0400-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$MGR2', 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0400 2S Main', 'WH-0400-2S', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, unit_cost, quantity_on_hand, status, bin_location, created_at) values
  ('$P1A', '$ORG', '$WH', 'X0400-R1A', 'Race one A',   1, 3, 'active', '1-A', now() - interval '3 days'),
  ('$P1B', '$ORG', '$WH', 'X0400-R1B', 'Race one B',   1, 3, 'active', '1-B', now() - interval '2 days'),
  ('$P1C', '$ORG', '$WH', 'X0400-R1C', 'Race one C',   1, 3, 'active', '1-C', now() - interval '1 day'),
  ('$P2A', '$ORG', '$WH', 'X0400-R2A', 'Race two A',   1, 3, 'active', '2-A', now() - interval '2 days'),
  ('$P2B', '$ORG', '$WH', 'X0400-R2B', 'Race two B',   1, 3, 'active', '2-B', now() - interval '1 day'),
  ('$P3A', '$ORG', '$WH', 'X0400-R3',  'Race three',   1, 3, 'active', '3-A', now() - interval '2 days'),
  ('$P3B', '$ORG', '$WH', 'X0400-R3',  'Race three',   1, 3, 'active', '3-B', now() - interval '1 day'),
  ('$P3C', '$ORG', '$WH', 'X0400-R3B', 'Race three b', 1, 3, 'active', '3-C', now() - interval '2 days'),
  ('$P3D', '$ORG', '$WH', 'X0400-R3B', 'Race three b', 1, 3, 'active', '3-D', now() - interval '1 day'),
  ('$P4A', '$ORG', '$WH', 'X0400-R4A', 'Race four A',  1, 3, 'active', '4-A', now() - interval '3 days'),
  ('$P4B', '$ORG', '$WH', 'X0400-R4B', 'Race four B',  1, 3, 'active', '4-B', now() - interval '2 days'),
  ('$P4C', '$ORG', '$WH', 'X0400-R4C', 'Race four C',  1, 3, 'active', '4-C', now() - interval '1 day'),
  ('$P5A', '$ORG', '$WH', 'X0400-R5A', 'Race five A',  1, 3, 'active', '5-A', now() - interval '2 days'),
  ('$P5B', '$ORG', '$WH', 'X0400-R5B', 'Race five B',  1, 3, 'active', '5-B', now() - interval '1 day'),
  ('$P6A', '$ORG', '$WH', 'X0400-R6A', 'Race six A',   1, 3, 'active', '6-A', now() - interval '2 days'),
  ('$P6B', '$ORG', '$WH', 'X0400-R6B', 'Race six B',   1, 3, 'active', '6-B', now() - interval '1 day');
SQL
then
  echo "fixture setup failed"; exit 1
fi

ans() { sed -n 's/^R=//p' "$TMP/$1.out"; }
jget() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "null")
out = []
for path in sys.argv[1:]:
    v = d
    for part in path.split("."):
        if isinstance(v, list):
            v = v[int(part)] if part.isdigit() and int(part) < len(v) else None
        else:
            v = v.get(part) if isinstance(v, dict) else None
    out.append("-" if v is None else json.dumps(v) if isinstance(v, bool) else str(v))
print("/".join(out))
' "$@"
}
refused() { # refused <tag> <sqlstate> <hint>: 1/1 when that output carries both
  printf '%s/%s' "$(grep -c "ERROR:  $2" "$TMP/$1.out")" "$(grep -c "HINT:  $3" "$TMP/$1.out")"
}
ids() { # ids <id>...: a JSON array of ids
  local out="" i
  for i in "$@"; do out="$out${out:+,}\"$i\""; done
  printf '[%s]' "$out"
}
nulls() { # nulls <id>...: expected_groups with every record in no group
  local out="" i
  for i in "$@"; do out="$out${out:+,}\"$i\":null"; done
  printf '{%s}' "$out"
}
new_t() { printf '{"kind":"new","name":"%s"}' "$1"; }

# ═══ 1. Group against group on overlapping records ════════════════════════
( as_user r1a "$MGR" "$(group_sql "$MGR" "$(ids "$P1A" "$P1B")" "$(new_t 'Race one A')" "$(nulls "$P1A" "$P1B")" "$(key 1)") select pg_sleep(1.5);" > "$TMP/r1a.out" ) &
wait_for r1a Timeout PgSleep || bad "1: A never reached its pause"
( as_user r1b "$MGR2" "$(group_sql "$MGR2" "$(ids "$P1B" "$P1C")" "$(new_t 'Race one B')" "$(nulls "$P1B" "$P1C")" "$(key 2)")" > "$TMP/r1b.out" ) &
if wait_for r1b Lock advisory; then ok "1: B waits on the organization's grouping lock"; else bad "1: B did not wait on the advisory lock"; fi
wait
check "1: A grouped P1A and P1B" "$(ans r1a | jget outcome created replay)" "applied/true/false"
check "1: B is refused membership_changed after A commits" "$(refused r1b P0001 membership_changed)" "1/1"
check "1: one group; P1B in A's, P1C in none; no group named B's" \
  "$(test "$(group_of "$P1A")" = "$(group_of "$P1B")" && echo same)/$(group_of "$P1C")/$(q "select count(*) from public.item_display_groups where organization_id = '$ORG' and name = 'Race one B'")" \
  "same/none/0"

# ═══ 2. The same key and body twice (a double tap) ════════════════════════
( as_user r2a "$MGR" "$(group_sql "$MGR" "$(ids "$P2A" "$P2B")" "$(new_t 'Race two')" "$(nulls "$P2A" "$P2B")" "$(key 3)") select pg_sleep(1.5);" > "$TMP/r2a.out" ) &
wait_for r2a Timeout PgSleep || bad "2: A never reached its pause"
( as_user r2b "$MGR" "$(group_sql "$MGR" "$(ids "$P2A" "$P2B")" "$(new_t 'Race two')" "$(nulls "$P2A" "$P2B")" "$(key 3)")" > "$TMP/r2b.out" ) &
if wait_for r2b Lock advisory; then ok "2: B waits on the grouping lock"; else bad "2: B did not wait on the advisory lock"; fi
wait
check "2: B replays A's answer" "$(ans r2b | jget replay group.id)" "true/$(ans r2a | jget group.id)"
check "2: one group, one request row, three audit rows" \
  "$(q "select count(*) from public.item_display_groups where organization_id = '$ORG' and name = 'Race two'")/$(q "select count(*) from public.item_grouping_requests where organization_id = '$ORG' and key = '$(key 3)'")/$(q "select count(*) from public.audit_logs where organization_id = '$ORG' and metadata->>'request_key' = '$(key 3)'")" \
  "1/1/3"

# ═══ 3. Group against Ungroup, both orders ════════════════════════════════
# 3a: the split holds; the grouping waits, then applies.
( as_user r3s "$MGR" "$(split_sql "$MGR" "$P3B" X0400-R3 "$(key 4)") select pg_sleep(1.5);" > "$TMP/r3s.out" ) &
wait_for r3s Timeout PgSleep || bad "3a: the split never reached its pause"
( as_user r3g "$MGR2" "$(group_sql "$MGR2" "$(ids "$P3A" "$P3B")" "$(new_t 'Race three')" "$(nulls "$P3A" "$P3B")" "$(key 5)")" > "$TMP/r3g.out" ) &
if wait_for r3g Lock advisory; then ok "3a: the grouping waits on the grouping lock the split holds"; else bad "3a: the grouping did not wait"; fi
wait
check "3a: the split applied, then the grouping applied" "$(ans r3s | jget items.0.kept)/$(ans r3g | jget outcome)" "false/applied"
check "3a: both grouped; the split record has its new SKU, the other the old" \
  "$(test "$(group_of "$P3A")" = "$(group_of "$P3B")" && echo same)/$(test "$(sku_of "$P3B")" != X0400-R3 && echo new)/$(sku_of "$P3A")" \
  "same/new/X0400-R3"
# 3b: the grouping holds; the split waits, then applies; the membership stays.
( as_user r3g2 "$MGR2" "$(group_sql "$MGR2" "$(ids "$P3C" "$P3D")" "$(new_t 'Race three b')" "$(nulls "$P3C" "$P3D")" "$(key 6)") select pg_sleep(1.5);" > "$TMP/r3g2.out" ) &
wait_for r3g2 Timeout PgSleep || bad "3b: the grouping never reached its pause"
( as_user r3s2 "$MGR" "$(split_sql "$MGR" "$P3D" X0400-R3B "$(key 7)")" > "$TMP/r3s2.out" ) &
if wait_for r3s2 Lock advisory; then ok "3b: the split waits on the grouping lock"; else bad "3b: the split did not wait"; fi
wait
check "3b: the grouping applied, then the split applied" "$(ans r3g2 | jget outcome)/$(ans r3s2 | jget items.0.kept)" "applied/false"
check "3b: the split record is still in the group, with its new SKU" \
  "$(test "$(group_of "$P3C")" = "$(group_of "$P3D")" && echo same)/$(test "$(sku_of "$P3D")" != X0400-R3B && echo new)" "same/new"

# ═══ 4. Group against remove ══════════════════════════════════════════════
as_user - "$MGR" "$(group_sql "$MGR" "$(ids "$P4A" "$P4B")" "$(new_t 'Race four')" "$(nulls "$P4A" "$P4B")" "$(key 8)")" > "$TMP/r4setup.out"
G4="$(group_of "$P4A")"
( as_user r4r "$MGR" "$(remove_sql "$MGR" "$(ids "$P4A")" "{\"$P4A\":\"$G4\"}" "$(key 9)") select pg_sleep(1.5);" > "$TMP/r4r.out" ) &
wait_for r4r Timeout PgSleep || bad "4: the remove never reached its pause"
( as_user r4g "$MGR2" "$(group_sql "$MGR2" "$(ids "$P4A" "$P4C")" "$(new_t 'Race four b')" "{\"$P4A\":\"$G4\",\"$P4C\":null}" "$(key 10)" "$(ids "$P4A")")" > "$TMP/r4g.out" ) &
if wait_for r4g Lock advisory; then ok "4: the move waits on the grouping lock the remove holds"; else bad "4: the move did not wait"; fi
wait
check "4: the remove applied; the move (stale screen) is membership_changed" "$(ans r4r | jget outcome)/$(refused r4g P0001 membership_changed)" "applied/1/1"
as_user r4g2 "$MGR2" "$(group_sql "$MGR2" "$(ids "$P4A" "$P4C")" "$(new_t 'Race four b')" "$(nulls "$P4A" "$P4C")" "$(key 11)")" > "$TMP/r4g2.out"
check "4: with a fresh screen the grouping applies; the first group keeps P4B" \
  "$(ans r4g2 | jget outcome)/$(test "$(group_of "$P4A")" = "$(group_of "$P4C")" && echo same)/$(test "$(group_of "$P4B")" = "$G4" && echo kept)" \
  "applied/same/kept"

# ═══ 5. A record held by another writer: busy at once ═════════════════════
( as_svc r5u "update public.inventory_items set unit_cost = 5 where id = '$P5A'; select pg_sleep(2);" > "$TMP/r5u.out" ) &
wait_for r5u Timeout PgSleep || bad "5: the writer never reached its pause"
T0=$(now_ms)
as_user r5g "$MGR" "$(group_sql "$MGR" "$(ids "$P5A" "$P5B")" "$(new_t 'Race five')" "$(nulls "$P5A" "$P5B")" "$(key 12)")" > "$TMP/r5g.out"
T1=$(now_ms)
check "5: the grouping answers 55P03 busy" "$(refused r5g 55P03 busy)" "1/1"
if [ $((T1 - T0)) -lt 1000 ]; then ok "5: at once ($((T1 - T0)) ms; the writer held for 2 s)"; else bad "5: the grouping waited $((T1 - T0)) ms"; fi
wait
as_user r5g2 "$MGR" "$(group_sql "$MGR" "$(ids "$P5A" "$P5B")" "$(new_t 'Race five')" "$(nulls "$P5A" "$P5B")" "$(key 12)")" > "$TMP/r5g2.out"
check "5: the same key applies after the writer commits (the refusal recorded nothing)" "$(ans r5g2 | jget outcome replay)" "applied/false"

# ═══ 6. The grouping first: an edit waits for it, then applies ════════════
( as_user r6g "$MGR" "$(group_sql "$MGR" "$(ids "$P6A" "$P6B")" "$(new_t 'Race six')" "$(nulls "$P6A" "$P6B")" "$(key 13)") select pg_sleep(1.5);" > "$TMP/r6g.out" ) &
wait_for r6g Timeout PgSleep || bad "6: the grouping never reached its pause"
( as_user r6e "$MGR2" "with u as (update public.inventory_items set name = 'Race six renamed' where organization_id = '$ORG' and id = '$P6A' returning id) select 'T=' || count(*) from u;" > "$TMP/r6e.out" ) &
if wait_for r6e Lock transactionid; then ok "6: the edit waits on the grouping's share lock"; else bad "6: the edit did not wait"; fi
wait
check "6: the grouping applied; then the edit applied" \
  "$(ans r6g | jget outcome)/$(sed -n 's/^T=//p' "$TMP/r6e.out")/$(q "select name from public.inventory_items where id = '$P6A'")" \
  "applied/1/Race six renamed"

# ═══ 7. Never 40001 or 40P01; the tables stay consistent ══════════════════
if grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out >/dev/null 2>&1; then
  bad "7: a session saw 40001 or 40P01: $(grep -l -E 'ERROR:  (40001|40P01)' "$TMP"/*.out | xargs -n1 basename | tr '\n' ' ')"
else
  ok "7: no session saw 40001 or 40P01"
fi
check "7: no open group without a live record; no row in a closed group; no membership across organizations" \
  "$(q "select (select count(*) from public.item_display_groups g where g.organization_id = '$ORG' and g.closed_at is null and not exists (select 1 from public.item_display_group_members m join public.inventory_items i on i.id = m.item_id where m.group_id = g.id and i.deleted_at is null)) || '/' || (select count(*) from public.item_display_group_members m join public.item_display_groups g on g.id = m.group_id where g.organization_id = '$ORG' and g.closed_at is not null) || '/' || (select count(*) from public.item_display_group_members m join public.inventory_items i on i.id = m.item_id where m.organization_id <> i.organization_id)")" \
  "0/0/0"

# ═══ After: what the run left (C2, as Ungroup's EV-2) ═════════════════════
wait
echo "after: 0400 function md5s: $(q "select string_agg(p.proname || '=' || md5(p.prosrc), ' ' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_display\_grouping\_%' or p.proname in ('apply_item_grouping', 'item_grouping_preview', 'tg_item_display_group_members_consistency'))")"
check "after: no planted function is left" "$(q "select count(*) from pg_proc where proname like '\_zz0400\_%'")" "0"
if cleanup; then ok "after: cleanup removed every fixture"; else bad "after: cleanup failed"; fi
check "after: fixture rows left (items, groups, memberships, requests, audit rows, the organization, the users)" \
  "$(q "select (select count(*) from public.inventory_items where organization_id = '$ORG') + (select count(*) from public.item_display_groups where organization_id = '$ORG') + (select count(*) from public.item_display_group_members where organization_id = '$ORG') + (select count(*) from public.item_grouping_requests where organization_id = '$ORG') + (select count(*) from public.audit_logs where organization_id = '$ORG') + (select count(*) from public.organizations where id = '$ORG') + (select count(*) from auth.users where id in ('$MGR', '$MGR2'))")" "0"
echo "wall time: $(( ($(now_ms) - T_START) / 1000 )) s"

echo
if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
exit "$FAILS"
