-- supabase/tests/0316_maintenance_attachment_path_uniq.test.sql
-- Proves migration 0316: maintenance_request_attachments gets a hard
-- (organization_id, storage_path) uniqueness guarantee — one storage object
-- can back at most one row, closing the app-layer-only cap bypass (Important
-- 3, Task 9 security fix wave): mint's count check only protects the mint
-- step, and 0315's storage INSERT policy lets any accepted org member PUT
-- directly under the org prefix, so nothing but this index stopped the same
-- object from backing many attachment rows.
--
--   1. the new unique index exists and covers exactly
--      (organization_id, storage_path),
--   2. the SAME (org, storage_path) pair collides — 23505,
--   3. the SAME storage_path under a DIFFERENT org coexists (scoped by org,
--      not a global path lock),
--   4. the SAME org with a DIFFERENT storage_path coexists (the index isn't
--      accidentally keyed on organization_id alone).
--
-- Fixtures inserted as postgres (bypassing RLS — this migration's guarantee
-- is a plain DB constraint, not an RLS boundary, so no session-role dance is
-- needed to exercise it). Literal UUIDs are hardcoded inside the
-- throws_ok/lives_ok string bodies rather than spliced via `:var` (house
-- convention — see 0314's own fixture tests, which hardcode literals inside
-- $$..$$ blocks and reserve format()/`:'var'` splicing for values captured
-- at runtime via \gset).
--
-- Namespace: a0316000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(5);

\set orgA   '\'a0316000-0000-0000-0000-000000000001\''
\set orgB   '\'a0316000-0000-0000-0000-000000000002\''
\set usr    '\'a0316000-0000-0000-0000-0000000000a1\''
\set reqA   '\'a0316000-0000-0000-0000-0000000000c1\''
\set reqB   '\'a0316000-0000-0000-0000-0000000000c2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:usr, 'attach-path-uniq-0316@test.local', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  (:orgA, 'Attachment Path Uniq Org A', 'attach-path-uniq-org-a-0316'),
  (:orgB, 'Attachment Path Uniq Org B', 'attach-path-uniq-org-b-0316');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :usr, 'admin', now()),
  (:orgB, :usr, 'admin', now());

insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description)
values
  (:reqA, :orgA, :usr, 'Attach Uniq Tester', 'Org A leaking pipe', 'Water under the floor.'),
  (:reqB, :orgB, :usr, 'Attach Uniq Tester', 'Org B leaking pipe', 'Water under the floor.');

insert into public.maintenance_request_attachments
  (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename,
   mime_type, byte_size, uploaded_by)
values (
  :orgA, :reqA,
  'a0316000-0000-0000-0000-000000000001/a0316000-0000-0000-0000-0000000000c1/11111111-1111-4111-8111-111111111111.jpg',
  'photo.jpg', 'photo.jpg', 'image/jpeg', 12345, :usr
);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The new unique index exists and covers exactly
--    (organization_id, storage_path), in order.
-- ─────────────────────────────────────────────────────────────────────────
select is(
  (select count(*)::int from pg_indexes
     where schemaname = 'public'
       and tablename = 'maintenance_request_attachments'
       and indexname = 'maintenance_request_attachments_org_path_uniq'),
  1,
  'new (organization_id, storage_path) unique index exists'
);

select is(
  (select array_agg(a.attname::text order by k.ord)
     from pg_index x
     join pg_class c on c.oid = x.indexrelid
     cross join lateral unnest(x.indkey) with ordinality as k(attnum, ord)
     join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum
     where c.relname = 'maintenance_request_attachments_org_path_uniq'
       and x.indisunique),
  array['organization_id', 'storage_path']::text[],
  'unique index covers (organization_id, storage_path) in order'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The proven exploit: the SAME storage object backing a SECOND row in
--    the SAME org is rejected. This is exactly the shape of the app-layer
--    bypass — two finalize() calls (or a direct-to-storage PUT followed by
--    finalize()) both targeting one uploaded object.
-- ─────────────────────────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename,
        mime_type, byte_size, uploaded_by)
     values (
       'a0316000-0000-0000-0000-000000000001', 'a0316000-0000-0000-0000-0000000000c1',
       'a0316000-0000-0000-0000-000000000001/a0316000-0000-0000-0000-0000000000c1/11111111-1111-4111-8111-111111111111.jpg',
       'photo-again.jpg', 'photo-again.jpg', 'image/jpeg', 999, 'a0316000-0000-0000-0000-0000000000a1'
     ) $$,
  '23505', null,
  'a second row backed by the SAME (org, storage_path) is rejected'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The SAME storage_path string under a DIFFERENT org coexists — the
--    index is scoped per-org, not a global path lock (each org's prefix
--    already makes a real cross-org collision impossible in practice, but
--    the index's own column order/scope is what this pins).
-- ─────────────────────────────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename,
        mime_type, byte_size, uploaded_by)
     values (
       'a0316000-0000-0000-0000-000000000002', 'a0316000-0000-0000-0000-0000000000c2',
       'a0316000-0000-0000-0000-000000000001/a0316000-0000-0000-0000-0000000000c1/11111111-1111-4111-8111-111111111111.jpg',
       'photo.jpg', 'photo.jpg', 'image/jpeg', 12345, 'a0316000-0000-0000-0000-0000000000a1'
     ) $$,
  'the identical storage_path string under a DIFFERENT org coexists (scoped per-org)'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The SAME org with a DIFFERENT storage_path coexists — the index is not
--    accidentally keyed on organization_id alone.
-- ─────────────────────────────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename,
        mime_type, byte_size, uploaded_by)
     values (
       'a0316000-0000-0000-0000-000000000001', 'a0316000-0000-0000-0000-0000000000c1',
       'a0316000-0000-0000-0000-000000000001/a0316000-0000-0000-0000-0000000000c1/22222222-2222-4222-8222-222222222222.jpg',
       'other.jpg', 'other.jpg', 'image/jpeg', 555, 'a0316000-0000-0000-0000-0000000000a1'
     ) $$,
  'a different storage_path in the same org coexists'
);

select * from finish();
rollback;
