#!/usr/bin/env bash
#
# Two-session checks of the platform console's security alerts
# (supabase/migrations/*_platform_security_alerts.sql). The claim, the
# result, the heartbeat, the set, the baseline and the purge take one
# transaction advisory lock of their own (never the security events' or the
# samples'), so one runs at a time, and each gives up a wait after 2 s (the
# functions' own lock_timeout). Two alert jobs that overlap (a slow run and
# the next one) must still send each alert once. This proves, with real
# sessions:
#
#   1. A claim that waits behind another gives up with 55P03 after about
#      2 s, and stores nothing.
#   2. Twenty sessions claim the same alert at once: one is new and hands
#      out the push and the email, nineteen are duplicates that hand out
#      nothing; one row.
#   3. A subject of null and of '' at once (ten sessions each): one row.
#   4. An hour edge: an event at minute 59 of an hour; twenty sessions, some
#      reading the inputs later than others, each claim the key the inputs
#      give for it: every session read the same key (the event's hour), one
#      row, one send.
#   5. A claim with no result: 5 minutes later twenty sessions claim it, one
#      gets the retry (attempt 2) and nineteen are duplicates; 5 minutes after
#      that, twenty more: one marks it not_sent, nineteen are duplicates, and
#      it is never handed out again.
#   6. The budgets hold under concurrency: twenty serious flags at once give
#      exactly 6 pushes and 14 email-only, every one by email; twenty
#      guessing alerts for twenty organizations at once give exactly 8
#      pushes.
#   7. Two runs overlap: the first run's finish is refused (not the latest
#      run), the second's is taken; twenty heartbeat starts at once all
#      answer with no error.
#   8. The alerts and the security events never wait on each other: an open
#      claim does not hold up the events' writer, and an open call of the
#      events' writer does not hold up a claim.
#   9. A serious flag's retry comes first: a serious flag claimed 30 minutes
#      ago with no result, its hour now 9 hours back (out of the read's
#      window), beside 101 volume alerts due their retry; twenty sessions at
#      once each start a run, read the inputs and claim the first serious
#      flag listed: no start marks anything not_sent, every read that lists
#      it lists the volume alerts apart (100, truncated), exactly one session
#      gets the retry (attempt 2) and none a refusal.
#  10. The held notice is made once: with email alone on, the summary off and
#      the day's 24 volume emails spent, twenty guessing alerts for twenty
#      organizations at once are each held with a notice, and exactly one of
#      the twenty answers carries the notice (one alerts_held row, by email,
#      counting the one alert held when it was made).
#
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack, the migration scratch stack is
# supabase_db_spmig). It needs the head at or after this migration. The
# state row is saved first and put back as it was at the end; every alert
# this script claims carries the counts key race_check_0480, every security
# events row it writes a dedupe key made from a0480-race-, every events
# writer call a reason that starts with race_alerts_; all of them are
# removed at the end, and so is each notice the script made (by its id).
# Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0480_platform_security_alerts_race.sh

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
# outcome counts of a set of answer files, as 'new:retry:duplicate:not_sent:refused:other:pushes:emails'
tally() {
  python3 - "$TMP" "$1" <<'PY'
import glob, json, sys
c = dict(new=0, retry=0, duplicate=0, not_sent=0, refused=0, other=0)
pushes = emails = 0
for f in glob.glob(sys.argv[1] + '/' + sys.argv[2] + '.*'):
    for line in open(f).read().split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            a = json.loads(line)
            c[a['outcome'] if a.get('outcome') in c else 'other'] += 1
            pushes += 1 if a.get('push') is True else 0
            emails += 1 if a.get('email') is True else 0
        except ValueError:
            c['other'] += 1
print(':'.join(str(c[k]) for k in ('new', 'retry', 'duplicate', 'not_sent', 'refused', 'other')) + ':%d:%d' % (pushes, emails))
PY
}

if [ "$(q "select to_regprocedure('public.platform_security_alert_claim(text, text, text, text, jsonb)') is not null")" != "t" ]; then
  echo "needs the head at or after the platform security alerts migration"
  exit 1
fi

MARK='{"race_check_0480": 1}'
SAVED="$(q "select to_jsonb(s) from public.platform_security_alert_state s")"
case "$SAVED" in
  '{'*) ;;
  *) echo "could not read the state row: $SAVED"; exit 1 ;;
esac
cleanup_rows() {
  q "delete from public.platform_security_alerts where counts ? 'race_check_0480'" > /dev/null
  if [ -s "$TMP/notice_ids" ]; then
    q "delete from public.platform_security_alerts
        where rule = 'alerts_held' and id::text in ($(sed "s/.*/'&'/" "$TMP/notice_ids" | paste -sd, -))" > /dev/null
  fi
  q "delete from public.security_events
      where dedupe_key in (select md5('a0480-race-' || g) from generate_series(1, 20) g)
         or reason like 'race\\_alerts\\_%'" > /dev/null
}
# The state as the checks need it: both switches on, no planned check, the
# default thresholds.
known_state() {
  q "update public.platform_security_alert_state
        set email_on = true, push_on = true, planned_check_until = null, thresholds = default" > /dev/null
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  cleanup_rows
  q "begin;
     delete from public.platform_security_alert_state;
     insert into public.platform_security_alert_state
       select * from jsonb_populate_record(null::public.platform_security_alert_state, '$SAVED'::jsonb);
     commit;" > /dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup_rows
known_state

# Keys in the window: this hour and the three before it; a bucket an hour back.
HOUR0="$(q "select to_char(date_trunc('hour', now(), 'UTC') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24')")"
key_h() { q "select '$1|' || to_char(date_trunc('hour', now() - make_interval(hours => $2), 'UTC') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24') || ':00Z'"; }
BUCKET="$(q "select to_char(date_bin('10 minutes', now() - interval '1 hour', '2000-01-01 00:00:00+00') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') || 'Z'")"
claim_sql() { printf "set role service_role; select public.platform_security_alert_claim(%s, %s, '%s', 'started', '%s');" "$1" "$2" "$3" "$MARK"; }

# ── 1. A waiting claim gives up after about 2 s ────────────────────────────
K1="$(key_h sign_in_not_me 3)"
printf "set application_name = 'alerts-holder-1';\nbegin;\n%s\nselect pg_sleep(4);\nrollback;\n" "$(claim_sql "'serious_flag'" "''" "$K1")" \
  | "${PSQL[@]}" > "$TMP/1.h.out" 2>&1 &
H1=$!
if ! wait_sleeping alerts-holder-1; then
  bad "1: the holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "$(claim_sql "'serious_flag'" "''" "$K1")")"
  T1="$(now_ms)"
  if [[ "$OUT" == *"lock timeout"* ]] && [ $((T1 - T0)) -ge 1800 ] && [ $((T1 - T0)) -le 3500 ]; then
    ok "1: the waiting claim gave up after $((T1 - T0)) ms with a lock timeout"
  else
    bad "1: the waiting claim answered after $((T1 - T0)) ms: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
fi
wait "$H1"
LEFT="$(q "select count(*) from public.platform_security_alerts where counts ? 'race_check_0480'")"
if [ "$LEFT" = "0" ]; then ok "1: neither claim stored a row (one rolled back, one gave up)"; else bad "1: $LEFT rows were stored"; fi

# ── 2. Twenty sessions, one alert ──────────────────────────────────────────
K2="$(key_h passkey_counter_went_back 1)"
PIDS=()
for i in $(seq 1 20); do
  ( q "$(claim_sql "'serious_flag'" "''" "$K2")" > "$TMP/2.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
T2="$(tally 2)"
ROWS="$(q "select count(*) || ':' || bool_and(push_planned and email_planned) from public.platform_security_alerts where rule = 'serious_flag' and event_key = '$K2' and counts ? 'race_check_0480'")"
if [ "$T2" = "1:0:19:0:0:0:1:1" ] && [ "$ROWS" = "1:true" ]; then
  ok "2: twenty sessions, one alert: one new (one push, one email), nineteen duplicates, one row"
else
  bad "2: new:retry:duplicate:not_sent:refused:other:pushes:emails $T2 (expected 1:0:19:0:0:0:1:1); rows $ROWS"
fi

# ── 3. A subject of null and of '' at once ─────────────────────────────────
PIDS=()
for i in $(seq 1 10); do
  ( q "$(claim_sql "'spike'" "null" "$BUCKET")" > "$TMP/3.n.$i" ) &
  PIDS+=($!)
  ( q "$(claim_sql "'spike'" "''" "$BUCKET")" > "$TMP/3.e.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
T3="$(tally 3)"
ROWS="$(q "select count(*) || ':' || coalesce(string_agg(subject, ','), '-') from public.platform_security_alerts where rule = 'spike' and event_key = '$BUCKET' and counts ? 'race_check_0480'")"
if [ "${T3%:*:*}" = "1:0:19:0:0:0" ] && [ "$ROWS" = "1:" ]; then
  ok "3: ten sessions with a subject of null and ten of '': one new, nineteen duplicates, one row with subject ''"
else
  bad "3: new:retry:duplicate:not_sent:refused:other $T3 (expected 1:0:19:0:0:0); rows:subjects $ROWS"
fi

# ── 4. An hour edge ────────────────────────────────────────────────────────
# An event at minute 59 of the hour before this one; each session reads the
# inputs (some later than others) and claims the key they give for it.
q "insert into public.security_events (minute, category, outcome, reason, source, event_count, last_seen_at, dedupe_key)
   values (date_trunc('hour', now(), 'UTC') - interval '1 minute', 'phishing', 'flagged', 'passkey_unexplained_sign_in',
           'web', 1, date_trunc('hour', now(), 'UTC') - interval '1 minute', md5('a0480-race-1'))" > /dev/null
K4="$(key_h passkey_unexplained_sign_in 1)"
K4_SQL="set role service_role;
  select pg_sleep(%s);
  select e ->> 'event_key' || ' ' || public.platform_security_alert_claim('serious_flag', '', e ->> 'event_key', 'started', '$MARK')::text
    from jsonb_array_elements(public.platform_security_alert_inputs() -> 'serious') e
   where e ->> 'reason' = 'passkey_unexplained_sign_in';"
PIDS=()
for i in $(seq 1 20); do
  # shellcheck disable=SC2059  # the format is this script's own
  ( q "$(printf "$K4_SQL" "0.0$((i % 10))")" > "$TMP/r4.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
KEYS="$(cat "$TMP"/r4.* | awk 'NF { print $1 }' | sort -u | tr '\n' ' ' | sed 's/ $//')"
for i in $(seq 1 20); do awk 'NF { sub(/^[^ ]* /, ""); print }' "$TMP/r4.$i" > "$TMP/4.$i"; done
T4="$(tally 4)"
ROWS="$(q "select count(*) from public.platform_security_alerts where rule = 'serious_flag' and event_key like 'passkey\\_unexplained\\_sign\\_in|%' and counts ? 'race_check_0480'")"
if [ "$KEYS" = "$K4" ] && [ "$T4" = "1:0:19:0:0:0:1:1" ] && [ "$ROWS" = "1" ]; then
  ok "4: an event at minute 59 of an hour: twenty sessions read the key $K4 (the event's hour), one new and sent once, nineteen duplicates, one row"
else
  bad "4: keys read '$KEYS' (expected $K4); new:retry:duplicate:not_sent:refused:other:pushes:emails $T4 (expected 1:0:19:0:0:0:1:1); rows $ROWS"
fi

# ── 5. The one retry, then not_sent ────────────────────────────────────────
K5="$(key_h sign_in_not_me 2)"
q "$(claim_sql "'serious_flag'" "''" "$K5")" > "$TMP/5.first"
q "update public.platform_security_alerts set claimed_at = claimed_at - interval '5 minutes'
    where rule = 'serious_flag' and event_key = '$K5' and counts ? 'race_check_0480'" > /dev/null
PIDS=()
for i in $(seq 1 20); do
  ( q "$(claim_sql "'serious_flag'" "''" "$K5")" > "$TMP/5r.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
T5R="$(tally 5r)"
q "update public.platform_security_alerts set claimed_at = claimed_at - interval '5 minutes'
    where rule = 'serious_flag' and event_key = '$K5' and counts ? 'race_check_0480'" > /dev/null
PIDS=()
for i in $(seq 1 20); do
  ( q "$(claim_sql "'serious_flag'" "''" "$K5")" > "$TMP/5n.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
T5N="$(tally 5n)"
q "update public.platform_security_alerts set claimed_at = claimed_at - interval '1 hour'
    where rule = 'serious_flag' and event_key = '$K5' and counts ? 'race_check_0480'" > /dev/null
T5L="$(q "$(claim_sql "'serious_flag'" "''" "$K5")" | python3 -c 'import json,sys; a=json.loads(sys.stdin.read()); print(a["outcome"], a["push"], a["email"])')"
ROW="$(q "select disposition || ':' || attempts || ':' || (resulted_at is null) from public.platform_security_alerts where rule = 'serious_flag' and event_key = '$K5' and counts ? 'race_check_0480'")"
if [ "$T5R" = "0:1:19:0:0:0:1:1" ] && [ "$T5N" = "0:0:19:1:0:0:0:0" ] && [ "$T5L" = "duplicate False False" ] && [ "$ROW" = "not_sent:2:true" ]; then
  ok "5: 5 minutes with no result: one of twenty sessions got the retry (attempt 2), nineteen duplicates; 5 more: one marked it not_sent, nineteen duplicates; never handed out again"
else
  bad "5: retry round $T5R (expected 0:1:19:0:0:0:1:1); not_sent round $T5N (expected 0:0:19:1:0:0:0:0); later '$T5L'; row $ROW"
fi
cleanup_rows

# ── 6. The budgets under concurrency ───────────────────────────────────────
PIDS=()
n=0
for r in passkey_counter_went_back passkey_unexplained_sign_in sign_in_not_me unrecorded_server_form_password unrecorded_server_form_code; do
  for h in 0 1 2 3; do
    n=$((n + 1))
    K="$(key_h "$r" "$h")"
    ( q "$(claim_sql "'serious_flag'" "''" "$K")" > "$TMP/6s.$n" ) &
    PIDS+=($!)
  done
done
for p in "${PIDS[@]}"; do wait "$p"; done
T6S="$(tally 6s)"
D6S="$(q "select string_agg(disposition || '=' || c, ',' order by disposition) from (select disposition, count(*) c from public.platform_security_alerts where rule = 'serious_flag' and counts ? 'race_check_0480' group by 1) x")"
PIDS=()
for i in $(seq 1 20); do
  ORG="$(printf 'a0480000-0000-4000-8000-%012d' "$i")"
  ( q "$(claim_sql "'aimed_guessing'" "'$ORG'" "$BUCKET")" > "$TMP/6v.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
T6V="$(tally 6v)"
if [ "$T6S" = "20:0:0:0:0:0:6:20" ] && [ "$D6S" = "email_only_budget=14,sent=6" ] && [ "$T6V" = "20:0:0:0:0:0:8:20" ]; then
  ok "6: twenty serious flags at once: 6 pushes and 14 email-only, all twenty by email; twenty guessing alerts at once: exactly 8 pushes"
else
  bad "6: serious $T6S (expected 20:0:0:0:0:0:6:20), dispositions $D6S; guessing $T6V (expected 20:0:0:0:0:0:8:20)"
fi
cleanup_rows

# ── 7. Two runs overlap ────────────────────────────────────────────────────
RUN_A="$(q "set role service_role; select public.platform_security_alert_heartbeat('start') ->> 'run_id'")"
RUN_B="$(q "set role service_role; select public.platform_security_alert_heartbeat('start') ->> 'run_id'")"
FIN_A="$(q "set role service_role; select public.platform_security_alert_heartbeat('finish', '$RUN_A', true) ->> 'refused'")"
FIN_B="$(q "set role service_role; select coalesce(public.platform_security_alert_heartbeat('finish', '$RUN_B', true) ->> 'refused', 'taken')")"
PIDS=()
for i in $(seq 1 20); do
  ( q "set role service_role; select public.platform_security_alert_heartbeat('start')" > "$TMP/7.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
T7="$(python3 - "$TMP" <<'PY'
import glob, json, sys
good = bad = 0
runs = set()
for f in glob.glob(sys.argv[1] + '/7.*'):
    try:
        a = json.loads(open(f).read().strip())
        if a.get('step') == 'start' and a.get('refused') is None and a.get('run_id'):
            good += 1
            runs.add(a['run_id'])
        else:
            bad += 1
    except ValueError:
        bad += 1
print('%d:%d:%d' % (good, bad, len(runs)))
PY
)"
if [ "$FIN_A" = "not_the_latest_run" ] && [ "$FIN_B" = "taken" ] && [ "$T7" = "20:0:20" ]; then
  ok "7: two runs overlap: the first's finish is refused (not_the_latest_run), the second's taken; twenty starts at once, each a run of its own, no error"
else
  bad "7: first finish '$FIN_A', second '$FIN_B'; starts good:bad:runs $T7 (expected 20:0:20)"
fi

# ── 8. The alerts and the security events never wait on each other ─────────
EV='[{"category":"exploit","outcome":"blocked","reason":"race_alerts_events","source":"web"}]'
printf "set application_name = 'alerts-holder-8a';\nbegin;\n%s\nselect pg_sleep(4);\nrollback;\n" "$(claim_sql "'record_trouble'" "''" "$BUCKET")" \
  | "${PSQL[@]}" > "$TMP/8a.h.out" 2>&1 &
H8=$!
if ! wait_sleeping alerts-holder-8a; then
  bad "8: the claim holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "set role service_role; select public.record_security_events('$EV'::jsonb);")"
  T1="$(now_ms)"
  if [ "$OUT" = "1" ] && [ $((T1 - T0)) -lt 1000 ]; then
    ok "8: an open claim did not hold up the events' writer ($((T1 - T0)) ms, stored)"
  else
    bad "8: the events' writer answered '$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-120)' after $((T1 - T0)) ms behind a claim"
  fi
fi
wait "$H8"
printf "set application_name = 'alerts-holder-8b';\nbegin;\nset local role service_role;\nselect public.record_security_events('%s'::jsonb);\nselect pg_sleep(4);\nrollback;\n" "$EV" \
  | "${PSQL[@]}" > "$TMP/8b.h.out" 2>&1 &
H8B=$!
if ! wait_sleeping alerts-holder-8b; then
  bad "8: the events' holder never reached pg_sleep"
else
  T0="$(now_ms)"
  OUT="$(q "$(claim_sql "'record_trouble'" "''" "$BUCKET")" | python3 -c 'import json,sys
t=sys.stdin.read().strip()
try: print(json.loads(t)["outcome"])
except Exception: print(t)')"
  T1="$(now_ms)"
  if [ "$OUT" = "new" ] && [ $((T1 - T0)) -lt 1000 ]; then
    ok "8: an open call of the events' writer did not hold up a claim ($((T1 - T0)) ms, new)"
  else
    bad "8: the claim answered '$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-120)' after $((T1 - T0)) ms behind the events' writer"
  fi
fi
wait "$H8B"

# ── 9. A serious flag's retry comes first ─────────────────────────────────
known_state
K9="$(key_h unrecorded_server_form_password 9)"
q "insert into public.platform_security_alerts (rule, class, subject, event_key, phase, counts, disposition, email_planned, claimed_at)
   select 'aimed_guessing', 'volume', 'a0480000-0000-4000-8000-' || lpad(g::text, 12, '0'), '$BUCKET', 'started',
          '$MARK'::jsonb, 'sent', true, now() - interval '25 minutes'
     from generate_series(1, 101) g" > /dev/null
q "insert into public.platform_security_alerts (rule, class, subject, event_key, phase, counts, disposition, push_planned,
                                                email_planned, push_counted, claimed_at)
   values ('serious_flag', 'serious', '', '$K9', 'started', '$MARK'::jsonb, 'sent', true, true, true,
           now() - interval '30 minutes')" > /dev/null
K9_SQL="set role service_role;
  with i as (select public.platform_security_alert_inputs() as a)
  select coalesce((select public.platform_security_alert_claim(e ->> 'rule', e ->> 'subject', e ->> 'event_key', e ->> 'phase', '$MARK')
                     from jsonb_array_elements(i.a -> 'serious_retry_due') e limit 1)::text, '{\"outcome\": \"none\"}')
         || ' ' || jsonb_array_length(i.a -> 'serious_retry_due') || ':' || jsonb_array_length(i.a -> 'retry_due')
         || ':' || (i.a ->> 'retry_due_truncated')
    from i;"
PIDS=()
for i in $(seq 1 20); do
  ( { q "set role service_role; select public.platform_security_alert_heartbeat('start') ->> 'marked_not_sent'"; q "$K9_SQL"; } > "$TMP/r9.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
R9="$(python3 - "$TMP" <<'PY9'
import glob, json, sys
marked = set(); lists = set(); bad = 0
for f in glob.glob(sys.argv[1] + '/r9.*'):
    lines = [l for l in open(f).read().split('\n') if l.strip()]
    if len(lines) != 2:
        bad += 1
        continue
    marked.add(lines[0].strip())
    answer, _, seen = lines[1].rpartition(' ')
    n_serious, n_volume, truncated = seen.split(':')
    if n_serious == '1':
        lists.add(n_volume + ':' + truncated)
    open(f.replace('/r9.', '/9.'), 'w').write(answer + '\n')
print('marked=' + ','.join(sorted(marked)) + ' volume=' + ','.join(sorted(lists)) + ' bad=%d' % bad)
PY9
)"
T9="$(tally 9)"
ROW="$(q "select disposition || ':' || attempts || ':' || (resulted_at is null) from public.platform_security_alerts where rule = 'serious_flag' and event_key = '$K9' and counts ? 'race_check_0480'")"
IFS=: read -r N9 RT9 D9 NS9 RF9 O9 _ _ <<< "$T9"
if [ "$R9" = "marked=0 volume=100:true bad=0" ] && [ "$N9" = "0" ] && [ "$RT9" = "1" ] && [ "$NS9" = "0" ] && [ "$RF9" = "0" ] \
   && [ $((D9 + O9)) -eq 19 ] && [ "$ROW" = "sent:2:true" ]; then
  ok "9: a serious flag's retry with its hour out of the window beside 101 volume alerts due theirs: twenty runs at once marked nothing not_sent, listed it apart from the volume alerts (100, truncated), one got the retry (attempt 2), $D9 duplicates, $O9 found it already taken"
else
  bad "9: reads $R9 (expected marked=0 volume=100:true bad=0); new:retry:duplicate:not_sent:refused:other:pushes:emails $T9; row $ROW (expected sent:2:true)"
fi
cleanup_rows

# ── 10. The held notice is made once ──────────────────────────────────────
known_state
q "update public.platform_security_alert_state set push_on = false, summary_on = false" > /dev/null
PRIOR="$(q "select count(*) from public.platform_security_alerts where rule = 'alerts_held' and claimed_at > now() - interval '6 hours'")"
if [ "$PRIOR" != "0" ]; then
  bad "10: a held notice made in the last 6 hours is already on this stack ($PRIOR), so no new one can be made: not checked"
else
  q "insert into public.platform_security_alerts (rule, class, subject, event_key, phase, counts, disposition, email_planned, claimed_at)
     select 'aimed_guessing', 'volume', 'a0480000-0000-4000-8000-' || lpad(g::text, 12, '0'), '$BUCKET', 'started',
            '$MARK'::jsonb, 'sent', true, now() - interval '1 hour'
       from generate_series(101, 124) g" > /dev/null
  PIDS=()
  for i in $(seq 1 20); do
    ORG="$(printf 'a0480000-0000-4000-8000-%012d' "$i")"
    ( q "$(claim_sql "'aimed_guessing'" "'$ORG'" "$BUCKET")" > "$TMP/10.$i" ) &
    PIDS+=($!)
  done
  for p in "${PIDS[@]}"; do wait "$p"; done
  T10="$(tally 10)"
  N10="$(python3 - "$TMP" <<'PY10'
import glob, json, sys
notices = []; held = 0
for f in glob.glob(sys.argv[1] + '/10.*'):
    try:
        a = json.loads(open(f).read().strip())
    except ValueError:
        continue
    held += 1 if a.get('disposition') == 'held_with_notice' else 0
    if isinstance(a.get('notice'), dict):
        notices.append(a['notice'])
with open(sys.argv[1] + '/notice_ids', 'a') as out:
    for n in notices:
        out.write(n['id'] + '\n')
print('held=%d notices=%d channels=%s' % (held, len(notices), ','.join('%s/%s' % (n.get('push'), n.get('email')) for n in notices)))
PY10
)"
  ROWS="$(q "select count(*) || ':' || coalesce(string_agg(disposition || '/' || push_planned || '/' || email_planned || '/' || (counts ->> 'held'), ','), '-')
              from public.platform_security_alerts where rule = 'alerts_held' and claimed_at > now() - interval '6 hours'")"
  if [ "$T10" = "20:0:0:0:0:0:0:0" ] && [ "$N10" = "held=20 notices=1 channels=False/True" ] && [ "$ROWS" = "1:sent/false/true/1" ]; then
    ok "10: twenty guessing alerts at once past the day's 24 volume emails, the summary off: all twenty held with a notice, exactly one answer carries it, one notice row (by email, counting 1 held)"
  else
    bad "10: new:retry:duplicate:not_sent:refused:other:pushes:emails $T10 (expected 20:0:0:0:0:0:0:0); answers $N10 (expected held=20 notices=1 channels=False/True); notice rows $ROWS (expected 1:sent/false/true/1)"
  fi
fi
cleanup_rows

echo "hour of the run: ${HOUR0}Z"
if [ "$FAILS" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$FAILS check(s) failed"
fi
exit "$FAILS"
