#!/usr/bin/env bash
#
# Lock footprint of migration 0413 (ordering visibility). The push runs the
# whole file as one batch, so every table lock a statement takes is held until
# the file commits. ADD COLUMN takes ACCESS EXCLUSIVE on inventory_items and
# organizations (every request's context read touches organizations), the
# CHECK re-add takes it on platform_admin_audit, and the new triggers take
# SHARE ROW EXCLUSIVE on order_request_lines and the three permission tables.
# A file that held one of these and then waited for another could close a
# cycle with ordinary traffic, so the file takes every lock in one NOWAIT
# prelude and never waits holding one. This proves, with the migration session
# ALWAYS rolled back:
#
#   0.  The preflight (before the prelude) takes no lock on any table outside
#       the catalogs.
#   1a. The prelude takes exactly: ACCESS EXCLUSIVE on inventory_items,
#       organizations and platform_admin_audit; SHARE ROW EXCLUSIVE on
#       order_request_lines, user_permission_overrides,
#       role_permission_overrides and role_default_permissions; ACCESS SHARE
#       on organization_members, organization_modules, user_profiles,
#       public_request_links, public_link_catalog_entries, warehouses,
#       categories and order_requests; nothing else outside the catalogs.
#   1b. No statement after the prelude locks a table the prelude had not
#       locked, so the file can never wait while holding a lock.
#   2.  The hold, from the end of the prelude to the end of the file, on this
#       stack (reported; bounded at 1500 ms here).
#   3.  An open writer on inventory_items (ROW EXCLUSIVE) held 9 s: the file
#       retries, holds NO table lock while paused between attempts (sampled
#       from pg_locks), and fails 55P03 after its 40 attempts, applying
#       nothing.
#   3b. The same writer held 0.6 s: the file retries past it and runs to the
#       end.
#   4.  An open organizations reader (every request's context read) held
#       0.6 s: the same, the file runs to the end. Nobody sees 40P01.
#   5.  The preflight refuses drift: with one replaced body
#       (order_items_orderable) or one relied-on policy
#       (inventory_items_select) altered earlier in the same transaction, the
#       file stops with 55000 order_visibility_preflight naming it (the
#       catalog-only first half for a body, the second half right after the
#       prelude for a policy, which deparsing locks), before any change, and
#       nothing is applied.
#
# LOCAL stack only (CONTAINER, default supabase_db_stockpilot; the migration
# scratch stack is supabase_db_spmig), at the pre-0413 head (supabase db
# reset --local --version 0402). Exit status 0 = every check passed.
#
# Usage: CONTAINER=supabase_db_spmig bash scripts/db-concurrency/0413_migration_lock_footprint.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIG=""
for f in "$REPO"/supabase/migrations/*_order_catalog_visibility.sql; do [ -f "$f" ] && MIG="$f" && break; done
TMP="$(mktemp -d)"

FAILS=0
ok()   { printf 'ok     %s\n' "$*"; }
bad()  { printf 'FAIL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
q() { "${PSQL[@]}" -c "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
wait_app() { # wait_app <application_name> <wait_event>
  local _
  for _ in $(seq 1 100); do
    [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and wait_event = '$2'")" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "missing supabase/migrations/*_order_catalog_visibility.sql"; exit 1; }
applied() { q "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'order_catalog_visible'"; }
if [ "$(applied)" != "0" ]; then
  echo "needs the pre-0413 head (supabase db reset --local --version <the migration before 0413>)"; exit 1
fi
echo "local head $(q "select max(version) from supabase_migrations.schema_migrations"); inventory_items rows $(q "select count(*) from public.inventory_items"); organizations rows $(q "select count(*) from public.organizations")"

# The file split after its preflight and after its prelude.
python3 - "$MIG" "$TMP" <<'PY'
import sys
src = open(sys.argv[1]).read()
a = src.index('\n$preflight$;') + len('\n$preflight$;')
b = src.index('end $lock$;') + len('end $lock$;')
open(sys.argv[2] + '/pre.sql', 'w').write(src[:a])
open(sys.argv[2] + '/lock.sql', 'w').write(src[a:b])
open(sys.argv[2] + '/tail.sql', 'w').write(src[b:])
PY
[ -s "$TMP/pre.sql" ] && [ -s "$TMP/lock.sql" ] && [ -s "$TMP/tail.sql" ] || { echo "could not split the file at its preflight and its prelude"; exit 1; }

LOCKS_SQL="select coalesce(string_agg(c.oid::regclass::text || '=' || l.mode, ',' order by c.oid::regclass::text, l.mode), '')
  from pg_locks l join pg_class c on c.oid = l.relation
 where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
   and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
   and c.relkind in ('r', 'p')"
EXPECTED='categories=AccessShareLock,inventory_items=AccessExclusiveLock,order_request_lines=ShareRowExclusiveLock,organization_members=AccessShareLock,order_requests=AccessShareLock,organization_modules=AccessShareLock,organizations=AccessExclusiveLock,platform_admin_audit=AccessExclusiveLock,public_link_catalog_entries=AccessShareLock,public_request_links=AccessShareLock,role_default_permissions=ShareRowExclusiveLock,role_permission_overrides=ShareRowExclusiveLock,user_permission_overrides=ShareRowExclusiveLock,user_profiles=AccessShareLock,warehouses=AccessShareLock'

# ═══ 0, 1 and 2 ═══════════════════════════════════════════════════════════
echo "== 0-2. what the preflight and the prelude take, and what the rest of the file adds"
{
  echo "begin;"
  cat "$TMP/pre.sql"
  echo "select 'AFTER_PREFLIGHT=' || ($LOCKS_SQL);"
  cat "$TMP/lock.sql"
  echo "select 'AFTER_PRELUDE=' || ($LOCKS_SQL);"
  echo "select 'T0=' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/tail.sql"
  echo "select 'T1=' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'AT_END=' || ($LOCKS_SQL);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/one.out" 2>&1
PRE="$(sed -n 's/^AFTER_PREFLIGHT=//p' "$TMP/one.out")"
AFTER="$(sed -n 's/^AFTER_PRELUDE=//p' "$TMP/one.out")"
ATEND="$(sed -n 's/^AT_END=//p' "$TMP/one.out")"
if ! grep -q '^AT_END=' "$TMP/one.out"; then bad "the file did not run to the end: $(tail -5 "$TMP/one.out" | tr '\n' ' ')"; fi
if grep -q '^AFTER_PREFLIGHT=$' "$TMP/one.out"; then ok "0: the preflight took no table lock"; else bad "0: the preflight locked '$PRE'"; fi
SAME="$(python3 - "$AFTER" "$EXPECTED" <<'PY'
import sys
print('yes' if set(filter(None, sys.argv[1].split(','))) == set(filter(None, sys.argv[2].split(','))) else 'no')
PY
)"
if [ "$SAME" = "yes" ]; then ok "1a: the prelude took exactly the expected 15 table locks"; else bad "1a: got '$AFTER', want '$EXPECTED'"; fi
EXTRA="$(python3 - "$AFTER" "$ATEND" <<'PY'
import sys
held = {a.split('=')[0] for a in filter(None, sys.argv[1].split(','))}
print(','.join(sorted(a for a in filter(None, sys.argv[2].split(',')) if a.split('=')[0] not in held)))
PY
)"
if [ -z "$EXTRA" ]; then ok "1b: nothing after the prelude locked a table the prelude had not locked"; else bad "1b: also locked $EXTRA"; fi
HOLD=$(( $(sed -n 's/^T1=//p' "$TMP/one.out") - $(sed -n 's/^T0=//p' "$TMP/one.out") ))
if [ "$HOLD" -lt 1500 ]; then ok "2: held from the prelude to the end for $HOLD ms"; else bad "2: held $HOLD ms"; fi
[ "$(applied)" = "0" ] && ok "   (rolled back: nothing applied)"

# ═══ 3 and 3b: a writer on inventory_items ════════════════════════════════
holder() { # holder <app> <seconds> <statement>
  ( printf "set application_name to '%s';\nbegin;\n%s\nselect pg_sleep(%s);\nrollback;\n" "$1" "$3" "$2" | "${PSQL[@]}" > "$TMP/$1.out" 2>&1 ) &
}
run_file() { # run_file <tag>: the whole file in a rolled-back transaction
  { echo "set application_name to 'mig-$1';"; echo "begin;"; cat "$MIG"; echo "select 'DONE';"; echo "rollback;"; } | "${PSQL[@]}" > "$TMP/mig-$1.out" 2>&1
}
ITEM_WRITE="update public.inventory_items set name = name where false;"

echo "== 3. a writer holds inventory_items for 9 s"
holder long-writer 9 "$ITEM_WRITE"
wait_app long-writer PgSleep || bad "3: the writer never reached its sleep"
MS0=$(now_ms)
( run_file long ) &
MPID=$!
PAUSED=0; HELD_WHILE_PAUSED=0
while kill -0 "$MPID" 2>/dev/null; do
  if [ "$(q "select count(*) from pg_stat_activity where application_name = 'mig-long' and wait_event = 'PgSleep'")" = "1" ]; then
    PAUSED=$((PAUSED + 1))
    n="$(q "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid join pg_class c on c.oid = l.relation where a.application_name = 'mig-long' and l.locktype = 'relation' and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) and c.relkind in ('r', 'p')")"
    [ "$n" != "0" ] && HELD_WHILE_PAUSED=$((HELD_WHILE_PAUSED + 1))
  fi
  sleep 0.05
done
MS1=$(now_ms)
wait
if grep -qE '55P03|could not obtain lock on relation' "$TMP/mig-long.out"; then ok "3: the file gave up with 55P03 after $((MS1 - MS0)) ms"; else bad "3: no 55P03: $(tail -3 "$TMP/mig-long.out" | tr '\n' ' ')"; fi
if [ "$PAUSED" -gt 3 ] && [ "$HELD_WHILE_PAUSED" = "0" ]; then ok "3: $PAUSED paused samples, 0 with a table lock held"; else bad "3: paused samples $PAUSED, holding a lock in $HELD_WHILE_PAUSED"; fi
grep -q '^DONE$' "$TMP/mig-long.out" && bad "3: the file ran to the end"

echo "== 3b. the same writer for 0.6 s"
holder short-writer 0.6 "$ITEM_WRITE"
wait_app short-writer PgSleep || bad "3b: the writer never reached its sleep"
MS0=$(now_ms); run_file short; MS1=$(now_ms)
if grep -q '^DONE$' "$TMP/mig-short.out"; then ok "3b: retried past it and ran to the end in $((MS1 - MS0)) ms"; else bad "3b: $(tail -3 "$TMP/mig-short.out" | tr '\n' ' ')"; fi
wait

echo "== 4. an organizations reader for 0.6 s"
holder org-reader 0.6 "select count(*) from public.organizations;"
wait_app org-reader PgSleep || bad "4: the reader never reached its sleep"
run_file orgs
if grep -q '^DONE$' "$TMP/mig-orgs.out"; then ok "4: retried past it and ran to the end"; else bad "4: $(tail -3 "$TMP/mig-orgs.out" | tr '\n' ' ')"; fi
wait
if cat "$TMP"/*.out | grep -qE '40P01|deadlock'; then bad "no session may see 40P01"; else ok "no session saw 40P01 or a deadlock"; fi

# ═══ 5. The preflight refuses drift ═══════════════════════════════════════
echo "== 5. a drifted body or policy stops the file before it changes anything"
drift() { # drift <tag> <statement that alters the live object>
  { echo "begin;"; echo "$2;"; cat "$MIG"; echo "select 'DONE';"; echo "rollback;"; } \
    | "${PSQL[@]}" -v VERBOSITY=verbose > "$TMP/drift-$1.out" 2>&1
}
# A comment added inside order_items_orderable's body: same behaviour, new md5.
drift body "$(q "select regexp_replace(pg_get_functiondef('public.order_items_orderable(uuid,uuid[])'::regprocedure), '(AS [\$]function[\$])', E'\\\\1\\n-- drift probe')")"
check_drift() { # check_drift <tag> <name expected in the message>
  if grep -q 'ERROR:  55000' "$TMP/drift-$1.out" && grep -q 'HINT:  order_visibility_preflight' "$TMP/drift-$1.out" \
     && grep -q "$2" "$TMP/drift-$1.out" && ! grep -q '^DONE$' "$TMP/drift-$1.out" \
     && grep -q 'line [0-9]* at RAISE' "$TMP/drift-$1.out"; then
    ok "5 ($1): 55000 order_visibility_preflight naming $2"
  else
    bad "5 ($1): $(grep -E 'ERROR|HINT|DETAIL' "$TMP/drift-$1.out" | head -3 | tr '\n' ' ')"
  fi
}
check_drift body 'order_items_orderable'
drift policy "alter policy inventory_items_select on public.inventory_items using (false);"
check_drift policy 'inventory_items_select'
[ "$(applied)" = "0" ] && [ "$(q "select count(*) from pg_proc where proname = 'order_items_orderable' and prosrc like '%drift probe%'")" = "0" ] \
  && ok "5: every drift session rolled back: nothing applied, the body unaltered"

[ "$(applied)" = "0" ] && ok "every migration session rolled back: nothing applied"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; fi
echo "$FAILS CHECK(S) FAILED"; exit 1
