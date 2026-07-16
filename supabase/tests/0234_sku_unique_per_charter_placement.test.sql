-- supabase/tests/0234_sku_unique_per_charter_placement.test.sql
-- Proves migration 0234: SKU uniqueness is per (org, sku, charter, bin), not
-- per (org, sku, bin).
--
--   • the old index inventory_items_org_sku_bin_unique is GONE,
--   • the new index inventory_items_org_sku_charter_bin_unique exists, is
--     unique, and covers exactly (organization_id, sku, charter_id, bin_location),
--   • the SAME sku at the SAME empty bin under DIFFERENT charters now COEXISTS
--     (the owner's "two same-model laptops, different charter" case),
--   • the SAME sku + SAME charter + SAME bin still collides (a true duplicate
--     placement — 23505),
--   • two "generic" rows (charter NULL, bin NULL, same sku) still collide
--     (NULLS NOT DISTINCT preserves the bulk-import dedup guarantee).
--
-- Namespace: ac023400. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(8);

\set org      '\'ac023400-0000-0000-0000-000000000001\''
\set usr      '\'ac023400-0000-0000-0000-000000000002\''
\set wh       '\'ac023400-0000-0000-0000-000000000003\''
\set chA      '\'ac023400-0000-0000-0000-00000000000a\''
\set chB      '\'ac023400-0000-0000-0000-00000000000b\''
\set i1       '\'ac023400-0000-0000-0000-000000000011\''
\set i2       '\'ac023400-0000-0000-0000-000000000012\''
\set i3       '\'ac023400-0000-0000-0000-000000000013\''
\set i4       '\'ac023400-0000-0000-0000-000000000014\''
\set i5       '\'ac023400-0000-0000-0000-000000000015\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'sku-0234@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'SKU Charter Org 0234', 'sku-charter-org-0234') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'SKU WH 0234', 'WH-SKU-0234', 'active') on conflict (id) do nothing;

insert into public.charters (id, organization_id, name, code)
  values (:chA, :org, 'Charter A 0234', 'CH-A-0234'),
         (:chB, :org, 'Charter B 0234', 'CH-B-0234')
  on conflict (id) do nothing;

-- inventory_items_warehouse_charter_fk (0008) requires a non-null charter_id
-- to be a (warehouse, charter) pair already serviced per warehouse_charters.
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
  values (:org, :wh, :chA),
         (:org, :wh, :chB)
  on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-2. The index swap happened.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*)::int from pg_indexes
     where schemaname = 'public'
       and tablename = 'inventory_items'
       and indexname = 'inventory_items_org_sku_bin_unique'),
  0,
  'old (org, sku, bin) unique index is dropped'
);

select is(
  (select count(*)::int from pg_indexes
     where schemaname = 'public'
       and tablename = 'inventory_items'
       and indexname = 'inventory_items_org_sku_charter_bin_unique'),
  1,
  'new (org, sku, charter, bin) unique index exists'
);

-- 3. The new index is UNIQUE and covers exactly the four expected columns in order.
select is(
  (select array_agg(a.attname::text order by k.ord)
     from pg_index x
     join pg_class c on c.oid = x.indexrelid
     cross join lateral unnest(x.indkey) with ordinality as k(attnum, ord)
     join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum
     where c.relname = 'inventory_items_org_sku_charter_bin_unique'
       and x.indisunique),
  array['organization_id', 'sku', 'charter_id', 'bin_location']::text[],
  'new unique index covers (organization_id, sku, charter_id, bin_location) in order'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Same sku, same (empty) bin, DIFFERENT charter → BOTH coexist.
--    This is the owner's case: "same laptop model, different charter."
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
  values (:i1, :org, :wh, :chA, 'SP-DUP-0234', 'Laptop @ Charter A', null, 100, 'active', 'none');

select lives_ok(
  $$ insert into public.inventory_items
       (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
       values ('ac023400-0000-0000-0000-000000000012', 'ac023400-0000-0000-0000-000000000001',
               'ac023400-0000-0000-0000-000000000003', 'ac023400-0000-0000-0000-00000000000b',
               'SP-DUP-0234', 'Laptop @ Charter B', null, 50, 'active', 'none') $$,
  'same sku + empty bin under a DIFFERENT charter now coexists'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Same sku, SAME charter, SAME (empty) bin → still a true-duplicate 23505.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into public.inventory_items
       (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
       values ('ac023400-0000-0000-0000-000000000013', 'ac023400-0000-0000-0000-000000000001',
               'ac023400-0000-0000-0000-000000000003', 'ac023400-0000-0000-0000-00000000000a',
               'SP-DUP-0234', 'Duplicate placement', null, 5, 'active', 'none') $$,
  '23505', null,
  'same sku + same charter + same empty bin is still rejected (true duplicate)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Same sku, same charter, DIFFERENT bin → coexists (unchanged from 0126).
-- ─────────────────────────────────────────────────────────────────────────────

select lives_ok(
  $$ insert into public.inventory_items
       (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
       values ('ac023400-0000-0000-0000-000000000014', 'ac023400-0000-0000-0000-000000000001',
               'ac023400-0000-0000-0000-000000000003', 'ac023400-0000-0000-0000-00000000000a',
               'SP-DUP-0234', 'Same charter, rack 2-A', '2-A', 7, 'active', 'none') $$,
  'same sku + same charter + a different bin still coexists'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Two "generic" rows (charter NULL, bin NULL, same sku) still collide —
--    NULLS NOT DISTINCT preserves the bulk-import "no charter, no rack" dedup.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
  values (:i5, :org, :wh, null, 'SP-GENERIC-0234', 'Generic row 1', null, 1, 'active', 'none');

select throws_ok(
  $$ insert into public.inventory_items
       (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
       values ('ac023400-0000-0000-0000-000000000016', 'ac023400-0000-0000-0000-000000000001',
               'ac023400-0000-0000-0000-000000000003', null,
               'SP-GENERIC-0234', 'Generic row 2', null, 2, 'active', 'none') $$,
  '23505', null,
  'two generic rows (charter NULL, bin NULL, same sku) still collide'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. A soft-deleted row does NOT block a live insert (partial WHERE deleted_at
--    IS NULL is preserved).
-- ─────────────────────────────────────────────────────────────────────────────

update public.inventory_items set deleted_at = now() where id = :i1;

select lives_ok(
  $$ insert into public.inventory_items
       (id, organization_id, warehouse_id, charter_id, sku, name, bin_location, quantity_on_hand, status, tracking_type)
       values ('ac023400-0000-0000-0000-000000000017', 'ac023400-0000-0000-0000-000000000001',
               'ac023400-0000-0000-0000-000000000003', 'ac023400-0000-0000-0000-00000000000a',
               'SP-DUP-0234', 'Re-created after soft-delete', null, 3, 'active', 'none') $$,
  'a soft-deleted row does not block re-inserting the same (sku, charter, bin)'
);

select * from finish();
rollback;
