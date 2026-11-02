#!/usr/bin/env bash
#
# Lock footprint of migration 0425 (docket S7, slice S7a: the replacement
# guards). The push runs the whole file as one batch, so every table lock a
# statement takes is held until the file commits. The functions (plpgsql,
# none declaring a table's row type), their comments and revokes lock no
# table; the only table statements are the two CREATE OR REPLACE TRIGGER
# statements, which take SHARE ROW EXCLUSIVE on order_request_lines and on
# order_requests. So the file takes both in one NOWAIT prelude
# (`do $lock$ ... end $lock$;`) and never waits holding one.
#
#   1a. Before the prelude the file holds no lock on any table outside the
#       catalogs (the preflight, the two helpers, the restated bodies, the
#       revokes, the grant and the comments).
#   1b. The prelude takes SHARE ROW EXCLUSIVE on order_request_lines and
#       order_requests, and nothing else.
#   1c. No statement after the prelude locks another existing table, and the
#       file never takes ACCESS EXCLUSIVE anywhere.
#   2.  The hold, from the prelude to the end of the file, is under 250 ms on
#       the local stack.
#   3.  A writer of order_request_lines, then a writer of order_requests, each
#       with an open transaction held longer than the retries last: the file
#       retries, holds NO table lock whenever it is paused between attempts,
#       and fails 55P03. 3b: a line writer held 0.6 s: the file retries past
#       it and runs to the end.
#   4.  Nothing was applied: neither helper exists and both triggers keep
#       0396's definitions.
#
# The migration sessions ALWAYS roll back. It needs the pre-0425 head (every
# migration before it applied, 0416 included). LOCAL stack only (CONTAINER,
# default the dev stack's supabase_db_stockpilot; the migration scratch stack
# is supabase_db_spmig). Exit status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0425_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# The file keeps its name when the kit renumbers it.
MIG=""
for f in "$REPO"/supabase/migrations/*_replacement_guards.sql; do
  if [ -f "$f" ]; then MIG="$f"; break; fi
done
TMP="$(mktemp -d)"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1"; }
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
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { wait 2> /dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

LINES_DEF="CREATE TRIGGER trg_zz_order_request_lines_replacement_guard BEFORE INSERT ON public.order_request_lines FOR EACH ROW EXECUTE FUNCTION tg_order_request_lines_replacement_guard()"
STATE_SQL="select (select count(*) from pg_proc
                    where proname in ('_return_replacement_warehouse_gate', '_replacement_line_parents'))::text || '|'
       || (select regexp_replace(pg_get_triggerdef(t.oid), 'FUNCTION (public\\.)?', 'FUNCTION ') from pg_trigger t
            where t.tgname = 'trg_zz_order_request_lines_replacement_guard') || '|'
       || (select (pg_get_triggerdef(t.oid) !~ 'cancelled')::text from pg_trigger t
            where t.tgname = 'trg_order_requests_zz_replacement_header')"

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_replacement_guards.sql"; exit 1; }
HAS_RX4="$(q "select count(*) from pg_proc where proname = 'close_return_replacement_rest'")"
if [ "$HAS_RX4" = "0" ] || [ "$(q "$STATE_SQL")" != "0|$LINES_DEF|true" ]; then
  echo "needs the pre-0425 head (every earlier migration applied, 0425 not)"
  exit 1
fi

# shellcheck disable=SC2016  # a literal $lock$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || { echo "no lock prelude in $MIG"; exit 1; }
head -n $((P0 - 1)) "$MIG" > "$TMP/part1.sql"
sed -n "${P0},${P1}p" "$MIG" > "$TMP/prelude.sql"
tail -n +$((P1 + 1)) "$MIG" > "$TMP/part3.sql"
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"
ALL_MODES_SQL="select coalesce(string_agg(distinct l.mode, ',' order by l.mode), 'none')
  from pg_locks l where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted"

# ── 1 and 2 ──────────────────────────────────────────────────────────────
{
  echo "begin;"
  cat "$TMP/part1.sql"
  echo "select 'BEFORE|' || coalesce(($LOCKS_SQL), 'none');"
  echo "select 'T0|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/prelude.sql"
  echo "select 'PRELUDE|' || coalesce(($LOCKS_SQL), 'none');"
  cat "$TMP/part3.sql"
  echo "select 'T1|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'END|' || coalesce(($LOCKS_SQL), 'none');"
  echo "select 'MODES|' || ($ALL_MODES_SQL);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err")"
else
  BEFORE="$(sed -n 's/^BEFORE|//p' "$TMP/1.out")"
  PRELUDE="$(sed -n 's/^PRELUDE|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  MODES="$(sed -n 's/^MODES|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then ok "1a: the preflight, the two helpers, the restated bodies, the revokes, the grant and the comments lock no table"
  else bad "1a: before the prelude the file already holds: $BEFORE"; fi
  if [ "$PRELUDE" = "public.order_request_lines:ShareRowExclusiveLock,public.order_requests:ShareRowExclusiveLock" ]; then
    ok "1b: the prelude takes exactly order_request_lines and order_requests (share row exclusive)"
  else bad "1b: the prelude took: $PRELUDE"; fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then ok "1c: nothing after the prelude locks another existing table"
  else bad "1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"; fi
  case ",$MODES," in
    *,AccessExclusiveLock,*) bad "1c: the file took ACCESS EXCLUSIVE somewhere (modes held: $MODES)" ;;
    *) ok "1c: the file never takes ACCESS EXCLUSIVE (modes held at the end: $MODES)" ;;
  esac
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt 250 ]; then ok "2: the prelude to the end of the file took $((T1 - T0)) ms"
  else bad "2: the prelude to the end of the file took $((T1 - T0)) ms"; fi
fi

# ── 3. An open transaction that writes one of the two tables ─────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0425-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0425-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then bad "3 $label: the holder never reached pg_sleep"; wait "$hp"; return; fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0425-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/3-$label.m.out" 2> "$TMP/3-$label.m.err" &
  local mp=$!
  local samples=0 sleeping=0 held=0 r
  while kill -0 "$mp" 2> /dev/null; do
    r="$(q "$LOCKS_OF_SLEEPING_FILE")"
    samples=$((samples + 1))
    sleeping=$((sleeping + ${r%%|*}))
    held=$((held + ${r##*|}))
    sleep 0.05
  done
  wait "$mp"
  rc=$?
  t1="$(now_ms)"
  if [ "$held" -ne 0 ]; then
    bad "3 $label: while paused between attempts the file held $held table lock(s)"
  elif [ "$expect" = "fail" ] && [ "$sleeping" -lt 1 ]; then
    bad "3 $label: never saw the file pause between attempts ($samples samples)"
  fi
  if [ "$expect" = "fail" ]; then
    if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err"; then
      ok "3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused, then failed 55P03"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  else
    if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
      ok "3 $label: the file retried past the holder and ran to the end after $((t1 - t0)) ms (rolled back)"
    else
      bad "3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  fi
  wait "$hp"
}
# A writer's statement takes ROW EXCLUSIVE on its table even when it changes
# no row; SHARE ROW EXCLUSIVE conflicts with it.
run_behind lines-writer "update public.order_request_lines set notes = notes where false;" 9 fail
run_behind orders-writer "update public.order_requests set internal_notes = internal_notes where false;" 9 fail
run_behind 3b-short-lines-writer "update public.order_request_lines set notes = notes where false;" 0.6 apply

# ── 4. Nothing applied ───────────────────────────────────────────────────
if [ "$(q "$STATE_SQL")" = "0|$LINES_DEF|true" ]; then
  ok "4: nothing was applied (no helper; both triggers keep 0396's definitions)"
else
  bad "4: the stack changed: $(q "$STATE_SQL")"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
