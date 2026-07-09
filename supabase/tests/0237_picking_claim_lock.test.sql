-- supabase/tests/0237_picking_claim_lock.test.sql
-- Proves migration 0237: picking claim / assign / lock / release.
--
--   • claim_picking assigns an unclaimed order to the caller,
--   • a SECOND claim on the now-assigned order is rejected (already_claimed) —
--     the lock is real (first-writer-wins),
--   • a non-picker staffer is FORBIDDEN from picking a claimed order
--     (not_assigned_picker) — the pick lock,
--   • the assigned picker CAN pick their own order,
--   • the picker can self-RELEASE, after which another staffer can claim,
--   • a non-manager cannot assign_picking (forbidden); a manager CAN.
--
-- Namespace: ac023700. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(11);

\set org   '\'ac023700-0000-0000-0000-000000000001\''
\set mgr   '\'ac023700-0000-0000-0000-000000000002\''
\set stfA  '\'ac023700-0000-0000-0000-000000000003\''
\set stfB  '\'ac023700-0000-0000-0000-000000000004\''
\set whA   '\'ac023700-0000-0000-0000-00000000000a\''
\set item  '\'ac023700-0000-0000-0000-000000000010\''
\set ordr  '\'ac023700-0000-0000-0000-0000000000a0\''
\set line  '\'ac023700-0000-0000-0000-0000000000a1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,  'mgr-0237@test.local',  '{}'::jsonb),
  (:stfA, 'stfA-0237@test.local', '{}'::jsonb),
  (:stfB, 'stfB-0237@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Claim Org 0237', 'claim-org-0237') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,  'manager', now()),
  (:org, :stfA, 'staff',   now()),
  (:org, :stfB, 'staff',   now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :org, 'WH A 0237', 'WH-A-0237', 'active') on conflict (id) do nothing;

-- Both staffers have write access to warehouse A.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:org, :stfA, :whA),
  (:org, :stfB, :whA) on conflict do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :whA, 'SKU-0237', 'Claim Item 0237', 100, 'active', 'none')
  on conflict (id) do nothing;

insert into public.order_requests (id, organization_id, warehouse_id, status, fulfillment_type)
  values (:ordr, :org, :whA, 'pick_slip_generated', 'pickup') on conflict (id) do nothing;
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested)
  values (:line, :ordr, :item, 5) on conflict (id) do nothing;

-- ── 1-2. Columns exist ──────────────────────────────────────────────────────
select has_column('public', 'order_requests', 'picking_claimed_at', 'picking_claimed_at exists');
select has_column('public', 'order_requests', 'picking_claimed_by', 'picking_claimed_by exists');

-- ── As staff A ──────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'ac023700-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 3. Staff A claims the unassigned order.
select lives_ok(
  $$ select public.claim_picking('ac023700-0000-0000-0000-0000000000a0') $$,
  'staff A can claim an unassigned picking order');
select is(
  (select assigned_picker_id from public.order_requests where id = :ordr),
  :stfA, 'the order is now assigned to staff A');

-- ── As staff B ──────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'ac023700-0000-0000-0000-000000000004';

-- 5. A second claim on the now-assigned order is rejected (the lock).
select throws_ok(
  $$ select public.claim_picking('ac023700-0000-0000-0000-0000000000a0') $$,
  'P0001', null,
  'a second claim on an already-claimed order is rejected (already_claimed)');

-- 6. Staff B (not the picker) is FORBIDDEN from picking a claimed order line.
select throws_ok(
  $$ select public.partial_pick_line('ac023700-0000-0000-0000-0000000000a1', 1) $$,
  '42501', null,
  'a non-assigned staffer is FORBIDDEN from picking a claimed order (not_assigned_picker)');

-- ── As staff A (the assigned picker) ────────────────────────────────────────
set local "request.jwt.claim.sub" to 'ac023700-0000-0000-0000-000000000003';

-- 7. The assigned picker CAN pick their own order.
select lives_ok(
  $$ select public.partial_pick_line('ac023700-0000-0000-0000-0000000000a1', 2) $$,
  'the assigned picker can pick their own order line');

-- 8. …and can self-release.
select lives_ok(
  $$ select public.release_picking('ac023700-0000-0000-0000-0000000000a0') $$,
  'the assigned picker can self-release their claim');
select is(
  (select assigned_picker_id from public.order_requests where id = :ordr),
  null, 'the order is unassigned again after release');

-- 9. A non-manager cannot assign a picker.
select throws_ok(
  $$ select public.assign_picking('ac023700-0000-0000-0000-0000000000a0','ac023700-0000-0000-0000-000000000003') $$,
  '42501', null,
  'a non-manager cannot assign_picking (forbidden)');

-- ── As a manager ────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'ac023700-0000-0000-0000-000000000002';

-- 11. A manager CAN assign a picker.
select lives_ok(
  $$ select public.assign_picking('ac023700-0000-0000-0000-0000000000a0','ac023700-0000-0000-0000-000000000003') $$,
  'a manager can assign a picker');

reset role;
select * from finish();
rollback;
