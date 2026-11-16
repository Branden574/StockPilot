#!/usr/bin/env bash
#
# Two-session proofs for the migration with which the database records role
# and sign-in policy changes in the audit log
# (supabase/migrations/*_role_and_sign_in_policy_changes_recorded_by_database.sql).
# The app's audit writer sends its own row for such a change as the server's
# role: a first try (a plain INSERT with an id the writer chose) and, when
# it did not hear back in time, later tries of the same row (INSERT ... ON
# CONFLICT (id) DO NOTHING). Two tries of one row can be in flight at once.
# pgTAP runs in ONE session, so it cannot show two tries overlapping.
#
#   1.  A recorded change, then the app's row, two tries overlapping. An
#       admin changes a member's role (committed): the database records one
#       row. Session A sends the first try and keeps its transaction open;
#       session B sends a later try of the same row meanwhile. Neither is
#       stored and neither waits for the other; the recorded row is the only
#       row for the change, in place and byte for byte as it was.
#   1b. The same with the later try first (A) and the first try arriving
#       while A is open (B).
#   2.  The same for a sign-in policy change.
#   3.  A change the database did not record (a row that names no recorded
#       change), two tries overlapping: A's first try is stored and held
#       open; B's later try waits for A, then writes nothing. One row, A's.
#   3b. The other order: A's later try is stored and held open; B's first
#       try waits for A, then is refused 23505. One row, A's.
#   4.  No session ever saw 40001 or 40P01.
#
# Runs against a LOCAL stack only, with the migration applied (CONTAINER,
# default the dev stack's supabase_db_stockpilot; the migration scratch stack
# is supabase_db_spmig). Fixtures live under the c0a71111-... namespace and
# are removed at the start, at the end and by the EXIT trap. Exit status 0 =
# every check passed.
#
# Usage: bash scripts/db-concurrency/*_app_row_race.sh (the file carries the
# migration's number)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
TMP="$(mktemp -d)"

ORG='c0a71111-0000-4000-8000-00000000000a'
ADM='c0a71111-0000-4000-8000-0000000000a1'
STF='c0a71111-0000-4000-8000-0000000000a2'
M_ADM='c0a71111-0000-4000-8000-0000000001a1'
M_STF='c0a71111-0000-4000-8000-0000000001a2'
E_NONE='c0a71111-0000-4000-8000-0000000003e1'
X1='c0a71111-0000-4000-8000-0000000002c1'
X1B='c0a71111-0000-4000-8000-0000000002c2'
X2='c0a71111-0000-4000-8000-0000000002c3'
X3='c0a71111-0000-4000-8000-0000000002c4'
X3B='c0a71111-0000-4000-8000-0000000002c5'
USERS="'$ADM','$STF'"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }
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
# The rows of an event that name an entity: how many, and the recorded ones
# as stored (place, writing transaction, md5 of the whole row).
rows_of() { # rows_of <event> <entity id>
  q "select count(*)::text || ' ' || coalesce(string_agg(a.ctid::text || '/' || a.xmin::text || '/' || md5(a::text), ',' order by a.ctid)
                                                filter (where a.metadata ->> 'source' = 'database'), 'none')
       from public.audit_logs a
      where a.organization_id = '$ORG' and a.event = '$1' and a.metadata ->> 'entity_id' = '$2'"
}
by_id() { q "select count(*) from public.audit_logs a where a.id = '$1'"; }

# The app's row, as its writer shapes it. try=first: a plain INSERT.
# try=later: the time of the event and ON CONFLICT (id) DO NOTHING. Prints
# '<tag>|<rows stored>'.
app_row() { # app_row <tag> <id> <event> <entity type> <entity id> <before json> <after json> <first|later>
  local cols="id, organization_id, user_id, event, ip, user_agent, metadata" tail=""
  local vals="'$2', '$ORG', '$ADM', '$3', '203.0.113.7', 'Mozilla/5.0 (test browser)',
    jsonb_build_object('entity_type', '$4', 'entity_id', '$5', 'warehouse_id', null,
                       'before', '$6'::jsonb, 'after', '$7'::jsonb, 'reason', null)"
  if [ "$8" = "later" ]; then cols="$cols, created_at"; vals="$vals, now()"; tail=" on conflict (id) do nothing"; fi
  printf "with w as (insert into public.audit_logs (%s) values (%s)%s returning 1) select '%s|' || count(*) from w;\n" \
    "$cols" "$vals" "$tail" "$1"
}
# One session as the server's role: <statements>, optionally held open.
as_server() { # as_server <application_name> <sql> [hold seconds]
  printf "set application_name = '%s';\nbegin;\nselect set_config('request.jwt.claims', '{\"role\": \"service_role\"}', true);\nset local role service_role;\n%s\n" "$1" "$2"
  if [ -n "${3:-}" ]; then printf "select pg_sleep(%s);\n" "$3"; fi
  printf "commit;\n"
}

cleanup() {
  if ! "${PSQL[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from public.audit_logs where organization_id = '$ORG';
delete from public.organizations where id = '$ORG';
delete from auth.users where id in ($USERS);
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
  local left
  left="$("${PSQL[@]}" -c "select (select count(*) from public.audit_logs where organization_id = '$ORG')
                                 + (select count(*) from public.organizations where id = '$ORG')
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

if [ "$(q "select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O'
            and t.tgname in ('trg_zz_record_mfa_policy_change', 'trg_zz_record_member_role_change', 'zz_fold_app_copy')")" != "3" ]; then
  echo "the recorded changes migration is not applied on this stack"; exit 1
fi
cleanup || exit 1

if ! "${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
  ('$ADM', 'rec-2s-adm@rec.test', '{}'::jsonb),
  ('$STF', 'rec-2s-stf@rec.test', '{}'::jsonb);
insert into public.organizations (id, name, slug, mfa_policy)
  values ('$ORG', 'Rec Two Session Org', 'rec-two-session', 'optional');
insert into public.organization_members (id, organization_id, user_id, role, accepted_at) values
  ('$M_ADM', '$ORG', '$ADM', 'admin', now()),
  ('$M_STF', '$ORG', '$STF', 'staff', now());
-- The two changes, each made by the admin through the Data API's role and
-- claims, each committed.
begin;
select set_config('request.jwt.claims', '{"sub": "$ADM", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
update public.organization_members set role = 'manager' where id = '$M_STF';
update public.organizations set mfa_policy = 'all_required' where id = '$ORG';
commit;
SQL
then
  echo "could not create the fixtures"; exit 1
fi

ROLE_BEFORE="$(rows_of user.role.changed "$M_STF")"
POLICY_BEFORE="$(rows_of organization.mfa_policy.changed "$ORG")"
case "$ROLE_BEFORE" in "1 "*/*/*) ok "0: the role change left one recorded row" ;; *) bad "0: the role change left: $ROLE_BEFORE" ;; esac
case "$POLICY_BEFORE" in "1 "*/*/*) ok "0: the sign-in policy change left one recorded row" ;; *) bad "0: the policy change left: $POLICY_BEFORE" ;; esac

# overlap <label> <A's sql> <B's sql>: A runs its statement and holds its
# transaction open for 3 s; B runs its statement meanwhile. Leaves
# $TMP/<label>.a.out|err and .b.out|err; B_WAITED=yes when B was seen waiting
# on a lock, B_DONE_FIRST=yes when B finished while A was still open.
overlap() {
  local label="$1"
  as_server "rec-race-a-$label" "$2" 3 | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.a.out" 2> "$TMP/$label.a.err" &
  local ap=$!
  if ! wait_sleeping "rec-race-a-$label"; then bad "$label: session A never reached pg_sleep: $(tr '\n' ' ' < "$TMP/$label.a.err")"; wait "$ap"; return 1; fi
  as_server "rec-race-b-$label" "$3" | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$label.b.out" 2> "$TMP/$label.b.err" &
  local bp=$!
  # Until B is seen waiting on a lock, or B has finished.
  B_WAITED=no
  B_DONE_FIRST=no
  while kill -0 "$bp" 2> /dev/null; do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = 'rec-race-b-$label' and wait_event_type = 'Lock'")" = "1" ]; then
      B_WAITED=yes
      break
    fi
    sleep 0.05
  done
  wait "$bp"
  if [ "$B_WAITED" = "no" ] \
     && [ "$(q "select count(*) from pg_stat_activity where application_name = 'rec-race-a-$label' and wait_event = 'PgSleep'")" = "1" ]; then
    B_DONE_FIRST=yes
  fi
  wait "$ap"
  return 0
}
out() { grep -E "^$2\|" "$TMP/$1" 2> /dev/null | tail -n 1; }
state_of() { grep -oE 'ERROR:  [0-9A-Z]{5}' "$TMP/$1" 2> /dev/null | head -n 1 | sed 's/ERROR:  //'; }

# ── 1. A recorded role change: first try open, later try meanwhile ────────
ROLE_ROW_ARGS=(user.role.changed organization_member "$M_STF" '{"role": "staff"}' '{"role": "manager"}')
if overlap 1 "$(app_row A "$X1" "${ROLE_ROW_ARGS[@]}" first)" "$(app_row B "$X1" "${ROLE_ROW_ARGS[@]}" later)"; then
  check "1: A's first try is accepted and not stored" "$(out 1.a.out A)" "A|0"
  check "1: B's later try is accepted and not stored" "$(out 1.b.out B)" "B|0"
  check "1: B did not wait for A, and finished while A's transaction was open" "waited=$B_WAITED done-first=$B_DONE_FIRST" "waited=no done-first=yes"
  check "1: one row for the change, the recorded one, unchanged" "$(rows_of user.role.changed "$M_STF")" "$ROLE_BEFORE"
  check "1: no row has the id the app chose" "$(by_id "$X1")" "0"
fi

# ── 1b. The later try open, the first try meanwhile ───────────────────────
if overlap 1b "$(app_row A "$X1B" "${ROLE_ROW_ARGS[@]}" later)" "$(app_row B "$X1B" "${ROLE_ROW_ARGS[@]}" first)"; then
  check "1b: A's later try is accepted and not stored" "$(out 1b.a.out A)" "A|0"
  check "1b: B's first try is accepted and not stored" "$(out 1b.b.out B)" "B|0"
  check "1b: B did not wait for A, and finished while A's transaction was open" "waited=$B_WAITED done-first=$B_DONE_FIRST" "waited=no done-first=yes"
  check "1b: one row for the change, the recorded one, unchanged" "$(rows_of user.role.changed "$M_STF")" "$ROLE_BEFORE"
  check "1b: no row has the id the app chose" "$(by_id "$X1B")" "0"
fi

# ── 2. A recorded sign-in policy change ───────────────────────────────────
POLICY_ROW_ARGS=(organization.mfa_policy.changed organization "$ORG" '{"mfa_policy": "optional"}' '{"mfa_policy": "all_required"}')
if overlap 2 "$(app_row A "$X2" "${POLICY_ROW_ARGS[@]}" first)" "$(app_row B "$X2" "${POLICY_ROW_ARGS[@]}" later)"; then
  check "2: A's first try is accepted and not stored" "$(out 2.a.out A)" "A|0"
  check "2: B's later try is accepted and not stored" "$(out 2.b.out B)" "B|0"
  check "2: B did not wait for A, and finished while A's transaction was open" "waited=$B_WAITED done-first=$B_DONE_FIRST" "waited=no done-first=yes"
  check "2: one row for the change, the recorded one, unchanged" "$(rows_of organization.mfa_policy.changed "$ORG")" "$POLICY_BEFORE"
  check "2: no row has the id the app chose" "$(by_id "$X2")" "0"
fi

# ── 3. A row that names no recorded change: first try open, later try ─────
NONE_ROW_ARGS=(user.role.changed organization_member "$E_NONE" '{"role": "staff"}' '{"role": "manager"}')
if overlap 3 "$(app_row A "$X3" "${NONE_ROW_ARGS[@]}" first)" "$(app_row B "$X3" "${NONE_ROW_ARGS[@]}" later)"; then
  check "3: A's first try is stored" "$(out 3.a.out A)" "A|1"
  check "3: B's later try waited for A, then wrote nothing" "$(out 3.b.out B) waited=$B_WAITED" "B|0 waited=yes"
  check "3: one row, with the id the app chose" "$(rows_of user.role.changed "$E_NONE") by-id=$(by_id "$X3")" "1 none by-id=1"
fi

# ── 3b. The other order: later try open, first try meanwhile ──────────────
E_NONE_B='c0a71111-0000-4000-8000-0000000003e2'
NONE_B_ROW_ARGS=(user.role.changed organization_member "$E_NONE_B" '{"role": "staff"}' '{"role": "manager"}')
if overlap 3b "$(app_row A "$X3B" "${NONE_B_ROW_ARGS[@]}" later)" "$(app_row B "$X3B" "${NONE_B_ROW_ARGS[@]}" first)"; then
  check "3b: A's later try is stored" "$(out 3b.a.out A)" "A|1"
  check "3b: B's first try waited for A, then was refused" "$(state_of 3b.b.err) waited=$B_WAITED" "23505 waited=yes"
  check "3b: one row, with the id the app chose" "$(rows_of user.role.changed "$E_NONE_B") by-id=$(by_id "$X3B")" "1 none by-id=1"
fi

# ── 4. No serialization failure, no deadlock ──────────────────────────────
if grep -lE '40001|40P01' "$TMP"/*.err > /dev/null 2>&1; then
  bad "4: a session saw 40001 or 40P01: $(grep -lE '40001|40P01' "$TMP"/*.err | tr '\n' ' ')"
else
  ok "4: no session saw 40001 or 40P01"
fi
UNEXPECTED="$(cat "$TMP"/1.*.err "$TMP"/1b.*.err "$TMP"/2.*.err "$TMP"/3.*.err "$TMP"/3b.a.err 2> /dev/null | grep -c 'ERROR')"
check "4: only 3b's refused first try reported an error" "$UNEXPECTED" "0"

cleanup || bad "cleanup"

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
