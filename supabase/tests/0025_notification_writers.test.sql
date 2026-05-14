-- supabase/tests/0025_notification_writers.test.sql
-- pgTAP tests for migration 0025 — _notify_low_stock + _notify_po_status.
-- Run via `supabase test db` after `supabase start`. Uses the standard
-- begin/rollback pattern so tests don't leak rows.

begin;

select plan(8);

-- ─────────────────────────────────────────────────────────────────────
-- Fixtures: org, owner, manager, an inventory item.
-- ─────────────────────────────────────────────────────────────────────

-- Use stable UUIDs so assertions are deterministic.
\set org_id '\'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\''
\set owner_id '\'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\''
\set staff_id '\'cccccccc-cccc-cccc-cccc-cccccccccccc\''
\set item_id '\'dddddddd-dddd-dddd-dddd-dddddddddddd\''
\set wh_id '\'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee\''
\set po_id '\'ffffffff-ffff-ffff-ffff-ffffffffffff\''

-- Insert auth.users via the convention Supabase uses for tests.
insert into auth.users (id, email, raw_user_meta_data)
  values (:owner_id, 'owner@test.local', '{}'::jsonb),
         (:staff_id, 'staff@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

-- Org + members.
insert into public.organizations (id, name, slug)
  values (:org_id, 'Test Org', 'test-org')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org_id, :owner_id, 'owner', now()),
         (:org_id, :staff_id, 'staff', now())
  on conflict do nothing;

-- Warehouse.
insert into public.warehouses (id, organization_id, name, status)
  values (:wh_id, :org_id, 'Main', 'active')
  on conflict (id) do nothing;

-- Item with reorder_point = 5, starting at 10.
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, reorder_point, status)
  values (:item_id, :org_id, :wh_id, 'Widget', 'SKU-001', 10, 5, 'active')
  on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────
-- Test 1: dropping above reorder does NOT fire the trigger.
-- ─────────────────────────────────────────────────────────────────────

update public.inventory_items set quantity_on_hand = 6 where id = :item_id;

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and metadata->>'item_id' = :item_id::text),
  0,
  'Quantity above reorder point should not create a notification'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 2: crossing below reorder fires for the owner (notify-eligible).
-- ─────────────────────────────────────────────────────────────────────

update public.inventory_items set quantity_on_hand = 4 where id = :item_id;

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and user_id = :owner_id
      and type = 'inventory.low_stock'),
  1,
  'Owner receives a low_stock notification on the crossing edge'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 3: staff (not in notify_recipients) gets nothing.
-- ─────────────────────────────────────────────────────────────────────

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and user_id = :staff_id),
  0,
  'Staff are not notified for low stock (only owner/admin/manager)'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 4: dipping further within the danger zone does NOT spam.
-- ─────────────────────────────────────────────────────────────────────

update public.inventory_items set quantity_on_hand = 3 where id = :item_id;

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and metadata->>'item_id' = :item_id::text),
  1,
  'Subsequent updates within the danger zone do not re-spam'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 5: out-of-stock crossing (qty <= 0) uses the OOS type.
-- ─────────────────────────────────────────────────────────────────────

-- Bring it back above first, then crash to 0.
update public.inventory_items set quantity_on_hand = 10 where id = :item_id;
update public.inventory_items set quantity_on_hand = 0 where id = :item_id;

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and type = 'inventory.out_of_stock'),
  1,
  'Crossing to qty <= 0 emits inventory.out_of_stock'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 6: PO status change notifies the creator + owner.
-- ─────────────────────────────────────────────────────────────────────

insert into public.purchase_orders
  (id, organization_id, po_number, status, created_by, warehouse_id)
  values (:po_id, :org_id, 'PO-001', 'draft', :owner_id, :wh_id)
  on conflict (id) do nothing;

update public.purchase_orders set status = 'ordered' where id = :po_id;

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and type = 'purchase_order.status_changed'
      and metadata->>'po_id' = :po_id::text),
  1,
  'PO status change emits one notification per recipient (owner=creator, deduped)'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 7: PO update with same status does NOT emit.
-- ─────────────────────────────────────────────────────────────────────

update public.purchase_orders set status = 'ordered' where id = :po_id;

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id
      and type = 'purchase_order.status_changed'),
  1,
  'No-op status change does not duplicate the notification'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 8: notification.link routes to the filtered inventory list so
-- the user lands on every row that needs action, not just the one item
-- that tripped the threshold. Migration 0060 swapped the per-item
-- detail link for the same `?stock=out|low&type=all` filter the
-- dashboard tiles already use.
-- ─────────────────────────────────────────────────────────────────────

select is(
  (select link from public.notifications
    where type = 'inventory.out_of_stock'
      and metadata->>'item_id' = :item_id::text
    limit 1),
  '/dashboard/inventory?stock=out&type=all',
  'Out-of-stock notification.link routes to the filtered list'
);

select * from finish();
rollback;
