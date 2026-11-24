#!/usr/bin/env bash
#
# Two-session checks of the vendor risk reviews
# (supabase/migrations/*_supplier_risk_reviews.sql). The daily job claims a
# reminder by stamping it first (supplier_risk_reminder_claim: a guarded
# UPDATE under READ COMMITTED, a lock wait ends after 2 s), offers a due
# reminder never confirmed once more 24 hours on (the same function's second
# guarded UPDATE) and confirms what it sent (supplier_risk_due_reminder_sent,
# one guarded UPDATE); the admins'
# writes take one advisory lock for the supplier (a wait ends after 5 s).
# Two job runs that overlap must send each reminder once, and two admins
# finishing the same supplier's review at once must still leave one current
# review. This proves, with real sessions:
#
#   1. Twenty sessions claim the same due reminder at once: one true,
#      nineteen false, no error; the stamp is set and the review leaves the
#      job's list.
#   2. Ten sessions claim a 30-day reminder as due_soon and ten as due, at
#      once: one true (a due_soon one); the due stamp stays empty.
#   3. A claim that waits behind a lock on the review gives up with 55P03
#      after about 2 s and stamps nothing; claimed again afterwards, it is
#      true once.
#   4. A claim that waits behind an admin finishing a new version of the
#      same supplier: once the finish commits, the claim reads the row again,
#      finds it is no longer current, and stamps nothing (false); the new
#      version is the current one.
#   5. Twenty admins' sessions finish the same supplier's review at once:
#      all twenty succeed, the versions are 1 to 20 each once, exactly one is
#      current and it is version 20.
#   6. Twenty sessions save a draft of one supplier at once: no error, one
#      draft row, every session got the same review and version.
#   7. Ten finishes and ten draft saves of one supplier at once: no error;
#      the versions run 1 to N with no gap, one current (the newest final),
#      at most one draft and then the newest version.
#   8. Twenty sessions make the second claim of one due reminder first
#      claimed 25 hours ago and never confirmed, at once: one true,
#      nineteen false; the second stamp is set beside the first, and the
#      review leaves the job's list.
#   9. Twenty sessions confirm one due reminder as sent, at once: one true,
#      nineteen false; the confirmation is stamped once.
#  10. Ten second claims and ten confirmations of one due reminder first
#      claimed 25 hours ago, at once: no error; one confirmation true; at
#      most one second claim true, and a second stamp exactly when one was;
#      the reminder ends confirmed.
#  11. No session anywhere met a deadlock or a serialization failure.
#
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack, the migration scratch stack is
# supabase_db_spmig). It needs the head at or after this migration. Every
# row it writes belongs to one made-up organization (b0481900-...) and its
# made-up account; the organization and the account are removed at the end,
# and their reviews, items and suppliers with them. Exit status 0 = every
# check passed.
#
# Usage: bash scripts/db-concurrency/0481_supplier_risk_reminder_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -At)
TMP="$(mktemp -d)"

NS=b0481900-0000-0000-0000
ORG="$NS-0000000000a1"
U1="$NS-0000000000c1"
S1="$NS-0000000000e1"
S2="$NS-0000000000e2"
S3="$NS-0000000000e3"
S4="$NS-0000000000e4"
S5="$NS-0000000000e5"
S6="$NS-0000000000e6"
S7="$NS-0000000000e7"
S8="$NS-0000000000e8"
S9="$NS-0000000000e9"
S10="$NS-0000000000ea"
R1="$NS-0000000000f1"
R2="$NS-0000000000f2"
R3="$NS-0000000000f3"
R5="$NS-0000000000f5"
R8="$NS-0000000000f8"
R9="$NS-0000000000f9"
R10="$NS-0000000000fa"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1" 2>&1; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
wait_app() { # wait_app <application_name> <wait_event_type or PgSleep>
  local _ n
  for _ in $(seq 1 100); do
    if [ "$2" = "PgSleep" ]; then
      n="$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = 'PgSleep'")"
    else
      n="$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = '$2'")"
    fi
    [ "$n" = "1" ] && return 0
    sleep 0.05
  done
  return 1
}
one_line() { tr '\n' ' ' < "$1" | sed 's/  */ /g' | cut -c1-240; }
# How many of the files hold the text (decided in python, not grep).
files_with() { # files_with <text> <file>...
  python3 - "$@" <<'PY'
import sys
needle = sys.argv[1]
print(sum(1 for f in sys.argv[2:] if needle in open(f, errors='replace').read()))
PY
}

remove_rows() {
  q "delete from public.organizations where id = '$ORG'" > /dev/null
  q "delete from auth.users where id = '$U1'" > /dev/null
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  remove_rows
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$(q "select to_regprocedure('public.supplier_risk_reminder_claim(uuid, text)') is not null")" != "t" ]; then
  echo "needs the head at or after the supplier risk reviews migration"
  exit 1
fi
if [ "$(q "select count(*) from public.organizations where id = '$ORG'")" != "0" ]; then
  echo "the made-up organization of an earlier run is still there; removing it first"
fi
remove_rows

# Every question asked with staff contact details answered Yes.
YES="$(q "select jsonb_object_agg(q.key, jsonb_build_object('answer', 'yes'))
            from public._supplier_risk_questions() q where not q.student_only")"
case "$YES" in '{"'*) ;; *) echo "could not read the question list: $YES"; exit 1 ;; esac

# A final, current review written straight into the table (as the reminders
# need dates the functions would not take): next review on today + $3 days,
# finished $4 days ago (the organization's zone is UTC), and when $5 is
# given, its due reminder first claimed $5 hours ago.
final_sql() { # final_sql <review id> <supplier id> <days to next review> <days since finished> [<hours since claimed>]
  local due="null"
  if [ -n "${5:-}" ]; then due="now() - interval '$5 hours'"; fi
  printf "insert into public.supplier_risk_reviews
    (id, organization_id, supplier_id, supplier_name, version, status, is_current, data_level, answers,
     starting_risk, evidence, residual_risk, hard_stops, computed_result, reviewer_id, reviewer_name,
     reviewed_at, reviewed_on, next_review_on, reminded_due_at)
  select '%s', '%s', '%s', 'Race fixture', 1, 'final', true, 'staff', a.ans,
         e ->> 'starting_risk', e ->> 'evidence', e ->> 'residual_risk',
         array(select jsonb_array_elements_text(e -> 'hard_stops')), e ->> 'result',
         null, 'Made-up Reviewer', now() - interval '%s days', a.day, (now() at time zone 'UTC')::date + %s, %s
    from (select '%s'::jsonb as ans, ((now() - interval '%s days') at time zone 'UTC')::date as day) a,
         lateral public._supplier_risk_evaluate(1::smallint, 'staff', a.ans, a.day) e;\n" \
    "$1" "$ORG" "$2" "$4" "$3" "$due" "$YES" "$4"
}

SETUP="$(q "
insert into auth.users (id, email, raw_user_meta_data)
  values ('$U1', 'race-0481-owner@test.local', '{\"full_name\": \"Made-up Race Owner\"}'::jsonb);
insert into public.organizations (id, name, slug, mfa_policy, timezone)
  values ('$ORG', 'Race Vendor Risk Org', 'b0481900-race', 'optional', 'UTC');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values ('$ORG', '$U1', 'owner', now());
insert into public.suppliers (id, organization_id, name) values
  ('$S1', '$ORG', 'Race Due Today Co'),
  ('$S2', '$ORG', 'Race Due Soon Co'),
  ('$S3', '$ORG', 'Race Locked Co'),
  ('$S4', '$ORG', 'Race Finish Twenty Co'),
  ('$S5', '$ORG', 'Race Claim And Finish Co'),
  ('$S6', '$ORG', 'Race Draft Twenty Co'),
  ('$S7', '$ORG', 'Race Mixed Writes Co'),
  ('$S8', '$ORG', 'Race Second Chance Co'),
  ('$S9', '$ORG', 'Race Confirm Co'),
  ('$S10', '$ORG', 'Race Second Chance And Confirm Co');
$(final_sql "$R1" "$S1" 0 200)
$(final_sql "$R2" "$S2" 20 200)
$(final_sql "$R3" "$S3" 0 200)
$(final_sql "$R5" "$S5" 0 200)
$(final_sql "$R8" "$S8" 0 200 25)
$(final_sql "$R9" "$S9" 0 200 1)
$(final_sql "$R10" "$S10" 0 200 25)
select 'setup done';" | tail -n 1)"
if [ "$SETUP" != "setup done" ]; then echo "setup failed: $SETUP"; exit 1; fi

# The daily job runs as service_role; an admin as authenticated with the
# owner's claims (the organization asks for no second step).
SR="set role service_role;"
ADMIN="set \"request.jwt.claims\" = '{\"sub\": \"$U1\", \"role\": \"authenticated\", \"aal\": \"aal1\"}';
set \"request.jwt.claim.sub\" = '$U1';
set role authenticated;"
claim() { printf "%s select public.supplier_risk_reminder_claim('%s', '%s');" "$SR" "$1" "$2"; }
sent() { printf "%s select public.supplier_risk_due_reminder_sent('%s');" "$SR" "$1"; }
finish() { printf "%s select public.supplier_risk_finalise('%s', '%s', 'staff', '%s'::jsonb)::text;" "$ADMIN" "$ORG" "$1" "$YES"; }
draft() {
  printf "%s select public.supplier_risk_draft_save('%s', '%s', 'staff', '{\"insurance\": {\"answer\": \"no\"}}'::jsonb)::text;" \
    "$ADMIN" "$ORG" "$1"
}
at_once() { # at_once <label> <count> <sql>: <count> sessions run <sql> together
  local i pids=()
  for i in $(seq 1 "$2"); do
    ( q "$3" > "$TMP/$1.$i" ) &
    pids+=($!)
  done
  local p
  for p in "${pids[@]}"; do wait "$p"; done
}
answers_of() { cat "$TMP/$1".* | sort | uniq -c | sed 's/^ *//' | tr '\n' ';'; }

# ── 1. Twenty claims of one due reminder ────────────────────────────────────
if [ "$(q "select count(*) from public.supplier_risk_reminders_due(500) d where d.review_id = '$R1' and d.kind = 'due'")" != "1" ]; then
  bad "1: the fixture's review is not on the job's list as due"
fi
at_once 1 20 "$(claim "$R1" due)"
A1="$(answers_of 1)"
if [ "$A1" = "19 f;1 t;" ] && [ "$(q "select reminded_due_at is not null and reminded_30_at is null from public.supplier_risk_reviews where id = '$R1'")" = "t" ] \
   && [ "$(q "select count(*) from public.supplier_risk_reminders_due(500) d where d.review_id = '$R1'")" = "0" ]; then
  ok "1: twenty claims at once: one true, nineteen false; stamped once and off the job's list"
else
  bad "1: the claims answered $A1"
fi

# ── 2. A 30-day reminder, claimed as due_soon and as due at once ────────────
if [ "$(q "select count(*) from public.supplier_risk_reminders_due(500) d where d.review_id = '$R2' and d.kind = 'due_soon'")" != "1" ]; then
  bad "2: the fixture's review is not on the job's list as due_soon"
fi
PIDS=()
for i in $(seq 1 10); do
  ( q "$(claim "$R2" due_soon)" > "$TMP/2s.$i" ) &
  PIDS+=($!)
  ( q "$(claim "$R2" due)" > "$TMP/2d.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
A2S="$(answers_of 2s)"
A2D="$(answers_of 2d)"
if [ "$A2S" = "9 f;1 t;" ] && [ "$A2D" = "10 f;" ] \
   && [ "$(q "select reminded_30_at is not null and reminded_due_at is null from public.supplier_risk_reviews where id = '$R2'")" = "t" ]; then
  ok "2: due_soon $A2S due $A2D: one 30-day claim, the due stamp still empty"
else
  bad "2: due_soon answered $A2S and due $A2D"
fi

# ── 3. A claim waiting behind a lock on the review ──────────────────────────
printf "set application_name = 'vr-holder-3';\nbegin;\nselect 1 from public.supplier_risk_reviews where id = '%s' for update;\nselect pg_sleep(4);\nrollback;\n" "$R3" \
  | "${PSQL[@]}" > "$TMP/3.holder" 2>&1 &
H3=$!
if ! wait_app vr-holder-3 PgSleep; then
  bad "3: the holder never reached its sleep: $(one_line "$TMP/3.holder")"
else
  T0="$(now_ms)"
  OUT3="$(q "$(claim "$R3" due)")"
  T1="$(now_ms)"
  if [[ "$OUT3" == *"lock timeout"* ]] && [ $((T1 - T0)) -ge 1800 ] && [ $((T1 - T0)) -le 3500 ]; then
    ok "3: the waiting claim gave up after $((T1 - T0)) ms with a lock timeout"
  else
    bad "3: the waiting claim answered after $((T1 - T0)) ms: $(printf '%s' "$OUT3" | tr '\n' ' ' | cut -c1-160)"
  fi
fi
wait "$H3"
if [ "$(q "select reminded_due_at is null from public.supplier_risk_reviews where id = '$R3'")" = "t" ]; then
  ok "3: the claim that gave up stamped nothing"
else
  bad "3: the claim that gave up left a stamp"
fi
at_once 3b 5 "$(claim "$R3" due)"
A3B="$(answers_of 3b)"
if [ "$A3B" = "4 f;1 t;" ]; then ok "3: claimed again afterwards: one true among five"; else bad "3: claimed again: $A3B"; fi

# ── 4. A claim waiting behind a finish of a new version ─────────────────────
printf "set application_name = 'vr-holder-4';\nbegin;\n%s\nselect pg_sleep(1);\ncommit;\n" \
  "$(finish "$S5")" | "${PSQL[@]}" > "$TMP/4.holder" 2>&1 &
H4=$!
if ! wait_app vr-holder-4 PgSleep; then
  bad "4: the finish never reached its sleep: $(one_line "$TMP/4.holder")"
  wait "$H4"
else
  T0="$(now_ms)"
  OUT4="$(q "$(claim "$R5" due)")"
  T1="$(now_ms)"
  wait "$H4"
  FACTS4="$(q "select string_agg(r.version || ':' || r.status || ':' || r.is_current || ':' || (r.reminded_due_at is null), ',' order by r.version)
                 from public.supplier_risk_reviews r where r.supplier_id = '$S5'")"
  if [ "$OUT4" = "f" ] && [ $((T1 - T0)) -ge 300 ] && [ "$FACTS4" = "1:final:false:true,2:final:true:true" ] \
     && [ "$(files_with '"version": 2' "$TMP/4.holder")" = "1" ]; then
    ok "4: the claim waited $((T1 - T0)) ms for the finish, then stamped nothing (false); version 2 is current"
  else
    bad "4: the claim answered '$OUT4' after $((T1 - T0)) ms; rows $FACTS4; finish $(one_line "$TMP/4.holder")"
  fi
fi

# ── 5. Twenty finishes of one supplier at once ──────────────────────────────
at_once 5 20 "$(finish "$S4")"
ERR5="$(files_with ERROR "$TMP"/5.*)"
FACTS5="$(q "select count(*) || '/' || count(distinct version) || '/' || min(version) || '/' || max(version) || '/'
                    || count(*) filter (where is_current) || '/' || coalesce(max(version) filter (where is_current), 0)
                    || '/' || count(*) filter (where status = 'draft')
               from public.supplier_risk_reviews where supplier_id = '$S4'")"
if [ "$ERR5" = "0" ] && [ "$FACTS5" = "20/20/1/20/1/20/0" ]; then
  ok "5: twenty finishes at once: all took, versions 1 to 20 once each, one current (version 20)"
else
  bad "5: $ERR5 errors; rows (all/distinct/min/max/current/current version/drafts) $FACTS5; $(one_line "$TMP/5.1")"
fi

# ── 6. Twenty draft saves of one supplier at once ───────────────────────────
at_once 6 20 "$(draft "$S6")"
ERR6="$(files_with ERROR "$TMP"/6.*)"
SAME6="$(python3 - "$TMP" <<'PY'
import glob, json, sys
seen = set()
for f in glob.glob(sys.argv[1] + '/6.*'):
    try:
        a = json.loads(open(f).read().strip())
        seen.add((a['review_id'], a['version']))
    except Exception:
        seen.add(('unreadable', f))
print(len(seen), sorted(v for _, v in seen if isinstance(v, int)))
PY
)"
FACTS6="$(q "select count(*) || '/' || count(*) filter (where status = 'draft') || '/' || max(version)
               from public.supplier_risk_reviews where supplier_id = '$S6'")"
if [ "$ERR6" = "0" ] && [ "$SAME6" = "1 [1]" ] && [ "$FACTS6" = "1/1/1" ]; then
  ok "6: twenty draft saves at once: no error, one draft (version 1), the same review for every session"
else
  bad "6: $ERR6 errors; answers $SAME6; rows (all/drafts/max version) $FACTS6; $(one_line "$TMP/6.1")"
fi

# ── 7. Ten finishes and ten draft saves of one supplier at once ─────────────
PIDS=()
for i in $(seq 1 10); do
  ( q "$(finish "$S7")" > "$TMP/7f.$i" ) &
  PIDS+=($!)
  ( q "$(draft "$S7")" > "$TMP/7d.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
ERR7="$(files_with ERROR "$TMP"/7f.* "$TMP"/7d.*)"
FACTS7="$(q "select (count(*) = max(version) and count(distinct version) = count(*) and min(version) = 1)
                    || '/' || (count(*) filter (where is_current) = 1)
                    || '/' || (max(version) filter (where is_current) = max(version) filter (where status = 'final'))
                    || '/' || (count(*) filter (where status = 'draft') <= 1)
                    || '/' || (coalesce(max(version) filter (where status = 'draft'), max(version)) = max(version))
                    || '/' || (count(*) filter (where status = 'final') = 10)
               from public.supplier_risk_reviews where supplier_id = '$S7'")"
if [ "$ERR7" = "0" ] && [ "$FACTS7" = "true/true/true/true/true/true" ]; then
  ok "7: ten finishes and ten draft saves at once: no error; versions 1 to N with no gap, ten finals, one current (the newest final), at most one draft and the newest"
else
  bad "7: $ERR7 errors; checks $FACTS7; $(one_line "$TMP/7f.1") $(one_line "$TMP/7d.1")"
fi

# ── 8. Twenty second claims of one due reminder at once ─────────────────────
if [ "$(q "select count(*) from public.supplier_risk_reminders_due(500) d where d.review_id = '$R8' and d.kind = 'due' and d.attempt = 2")" != "1" ]; then
  bad "8: the fixture's review is not on the job's list for its second chance"
fi
at_once 8 20 "$(claim "$R8" due)"
A8="$(answers_of 8)"
if [ "$A8" = "19 f;1 t;" ] \
   && [ "$(q "select reminded_due_retry_at is not null and reminded_due_at < now() - interval '24 hours' and reminded_due_sent_at is null
                from public.supplier_risk_reviews where id = '$R8'")" = "t" ] \
   && [ "$(q "select count(*) from public.supplier_risk_reminders_due(500) d where d.review_id = '$R8'")" = "0" ]; then
  ok "8: twenty second claims at once: one true, nineteen false; the second stamp beside the first, and off the job's list"
else
  bad "8: the second claims answered $A8"
fi

# ── 9. Twenty confirmations of one due reminder at once ─────────────────────
at_once 9 20 "$(sent "$R9")"
A9="$(answers_of 9)"
if [ "$A9" = "19 f;1 t;" ] \
   && [ "$(q "select reminded_due_sent_at is not null and reminded_due_retry_at is null from public.supplier_risk_reviews where id = '$R9'")" = "t" ]; then
  ok "9: twenty confirmations at once: one true, nineteen false; confirmed once"
else
  bad "9: the confirmations answered $A9"
fi

# ── 10. Ten second claims and ten confirmations at once ─────────────────────
PIDS=()
for i in $(seq 1 10); do
  ( q "$(claim "$R10" due)" > "$TMP/10c.$i" ) &
  PIDS+=($!)
  ( q "$(sent "$R10")" > "$TMP/10s.$i" ) &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
ERR10="$(files_with ERROR "$TMP"/10c.* "$TMP"/10s.*)"
A10C="$(answers_of 10c)"
A10S="$(answers_of 10s)"
FACTS10="$(q "select (reminded_due_sent_at is not null) || '/' || (reminded_due_retry_at is not null) from public.supplier_risk_reviews where id = '$R10'")"
if [ "$ERR10" = "0" ] && [ "$A10S" = "9 f;1 t;" ] \
   && { { [ "$A10C" = "10 f;" ] && [ "$FACTS10" = "true/false" ]; } || { [ "$A10C" = "9 f;1 t;" ] && [ "$FACTS10" = "true/true" ]; }; }; then
  ok "10: ten second claims and ten confirmations at once: no error; claims $A10C confirmations $A10S; confirmed, second stamp $FACTS10"
else
  bad "10: $ERR10 errors; claims $A10C confirmations $A10S; sent/second stamp $FACTS10; $(one_line "$TMP/10c.1")"
fi

# ── 11. No deadlock, no serialization failure ───────────────────────────────
N11=0
for w in 40P01 40001 deadlock 'could not serialize'; do N11=$((N11 + $(files_with "$w" "$TMP"/*))); done
if [ "$N11" != "0" ]; then
  bad "11: a session met a deadlock or a serialization failure"
else
  ok "11: no session met a deadlock or a serialization failure"
fi

remove_rows
LEFT="$(q "select (select count(*) from public.organizations where id = '$ORG')
                + (select count(*) from auth.users where id = '$U1')
                + (select count(*) from public.supplier_risk_reviews where organization_id = '$ORG')
                + (select count(*) from public.suppliers where organization_id = '$ORG')")"
if [ "$LEFT" = "0" ]; then ok "the made-up organization, account, suppliers and reviews are removed"; else bad "$LEFT made-up rows are left"; fi

if [ "$FAILS" -eq 0 ]; then
  echo "all checks passed"
  exit 0
fi
echo "$FAILS check(s) failed"
exit 1
