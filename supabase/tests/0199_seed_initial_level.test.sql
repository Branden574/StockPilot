-- supabase/tests/0199_seed_initial_level.test.sql
-- pgTAP gate for migration 0199: tg_seed_initial_level (AFTER INSERT) seeds an
-- item_stock_levels row on item creation so Σlevels = quantity_on_hand from day 0.
--
-- Four cases:
--   1. Item with quantity_on_hand=12 and primary_location_id = a rack location
--      → the RACK level = 12 and Σ levels = on_hand = 12.
--   2. Item with quantity_on_hand=5, primary_location_id = null, warehouse_id set
--      → the warehouse UNPLACED level = 5, Σ = 5, and STAGING level is absent/0.
--   3. Item with quantity_on_hand=0
--      → NO item_stock_levels row exists for it (and trivially Σ = on_hand = 0).
--   4. Fix 3 (tenant-isolation): org-A item with primary_location_id = an org-B
--      rack location → the seeded level is NOT at the org-B location; it falls
--      through to org-A's warehouse/Unplaced instead. Σ = on_hand = 9.
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(11);

-- ── Stable UUIDs — namespace 0xcc99xx (distinct from all other test files) ─────
\set org    '\'cc9900aa-0000-0000-0000-000000000001\''
\set usr    '\'cc9900aa-0000-0000-0000-000000000002\''
\set wh     '\'cc9900aa-0000-0000-0000-000000000003\''
\set rack   '\'cc9900aa-0000-0000-0000-000000000004\''
\set item1  '\'cc9900aa-0000-0000-0000-000000000005\''
\set item2  '\'cc9900aa-0000-0000-0000-000000000006\''
\set item3  '\'cc9900aa-0000-0000-0000-000000000007\''
\set org_b  '\'cc9900aa-0000-0000-0000-000000000008\''
\set wh_b   '\'cc9900aa-0000-0000-0000-000000000009\''
\set rack_b '\'cc9900aa-0000-0000-0000-00000000000a\''
\set item4  '\'cc9900aa-0000-0000-0000-00000000000b\''

-- ── Fixtures (run as superuser) ──────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'seed-level-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Seed Level Test Org', 'seed-level-test-0199')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;

-- Warehouse — the 0188 trigger auto-creates Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Seed Level WH', 'WH-SL99', 'active')
  on conflict (id) do nothing;

-- A rack location inside the warehouse (kind='rack', NOT staging or unplaced).
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'R1-SL99', 'bin', 'rack')
  on conflict (id) do nothing;

-- ── CASE 1: item with quantity_on_hand=12, primary_location_id = the rack ────────
-- The trigger must seed the RACK level = 12.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type,
   primary_location_id)
  values (:item1, :org, :wh, 'SL99-CASE1', 'Seed Level Item 1', 12, 'active', 'none', :rack)
  on conflict (id) do nothing;

-- 1a. rack item_stock_levels row = 12.
select is(
  (select quantity from public.item_stock_levels
     where item_id    = 'cc9900aa-0000-0000-0000-000000000005'::uuid
       and location_id = 'cc9900aa-0000-0000-0000-000000000004'::uuid),
  12::numeric,
  'Case 1: rack item_stock_levels level seeded = 12');

-- 1b. Σ item_stock_levels = quantity_on_hand = 12.
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc9900aa-0000-0000-0000-000000000005'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc9900aa-0000-0000-0000-000000000005'::uuid),
  'Case 1: Sigma(item_stock_levels) = quantity_on_hand = 12');

-- ── CASE 2: item with quantity_on_hand=5, primary_location_id = null, warehouse set ─
-- The trigger must seed the warehouse UNPLACED level = 5; Staging must be absent/0.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item2, :org, :wh, 'SL99-CASE2', 'Seed Level Item 2', 5, 'active', 'none')
  on conflict (id) do nothing;

-- 2a. Warehouse Unplaced level = 5.
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'cc9900aa-0000-0000-0000-000000000006'::uuid
      and l.warehouse_id = 'cc9900aa-0000-0000-0000-000000000003'::uuid
      and l.kind = 'unplaced'
      and l.deleted_at is null
    limit 1),
  5::numeric,
  'Case 2: warehouse Unplaced level seeded = 5');

-- 2b. Σ item_stock_levels = quantity_on_hand = 5.
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc9900aa-0000-0000-0000-000000000006'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc9900aa-0000-0000-0000-000000000006'::uuid),
  'Case 2: Sigma(item_stock_levels) = quantity_on_hand = 5');

-- 2c. Staging level is absent (0) — initial stock must NOT land in Staging.
select is(
  coalesce(
    (select isl.quantity
       from public.item_stock_levels isl
       join public.locations l on l.id = isl.location_id
      where isl.item_id = 'cc9900aa-0000-0000-0000-000000000006'::uuid
        and l.warehouse_id = 'cc9900aa-0000-0000-0000-000000000003'::uuid
        and l.kind = 'staging'
        and l.deleted_at is null
      limit 1),
    0::numeric),
  0::numeric,
  'Case 2: Staging level is 0 (initial stock does not land in Staging)');

-- ── CASE 3: item with quantity_on_hand=0 — no row must be created ─────────────────
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item3, :org, :wh, 'SL99-CASE3', 'Seed Level Item 3', 0, 'active', 'none')
  on conflict (id) do nothing;

-- 3a. No item_stock_levels row exists for this item.
select is(
  (select count(*)::int from public.item_stock_levels
    where item_id = 'cc9900aa-0000-0000-0000-000000000007'::uuid),
  0,
  'Case 3: quantity_on_hand=0 -> no item_stock_levels row created');

-- 3b. Σ = 0 = quantity_on_hand (trivially holds; belt-and-suspenders check).
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc9900aa-0000-0000-0000-000000000007'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc9900aa-0000-0000-0000-000000000007'::uuid),
  'Case 3: Sigma(item_stock_levels) = quantity_on_hand = 0');

-- ── CASE 4: Fix 3 — tenant-isolation: org-A item with primary_location_id pointing
-- at an org-B rack must NOT seed a level at that org-B location. Without the org-
-- scope guard the SECURITY DEFINER trigger would seed stock across tenants.
-- With the fix the location lookup finds no row (wrong org) and falls through to
-- org-A's warehouse Unplaced bucket instead.
-- ────────────────────────────────────────────────────────────────────────────────

-- Org B + its warehouse + a rack location inside it.
insert into public.organizations (id, name, slug)
  values (:org_b, 'Other Org B', 'other-org-b-0199')
  on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh_b, :org_b, 'Org B WH', 'WH-ORGB', 'active')
  on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack_b, :org_b, :wh_b, 'OrgB-Rack1', 'bin', 'rack')
  on conflict (id) do nothing;

-- Org-A item with quantity_on_hand=9 and primary_location_id pointing at the
-- org-B rack. The trigger must reject this (cross-tenant) and fall through to
-- org-A's warehouse Unplaced instead.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, primary_location_id)
  values (:item4, :org, :wh, 'SL99-CASE4', 'Cross-Tenant Seed Item', 9,
          'active', 'none', :rack_b)
  on conflict (id) do nothing;

-- 4a. Σ item_stock_levels = on_hand = 9 for the org-A item.
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc9900aa-0000-0000-0000-00000000000b'::uuid),
  9::numeric,
  'Case 4: Sigma(item_stock_levels) = on_hand = 9 for org-A item'
);

-- 4b. No item_stock_levels row references the org-B rack for the org-A item.
select ok(
  not exists(
    select 1 from public.item_stock_levels
     where item_id     = 'cc9900aa-0000-0000-0000-00000000000b'::uuid
       and location_id = 'cc9900aa-0000-0000-0000-00000000000a'::uuid
  ),
  'Case 4: no item_stock_levels row at the org-B location for the org-A item'
);

-- 4c. The stock landed in org-A's warehouse Unplaced (not the org-B rack).
select ok(
  exists(
    select 1
      from public.item_stock_levels isl
      join public.locations l on l.id = isl.location_id
     where isl.item_id      = 'cc9900aa-0000-0000-0000-00000000000b'::uuid
       and l.organization_id = 'cc9900aa-0000-0000-0000-000000000001'::uuid
       and l.warehouse_id    = 'cc9900aa-0000-0000-0000-000000000003'::uuid
       and l.kind            = 'unplaced'
       and l.deleted_at      is null
       and isl.quantity      = 9
  ),
  'Case 4: org-A item stock (9) landed in org-A warehouse Unplaced, not org-B rack'
);

-- 4d. Σ item_stock_levels for the org-A item equals quantity_on_hand = 9 (invariant).
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc9900aa-0000-0000-0000-00000000000b'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc9900aa-0000-0000-0000-00000000000b'::uuid),
  'Case 4: Sigma(item_stock_levels) = quantity_on_hand invariant holds after cross-tenant guard'
);

select * from finish();
rollback;
