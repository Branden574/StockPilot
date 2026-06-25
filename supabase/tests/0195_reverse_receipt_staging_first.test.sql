-- supabase/tests/0195_reverse_receipt_staging_first.test.sql
-- Proves that reverse_receipt drains Staging-first then placed (mig 0195).
--
-- Case A (regression): receive 5 → Staging; reverse → on_hand=0, Σlevels=0.
--   This is the same case that 0193 handled; must still pass.
--
-- Case B (the staging_first proof): receive 5; transfer_stock(Staging → rack, 3);
--   now Staging=2, rack=3, on_hand=5. Call reverse_receipt; assert on_hand=0 AND
--   Σlevels=0. staging_first drains the 2 staged first, then the 3 from the rack.
--   With the OLD 0193 explicit-Staging logic this would go negative on Staging
--   (tried to remove 5 from a location holding only 2). With 'placed' mode (no
--   staging_first) it would skip Staging entirely → phantom staged stock remains.
--
-- Reuses the 0190/0193 receive fixture pattern.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(4);

\set org      '\'aa950000-0000-0000-0000-000000000001\''
\set mgr      '\'bb950000-0000-0000-0000-000000000001\''
\set wh       '\'cc950000-0000-0000-0000-000000000001\''
\set item_a   '\'dd950000-0000-0000-0000-000000000001\''
\set item_b   '\'dd950000-0000-0000-0000-000000000002\''
\set po_a     '\'ee950000-0000-0000-0000-000000000001\''
\set po_b     '\'ee950000-0000-0000-0000-000000000002\''
\set poline_a '\'ff950000-0000-0000-0000-000000000001\''
\set poline_b '\'ff950000-0000-0000-0000-000000000002\''
\set rack_loc '\'11950000-0000-0000-0000-000000000001\''

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, 'stg-first-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'SF Test Org', 'sf-test-org-0195') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;

-- Warehouse — the trigger auto-creates Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'SF Test WH', 'WH-SF', 'active') on conflict (id) do nothing;

-- Rack location for Case B placement. type must be one of the enum values
-- (warehouse/room/shelf/bin/vehicle/jobsite/other); kind='rack' is the placement kind.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack_loc, :org, :wh, 'Rack A-1', 'other', 'rack') on conflict (id) do nothing;

-- Item A: Case A (still staged).
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values (:item_a, :org, :wh, 'SF Widget A', 'SKU-SFA', 0, 'active', 'none')
  on conflict (id) do nothing;

-- Item B: Case B (placed out of Staging).
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values (:item_b, :org, :wh, 'SF Widget B', 'SKU-SFB', 0, 'active', 'none')
  on conflict (id) do nothing;

-- PO A for Case A.
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po_a, :org, 'SF-PO-A', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:poline_a, :org, :po_a, :item_a, 10, 0, 5)
  on conflict (id) do nothing;

-- PO B for Case B.
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po_b, :org, 'SF-PO-B', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:poline_b, :org, :po_b, :item_b, 10, 0, 5)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────
set local "request.jwt.claim.sub" to 'bb950000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Case A: receive 5 → Staging; reverse; assert on_hand=0 AND Σlevels=0 ──
do $$
declare
  v_receipt public.receipts;
begin
  select * into v_receipt from public.post_receipt_v2(
    'ee950000-0000-0000-0000-000000000001'::uuid,   -- p_purchase_order_id
    'cc950000-0000-0000-0000-000000000001'::uuid,   -- p_warehouse_id
    jsonb_build_array(jsonb_build_object(
      'po_line_id',   'ff950000-0000-0000-0000-000000000001',
      'qty_received', 5,
      'qty_accepted', 5,
      'qty_rejected', 0,
      'unit_cost',    5
    )),
    'idem-key-0195-case-a',
    'hash-0195-case-a',
    null
  );
  perform public.reverse_receipt(v_receipt.id, 'test case A');
end$$;

select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'dd950000-0000-0000-0000-000000000001'::uuid),
  0::numeric,
  'Case A: quantity_on_hand is 0 after receive→reverse (still staged)'
);

select is(
  (select coalesce(sum(isl.quantity), 0)
     from public.item_stock_levels isl
    where isl.item_id = 'dd950000-0000-0000-0000-000000000001'::uuid),
  0::numeric,
  'Case A: Σitem_stock_levels is 0 after receive→reverse (Staging drained)'
);

-- ── Case B: receive 5; place 3 onto rack; reverse; assert on_hand=0, Σlevels=0 ─
-- After receive: Staging=5, rack=0, on_hand=5.
-- After transfer_stock(Staging→rack, 3): Staging=2, rack=3, on_hand=5.
-- After reverse_receipt: staging_first drains Staging(2) first, then rack(3) → both=0.
do $$
declare
  v_receipt  public.receipts;
  v_staging  uuid;
begin
  -- Receive 5 into Staging.
  select * into v_receipt from public.post_receipt_v2(
    'ee950000-0000-0000-0000-000000000002'::uuid,   -- p_purchase_order_id
    'cc950000-0000-0000-0000-000000000001'::uuid,   -- p_warehouse_id
    jsonb_build_array(jsonb_build_object(
      'po_line_id',   'ff950000-0000-0000-0000-000000000002',
      'qty_received', 5,
      'qty_accepted', 5,
      'qty_rejected', 0,
      'unit_cost',    5
    )),
    'idem-key-0195-case-b',
    'hash-0195-case-b',
    null
  );

  -- Resolve the Staging location for this warehouse.
  select id into v_staging from public.locations
    where warehouse_id = 'cc950000-0000-0000-0000-000000000001'::uuid
      and kind = 'staging' and deleted_at is null
    limit 1;

  -- Place 3 of the 5 onto the rack (Staging→rack).
  perform public.transfer_stock(
    'dd950000-0000-0000-0000-000000000002'::uuid,  -- item
    v_staging,                                      -- from: Staging
    '11950000-0000-0000-0000-000000000001'::uuid,  -- to: rack
    3                                               -- qty
  );
  -- Now: Staging=2, rack=3, on_hand=5.

  -- Reverse the receipt — staging_first should drain Staging(2) then rack(3).
  perform public.reverse_receipt(v_receipt.id, 'test case B');
end$$;

select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'dd950000-0000-0000-0000-000000000002'::uuid),
  0::numeric,
  'Case B: quantity_on_hand is 0 after receive→place→reverse (staging_first)'
);

select is(
  (select coalesce(sum(isl.quantity), 0)
     from public.item_stock_levels isl
    where isl.item_id = 'dd950000-0000-0000-0000-000000000002'::uuid),
  0::numeric,
  'Case B: Σitem_stock_levels is 0 after receive→place→reverse (staging_first drains all levels)'
);

select * from finish();
rollback;
