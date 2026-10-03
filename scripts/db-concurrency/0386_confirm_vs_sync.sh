#!/usr/bin/env bash
#
# Two-session proof for migration 0386 (confirm the counted number of a count
# difference): a confirm and the org's sync never undo each other, and a
# confirm never meets a recount in a deadlock. pgTAP runs in ONE session, so
# it cannot show this.
#
#   1. A sync holds the org's lock (its transaction kept open); a confirm
#      meanwhile waits for it, then succeeds. The sync raised nothing.
#   2. A confirm holds the lock; a STALE sync (its evaluation read before the
#      confirm) meanwhile waits, then answers raised 0 and settled 1: step 2b
#      sees the committed confirmation.
#   3. The mutations: (a) a COPY of the confirm without the advisory lock
#      (public._probe_confirm_nolock): the sync reads the row before the
#      confirm commits and raises a SECOND occurrence ("Recurred") once it
#      does; (b) a COPY of the sync without step 2b
#      (public._probe_sync_no_settle): applied after a committed confirm, it
#      raises a second occurrence where the real sync raises none. This is
#      what the lock and the step exist for.
#   4. A confirm against start_targeted_recount on the same row, both orders:
#      no deadlock; recount first -> the confirm answers recount_in_progress;
#      confirm first -> the recount skips the row as resolved.
#   5. The org's lock held for 8 s (the confirm starts 1 s in, so it would
#      wait 7 s): the confirm answers 55P03 at about 5 s (lock_timeout), never
#      a hang and never 57014.
#   No session ever sees 40001 or 40P01.
#
# Runs against the LOCAL stack only (docker container supabase_db_stockpilot).
# Fixtures are committed under the 03861111-... namespace and removed at the
# start and the end. Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0386_confirm_vs_sync.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"
# The mutation sections create throwaway copies of real functions (one
# SECURITY DEFINER and executable by authenticated). The EXIT trap drops them
# however the script ends (a failure, Ctrl-C, SIGTERM, a harness timeout;
# bash runs it on INT, TERM and HUP), so an interrupted run never leaves one on
# the shared local stack. SIGKILL cannot be trapped: the next run's cleanup
# drops them first.
# shellcheck disable=SC2329 # called from the EXIT trap below
drop_probes() {
  "${PSQL[@]}" -c "drop function if exists public._probe_confirm_nolock(uuid, uuid, numeric, text); drop function if exists public._probe_sync_no_settle(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)" >/dev/null 2>&1
}
trap 'drop_probes; [ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"; [ -n "${KEEP_TMP:-}" ] && echo "kept $TMP"' EXIT

ORG='03861111-0000-0000-0000-00000000000a'
STA='03861111-0000-0000-0000-0000000000a1'
MGR='03861111-0000-0000-0000-0000000000a2'
WH='03861111-0000-0000-0000-0000000000b1'
CC='03861111-0000-0000-0000-0000000000c0'
item() { printf '03861111-0000-0000-0000-0000000000e%s' "$1"; }
occ() { printf '03861111-0000-0000-0000-0000000000d%s' "$1"; }

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

cleanup() {
  "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop function if exists public._probe_confirm_nolock(uuid, uuid, numeric, text);
drop function if exists public._probe_sync_no_settle(uuid, timestamptz, text[], text[], text[], jsonb, jsonb);
delete from public.exception_occurrence_events where organization_id = '$ORG';
delete from public.exception_occurrences where organization_id = '$ORG';
delete from public.exception_sync_state where organization_id = '$ORG';
delete from public.exception_occurrence_counters where organization_id = '$ORG';
delete from public.idempotency_keys where organization_id = '$ORG';
delete from public.cycle_count_lines where cycle_count_id in (select id from public.cycle_counts where organization_id = '$ORG');
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ('$STA', '$MGR');
SQL
  if [ $? -ne 0 ]; then echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1; fi
}

cleanup || exit 1

# Seven items, one per section, each counted 7 where 10 was on record by
# staff A in one posted count (planted: the count's flow is 0369's and 0372's
# to prove), with the stock on record at the counted 7, and one open
# count_variance occurrence each whose facts name the count.
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$STA', '0386-2s-a@test.local', '{}'::jsonb),
  ('$MGR', '0386-2s-m@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', '0386 Two Session Org', '0386-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$STA', 'staff', now()),
  ('$ORG', '$MGR', 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  ('$ORG', 'cycle_counts', true, 'optional')
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values ('$WH', '$ORG', '0386 2S Main', 'WH-0386-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  ('$ORG', '$STA', '$WH', true);
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status)
select ('03861111-0000-0000-0000-0000000000e' || n)::uuid, '$ORG', '$WH', '2S item ' || n, 'SKU-0386-2S-' || n, 7, 'active'
  from generate_series(1, 7) n;
alter table public.cycle_count_lines disable trigger cycle_count_lines_rebase_expected;
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at, completed_at, completed_by)
values ('$CC', '$ORG', '$WH', 'completed', 'selection', '$MGR', now() - interval '2 hours', now() - interval '1 hour', '$MGR');
insert into public.cycle_count_lines
  (cycle_count_id, item_id, warehouse_id, expected_quantity, expected_at_start, counted_quantity, counted_by, counted_at, baseline_at)
select '$CC', ('03861111-0000-0000-0000-0000000000e' || n)::uuid, '$WH', 10, 10, 7, '$STA',
       now() - interval '90 minutes', now() - interval '90 minutes'
  from generate_series(1, 7) n;
alter table public.cycle_count_lines enable trigger cycle_count_lines_rebase_expected;
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id, facts, condition_since, first_seen_at, last_seen_at)
select ('03861111-0000-0000-0000-0000000000d' || n)::uuid, '$ORG', n, 'count_variance',
       ('03861111-0000-0000-0000-0000000000e' || n)::uuid, null, '$WH',
       jsonb_build_object('cycleCountId', '$CC'::uuid, 'counted', 7, 'expected', 10, 'variance', -3),
       now() - interval '90 minutes', now() - interval '1 hour', now() - interval '1 hour'
  from generate_series(1, 7) n;
insert into public.exception_occurrence_events (organization_id, occurrence_id, kind)
select '$ORG', ('03861111-0000-0000-0000-0000000000d' || n)::uuid, 'raised' from generate_series(1, 7) n;
SQL
if [ $? -ne 0 ]; then echo "fixture setup failed"; cleanup; exit 1; fi

# The evaluator's present entry for one item (read now: a later apply of it
# is a STALE evaluation).
entry() {
  q "select jsonb_build_array(jsonb_build_object('rule', 'count_variance', 'itemId', l.item_id, 'locationId', null,
       'facts', jsonb_build_object('cycleCountId', l.cycle_count_id, 'countNumber', l.count_number,
                                   'expected', trim_scale(l.expected_quantity), 'counted', trim_scale(l.counted_quantity),
                                   'variance', trim_scale(l.counted_quantity - l.expected_quantity))))::text
       from public._latest_count_lines('$ORG', array['$1']::uuid[], null) l"
}
# SQL lines for a session: as a user, the confirm; as the system, a sync of
# one item's entry (no rule complete, so nothing else resolves).
as_user() { printf "set local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\n" "$1"; }
confirm_sql() { # confirm_sql <fn> <user> <occ> <label>
  as_user "$2"
  printf "select '%s=' || (public.%s('%s', '%s', 7, null))::text;\n" "$4" "$1" "$3" "$CC"
}
sync_sql() { # sync_sql <fn> <entries json> <label>
  printf "set local role service_role;\nselect '%s=' || (public.%s('%s', clock_timestamp(), '{}', '{}', '{}', '%s'::jsonb, '[]'::jsonb))::text;\n" \
    "$3" "$1" "$ORG" "$2"
}
recount_sql() { # recount_sql <occ> <key> <label>
  as_user "$MGR"
  printf "select '%s=' || (public.start_targeted_recount('%s', array['%s']::uuid[], null, null, '%s'))::text;\n" "$3" "$ORG" "$1" "$2"
}

# race <tag> <A sql> <B sql> <A hold seconds>: A runs and holds its
# transaction open; B starts 1 s later and is timed.
race() {
  local tag="$1" a="$2" b="$3" hold="${4:-3}"
  ( printf 'begin;\n%s\nselect pg_sleep(%s);\ncommit;\n' "$a" "$hold" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.A.out" 2>&1 ) &
  local pid=$!
  sleep 1
  local t0; t0=$(now_ms)
  printf 'begin;\n%s\ncommit;\n' "$b" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$tag.B.out" 2>&1
  local t1; t1=$(now_ms)
  wait "$pid"
  echo $((t1 - t0)) > "$TMP/$tag.waited"
}
waited_ok() { # waited_ok <label> <tag> <min ms>
  local w; w="$(cat "$TMP/$2.waited")"
  if [ "$w" -ge "$3" ]; then ok "$1 ($w ms)"; else bad "$1: did not wait ($w ms)"; fi
}
open_rows() { q "select count(*) from public.exception_occurrences where item_id = '$1' and resolved_at is null"; }

# ═══ 1. A sync holds the lock; a confirm waits, then succeeds ═════════════
echo "== 1. a sync holds the org's lock; a confirm meanwhile waits for it"
E1="$(entry "$(item 1)")"
race s1 "$(sync_sql exceptions_sync "$E1" A)" "$(confirm_sql exception_confirm_count "$STA" "$(occ 1)" B)" 2
check "1a: the sync raised nothing" "$(grep -oE '"raised": [0-9]+' "$TMP/s1.A.out")" '"raised": 0'
waited_ok "1b: the confirm waited for the sync's lock" s1 800
check "1c: then the confirm succeeded, as the counter" "$(grep -c '"confirmedAs": "counter"' "$TMP/s1.B.out")" "1"
check "1d: the row is resolved as confirmed" "$(q "select resolved_reason from public.exception_occurrences where id = '$(occ 1)'")" "confirmed"

# ═══ 2. A confirm holds the lock; a stale sync waits, then settles ════════
echo "== 2. a confirm holds the lock; a STALE sync (read before it) meanwhile waits"
E2="$(entry "$(item 2)")"
race s2 "$(confirm_sql exception_confirm_count "$STA" "$(occ 2)" A)" "$(sync_sql exceptions_sync "$E2" B)" 2
check "2a: the confirm succeeded" "$(grep -c '"confirmedAs": "counter"' "$TMP/s2.A.out")" "1"
waited_ok "2b: the sync waited for the confirm's lock" s2 800
check "2c: the stale sync raised 0 and settled 1" \
  "$(grep -oE '"raised": [0-9]+|"settled": [0-9]+' "$TMP/s2.B.out" | sort | tr '\n' ' ')" '"raised": 0 "settled": 1 '
check "2d: one occurrence for the item, resolved as confirmed" \
  "$(q "select count(*) || ':' || string_agg(resolved_reason, ',') from public.exception_occurrences where item_id = '$(item 2)'")" "1:confirmed"

# ═══ 3a. The mutation: a confirm without the advisory lock ════════════════
echo "== 3a. the same race against a copy of the confirm with the advisory lock removed"
q "select pg_get_functiondef('public.exception_confirm_count(uuid, uuid, numeric, text)'::regprocedure)" > "$TMP/confirm.sql"
python3 - "$TMP/confirm.sql" "$TMP/nolock.sql" <<'PY'
import sys
d = open(sys.argv[1]).read()
lock = "\n  perform pg_advisory_xact_lock(hashtextextended('exc_sync:' || v_org::text, 0));"
assert d.count(lock) == 1, d.count(lock)
d = d.replace(lock, '', 1).replace('public.exception_confirm_count(', 'public._probe_confirm_nolock(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/nolock.sql" || bad "3a: could not create the lock-less copy"
q "revoke all on function public._probe_confirm_nolock(uuid, uuid, numeric, text) from public, anon, service_role; grant execute on function public._probe_confirm_nolock(uuid, uuid, numeric, text) to authenticated" >/dev/null
E3="$(entry "$(item 3)")"
race s3a "$(confirm_sql _probe_confirm_nolock "$STA" "$(occ 3)" A)" "$(sync_sql exceptions_sync "$E3" B)" 2
check "3a1: the lock-less confirm succeeded" "$(grep -c '"confirmedAs": "counter"' "$TMP/s3a.A.out")" "1"
check "3a2: the sync, which read the row before the confirm committed, RAISED a second occurrence (what the lock prevents)" \
  "$(grep -oE '"raised": [0-9]+' "$TMP/s3a.B.out")" '"raised": 1'
check "3a3: the item now has an open recurrence of the confirmed row" \
  "$(q "select recurrence_index || ':' || (previous_occurrence_id = '$(occ 3)')::text from public.exception_occurrences where item_id = '$(item 3)' and resolved_at is null")" "1:true"

# ═══ 3b. The mutation: a sync without step 2b ════════════════════════════
echo "== 3b. a copy of the sync without step 2b, after a committed confirm"
q "select pg_get_functiondef('public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)'::regprocedure)" > "$TMP/sync.sql"
python3 - "$TMP/sync.sql" "$TMP/no_settle.sql" <<'PY'
import sys
lines = open(sys.argv[1]).read().split('\n')
start = [i for i, l in enumerate(lines) if l.startswith('  -- ── 2b. (0386) Settled')]
assert len(start) == 1, start
end = next(i for i in range(start[0], len(lines)) if lines[i].startswith('    from s;'))
d = '\n'.join(lines[:start[0]] + lines[end + 1:])
d = d.replace('public.exceptions_sync(', 'public._probe_sync_no_settle(', 1)
open(sys.argv[2], 'w').write(d + ';\n')
PY
"${PSQL[@]}" >/dev/null < "$TMP/no_settle.sql" || bad "3b: could not create the copy without step 2b"
q "revoke all on function public._probe_sync_no_settle(uuid, timestamptz, text[], text[], text[], jsonb, jsonb) from public, anon, authenticated; grant execute on function public._probe_sync_no_settle(uuid, timestamptz, text[], text[], text[], jsonb, jsonb) to service_role" >/dev/null
E4="$(entry "$(item 4)")"
printf 'begin;\n%s\ncommit;\n' "$(confirm_sql exception_confirm_count "$STA" "$(occ 4)" C)" | "${PSQL[@]}" > "$TMP/s3b.C.out" 2>&1
check "3b1: the confirm succeeded" "$(grep -c '"confirmedAs": "counter"' "$TMP/s3b.C.out")" "1"
printf 'begin;\n%s\ncommit;\n' "$(sync_sql exceptions_sync "$E4" R)" | "${PSQL[@]}" > "$TMP/s3b.R.out" 2>&1
check "3b2: the real sync raises nothing for the confirmed line" "$(grep -oE '"raised": [0-9]+' "$TMP/s3b.R.out")" '"raised": 0'
printf 'begin;\n%s\ncommit;\n' "$(sync_sql _probe_sync_no_settle "$E4" P)" | "${PSQL[@]}" > "$TMP/s3b.P.out" 2>&1
check "3b3: the copy without step 2b raises a second occurrence (what the step prevents)" \
  "$(grep -oE '"raised": [0-9]+' "$TMP/s3b.P.out")" '"raised": 1'

# ═══ 4. A confirm against a targeted recount, both orders ═════════════════
echo "== 4a. a recount holds the lock; a confirm meanwhile waits"
race s4a "$(recount_sql "$(occ 5)" k-0386-2s-4a A)" "$(confirm_sql exception_confirm_count "$STA" "$(occ 5)" B)" 2
check "4a1: the recount linked the row" "$(q "select (recount_cycle_count_id is not null)::text from public.exception_occurrences where id = '$(occ 5)'")" "true"
waited_ok "4a2: the confirm waited" s4a 800
check "4a3: then refused it: recount_in_progress" "$(grep -cE 'P0001: recount_in_progress' "$TMP/s4a.B.out")" "1"
echo "== 4b. a confirm holds the lock; a recount meanwhile waits"
race s4b "$(confirm_sql exception_confirm_count "$STA" "$(occ 6)" A)" "$(recount_sql "$(occ 6)" k-0386-2s-4b B)" 2
check "4b1: the confirm succeeded" "$(grep -c '"confirmedAs": "counter"' "$TMP/s4b.A.out")" "1"
waited_ok "4b2: the recount waited" s4b 800
check "4b3: then skipped the row as resolved, and started no count" \
  "$(grep -oE '"reason": "resolved"|"cycleCountId": null' "$TMP/s4b.B.out" | sort | tr '\n' ' ')" '"cycleCountId": null "reason": "resolved" '

# ═══ 5. The lock held past lock_timeout ═══════════════════════════════════
echo "== 5. the org's lock held for 8 s; a confirm answers 55P03 at about 5 s"
race s5 "select pg_advisory_xact_lock(hashtextextended('exc_sync:' || '$ORG', 0));" \
  "$(confirm_sql exception_confirm_count "$STA" "$(occ 7)" B)" 8
W5="$(cat "$TMP/s5.waited")"
check "5a: the confirm was refused with 55P03 (lock_timeout)" "$(grep -cE '55P03' "$TMP/s5.B.out")" "1"
if [ "$W5" -ge 4500 ] && [ "$W5" -le 5900 ]; then ok "5b: after about 5 s ($W5 ms)"; else bad "5b: after $W5 ms, want about 5000"; fi
check "5c: never a statement timeout (57014)" "$(grep -c '57014' "$TMP/s5.B.out")" "0"
check "5d: the row is still open" "$(open_rows "$(item 7)")" "1"

check "no session saw 40001 or 40P01" \
  "$(cat "$TMP"/*.out | grep -cE '40001|40P01')" "0"

cleanup || FAILS=$((FAILS + 1))
check "cleanup: no fixture left" "$(q "select count(*) from public.organizations where id = '$ORG'")" "0"

if [ "$FAILS" -eq 0 ]; then echo "PASS: all checks"; exit 0; else echo "FAILED: $FAILS check(s)"; exit 1; fi
