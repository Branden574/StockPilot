-- supabase/tests/0193_reverse_receipt_staging.test.sql
-- Proves that post_receipt_v2 followed by reverse_receipt is symmetric:
-- both quantity_on_hand AND the Staging stock level return to their
-- pre-receive baseline (0). This is the regression that existed BEFORE mig 0193:
-- reverse_receipt called adjust_stock(null location), decrementing quantity_on_hand
-- but leaving item_stock_levels[item, Staging] at N (phantom staged stock).
--
-- Fixture reuses the same seeding pattern as 0190_receive_to_staging.test.sql.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(3);

\set org      '\'aa930000-0000-0000-0000-000000000001\''
\set mgr      '\'bb930000-0000-0000-0000-000000000001\''
\set wh       '\'cc930000-0000-0000-0000-000000000001\''
\set item1    '\'dd930000-0000-0000-0000-000000000001\''
\set po1      '\'ee930000-0000-0000-0000-000000000001\''
\set poline1  '\'ff930000-0000-0000-0000-000000000001\''

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, 'rev-stg-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Reverse Staging Test Org', 'reverse-staging-test-org-0193') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;

-- Insert warehouse — the trigger will auto-create Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Reverse Staging Test WH', 'WH-RSTG', 'active') on conflict (id) do nothing;

-- Untracked item (no lot/serial) starting at quantity_on_hand = 0.
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values (:item1, :org, :wh, 'Reverse Staging Widget', 'SKU-RSTG1', 0, 'active', 'none')
  on conflict (id) do nothing;

-- PO in 'ordered' status (receipt-eligible).
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po1, :org, 'RSTG-PO-1', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:poline1, :org, :po1, :item1, 10, 0, 5)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────
set local "request.jwt.claim.sub" to 'bb930000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Step 1: receive 5 units → stock lands in Staging ─────────────────────
do $$
declare
  v_receipt public.receipts;
begin
  select * into v_receipt from public.post_receipt_v2(
    'ee930000-0000-0000-0000-000000000001'::uuid,  -- p_purchase_order_id
    'cc930000-0000-0000-0000-000000000001'::uuid,  -- p_warehouse_id
    jsonb_build_array(jsonb_build_object(
      'po_line_id',    'ff930000-0000-0000-0000-000000000001',
      'qty_received',  5,
      'qty_accepted',  5,
      'qty_rejected',  0,
      'unit_cost',     5
    )),
    'idem-key-0193-test',   -- p_idempotency_key
    'hash-0193-test',       -- p_request_hash
    null                    -- p_notes
  );

  -- Step 2: reverse the receipt that was just created
  perform public.reverse_receipt(v_receipt.id, 'test reversal');
end$$;

-- ── Assertions: after receive→reverse, everything is back to zero ─────────

-- 1. quantity_on_hand is back to 0 (pre-receive baseline)
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'dd930000-0000-0000-0000-000000000001'::uuid),
  0::numeric,
  'quantity_on_hand is back to 0 after receive→reverse'
);

-- 2. Σ item_stock_levels for this item across ALL locations is 0 (Staging level
--    was NOT decremented before mig 0193 — this is the assertion that proved the bug).
select is(
  (select coalesce(sum(isl.quantity), 0)
     from public.item_stock_levels isl
    where isl.item_id = 'dd930000-0000-0000-0000-000000000001'::uuid),
  0::numeric,
  'sum(item_stock_levels.quantity) is 0 after receive→reverse (no phantom staged stock)'
);

-- 3. A stock_movement row with movement_type='correction' and a negative
--    quantity_change exists for the reversal. (mig 0195 uses staging_first /
--    null-location so from_location_id is null in the movement row; we just
--    confirm the correction movement was written for the right item.)
select ok(
  exists (
    select 1
      from public.stock_movements sm
     where sm.item_id       = 'dd930000-0000-0000-0000-000000000001'::uuid
       and sm.movement_type = 'correction'
       and sm.quantity_change < 0
  ),
  'reversal stock_movement with movement_type=correction and negative qty exists'
);

select * from finish();
rollback;
