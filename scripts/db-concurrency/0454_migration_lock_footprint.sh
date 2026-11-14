#!/usr/bin/env bash
#
# Lock footprint and preflight of the opening-stock migration
# (*_opening_stock_function.sql, docket S8). The file creates and restates
# functions and comments only: CREATE [OR REPLACE] FUNCTION, REVOKE and GRANT
# on a function and COMMENT ON FUNCTION take no lock on any table. This
# proves, on a database without the file:
#
#   1. The preflight refuses (55000, hint s8a_preflight) and nothing after it
#      runs when:
#        a. a function named open_item_stock exists, with any signature;
#        b. a function named _opening_stock_location exists, with any
#           signature;
#        c. tg_seed_initial_level is not its pinned posture (made INVOKER);
#        d. duplicate_inventory_item is not its pinned posture (another
#           search_path).
#   2. Applied in one transaction, the file holds no lock on any relation
#      outside the system catalogs when it ends (so nothing a request reads or
#      writes waits for the push), and the four functions exist.
#   3. The file leaves the session's lock_timeout as it found it (it sets
#      900ms for itself and resets it at the end).
#   4. A second run in the same transaction is refused by the preflight.
#
# Every session ROLLS BACK, so the script changes nothing. It needs the head
# before this file. LOCAL stack only (docker container supabase_db_stockpilot
# by default; CONTAINER=<name> for another local stack). Exit status 0 = every
# check passed.
#
# Usage: bash scripts/db-concurrency/0454_migration_lock_footprint.sh
# (MIG=<path> runs it against the file under another number after a rename.)

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="${MIG:-$(find "$REPO/supabase/migrations" -name '*_opening_stock_function.sql' | sort | tail -n 1)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }

[ -f "$MIG" ] || { echo "migration file not found"; exit 1; }
if [ "$(q "select count(*) from pg_proc where proname in ('open_item_stock', '_opening_stock_location')")" != "0" ]; then
  echo "the file is already applied on this stack: this script needs the head before it"; exit 1
fi

# run_file <tag> <statements before> <statements after>: one transaction that
# runs the setup, the file and the probes, then rolls back.
run_file() {
  { printf '%s\n' "begin;" "$2"; cat "$MIG"; printf '\n%s\n' "$3" "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/$1.out" 2>&1
}
refused() { # refused <tag>: 1/1/0 when the preflight refused and nothing after it ran
  local a=0 b=0 c=0
  grep -q 'ERROR:  55000: S8a preflight refused' "$TMP/$1.out" && a=1
  grep -q 'HINT:  s8a_preflight' "$TMP/$1.out" && b=1
  grep -q '^APPLIED' "$TMP/$1.out" && c=1
  printf '%s/%s/%s' "$a" "$b" "$c"
}

# ═══ 1. The preflight ══════════════════════════════════════════════════════
run_file pre-a "create function public.open_item_stock(p int) returns int language sql as 'select 1';" "select 'APPLIED';"
check "1a: a function named open_item_stock with another signature is refused" "$(refused pre-a)" "1/1/0"
run_file pre-b "create function public._opening_stock_location(p uuid) returns uuid language sql as 'select null::uuid';" "select 'APPLIED';"
check "1b: a function named _opening_stock_location with another signature is refused" "$(refused pre-b)" "1/1/0"
run_file pre-c "alter function public.tg_seed_initial_level() security invoker;" "select 'APPLIED';"
check "1c: tg_seed_initial_level made INVOKER is refused" "$(refused pre-c)" "1/1/0"
run_file pre-d "alter function public.duplicate_inventory_item(uuid, jsonb) set search_path = public, extensions;" "select 'APPLIED';"
check "1d: duplicate_inventory_item with another search_path is refused" "$(refused pre-d)" "1/1/0"

# ═══ 2-4. Applied in one transaction ═══════════════════════════════════════
run_file apply "set lock_timeout = '0';" "
select 'LOCKS=' || coalesce(string_agg(c.oid::regclass::text || ':' || l.mode, ',' order by 1), '')
  from pg_locks l join pg_class c on c.oid = l.relation
 where l.pid = pg_backend_pid() and l.locktype = 'relation'
   and c.relnamespace not in ('pg_catalog'::regnamespace, 'pg_toast'::regnamespace, 'information_schema'::regnamespace);
select 'FUNCS=' || count(*) from pg_proc
 where oid in (to_regprocedure('public.open_item_stock(uuid,jsonb)'),
               to_regprocedure('public._opening_stock_location(public.inventory_items)'),
               to_regprocedure('public.duplicate_inventory_item(uuid,jsonb)'),
               to_regprocedure('public.tg_seed_initial_level()'));
select 'MD5=' || string_agg(p.proname || ':' || md5(p.prosrc), ' ' order by p.proname) from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('open_item_stock', '_opening_stock_location', 'duplicate_inventory_item', 'tg_seed_initial_level');
select 'TIMEOUT=' || current_setting('lock_timeout');"
if grep -q 'ERROR' "$TMP/apply.out"; then bad "2: the file failed: $(grep 'ERROR' "$TMP/apply.out" | head -3 | tr '\n' ' ')"; fi
check "2: no lock on any relation outside the system catalogs at the end of the file" "$(grep '^LOCKS=' "$TMP/apply.out")" "LOCKS="
check "2: the four functions exist" "$(grep '^FUNCS=' "$TMP/apply.out")" "FUNCS=4"
grep '^MD5=' "$TMP/apply.out" | sed 's/^/info   /'
check "3: lock_timeout is the session's own again after the file" "$(grep '^TIMEOUT=' "$TMP/apply.out")" "TIMEOUT=0"

{ printf '%s\n' "begin;"; cat "$MIG"; printf '\n'; cat "$MIG"; printf '\n%s\n' "select 'APPLIED';" "rollback;"; } \
  | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/twice.out" 2>&1
check "4: a second run is refused by the preflight" "$(refused twice)" "1/1/0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
