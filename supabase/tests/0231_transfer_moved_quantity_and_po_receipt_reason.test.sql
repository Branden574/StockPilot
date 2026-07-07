-- supabase/tests/0231_transfer_moved_quantity_and_po_receipt_reason.test.sql
-- Proves migration 0231: transfer moved_quantity + PO-number receipt reason.
--
--   • stock_movements.moved_quantity exists, is nullable numeric with NO default
--     (old rows stay null — displays must show no number, never 0),
--   • transfer_stock records moved_quantity = p_quantity on its ledger row while
--     quantity_change stays EXACTLY 0 (net-zero invariant: ledger rows sum to
--     quantity_on_hand; 0230 snapshots depend on it) and the two-table move
--     still happens (source -N, destination +N, on-hand unchanged),
--   • transfer_stock grants unchanged: authenticated still holds EXECUTE,
--   • post_receipt_v2 writes reason = 'PO ' || po_number on the receive_po
--     movement (was the internal 'receipt_line' label) while notes STILL carries
--     the receipt id — InventoryService.stagedWorklist consumes notes to resolve
--     the source receipt and must keep working,
--   • post_receipt_v2 grants unchanged: authenticated still holds EXECUTE.
--
-- Namespace: ac023100. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(14);

\set org      '\'ac023100-0000-0000-0000-000000000001\''
\set usr      '\'ac023100-0000-0000-0000-000000000002\''
\set wh       '\'ac023100-0000-0000-0000-000000000003\''
\set item     '\'ac023100-0000-0000-0000-000000000004\''
\set loc1     '\'ac023100-0000-0000-0000-000000000005\''
\set loc2     '\'ac023100-0000-0000-0000-000000000006\''
\set item2    '\'ac023100-0000-0000-0000-000000000007\''
\set po1      '\'ac023100-0000-0000-0000-000000000008\''
\set poline1  '\'ac023100-0000-0000-0000-000000000009\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'mgr-0231@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Moved Qty Org 0231', 'moved-qty-org-0231') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

-- Warehouse — trigger auto-creates Staging + Unplaced locations (0188).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Moved Qty WH', 'WH-MQ-0231', 'active') on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type)
  values
    (:loc1, :org, :wh, 'MQ-from', 'bin'),
    (:loc2, :org, :wh, 'MQ-to',   'bin')
  on conflict (id) do nothing;

-- Transfer item: 10 on hand, all placed in loc1.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'MQ-0231', 'Moved Qty Item', 10, 'active', 'none')
  on conflict (id) do nothing;

delete from public.item_stock_levels where item_id = :item;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item, :loc1, 10)
  on conflict (item_id, location_id) do nothing;

-- Receipt item + receivable PO with a line of 10 @ cost 5.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item2, :org, :wh, 'MQ-0231-R', 'Receipt Item', 0, 'active', 'none')
  on conflict (id) do nothing;

insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po1, :org, 'PO-0231-77', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:poline1, :org, :po1, :item2, 10, 0, 5)
  on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-3. Column: moved_quantity exists, numeric, nullable (no default).
-- ─────────────────────────────────────────────────────────────────────────────

select has_column('public', 'stock_movements', 'moved_quantity',
  'stock_movements.moved_quantity exists');

select col_type_is('public', 'stock_movements', 'moved_quantity', 'numeric',
  'moved_quantity is numeric');

select col_is_null('public', 'stock_movements', 'moved_quantity',
  'moved_quantity is nullable (old rows stay null — display shows no number)');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-5. Grants unchanged on both functions.
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  has_function_privilege('authenticated',
    'public.transfer_stock(uuid, uuid, uuid, numeric, text)', 'EXECUTE'),
  'authenticated can EXECUTE transfer_stock (grant unchanged)');

select ok(
  has_function_privilege('authenticated',
    'public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)', 'EXECUTE'),
  'authenticated can EXECUTE post_receipt_v2 (grant unchanged)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Become the manager (auth.uid() + has_org_role + RLS) and exercise both RPCs.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'ac023100-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

do $$
begin
  perform public.transfer_stock(
    'ac023100-0000-0000-0000-000000000004'::uuid,  -- p_item_id
    'ac023100-0000-0000-0000-000000000005'::uuid,  -- p_from_location_id
    'ac023100-0000-0000-0000-000000000006'::uuid,  -- p_to_location_id
    4,                                              -- p_quantity
    'pgtap-0231'                                    -- p_notes
  );
end$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6-10. transfer_stock: moved_quantity recorded, quantity_change still 0,
--       two-table move intact, on-hand unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select moved_quantity from public.stock_movements
    where item_id = 'ac023100-0000-0000-0000-000000000004'::uuid
      and movement_type = 'transfer'
    order by created_at desc limit 1),
  4::numeric,
  'transfer ledger row records moved_quantity = p_quantity (4)');

select is(
  (select quantity_change from public.stock_movements
    where item_id = 'ac023100-0000-0000-0000-000000000004'::uuid
      and movement_type = 'transfer'
    order by created_at desc limit 1),
  0::numeric,
  'transfer ledger row keeps quantity_change EXACTLY 0 (net-zero invariant)');

select is(
  (select quantity from public.item_stock_levels
    where item_id = 'ac023100-0000-0000-0000-000000000004'::uuid
      and location_id = 'ac023100-0000-0000-0000-000000000005'::uuid),
  6::numeric,
  'source level decremented by 4 (10 -> 6)');

select is(
  (select quantity from public.item_stock_levels
    where item_id = 'ac023100-0000-0000-0000-000000000004'::uuid
      and location_id = 'ac023100-0000-0000-0000-000000000006'::uuid),
  4::numeric,
  'destination level incremented by 4 (0 -> 4)');

select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'ac023100-0000-0000-0000-000000000004'::uuid),
  10::numeric,
  'quantity_on_hand unchanged (net-zero transfer)');

-- ─────────────────────────────────────────────────────────────────────────────
-- 11-14. post_receipt_v2: reason = 'PO {po_number}', notes still receipt id,
--        stock still routed to Staging, on-hand rose.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  perform public.post_receipt_v2(
    'ac023100-0000-0000-0000-000000000008'::uuid,  -- p_purchase_order_id
    'ac023100-0000-0000-0000-000000000003'::uuid,  -- p_warehouse_id
    jsonb_build_array(jsonb_build_object(
      'po_line_id',    'ac023100-0000-0000-0000-000000000009',
      'qty_received',  5,
      'qty_accepted',  5,
      'qty_rejected',  0,
      'unit_cost',     5
    )),
    'idem-key-0231-test',   -- p_idempotency_key
    'hash-0231-test',       -- p_request_hash
    null                    -- p_notes
  );
end$$;

select is(
  (select reason from public.stock_movements
    where item_id = 'ac023100-0000-0000-0000-000000000007'::uuid
      and movement_type = 'receive_po'
    order by created_at desc limit 1),
  'PO PO-0231-77',
  'receive_po ledger row reason is ''PO '' || po_number (was receipt_line)');

-- notes still carries the receipt id — stagedWorklist resolves the source
-- receipt (and its PO number / age badge) from sm.notes; 0231 must not break it.
select ok(
  exists (
    select 1
      from public.stock_movements sm
      join public.receipts r on r.id::text = sm.notes
     where sm.item_id = 'ac023100-0000-0000-0000-000000000007'::uuid
       and sm.movement_type = 'receive_po'
       and r.purchase_order_id = 'ac023100-0000-0000-0000-000000000008'::uuid
  ),
  'receive_po ledger row notes still holds the receipt id (stagedWorklist consumer intact)');

select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ac023100-0000-0000-0000-000000000007'::uuid
      and l.warehouse_id = 'ac023100-0000-0000-0000-000000000003'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  5::numeric,
  'accepted qty (5) still lands in the staging location (0190 behavior intact)');

select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'ac023100-0000-0000-0000-000000000007'::uuid),
  5::numeric,
  'quantity_on_hand rose by the accepted qty (receipt math intact)');

select * from finish();
rollback;
