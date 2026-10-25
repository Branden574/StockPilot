#!/usr/bin/env bash
#
# Data guards and lock footprint of migration 0407 (docket S9: grants and
# policy clean-up). The pgTAP file 0407_grants_policy_cleanup.test.sql runs on
# a database the file has already been applied to, where none of these paths
# can be reached: no stack ever has the item-attachments bucket when the
# migrations run (the CLI creates config.toml's buckets after them), so the
# bucket refusal, the bucket delete and the preflight's data guards are proved
# here, each against the file as it is, in a transaction that ALWAYS rolls
# back:
#
#   G1. One object in the item-attachments bucket: the preflight refuses
#       (55000, hint item_attachments_bucket_not_empty) before any other
#       statement runs.
#   G2. An object that arrives after the preflight (inserted in the file's
#       own session between the preflight and the lock prelude): the bucket
#       block counts again under the prelude's lock and refuses with the same
#       error, and the object and the bucket are still there.
#   G3. A multipart upload in progress in the bucket: the preflight refuses
#       the same way.
#   G4. The empty bucket: the file runs to the end and deletes the bucket row
#       only. Every object in every other bucket is as before (an object in
#       item-images is added for the check), and storage.allow_delete_query is
#       back to false at the end.
#   G5. A row in item_attachments: 55000 item_attachments_not_empty.
#   G6. More than 250,000 rows in item_images: 55000 item_images_too_large.
#   G7. Drift, each refused with 55000 grants_cleanup_preflight: a changed
#       idempotency policy, a report function made SECURITY DEFINER, an index
#       name the file creates already taken.
#   G8. A second run of the file after the first, in one transaction: refused
#       by the preflight (55000 grants_cleanup_preflight), nothing more
#       applied.
#   L1a. Before the lock prelude the file holds no lock on any table outside
#        the catalogs: the preflight reads policy text and row counts in a
#        block it always undoes, and the function, GRANT, REVOKE and ALTER
#        DEFAULT PRIVILEGES statements lock no table.
#   L1b. The prelude takes ACCESS EXCLUSIVE on idempotency_keys,
#        maintenance_request_attachments, item_attachments, storage.objects
#        and every existing table supautils.policy_grants lists for the role,
#        SHARE on item_images, and nothing else.
#   L1c. No statement after the prelude locks a table the prelude did not
#        lock: the file never waits while holding a lock.
#   L2.  The hold, from the prelude to the end of the file (every table above
#        is held for exactly this long), is under HOLD_BUDGET_MS (250) on the
#        local stack. Printed per run.
#   L3.  An open transaction that reads auth.users (a sign-in), writes
#        item_images (a photo save) or reads storage.objects, held 9 s: the
#        file retries, holds NO table lock while paused between attempts
#        (sampled from pg_locks), and fails 55P03 after its 40 attempts. The
#        holder is never blocked.
#   L3b. The same item_images writer held 0.6 s: the file retries past it and
#        runs to the end.
#   L4.  While the file holds its locks (a 1 s pause added at its end): new
#        readers of item_images, inventory_items and stock_movements are not
#        blocked at all; new readers of auth.users and idempotency_keys wait
#        for the hold only, then read.
#   N.   No case changed the stack (report functions, policies, privileges,
#        default privileges, buckets, objects and item_images indexes as
#        before).
#
# No session ever sees 40001 or 40P01. It needs the head right before 0407
# (the six report functions as 0380 left them, the idempotency_keys_write
# policy, no 0407 index). LOCAL stack only (docker container
# supabase_db_stockpilot; CONTAINER=<name> for another local stack). Exit
# status 0 = every check passed.
#
# Usage: bash scripts/db-concurrency/0407_migration_guards.sh

set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_stockpilot}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -At)
# Runs on after an error, for the cases that look at the session after one.
PSQL_ON=(docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -At)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIGS=("$REPO"/supabase/migrations/*_grants_policy_cleanup.sql)
MIG="${MIGS[0]}"
TMP="$(mktemp -d)"
HOLD_BUDGET_MS="${HOLD_BUDGET_MS:-250}"
BG=()

ORG='04079999-0000-4000-8000-00000000000a'
ITEM='04079999-0000-4000-8000-0000000000d1'

FAILS=0
ok() { printf 'ok     %s\n' "$*"; }
bad() {
  printf 'FAIL   %s\n' "$*"
  FAILS=$((FAILS + 1))
}
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
cleanup() {
  local p
  for p in "${BG[@]:-}"; do [ -n "$p" ] && wait "$p" 2> /dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

[ -n "$MIG" ] && [ -f "$MIG" ] || {
  echo "missing supabase/migrations/*_grants_policy_cleanup.sql"
  exit 1
}
PRE_HEAD="$(q "select (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.report_top_movers(uuid,timestamptz,integer)'))
            || '|' || (select count(*) from pg_policy where polrelid = 'public.idempotency_keys'::regclass and polname = 'idempotency_keys_write')
            || '|' || (to_regclass('public.item_images_storage_path_idx') is null)")"
if [ "$PRE_HEAD" != "f3d8bba356ad4c1e48669a9a731acc76|1|true" ]; then
  echo "needs the head right before 0407 (got $PRE_HEAD): supabase db reset --local --version <the migration before 0407>"
  exit 1
fi
HEAD_NOW="$(q "select max(version) from supabase_migrations.schema_migrations")"
echo "local head $HEAD_NOW; $(q "select count(*) from storage.buckets where id = 'item-attachments'") item-attachments bucket(s)"

# What a case must never leave changed.
STATE_SQL="select md5(concat_ws('#',
  (select string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'report\\_%'),
  (select string_agg(c.relname || ':' || pol.polname || ':' || pol.polcmd::text, ',' order by c.relname, pol.polname)
     from pg_policy pol join pg_class c on c.oid = pol.polrelid
    where c.relname in ('idempotency_keys', 'item_attachments', 'maintenance_request_attachments') or pol.polname like 'item-attachments%'),
  (select string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' order by c.relname)
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')),
  (select string_agg(d.defaclrole::regrole::text || ':' || d.defaclnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, ','
                     order by d.defaclrole::regrole::text, d.defaclnamespace, d.defaclobjtype) from pg_default_acl d),
  (select string_agg(b.id, ',' order by b.id) from storage.buckets b),
  (select count(*)::text from storage.objects),
  (select string_agg(i.indexrelid::regclass::text, ',' order by i.indexrelid::regclass::text) from pg_index i where i.indrelid = 'public.item_images'::regclass)))"
STATE_BEFORE="$(q "$STATE_SQL")"

ENSURE_BUCKET="insert into storage.buckets (id, name) values ('item-attachments', 'item-attachments') on conflict (id) do nothing;"
FIXTURE_ITEM="insert into public.organizations (id, name, slug) values ('$ORG', '0407 Guard Org', '0407-guard');
insert into public.inventory_items (id, organization_id, name, sku) values ('$ITEM', '$ORG', 'Guard item', 'SKU-0407-GUARD');"

# The file in three parts: before the prelude, the prelude, the rest.
# shellcheck disable=SC2016  # a literal $lock407$ dollar tag, not an expansion
P0="$(grep -n '^do \$lock407\$$' "$MIG" | head -n 1 | cut -d: -f1)"
# shellcheck disable=SC2016  # the same literal tag
P1="$(grep -n '^end \$lock407\$;$' "$MIG" | head -n 1 | cut -d: -f1)"
[ -n "$P0" ] && [ -n "$P1" ] || {
  echo "no lock prelude in $MIG"
  exit 1
}
head -n $((P0 - 1)) "$MIG" > "$TMP/part1.sql"
sed -n "${P0},${P1}p" "$MIG" > "$TMP/prelude.sql"
tail -n +$((P1 + 1)) "$MIG" > "$TMP/part3.sql"

first_error() { grep -m1 '^ERROR:' "$1" | cut -c1-240; }
first_hint() { grep -A3 -m1 '^ERROR:' "$1" | grep -m1 '^HINT:' | sed 's/^HINT: *//'; }

# refused <label> <setup sql> <hint> <message fragment>: the file, after the
# setup, stops at its first statement with 55000 and that hint.
refused() {
  local label="$1" setup="$2" hint="$3" frag="$4" rc err
  { echo "begin;"; printf '%s\n' "$setup"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" > "$TMP/$label.out" 2> "$TMP/$label.err"
  rc=$?
  err="$(first_error "$TMP/$label.err")"
  if [ $rc -ne 0 ] && [[ "$err" == "ERROR:  55000: "* ]] && [ "$(first_hint "$TMP/$label.err")" = "$hint" ] \
     && [[ "$err" == *"$frag"* ]] && ! grep -qE '40P01|40001' "$TMP/$label.err" \
     && grep -q 'inline_code_block' "$TMP/$label.err"; then
    ok "$label: refused with 55000 $hint (${err#ERROR:  55000: })"
  else
    bad "$label: rc $rc, first error: ${err:-none}, hint: $(first_hint "$TMP/$label.err")"
  fi
}

# ── G1, G3, G5, G6, G7, G8: the preflight refuses ──────────────────────────
refused G1-object-in-bucket \
  "$ENSURE_BUCKET
   insert into storage.objects (bucket_id, name) values ('item-attachments', '0407-guard/one.pdf');" \
  item_attachments_bucket_not_empty 'grants_cleanup_data: the item-attachments bucket holds 1 objects;'
refused G3-upload-in-progress \
  "$ENSURE_BUCKET
   insert into storage.s3_multipart_uploads (id, upload_signature, bucket_id, key, version)
   values ('0407-guard-upload', 'guard', 'item-attachments', '0407-guard/big.pdf', 'v1');" \
  item_attachments_bucket_not_empty 'holds 1 multipart uploads;'
refused G5-attachment-row \
  "$FIXTURE_ITEM
   insert into public.item_attachments (organization_id, item_id, storage_path, filename)
   values ('$ORG', '$ITEM', '$ORG/$ITEM/guard.pdf', 'guard.pdf');" \
  item_attachments_not_empty 'item_attachments holds 1 rows;'
refused G6-item-images-too-large \
  "$FIXTURE_ITEM
   insert into public.item_images (organization_id, item_id, storage_path)
   select '$ORG', '$ITEM', '$ORG/$ITEM/' || g || '.webp' from generate_series(1, 250001) g;" \
  item_images_too_large 'item_images holds 250001 rows'
refused G7-policy-drift \
  "alter policy idempotency_keys_write on public.idempotency_keys using (true);" \
  grants_cleanup_preflight 'policy idempotency_keys_write on public.idempotency_keys drifted'
refused G7-report-definer \
  "alter function public.report_top_movers(uuid, timestamptz, integer) security definer;" \
  grants_cleanup_preflight 'public.report_top_movers(uuid,timestamptz,integer) drifted'
refused G7-index-name-taken \
  "create index item_images_thumb_path_idx on public.item_images (id);" \
  grants_cleanup_preflight 'an item_images index this file creates already exists'

# G8: the whole file, then the file again.
{ echo "begin;"; cat "$MIG"; echo "select 'FIRST_RUN_DONE';"; cat "$MIG"; echo "rollback;"; } \
  | "${PSQL[@]}" > "$TMP/G8.out" 2> "$TMP/G8.err"
rc=$?
err="$(first_error "$TMP/G8.err")"
if [ $rc -ne 0 ] && grep -q '^FIRST_RUN_DONE$' "$TMP/G8.out" && [[ "$err" == "ERROR:  55000: grants_cleanup_preflight:"* ]] \
   && [ "$(first_hint "$TMP/G8.err")" = "grants_cleanup_preflight" ]; then
  ok "G8-second-run: the first run went to the end; the second was refused by its preflight (${err:0:160}...)"
else
  bad "G8-second-run: rc $rc, first run done: $(grep -c '^FIRST_RUN_DONE$' "$TMP/G8.out"), first error: ${err:-none}"
fi

# ── G2: an object that arrives after the preflight ─────────────────────────
{
  echo "begin;"
  echo "$ENSURE_BUCKET"
  cat "$TMP/part1.sql"
  echo "select 'PART1_DONE';"
  echo "insert into storage.objects (bucket_id, name) values ('item-attachments', '0407-guard/late.pdf');"
  echo "savepoint before_prelude;"
  cat "$TMP/prelude.sql" "$TMP/part3.sql"
  echo "rollback to savepoint before_prelude;"
  echo "select 'OBJ|' || count(*) from storage.objects where bucket_id = 'item-attachments';"
  echo "select 'BKT|' || count(*) from storage.buckets where id = 'item-attachments';"
  echo "rollback;"
} | "${PSQL_ON[@]}" > "$TMP/G2.out" 2> "$TMP/G2.err"
err="$(first_error "$TMP/G2.err")"
if grep -q '^PART1_DONE$' "$TMP/G2.out" && [[ "$err" == "ERROR:  55000: grants_cleanup_data: the item-attachments bucket holds 1 objects and 0 multipart uploads"* ]] \
   && [ "$(first_hint "$TMP/G2.err")" = "item_attachments_bucket_not_empty" ] \
   && grep -q '^OBJ|1$' "$TMP/G2.out" && grep -q '^BKT|1$' "$TMP/G2.out"; then
  ok "G2-object-after-preflight: the bucket block counted again under the lock and refused (${err#ERROR:  55000: }); the object and the bucket are still there"
else
  bad "G2-object-after-preflight: part 1 done: $(grep -c '^PART1_DONE$' "$TMP/G2.out"), first error: ${err:-none}, $(grep -E '^(OBJ|BKT)\|' "$TMP/G2.out" | tr '\n' ' ')"
fi

# ── G4: the empty bucket is deleted, nothing else ──────────────────────────
OBJECTS_SQL="select 'OBJECTS|' || count(*) || '|' || coalesce(md5(string_agg(o.id::text || o.bucket_id || o.name, ',' order by o.id)), 'none')
  from storage.objects o"
{
  echo "begin;"
  echo "$ENSURE_BUCKET"
  echo "insert into storage.objects (bucket_id, name) values ('item-images', '0407-guard/kept.webp');"
  echo "$OBJECTS_SQL;"
  cat "$MIG"
  echo "$OBJECTS_SQL;"
  echo "select 'BKT|' || count(*) from storage.buckets where id = 'item-attachments';"
  echo "select 'OTHER_BUCKETS|' || count(*) from storage.buckets where id <> 'item-attachments';"
  echo "select 'ADQ|' || coalesce(current_setting('storage.allow_delete_query', true), 'unset');"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/G4.out" 2> "$TMP/G4.err"
rc=$?
O1="$(grep '^OBJECTS|' "$TMP/G4.out" | sed -n 1p)"
O2="$(grep '^OBJECTS|' "$TMP/G4.out" | sed -n 2p)"
OTHER="$(q "select count(*) from storage.buckets where id <> 'item-attachments'")"
if [ $rc -eq 0 ] && [ -n "$O1" ] && [ "$O1" = "$O2" ] && grep -q '^BKT|0$' "$TMP/G4.out" \
   && grep -q "^OTHER_BUCKETS|$OTHER$" "$TMP/G4.out" && grep -q '^ADQ|false$' "$TMP/G4.out"; then
  ok "G4-empty-bucket: the file ran to the end and deleted the bucket only; ${O1#OBJECTS|} objects (count|md5) before and after, the other $OTHER buckets kept, allow_delete_query back to false"
else
  bad "G4-empty-bucket: rc $rc, $(first_error "$TMP/G4.err"), objects $O1 then $O2, $(grep -E '^(BKT|OTHER_BUCKETS|ADQ)\|' "$TMP/G4.out" | tr '\n' ' ')"
fi

# ── L1 and L2: what the prelude takes, and that nothing comes after it ─────
LOCKS_SQL="select string_agg(distinct n.nspname || '.' || c.relname || ':' || l.mode, ',' order by n.nspname || '.' || c.relname || ':' || l.mode)
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
 where l.locktype = 'relation' and l.pid = pg_backend_pid() and l.granted
   and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema') and c.relkind in ('r', 'p')"
{
  echo "begin;"
  cat "$TMP/part1.sql"
  echo "select 'BEFORE|' || coalesce(($LOCKS_SQL), 'none');"
  echo "select 'T0|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  cat "$TMP/prelude.sql"
  echo "select 'PRELUDE|' || coalesce(($LOCKS_SQL), 'none');"
  echo "select 'EXPECTED|' || string_agg(x, ',' order by x) from (
          select 'public.idempotency_keys:AccessExclusiveLock' as x
          union select 'public.maintenance_request_attachments:AccessExclusiveLock'
          union select 'public.item_attachments:AccessExclusiveLock'
          union select 'storage.objects:AccessExclusiveLock'
          union select 'public.item_images:ShareLock'
          union select n.nspname || '.' || c.relname || ':AccessExclusiveLock'
            from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb)) t(name)
            join pg_class c on c.oid = to_regclass(t.name) join pg_namespace n on n.oid = c.relnamespace) e;"
  echo "select 'POLICY_GRANTS|' || jsonb_array_length(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb));"
  cat "$TMP/part3.sql"
  echo "select 'T1|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;"
  echo "select 'END|' || coalesce(($LOCKS_SQL), 'none');"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/1.out" 2> "$TMP/1.err"
rc=$?
if [ $rc -ne 0 ]; then
  bad "1: the file did not run inside a transaction: $(tr '\n' ' ' < "$TMP/1.err" | cut -c1-300)"
else
  BEFORE="$(sed -n 's/^BEFORE|//p' "$TMP/1.out")"
  PRELUDE="$(sed -n 's/^PRELUDE|//p' "$TMP/1.out")"
  EXPECTED="$(sed -n 's/^EXPECTED|//p' "$TMP/1.out")"
  END="$(sed -n 's/^END|//p' "$TMP/1.out")"
  if [ "$BEFORE" = "none" ]; then
    ok "L1a: the preflight, the report functions, the revokes and the default privileges lock no table"
  else
    bad "L1a: before the prelude the file already holds: $BEFORE"
  fi
  if [ -n "$PRELUDE" ] && [ "$PRELUDE" = "$EXPECTED" ]; then
    ok "L1b: the prelude takes exactly idempotency_keys, maintenance_request_attachments, item_attachments and storage.objects (exclusive), item_images (share) and the $(printf '%s' "$EXPECTED" | tr ',' '\n' | grep -vc '^public\.') existing supautils.policy_grants tables of $(sed -n 's/^POLICY_GRANTS|//p' "$TMP/1.out") listed (exclusive)"
  else
    bad "L1b: the prelude took: $PRELUDE; expected: $EXPECTED"
  fi
  rels() { printf '%s' "$1" | tr ',' '\n' | sed 's/:.*//' | sort -u; }
  NEW="$(comm -13 <(rels "$PRELUDE") <(rels "$END"))"
  if [ -z "$NEW" ]; then
    ok "L1c: nothing after the prelude locks a table it did not lock"
  else
    bad "L1c: after the prelude the file also locked: $(printf '%s' "$NEW" | tr '\n' ' ')"
  fi
  T0="$(sed -n 's/^T0|//p' "$TMP/1.out")"
  T1="$(sed -n 's/^T1|//p' "$TMP/1.out")"
  if [ -n "$T0" ] && [ -n "$T1" ] && [ $((T1 - T0)) -lt "$HOLD_BUDGET_MS" ]; then
    ok "L2: the prelude to the end of the file took $((T1 - T0)) ms (the hold before commit)"
  else
    bad "L2: the prelude to the end of the file took $((${T1:-0} - ${T0:-0})) ms (budget $HOLD_BUDGET_MS)"
  fi
fi

# ── L3: an open transaction on a table the prelude needs ───────────────────
LOCKS_OF_SLEEPING_FILE="select count(*) filter (where a.wait_event = 'PgSleep')::text || '|'
       || count(l.relation) filter (where a.wait_event = 'PgSleep')::text
  from pg_stat_activity a
  left join pg_locks l on l.pid = a.pid and l.locktype = 'relation' and l.granted
   and l.relation in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema'))
 where a.application_name like '0407-lock-file-%'"
run_behind() { # run_behind <label> <holder sql> <holder seconds> <expect: fail|apply>
  local label="$1" holder="$2" secs="$3" expect="$4" app="0407-lock-holder-$1"
  printf "set application_name = '%s';\nbegin;\n%s\nselect pg_sleep(%s);\ncommit;\nselect 'HOLDER_DONE';\n" "$app" "$holder" "$secs" \
    | "${PSQL[@]}" > "$TMP/3-$label.h.out" 2>&1 &
  local hp=$!
  if ! wait_sleeping "$app"; then
    bad "L3 $label: the holder never reached pg_sleep"
    wait "$hp"
    return
  fi
  local t0 t1 rc
  t0="$(now_ms)"
  { echo "set application_name = '0407-lock-file-$label';"; echo "begin;"; cat "$MIG"; echo "rollback;"; } \
    | "${PSQL[@]}" > "$TMP/3-$label.m.out" 2> "$TMP/3-$label.m.err" &
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
    bad "L3 $label: while paused between attempts the file held $held table lock(s)"
  elif [ "$expect" = "fail" ] && [ "$sleeping" -lt 1 ]; then
    bad "L3 $label: never saw the file pause between attempts ($samples samples)"
  fi
  if [ "$expect" = "fail" ]; then
    if [ $rc -ne 0 ] && grep -q '55P03' "$TMP/3-$label.m.err" && ! grep -qE '40P01|40001' "$TMP/3-$label.m.err" \
       && [ $((t1 - t0)) -ge 1500 ] && [ $((t1 - t0)) -lt 10000 ]; then
      ok "L3 $label: the file retried for $((t1 - t0)) ms holding no table lock while paused ($sleeping paused samples, 0 locks), then failed 55P03 and wrote nothing"
    else
      bad "L3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  else
    if [ $rc -eq 0 ] && ! grep -qE '55P03|40P01|40001' "$TMP/3-$label.m.err"; then
      ok "L3 $label: the holder let go after ${secs} s and the file retried past it, ran to the end after $((t1 - t0)) ms ($sleeping paused samples, 0 locks while paused; rolled back)"
    else
      bad "L3 $label: rc $rc after $((t1 - t0)) ms: $(tr '\n' ' ' < "$TMP/3-$label.m.err" | cut -c1-300)"
    fi
  fi
  wait "$hp"
  if grep -q '^HOLDER_DONE$' "$TMP/3-$label.h.out" && ! grep -qE 'ERROR|40P01' "$TMP/3-$label.h.out"; then
    ok "L3 $label: the holder finished without an error"
  else
    bad "L3 $label: the holder: $(tr '\n' ' ' < "$TMP/3-$label.h.out" | cut -c1-200)"
  fi
}
run_behind auth-reader "select count(*) from auth.users;" 9 fail
run_behind photo-writer "update public.item_images set sort_order = sort_order where false;" 9 fail
run_behind storage-reader "select count(*) from storage.objects;" 9 fail
run_behind short-photo-writer "update public.item_images set sort_order = sort_order where false;" 0.6 apply

# ── L4: while the file holds its locks ─────────────────────────────────────
{
  echo "set application_name = '0407-lock-migration-4';"
  echo "begin;"
  cat "$MIG"
  echo "select pg_sleep(1);"
  echo "rollback;"
} | "${PSQL[@]}" > "$TMP/4m.out" 2> "$TMP/4m.err" &
BG+=("$!")
if ! wait_sleeping 0407-lock-migration-4; then
  bad "L4: the migration session never reached pg_sleep: $(tr '\n' ' ' < "$TMP/4m.err" | cut -c1-300)"
else
  for target in public.item_images public.inventory_items public.stock_movements; do
    t0="$(now_ms)"
    R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    t1="$(now_ms)"
    if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 300 ]; then
      ok "L4: a new reader of $target is not blocked by the hold ($((t1 - t0)) ms)"
    else
      bad "L4: a new reader of $target: $R after $((t1 - t0)) ms"
    fi
  done
  for target in auth.users public.idempotency_keys; do
    t0="$(now_ms)"
    R="$(printf "set lock_timeout = '3s';\nselect 'read:' || (count(*) >= 0)::text from %s;\n" "$target" | "${PSQL[@]}" 2>&1)"
    t1="$(now_ms)"
    if [ "$R" = "read:true" ] && [ $((t1 - t0)) -lt 1800 ]; then
      ok "L4: a new reader of $target waited for the hold only and read after $((t1 - t0)) ms"
    else
      bad "L4: a new reader of $target: $R after $((t1 - t0)) ms"
    fi
  done
fi
for p in "${BG[@]}"; do wait "$p" 2> /dev/null; done
BG=()
if grep -q . "$TMP/4m.err"; then bad "L4: the migration session reported: $(tr '\n' ' ' < "$TMP/4m.err" | cut -c1-300)"; fi

# ── N: nothing was applied ─────────────────────────────────────────────────
STATE_AFTER="$(q "$STATE_SQL")"
HEAD_AFTER="$(q "select max(version) from supabase_migrations.schema_migrations")"
if [ "$STATE_AFTER" = "$STATE_BEFORE" ] && [ "$HEAD_AFTER" = "$HEAD_NOW" ]; then
  ok "N: the stack is unchanged (head $HEAD_NOW; report functions, policies, privileges, default privileges, buckets, objects and item_images indexes as before)"
else
  bad "N: the stack changed under the script (head $HEAD_AFTER, state $STATE_BEFORE -> $STATE_AFTER)"
fi

if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
