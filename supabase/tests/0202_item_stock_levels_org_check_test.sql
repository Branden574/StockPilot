-- supabase/tests/0202_item_stock_levels_org_check_test.sql
-- pgTAP proof that the augmented item_stock_levels_write WITH CHECK (mig 0202)
-- closes the direct-write cross-tenant hole, while same-org paths and the
-- transfer_stock RPC still work.
--
-- Seeds two orgs (A and B), each with a warehouse + two locations (bin + the
-- auto-created Staging/Unplaced from the warehouse trigger).  Item is in org A.
-- Tests:
--   1. Direct cross-tenant INSERT (orgA row, orgB location_id) → 42501
--   2. Same-org direct INSERT (orgA row, orgA location_id)     → lives_ok
--   3. Cross-tenant UPDATE (move existing row's location_id to orgB) → 42501
--   4. transfer_stock(orgA item, orgA loc1 → orgA loc2)        → lives_ok (RPC no-regression)
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(4);

-- ── UUIDs ─────────────────────────────────────────────────────────────────────
\set orgA  '\'ff020200-0000-0000-0000-000000000001\''
\set orgB  '\'ff020200-0000-0000-0000-000000000002\''
\set usr   '\'ff020200-0000-0000-0000-000000000003\''
\set whA   '\'ff020200-0000-0000-0000-000000000004\''
\set whB   '\'ff020200-0000-0000-0000-000000000005\''
\set locA1 '\'ff020200-0000-0000-0000-000000000006\''
\set locA2 '\'ff020200-0000-0000-0000-000000000007\''
\set locB1 '\'ff020200-0000-0000-0000-000000000008\''
\set itemA '\'ff020200-0000-0000-0000-000000000009\''
\set levelA '\'ff020200-0000-0000-0000-00000000000a\''

-- ── Fixtures (seeded as superuser) ────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'loc-rls-test@test.local', '{}'::jsonb) on conflict (id) do nothing;

-- Org A
insert into public.organizations (id, name, slug)
  values (:orgA, 'Loc RLS Test Org A', 'loc-rls-test-org-a-0202') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :usr, 'manager', now()) on conflict do nothing;

-- Org B (user is NOT a member — cross-tenant scenario)
insert into public.organizations (id, name, slug)
  values (:orgB, 'Loc RLS Test Org B', 'loc-rls-test-org-b-0202') on conflict (id) do nothing;

-- Warehouses (trigger auto-creates Staging + Unplaced locations per mig 0188)
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'Loc RLS WH A', 'WH-LRA', 'active') on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:whB, :orgB, 'Loc RLS WH B', 'WH-LRB', 'active') on conflict (id) do nothing;

-- Two bin locations in org A, one in org B
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values
    (:locA1, :orgA, :whA, 'LR-A-Bin-1', 'bin'),
    (:locA2, :orgA, :whA, 'LR-A-Bin-2', 'bin'),
    (:locB1, :orgB, :whB, 'LR-B-Bin-1', 'bin')
  on conflict (id) do nothing;

-- Item A in org A, warehouse A, qty_on_hand = 20
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:itemA, :orgA, :whA, 'LOC-RLS-0202', 'Loc RLS Test Item', 20, 'active', 'none')
  on conflict (id) do nothing;

-- Clear any seed row from the 0199 trigger; seed all 20 units at locA1
delete from public.item_stock_levels where item_id = :itemA;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:orgA, :itemA, :locA1, 20)
  on conflict (item_id, location_id) do nothing;

-- ── Become the org-A manager (auth.uid() + has_org_role + RLS) ───────────────
set local "request.jwt.claim.sub" to 'ff020200-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Test 1: direct cross-tenant INSERT → WITH CHECK must reject 42501 ─────────
-- org_id=orgA, item_id=orgA item, but location_id=orgB → cross-tenant hole
select throws_ok(
  $$ insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
     values (
       'ff020200-0000-0000-0000-000000000001'::uuid,  -- orgA
       'ff020200-0000-0000-0000-000000000009'::uuid,  -- itemA
       'ff020200-0000-0000-0000-000000000008'::uuid,  -- locB1 (foreign org!)
       5
     ) $$,
  '42501', NULL,
  'direct cross-tenant INSERT into item_stock_levels raises WITH CHECK violation (42501)');

-- ── Test 2: same-org direct INSERT → must succeed ─────────────────────────────
set local "request.jwt.claim.sub" to 'ff020200-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
     values (
       'ff020200-0000-0000-0000-000000000001'::uuid,  -- orgA
       'ff020200-0000-0000-0000-000000000009'::uuid,  -- itemA
       'ff020200-0000-0000-0000-000000000007'::uuid,  -- locA2 (same org)
       3
     )
     on conflict (item_id, location_id) do update
       set quantity = public.item_stock_levels.quantity + excluded.quantity $$,
  'same-org direct INSERT into item_stock_levels lives (no exception)');

-- ── Test 3: cross-tenant UPDATE (move row's location_id to foreign org) → 42501
set local "request.jwt.claim.sub" to 'ff020200-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ update public.item_stock_levels
        set location_id = 'ff020200-0000-0000-0000-000000000008'::uuid  -- locB1 (foreign org!)
      where item_id = 'ff020200-0000-0000-0000-000000000009'::uuid       -- itemA
        and location_id = 'ff020200-0000-0000-0000-000000000006'::uuid   -- locA1
  $$,
  '42501', NULL,
  'UPDATE moving location_id to a foreign-org location raises WITH CHECK violation (42501)');

-- ── Test 4: transfer_stock RPC (same org) → lives_ok (no regression) ──────────
set local "request.jwt.claim.sub" to 'ff020200-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ select public.transfer_stock(
       'ff020200-0000-0000-0000-000000000009'::uuid,  -- itemA
       'ff020200-0000-0000-0000-000000000006'::uuid,  -- locA1 (source)
       'ff020200-0000-0000-0000-000000000007'::uuid,  -- locA2 (dest, same org)
       5) $$,
  'same-org transfer_stock RPC still works after 0202 WITH CHECK augmentation');

select * from finish();
rollback;
