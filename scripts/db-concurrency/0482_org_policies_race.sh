#!/usr/bin/env bash
#
# Two-session checks of policy sign-off (supabase/migrations/*_org_policies.sql).
# The reminder job may overlap itself (a slow run and the next one), a member
# may press "I have read and agree" twice, and an admin may publish while a
# member acknowledges. This proves, with real sessions:
#
#   1. Two claims overlap: while the first holds its transaction open, the
#      second answers busy at once and claims nothing; after the first
#      commits, a third claims nothing (every reminder was stamped). Each due
#      reminder is handed out exactly once.
#   2. Twenty claims at once over a fresh set of due reminders: together they
#      hand out each one exactly once (no account twice), and each row's count
#      is 1.
#   3. Twenty acknowledgements of one version by one member at once: one row;
#      exactly one answer says it was new.
#   4. A publish holding the policy row: an acknowledgement of the version it
#      replaces waits, then is refused (policy_version_not_current), so no
#      acknowledgement is ever of a version that was superseded meanwhile.
#      The other way round: a publish waits for an open acknowledgement, and
#      the acknowledgement stays. A wait longer than 2 s gives up with 55P03
#      and writes nothing.
#   5. Ten admins press Remind now at once: one reminds, nine are told it is
#      too soon.
#
# LOCAL stack only (docker container supabase_db_stockpilot by default;
# CONTAINER=<name> for another local stack, the migration scratch stack is
# supabase_db_spmig). It needs the head at or after this migration. Every
# organization, account and text it writes is made up and carries the
# namespace a0482900; all of them are removed at the end (the organization's
# deletion removes its records, the one removal the guards allow).
# Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0482_org_policies_race.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
TMP="$(mktemp -d)"
FAILS=0
ok()  { printf 'ok     %s\n' "$*"; }
bad() { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q()   { docker exec -i "$CONTAINER" psql -U postgres -X -q -At -c "$1" 2>&1; }
# qa <application_name> <sql>: one session with a name pg_stat_activity shows.
qa()  { docker exec -i -e PGAPPNAME="$1" "$CONTAINER" psql -U postgres -X -q -At -c "$2" 2>&1; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
wait_for() { # <application_name> <wait_event or 'PgSleep'>
  local _ n
  for _ in $(seq 1 100); do
    n="$(q "select count(*) from pg_stat_activity where application_name = '$1' and (wait_event = '$2' or ('$2' = 'Lock' and wait_event_type = 'Lock'))")"
    [ "$n" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}
as_member() { # <user id>: the SQL that makes the rest of a transaction run as that member
  printf "set local role authenticated; select set_config('request.jwt.claims', '{\"sub\": \"%s\", \"role\": \"authenticated\", \"aal\": \"aal1\"}', true);" "$1"
}

ORG=a0482900-0000-0000-0000-0000000000a1
ADMIN=a0482900-0000-0000-0000-0000000000c1
ADMIN2=a0482900-0000-0000-0000-0000000000c2
MEMBER=a0482900-0000-0000-0000-0000000000c3

cleanup() {
  q "delete from public.organizations where id = '$ORG'; delete from auth.users where id::text like 'a0482900-%';" >/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$(q "select to_regprocedure('public.org_policy_reminders_claim(integer)') is not null")" != "t" ]; then
  echo "the stack has no 0482: apply the migrations first" >&2
  exit 2
fi
cleanup
TMP="$(mktemp -d)"

# ── The fixture: an organization, two admins, a member and 40 more members. ──
q "
insert into auth.users (id, email, raw_user_meta_data)
select ('a0482900-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid, 'race-' || n || '@test.local',
       jsonb_build_object('full_name', 'Race Member ' || n)
  from generate_series(193, 195) n
union all
select ('a0482900-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, 'race-many-' || n || '@test.local',
       jsonb_build_object('full_name', 'Race Many ' || n)
  from generate_series(1, 40) n;
insert into public.organizations (id, name, slug, mfa_policy) values ('$ORG', 'Race Org', 'a0482900-race', 'optional');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
values ('$ORG', '$ADMIN', 'admin', now() - interval '100 days'), ('$ORG', '$ADMIN2', 'admin', now() - interval '100 days'),
       ('$ORG', '$MEMBER', 'staff', now() - interval '100 days');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
select '$ORG', ('a0482900-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, 'staff', now() - interval '100 days'
  from generate_series(1, 40) n;" >/dev/null

# Two policies, each published 40 days ago (its guard switched off for that one statement), so every member is due.
publish() { # <title> -> policy id
  local id
  id="$(q "begin; $(as_member "$ADMIN")
    select (public.org_policy_save_draft('$ORG', null, 'other', '$1', 'Race words.') ->> 'policy_id');
    commit;" | grep -E '^[0-9a-f-]{36}$')"
  q "begin; $(as_member "$ADMIN")
    select public.org_policy_publish('$id', 'new_version', (select public.org_policy_draft('$id') -> 'draft' ->> 'text_hash'));
    commit;" >/dev/null
  echo "$id"
}
backdate() { # <policy id>
  q "begin;
     alter table public.org_policy_versions disable trigger org_policy_versions_guard;
     update public.org_policy_versions set published_at = now() - interval '40 days' where policy_id = '$1';
     alter table public.org_policy_versions enable trigger org_policy_versions_guard;
     commit;" >/dev/null
}
P1="$(publish 'Race policy one')"
backdate "$P1"
DUE1="$(q "select count(*) from public.organization_members where organization_id = '$ORG' and public._notify_is_current_member('$ORG', user_id)")"

CLAIM="set local role service_role; select public.org_policy_reminders_claim(1000);"

# ── 1. Two claims overlap. ──
qa race_claim_a "begin; $CLAIM select pg_sleep(3); commit;" > "$TMP/claim.a" &
A=$!
if wait_for race_claim_a PgSleep; then
  t0="$(now_ms)"
  qa race_claim_b "begin; $CLAIM commit;" > "$TMP/claim.b"
  t1="$(now_ms)"
  wait "$A"
  qa race_claim_c "begin; $CLAIM commit;" > "$TMP/claim.c"
  r="$(python3 - "$TMP" <<'PY'
import json, sys
d = sys.argv[1]
a = json.loads(open(d + '/claim.a').read().strip().split('\n')[0])
b = json.loads(open(d + '/claim.b').read().strip())
c = json.loads(open(d + '/claim.c').read().strip())
print(len(a['claimed']), b['busy'], len(b['claimed']), c['busy'], len(c['claimed']))
PY
)"
  if [ "$r" = "$DUE1 True 0 False 0" ] && [ $((t1 - t0)) -lt 1500 ]; then
    ok "1. overlapping claims: the first handed out $DUE1, the second answered busy in $((t1 - t0)) ms with nothing, a third after the commit nothing"
  else
    bad "1. overlapping claims: got '$r' (want '$DUE1 True 0 False 0'), the second took $((t1 - t0)) ms"
  fi
else
  bad "1. the first claim never reached its sleep"
  wait "$A"
fi

# ── 2. Twenty claims at once over a fresh set. ──
P2="$(publish 'Race policy two')"
backdate "$P2"
for i in $(seq 1 20); do
  qa "race_many_$i" "begin; $CLAIM commit;" > "$TMP/many.$i" &
done
wait
r="$(python3 - "$TMP" "$P2" <<'PY'
import glob, json, sys
d, p2 = sys.argv[1], sys.argv[2]
seen = []
busy = 0
for f in glob.glob(d + '/many.*'):
    a = json.loads(open(f).read().strip())
    busy += 1 if a['busy'] else 0
    seen += [(x['policy_id'], x['user_id']) for x in a['claimed']]
mine = [s for s in seen if s[0] == p2]
print(len(mine), len(set(mine)), len(seen) - len(mine), busy)
PY
)"
counts="$(q "select count(*) || ':' || count(*) filter (where sent_count = 1) from public.org_policy_reminders where policy_id = '$P2'")"
read -r n_out n_distinct n_first n_busy <<< "$r"
if [ "$n_out" = "$DUE1" ] && [ "$n_distinct" = "$DUE1" ] && [ "$n_first" = "0" ] && [ "$counts" = "$DUE1:$DUE1" ]; then
  ok "2. twenty claims at once handed out $n_out reminders, each once ($n_busy answered busy); every row's count is 1"
else
  bad "2. twenty claims at once: handed out $n_out, distinct $n_distinct, of the first policy $n_first, busy $n_busy, rows $counts (want $DUE1 each)"
fi

# ── 3. Twenty acknowledgements of one version by one member at once. ──
V1="$(q "select id from public.org_policy_versions where policy_id = '$P1' and version_number = 1")"
H1="$(q "select text_hash from public.org_policy_versions where id = '$V1'")"
for i in $(seq 1 20); do
  qa "race_ack_$i" "begin; $(as_member "$MEMBER") select public.org_policy_acknowledge('$V1', '$H1', 'web'); commit;" > "$TMP/ack.$i" &
done
wait
r="$(python3 - "$TMP" <<'PY'
import glob, json, sys
new = already = other = 0
ids = set()
for f in glob.glob(sys.argv[1] + '/ack.*'):
    t = open(f).read().strip()
    try:
        a = json.loads(t)
    except Exception:
        other += 1
        continue
    ids.add(a['acknowledgement_id'])
    if a['already']:
        already += 1
    else:
        new += 1
print(new, already, other, len(ids))
PY
)"
rows="$(q "select count(*) from public.org_policy_acknowledgements where version_id = '$V1' and user_id = '$MEMBER'")"
if [ "$r" = "1 19 0 1" ] && [ "$rows" = "1" ]; then
  ok "3. twenty acknowledgements at once: one row, one answer new and nineteen the same row"
else
  bad "3. twenty acknowledgements at once: new/already/error/ids '$r', rows $rows (want '1 19 0 1', 1)"
fi

# ── 4. A publish and an acknowledgement. ──
q "begin; $(as_member "$ADMIN") select public.org_policy_save_draft('$ORG', '$P1', 'other', 'Race policy one', 'Race words, second version.'); commit;" >/dev/null
H2="$(q "select text_hash from public.org_policy_versions where policy_id = '$P1' and published_at is null")"
M2=a0482900-0000-0000-0001-000000000001
qa race_pub_a "begin; $(as_member "$ADMIN") select public.org_policy_publish('$P1', 'new_version', '$H2'); select pg_sleep(1.5); commit;" > "$TMP/pub.a" &
A=$!
if wait_for race_pub_a PgSleep; then
  qa race_ack_b "begin; $(as_member "$M2") select public.org_policy_acknowledge('$V1', '$H1', 'phone'); commit;" > "$TMP/ack.b" 2>&1
  wait "$A"
  rows="$(q "select count(*) from public.org_policy_acknowledgements where user_id = '$M2'")"
  if grep -q 'policy_version_not_current' "$TMP/ack.b" && [ "$rows" = "0" ]; then
    ok "4a. an acknowledgement of version 1 that waited behind the publish of version 2 was refused (policy_version_not_current), nothing written"
  else
    bad "4a. acknowledgement behind a publish: '$(tr '\n' ' ' < "$TMP/ack.b")', rows $rows"
  fi
else
  bad "4a. the publish never reached its sleep"
  wait "$A"
fi
V2="$(q "select id from public.org_policy_versions where policy_id = '$P1' and version_number = 2")"
H2="$(q "select text_hash from public.org_policy_versions where id = '$V2'")"
q "begin; $(as_member "$ADMIN") select public.org_policy_save_draft('$ORG', '$P1', 'other', 'Race policy one', 'Race words, third version.'); commit;" >/dev/null
H3="$(q "select text_hash from public.org_policy_versions where policy_id = '$P1' and published_at is null")"
qa race_ack_a "begin; $(as_member "$M2") select public.org_policy_acknowledge('$V2', '$H2', 'web'); select pg_sleep(1.5); commit;" > "$TMP/ack.a" &
A=$!
if wait_for race_ack_a PgSleep; then
  t0="$(now_ms)"
  qa race_pub_b "begin; $(as_member "$ADMIN") select public.org_policy_publish('$P1', 'new_version', '$H3') ->> 'version_number'; commit;" > "$TMP/pub.b" 2>&1
  t1="$(now_ms)"
  wait "$A"
  rows="$(q "select string_agg(version_number::text, ',') from public.org_policy_acknowledgements where user_id = '$M2'")"
  if grep -qx '3' "$TMP/pub.b" && [ "$rows" = "2" ] && [ $((t1 - t0)) -ge 900 ]; then
    ok "4b. a publish waited $((t1 - t0)) ms for an open acknowledgement of version 2, then made version 3; the acknowledgement stays"
  else
    bad "4b. publish behind an acknowledgement: '$(tr '\n' ' ' < "$TMP/pub.b")', rows '$rows', waited $((t1 - t0)) ms"
  fi
else
  bad "4b. the acknowledgement never reached its sleep"
  wait "$A"
fi
V3="$(q "select id from public.org_policy_versions where policy_id = '$P1' and version_number = 3")"
H3="$(q "select text_hash from public.org_policy_versions where id = '$V3'")"
q "begin; $(as_member "$ADMIN") select public.org_policy_save_draft('$ORG', '$P1', 'other', 'Race policy one', 'Race words, fourth version.'); commit;" >/dev/null
H4="$(q "select text_hash from public.org_policy_versions where policy_id = '$P1' and published_at is null")"
qa race_ack_long "begin; $(as_member "$M2") select public.org_policy_acknowledge('$V3', '$H3', 'web'); select pg_sleep(4); commit;" > "$TMP/ack.long" &
A=$!
if wait_for race_ack_long PgSleep; then
  t0="$(now_ms)"
  qa race_pub_long "begin; $(as_member "$ADMIN") select public.org_policy_publish('$P1', 'new_version', '$H4'); commit;" > "$TMP/pub.long" 2>&1
  t1="$(now_ms)"
  wait "$A"
  n4="$(q "select count(*) from public.org_policy_versions where policy_id = '$P1' and version_number = 4")"
  if grep -q '55P03\|lock timeout' "$TMP/pub.long" && [ "$n4" = "0" ] && [ $((t1 - t0)) -ge 1800 ] && [ $((t1 - t0)) -lt 3800 ]; then
    ok "4c. a publish that waited behind a long acknowledgement gave up after $((t1 - t0)) ms (55P03) and wrote nothing"
  else
    bad "4c. long wait: '$(tr '\n' ' ' < "$TMP/pub.long")', version 4 rows $n4, waited $((t1 - t0)) ms"
  fi
else
  bad "4c. the acknowledgement never reached its sleep"
  wait "$A"
fi

# ── 5. Ten admins press Remind now at once. ──
for i in $(seq 1 10); do
  who="$ADMIN"; [ $((i % 2)) = 0 ] && who="$ADMIN2"
  qa "race_remind_$i" "begin; $(as_member "$who") select public.org_policy_remind_now('$P2'); commit;" > "$TMP/remind.$i" &
done
wait
r="$(python3 - "$TMP" <<'PY'
import glob, json, sys
yes = soon = other = 0
for f in glob.glob(sys.argv[1] + '/remind.*'):
    try:
        a = json.loads(open(f).read().strip())
    except Exception:
        other += 1
        continue
    if a['reminded']:
        yes += 1
    elif a['reason'] == 'too_soon':
        soon += 1
    else:
        other += 1
print(yes, soon, other)
PY
)"
manual="$(q "select coalesce(max(manual_count), 0) from public.org_policy_reminders where policy_id = '$P2'")"
if [ "$r" = "1 9 0" ] && [ "$manual" = "1" ]; then
  ok "5. ten Remind now at once: one reminded, nine too soon; each row stamped once"
else
  bad "5. ten Remind now at once: reminded/too soon/other '$r', largest manual count $manual (want '1 9 0', 1)"
fi

cleanup
TMP="$(mktemp -d)"
left="$(q "select (select count(*) from public.org_policies where organization_id = '$ORG') + (select count(*) from public.org_policy_acknowledgements where organization_id = '$ORG') + (select count(*) from auth.users where id::text like 'a0482900-%')")"
if [ "$left" = "0" ]; then ok "the made-up rows are gone"; else bad "$left made-up rows are left"; fi

if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; exit 0; fi
echo "$FAILS check(s) failed"
exit 1
