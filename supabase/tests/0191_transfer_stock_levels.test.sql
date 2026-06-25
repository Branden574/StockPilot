-- supabase/tests/0191_transfer_stock_levels.test.sql
-- End-to-end pgTAP proof that transfer_stock performs a real two-table move
-- after migration 0191.
--
-- Seeds: org + auth user + org_member (manager) + warehouse (which triggers
-- Staging/Unplaced location creation) + two bin locations + item with
-- warehouse_id (required by RLS user_can_access_inventory) at quantity_on_hand=10
-- + source item_stock_levels row of 10.
-- Calls transfer_stock(item, from, to, 4).
-- Asserts:
--   1. source level decremented by 4 (now 6)
--   2. destination level incremented by 4 (now 4)
--   3. quantity_on_hand unchanged (net-zero; still 10)
--   4. transferring MORE than the source holds raises insufficient_stock (P0001)
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(4);

\set org  '\'ff910000-0000-0000-0000-000000000001\''
\set usr  '\'ff910000-0000-0000-0000-000000000002\''
\set wh   '\'ff910000-0000-0000-0000-000000000003\''
\set item '\'ff910000-0000-0000-0000-000000000004\''
\set loc1 '\'ff910000-0000-0000-0000-000000000005\''
\set loc2 '\'ff910000-0000-0000-0000-000000000006\''

-- ── Fixtures (seeded as superuser before role switch) ─────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'tx-staff@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Transfer Test Org', 'transfer-test-org-0191') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

-- Warehouse — also triggers Staging + Unplaced location creation via 0188 trigger.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Transfer Test WH', 'WH-TX', 'active') on conflict (id) do nothing;

-- Two regular bin locations within the warehouse.
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values
    (:loc1, :org, :wh, 'L-from', 'bin'),
    (:loc2, :org, :wh, 'L-to',   'bin')
  on conflict (id) do nothing;

-- Item must have warehouse_id so user_can_access_inventory RLS passes.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'TX-0191', 'Transfer Item', 10, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; clear it so we can place all stock in loc1.
delete from public.item_stock_levels where item_id = :item;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item, :loc1, 10)
  on conflict (item_id, location_id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────────
set local "request.jwt.claim.sub" to 'ff910000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Call transfer_stock ───────────────────────────────────────────────────────
do $$
begin
  perform public.transfer_stock(
    'ff910000-0000-0000-0000-000000000004'::uuid,  -- p_item_id
    'ff910000-0000-0000-0000-000000000005'::uuid,  -- p_from_location_id
    'ff910000-0000-0000-0000-000000000006'::uuid,  -- p_to_location_id
    4,                                              -- p_quantity
    'pgtap'                                         -- p_notes
  );
end$$;

-- ── Assertions ────────────────────────────────────────────────────────────────

select is(
  (select quantity from public.item_stock_levels
     where item_id = 'ff910000-0000-0000-0000-000000000004'::uuid
       and location_id = 'ff910000-0000-0000-0000-000000000005'::uuid),
  6::numeric,
  'source level decremented by 4 (10 -> 6)');

select is(
  (select quantity from public.item_stock_levels
     where item_id = 'ff910000-0000-0000-0000-000000000004'::uuid
       and location_id = 'ff910000-0000-0000-0000-000000000006'::uuid),
  4::numeric,
  'destination level incremented by 4 (0 -> 4)');

select is(
  (select quantity_on_hand from public.inventory_items
     where id = 'ff910000-0000-0000-0000-000000000004'::uuid),
  10::numeric,
  'quantity_on_hand unchanged (net-zero transfer)');

-- ── Guard: over-transfer raises insufficient_stock ────────────────────────────
-- Re-assert the authenticated role/jwt so the call clears has_org_role and reaches
-- the insufficient_stock guard (not 'forbidden'). throws_ok runs the call in a
-- savepoint, so the partial decrement is rolled back and prior state is preserved.
-- Source now holds 6 (10 - 4); attempting to move 100 clearly exceeds it.
set local "request.jwt.claim.sub" to 'ff910000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ select public.transfer_stock(
       'ff910000-0000-0000-0000-000000000004'::uuid,
       'ff910000-0000-0000-0000-000000000005'::uuid,
       'ff910000-0000-0000-0000-000000000006'::uuid,
       100) $$,
  'P0001', 'insufficient_stock',
  'transferring more than the source holds raises insufficient_stock');

select * from finish();
rollback;
