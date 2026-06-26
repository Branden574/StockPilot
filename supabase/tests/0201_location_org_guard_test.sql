-- supabase/tests/0201_location_org_guard_test.sql
-- pgTAP proof that assert_location_in_org closes the cross-tenant stock-write
-- hole in transfer_stock (0191) and adjust_stock's explicit-location path (0194).
--
-- Seeds two orgs (A and B), each with a warehouse + location + item.
-- Item is in org A with stock at orgA-loc1.
-- Tests:
--   1. transfer_stock(itemA, fromLoc=orgA-loc1, toLoc=orgB-loc1, qty)
--        -> throws_ok SQLSTATE 42501 'location_org_mismatch'
--   2. transfer_stock(itemA, fromLoc=orgA-loc1, toLoc=orgA-loc2, qty)
--        -> lives_ok + net-zero on quantity_on_hand
--   3. adjust_stock(itemA, +10, 'add', p_location_id=orgB-loc1, ...)
--        -> throws_ok SQLSTATE 42501 'location_org_mismatch'
--   4. adjust_stock(itemA, +5,  'add', p_location_id=orgA-loc1, ...)
--        -> lives_ok (same-org explicit location succeeds)
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(4);

-- ── UUIDs ─────────────────────────────────────────────────────────────────────
\set orgA  '\'ff200100-0000-0000-0000-000000000001\''
\set orgB  '\'ff200100-0000-0000-0000-000000000002\''
\set usr   '\'ff200100-0000-0000-0000-000000000003\''
\set whA   '\'ff200100-0000-0000-0000-000000000004\''
\set whB   '\'ff200100-0000-0000-0000-000000000005\''
\set locA1 '\'ff200100-0000-0000-0000-000000000006\''
\set locA2 '\'ff200100-0000-0000-0000-000000000007\''
\set locB1 '\'ff200100-0000-0000-0000-000000000008\''
\set itemA '\'ff200100-0000-0000-0000-000000000009\''

-- ── Fixtures (seeded as superuser) ────────────────────────────────────────────

-- Auth user (member of org A only)
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'guard-test@test.local', '{}'::jsonb) on conflict (id) do nothing;

-- Org A
insert into public.organizations (id, name, slug)
  values (:orgA, 'Guard Test Org A', 'guard-test-org-a-0201') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :usr, 'manager', now()) on conflict do nothing;

-- Org B (user is NOT a member — cross-tenant attacker scenario)
insert into public.organizations (id, name, slug)
  values (:orgB, 'Guard Test Org B', 'guard-test-org-b-0201') on conflict (id) do nothing;

-- Warehouses (trigger auto-creates Staging + Unplaced locations per mig 0188)
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'Guard WH A', 'WH-GA', 'active') on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:whB, :orgB, 'Guard WH B', 'WH-GB', 'active') on conflict (id) do nothing;

-- Two bin locations in org A, one bin location in org B
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values
    (:locA1, :orgA, :whA, 'A-Bin-1', 'bin'),
    (:locA2, :orgA, :whA, 'A-Bin-2', 'bin'),
    (:locB1, :orgB, :whB, 'B-Bin-1', 'bin')
  on conflict (id) do nothing;

-- Item A in org A, warehouse A, qty_on_hand = 20
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:itemA, :orgA, :whA, 'GUARD-0201', 'Guard Test Item', 20, 'active', 'none')
  on conflict (id) do nothing;

-- Clear 0199 trigger seed row; place all 20 units at locA1
delete from public.item_stock_levels where item_id = :itemA;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:orgA, :itemA, :locA1, 20)
  on conflict (item_id, location_id) do nothing;

-- ── Become the org-A manager (auth.uid() + has_org_role + RLS) ───────────────
set local "request.jwt.claim.sub" to 'ff200100-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Test 1: transfer_stock with a foreign-org destination → 42501 ─────────────
select throws_ok(
  $$ select public.transfer_stock(
       'ff200100-0000-0000-0000-000000000009'::uuid,  -- itemA
       'ff200100-0000-0000-0000-000000000006'::uuid,  -- locA1 (own org, valid source)
       'ff200100-0000-0000-0000-000000000008'::uuid,  -- locB1 (foreign org!)
       5) $$,
  '42501', 'location_org_mismatch',
  'transfer_stock to a foreign-org destination raises location_org_mismatch (42501)');

-- ── Test 2: transfer_stock within same org → succeeds + net-zero ──────────────
-- Re-assert authenticated role (throws_ok runs in a savepoint so state persists).
set local "request.jwt.claim.sub" to 'ff200100-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ select public.transfer_stock(
       'ff200100-0000-0000-0000-000000000009'::uuid,  -- itemA
       'ff200100-0000-0000-0000-000000000006'::uuid,  -- locA1 (source)
       'ff200100-0000-0000-0000-000000000007'::uuid,  -- locA2 (dest, same org)
       8) $$,
  'same-org transfer_stock lives (no exception)');

-- Net-zero assertion: quantity_on_hand must be unchanged at 20
-- (Reset to superuser temporarily to read inventory_items without RLS interference,
--  but the call above ran as authenticated — this read is just verification.)
reset role;
do $$
declare v_qoh numeric;
begin
  select quantity_on_hand into v_qoh
    from public.inventory_items
   where id = 'ff200100-0000-0000-0000-000000000009'::uuid;
  if v_qoh <> 20 then
    raise exception 'net-zero violation: quantity_on_hand = % (expected 20)', v_qoh;
  end if;
end$$;
set local "request.jwt.claim.sub" to 'ff200100-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Test 3: adjust_stock with a foreign-org location_id → 42501 ──────────────
select throws_ok(
  $$ select public.adjust_stock(
       'ff200100-0000-0000-0000-000000000009'::uuid,  -- itemA
       10, 'adjust',
       'ff200100-0000-0000-0000-000000000008'::uuid,  -- locB1 (foreign org!)
       'cross-tenant-test', null) $$,
  '42501', 'location_org_mismatch',
  'adjust_stock with a foreign-org location_id raises location_org_mismatch (42501)');

-- ── Test 4: adjust_stock with same-org location_id → succeeds ────────────────
set local "request.jwt.claim.sub" to 'ff200100-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ select public.adjust_stock(
       'ff200100-0000-0000-0000-000000000009'::uuid,  -- itemA
       5, 'adjust',
       'ff200100-0000-0000-0000-000000000006'::uuid,  -- locA1 (same org)
       'same-org-test', null) $$,
  'same-org adjust_stock with explicit location_id lives (no exception)');

select * from finish();
rollback;
