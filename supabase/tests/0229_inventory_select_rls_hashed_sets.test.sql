-- supabase/tests/0229_inventory_select_rls_hashed_sets.test.sql
-- Proves migration 0229: the inventory_items / stock_movements SELECT
-- policies rebuilt as hashed-set probes are ROW-SET IDENTICAL to the old
-- per-row predicates (user_can_access_inventory + user_can_see_item_category,
-- is_org_member), with ONE deliberate tightening: expired "act as"
-- impersonation memberships (0177 gap) no longer read inventory_items.
--
-- Method: for every persona the same fixture matrix is read twice —
--   (a) live, as that authenticated user (new policy decides), and
--   (b) as superuser filtered by the OLD functions with the persona's uid
--       (the pre-0229 predicate, which takes p_user_id explicitly).
-- Both must equal the same hand-computed id list. The impersonation-expired
-- persona is asserted to DIFFER exactly as intended (old: visible, new: zero).
--
-- Personas × semantics covered:
--   ownerA          manager+ sees all org items — EXCEPT the NULL-warehouse
--                   item (old user_can_access_inventory returns false when
--                   warehouse_id is NULL, even for owners — preserved).
--   staffAllWh1     staff, assignment (whA1, charter NULL) → every charter
--                   at whA1, nothing at whA2.
--   staffChX        staff, assignment (whA1, chX) → chX items + GENERIC
--                   (NULL-charter) items at whA1; NOT chY; NOT whA2.
--   staffNone       staff, zero assignments → zero items (but DOES see all
--                   org stock_movements — that policy is org-membership only).
--   viewerRestr     viewer, wh access + category whitelist {catG} → only
--                   catG items; NULL-category items hidden.
--   viewerFree      viewer, wh access, ZERO category rows → unrestricted
--                   (0128 back-compat default).
--   staffUca        staff WITH stale category rows → still unrestricted
--                   (category whitelist applies to role=viewer only).
--   outsider        authenticated non-member → zero rows everywhere.
--   ownerB          cross-org isolation: sees only org B.
--   impActive       unexpired impersonation owner → full org A access.
--   impExpired      EXPIRED impersonation owner → zero rows under the new
--                   policy; the old predicate is shown to have leaked.
--
-- Namespace: ac022900. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(39);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  ('ac022900-0000-0000-0000-000000000101', 'owner-a@0229.test',      '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000102', 'staff-allwh1@0229.test', '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000103', 'staff-chx@0229.test',    '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000104', 'staff-none@0229.test',   '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000105', 'viewer-restr@0229.test', '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000106', 'viewer-free@0229.test',  '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000107', 'outsider@0229.test',     '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000108', 'owner-b@0229.test',      '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000109', 'imp-expired@0229.test',  '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000110', 'imp-active@0229.test',   '{}'::jsonb),
  ('ac022900-0000-0000-0000-000000000111', 'staff-uca@0229.test',    '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  ('ac022900-0000-0000-0000-00000000000a', 'Hashed RLS Org A', 'hashed-rls-a-0229'),
  ('ac022900-0000-0000-0000-00000000000b', 'Hashed RLS Org B', 'hashed-rls-b-0229');

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-00000000000a', 'WH A1', 'WH-A1-0229', 'active'),
  ('ac022900-0000-0000-0000-000000000012', 'ac022900-0000-0000-0000-00000000000a', 'WH A2', 'WH-A2-0229', 'active'),
  ('ac022900-0000-0000-0000-000000000013', 'ac022900-0000-0000-0000-00000000000b', 'WH B1', 'WH-B1-0229', 'active');

insert into public.charters (id, organization_id, name, code) values
  ('ac022900-0000-0000-0000-000000000021', 'ac022900-0000-0000-0000-00000000000a', 'Charter X', 'CH-X-0229'),
  ('ac022900-0000-0000-0000-000000000022', 'ac022900-0000-0000-0000-00000000000a', 'Charter Y', 'CH-Y-0229');

insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-000000000021'),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-000000000022'),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000012', 'ac022900-0000-0000-0000-000000000021');

insert into public.categories (id, organization_id, name) values
  ('ac022900-0000-0000-0000-000000000031', 'ac022900-0000-0000-0000-00000000000a', 'Cat G 0229'),
  ('ac022900-0000-0000-0000-000000000032', 'ac022900-0000-0000-0000-00000000000a', 'Cat H 0229'),
  ('ac022900-0000-0000-0000-000000000033', 'ac022900-0000-0000-0000-00000000000b', 'Cat B 0229');

insert into public.organization_members
  (organization_id, user_id, role, accepted_at, impersonation_expires_at)
values
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000101', 'owner',  now(), null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000102', 'staff',  now(), null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000103', 'staff',  now(), null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000104', 'staff',  now(), null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000105', 'viewer', now(), null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000106', 'viewer', now(), null),
  ('ac022900-0000-0000-0000-00000000000b', 'ac022900-0000-0000-0000-000000000108', 'owner',  now(), null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000109', 'owner',  now(), now() - interval '1 hour'),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000110', 'owner',  now(), now() + interval '1 hour'),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000111', 'staff',  now(), null);
-- outsider (…0107) is intentionally NOT a member of anything.

insert into public.user_warehouse_assignments
  (organization_id, user_id, warehouse_id, charter_id)
values
  -- staffAllWh1: whole warehouse A1 (all charters)
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000102',
   'ac022900-0000-0000-0000-000000000011', null),
  -- staffChX: only charter X at warehouse A1
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000103',
   'ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-000000000021'),
  -- viewerRestr / viewerFree / staffUca: whole warehouse A1
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000105',
   'ac022900-0000-0000-0000-000000000011', null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000106',
   'ac022900-0000-0000-0000-000000000011', null),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000111',
   'ac022900-0000-0000-0000-000000000011', null);

insert into public.user_category_assignments (organization_id, user_id, category_id) values
  -- viewerRestr: whitelisted to Cat G only
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000105',
   'ac022900-0000-0000-0000-000000000031'),
  -- staffUca: stale rows on a STAFF account — must have no effect
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000111',
   'ac022900-0000-0000-0000-000000000032');

-- Items — the semantic matrix. (warehouse, charter, category) per item:
--   i1 (whA1, chX,  catG)   i2 (whA1, chY,  catG)   i3 (whA1, NULL, catH)
--   i4 (whA1, chX,  NULL)   i5 (whA2, chX,  catG)
--   i6 (NULL warehouse — invisible to EVERYONE under the old + new policy)
--   i7 (org B: whB1, NULL, catB)
insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, category_id, sku, name,
   quantity_on_hand, unit_cost, reorder_point, status, tracking_type, created_at)
values
  ('ac022900-0000-0000-0000-000000000201', 'ac022900-0000-0000-0000-00000000000a',
   'ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-000000000021',
   'ac022900-0000-0000-0000-000000000031', 'HS-I1', 'Item i1', 5, 1, 0, 'active', 'none', now()),
  ('ac022900-0000-0000-0000-000000000202', 'ac022900-0000-0000-0000-00000000000a',
   'ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-000000000022',
   'ac022900-0000-0000-0000-000000000031', 'HS-I2', 'Item i2', 5, 1, 0, 'active', 'none', now()),
  ('ac022900-0000-0000-0000-000000000203', 'ac022900-0000-0000-0000-00000000000a',
   'ac022900-0000-0000-0000-000000000011', null,
   'ac022900-0000-0000-0000-000000000032', 'HS-I3', 'Item i3 (generic)', 5, 1, 0, 'active', 'none', now()),
  ('ac022900-0000-0000-0000-000000000204', 'ac022900-0000-0000-0000-00000000000a',
   'ac022900-0000-0000-0000-000000000011', 'ac022900-0000-0000-0000-000000000021',
   null, 'HS-I4', 'Item i4 (no category)', 5, 1, 0, 'active', 'none', now()),
  ('ac022900-0000-0000-0000-000000000205', 'ac022900-0000-0000-0000-00000000000a',
   'ac022900-0000-0000-0000-000000000012', 'ac022900-0000-0000-0000-000000000021',
   'ac022900-0000-0000-0000-000000000031', 'HS-I5', 'Item i5 (whA2)', 5, 1, 0, 'active', 'none', now()),
  ('ac022900-0000-0000-0000-000000000206', 'ac022900-0000-0000-0000-00000000000a',
   null, null,
   'ac022900-0000-0000-0000-000000000031', 'HS-I6', 'Item i6 (no warehouse)', 5, 1, 0, 'active', 'none', now()),
  ('ac022900-0000-0000-0000-000000000207', 'ac022900-0000-0000-0000-00000000000b',
   'ac022900-0000-0000-0000-000000000013', null,
   'ac022900-0000-0000-0000-000000000033', 'HS-I7', 'Item i7 (org B)', 5, 1, 0, 'active', 'none', now());

-- Movements: 2 in org A, 1 in org B (org-membership-scoped policy).
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity)
values
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000201', 'add',    5, 0, 5),
  ('ac022900-0000-0000-0000-00000000000a', 'ac022900-0000-0000-0000-000000000203', 'adjust', 1, 4, 5),
  ('ac022900-0000-0000-0000-00000000000b', 'ac022900-0000-0000-0000-000000000207', 'add',    5, 0, 5);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-6. Shape: the six helper set functions exist (zero-arg).
-- ─────────────────────────────────────────────────────────────────────────────

select has_function('public', 'rls_inv_read_full_warehouse_ids',     '{}'::name[],
  'rls_inv_read_full_warehouse_ids() exists');
select has_function('public', 'rls_inv_read_assigned_warehouse_ids', '{}'::name[],
  'rls_inv_read_assigned_warehouse_ids() exists');
select has_function('public', 'rls_inv_read_warehouse_charter_ids',  '{}'::name[],
  'rls_inv_read_warehouse_charter_ids() exists');
select has_function('public', 'rls_cat_unrestricted_org_ids',        '{}'::name[],
  'rls_cat_unrestricted_org_ids() exists');
select has_function('public', 'rls_cat_allowed_category_ids',        '{}'::name[],
  'rls_cat_allowed_category_ids() exists');
select has_function('public', 'rls_member_org_ids',                  '{}'::name[],
  'rls_member_org_ids() exists');

-- ─────────────────────────────────────────────────────────────────────────────
-- 7-10. Security posture of all six helpers: SECURITY DEFINER (they read
--       membership/assignment tables the caller cannot), search_path pinned,
--       anon holds NO execute, authenticated DOES (policies run as the caller).
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rls_inv_read_full_warehouse_ids','rls_inv_read_assigned_warehouse_ids',
                       'rls_inv_read_warehouse_charter_ids','rls_cat_unrestricted_org_ids',
                       'rls_cat_allowed_category_ids','rls_member_org_ids')
     and p.prosecdef),
  6::bigint,
  'all six RLS helpers are SECURITY DEFINER');

select ok(
  (select bool_and(p.proconfig @> array['search_path=public']) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rls_inv_read_full_warehouse_ids','rls_inv_read_assigned_warehouse_ids',
                       'rls_inv_read_warehouse_charter_ids','rls_cat_unrestricted_org_ids',
                       'rls_cat_allowed_category_ids','rls_member_org_ids')),
  'all six RLS helpers have search_path pinned to public');

select ok(
  (select bool_and(not has_function_privilege('anon', p.oid, 'execute')) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rls_inv_read_full_warehouse_ids','rls_inv_read_assigned_warehouse_ids',
                       'rls_inv_read_warehouse_charter_ids','rls_cat_unrestricted_org_ids',
                       'rls_cat_allowed_category_ids','rls_member_org_ids')),
  'anon holds NO execute on any RLS helper');

select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rls_inv_read_full_warehouse_ids','rls_inv_read_assigned_warehouse_ids',
                       'rls_inv_read_warehouse_charter_ids','rls_cat_unrestricted_org_ids',
                       'rls_cat_allowed_category_ids','rls_member_org_ids')),
  'authenticated holds execute on every RLS helper (policy expressions run as the caller)');

-- ─────────────────────────────────────────────────────────────────────────────
-- 11-12. The rebuilt policies are in place and reference the hashed sets.
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'inventory_items'
             and policyname = 'inventory_items_select' and cmd = 'SELECT'
             and qual like '%rls_inv_read_full_warehouse_ids%'
             and qual like '%rls_cat_unrestricted_org_ids%'),
  'inventory_items_select is the 0229 hashed-set policy');

select ok(
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'stock_movements'
             and policyname = 'stock_movements_select' and cmd = 'SELECT'
             and qual like '%rls_member_org_ids%'),
  'stock_movements_select is the 0229 hashed-set policy');

-- ═════════════════════════════════════════════════════════════════════════════
-- Equivalence matrix. For each persona: (a) live rows under the NEW policy as
-- that authenticated user, (b) rows passing the OLD predicate (superuser +
-- explicit uid). Both must match the hand-computed set.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── ownerA: all org A items EXCEPT i6 (NULL warehouse blocks even owners) ────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000101';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid),
            ('ac022900-0000-0000-0000-000000000205'::uuid) $$,
  'NEW: ownerA sees i1-i5, and NOT the NULL-warehouse item i6 (preserved old semantics)');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000101'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000101'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid),
            ('ac022900-0000-0000-0000-000000000205'::uuid) $$,
  'OLD: ownerA predicate returns the identical set (equivalence)');

-- ── staffAllWh1: every charter at whA1; nothing at whA2 ──────────────────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000102';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'NEW: staff with a NULL-charter assignment sees all whA1 items (i1-i4), none at whA2');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000102'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000102'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'OLD: staffAllWh1 predicate returns the identical set (equivalence)');

-- ── staffChX: chX + generic items at whA1 only (NOT chY, NOT whA2) ───────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000103';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'NEW: charter-scoped staff sees chX items (i1,i4) + generic stock (i3); chY (i2) and whA2 (i5) hidden');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000103'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000103'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'OLD: staffChX predicate returns the identical set (equivalence)');

-- ── staffNone: member, zero assignments → zero items ─────────────────────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000104';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.inventory_items where id::text like 'ac022900%'),
  0::bigint,
  'NEW: staff with no warehouse assignment sees zero items');
reset role;
select is(
  (select count(*) from public.inventory_items
    where id::text like 'ac022900%'
      and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000104'::uuid, warehouse_id, charter_id, 'read')
      and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000104'::uuid, organization_id, category_id)),
  0::bigint,
  'OLD: staffNone predicate returns zero rows too (equivalence)');

-- ── viewerRestr: category whitelist {catG} → only i1,i2; NULL-category hidden ─
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000105';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid) $$,
  'NEW: restricted viewer sees only catG items (i1,i2); catH (i3) and NULL-category (i4) hidden');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000105'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000105'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid) $$,
  'OLD: viewerRestr predicate returns the identical set (equivalence)');

-- ── viewerFree: zero category rows → unrestricted (0128 back-compat) ─────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000106';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'NEW: viewer with zero category rows is category-unrestricted (sees i1-i4 via wh access)');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000106'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000106'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'OLD: viewerFree predicate returns the identical set (equivalence)');

-- ── staffUca: stale category rows on a STAFF account have NO effect ──────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000111';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'NEW: staff with stale user_category_assignments rows stays unrestricted (whitelist is viewer-only)');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000111'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000111'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid) $$,
  'OLD: staffUca predicate returns the identical set (equivalence)');

-- ── outsider: authenticated non-member → zero rows ───────────────────────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000107';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.inventory_items where id::text like 'ac022900%'),
  0::bigint,
  'NEW: an authenticated NON-member sees zero items');
reset role;
select is(
  (select count(*) from public.inventory_items
    where id::text like 'ac022900%'
      and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000107'::uuid, warehouse_id, charter_id, 'read')
      and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000107'::uuid, organization_id, category_id)),
  0::bigint,
  'OLD: outsider predicate returns zero rows too (equivalence)');

-- ── ownerB: cross-org isolation — only org B's item ──────────────────────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000108';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000207'::uuid) $$,
  'NEW: org B owner sees ONLY org B''s item (cross-org isolation)');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000108'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000108'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000207'::uuid) $$,
  'OLD: ownerB predicate returns the identical set (equivalence)');

-- ── impActive: unexpired impersonation owner keeps full access ───────────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000110';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select id from public.inventory_items where id::text like 'ac022900%' order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid),
            ('ac022900-0000-0000-0000-000000000205'::uuid) $$,
  'NEW: ACTIVE impersonation owner sees all org A items (i1-i5)');
reset role;
select results_eq(
  $$ select id from public.inventory_items
      where id::text like 'ac022900%'
        and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000110'::uuid, warehouse_id, charter_id, 'read')
        and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000110'::uuid, organization_id, category_id)
      order by id $$,
  $$ values ('ac022900-0000-0000-0000-000000000201'::uuid),
            ('ac022900-0000-0000-0000-000000000202'::uuid),
            ('ac022900-0000-0000-0000-000000000203'::uuid),
            ('ac022900-0000-0000-0000-000000000204'::uuid),
            ('ac022900-0000-0000-0000-000000000205'::uuid) $$,
  'OLD: impActive predicate returns the identical set (equivalence)');

-- ── impExpired: THE ONE DELIBERATE DELTA (closes the 0177 gap) ───────────────
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000109';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.inventory_items where id::text like 'ac022900%'),
  0::bigint,
  'NEW: EXPIRED impersonation owner sees ZERO items (0177 expiry now enforced here too)');
reset role;
select is(
  (select count(*) from public.inventory_items
    where id::text like 'ac022900%'
      and public.user_can_access_inventory('ac022900-0000-0000-0000-000000000109'::uuid, warehouse_id, charter_id, 'read')
      and public.user_can_see_item_category('ac022900-0000-0000-0000-000000000109'::uuid, organization_id, category_id)),
  5::bigint,
  'OLD: the pre-0229 predicate LEAKED all 5 items to the expired impersonator (the gap 0229 closes)');

-- ═════════════════════════════════════════════════════════════════════════════
-- stock_movements: org-membership scope preserved (NOT warehouse-scoped).
-- ═════════════════════════════════════════════════════════════════════════════

-- staffNone sees zero ITEMS (above) but ALL org A movements — proving the
-- movements policy is org-membership-only, exactly like old is_org_member.
set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000104';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.stock_movements where organization_id::text like 'ac022900%'),
  2::bigint,
  'movements: an org A member with NO warehouse assignment still sees both org A movements (org-membership scope preserved)');
reset role;

set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000108';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.stock_movements where organization_id::text like 'ac022900%'),
  1::bigint,
  'movements: org B owner sees only org B''s movement (cross-org isolation)');
reset role;

set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000107';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.stock_movements where organization_id::text like 'ac022900%'),
  0::bigint,
  'movements: authenticated non-member sees zero movements');
reset role;

set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000109';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.stock_movements where organization_id::text like 'ac022900%'),
  0::bigint,
  'movements: EXPIRED impersonation owner sees zero (identical to old is_org_member, which 0177 already fixed)');
reset role;

set local "request.jwt.claim.sub" to 'ac022900-0000-0000-0000-000000000110';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.stock_movements where organization_id::text like 'ac022900%'),
  2::bigint,
  'movements: ACTIVE impersonation owner sees both org A movements');
reset role;

select * from finish();
rollback;
