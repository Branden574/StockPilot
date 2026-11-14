#!/usr/bin/env bash
#
# What gate.session_meets_mfa() and gate.factor_read_state() (migration 0455,
# *_session_factor_helper.sql) answer when the factor table cannot be read,
# shown on the real auth.mfa_factors as the local stack's superuser. pgTAP
# cannot do this: the role the tests run as may not change the auth schema or
# another role's attributes. Each case breaks one thing inside a transaction,
# calls both functions for a fixture account that holds a verified factor, at
# aal1, and rolls back:
#
#   1. nothing broken (control): helper false, no flag; premise check ok.
#   2. SELECT on auth.mfa_factors revoked from postgres: helper false, no
#      flag; premise check ok (postgres still reads the table through its
#      pg_read_all_data membership).
#   3. column status renamed (42703): helper true, flag 42703; premise check
#      catalog.
#   4. column user_id renamed (42703): helper true, flag 42703; premise check
#      catalog (it reads both columns the helper filters on).
#   5. table renamed (42P01): helper true, flag 42P01; premise check catalog.
#   6. enum label verified renamed (22P02, not one of the four catalog
#      errors): the helper's call fails; nothing is answered. The premise
#      check, read in a transaction of its own, answers error.
#   7. postgres without BYPASSRLS (no error at all): helper true with no
#      flag; premise check blind. This case raises nothing for the helper to
#      catch; the premise check and the migration's preflight are what see it.
#
# And:
#   8. Cases 3, 4 and 5 each call the helper twice in their transaction, and
#      the server log holds exactly one catalog_error line for each (one per
#      transaction), naming 42703, 42703 and 42P01.
#   9. The migration's own preflight, run as postgres with postgres's
#      BYPASSRLS taken away (rolled back), stops with 55000 (hint
#      gate_helper_preflight) naming the missing BYPASSRLS or SUPERUSER.
#  10. The stack is as it was: postgres has BYPASSRLS, auth.mfa_factors and
#      its user_id and status columns and label are in place, and the helper's body is the
#      one pinned below.
#
# Runs against a LOCAL stack only (CONTAINER, default the dev stack's
# supabase_db_stockpilot; the migration scratch stack is supabase_db_spmig),
# at the state after the file. It connects inside the container as
# supabase_admin (the local superuser) and as postgres. The fixture account
# lives under the 9a7e00f0-... namespace and is removed at the start, at the
# end and by the EXIT trap. Exit status 0 = every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0455_gate_catalog_errors.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
SU=(docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -X -q -At)
PG=(docker exec -i "$CONTAINER" psql -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG=""
for f in "$REPO"/supabase/migrations/*_session_factor_helper.sql; do [ -f "$f" ] && MIG="$f" && break; done
TMP="$(mktemp -d)"

HELPER_MD5='85bf4ab1b6a710b1bb8a5595bb0ffff7'
U='9a7e00f0-0000-4000-8000-0000000000f1'
CLAIMS="{\"sub\": \"$U\", \"role\": \"authenticated\", \"aal\": \"aal1\"}"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PG[@]}" -c "$1"; }

cleanup() {
  if ! "${PG[@]}" >/dev/null 2>"$TMP/cleanup.err" <<SQL
delete from auth.mfa_factors where user_id = '$U';
delete from auth.users where id = '$U';
SQL
  then
    echo "cleanup failed:"; cat "$TMP/cleanup.err"; return 1
  fi
}
# shellcheck disable=SC2329 # called from the EXIT trap below
on_exit() {
  cleanup >/dev/null 2>&1
  rm -rf "$TMP"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# One case: <breaker> as the superuser, then <calls> helper calls as the
# enrolled account at aal1, the flag, and the premise check, all in one
# transaction that is rolled back. Errors do not stop psql: the output says
# what was answered and what failed.
run_case() { # run_case <tag> <breaker> <calls>
  local calls=""
  for _ in $(seq 1 "$3"); do
    calls="$calls
select 'helper=' || gate.session_meets_mfa()::text;"
  done
  "${SU[@]}" > "$TMP/$1.out" 2>&1 <<SQL
begin;
$2;
set local "request.jwt.claim.sub" to '$U';
set local "request.jwt.claims" to '$CLAIMS';
set local role authenticated;
$calls
select 'flag=' || coalesce(nullif(current_setting('sp_gate.catalog_error', true), ''), 'none');
reset role;
select 'premise=' || gate.factor_read_state();
rollback;
SQL
}
answer() { # answer <tag>: helper answers, flag and premise, or the error's SQLSTATE
  local f="$TMP/$1.out" h
  h="$(grep '^helper=' "$f" | cut -d= -f2 | sort -u | tr '\n' ',' | sed 's/,$//')"
  if grep -q '^ERROR' "$f"; then
    echo "error=$(grep -m1 -oE 'invalid input value for enum|does not exist|permission denied' "$f")|helper=${h:-none}|premise=$(grep '^premise=' "$f" | cut -d= -f2 || true)"
  else
    echo "helper=$h|$(grep '^flag=' "$f")|$(grep '^premise=' "$f")"
  fi
}

# ═══ 0. Preconditions ═════════════════════════════════════════════════════
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_session_factor_helper.sql"; exit 1; }
if [ "$(q "select md5(prosrc) from pg_proc where oid = to_regprocedure('gate.session_meets_mfa()')")" != "$HELPER_MD5" ]; then
  echo "needs the state after the file: gate.session_meets_mfa() with body md5 $HELPER_MD5"; exit 1
fi
check "0: the local superuser connects" "$("${SU[@]}" -c "select rolsuper from pg_roles where rolname = current_user")" "t"
cleanup || exit 1
if ! "${PG[@]}" > "$TMP/setup.log" 2>&1 <<SQL
insert into auth.users (id, email, raw_user_meta_data) values ('$U', 'gate-catalog@example.test', '{}'::jsonb);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('9a7e00f0-0000-4000-8000-0000000001f1', '$U', 'gate catalog', 'totp', 'verified', now(), now());
SQL
then
  echo "fixture setup failed: $(cat "$TMP/setup.log")"; exit 1
fi
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep 1

# ═══ 1-7. The seven cases ═════════════════════════════════════════════════
echo "== 1-7. the seven cases, each rolled back"
run_case c1 "select 1" 1
check "1: nothing broken (control)" "$(answer c1)" "helper=false|flag=none|premise=ok"
run_case c2 "revoke select on auth.mfa_factors from postgres" 1
check "2: SELECT revoked from postgres (pg_read_all_data still reads)" "$(answer c2)" "helper=false|flag=none|premise=ok"
run_case c3 "alter table auth.mfa_factors rename column status to status_gone" 2
check "3: column status renamed (42703)" "$(answer c3)" "helper=true|flag=42703|premise=catalog"
run_case c4 "alter table auth.mfa_factors rename column user_id to user_id_gone" 2
check "4: column user_id renamed (42703): the premise check sees it too" "$(answer c4)" "helper=true|flag=42703|premise=catalog"
run_case c5 "alter table auth.mfa_factors rename to mfa_factors_gone" 2
check "5: table renamed (42P01)" "$(answer c5)" "helper=true|flag=42P01|premise=catalog"
run_case c6 "alter type auth.factor_status rename value 'verified' to 'verified_gone'" 1
check "6: enum label renamed (22P02): the call fails, nothing answered" "$(answer c6)" "error=invalid input value for enum|helper=none|premise="
"${SU[@]}" > "$TMP/c6p.out" 2>&1 <<SQL
begin;
alter type auth.factor_status rename value 'verified' to 'verified_gone';
select 'premise=' || gate.factor_read_state();
rollback;
SQL
check "6: the same, the premise check read on its own answers error" "$(grep '^premise=' "$TMP/c6p.out")" "premise=error"
run_case c7 "alter role postgres nobypassrls" 1
check "7: postgres without BYPASSRLS: true with no flag; the premise check says blind" "$(answer c7)" "helper=true|flag=none|premise=blind"

# ═══ 8. One log line per transaction ══════════════════════════════════════
echo "== 8. the server log: one catalog_error line per transaction"
sleep 1
docker logs --since "$SINCE" "$CONTAINER" > "$TMP/server.log" 2>&1
check "8: exactly three catalog_error lines (cases 3, 4 and 5 each called the helper twice)" \
  "$(grep -c 'aal2_gate catalog_error' "$TMP/server.log")" "3"
check "8: they name 42703, 42703 and 42P01" \
  "$(grep -oE 'aal2_gate catalog_error sqlstate=[0-9A-Z]+' "$TMP/server.log" | sort | tr '\n' ' ' | sed 's/ $//')" \
  "aal2_gate catalog_error sqlstate=42703 aal2_gate catalog_error sqlstate=42703 aal2_gate catalog_error sqlstate=42P01"

# ═══ 9. The preflight sees the missing BYPASSRLS ══════════════════════════
echo "== 9. the migration's preflight as postgres without BYPASSRLS (rolled back)"
PRE="$(awk '/^do \$gate_pre\$$/ { on = 1 } on { print } /^\$gate_pre\$;$/ { exit }' "$MIG")"
[ -n "$PRE" ] || bad "9: could not find the preflight block in the file"
{ echo "begin;"; echo "alter role postgres nobypassrls;"; echo "set local role postgres;"; echo "$PRE"; echo "select 'DONE';"; echo "rollback;"; } \
  | "${SU[@]}" -v VERBOSITY=verbose > "$TMP/pre.x55" 2>&1
if grep -q 'ERROR:  55000' "$TMP/pre.x55" && grep -q 'HINT:  gate_helper_preflight' "$TMP/pre.x55" \
   && grep -qF 'the migration role (postgres) has neither BYPASSRLS nor SUPERUSER' "$TMP/pre.x55" && ! grep -q '^DONE$' "$TMP/pre.x55"; then
  ok "9: 55000 gate_helper_preflight naming 'the migration role (postgres) has neither BYPASSRLS nor SUPERUSER'"
else
  bad "9: $(grep -E 'ERROR|HINT' "$TMP/pre.x55" | head -3 | tr '\n' ' ')"
fi

# ═══ 10. As it was ════════════════════════════════════════════════════════
echo "== 10. the stack is as it was"
check "10: postgres has BYPASSRLS; the table, its user_id and status columns and the label verified are in place; the helper's body is unchanged" \
  "$(q "select (select rolbypassrls from pg_roles where rolname = 'postgres')::text
              || '|' || (to_regclass('auth.mfa_factors') is not null)::text
              || '|' || exists (select 1 from pg_attribute where attrelid = 'auth.mfa_factors'::regclass and attname = 'user_id')::text
              || '|' || exists (select 1 from pg_attribute where attrelid = 'auth.mfa_factors'::regclass and attname = 'status')::text
              || '|' || exists (select 1 from pg_enum where enumtypid = 'auth.factor_status'::regtype and enumlabel = 'verified')::text
              || '|' || (select md5(prosrc) from pg_proc where oid = to_regprocedure('gate.session_meets_mfa()'))")" \
  "true|true|true|true|true|$HELPER_MD5"
check "10: postgres may select auth.mfa_factors" "$(q "select has_table_privilege('postgres', 'auth.mfa_factors', 'SELECT')")" "t"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; fi
cleanup || FAILS=$((FAILS + 1))
exit "$FAILS"
