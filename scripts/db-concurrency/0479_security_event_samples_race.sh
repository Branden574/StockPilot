#!/usr/bin/env bash
#
# Two-session checks of the security event samples writer and purge
# (supabase/migrations/*_security_event_samples.sql).
# record_security_event_samples and purge_security_event_samples take one
# transaction advisory lock of their own (never the security events' lock),
# so one call runs at a time, and each gives up a wait after 2 s (the
# functions' own lock_timeout). This proves, with real sessions:
#
#   1. A writer call that waits behind another gives up with 55P03 after
#      about 2 s, and stores nothing.
#   2. Forty calls at once, half naming two paths in one order and half in
#      the other: no call fails (no deadlock) and the two counts are exact.
#   3. The purge waits for an open writer call the same way (55P03 after
#      about 2 s).
#   4. The two records never wait on each other: an open call of the
#      security events' writer does not hold up the samples' writer, and an
#      open call of the samples' writer does not hold up the events' writer.
#   5. The caps hold under concurrency: twenty calls at once, each naming
#      five new paths of one kind in one hour (a hundred in all), leave
#      exactly fifty listed rows and one overflow row counting the other
#      fifty, with no error.
#
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack, the migration scratch stack is
# supabase_db_spmig). It needs the head at or after this migration. Every
# sample row it writes is in one hour two hours back, of the kind
# admin_tool, under paths that start with /example-race/ (and that hour's
# overflow row of the kind); every security events row has a reason that
# starts with race_samples_. All of them are removed at the end. Exit
# status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0479_security_event_samples_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -At)
TMP="$(mktemp -d)"

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

if [ "$(q "select to_regprocedure('public.record_security_event_samples(jsonb)') is not null")" != "t" ]; then
  echo "needs the head at or after the security event samples migration"
  exit 1
fi

# The hour every sample row of this script is in: two hours back, as at_ms.
HOUR="$(q "select date_trunc('hour', now() - interval '2 hours', 'UTC')")"
AT="$(q "select floor(extract(epoch from date_trunc('hour', now() - interval '2 hours', 'UTC') + interval '30 minutes') * 1000)::bigint")"
cleanup_rows() {
  q "delete from public.security_event_samples
      where hour = '$HOUR' and reason = 'admin_tool'
        and (target like '/example-race/%' or target = '(more than could be listed)')" > /dev/null
  q "delete from public.security_events where reason like 'race\\_samples\\_%'" > /dev/null
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  cleanup_rows
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup_rows

el() { printf '{"category":"exploit","reason":"admin_tool","source":"web","method":"GET","target":"/example-race/%s","at_ms":%s}' "$1" "$AT"; }
AB="[$(el a),$(el b)]"
BA="[$(el b),$(el a)]"
EV='[{"category":"exploit","outcome":"blocked","reason":"race_samples_events","source":"web"}]'

# ── 1. A waiting writer gives up after about 2 s ───────────────────────────
printf "set application_name = 'samples-holder-1';\nbegin;\nset local role service_role;\nselect public.record_security_event_samples('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$AB" \
  | "${PSQL[@]}" > "$TMP/1.h.out" 2>&1 &
H1=$!
if ! wait_sleeping samples-holder-1; then
  bad "1: the holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.record_security_event_samples('$BA'::jsonb);")"
  T1="$(now_ms)"
  if [[ "$OUT" == *"lock timeout"* ]] && [ $((T1 - T0)) -ge 1800 ] && [ $((T1 - T0)) -le 3500 ]; then
    ok "1: the waiting call gave up after $((T1 - T0)) ms with a lock timeout"
  else
    bad "1: the waiting call answered after $((T1 - T0)) ms: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
fi
wait "$H1"
LEFT="$(q "select count(*) from public.security_event_samples where hour = '$HOUR' and target like '/example-race/%'")"
if [ "$LEFT" = "0" ]; then ok "1: neither call stored a row (one rolled back, one gave up)"; else bad "1: $LEFT rows were stored"; fi

# ── 2. Forty calls at once, opposite orders ────────────────────────────────
PIDS=()
for i in $(seq 1 20); do
  ( q "set role service_role; select public.record_security_event_samples('$AB'::jsonb);" > "$TMP/2.a.$i" ) &
  PIDS+=($!)
  ( q "set role service_role; select public.record_security_event_samples('$BA'::jsonb);" > "$TMP/2.b.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
ANSWERS="$(python3 - "$TMP" <<'PY'
import glob, json, sys
good = bad = 0
for f in glob.glob(sys.argv[1] + '/2.*'):
    t = open(f).read().strip()
    try:
        a = json.loads(t)
        good += 1 if a.get('stored') == 2 and a.get('skipped') == 0 and a.get('overflowed') == 0 else 0
        bad += 0 if a.get('stored') == 2 else 1
    except ValueError:
        bad += 1
print('%d:%d' % (good, bad))
PY
)"
SUMS="$(q "select coalesce(string_agg(target || '=' || event_count, ',' order by target), 'none') from public.security_event_samples where hour = '$HOUR' and target like '/example-race/%'")"
if [ "$ANSWERS" = "40:0" ] && [ "$SUMS" = "/example-race/a=40,/example-race/b=40" ]; then
  ok "2: forty calls in opposite orders, each stored both, no error, counts exact ($SUMS)"
else
  bad "2: answers good:bad $ANSWERS; counts: $SUMS (expected /example-race/a=40,/example-race/b=40)"
fi
cleanup_rows

# ── 3. The purge waits for an open writer call ─────────────────────────────
printf "set application_name = 'samples-holder-3';\nbegin;\nset local role service_role;\nselect public.record_security_event_samples('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$AB" \
  | "${PSQL[@]}" > "$TMP/3.h.out" 2>&1 &
H3=$!
if ! wait_sleeping samples-holder-3; then
  bad "3: the holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.purge_security_event_samples();")"
  T1="$(now_ms)"
  if [[ "$OUT" == *"lock timeout"* ]] && [ $((T1 - T0)) -ge 1800 ] && [ $((T1 - T0)) -le 3500 ]; then
    ok "3: the purge gave up after $((T1 - T0)) ms behind an open writer call"
  else
    bad "3: the purge answered after $((T1 - T0)) ms: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
fi
wait "$H3"

# ── 4. The two records never wait on each other ────────────────────────────
printf "set application_name = 'samples-holder-4a';\nbegin;\nset local role service_role;\nselect public.record_security_events('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$EV" \
  | "${PSQL[@]}" > "$TMP/4a.h.out" 2>&1 &
H4=$!
if ! wait_sleeping samples-holder-4a; then
  bad "4: the events' holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select (public.record_security_event_samples('$AB'::jsonb) ->> 'stored');")"
  T1="$(now_ms)"
  if [ "$OUT" = "2" ] && [ $((T1 - T0)) -lt 1000 ]; then
    ok "4: an open call of the events' writer did not hold up the samples' writer ($((T1 - T0)) ms, both stored)"
  else
    bad "4: the samples' writer answered '$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-120)' after $((T1 - T0)) ms behind the events' writer"
  fi
fi
wait "$H4"
printf "set application_name = 'samples-holder-4b';\nbegin;\nset local role service_role;\nselect public.record_security_event_samples('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$AB" \
  | "${PSQL[@]}" > "$TMP/4b.h.out" 2>&1 &
H4B=$!
if ! wait_sleeping samples-holder-4b; then
  bad "4: the samples' holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.record_security_events('$EV'::jsonb);")"
  T1="$(now_ms)"
  if [ "$OUT" = "1" ] && [ $((T1 - T0)) -lt 1000 ]; then
    ok "4: an open call of the samples' writer did not hold up the events' writer ($((T1 - T0)) ms, stored)"
  else
    bad "4: the events' writer answered '$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-120)' after $((T1 - T0)) ms behind the samples' writer"
  fi
fi
wait "$H4B"
cleanup_rows

# ── 5. The caps under concurrency ──────────────────────────────────────────
PIDS=()
for i in $(seq 1 20); do
  BATCH="[$(el "cap-$i-1"),$(el "cap-$i-2"),$(el "cap-$i-3"),$(el "cap-$i-4"),$(el "cap-$i-5")]"
  ( q "set role service_role; select public.record_security_event_samples('$BATCH'::jsonb);" > "$TMP/5.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
TOTALS="$(python3 - "$TMP" <<'PY'
import glob, json, sys
stored = over = bad = 0
for f in glob.glob(sys.argv[1] + '/5.*'):
    try:
        a = json.loads(open(f).read().strip())
        stored += a['stored']; over += a['overflowed']
    except (ValueError, KeyError, TypeError):
        bad += 1
print('%d:%d:%d' % (stored, over, bad))
PY
)"
ROWS="$(q "select count(*) filter (where target like '/example-race/%') || ':' || count(*) filter (where target = '(more than could be listed)') || ':' || coalesce(sum(event_count) filter (where target = '(more than could be listed)'), 0) from public.security_event_samples where hour = '$HOUR' and reason = 'admin_tool'")"
if [ "$TOTALS" = "50:50:0" ] && [ "$ROWS" = "50:1:50" ]; then
  ok "5: twenty calls at once with a hundred new paths: 50 listed, one overflow row counting 50, no error"
else
  bad "5: answers stored:overflowed:failed $TOTALS (expected 50:50:0); rows listed:overflow:counted $ROWS (expected 50:1:50)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$FAILS check(s) failed"
fi
exit "$FAILS"
