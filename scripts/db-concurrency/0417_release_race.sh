#!/usr/bin/env bash
#
# Two-session proofs for the S42 migration
# (supabase/migrations/*_release_cycle_count_assignee_check.sql):
# release_cycle_count decides who may release on the count row it locks.
# pgTAP runs in ONE session, so it cannot show what a waiting release reads:
# the assignee opens their count, a manager releases it, and only then does
# the assignee's Release reach the database (the stale screen).
#
#   1.  The race. A (a manager) releases the assignee's count and keeps its
#       transaction open; B (the assignee: staff holding stock:adjust)
#       releases the same count. B waits on A's row lock, then reads the
#       count with no assignee under its own lock and is refused 42501
#       forbidden. The count ends released once, by A (assignment_version
#       up by one).
#   2.  The control: A rolls back instead. B waits, then releases its own
#       count, still assigned to it when B gets the row. The count ends
#       released once, by B.
#   3.  The mutation the unassigned block exists for: a copy of
#       release_cycle_count without the two S42 blocks (production's body
#       before this migration, md5 a428c8f7), in a probe schema, raced
#       exactly as case 1: B's release goes through after A's, a no-op on
#       the assignment that moves assignment_version a second time and
#       returns the row. The real function (case 1) refuses it. The probe
#       schema is dropped at the end.
#   4.  No session ever saw 40001 or 40P01.
#
# Runs against a LOCAL stack only, with the S42 migration applied (CONTAINER,
# default the dev stack's supabase_db_stockpilot; the migration scratch stack
# is supabase_db_spmig). Fixtures live under the 54201111-... namespace and
# are removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: bash scripts/db-concurrency/*_release_race.sh (the file carries the
# migration's number)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='54201111-0000-0000-0000-00000000000a'
MGR='54201111-0000-0000-0000-0000000000a1'
ASG='54201111-0000-0000-0000-0000000000a2'
WH='54201111-0000-0000-0000-0000000000c1'
C1='54201111-0000-0000-0000-0000000000d1'
C2='54201111-0000-0000-0000-0000000000d2'
C3='54201111-0000-0000-0000-0000000000d3'
USERS="'$MGR','$ASG'"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
has() { grep -cF -- "$1" "$2"; }
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
wait_locked() { # until that backend waits on a lock (any lock type)
  local _
  for _ in $(seq 1 200); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event_type = 'Lock'")" = "1" ]; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
# A count's assignee (or none) and its assignment_version.
cstate() {
  q "select coalesce(c.assigned_to::text, 'none') || '/' || c.assignment_version
       from public.cycle_counts c where c.id = '$1'"
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
drop schema if exists zz_probe_s42 cascade;
delete from public.notifications where organization_id = '$ORG';
delete from public.cycle_counts where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.cycle_counts where organization_id = '$ORG')
                                 + (select count(*) from auth.users where id in ($USERS))
                                 + (select count(*) from pg_namespace where nspname = 'zz_probe_s42')")"
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

if [ "$(q "select count(*) from pg_proc where proname = 'release_cycle_count' and prosrc like '%S42: a count nobody is assigned to%'")" != "1" ]; then
  echo "the S42 migration is not applied on this stack"; exit 1
fi
cleanup || exit 1

# The assignee's three counts, each assigned by the manager (version 1).
if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$MGR', 's42-2s-mgr@s42.test', '{}'::jsonb),
  ('$ASG', 's42-2s-asg@s42.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values ('$ORG', 'S42 Two Session Org', 's42-two-session');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('$ORG', '$MGR', 'manager', now()),
  ('$ORG', '$ASG', 'staff',   now());
insert into public.warehouses (id, organization_id, name, code, status) values
  ('$WH', '$ORG', 'S42 2S Main', 'WH-S42-2S', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  ('$ORG', '$ASG', '$WH', true);
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, started_by, assigned_to, assignment_claimed_at, assignment_claimed_by,
   assignment_version)
select v.id, '$ORG', '$WH', 'in_progress', '$MGR', '$ASG', now(), '$MGR', 1
  from (values ('$C1'::uuid), ('$C2'::uuid), ('$C3'::uuid)) v(id);
SQL
then
  echo "fixture setup failed"; exit 1
fi

as_user() { # the user's claims, as authenticated (PostgREST's shape)
  printf "set local role authenticated;\nset local \"request.jwt.claim.role\" to 'authenticated';\nset local \"request.jwt.claim.sub\" to '%s';\n" "$1"
}

# race <case> <count> <A's end: commit|rollback> <B's release function>: A
# (the manager) releases the count and holds it; B (the assignee) releases it.
race() {
  local c="$1" cnt="$2" end="$3" fn="$4"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$c.A.out" 2>&1 <<SQL
set application_name to 's42-race-$c-A';
begin;
$(as_user "$MGR")
select 'A=' || coalesce(r.assigned_to::text, 'none') || '/' || r.assignment_version
  from public.release_cycle_count('$cnt', 'Reassigning') r;
select pg_sleep(2);
$end;
SQL
  ) &
  local pa=$!
  wait_sleeping "s42-race-$c-A" || bad "$c: session A never reached its pg_sleep"
  ( "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$c.B.out" 2>&1 <<SQL
set application_name to 's42-race-$c-B';
begin;
$(as_user "$ASG")
select 'B=' || coalesce(r.assigned_to::text, 'none') || '/' || r.assignment_version
  from $fn('$cnt', 'Shift ending') r;
commit;
SQL
  ) &
  local pb=$!
  if wait_locked "s42-race-$c-B"; then ok "$c: B's release waits on A's row lock"; else bad "$c: B never waited on the row lock"; fi
  wait "$pa"; wait "$pb"
}

# ═══ 1. The race: released under the assignee's feet ══════════════════════
echo "== 1. A (a manager) releases the assignee's count and commits; B's (the assignee's) release waits"
race 1 "$C1" commit public.release_cycle_count
check "1: A released it" "$(grep -c '^A=none/2$' "$TMP/1.A.out")" "1"
check "1: B was refused forbidden" "$(has 'forbidden' "$TMP/1.B.out")" "1"
check "1: B's refusal is 42501" "$(has '42501' "$TMP/1.B.out")" "1"
check "1: B got no row back" "$(grep -c '^B=' "$TMP/1.B.out")" "0"
check "1: the count ends released once, by A" "$(cstate "$C1")" "none/2"

# ═══ 2. The control: the manager rolls back ═══════════════════════════════
echo "== 2. the same, but A rolls back: B releases its own count"
race 2 "$C2" rollback public.release_cycle_count
check "2: A had released it before rolling back" "$(grep -c '^A=none/2$' "$TMP/2.A.out")" "1"
check "2: B released its own count after A rolled back" "$(grep -c '^B=none/2$' "$TMP/2.B.out")" "1"
check "2: the count ends released once, by B" "$(cstate "$C2")" "none/2"

# ═══ 3. The mutation: production's body raced the same way ════════════════
echo "== 3. a copy of release_cycle_count without the two S42 blocks, raced as in case 1"
if ! "${PSQL[@]}" >/dev/null 2>"$TMP/3.setup.err" <<'SQL'
create schema zz_probe_s42;
grant usage on schema zz_probe_s42 to authenticated;
do $probe$
declare
  v_def text := pg_get_functiondef('public.release_cycle_count(uuid, text)'::regprocedure);
  v_cut text := substring(v_def from '\n  -- S42: a count nobody is assigned to.*?\n  end if;\n  -- S42: the assignee.*?\n  end if;\n');
begin
  if v_cut is null then
    raise exception 'probe: the S42 blocks were not found';
  end if;
  v_def := replace(v_def, v_cut, E'\n');
  v_def := replace(v_def, 'FUNCTION public.release_cycle_count(', 'FUNCTION zz_probe_s42.release_cycle_count(');
  execute v_def;
end $probe$;
revoke all on function zz_probe_s42.release_cycle_count(uuid, text) from public, anon;
grant execute on function zz_probe_s42.release_cycle_count(uuid, text) to authenticated;
SQL
then
  bad "3: the probe copy could not be made: $(cat "$TMP/3.setup.err")"
else
  check "3: the probe's body is production's before this migration (md5 a428c8f7)" \
    "$(q "select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'zz_probe_s42' and p.proname = 'release_cycle_count'")" \
    "a428c8f73f73ee31516dd186e47bc9f9"
  race 3 "$C3" commit zz_probe_s42.release_cycle_count
  check "3: A released it" "$(grep -c '^A=none/2$' "$TMP/3.A.out")" "1"
  check "3: without the blocks B's release goes through and returns the row" "$(grep -c '^B=none/3$' "$TMP/3.B.out")" "1"
  check "3: the count ends released twice, the second a no-op by the former assignee (what case 1 refuses)" "$(cstate "$C3")" "none/3"
fi

# ═══ 4. Never a retryable error ═══════════════════════════════════════════
echo "== 4. no session saw 40001 or 40P01"
check "4: no 40001/40P01 in any session's output" "$(cat "$TMP"/*.out | grep -cE '40001|40P01|could not serialize|deadlock detected')" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
