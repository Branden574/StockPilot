#!/usr/bin/env bash
#
# Two-session checks of the passkey records (supabase/migrations/*_passkeys.sql).
# Every function that changes an account's passkeys or bridge row takes the
# account's profile row FOR NO KEY UPDATE first, and re-reads what it needs
# after the lock; a challenge is spent by one UPDATE. One session cannot show
# what a second one does meanwhile, so this runs real sessions. In each
# ordered case the first call runs in an open transaction that sleeps before
# it commits, the second call starts while it sleeps, and the script checks
# that the second WAITED (seen in pg_stat_activity as a lock wait) and what
# it answered once the first committed. It proves:
#
#   1.  Two registrations of one account, each bringing its own bridge: the
#       second waits, then is refused (55000 passkey_bridge_exists) and stores
#       nothing; one passkey and one bridge row (the first's) are left.
#   1b. Ten such registrations released at the same instant: exactly one is
#       stored, nine are refused 55000 passkey_bridge_exists, one bridge row.
#   2.  Removing the last passkey against adding one that keeps the present
#       bridge, in both orders: remove first, the add waits and is refused
#       (55000 passkey_bridge_missing): no passkey, no bridge row; add first,
#       the removal waits and sees the new passkey: one active, bridge kept.
#   3.  Replacing the bridge against dropping it: replace first (an account
#       with an active passkey), the drop waits and is refused (55000
#       passkey_still_active), the new bridge stays; two replaces that expect
#       the same bridge, the second waits and changes nothing (false).
#   3b. Dropping a bridge row (no active passkey) against a registration that
#       keeps the present bridge, both orders: drop first, the registration
#       waits and is refused 55000 passkey_bridge_missing; registration
#       first, the drop waits and is refused 55000 passkey_still_active.
#   4.  Two takes of one challenge: the second waits for the first and gets
#       nothing; twenty takes released at the same instant: exactly one wins.
#   5.  A recovery code with the passkey removal against a registration, both
#       orders: the code first, the registration waits and is refused 55000
#       passkey_bridge_missing (nothing stored, the code spent); the
#       registration first, the code waits, then removes both passkeys and
#       the bridge row.
#   6.  Ending one bridge-raised Auth session (passkey_end_bridge_session,
#       which checks and deletes in one statement, with no lock of its own):
#       6a  two calls for one session, the second while the first is still
#           open: the second waits, then answers false (already gone), no
#           error; 6b  ten calls released at the same instant: exactly one
#           true, nine false, no error; 6c  Auth moves the session to the
#           member's own app in an open transaction: the call waits, then is
#           refused 22023 passkey_session_not_bridge_raised on the session as
#           it now is, and the session stays; 6d  a transaction holds the
#           session row for 4 s: the call gives up after 2 s with 55P03 and
#           ends nothing.
#   After every case: no account has an active passkey without a bridge row
#   or a bridge row without an active passkey (the invariant the functions
#   keep), and no session failed with a deadlock or a serialization error.
#
# LOCAL stack only: DB_URL=<postgres URL of a local stack> (the migration
# scratch stack is postgresql://postgres:postgres@127.0.0.1:56422/postgres),
# or CONTAINER=<docker container> (default supabase_db_stockpilot). It needs
# the head at or after this migration. Every account, factor, code and
# organization it makes is made up (namespace a0475900) and is removed at the
# end; it switches passkeys on in public.platform_settings for the run and
# puts the row back as it found it. Exit status 0 = every check passed.
#
# Usage: DB_URL=... bash scripts/db-concurrency/0475_passkey_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
if [ -n "${DB_URL:-}" ]; then
  case "$DB_URL" in
    *@127.0.0.1:*|*@localhost:*) ;;
    *) echo "DB_URL must point at a local stack (127.0.0.1 or localhost)"; exit 1 ;;
  esac
  PSQL=(psql "$DB_URL" -X -q -At)
else
  PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -At)
fi
TMP="$(mktemp -d)"
NS='a0475900-0000-4000-8000'
ORG="$NS-0000000000a1"
U1="$NS-000000000001" U2="$NS-000000000002" U3="$NS-000000000003" U4="$NS-000000000004"
U5="$NS-000000000005" U6="$NS-000000000006" U7="$NS-000000000007" U8="$NS-000000000008"
U9="$NS-000000000009" UA="$NS-00000000000a" UB="$NS-00000000000b" UC="$NS-00000000000c"
USERS="'$U1','$U2','$U3','$U4','$U5','$U6','$U7','$U8','$U9','$UA','$UB','$UC'"
SESS="$NS-0000000005e1"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1" 2>&1; }
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
KEY="decode(repeat('a5', 77), 'hex')"
cred() { printf "'race0475x%013d'" "$1"; }
ct() { printf "'v1.IIIIIIIIIIIIIIII.C%041d.TTTTTTTTTTTTTTTTTTTTTT'" "$1"; }
fid() { printf "%s-%012x" "$NS" "$((0xf000 + $1))"; }
# A registration as SQL: keep the present bridge (factor empty), or bring one.
reg() { # reg <user> <cred n> [factor n]
  if [ -z "${3:-}" ]; then
    printf "select public.passkey_register('%s', %s, %s, 0, null, true, true, 'Race key %s', 'localhost', null, null, null);" \
      "$1" "$(cred "$2")" "$KEY" "$2"
  else
    printf "select public.passkey_register('%s', %s, %s, 0, null, true, true, 'Race key %s', 'localhost', '%s', %s, 1::smallint);" \
      "$1" "$(cred "$2")" "$KEY" "$2" "$(fid "$3")" "$(ct "$3")"
  fi
}

# Platform switches: remember the row, switch passkeys on for the run.
ROW_BEFORE="$(q "select coalesce((select passkeys_on::text || ',' || passkey_adds_on::text || ',' || passkey_check_ends_sessions::text from public.platform_settings where id), 'none')")"
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  q "delete from auth.users where id in ($USERS)" > /dev/null
  q "delete from public.organizations where id = '$ORG'" > /dev/null
  case "$ROW_BEFORE" in
    none) q "delete from public.platform_settings where id" > /dev/null ;;
    *,*,*) IFS=, read -r B_ON B_ADDS B_ENDS <<< "$ROW_BEFORE"
           q "update public.platform_settings set passkeys_on = $B_ON, passkey_adds_on = $B_ADDS, passkey_check_ends_sessions = $B_ENDS where id" > /dev/null ;;
  esac
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$(q "select to_regprocedure('public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint)') is not null")" != "t" ]; then
  echo "needs the head at or after the passkeys migration"
  exit 1
fi
case "$ROW_BEFORE" in none|*,*,*) ;; *) echo "could not read public.platform_settings: $ROW_BEFORE"; exit 1 ;; esac
if [ "$(q "select count(*) from auth.users where id in ($USERS)")" != "0" ]; then
  echo "made-up accounts of an earlier run are still there; removing them first"
  q "delete from auth.users where id in ($USERS)" > /dev/null
  q "delete from public.organizations where id = '$ORG'" > /dev/null
fi

SETUP="$(q "
insert into public.platform_settings (id, passkeys_on, passkey_adds_on) values (true, true, true)
  on conflict (id) do update set passkeys_on = true, passkey_adds_on = true;
insert into auth.users (id, email)
  select u::uuid, 'race-0475-' || right(u, 2) || '@test.local' from unnest(array[$USERS]) u;
insert into public.organizations (id, name, slug) values ('$ORG', 'Race Passkeys Org', 'a0475900-race');
insert into public.organization_passkey_switches (organization_id) values ('$ORG');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  select '$ORG', u::uuid, 'staff', now() from unnest(array[$USERS]) u;
-- Verified reserved-name factors: 1 to 2 for U1, 11 to 20 for U2, 31 to 33 for U3 to U5 and so on.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  select ('$NS-' || lpad(to_hex(61440 + v.n), 12, '0'))::uuid, v.u::uuid,
         'sp-passkey-bridge-race' || v.n, 'totp', 'verified', now(), now()
    from (values ('$U1', 1), ('$U1', 2),
                 ('$U2', 11), ('$U2', 12), ('$U2', 13), ('$U2', 14), ('$U2', 15),
                 ('$U2', 16), ('$U2', 17), ('$U2', 18), ('$U2', 19), ('$U2', 20),
                 ('$U3', 31), ('$U4', 41), ('$U5', 51), ('$U6', 61), ('$U6', 62), ('$U6', 63),
                 ('$U7', 71), ('$U8', 81), ('$U9', 91), ('$UA', 101), ('$UB', 111), ('$UC', 121)) v(u, n);
select 'setup done';" | tail -n 1)"
if [ "$SETUP" != "setup done" ]; then echo "setup failed: $SETUP"; exit 1; fi

# Run as service_role, like the app's server. Each call prints its answer or
# its error with the SQLSTATE.
SR="set role service_role;"
ordered() { # ordered <label> <first sql> <second sql> [seconds]: first in an open transaction that sleeps (2 s)
  local label="$1" first="$2" second="$3" pause="${4:-2}"
  printf "set application_name = 'pk-first-%s';\n\\set VERBOSITY verbose\nbegin;\n%s\n%s\nselect pg_sleep(%s);\ncommit;\n" \
    "$label" "$SR" "$first" "$pause" | "${PSQL[@]}" > "$TMP/$label.first" 2>&1 &
  local fp=$!
  if ! wait_app "pk-first-$label" PgSleep; then
    bad "$label: the first session never reached its sleep: $(tr '\n' ' ' < "$TMP/$label.first" | cut -c1-200)"
    wait "$fp"; return 1
  fi
  printf "set application_name = 'pk-second-%s';\n\\set VERBOSITY verbose\n%s\n%s\n" "$label" "$SR" "$second" \
    | "${PSQL[@]}" > "$TMP/$label.second" 2>&1 &
  local sp=$!
  if wait_app "pk-second-$label" Lock; then echo "waited" > "$TMP/$label.waited"; else echo "no wait seen" > "$TMP/$label.waited"; fi
  wait "$sp"; wait "$fp"
}
second_waited() { [ "$(cat "$TMP/$1.waited" 2> /dev/null)" = "waited" ]; }
out() { tr '\n' ' ' < "$TMP/$1.$2" | sed 's/  */ /g' | cut -c1-240; }
no_deadlock() { ! grep -qE '40P01|40001' "$TMP/$1".* 2> /dev/null; }
invariant() { # every made-up account: active passkeys > 0 exactly when it has a bridge row
  q "select coalesce(string_agg(right(x.u::text, 2) || ':' || x.active || '/' || x.bridges, ' ' order by x.u), 'none')
       from (select u.id as u,
                    (select count(*) from public.member_passkeys p where p.user_id = u.id and p.removed_at is null) as active,
                    (select count(*) from public.passkey_bridges b where b.user_id = u.id) as bridges
               from public.user_profiles u where u.id in ($USERS)) x
      where (x.active > 0) <> (x.bridges > 0)"
}
facts() { # facts <user>: active passkeys / bridge rows / bridge factor number
  q "select (select count(*) from public.member_passkeys p where p.user_id = '$1' and p.removed_at is null) || '/'
            || (select count(*) from public.passkey_bridges b where b.user_id = '$1') || '/'
            || coalesce((select ('x' || right(b.factor_id::text, 4))::bit(16)::int - 61440 from public.passkey_bridges b where b.user_id = '$1')::text, '-')"
}

# ── 1. Two registrations of one account, each with its own bridge ─────────
ordered 1-two-registrations "$(reg "$U1" 1 1)" "$(reg "$U1" 2 2)"
if second_waited 1-two-registrations && grep -q '55000: passkey_bridge_exists' "$TMP/1-two-registrations.second" \
   && ! grep -q 'ERROR' "$TMP/1-two-registrations.first" && [ "$(facts "$U1")" = "1/1/1" ] \
   && [ "$(q "select count(*) from public.member_passkeys where credential_id = $(cred 2)")" = "0" ] \
   && no_deadlock 1-two-registrations; then
  ok "1: the second registration waited for the first, then was refused 55000 passkey_bridge_exists; one passkey and the first's bridge row are left, the second's passkey was not stored"
else
  bad "1: second waited: $(cat "$TMP/1-two-registrations.waited"); first: $(out 1-two-registrations first); second: $(out 1-two-registrations second); facts $(facts "$U1") (expected 1/1/1)"
fi

# ── 1b. Ten registrations released at the same instant ────────────────────
# A barrier: a holder keeps an exclusive advisory lock; each registration
# first waits for a shared one, so all ten start when the holder lets go.
printf "set application_name = 'pk-barrier-1b';\nselect pg_advisory_lock(4750001);\nselect pg_sleep(2);\nselect pg_advisory_unlock(4750001);\n" \
  | "${PSQL[@]}" > /dev/null 2>&1 &
BP=$!
wait_app pk-barrier-1b PgSleep || bad "1b: the barrier never started"
PIDS=()
for i in $(seq 11 20); do
  printf "\\set VERBOSITY verbose\nbegin;\nselect pg_advisory_xact_lock_shared(4750001);\n%s\n%s\ncommit;\n" "$SR" "$(reg "$U2" "$i" "$i")" \
    | "${PSQL[@]}" > "$TMP/1b.$i" 2>&1 &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
wait "$BP"
STORED="$(cat "$TMP"/1b.* | grep -cE '^[0-9a-f]{8}-')"
REFUSED="$(cat "$TMP"/1b.* | grep -c '55000: passkey_bridge_exists')"
OTHER="$(cat "$TMP"/1b.* | grep 'ERROR' | grep -vc 'passkey_bridge_exists')"
if [ "$STORED" = "1" ] && [ "$REFUSED" = "9" ] && [ "$OTHER" = "0" ] && [ "$(facts "$U2" | cut -d/ -f1,2)" = "1/1" ]; then
  ok "1b: ten registrations released at once: one stored, nine refused 55000 passkey_bridge_exists, no other error; one passkey and one bridge row (factor $(facts "$U2" | cut -d/ -f3))"
else
  bad "1b: stored $STORED, refused $REFUSED, other errors $OTHER, facts $(facts "$U2") (expected 1 stored, 9 refused, 0 other, 1/1/<n>)"
fi

# ── 2. Removing the last passkey against adding one ───────────────────────
# U3 and U4: one active passkey each (31, 41) with its bridge.
q "set role service_role; $(reg "$U3" 31 31) $(reg "$U4" 41 41)" > "$TMP/2.setup"
P31="(select id from public.member_passkeys where credential_id = $(cred 31))"
P41="(select id from public.member_passkeys where credential_id = $(cred 41))"
ordered 2a-remove-first "select removed, active_left, bridge_dropped from public.passkey_mark_removed('$U3', $P31, 'member');" "$(reg "$U3" 32)"
if second_waited 2a-remove-first && grep -q '55000: passkey_bridge_missing' "$TMP/2a-remove-first.second" \
   && grep -q '^t|0|t$' "$TMP/2a-remove-first.first" && [ "$(facts "$U3")" = "0/0/-" ] && no_deadlock 2a-remove-first; then
  ok "2a: removal first: the add (keeping the present bridge) waited, then was refused 55000 passkey_bridge_missing; no passkey and no bridge row are left"
else
  bad "2a: second waited: $(cat "$TMP/2a-remove-first.waited"); first: $(out 2a-remove-first first); second: $(out 2a-remove-first second); facts $(facts "$U3") (expected 0/0/-)"
fi
ordered 2b-add-first "$(reg "$U4" 42)" "select removed, active_left, bridge_dropped from public.passkey_mark_removed('$U4', $P41, 'member');"
if second_waited 2b-add-first && grep -q '^t|1|f$' "$TMP/2b-add-first.second" && ! grep -q 'ERROR' "$TMP/2b-add-first.first" \
   && [ "$(facts "$U4")" = "1/1/41" ] && no_deadlock 2b-add-first; then
  ok "2b: add first: the removal waited, then saw the new passkey (removed, one left, bridge kept); one active passkey and its bridge row"
else
  bad "2b: second waited: $(cat "$TMP/2b-add-first.waited"); first: $(out 2b-add-first first); second: $(out 2b-add-first second); facts $(facts "$U4") (expected 1/1/41)"
fi

# ── 3. Replacing the bridge against dropping it ───────────────────────────
# U5: an active passkey with bridge 51; U6: an active passkey with bridge 61,
# and 62, 63 verified beside it.
q "set role service_role; $(reg "$U5" 51 51) $(reg "$U6" 61 61)" > "$TMP/3.setup"
q "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
   values ('$(fid 52)', '$U5', 'sp-passkey-bridge-race52', 'totp', 'verified', now(), now())" > /dev/null
ordered 3a-replace-first "select public.passkey_replace_bridge('$U5', '$(fid 51)', '$(fid 52)', $(ct 52), 1::smallint);" \
  "select public.passkey_drop_bridge('$U5', '$(fid 51)');"
if second_waited 3a-replace-first && grep -q '^t$' "$TMP/3a-replace-first.first" \
   && grep -q '55000: passkey_still_active' "$TMP/3a-replace-first.second" && [ "$(facts "$U5")" = "1/1/52" ] && no_deadlock 3a-replace-first; then
  ok "3a: replace first: the drop waited, then was refused 55000 passkey_still_active; the new bridge (52) stays"
else
  bad "3a: second waited: $(cat "$TMP/3a-replace-first.waited"); first: $(out 3a-replace-first first); second: $(out 3a-replace-first second); facts $(facts "$U5") (expected 1/1/52)"
fi
ordered 3c-two-replaces "select public.passkey_replace_bridge('$U6', '$(fid 61)', '$(fid 62)', $(ct 62), 1::smallint);" \
  "select public.passkey_replace_bridge('$U6', '$(fid 61)', '$(fid 63)', $(ct 63), 1::smallint);"
if second_waited 3c-two-replaces && grep -q '^t$' "$TMP/3c-two-replaces.first" && grep -q '^f$' "$TMP/3c-two-replaces.second" \
   && [ "$(facts "$U6")" = "1/1/62" ] && no_deadlock 3c-two-replaces; then
  ok "3c: two replaces expecting the same bridge: the second waited, then changed nothing (false); the first's bridge (62) stays"
else
  bad "3c: second waited: $(cat "$TMP/3c-two-replaces.waited"); first: $(out 3c-two-replaces first); second: $(out 3c-two-replaces second); facts $(facts "$U6") (expected 1/1/62)"
fi

# ── 3b. Dropping a bridge row against a registration that keeps it ────────
# U7 and U8: a bridge row and no active passkey (a passkey removed, the row
# left by hand: the state passkey_drop_bridge is for).
q "set role service_role; $(reg "$U7" 71 71) $(reg "$U8" 81 81)" > "$TMP/3b.setup"
q "update public.member_passkeys set removed_at = now(), removed_reason = 'member' where credential_id in ($(cred 71), $(cred 81))" > /dev/null
ordered 3b1-drop-first "select public.passkey_drop_bridge('$U7', '$(fid 71)');" "$(reg "$U7" 72)"
if second_waited 3b1-drop-first && grep -q '^t$' "$TMP/3b1-drop-first.first" \
   && grep -q '55000: passkey_bridge_missing' "$TMP/3b1-drop-first.second" && [ "$(facts "$U7")" = "0/0/-" ] && no_deadlock 3b1-drop-first; then
  ok "3b: drop first: the registration waited, then was refused 55000 passkey_bridge_missing; no passkey, no bridge row"
else
  bad "3b: second waited: $(cat "$TMP/3b1-drop-first.waited"); first: $(out 3b1-drop-first first); second: $(out 3b1-drop-first second); facts $(facts "$U7") (expected 0/0/-)"
fi
ordered 3b2-register-first "$(reg "$U8" 82)" "select public.passkey_drop_bridge('$U8', '$(fid 81)');"
if second_waited 3b2-register-first && ! grep -q 'ERROR' "$TMP/3b2-register-first.first" \
   && grep -q '55000: passkey_still_active' "$TMP/3b2-register-first.second" && [ "$(facts "$U8")" = "1/1/81" ] && no_deadlock 3b2-register-first; then
  ok "3b: registration first: the drop waited, then was refused 55000 passkey_still_active; the new passkey and the bridge row stay"
else
  bad "3b: second waited: $(cat "$TMP/3b2-register-first.waited"); first: $(out 3b2-register-first first); second: $(out 3b2-register-first second); facts $(facts "$U8") (expected 1/1/81)"
fi

# ── 4. Two takes of one challenge ─────────────────────────────────────────
issue() { # issue <n>: a challenge of U9's, its id
  q "set role service_role; select public.issue_passkey_challenge('$U9', '$SESS', 'second_step', 'r' || lpad('$1', 42, '0'),
       encode(sha256(convert_to('race-binding', 'UTF8')), 'hex'), 'localhost');"
}
take() { printf "select count(*) from public.take_passkey_challenge('%s', '%s', '%s', 'second_step', encode(sha256(convert_to('race-binding', 'UTF8')), 'hex'));" "$1" "$U9" "$SESS"; }
C1="$(issue 1)"
ordered 4a-two-takes "$(take "$C1")" "$(take "$C1")"
if second_waited 4a-two-takes && grep -q '^1$' "$TMP/4a-two-takes.first" && grep -q '^0$' "$TMP/4a-two-takes.second" && no_deadlock 4a-two-takes; then
  ok "4a: the second take waited for the first, then got nothing: the challenge was spent once"
else
  bad "4a: second waited: $(cat "$TMP/4a-two-takes.waited"); first: $(out 4a-two-takes first); second: $(out 4a-two-takes second)"
fi
C2="$(issue 2)"
printf "set application_name = 'pk-barrier-4b';\nselect pg_advisory_lock(4750002);\nselect pg_sleep(2);\nselect pg_advisory_unlock(4750002);\n" \
  | "${PSQL[@]}" > /dev/null 2>&1 &
BP=$!
wait_app pk-barrier-4b PgSleep || bad "4b: the barrier never started"
PIDS=()
for i in $(seq 1 20); do
  printf "begin;\nselect pg_advisory_xact_lock_shared(4750002);\n%s\n%s\ncommit;\n" "$SR" "$(take "$C2")" \
    | "${PSQL[@]}" > "$TMP/4b.$i" 2>&1 &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
wait "$BP"
WINS="$(cat "$TMP"/4b.* | grep -c '^1$')"
NONE="$(cat "$TMP"/4b.* | grep -c '^0$')"
ERRS="$(cat "$TMP"/4b.* | grep -c 'ERROR')"
if [ "$WINS" = "1" ] && [ "$NONE" = "19" ] && [ "$ERRS" = "0" ]; then
  ok "4b: twenty takes of one challenge released at once: exactly one won, nineteen got nothing, no error"
else
  bad "4b: wins $WINS, nothing $NONE, errors $ERRS (expected 1, 19, 0)"
fi

# ── 5. A recovery code with the removal against a registration ────────────
# UA and UB: one active passkey with its bridge, and one recovery code each.
q "set role service_role; $(reg "$UA" 101 101) $(reg "$UB" 111 111)" > "$TMP/5.setup"
q "insert into public.mfa_recovery_codes (user_id, code_hash)
   values ('$UA', encode(sha256(convert_to('RACE0475CODEA', 'UTF8')), 'hex')),
          ('$UB', encode(sha256(convert_to('RACE0475CODEB', 'UTF8')), 'hex'))" > /dev/null
ordered 5a-code-first "select consumed, passkeys_removed from public.consume_recovery_code_with_passkeys('$UA', 'race0475codea');" "$(reg "$UA" 102)"
if second_waited 5a-code-first && grep -q '^t|1$' "$TMP/5a-code-first.first" \
   && grep -q '55000: passkey_bridge_missing' "$TMP/5a-code-first.second" && [ "$(facts "$UA")" = "0/0/-" ] \
   && [ "$(q "select count(*) from public.mfa_recovery_codes where user_id = '$UA' and used_at is null")" = "0" ] && no_deadlock 5a-code-first; then
  ok "5a: the code first: the registration waited, then was refused 55000 passkey_bridge_missing; the code is spent, no passkey, no bridge row"
else
  bad "5a: second waited: $(cat "$TMP/5a-code-first.waited"); first: $(out 5a-code-first first); second: $(out 5a-code-first second); facts $(facts "$UA") (expected 0/0/-)"
fi
ordered 5b-register-first "$(reg "$UB" 112)" "select consumed, passkeys_removed from public.consume_recovery_code_with_passkeys('$UB', 'race0475codeb');"
if second_waited 5b-register-first && ! grep -q 'ERROR' "$TMP/5b-register-first.first" \
   && grep -q '^t|2$' "$TMP/5b-register-first.second" && [ "$(facts "$UB")" = "0/0/-" ] && no_deadlock 5b-register-first; then
  ok "5b: the registration first: the code waited, then removed both passkeys (the new one included) and the bridge row"
else
  bad "5b: second waited: $(cat "$TMP/5b-register-first.waited"); first: $(out 5b-register-first first); second: $(out 5b-register-first second); facts $(facts "$UB") (expected 0/0/-)"
fi

# ── 6. Ending one bridge-raised Auth session ──────────────────────────────
# UC: one passkey with its recorded bridge (factor 121), an authenticator app
# of its own (122), and four sessions raised by the bridge.
S6A="$NS-0000000006a1" S6B="$NS-0000000006b1" S6C="$NS-0000000006c1" S6D="$NS-0000000006d1"
q "set role service_role; $(reg "$UC" 121 121)" > "$TMP/6.setup"
q "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values ('$(fid 122)', '$UC', 'Race app', 'totp', 'verified', now(), now());
   insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal)
     select s::uuid, '$UC', now(), now(), '$(fid 121)', 'aal2' from unnest(array['$S6A', '$S6B', '$S6C', '$S6D']) s;" > /dev/null
ends() { printf "select public.passkey_end_bridge_session('%s');" "$1"; }
alive() { q "select count(*) from auth.sessions where id = '$1'"; }
ordered 6a-two-ends "$(ends "$S6A")" "$(ends "$S6A")"
if second_waited 6a-two-ends && grep -q '^t$' "$TMP/6a-two-ends.first" && grep -q '^f$' "$TMP/6a-two-ends.second" \
   && ! grep -q 'ERROR' "$TMP"/6a-two-ends.* && [ "$(alive "$S6A")" = "0" ] && no_deadlock 6a-two-ends; then
  ok "6a: two ends of one session: the second waited for the first, then answered false (already gone), no error; the session is gone"
else
  bad "6a: second waited: $(cat "$TMP/6a-two-ends.waited"); first: $(out 6a-two-ends first); second: $(out 6a-two-ends second); alive $(alive "$S6A")"
fi
printf "set application_name = 'pk-barrier-6b';\nselect pg_advisory_lock(4750006);\nselect pg_sleep(2);\nselect pg_advisory_unlock(4750006);\n" \
  | "${PSQL[@]}" > /dev/null 2>&1 &
BP=$!
wait_app pk-barrier-6b PgSleep || bad "6b: the barrier never started"
PIDS=()
for i in $(seq 1 10); do
  printf "begin;\nselect pg_advisory_xact_lock_shared(4750006);\n%s\n%s\ncommit;\n" "$SR" "$(ends "$S6B")" \
    | "${PSQL[@]}" > "$TMP/6b.$i" 2>&1 &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
wait "$BP"
ENDED="$(cat "$TMP"/6b.* | grep -c '^t$')"
GONE="$(cat "$TMP"/6b.* | grep -c '^f$')"
ERRS="$(cat "$TMP"/6b.* | grep -c 'ERROR')"
if [ "$ENDED" = "1" ] && [ "$GONE" = "9" ] && [ "$ERRS" = "0" ] && [ "$(alive "$S6B")" = "0" ]; then
  ok "6b: ten ends of one session released at once: exactly one ended it, nine answered false, no error"
else
  bad "6b: ended $ENDED, false $GONE, errors $ERRS (expected 1, 9, 0); alive $(alive "$S6B")"
fi
ordered 6c-moved "reset role; update auth.sessions set factor_id = '$(fid 122)' where id = '$S6C';" "$(ends "$S6C")"
if second_waited 6c-moved && grep -q '22023: passkey_session_not_bridge_raised' "$TMP/6c-moved.second" \
   && ! grep -q 'ERROR' "$TMP/6c-moved.first" && [ "$(alive "$S6C")" = "1" ] && no_deadlock 6c-moved; then
  ok "6c: Auth moved the session to the member's own app meanwhile: the end waited, then was refused 22023 on the session as it now is; the session stays"
else
  bad "6c: second waited: $(cat "$TMP/6c-moved.waited"); first: $(out 6c-moved first); second: $(out 6c-moved second); alive $(alive "$S6C")"
fi
ordered 6d-held "reset role; update auth.sessions set updated_at = now() where id = '$S6D';" "$(ends "$S6D")" 4
if second_waited 6d-held && grep -q '55P03' "$TMP/6d-held.second" && ! grep -q 'ERROR' "$TMP/6d-held.first" \
   && [ "$(alive "$S6D")" = "1" ] && no_deadlock 6d-held; then
  ok "6d: a transaction held the session row for 4 s: the end gave up after 2 s with 55P03 and ended nothing"
else
  bad "6d: second waited: $(cat "$TMP/6d-held.waited"); first: $(out 6d-held first); second: $(out 6d-held second); alive $(alive "$S6D")"
fi

# ── The invariant, over every made-up account ─────────────────────────────
BROKEN="$(invariant)"
if [ "$BROKEN" = "none" ]; then
  ok "after every case: no account has an active passkey without a bridge row, or a bridge row without an active passkey (U7 and U8 were set up that way by hand and settled by the cases)"
else
  bad "accounts where an active passkey and a bridge row do not go together (account:active/bridges): $BROKEN"
fi
if grep -qlE '40P01|40001' "$TMP"/* 2> /dev/null; then
  bad "a session failed with a deadlock or a serialization error: $(grep -lE '40P01|40001' "$TMP"/* | xargs -n1 basename | tr '\n' ' ')"
else
  ok "no session failed with a deadlock or a serialization error"
fi

cleanup
trap - EXIT
LEFT="$(q "select (select count(*) from auth.users where id in ($USERS)) + (select count(*) from public.organizations where id = '$ORG')
                + (select count(*) from public.member_passkeys where credential_id like 'race0475x%')
                + (select count(*) from auth.mfa_factors where friendly_name like 'sp-passkey-bridge-race%')")"
ROW_AFTER="$(q "select coalesce((select passkeys_on::text || ',' || passkey_adds_on::text || ',' || passkey_check_ends_sessions::text from public.platform_settings where id), 'none')")"
if [ "$LEFT" = "0" ] && [ "$ROW_AFTER" = "$ROW_BEFORE" ]; then
  ok "cleaned up: no made-up account, organization, passkey or factor is left, and the settings row is as it was ($ROW_AFTER)"
else
  bad "left behind: $LEFT made-up rows; settings row $ROW_AFTER (was $ROW_BEFORE)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
