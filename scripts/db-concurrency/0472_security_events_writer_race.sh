#!/usr/bin/env bash
#
# Two-session checks of the security events writer and purge
# (supabase/migrations/*_security_events.sql). record_security_events and
# purge_security_events take one transaction advisory lock, so one call runs
# at a time, and each gives up a wait after 2 s (the functions' own
# lock_timeout). This proves, with real sessions:
#
#   1. A writer call that waits behind another gives up with 55P03 after
#      about 2 s, and stores nothing.
#   2. Forty calls at once, half naming two events in one order and half in
#      the other: no call fails (no deadlock) and the two counts are exact.
#   3. The purge waits for an open writer call the same way (55P03 after
#      about 2 s): a purge and a write never hold each other's rows.
#   4. An organization that is being deleted (its row locked by an open
#      DELETE): a writer call that names it does not wait. It returns at
#      once and stores the event with no organization.
#
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack, the migration scratch stack is
# supabase_db_spmig). It needs the head at or after this migration. Every row
# it writes carries a reason that starts with 'race_' or belongs to the one
# made-up organization below, and all of them are removed at the end. Exit
# status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0472_security_events_writer_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -At)
TMP="$(mktemp -d)"
ORG='a0472900-0000-4000-8000-0000000000a1'

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1" 2>&1; }
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
cleanup() {
  q "delete from public.security_events where reason like 'race\\_%' or organization_id = '$ORG'" > /dev/null
  q "delete from public.organizations where id = '$ORG'" > /dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$(q "select to_regprocedure('public.record_security_events(jsonb)') is not null")" != "t" ]; then
  echo "needs the head at or after the security events migration"
  exit 1
fi
cleanup_rows() { q "delete from public.security_events where reason like 'race\\_%' or organization_id = '$ORG'" > /dev/null; }
cleanup_rows

AB='[{"category":"exploit","outcome":"blocked","reason":"race_a","source":"web"},{"category":"exploit","outcome":"blocked","reason":"race_b","source":"web"}]'
BA='[{"category":"exploit","outcome":"blocked","reason":"race_b","source":"web"},{"category":"exploit","outcome":"blocked","reason":"race_a","source":"web"}]'

# ── 1. A waiting writer gives up after about 2 s ───────────────────────────
printf "set application_name = 'race-holder-1';\nbegin;\nset local role service_role;\nselect public.record_security_events('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$AB" \
  | "${PSQL[@]}" > "$TMP/1.h.out" 2>&1 &
H1=$!
if ! wait_sleeping race-holder-1; then
  bad "1: the holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.record_security_events('$BA'::jsonb);")"
  T1="$(now_ms)"
  if printf '%s' "$OUT" | grep -q 'lock timeout' && [ $((T1 - T0)) -ge 1800 ] && [ $((T1 - T0)) -le 3500 ]; then
    ok "1: the waiting call gave up after $((T1 - T0)) ms with a lock timeout"
  else
    bad "1: the waiting call answered after $((T1 - T0)) ms: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
fi
wait "$H1"
LEFT="$(q "select count(*) from public.security_events where reason like 'race\\_%'")"
if [ "$LEFT" = "0" ]; then ok "1: neither call stored a row (one rolled back, one gave up)"; else bad "1: $LEFT rows were stored"; fi

# ── 2. Forty calls at once, opposite orders ────────────────────────────────
PIDS=()
for i in $(seq 1 20); do
  ( q "set role service_role; select public.record_security_events('$AB'::jsonb);" > "$TMP/2.a.$i" ) &
  PIDS+=($!)
  ( q "set role service_role; select public.record_security_events('$BA'::jsonb);" > "$TMP/2.b.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
ERRS="$(cat "$TMP"/2.a.* "$TMP"/2.b.* | grep -c -i 'error')"
SUMS="$(q "select coalesce(string_agg(reason || '=' || n, ',' order by reason), 'none') from (select reason, sum(event_count) as n from public.security_events where reason like 'race\\_%' group by reason) t")"
if [ "$ERRS" = "0" ] && [ "$SUMS" = "race_a=40,race_b=40" ]; then
  ok "2: forty calls in opposite orders, no error, counts exact ($SUMS)"
else
  bad "2: $ERRS calls failed; counts: $SUMS (expected race_a=40,race_b=40)"
fi
cleanup_rows

# ── 3. The purge waits for an open writer call ─────────────────────────────
printf "set application_name = 'race-holder-3';\nbegin;\nset local role service_role;\nselect public.record_security_events('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$AB" \
  | "${PSQL[@]}" > "$TMP/3.h.out" 2>&1 &
H3=$!
if ! wait_sleeping race-holder-3; then
  bad "3: the holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.purge_security_events();")"
  T1="$(now_ms)"
  if printf '%s' "$OUT" | grep -q 'lock timeout' && [ $((T1 - T0)) -ge 1800 ] && [ $((T1 - T0)) -le 3500 ]; then
    ok "3: the purge gave up after $((T1 - T0)) ms behind an open writer call"
  else
    bad "3: the purge answered after $((T1 - T0)) ms: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
fi
wait "$H3"

# ── 4. An organization that is being deleted ───────────────────────────────
q "insert into public.organizations (id, name, slug) values ('$ORG', 'Race Check Org', 'a0472900-race-check')" > /dev/null
printf "set application_name = 'race-holder-4';\nbegin;\ndelete from public.organizations where id = '%s';\nselect pg_sleep(4);\nrollback;\n" "$ORG" \
  | "${PSQL[@]}" > "$TMP/4.h.out" 2>&1 &
H4=$!
if ! wait_sleeping race-holder-4; then
  bad "4: the deleting session never reached pg_sleep"
else
  EV="[{\"category\":\"bots\",\"outcome\":\"blocked\",\"reason\":\"race_org\",\"source\":\"web\",\"organization_id\":\"$ORG\"}]"
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.record_security_events('$EV'::jsonb);")"
  T1="$(now_ms)"
  ROW="$(q "select coalesce(string_agg((organization_id is null)::text || ':' || event_count, ','), 'none') from public.security_events where reason = 'race_org'")"
  if [ "$OUT" = "1" ] && [ $((T1 - T0)) -lt 1000 ] && [ "$ROW" = "true:1" ]; then
    ok "4: the call did not wait for the delete ($((T1 - T0)) ms) and stored the event with no organization"
  else
    bad "4: answered '$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-120)' after $((T1 - T0)) ms; row: $ROW (expected true:1)"
  fi
fi
wait "$H4"

if [ "$FAILS" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$FAILS check(s) failed"
fi
exit "$FAILS"
