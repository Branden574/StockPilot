-- supabase/tests/0375_exception_evidence.test.sql
-- pgTAP proof for migration 0375 (F1-4: photo evidence on exception
-- occurrences). "Mutation: X" names a deliberate break of the code that the
-- preceding assertion catches.
--
-- B. Bucket: private, PNG/JPEG/WEBP, 10 MB; exactly one policy, INSERT only.
--    An accepted member writes under their org's folder; another org's
--    folder, a first folder that is not a uuid, a pending invite and a
--    disabled account are refused (42501). A member may create only the name
--    a mint hands out ({org}/{occurrence}/{uuid}.{ext}): never a server
--    thumbnail name ({uuid}-thumb.webp), another file name, a nested folder
--    or another extension (review finding 2026-09-27: a member could fill a
--    thumbnail path the server had emptied). No SELECT, UPDATE or DELETE for
--    authenticated: a member sees 0 rows, updates 0 and deletes 0, and the
--    object is still there.
-- G. Grants: authenticated has SELECT only on exception_evidence (insert,
--    update, delete fail with 42501); the record RPC is service_role only
--    (catalog), and its BODY refuses a client role even when a grant slips
--    (mutation: drop the in-body role check); the remove RPC is
--    authenticated, not anon; the gate helper is service_role only; RLS on;
--    search_path pinned; no 40001/40P01 anywhere.
-- O. One gate: exception_occurrence_act, the record RPC and the remove RPC
--    all call _exc_occurrence_can_act and none restates it (mutation: inline
--    the gate again in any of them); the helper answers per persona exactly
--    as 0370's act gate did.
-- C. Path CHECKs (direct writes as the owner): the 0323 traversal alphabet,
--    a path or thumbnail outside the occurrence's folder, a capture time far
--    in the future; the events FK and the evidence-kind CHECK are validated
--    and hold.
-- R. exception_evidence_record, as service_role: staff with write access
--    records a photo and an evidence_added event (actor, photo, note); the
--    uploader is judged by the act gate as themselves: staff of another
--    warehouse and a member of another org get P0002, a disabled or pending
--    account P0002, a viewer (even one granted stock:adjust) and staff
--    without stock:adjust 42501, a null-warehouse occurrence needs a
--    manager; a resolved occurrence gets occurrence_resolved; the path must
--    be this occurrence's folder, the extension must match the type, the
--    thumbnail must be a server thumbnail name ({uuid}-thumb.webp) and may
--    carry its own uuid; size, note and capture-time bounds; ONE UPLOAD NAME,
--    ONE PHOTO: a second record of a recorded upload name, whatever its
--    extension, is 23505 already_recorded, and so is a second row naming a
--    recorded thumbnail (review finding 2026-09-27: {uuid}.jpg and
--    {uuid}.png shared one thumbnail); the request claims are restored after
--    the call (mutation: forget to restore).
-- K. The cap: 8 live photos, the 9th refused (mutation: drop the cap); a
--    removed photo frees its slot (mutation: count removed photos too); at
--    the cap a second record of a recorded upload is still 23505
--    already_recorded, never evidence_limit_reached (a mapped refusal makes
--    the server delete the upload, which there is the recorded photo's
--    file). The concurrent case is scripts/db-concurrency/0375_evidence_cap.sh.
-- L. The locks the cap and the remove rely on, pinned in the catalog (no
--    sequential test can see a missing lock): the record RPC locks the
--    occurrence before it counts, the remove RPC locks the occurrence and
--    then the photo (mutation: drop any of the three FOR UPDATEs).
-- M. exception_evidence_remove, as authenticated: the uploader removes their
--    own (soft: the row and the stored object stay, removed_at/by set, one
--    evidence_removed event with the reason); another staff member who did
--    not upload it gets 42501 (mutation: drop the uploader-or-manager rule);
--    a manager may remove anyone's; a repeat is a no-op with no second event;
--    a viewer gets 42501; staff of another warehouse and another org get
--    P0002; a resolved occurrence gets occurrence_resolved (mutation: drop
--    the open check), and a second record of a photo already on it is still
--    23505 already_recorded; signed out 42501; reason bound; it never
--    deletes a row and never touches the occurrence's resolution.
-- V. RLS: photos are visible exactly where the occurrence is.
--
-- Roles: fixtures as the test superuser; records as service_role; removes and
-- reads as `authenticated` with request.jwt.claim.sub. begin/rollback:
-- nothing leaks. Namespace 03750000.

begin;

select plan(113);

\set orgA    03750000-0000-0000-0000-00000000000a
\set orgB    03750000-0000-0000-0000-00000000000b
\set mgr     03750000-0000-0000-0000-0000000000a1
\set stf     03750000-0000-0000-0000-0000000000a2
\set stf2    03750000-0000-0000-0000-0000000000a3
\set vwr     03750000-0000-0000-0000-0000000000a4
\set vwrAdj  03750000-0000-0000-0000-0000000000a5
\set stfNo   03750000-0000-0000-0000-0000000000a6
\set dis     03750000-0000-0000-0000-0000000000a7
\set pend    03750000-0000-0000-0000-0000000000a8
\set stf3    03750000-0000-0000-0000-0000000000a9
\set mgrB    03750000-0000-0000-0000-0000000000b1
\set whA     03750000-0000-0000-0000-0000000000c1
\set whA2    03750000-0000-0000-0000-0000000000c2
\set whB     03750000-0000-0000-0000-0000000000c3
\set iL      03750000-0000-0000-0000-000000000f01
\set iN      03750000-0000-0000-0000-000000000f02
\set iR      03750000-0000-0000-0000-000000000f03
\set iC      03750000-0000-0000-0000-000000000f04
\set iB      03750000-0000-0000-0000-000000000f05
\set iZ      03750000-0000-0000-0000-000000000f06
\set occL    03750000-0000-0000-0000-000000000e01
\set occN    03750000-0000-0000-0000-000000000e02
\set occR    03750000-0000-0000-0000-000000000e03
\set occC    03750000-0000-0000-0000-000000000e04
\set occB    03750000-0000-0000-0000-000000000e05
\set occZ    03750000-0000-0000-0000-000000000e06
\set occX    03750000-0000-0000-0000-000000000eff

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mgr',    '0375-mgr@test.local',    '{}'::jsonb),
  (:'stf',    '0375-stf@test.local',    '{}'::jsonb),
  (:'stf2',   '0375-stf2@test.local',   '{}'::jsonb),
  (:'vwr',    '0375-vwr@test.local',    '{}'::jsonb),
  (:'vwrAdj', '0375-vwradj@test.local', '{}'::jsonb),
  (:'stfNo',  '0375-stfno@test.local',  '{}'::jsonb),
  (:'dis',    '0375-dis@test.local',    '{}'::jsonb),
  (:'pend',   '0375-pend@test.local',   '{}'::jsonb),
  (:'stf3',   '0375-stf3@test.local',   '{}'::jsonb),
  (:'mgrB',   '0375-mgrb@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'orgA', '0375 Evidence A', '0375-evidence-a'),
  (:'orgB', '0375 Evidence B', '0375-evidence-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:'orgA', :'mgr',    'manager', now()),
  (:'orgA', :'stf',    'staff',   now()),
  (:'orgA', :'stf2',   'staff',   now()),
  (:'orgA', :'vwr',    'viewer',  now()),
  (:'orgA', :'vwrAdj', 'viewer',  now()),
  (:'orgA', :'stfNo',  'staff',   now()),
  (:'orgA', :'dis',    'staff',   now()),
  (:'orgA', :'pend',   'staff',   null),
  (:'orgA', :'stf3',   'staff',   now()),
  (:'orgB', :'mgrB',   'manager', now());
update public.user_profiles set disabled_at = now() where id = :'dis';
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whA',  :'orgA', '0375 Main',  'WH-0375A',  'active'),
  (:'whA2', :'orgA', '0375 Annex', 'WH-0375A2', 'active'),
  (:'whB',  :'orgB', '0375 Other', 'WH-0375B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:'orgA', :'stf',    :'whA',  true),
  (:'orgA', :'stf2',   :'whA2', true),
  (:'orgA', :'vwr',    :'whA',  true),
  (:'orgA', :'vwrAdj', :'whA',  true),
  (:'orgA', :'stfNo',  :'whA',  true),
  (:'orgA', :'dis',    :'whA',  true),
  (:'orgA', :'pend',   :'whA',  true),
  (:'orgA', :'stf3',   :'whA',  true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'orgA', :'stfNo',  'stock:adjust', false),
  (:'orgA', :'vwrAdj', 'stock:adjust', true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  (:'iL', :'orgA', :'whA', 'X0375-L', 'Labelled item',   0, 'active'),
  (:'iN', :'orgA', :'whA', 'X0375-N', 'Unscoped item',   0, 'active'),
  (:'iR', :'orgA', :'whA', 'X0375-R', 'Resolved item',   0, 'active'),
  (:'iC', :'orgA', :'whA', 'X0375-C', 'Capped item',     0, 'active'),
  (:'iZ', :'orgA', :'whA', 'X0375-Z', 'Closing item',    0, 'active'),
  (:'iB', :'orgB', :'whB', 'X0375-B', 'Other org item',  0, 'active');
-- Occurrences as exceptions_sync would store them (item-level rules). occN
-- has no warehouse stamp (a manager's call); occR is already resolved.
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, resolved_at, resolved_reason) values
  (:'occL', :'orgA', 1, 'label_mismatch', :'iL', null, :'whA', now(), now(), null, null),
  (:'occN', :'orgA', 2, 'label_mismatch', :'iN', null, null,   now(), now(), null, null),
  (:'occR', :'orgA', 3, 'label_mismatch', :'iR', null, :'whA', now(), now(), now(), 'cleared'),
  (:'occC', :'orgA', 4, 'over_reserved',  :'iC', null, :'whA', now(), now(), null, null),
  (:'occZ', :'orgA', 5, 'label_mismatch', :'iZ', null, :'whA', now(), now(), null, null),
  (:'occB', :'orgB', 1, 'label_mismatch', :'iB', null, :'whB', now(), now(), null, null);

-- {org}/{occurrence}/{uuid}.{ext}, the uuid made from n.
create function pg_temp.path(p_org uuid, p_occ uuid, p_n int, p_ext text default 'jpg')
returns text language sql immutable as $$
  select p_org::text || '/' || p_occ::text || '/'
         || lpad(to_hex(p_n), 8, '0') || '-0000-4000-8000-' || lpad(to_hex(p_n), 12, '0')
         || '.' || p_ext
$$;
create function pg_temp.thumb(p_path text) returns text language sql immutable as $$
  select regexp_replace(p_path, '\.(jpg|jpeg|png|webp)$', '-thumb.webp')
$$;

-- Record one photo; 'ok', or the SQLSTATE and hint of the refusal. A refusal
-- rolls back only its own subtransaction.
create function pg_temp.rec(
  p_org uuid, p_occ uuid, p_by uuid, p_n int,
  p_ext text default 'jpg', p_type text default 'image/jpeg', p_note text default null,
  p_captured timestamptz default null, p_thumb text default 'derived', p_size bigint default 1000)
returns text language plpgsql as $$
declare
  v_path text := pg_temp.path(p_org, p_occ, p_n, p_ext);
  v_state text; v_hint text;
begin
  perform public.exception_evidence_record(
    p_occ, p_by, v_path,
    case p_thumb when 'derived' then pg_temp.thumb(v_path) when 'none' then null else p_thumb end,
    p_type, p_size, p_captured, p_note);
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || coalesce(':' || nullif(v_hint, ''), '');
end $$;

-- Remove one photo as the current (authenticated) caller; same answer shape.
create function pg_temp.rm(p_id uuid, p_reason text default null) returns text language plpgsql as $$
declare v_state text; v_hint text;
begin
  perform public.exception_evidence_remove(p_id, p_reason);
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || coalesce(':' || nullif(v_hint, ''), '');
end $$;

-- A photo's id by path (as the owner: invisible rows too).
create function pg_temp.eid(p_org uuid, p_occ uuid, p_n int, p_ext text default 'jpg') returns uuid
language sql as $$
  select id from public.exception_evidence where storage_path = pg_temp.path(p_org, p_occ, p_n, p_ext)
$$;

-- Rows an UPDATE / DELETE of the bucket touched, as the current caller.
create function pg_temp.bucket_updates() returns int language plpgsql as $$
declare n int;
begin
  update storage.objects set metadata = '{"x":1}'::jsonb where bucket_id = 'exception-evidence';
  get diagnostics n = row_count;
  return n;
end $$;
-- The Storage API's own delete path sets storage.allow_delete_query and then
-- deletes under the caller's RLS; this does the same, so what stops the
-- member is the missing DELETE policy, not storage.protect_delete.
create function pg_temp.bucket_deletes() returns int language plpgsql as $$
declare n int;
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'exception-evidence';
  get diagnostics n = row_count;
  perform set_config('storage.allow_delete_query', 'false', true);
  return n;
end $$;

-- ═══ B. Bucket ════════════════════════════════════════════════════════════
select ok(
  exists (select 1 from storage.buckets where id = 'exception-evidence' and public = false),
  'B1: exception-evidence bucket exists and is private');
select is(
  (select allowed_mime_types from storage.buckets where id = 'exception-evidence'),
  array['image/png','image/jpeg','image/webp'],
  'B2: bucket pinned to png/jpeg/webp');
select is(
  (select file_size_limit from storage.buckets where id = 'exception-evidence'),
  10485760::bigint,
  'B3: bucket capped at 10 MB per object');
select is(
  (select string_agg(cmd, ',') from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (policyname like 'exception-evidence%' or qual like '%exception-evidence%'
           or with_check like '%exception-evidence%')),
  'INSERT',
  'B4: exactly one storage policy names this bucket, and it is INSERT only');

set local "request.jwt.claim.sub" to :'stf';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         pg_temp.path(:'orgA', :'occL', 900)),
  'B5: an accepted member writes under their own org''s folder');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         pg_temp.path(:'orgB', :'occB', 901)),
  '42501', null,
  'B6: the same member cannot write under another org''s folder');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('exception-evidence', 'not-a-uuid/x/y.jpg')$$,
  '42501', null,
  'B7: a first folder that is not a uuid is a plain refusal, not a cast error');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         pg_temp.thumb(pg_temp.path(:'orgA', :'occL', 1))),
  '42501', null,
  'B14: a member cannot create a server thumbnail name ({uuid}-thumb.webp), even in their own org''s folder');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         :'orgA' || '/' || :'occL' || '/photo.jpg'),
  '42501', null,
  'B15: a member cannot create a file name that is not a uuid');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         :'orgA' || '/' || :'occL' || '/x/' || split_part(pg_temp.path(:'orgA', :'occL', 906), '/', 3)),
  '42501', null,
  'B16: a member cannot create a nested folder');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         pg_temp.path(:'orgA', :'occL', 907, 'gif')),
  '42501', null,
  'B17: a member cannot create a name with another extension');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'exception-evidence'),
  0,
  'B8: no SELECT policy: the member sees none of the bucket, not even their own upload');
select is(pg_temp.bucket_updates(), 0, 'B9: no UPDATE: an update of the bucket touches nothing');
select is(pg_temp.bucket_deletes(), 0, 'B10: no DELETE: a delete of the bucket removes nothing');
reset role;
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'exception-evidence' and name = pg_temp.path(:'orgA', :'occL', 900)),
  1,
  'B11: the member''s object is still there after their update and delete attempts');

set local "request.jwt.claim.sub" to :'pend';
set local role to 'authenticated';
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         pg_temp.path(:'orgA', :'occL', 902)),
  '42501', null,
  'B12: a pending (not accepted) invite cannot write');
reset role;
set local "request.jwt.claim.sub" to :'dis';
set local role to 'authenticated';
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('exception-evidence', %L)$$,
         pg_temp.path(:'orgA', :'occL', 903)),
  '42501', null,
  'B13: a disabled account cannot write');
reset role;

-- ═══ G. Grants and structure ══════════════════════════════════════════════
select ok(
  has_table_privilege('authenticated', 'public.exception_evidence', 'SELECT')
  and not has_table_privilege('authenticated', 'public.exception_evidence', 'INSERT')
  and not has_table_privilege('authenticated', 'public.exception_evidence', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.exception_evidence', 'DELETE')
  and not has_table_privilege('anon', 'public.exception_evidence', 'SELECT'),
  'G1: authenticated holds SELECT only on exception_evidence; anon nothing');
select ok(
  not has_table_privilege('service_role', 'public.exception_evidence', 'UPDATE')
  and not has_table_privilege('service_role', 'public.exception_evidence', 'DELETE'),
  'G2: not even service_role may update or delete a photo row');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.exception_evidence'::regclass),
  'G3: RLS is on');

set local "request.jwt.claim.sub" to :'stf';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.exception_evidence (organization_id, occurrence_id, uploaded_by, storage_path, content_type, byte_size)
           values (%L, %L, %L, %L, 'image/jpeg', 10)$$,
         :'orgA', :'occL', :'stf', pg_temp.path(:'orgA', :'occL', 904)),
  '42501', null,
  'G4: a direct insert as authenticated is refused');
select throws_ok($$update public.exception_evidence set removed_at = now()$$, '42501', null,
  'G5: a direct update as authenticated is refused');
select throws_ok($$delete from public.exception_evidence$$, '42501', null,
  'G6: a direct delete as authenticated is refused');
reset role;

select ok(
  not has_function_privilege('authenticated', 'public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)', 'EXECUTE'),
  'G7: the record RPC is executable by service_role only');
select ok(
  has_function_privilege('authenticated', 'public.exception_evidence_remove(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exception_evidence_remove(uuid, text)', 'EXECUTE'),
  'G8: the remove RPC is executable by authenticated, not anon');
select ok(
  not has_function_privilege('authenticated', 'public._exc_occurrence_can_act(uuid, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._exc_occurrence_can_act(uuid, uuid, uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public._exc_occurrence_can_act(uuid, uuid, uuid)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public._exc_occurrence_can_act(uuid, uuid, uuid)'::regprocedure
                     and a.grantee = 0),
  'G9: the gate helper is service_role only (no PUBLIC grant)');
select is(
  (select string_agg(p.proname || ':' || case when p.prosecdef then 'definer' else 'invoker' end
                     || ':' || coalesce(array_to_string(p.proconfig, ';'), ''), ' ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_evidence_record', 'exception_evidence_remove', '_exc_occurrence_can_act')),
  '_exc_occurrence_can_act:definer:search_path=public '
  || 'exception_evidence_record:invoker:search_path=public;lock_timeout=5s '
  || 'exception_evidence_remove:definer:search_path=public;lock_timeout=5s',
  'G10: security mode and pinned search_path (and lock_timeout) of the three new functions');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_evidence_record', 'exception_evidence_remove',
                        '_exc_occurrence_can_act', 'exception_occurrence_act')
      and p.prosrc ~ '40001|40P01'),
  0,
  'G11: no evidence or act function raises a retryable SQLSTATE (40001/40P01)');

-- A grant slip must still meet the body's own role check.
grant execute on function public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text) to authenticated;
set local "request.jwt.claim.sub" to :'stf';
set local role to 'authenticated';
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 905), '42501',
  'G12: called as authenticated (after a grant slip) the record body refuses. Mutation: drop the in-body role check');
reset role;
revoke execute on function public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text) from authenticated;

-- ═══ O. One gate ══════════════════════════════════════════════════════════
select ok(
  (select bool_and(p.prosrc ~ '_exc_occurrence_can_act\(' and p.prosrc !~ 'user_can_access_inventory'
                   and p.prosrc !~ 'has_permission\(')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_occurrence_act', 'exception_evidence_record', 'exception_evidence_remove')),
  'O1: act, record and remove all call _exc_occurrence_can_act and none restates the gate. Mutation: inline the gate in any of them');

-- The helper, per persona, on occL (warehouse whA) and occN (no warehouse).
create function pg_temp.can(p_uid uuid, p_occ uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  select public._exc_occurrence_can_act(o.organization_id, o.warehouse_id, o.item_id) into v
    from public.exception_occurrences o where o.id = p_occ;
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $$;
set local role to 'service_role';
select is(
  format('%s %s %s %s %s %s %s %s',
         pg_temp.can(:'mgr', :'occL'), pg_temp.can(:'stf', :'occL'), pg_temp.can(:'stf2', :'occL'),
         pg_temp.can(:'vwr', :'occL'), pg_temp.can(:'vwrAdj', :'occL'), pg_temp.can(:'stfNo', :'occL'),
         pg_temp.can(:'dis', :'occL'), pg_temp.can(:'mgrB', :'occL')),
  't t f f f f f f',
  'O2: on a warehouse-stamped row the gate allows the manager and staff with write access only');
select is(
  format('%s %s', pg_temp.can(:'mgr', :'occN'), pg_temp.can(:'stf', :'occN')),
  't f',
  'O3: on a row with no warehouse the gate needs a manager');
reset role;

-- ═══ C. Path CHECKs, FK and evidence-kind CHECK ═══════════════════════════
create function pg_temp.direct(p_path text, p_thumb text default null, p_captured timestamptz default null)
returns text language plpgsql as $$
declare v_state text; v_con text;
begin
  insert into public.exception_evidence
    (organization_id, occurrence_id, uploaded_by, storage_path, thumbnail_path, content_type, byte_size, captured_at)
  values ('03750000-0000-0000-0000-00000000000a', '03750000-0000-0000-0000-000000000e01',
          '03750000-0000-0000-0000-0000000000a2', p_path, p_thumb, 'image/jpeg', 10, p_captured);
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_con = constraint_name;
  return v_state || coalesce(':' || v_con, '');
end $$;
select is(pg_temp.direct(:'orgA' || '/' || :'occL' || '/../x.jpg'), '23514:exception_evidence_storage_path_safe',
  'C1: a traversal segment is refused by the 0323 floor');
select is(pg_temp.direct(:'orgA' || '/' || :'occL' || '/%2e%2e.jpg'), '23514:exception_evidence_storage_path_safe',
  'C2: a percent-encoded path is refused by the 0323 floor');
select is(pg_temp.direct(pg_temp.path(:'orgA', :'occN', 1)), '23514:exception_evidence_path_in_occurrence',
  'C3: a path in another occurrence''s folder is refused');
select is(pg_temp.direct(pg_temp.path(:'orgA', :'occL', 1), pg_temp.path(:'orgA', :'occN', 1, 'webp')),
  '23514:exception_evidence_thumbnail_in_occurrence',
  'C4: a thumbnail in another occurrence''s folder is refused');
select is(pg_temp.direct(pg_temp.path(:'orgA', :'occL', 2), null, now() + interval '1 day'),
  '23514:exception_evidence_captured_not_future',
  'C5: a capture time a day ahead of the upload is refused');
select ok(
  (select bool_and(convalidated) from pg_constraint
    where conrelid = 'public.exception_occurrence_events'::regclass
      and conname in ('exception_occurrence_events_evidence_id_fkey', 'exc_occ_events_evidence_kind'))
  and (select count(*) from pg_constraint
        where conrelid = 'public.exception_occurrence_events'::regclass
          and conname in ('exception_occurrence_events_evidence_id_fkey', 'exc_occ_events_evidence_kind')) = 2,
  'C6: the events FK and the evidence-kind CHECK exist and are VALIDATED');
select throws_ok(
  format($$insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, evidence_id)
           values (%L, %L, 'evidence_added', gen_random_uuid())$$, :'orgA', :'occL'),
  '23503', null,
  'C7: an event naming a photo that does not exist is refused (FK)');
select throws_ok(
  format($$insert into public.exception_occurrence_events (organization_id, occurrence_id, kind)
           values (%L, %L, 'evidence_added')$$, :'orgA', :'occL'),
  '23514', null,
  'C8: an evidence event without a photo is refused');

-- ═══ R. exception_evidence_record ═════════════════════════════════════════
set local role to 'service_role';
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 1, 'jpg', 'image/jpeg', '  shelf empty  ',
                      now() - interval '10 minutes'), 'ok',
  'R1: staff with write access records a photo');
reset role;
select is(
  (select format('%s|%s|%s|%s|%s|%s', e.uploaded_by = :'stf', e.content_type, e.byte_size, e.note,
                 e.thumbnail_path = pg_temp.thumb(e.storage_path), e.removed_at is null)
     from public.exception_evidence e where e.id = pg_temp.eid(:'orgA', :'occL', 1)),
  't|image/jpeg|1000|shelf empty|t|t',
  'R2: the row records the uploader, type, size, trimmed note and derived thumbnail, live');
select is(
  (select format('%s|%s|%s', ev.actor_user_id = :'stf', ev.evidence_id = pg_temp.eid(:'orgA', :'occL', 1), ev.note)
     from public.exception_occurrence_events ev
    where ev.occurrence_id = :'occL' and ev.kind = 'evidence_added'),
  't|t|shelf empty',
  'R3: one evidence_added event names the uploader, the photo and the note');

set local role to 'service_role';
select is(pg_temp.rec(:'orgA', :'occL', :'stf2', 2), 'P0002',
  'R4: staff of another warehouse is refused as not found');
select is(pg_temp.rec(:'orgA', :'occL', :'mgrB', 3), 'P0002',
  'R5: a member of another org is refused as not found');
select is(pg_temp.rec(:'orgB', :'occB', :'stf', 4), 'P0002',
  'R6: another org''s occurrence is refused as not found for this uploader');
select is(pg_temp.rec(:'orgA', :'occL', :'dis', 5), 'P0002',
  'R7: a disabled account is refused as not found');
select is(pg_temp.rec(:'orgA', :'occL', :'pend', 6), 'P0002',
  'R8: a pending invite is refused as not found');
select is(pg_temp.rec(:'orgA', :'occL', :'vwr', 7), '42501',
  'R9: a viewer is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'vwrAdj', 8), '42501',
  'R10: a viewer granted stock:adjust is still refused (no write access)');
select is(pg_temp.rec(:'orgA', :'occL', :'stfNo', 9), '42501',
  'R11: staff without stock:adjust is refused');
select is(pg_temp.rec(:'orgA', :'occN', :'stf', 10), '42501',
  'R12: an occurrence with no warehouse refuses staff');
select is(pg_temp.rec(:'orgA', :'occN', :'mgr', 11), 'ok',
  'R13: ...and allows a manager');
select is(pg_temp.rec(:'orgA', :'occR', :'stf', 12), 'P0001:occurrence_resolved',
  'R14: a resolved (closed) occurrence is refused');
select is(pg_temp.rec(:'orgA', :'occX', :'stf', 13), 'P0002',
  'R15: an unknown occurrence is not found');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 14, 'gif', 'image/jpeg'), '22023:invalid_path',
  'R16: an extension outside the allow-list is an invalid path');
-- A path in another occurrence's folder, handed to this occurrence.
select throws_ok(
  format($$select public.exception_evidence_record(%L, %L, %L, null, 'image/jpeg', 1000)$$,
         :'occL', :'stf', pg_temp.path(:'orgA', :'occN', 15)),
  '22023', 'invalid_path',
  'R17: a path in another occurrence''s folder is an invalid path');
select throws_ok(
  format($$select public.exception_evidence_record(%L, %L, %L, null, 'image/jpeg', 1000)$$,
         :'occL', :'stf', :'orgA' || '/' || :'occL' || '/photo.jpg'),
  '22023', 'invalid_path',
  'R18: a file name that is not a uuid is an invalid path');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 16, 'png', 'image/jpeg'), '22023:invalid_content_type',
  'R19: an extension that disagrees with the type is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 17, 'jpg', 'image/gif'), '22023:invalid_content_type',
  'R20: a type outside the three is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 18, 'jpg', 'image/jpeg', null, null,
                      pg_temp.path(:'orgA', :'occL', 99, 'webp')), '22023:invalid_thumbnail_path',
  'R21: a thumbnail that is not a server thumbnail name ({uuid}-thumb.webp in this folder) is refused');
select is(pg_temp.rec(:'orgA', :'occN', :'mgr', 31, 'jpg', 'image/jpeg', null, null,
                      pg_temp.thumb(pg_temp.path(:'orgA', :'occN', 131))), 'ok',
  'R21b: a thumbnail with its own uuid (the server names each thumbnail afresh) is allowed');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 19, 'webp', 'image/webp', null, null, 'none'), 'ok',
  'R22: a photo with no thumbnail is allowed (webp, matching type)');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 20, 'jpg', 'image/jpeg', null, null, 'derived', 0),
  '22023:byte_size_out_of_range', 'R23: a zero-byte photo is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 21, 'jpg', 'image/jpeg', null, null, 'derived', 10485761),
  '22023:byte_size_out_of_range', 'R24: a photo over 10 MB is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 22, 'jpg', 'image/jpeg', repeat('n', 501)),
  '22023:note_too_long', 'R25: a note over 500 characters is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 23, 'jpg', 'image/jpeg', null, now() + interval '1 hour'),
  '22023:captured_at_in_future', 'R26: a capture time an hour ahead is refused');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 1), '23505:already_recorded',
  'R27: recording the same path twice answers 23505 already_recorded (the first row stands)');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 1, 'png', 'image/png'), '23505:already_recorded',
  'R34: {uuid}.png after {uuid}.jpg is the same upload name: 23505 already_recorded, no second row');
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 32, 'jpg', 'image/jpeg', null, null,
                      pg_temp.thumb(pg_temp.path(:'orgA', :'occL', 1))), '23505',
  'R35: a second row naming a recorded photo''s thumbnail is refused (unique thumbnail)');
reset role;

-- The request claims are restored after the call.
set local "request.jwt.claim.sub" to '';
set local "request.jwt.claim.role" to '';
set local role to 'service_role';
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 24), 'ok', 'R28: a record as service_role with no caller identity');
select is(auth.uid(), null::uuid,
  'R29: afterwards auth.uid() is null again: the uploader identity did not leak. Mutation: forget to restore');
select is(auth.role(), null::text, 'R30: and the role claim is back to what it was');
reset role;
set local "request.jwt.claim.sub" to :'mgrB';
set local "request.jwt.claim.role" to 'service_role';
set local role to 'service_role';
select is(pg_temp.rec(:'orgA', :'occL', :'stf', 25), 'ok', 'R31: a record while a different identity is set');
select is(format('%s %s', auth.uid() = :'mgrB', auth.role()), 't service_role',
  'R32: the earlier identity and role are restored exactly');
reset role;
set local "request.jwt.claim.sub" to '';
set local "request.jwt.claim.role" to '';

select is(
  (select count(*)::int from public.exception_occurrence_events where occurrence_id = :'occL' and kind = 'evidence_added'),
  (select count(*)::int from public.exception_evidence where occurrence_id = :'occL'),
  'R33: every recorded photo has exactly one evidence_added event, and no refusal left one');

-- ═══ K. The cap ═══════════════════════════════════════════════════════════
set local role to 'service_role';
select is(
  (select string_agg(pg_temp.rec(:'orgA', :'occC', :'stf', 100 + g), ',' order by g) from generate_series(1, 8) g),
  'ok,ok,ok,ok,ok,ok,ok,ok',
  'K1: eight photos record');
select is(pg_temp.rec(:'orgA', :'occC', :'stf', 109), 'P0001:evidence_limit_reached',
  'K2: the ninth live photo is refused. Mutation: drop the cap');
select is(pg_temp.rec(:'orgA', :'occC', :'mgr', 110), 'P0001:evidence_limit_reached',
  'K3: the cap holds for a manager too');
reset role;
select id as "k1" from public.exception_evidence where storage_path = pg_temp.path(:'orgA', :'occC', 101) \gset
set local "request.jwt.claim.sub" to :'stf';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(pg_temp.rm(:'k1', 'wrong shelf'), 'ok', 'K4: the uploader removes one photo');
reset role;
set local role to 'service_role';
select is(pg_temp.rec(:'orgA', :'occC', :'stf', 111), 'ok',
  'K5: a removed photo frees its slot. Mutation: count removed photos too');
select is(pg_temp.rec(:'orgA', :'occC', :'stf', 112), 'P0001:evidence_limit_reached',
  'K6: and the cap is full again');
select is(pg_temp.rec(:'orgA', :'occC', :'stf', 111), '23505:already_recorded',
  'K8: at the cap, a second record of a recorded upload is already_recorded, not evidence_limit_reached');
reset role;
select is(
  (select format('%s live, %s total', count(*) filter (where removed_at is null), count(*))
     from public.exception_evidence where occurrence_id = :'occC'),
  '8 live, 9 total',
  'K7: eight live photos and the removed one kept');

-- ═══ M. exception_evidence_remove ═════════════════════════════════════════
set local role to 'service_role';
select is(
  (select string_agg(pg_temp.rec(:'orgA', :'occZ', :'stf', 200 + g), ',' order by g) from generate_series(1, 3) g),
  'ok,ok,ok', 'M0: fixture: three photos by staff on occZ');
reset role;
select id as "m1" from public.exception_evidence where storage_path = pg_temp.path(:'orgA', :'occZ', 201) \gset
select id as "m2" from public.exception_evidence where storage_path = pg_temp.path(:'orgA', :'occZ', 202) \gset
select id as "m3" from public.exception_evidence where storage_path = pg_temp.path(:'orgA', :'occZ', 203) \gset
-- The stored object for m1, as the uploader's PUT left it.
insert into storage.objects (bucket_id, name) values ('exception-evidence', pg_temp.path(:'orgA', :'occZ', 201));
select count(*) as "rowsBefore" from public.exception_evidence \gset

set local "request.jwt.claim.sub" to :'stf';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(pg_temp.rm(:'m1', '  blurry  '), 'ok', 'M1: the uploader removes their own photo');
reset role;
select is(
  (select format('%s|%s', removed_at is not null, removed_by = :'stf') from public.exception_evidence where id = :'m1'),
  't|t',
  'M2: the row stays, marked removed by the uploader');
select is(
  (select format('%s|%s|%s', count(*), bool_and(actor_user_id = :'stf'), max(note))
     from public.exception_occurrence_events where evidence_id = :'m1' and kind = 'evidence_removed'),
  '1|t|blurry',
  'M3: one evidence_removed event with the remover and the trimmed reason');
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'exception-evidence' and name = pg_temp.path(:'orgA', :'occZ', 201)),
  1,
  'M4: the stored file is kept');

set local "request.jwt.claim.sub" to :'stf';
set local role to 'authenticated';
select is(pg_temp.rm(:'m1', 'again'), 'ok', 'M5: removing it again answers ok');
reset role;
select is(
  (select count(*)::int from public.exception_occurrence_events where evidence_id = :'m1' and kind = 'evidence_removed'),
  1,
  'M6: ...and writes no second event');

set local "request.jwt.claim.sub" to :'stf3';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2'), '42501',
  'M7: staff who did not upload it is refused. Mutation: drop the uploader-or-manager rule');
reset role;
set local "request.jwt.claim.sub" to :'vwr';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2'), '42501', 'M8: a viewer is refused');
reset role;
set local "request.jwt.claim.sub" to :'stf2';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2'), 'P0002', 'M9: staff of another warehouse gets not found');
reset role;
set local "request.jwt.claim.sub" to :'mgrB';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2'), 'P0002', 'M10: a member of another org gets not found');
select is(pg_temp.rm(gen_random_uuid()), 'P0002', 'M11: an unknown photo is not found');
reset role;
set local "request.jwt.claim.sub" to :'stf';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2', repeat('r', 501)), '22023:reason_too_long', 'M12: a reason over 500 characters is refused');
reset role;
set local "request.jwt.claim.sub" to '';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2'), '42501', 'M13: signed out is refused');
reset role;
set local "request.jwt.claim.sub" to :'mgr';
set local role to 'authenticated';
select is(pg_temp.rm(:'m2', 'duplicate'), 'ok', 'M14: a manager removes a photo someone else uploaded');
reset role;
select is(
  (select format('%s|%s', removed_by = :'mgr', (select actor_user_id = :'mgr' from public.exception_occurrence_events
                                                  where evidence_id = :'m2' and kind = 'evidence_removed'))
     from public.exception_evidence where id = :'m2'),
  't|t',
  'M15: the manager is recorded as the remover');

-- The occurrence resolves: its photos can no longer change.
update public.exception_occurrences set resolved_at = now(), resolved_reason = 'cleared' where id = :'occZ';
set local "request.jwt.claim.sub" to :'stf';
set local role to 'authenticated';
select is(pg_temp.rm(:'m3'), 'P0001:occurrence_resolved',
  'M16: a photo on a resolved occurrence cannot be removed. Mutation: drop the open check');
select is(pg_temp.rm(:'m1'), 'ok', 'M17: a repeat removal after resolution still answers (no change)');
reset role;
set local role to 'service_role';
select is(pg_temp.rec(:'orgA', :'occZ', :'stf', 202), '23505:already_recorded',
  'M20: on a resolved occurrence a second record of a recorded photo is already_recorded, not occurrence_resolved');
reset role;
select is(
  (select format('%s|%s', resolved_reason, (select count(*) from public.exception_occurrence_events
                                              where occurrence_id = :'occZ' and kind = 'resolved'))
     from public.exception_occurrences where id = :'occZ'),
  'cleared|0',
  'M18: removing photos never touched the occurrence''s resolution or wrote a resolved event');
select is((select count(*)::int from public.exception_evidence), :'rowsBefore'::int,
  'M19: removal never deletes a row');

-- ═══ L. Locks (catalog) ══════════════════════════════════════════════════
select ok(
  (select p.prosrc ~ 'from public\.exception_occurrences o\s+where o\.id = p_occurrence_id\s+for update;'
          and strpos(p.prosrc, 'for update') < strpos(p.prosrc, 'select count(*) into v_live')
     from pg_proc p
    where p.oid = 'public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)'::regprocedure),
  'L1: the record RPC locks the occurrence row before it counts live photos. Mutation: drop the FOR UPDATE');
select ok(
  (select p.prosrc ~ '_exc_occurrence_visible\(o\.organization_id, o\.item_id, o\.location_id\)\s+for update;'
          and p.prosrc ~ 'and e\.organization_id = v_occ\.organization_id\s+for update;'
     from pg_proc p
    where p.oid = 'public.exception_evidence_remove(uuid, text)'::regprocedure),
  'L2: the remove RPC locks the occurrence, then the photo. Mutation: drop either FOR UPDATE');

-- ═══ V. RLS ═══════════════════════════════════════════════════════════════
create function pg_temp.visible(p_occ uuid) returns int language sql as $$
  select count(*)::int from public.exception_evidence where occurrence_id = p_occ
$$;
set local "request.jwt.claim.sub" to :'stf';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(pg_temp.visible(:'occL'), 4, 'V1: staff of the warehouse sees every photo on the occurrence');
reset role;
set local "request.jwt.claim.sub" to :'vwr';
set local role to 'authenticated';
select is(pg_temp.visible(:'occL'), 4, 'V2: a viewer of the warehouse sees them too (reading is items:read)');
reset role;
set local "request.jwt.claim.sub" to :'stf2';
set local role to 'authenticated';
select is(pg_temp.visible(:'occL'), 0, 'V3: staff of another warehouse sees none');
reset role;
set local "request.jwt.claim.sub" to :'mgrB';
set local role to 'authenticated';
select is(pg_temp.visible(:'occL'), 0, 'V4: another org sees none');
select is((select count(*)::int from public.exception_evidence), 0, 'V5: another org sees no photo at all');
reset role;
set local "request.jwt.claim.sub" to :'dis';
set local role to 'authenticated';
select is(pg_temp.visible(:'occL'), 0, 'V6: a disabled account sees none');
reset role;

select * from finish();
rollback;
