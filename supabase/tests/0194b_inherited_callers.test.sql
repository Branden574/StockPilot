-- supabase/tests/0194b_inherited_callers.test.sql
-- pgTAP proof that the order-flow RPCs (complete_picking, cancel_order_request)
-- inherit per-location allocation from mig 0194's adjust_stock rewrite.
--
-- Three scenarios:
--   1. complete_picking draws from PLACED: rack level drops; Σ = on_hand.
--   2. complete_picking raises insufficient_placed_stock (P0001) when stock
--      is ONLY in Staging (no placed locations hold any quantity).
--   3. cancel_order_request restores into Staging; Σ = on_hand restored.
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(9);

-- ── Stable UUIDs (prefix 0194b to avoid collisions with 0194 test) ────────────
\set org   '\'b194b000-0000-0000-0000-000000000001\''
\set usr   '\'b194b000-0000-0000-0000-000000000002\''
\set wh    '\'b194b000-0000-0000-0000-000000000003\''

-- Scenario 1 + 3: item with stock placed in a rack
\set item_placed '\'b194b000-0000-0000-0000-000000000004\''
\set rack        '\'b194b000-0000-0000-0000-000000000005\''
\set ord_pick    '\'b194b000-0000-0000-0000-000000000006\''
\set line_pick   '\'b194b000-0000-0000-0000-000000000007\''

-- Scenario 2: item whose stock is ONLY in Staging
\set item_staged '\'b194b000-0000-0000-0000-000000000008\''
\set ord_staged  '\'b194b000-0000-0000-0000-000000000009\''
\set line_staged '\'b194b000-0000-0000-0000-000000000010\''

-- ── Fixtures (run as superuser before role switch) ─────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'inh-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Inherited Callers Test Org', 'inherited-callers-test-0194b')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;

-- Warehouse — trigger auto-creates Staging + Unplaced (mig 0188).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'ICT Warehouse', 'WH-ICT', 'active')
  on conflict (id) do nothing;

-- Rack location for placed stock (kind='rack', not 'staging').
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'ICT-R1', 'shelf', 'rack')
  on conflict (id) do nothing;

-- ── SCENARIO 1 + 3 ITEM: 10 units, all placed in the rack ─────────────────────
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item_placed, :org, :wh, 'ICT-PLACED', 'Placed Item', 10, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; clear it so all stock sits in the rack only.
delete from public.item_stock_levels where item_id = :item_placed;

-- Seed rack level = 10 (entire on-hand is placed).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item_placed, :rack, 10)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

-- Order in pick_slip_generated status (INSERT bypass: trigger only fires on UPDATE).
-- fulfillment_type='pickup' avoids order_requests_delivery_target_chk (0110).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values (:ord_pick, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup')
  on conflict (id) do nothing;

-- Line: request 3 units; quantity_picked=NULL → manager one-click path in complete_picking.
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked, returned_quantity)
  values (:line_pick, :ord_pick, :item_placed, 3, 0, null, 0)
  on conflict (id) do nothing;

-- ── SCENARIO 2 ITEM: 5 units on_hand, ALL in Staging, zero in placed locations ─
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item_staged, :org, :wh, 'ICT-STAGED', 'Staging-Only Item', 5, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; clear it, then place all stock into Staging.
delete from public.item_stock_levels where item_id = :item_staged;

-- Seed the Staging level only (no rack level → zero placed stock).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item_staged, l.id, 5
    from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null
   limit 1
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values (:ord_staged, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup')
  on conflict (id) do nothing;

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked, returned_quantity)
  values (:line_staged, :ord_staged, :item_staged, 3, 0, null, 0)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ──────────────────────
set local "request.jwt.claim.sub" to 'b194b000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════════
-- SCENARIO 1: complete_picking draws from PLACED
-- Expected: rack level 10 → 7, quantity_on_hand 10 → 7, Σ = 7
-- ════════════════════════════════════════════════════════════════════════════════

do $$
begin
  perform public.complete_picking('b194b000-0000-0000-0000-000000000006'::uuid);
end$$;

-- 1a. Rack level decremented by 3 (10 → 7).
select is(
  (select quantity from public.item_stock_levels
    where item_id    = 'b194b000-0000-0000-0000-000000000004'::uuid
      and location_id = 'b194b000-0000-0000-0000-000000000005'::uuid),
  7::numeric,
  'S1: complete_picking decremented placed rack level (10 → 7)');

-- 1b. quantity_on_hand = 7.
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'b194b000-0000-0000-0000-000000000004'::uuid),
  7::numeric,
  'S1: quantity_on_hand decremented (10 → 7)');

-- 1c. Σ item_stock_levels = live quantity_on_hand (Phase 2a core invariant).
--     Compare dynamically so a wrong on_hand can't slip past a matching literal.
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'b194b000-0000-0000-0000-000000000004'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'b194b000-0000-0000-0000-000000000004'::uuid),
  'S1: Σ item_stock_levels = quantity_on_hand');

-- 1d. Order status flipped to picking_complete.
select is(
  (select status from public.order_requests
    where id = 'b194b000-0000-0000-0000-000000000006'::uuid),
  'picking_complete',
  'S1: order status = picking_complete after complete_picking');

-- ════════════════════════════════════════════════════════════════════════════════
-- SCENARIO 2: complete_picking raises insufficient_placed_stock for staging-only item.
-- The item has on_hand=5 and the line requests 3, so adjust_stock's on-hand guard
-- (5 - 3 = 2 >= 0) passes; apply_level_delta('placed') then finds zero placed-location
-- stock (everything is in Staging) and raises P0001 with the natural on-hand — no boost.
-- ════════════════════════════════════════════════════════════════════════════════

select throws_ok(
  $$ select public.complete_picking('b194b000-0000-0000-0000-000000000009'::uuid) $$,
  'P0001',
  'insufficient_placed_stock',
  'S2: complete_picking raises insufficient_placed_stock for staging-only item');

-- ════════════════════════════════════════════════════════════════════════════════
-- SCENARIO 3: cancel_order_request restores into Staging.
-- Uses the ord_pick order (now at picking_complete, on_hand=7, rack=7).
-- After cancel: on_hand → 10, Staging += 3, rack stays 7, Σ = 10.
-- (picking_complete → cancelled is a valid transition per 0120.)
-- ════════════════════════════════════════════════════════════════════════════════

do $$
begin
  perform public.cancel_order_request(
    'b194b000-0000-0000-0000-000000000006'::uuid,
    'pgtap cancel test'
  );
end$$;

-- 3a. Order status = cancelled.
select is(
  (select status from public.order_requests
    where id = 'b194b000-0000-0000-0000-000000000006'::uuid),
  'cancelled',
  'S3: order status = cancelled after cancel_order_request');

-- 3b. Restored qty landed in the warehouse Staging level(s). Sum across all
--     staging rows for the item → deterministic without an ORDER BY/LIMIT.
select is(
  (select coalesce(sum(isl.quantity), 0)
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'b194b000-0000-0000-0000-000000000004'::uuid
      and l.warehouse_id = 'b194b000-0000-0000-0000-000000000003'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null),
  3::numeric,
  'S3: cancel_order_request restored 3 units into Staging');

-- 3c. quantity_on_hand restored (7 + 3 = 10).
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'b194b000-0000-0000-0000-000000000004'::uuid),
  10::numeric,
  'S3: quantity_on_hand restored (7 → 10)');

-- 3d. Σ item_stock_levels = live quantity_on_hand (Phase 2a core invariant).
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'b194b000-0000-0000-0000-000000000004'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'b194b000-0000-0000-0000-000000000004'::uuid),
  'S3: Σ item_stock_levels = quantity_on_hand');

select * from finish();
rollback;
