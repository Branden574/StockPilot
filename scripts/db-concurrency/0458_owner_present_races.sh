#!/usr/bin/env bash
#
# Two-session proofs for migration 0458 (an organization that has members
# keeps an owner). pgTAP runs in ONE session and never commits, so it cannot
# show the per-organization lock taken at COMMIT, a second transaction's
# fresh read after it, the busy answer, the isolation refusal, or GoTrue's
# own role committing. Every session here really commits.
#
# Words: a real member is an accepted row that is not an "Act as" seat; a
# real owner is a real member whose role is owner.
#
#   1.  Two owners removed at once. A demotes owner 1 of a two-owner
#       organization (with a staff member), runs SET CONSTRAINTS ALL
#       IMMEDIATE (the check passes: owner 2 is still there) and holds the
#       organization's lock for 2 s; B demotes owner 2 and commits: B's check
#       waits in its try-lock loop, gets the lock after A commits, reads again
#       and is refused (P0001 organization_needs_owner). One owner left.
#   2.  Demote the last owner against a new owner's insert. 2a the insert is
#       still open when the demotion commits: the demotion is refused. 2b the
#       insert commits first: the demotion passes. Never ownerless.
#   3.  The last owner leaves against the last member leaving. 3a the
#       member's removal is still open: the owner's removal is refused, then
#       the member's commits; the owner stays. 3b the member's removal
#       commits first: the owner's passes; the organization is empty.
#   4.  Transfer against removal. A transfers ownership to M and holds; B
#       (service role) deletes M's row, waits on the row lock, then deletes
#       the new owner's row and is refused at commit. M is the owner.
#   5.  A join against the only owner's account deletion (GoTrue's own role,
#       supabase_auth_admin, real commit). 5a the member (service role) joins
#       and commits while the deletion is open: the deletion is refused at
#       its commit; the owner and the member stay. 5b the deletion commits
#       while the join is open: the join is refused; the organization has no
#       member and no owner. (0393's race 3, whose joining session is
#       postgres, keeps its documented outcome: the join side binds the API
#       roles only.)
#   6.  GoTrue's role commits the deletion of one of two owners, and of an
#       owner who is alone: both pass (a SECURITY DEFINER body with an empty
#       search_path, run at commit for a role that holds no EXECUTE).
#   7.  Account deletion of co-owner A (GoTrue's role) against a service-role
#       demotion of co-owner B, both orders: exactly one commits.
#   8.  A savepoint rolled back: an owner demotion undone by ROLLBACK TO
#       SAVEPOINT queues nothing: the commit passes at once while another
#       session holds the organization's lock.
#   9.  A session holding constraints immediate. A demotes one of three owners,
#       runs SET CONSTRAINTS ALL IMMEDIATE (takes the lock) and holds for 7 s;
#       B demotes another owner of the same organization: B ends 55P03
#       organization_owner_check_busy within the loop's bound (2 to 6 s),
#       nothing of B's applied; A's later statements and commit succeed.
#   10. Organization delete against a demotion, both orders: neither is
#       refused, no deadlock, the organization is gone.
#   11. REPEATABLE READ: an owner demotion is refused at commit with 0A000
#       organization_owner_check_isolation; nothing applied.
#   12. Two transactions change owners of organizations X and Y in opposite
#       order and commit at the same moment: no 40P01 or 40001; each ends
#       committed or 55P03; X and Y each keep an owner.
#   13. Error classes: no session saw 40001 or 40P01; the function's body
#       names neither.
#
# Runs against a LOCAL stack only, with 0458 applied (CONTAINER, default the
# dev stack's supabase_db_stockpilot; the migration scratch stack is
# supabase_db_spmig). Fixtures live under the 04581111-... namespace, made-up
# data only, and are removed at the start, at the end and by the EXIT trap.
# Exit status 0 = every check passed. A FAIL line starts with the case number.
#
# Usage: bash scripts/db-concurrency/0458_owner_present_races.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
# GoTrue deletes accounts as supabase_auth_admin (peer auth refuses it on the
# socket; the container trusts 127.0.0.1).
PSQL_AUTH=(docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U supabase_auth_admin -d postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

NS='04581111-0000-0000-0000'
ORG1="$NS-000000000001"; ORG2="$NS-000000000002"; ORG3="$NS-000000000003"; ORG3B="$NS-000000000013"
ORG4="$NS-000000000004"; ORG5="$NS-000000000005"; ORG5B="$NS-000000000015"; ORG6="$NS-000000000006"
ORG6B="$NS-000000000016"; ORG7="$NS-000000000007"; ORG7B="$NS-000000000017"; ORG8="$NS-000000000008"
ORG9="$NS-000000000009"; ORG10="$NS-00000000000a"; ORG10B="$NS-00000000001a"; ORG11="$NS-00000000000b"
ORGX="$NS-00000000000c"; ORGY="$NS-00000000000d"
ORGS="'$ORG1','$ORG2','$ORG3','$ORG3B','$ORG4','$ORG5','$ORG5B','$ORG6','$ORG6B','$ORG7','$ORG7B','$ORG8','$ORG9','$ORG10','$ORG10B','$ORG11','$ORGX','$ORGY'"
# users: two digits per case
U11="$NS-0000000000a1"; U12="$NS-0000000000a2"; U13="$NS-0000000000a3"
U21="$NS-0000000000b1"; U22="$NS-0000000000b2"; U23="$NS-0000000000b3"
U31="$NS-0000000000c1"; U32="$NS-0000000000c2"; U33="$NS-0000000000c3"; U34="$NS-0000000000c4"
U41="$NS-0000000000d1"; U42="$NS-0000000000d2"; U43="$NS-0000000000d3"
U51="$NS-0000000000e1"; U52="$NS-0000000000e2"; U53="$NS-0000000000e3"; U54="$NS-0000000000e4"
U61="$NS-0000000000f1"; U62="$NS-0000000000f2"; U63="$NS-0000000000f3"; U64="$NS-0000000000f4"
U71="$NS-000000000101"; U72="$NS-000000000102"; U73="$NS-000000000103"
U74="$NS-000000000104"; U75="$NS-000000000105"; U76="$NS-000000000106"
U81="$NS-000000000111"; U82="$NS-000000000112"
U91="$NS-000000000121"; U92="$NS-000000000122"; U93="$NS-000000000123"; U94="$NS-000000000124"
UA1="$NS-000000000131"; UA2="$NS-000000000132"; UA3="$NS-000000000133"
UA4="$NS-000000000134"; UA5="$NS-000000000135"; UA6="$NS-000000000136"
UB1="$NS-000000000141"; UB2="$NS-000000000142"; UB3="$NS-000000000143"
UX1="$NS-000000000151"; UX2="$NS-000000000152"; UX3="$NS-000000000153"
UY1="$NS-000000000161"; UY2="$NS-000000000162"; UY3="$NS-000000000163"
USER_LIST="$U11 $U12 $U13 $U21 $U22 $U23 $U31 $U32 $U33 $U34 $U41 $U42 $U43 $U51 $U52 $U53 $U54 $U61 $U62 $U63 $U64
$U71 $U72 $U73 $U74 $U75 $U76 $U81 $U82 $U91 $U92 $U93 $U94 $UA1 $UA2 $UA3 $UA4 $UA5 $UA6 $UB1 $UB2 $UB3
$UX1 $UX2 $UX3 $UY1 $UY2 $UY3"
USERS="$(for u in $USER_LIST; do printf "'%s'," "$u"; done | sed 's/,$//')"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf 'note   %s\n' "$*"; }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
has() { grep -cF -- "$1" "$2"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
owners() { # the real owners of an organization, comma-separated
  q "select coalesce(string_agg(user_id::text, ',' order by user_id), '') from public.organization_members
      where organization_id = '$1' and role = 'owner' and accepted_at is not null and impersonation_expires_at is null"
}
reals() { # the number of real members of an organization
  q "select count(*) from public.organization_members
      where organization_id = '$1' and accepted_at is not null and impersonation_expires_at is null"
}
wait_event() { # wait_event <application_name> <wait_event>
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
wait_sleeping() { wait_event "$1" PgSleep; }
wait_lock() { # the session is waiting for a heavyweight lock
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
as_service() {
  printf "set local role service_role;\nset local \"request.jwt.claim.role\" to 'service_role';\nset local \"request.jwt.claim.sub\" to '';\n"
}
# The organization's lock key, as the function computes it.
lock_key() { printf "hashtextextended('organization_owner_present:' || '%s', 0)" "$1"; }
# delete_as_gotrue <app> <user> [sleep-seconds-before-commit] > out
delete_as_gotrue() {
  "${PSQL_AUTH[@]}" -v VERBOSITY=verbose <<SQL
set application_name to '$1';
begin;
delete from auth.users where id = '$2' returning 'G=deleted';
select pg_sleep(${3:-0});
commit;
select 'G=committed';
SQL
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.organizations where id in ($ORGS);
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$(q "select (select count(*) from public.organizations where id in ($ORGS))
                  + (select count(*) from auth.users where id in ($USERS))")"
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

if [ "$(q "select count(*) from pg_trigger where tgrelid = 'public.organization_members'::regclass and tgname like 'organization\_members\_owner\_present\_%'")" != "4" ]; then
  echo "0458 is not applied on this stack"; exit 1
fi
cleanup || exit 1

USER_VALUES="$(for u in $USER_LIST; do printf "('%s', '0458-2s-%s@test.local', '{}'::jsonb)," "$u" "${u: -3}"; done | sed 's/,$//')"
ORG_VALUES="$(for o in $ORG1 $ORG2 $ORG3 $ORG3B $ORG4 $ORG5 $ORG5B $ORG6 $ORG6B $ORG7 $ORG7B $ORG8 $ORG9 $ORG10 $ORG10B $ORG11 $ORGX $ORGY; do
  printf "('%s', '0458 2S %s', '0458-2s-%s')," "$o" "${o: -3}" "${o: -3}"; done | sed 's/,$//')"
# Fixtures as postgres (the join side does not check the table owner's writes).
if ! "${PSQL[@]}" >"$TMP/setup.out" 2>&1 <<SQL
insert into auth.users (id, email, raw_user_meta_data) values $USER_VALUES;
insert into public.organizations (id, name, slug) values $ORG_VALUES;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  -- 1: two owners and a staff member
  ('$ORG1', '$U11', 'owner', now()), ('$ORG1', '$U12', 'owner', now()), ('$ORG1', '$U13', 'staff', now()),
  -- 2: one owner and a staff member (U23 is the new owner of 2b)
  ('$ORG2', '$U21', 'owner', now()), ('$ORG2', '$U22', 'staff', now()),
  -- 3a and 3b: one owner and one staff member each
  ('$ORG3', '$U31', 'owner', now()), ('$ORG3', '$U32', 'staff', now()),
  ('$ORG3B', '$U33', 'owner', now()), ('$ORG3B', '$U34', 'staff', now()),
  -- 4: an owner, the transfer's target M, a staff member
  ('$ORG4', '$U41', 'owner', now()), ('$ORG4', '$U42', 'admin', now()), ('$ORG4', '$U43', 'staff', now()),
  -- 5a and 5b: an owner who is alone (U53 and U54 join)
  ('$ORG5', '$U51', 'owner', now()), ('$ORG5B', '$U52', 'owner', now()),
  -- 6: two owners and a staff member; 6b an owner who is alone
  ('$ORG6', '$U61', 'owner', now()), ('$ORG6', '$U62', 'owner', now()), ('$ORG6', '$U63', 'staff', now()),
  ('$ORG6B', '$U64', 'owner', now()),
  -- 7 and 7b: two owners and a staff member each
  ('$ORG7', '$U71', 'owner', now()), ('$ORG7', '$U72', 'owner', now()), ('$ORG7', '$U73', 'staff', now()),
  ('$ORG7B', '$U74', 'owner', now()), ('$ORG7B', '$U75', 'owner', now()), ('$ORG7B', '$U76', 'staff', now()),
  -- 8: one owner and a staff member
  ('$ORG8', '$U81', 'owner', now()), ('$ORG8', '$U82', 'staff', now()),
  -- 9: three owners and a staff member
  ('$ORG9', '$U91', 'owner', now()), ('$ORG9', '$U92', 'owner', now()), ('$ORG9', '$U93', 'owner', now()),
  ('$ORG9', '$U94', 'staff', now()),
  -- 10 and 10b: two owners and a staff member each
  ('$ORG10', '$UA1', 'owner', now()), ('$ORG10', '$UA2', 'owner', now()), ('$ORG10', '$UA3', 'staff', now()),
  ('$ORG10B', '$UA4', 'owner', now()), ('$ORG10B', '$UA5', 'owner', now()), ('$ORG10B', '$UA6', 'staff', now()),
  -- 11: two owners and a staff member
  ('$ORG11', '$UB1', 'owner', now()), ('$ORG11', '$UB2', 'owner', now()), ('$ORG11', '$UB3', 'staff', now()),
  -- 12: X and Y, three owners each
  ('$ORGX', '$UX1', 'owner', now()), ('$ORGX', '$UX2', 'owner', now()), ('$ORGX', '$UX3', 'owner', now()),
  ('$ORGY', '$UY1', 'owner', now()), ('$ORGY', '$UY2', 'owner', now()), ('$ORGY', '$UY3', 'owner', now());
SQL
then
  echo "fixture setup failed:"; cat "$TMP/setup.out"; exit 1
fi

# ═══ 1. Two owners removed at once ═══════════════════════════════════════
echo "== 1. A demotes owner 1 and holds the organization's lock; B demotes owner 2 and commits"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1.A.out" 2>&1 <<SQL
set application_name to '0458-race-1-A';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG1' and user_id = '$U11';
set constraints all immediate;
select 'A=checked';
select pg_sleep(2);
commit;
select 'A=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-1-A || bad "1: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/1.B.out" 2>&1 <<SQL
set application_name to '0458-race-1-B';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG1' and user_id = '$U12';
commit;
select 'B=committed';
SQL
T1=$(now_ms)
wait "$PID"
check "1: A committed, B refused at commit (organization_needs_owner)" \
  "$(has 'A=committed' "$TMP/1.A.out")/$(has 'B=committed' "$TMP/1.B.out")/$(has 'organization_needs_owner' "$TMP/1.B.out")" "1/0/1"
if [ $((T1 - T0)) -ge 1000 ]; then ok "1: B waited for A's lock before reading ($((T1 - T0)) ms)"; else bad "1: B did not wait ($((T1 - T0)) ms)"; fi
check "1: one owner left (owner 2)" "$(owners "$ORG1")" "$U12"

# ═══ 2. Demote the last owner against a new owner's insert ═══════════════
echo "== 2a. the new owner's insert is open; the last owner's demotion commits"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2a.A.out" 2>&1 <<SQL
set application_name to '0458-race-2a-A';
begin;
$(as_service)
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG2', '$U23', 'owner', now());
select pg_sleep(2);
rollback;
SQL
) &
PID=$!
wait_sleeping 0458-race-2a-A || bad "2a: session A never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2a.B.out" 2>&1 <<SQL
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG2' and user_id = '$U21';
commit;
select 'B=committed';
SQL
wait "$PID"
check "2a: the demotion is refused (the new owner was not committed)" \
  "$(has 'B=committed' "$TMP/2a.B.out")/$(has 'organization_needs_owner' "$TMP/2a.B.out")" "0/1"
check "2a: the owner is unchanged" "$(owners "$ORG2")" "$U21"
echo "== 2b. the new owner's insert commits first; then the demotion"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/2b.A.out" 2>&1 <<SQL
begin;
$(as_service)
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG2', '$U23', 'owner', now());
commit;
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG2' and user_id = '$U21';
commit;
select 'B=committed';
SQL
check "2b: the demotion passes" "$(has 'B=committed' "$TMP/2b.A.out")" "1"
check "2b: the new owner is the owner" "$(owners "$ORG2")" "$U23"

# ═══ 3. The last owner against the last member ═══════════════════════════
echo "== 3a. the member's removal is open; the owner's removal commits"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3a.A.out" 2>&1 <<SQL
set application_name to '0458-race-3a-A';
begin;
$(as_service)
delete from public.organization_members where organization_id = '$ORG3' and user_id = '$U32';
select pg_sleep(2);
commit;
select 'A=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-3a-A || bad "3a: session A never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3a.B.out" 2>&1 <<SQL
begin;
$(as_service)
delete from public.organization_members where organization_id = '$ORG3' and user_id = '$U31';
commit;
select 'B=committed';
SQL
wait "$PID"
check "3a: the member's removal committed, the owner's was refused" \
  "$(has 'A=committed' "$TMP/3a.A.out")/$(has 'B=committed' "$TMP/3a.B.out")/$(has 'organization_needs_owner' "$TMP/3a.B.out")" "1/0/1"
check "3a: the owner stays, alone" "$(owners "$ORG3")/$(reals "$ORG3")" "$U31/1"
echo "== 3b. the member's removal commits first; then the owner's"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3b.out" 2>&1 <<SQL
begin;
$(as_service)
delete from public.organization_members where organization_id = '$ORG3B' and user_id = '$U34';
commit;
begin;
$(as_service)
delete from public.organization_members where organization_id = '$ORG3B' and user_id = '$U33';
commit;
select 'B=committed';
SQL
check "3b: the owner's removal passes; the organization is empty" "$(has 'B=committed' "$TMP/3b.out")/$(reals "$ORG3B")" "1/0"

# ═══ 4. Transfer against removal ═════════════════════════════════════════
echo "== 4. A transfers ownership to M and holds; B (service role) deletes M's row"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.A.out" 2>&1 <<SQL
set application_name to '0458-race-4-A';
begin;
$(as_service)
select 'A=' || public.transfer_org_ownership('$ORG4', '$U41', '$U42');
select pg_sleep(2);
commit;
select 'A=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-4-A || bad "4: session A never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/4.B.out" 2>&1 <<SQL
set application_name to '0458-race-4-B';
begin;
$(as_service)
delete from public.organization_members where organization_id = '$ORG4' and user_id = '$U42' returning 'B=deleted';
commit;
select 'B=committed';
SQL
wait "$PID"
check "4: the transfer committed; B deleted the new owner's row after the wait and was refused at commit" \
  "$(has 'A=committed' "$TMP/4.A.out")/$(has 'B=deleted' "$TMP/4.B.out")/$(has 'B=committed' "$TMP/4.B.out")/$(has 'organization_needs_owner' "$TMP/4.B.out")" "1/1/0/1"
check "4: M is the owner" "$(owners "$ORG4")" "$U42"

# ═══ 5. A join against the only owner's account deletion ═════════════════
echo "== 5a. GoTrue deletes the only owner and holds; a member (service role) joins and commits"
( delete_as_gotrue 0458-race-5a-G "$U51" 2 > "$TMP/5a.G.out" 2>&1 ) &
PID=$!
wait_sleeping 0458-race-5a-G || bad "5a: the deletion never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/5a.J.out" 2>&1 <<SQL
begin;
$(as_service)
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG5', '$U53', 'staff', now());
commit;
select 'J=committed';
SQL
wait "$PID"
check "5a: the join committed (the owner's row was still there for it); the deletion was refused at its commit" \
  "$(has 'J=committed' "$TMP/5a.J.out")/$(has 'G=committed' "$TMP/5a.G.out")/$(has 'organization_needs_owner' "$TMP/5a.G.out")" "1/0/1"
check "5a: the owner's account and row stay, with the member" \
  "$(q "select count(*) from auth.users where id = '$U51'")/$(owners "$ORG5")/$(reals "$ORG5")" "1/$U51/2"
echo "== 5b. a member (service role) joins and holds; GoTrue deletes the only owner and commits"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/5b.J.out" 2>&1 <<SQL
set application_name to '0458-race-5b-J';
begin;
$(as_service)
insert into public.organization_members (organization_id, user_id, role, accepted_at) values ('$ORG5B', '$U54', 'staff', now());
select pg_sleep(2);
commit;
select 'J=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-5b-J || bad "5b: the join never reached its pg_sleep"
delete_as_gotrue 0458-race-5b-G "$U52" > "$TMP/5b.G.out" 2>&1
wait "$PID"
check "5b: the deletion committed (the member was not visible); the join was refused at its commit" \
  "$(has 'G=committed' "$TMP/5b.G.out")/$(has 'J=committed' "$TMP/5b.J.out")/$(has 'organization_needs_owner' "$TMP/5b.J.out")" "1/0/1"
check "5b: the organization has no member and no owner" \
  "$(q "select count(*) from public.organization_members where organization_id = '$ORG5B'")/$(owners "$ORG5B")" "0/"

# ═══ 6. GoTrue's role commits allowed deletions ══════════════════════════
echo "== 6. GoTrue deletes one of two owners, then an owner who is alone"
delete_as_gotrue 0458-race-6 "$U61" > "$TMP/6a.out" 2>&1
delete_as_gotrue 0458-race-6b "$U64" > "$TMP/6b.out" 2>&1
check "6: both deletions committed" "$(has 'G=committed' "$TMP/6a.out")/$(has 'G=committed' "$TMP/6b.out")" "1/1"
check "6: the other owner remains; the solo organization is empty" "$(owners "$ORG6")/$(reals "$ORG6B")" "$U62/0"

# ═══ 7. Account deletion of co-owner A against a demotion of co-owner B ══
echo "== 7a. GoTrue deletes owner A and holds; the service role demotes owner B"
( delete_as_gotrue 0458-race-7a-G "$U71" 2 > "$TMP/7a.G.out" 2>&1 ) &
PID=$!
wait_sleeping 0458-race-7a-G || bad "7a: the deletion never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7a.D.out" 2>&1 <<SQL
set application_name to '0458-race-7a-D';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG7' and user_id = '$U72';
commit;
select 'D=committed';
SQL
wait "$PID"
check "7a: the deletion committed; the demotion waited, then was refused at commit" \
  "$(has 'G=committed' "$TMP/7a.G.out")/$(has 'D=committed' "$TMP/7a.D.out")/$(has 'organization_needs_owner' "$TMP/7a.D.out")" "1/0/1"
check "7a: owner B remains" "$(owners "$ORG7")" "$U72"
echo "== 7b. the service role demotes owner B and holds; GoTrue deletes owner A"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/7b.D.out" 2>&1 <<SQL
set application_name to '0458-race-7b-D';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG7B' and user_id = '$U75';
select pg_sleep(2);
commit;
select 'D=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-7b-D || bad "7b: the demotion never reached its pg_sleep"
delete_as_gotrue 0458-race-7b-G "$U74" > "$TMP/7b.G.out" 2>&1
wait "$PID"
check "7b: the demotion committed; the deletion waited, then 0393's rule refused it (last_owner)" \
  "$(has 'D=committed' "$TMP/7b.D.out")/$(has 'G=committed' "$TMP/7b.G.out")/$(has 'P0001: last_owner' "$TMP/7b.G.out")" "1/0/1"
check "7b: owner A remains" "$(owners "$ORG7B")" "$U74"

# ═══ 8. A savepoint rolled back ══════════════════════════════════════════
echo "== 8. another session holds the organization's lock; an owner demotion is rolled back to a savepoint, then the commit"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/8.H.out" 2>&1 <<SQL
set application_name to '0458-race-8-H';
begin;
select pg_advisory_xact_lock($(lock_key "$ORG8"));
select pg_sleep(8);
commit;
SQL
) &
PID=$!
wait_sleeping 0458-race-8-H || bad "8: the holder never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/8.out" 2>&1 <<SQL
begin;
$(as_service)
savepoint s;
update public.organization_members set role = 'admin' where organization_id = '$ORG8' and user_id = '$U81';
rollback to savepoint s;
update public.organization_members set is_delivery_driver = true where organization_id = '$ORG8' and user_id = '$U82';
commit;
select 'S=committed';
SQL
T1=$(now_ms)
check "8: the commit passed" "$(has 'S=committed' "$TMP/8.out")" "1"
if [ $((T1 - T0)) -lt 1000 ]; then ok "8: it did not try the organization's lock ($((T1 - T0)) ms while another session held it)"; else bad "8: it waited ($((T1 - T0)) ms)"; fi
check "8: the owner is unchanged, the driver flag applied" \
  "$(owners "$ORG8")/$(q "select is_delivery_driver from public.organization_members where organization_id = '$ORG8' and user_id = '$U82'")" "$U81/t"
q "select pg_cancel_backend(pid) from pg_stat_activity where application_name = '0458-race-8-H'" >/dev/null
wait "$PID"

# ═══ 9. A session holding constraints immediate ══════════════════════════
echo "== 9. A demotes owner 1, runs SET CONSTRAINTS ALL IMMEDIATE and holds 7 s; B demotes owner 2"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/9.A.out" 2>&1 <<SQL
set application_name to '0458-race-9-A';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG9' and user_id = '$U91';
set constraints all immediate;
select pg_sleep(7);
select 'A=still' from public.organization_members where organization_id = '$ORG9' and user_id = '$U94';
update public.organization_members set is_delivery_driver = true where organization_id = '$ORG9' and user_id = '$U94';
commit;
select 'A=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-9-A || bad "9: session A never reached its pg_sleep"
T0=$(now_ms)
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/9.B.out" 2>&1 <<SQL
set application_name to '0458-race-9-B';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG9' and user_id = '$U92';
commit;
select 'B=committed';
SQL
T1=$(now_ms)
wait "$PID"
check "9: B ended 55P03 organization_owner_check_busy" \
  "$(has 'B=committed' "$TMP/9.B.out")/$(has '55P03' "$TMP/9.B.out")/$(has 'organization_owner_check_busy' "$TMP/9.B.out")" "0/1/1"
if [ $((T1 - T0)) -ge 1900 ] && [ $((T1 - T0)) -le 6900 ]; then ok "9: B gave up within the loop's bound ($((T1 - T0)) ms)"; else bad "9: B took $((T1 - T0)) ms"; fi
check "9: A's later statements and its commit succeeded" "$(has 'A=still' "$TMP/9.A.out")/$(has 'A=committed' "$TMP/9.A.out")" "1/1"
check "9: owner 1 demoted (A), owner 2 unchanged (B applied nothing)" "$(owners "$ORG9")" "$U92,$U93"

# ═══ 10. Organization delete against a demotion ══════════════════════════
echo "== 10a. the organization delete holds; a demotion of its owner"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/10a.A.out" 2>&1 <<SQL
set application_name to '0458-race-10a-A';
begin;
$(as_service)
delete from public.organizations where id = '$ORG10';
select pg_sleep(2);
commit;
select 'A=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-10a-A || bad "10a: session A never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/10a.B.out" 2>&1 <<SQL
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG10' and user_id = '$UA2';
commit;
select 'B=committed';
SQL
wait "$PID"
check "10a: both committed (the demotion found no row once the delete committed)" \
  "$(has 'A=committed' "$TMP/10a.A.out")/$(has 'B=committed' "$TMP/10a.B.out")" "1/1"
check "10a: the organization is gone" "$(q "select count(*) from public.organizations where id = '$ORG10'")" "0"
echo "== 10b. the demotion holds; the organization delete"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/10b.B.out" 2>&1 <<SQL
set application_name to '0458-race-10b-B';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG10B' and user_id = '$UA5';
select pg_sleep(2);
commit;
select 'B=committed';
SQL
) &
PID=$!
wait_sleeping 0458-race-10b-B || bad "10b: session B never reached its pg_sleep"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/10b.A.out" 2>&1 <<SQL
begin;
$(as_service)
delete from public.organizations where id = '$ORG10B';
commit;
select 'A=committed';
SQL
wait "$PID"
check "10b: both committed (the delete waited for the demotion, then emptied the organization)" \
  "$(has 'A=committed' "$TMP/10b.A.out")/$(has 'B=committed' "$TMP/10b.B.out")" "1/1"
check "10b: the organization is gone" "$(q "select count(*) from public.organizations where id = '$ORG10B'")" "0"

# ═══ 11. REPEATABLE READ ═════════════════════════════════════════════════
echo "== 11. an owner demotion in a REPEATABLE READ transaction"
"${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/11.out" 2>&1 <<SQL
begin isolation level repeatable read;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORG11' and user_id = '$UB1';
commit;
select 'R=committed';
SQL
check "11: refused at commit with 0A000 organization_owner_check_isolation" \
  "$(has 'R=committed' "$TMP/11.out")/$(has '0A000' "$TMP/11.out")/$(has 'organization_owner_check_isolation' "$TMP/11.out")" "0/1/1"
check "11: nothing applied" "$(owners "$ORG11")" "$UB1,$UB2"

# ═══ 12. Two organizations in opposite order ═════════════════════════════
echo "== 12. T1 changes owners of X then Y, T2 of Y then X; both commit at the same moment"
AT="$(q "select (clock_timestamp() + interval '2 seconds')::text")"
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/12.T1.out" 2>&1 <<SQL
set application_name to '0458-race-12-T1';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORGX' and user_id = '$UX1';
update public.organization_members set role = 'admin' where organization_id = '$ORGY' and user_id = '$UY1';
select pg_sleep_until('$AT');
commit;
select 'T1=committed';
SQL
) &
P1=$!
( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/12.T2.out" 2>&1 <<SQL
set application_name to '0458-race-12-T2';
begin;
$(as_service)
update public.organization_members set role = 'admin' where organization_id = '$ORGY' and user_id = '$UY2';
update public.organization_members set role = 'admin' where organization_id = '$ORGX' and user_id = '$UX2';
select pg_sleep_until('$AT');
commit;
select 'T2=committed';
SQL
) &
P2=$!
wait "$P1"; wait "$P2"
R1="$(if [ "$(has 'T1=committed' "$TMP/12.T1.out")" = 1 ]; then echo committed; elif [ "$(has 'organization_owner_check_busy' "$TMP/12.T1.out")" = 1 ]; then echo busy; else echo other; fi)"
R2="$(if [ "$(has 'T2=committed' "$TMP/12.T2.out")" = 1 ]; then echo committed; elif [ "$(has 'organization_owner_check_busy' "$TMP/12.T2.out")" = 1 ]; then echo busy; else echo other; fi)"
note "12: T1 $R1, T2 $R2"
case "$R1/$R2" in
  (*other*) bad "12: a session ended neither committed nor 55P03 ($R1/$R2)";;
  (*) ok "12: each session committed or ended 55P03 ($R1/$R2)";;
esac
check "12: no 40P01 or 40001 in either" "$(cat "$TMP/12.T1.out" "$TMP/12.T2.out" | grep -cE '40P01|40001')" "0"
check "12: X and Y each keep an owner" "$([ -n "$(owners "$ORGX")" ] && echo y)/$([ -n "$(owners "$ORGY")" ] && echo y)" "y/y"

# ═══ 13. Error classes ═══════════════════════════════════════════════════
echo "== 13. error classes"
check "13: no 40001 in any session" "$(cat "$TMP"/*.out | grep -c '40001')" "0"
check "13: no 40P01 in any session" "$(cat "$TMP"/*.out | grep -c '40P01')" "0"
check "13: the function's body names neither" \
  "$(q "select count(*) from pg_proc where oid = to_regprocedure('public.tg_organization_members_owner_present()')
          and prosrc ~ '40001|40P01|serialization_failure|deadlock_detected'")" "0"

cleanup || FAILS=$((FAILS + 1))

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
