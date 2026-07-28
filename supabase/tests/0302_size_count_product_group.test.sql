-- supabase/tests/0302_size_count_product_group.test.sql
--
-- Proves 0302: Instant Size Count is re-keyed from the display-only style_key
-- onto a real product_group_id, WITHOUT breaking a single pre-0302 session.
--
-- Assertion index (14):
--    1  product_group_id exists
--    2  ...and is NULLABLE (every historical session has no group, and an
--       ungrouped org never gains one)
--    3  ...and is uuid (a group reference, never a name string)
--    4  it FKs product_groups(id)
--    5  size_count_sessions_group_idx exists
--    6  style_key IS STILL THERE — it is kept, not dropped: existing rows
--       carry it and the display-only fallback still reads it
--    7  ...and style_key is STILL NULLABLE (nothing became mandatory)
--    8  ANTI-REGRESSION: a session inserted with only the pre-0302 columns
--       still succeeds, as staff, under RLS
--    9  ...and reads back a NULL product_group_id (no default back-filled a
--       group nobody chose — and NO style_key was heuristically mapped)
--   10  a session naming a SAME-ORG group is accepted
--   11  ORG SCOPING: a session naming ANOTHER org's group is REJECTED. The
--       group id is a client-supplied uuid; a plain FK cannot say "same org".
--   12  the pre-0302 session survives its org gaining groups (still readable)
--   13  ON DELETE SET NULL, behaviourally: delete the group and the SESSION
--       SURVIVES — a count list is evidence of work done and a group delete
--       must never destroy it
--   14  ...with product_group_id nulled (and its style_key untouched)
--
-- Namespace: 51301000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(14);

\set orgA  '\'51301000-0000-0000-0000-000000000001\''
\set orgB  '\'51301000-0000-0000-0000-000000000002\''
\set stfA  '\'51301000-0000-0000-0000-000000000003\''
\set whA   '\'51301000-0000-0000-0000-00000000000a\''
\set grpA  '\'51301000-0000-0000-0000-0000000000a1\''
\set grpB  '\'51301000-0000-0000-0000-0000000000b1\''
\set sLeg  '\'51301000-0000-0000-0000-0000000000e1\''
\set sGrp  '\'51301000-0000-0000-0000-0000000000e2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:stfA, 'stfA-0302@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Size Org A 0302', 'size-org-a-0302'),
  (:orgB, 'Size Org B 0302', 'size-org-b-0302') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :stfA, 'staff', now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'WH A 0302', 'WH-A-0302', 'active') on conflict (id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id)
  values (:orgA, :stfA, :whA) on conflict do nothing;

-- One group in each org. Same identity shape; different tenants.
insert into public.product_groups
  (id, organization_id, subcategory_key, name, brand, model, group_key,
   default_counting_unit)
  values
  (:grpA, :orgA, 'shoes', 'Nike Pegasus 41', 'Nike', 'Pegasus 41',
   'shoes|nike|pegasus 41||', 'pair'),
  (:grpB, :orgB, 'shoes', 'Nike Pegasus 41', 'Nike', 'Pegasus 41',
   'shoes|nike|pegasus 41||', 'pair')
  on conflict (id) do nothing;

-- ── 1-3. The column ─────────────────────────────────────────────────────────
select has_column('public', 'size_count_sessions', 'product_group_id',
  'size_count_sessions has product_group_id');
select col_is_null('public', 'size_count_sessions', 'product_group_id',
  'product_group_id is NULLABLE — every historical session has no group');
select col_type_is('public', 'size_count_sessions', 'product_group_id', 'uuid',
  'product_group_id is uuid — a group reference, never a name string');

-- ── 4. It references product_groups ─────────────────────────────────────────
select fk_ok('public', 'size_count_sessions', 'product_group_id',
             'public', 'product_groups', 'id',
  'product_group_id references product_groups(id)');

-- ── 5. The lookup index ─────────────────────────────────────────────────────
select has_index('public', 'size_count_sessions', 'size_count_sessions_group_idx',
  'size_count_sessions_group_idx exists');

-- ── 6-7. style_key is KEPT, and kept optional ───────────────────────────────
select has_column('public', 'size_count_sessions', 'style_key',
  'style_key is KEPT, not dropped — existing rows carry it');
select col_is_null('public', 'size_count_sessions', 'style_key',
  'style_key is still nullable — nothing became mandatory');

-- ── As staff A (org A), under RLS ───────────────────────────────────────────
set local "request.jwt.claim.sub" to '51301000-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 8-9. Anti-regression: the pre-0302 insert shape still works ─────────────
select lives_ok(
  $$ insert into public.size_count_sessions
       (id, organization_id, warehouse_id, style_key, box_id, mode, started_by)
     values ('51301000-0000-0000-0000-0000000000e1',
             '51301000-0000-0000-0000-000000000001',
             '51301000-0000-0000-0000-00000000000a',
             'nike pegasus 41', 'BOX-7', 'rapid_pass',
             '51301000-0000-0000-0000-000000000003') $$,
  'a session inserted with only the pre-0302 columns still succeeds');

select is(
  (select coalesce(product_group_id::text, 'NULL') || '/' || coalesce(style_key, 'NULL')
     from public.size_count_sessions where id = :sLeg),
  'NULL/nike pegasus 41',
  'the legacy session reads back a NULL group and its original style_key '
  '(no default, and no name-heuristic mapped it to a group)');

-- ── 10. A same-org group is accepted ────────────────────────────────────────
select lives_ok(
  $$ insert into public.size_count_sessions
       (id, organization_id, warehouse_id, product_group_id, mode, started_by)
     values ('51301000-0000-0000-0000-0000000000e2',
             '51301000-0000-0000-0000-000000000001',
             '51301000-0000-0000-0000-00000000000a',
             '51301000-0000-0000-0000-0000000000a1', 'rapid_pass',
             '51301000-0000-0000-0000-000000000003') $$,
  'a session naming a group in its OWN org is accepted');

-- ── 11. Another org's group is refused ──────────────────────────────────────
-- The FK alone would happily accept org B's group: it only checks the row
-- exists. Org scoping has to be a policy arm (product_group_in_org).
select throws_ok(
  $$ insert into public.size_count_sessions
       (organization_id, warehouse_id, product_group_id, mode, started_by)
     values ('51301000-0000-0000-0000-000000000001',
             '51301000-0000-0000-0000-00000000000a',
             '51301000-0000-0000-0000-0000000000b1', 'rapid_pass',
             '51301000-0000-0000-0000-000000000003') $$,
  '42501',
  'new row violates row-level security policy for table "size_count_sessions"',
  'a session naming ANOTHER org''s product group is refused by RLS');

reset role;

-- ── 12. The legacy session is untouched by any of this ──────────────────────
select is(
  (select count(*)::int from public.size_count_sessions where id = :sLeg),
  1,
  'the pre-0302 session is still there after its org started using groups');

-- ── 13-14. ON DELETE SET NULL: the count list outlives the group ────────────
-- A completed size count is a record of work a human did. Deleting the product
-- group must strip the link, never the evidence.
delete from public.product_groups where id = :grpA;

select is(
  (select count(*)::int from public.size_count_sessions where id = :sGrp),
  1,
  'deleting the product group LEAVES the size-count session');

select is(
  (select coalesce(product_group_id::text, 'NULL') || '/' || coalesce(style_key, 'NULL')
     from public.size_count_sessions where id = :sGrp),
  'NULL/NULL',
  'the orphaned session reads product_group_id NULL (on delete set null) and '
  'gains no invented style_key');

select * from finish();
rollback;
