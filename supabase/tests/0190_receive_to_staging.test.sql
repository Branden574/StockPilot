-- supabase/tests/0190_receive_to_staging.test.sql
-- End-to-end pgTAP proof that post_receipt_v2 routes accepted qty into the
-- warehouse Staging location after migration 0190.
--
-- Seeds a minimal org/warehouse/item/PO/po-line fixture (same pattern as
-- 0183_receipt_reversal.test.sql), calls post_receipt_v2, and asserts:
--   1. item_stock_levels.quantity = accepted qty for the staging location
--   2. inventory_items.quantity_on_hand rose by the accepted qty
--   3. stock_movements row with movement_type='receive_po' carries the
--      staging to_location_id (non-null, matching the location id)
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(3);

\set org      '\'aa900000-0000-0000-0000-000000000001\''
\set mgr      '\'bb900000-0000-0000-0000-000000000001\''
\set wh       '\'cc900000-0000-0000-0000-000000000001\''
\set item1    '\'dd900000-0000-0000-0000-000000000001\''
\set po1      '\'ee900000-0000-0000-0000-000000000001\''
\set poline1  '\'ff900000-0000-0000-0000-000000000001\''

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, 'stg-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Staging Test Org', 'staging-test-org-0190') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;

-- Insert warehouse — the trigger will auto-create Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Staging Test WH', 'WH-STG', 'active') on conflict (id) do nothing;

-- Untracked item (no lot/serial) starting at quantity_on_hand = 0.
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values (:item1, :org, :wh, 'Staging Widget', 'SKU-STG1', 0, 'active', 'none')
  on conflict (id) do nothing;

-- PO in 'ordered' status (receipt-eligible).
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po1, :org, 'STG-PO-1', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:poline1, :org, :po1, :item1, 10, 0, 5)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────
set local "request.jwt.claim.sub" to 'bb900000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Call post_receipt_v2 with qty_accepted = 5 ───────────────────────────
do $$
begin
  perform public.post_receipt_v2(
    'ee900000-0000-0000-0000-000000000001'::uuid,  -- p_purchase_order_id
    'cc900000-0000-0000-0000-000000000001'::uuid,  -- p_warehouse_id
    jsonb_build_array(jsonb_build_object(
      'po_line_id',    'ff900000-0000-0000-0000-000000000001',
      'qty_received',  5,
      'qty_accepted',  5,
      'qty_rejected',  0,
      'unit_cost',     5
    )),
    'idem-key-0190-test',   -- p_idempotency_key
    'hash-0190-test',       -- p_request_hash
    null                    -- p_notes
  );
end$$;

-- ── Assertions ───────────────────────────────────────────────────────────

-- 1. item_stock_levels for this item's staging location = 5
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'dd900000-0000-0000-0000-000000000001'::uuid
      and l.warehouse_id = 'cc900000-0000-0000-0000-000000000001'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  5::numeric,
  'accepted qty (5) landed in item_stock_levels for the staging location'
);

-- 2. inventory_items.quantity_on_hand rose from 0 to 5
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'dd900000-0000-0000-0000-000000000001'::uuid),
  5::numeric,
  'quantity_on_hand rose by 5 after receiving'
);

-- 3. stock_movements receive_po row carries the staging to_location_id (not null)
select ok(
  exists (
    select 1
      from public.stock_movements sm
      join public.locations l on l.id = sm.to_location_id
     where sm.item_id     = 'dd900000-0000-0000-0000-000000000001'::uuid
       and sm.movement_type = 'receive_po'
       and l.kind          = 'staging'
       and l.warehouse_id  = 'cc900000-0000-0000-0000-000000000001'::uuid
  ),
  'receive_po stock_movement carries staging to_location_id (not null)'
);

select * from finish();
rollback;
