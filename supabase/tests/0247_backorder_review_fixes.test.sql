-- supabase/tests/0247_backorder_review_fixes.test.sql
-- Proves migration 0247:
--   C1. complete_picking one-click on a SHORT order stages what's available
--       (not the full owed) and does NOT crash — the approve_partial flow.
--   C2. …clamped to on_hand net of OTHER orders' reservations.
--   R1. resume_fulfillment clears assigned_picker_id (fresh claim).
--
-- Wrapped in begin/rollback. Namespace b0247000.

begin;

select plan(7);

\set org  '\'b0247000-0000-0000-0000-000000000001\''
\set usr  '\'b0247000-0000-0000-0000-000000000002\''
\set wh   '\'b0247000-0000-0000-0000-000000000003\''
\set rack '\'b0247000-0000-0000-0000-000000000004\''

\set item_c1 '\'b0247000-0000-0000-0000-0000000000a0\''
\set ord_c1  '\'b0247000-0000-0000-0000-0000000000a1\''
\set line_c1 '\'b0247000-0000-0000-0000-0000000000a2\''
\set item_c2 '\'b0247000-0000-0000-0000-0000000000b0\''
\set ord_c2  '\'b0247000-0000-0000-0000-0000000000b1\''
\set line_c2 '\'b0247000-0000-0000-0000-0000000000b2\''
\set ord_other '\'b0247000-0000-0000-0000-0000000000bf\''
\set item_r1 '\'b0247000-0000-0000-0000-0000000000d0\''
\set ord_r1  '\'b0247000-0000-0000-0000-0000000000d1\''
\set line_r1 '\'b0247000-0000-0000-0000-0000000000d2\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bo-0247-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Review Fixes Org 0247', 'review-fixes-0247') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'RF WH', 'WH-RF-0247', 'active') on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'RF-R1', 'shelf', 'rack') on conflict (id) do nothing;

-- C1 item: 30 on hand (all placed). C2 item: 50 on hand (all placed).
-- R1 item: 30 on hand (resume reads item-level only).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_c1, :org, :wh, 'RF-C1', 'C1', 30, 'active', 'none'),
    (:item_c2, :org, :wh, 'RF-C2', 'C2', 50, 'active', 'none'),
    (:item_r1, :org, :wh, 'RF-R1', 'R1', 30, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels where item_id in (:item_c1, :item_c2, :item_r1);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item_c1, :rack, 30), (:org, :item_c2, :rack, 50), (:org, :item_r1, :rack, 30);

-- C1/C2 orders in pick_slip_generated with NULL picks (one-click path).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values
    (:ord_c1, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup'),
    (:ord_c2, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup'),
    (:ord_other, :org, :wh, 'approved', :usr, 'internal', 'pickup'),
    (:ord_r1, :org, :wh, 'backordered', :usr, 'internal', 'pickup')
  on conflict (id) do nothing;

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_c1, :ord_c1, :item_c1, 100, 0, null),
    (:line_c2, :ord_c2, :item_c2, 100, 0, null),
    (:line_r1, :ord_r1, :item_r1, 100, 0, null)
  on conflict (id) do nothing;

-- C2: a competing order holds 20 of item_c2, so only 30 of the 50 is available.
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity)
  values (:org, :item_c2, :wh, :ord_other, 20);

-- R1: assign a picker so we can prove resume clears it.
update public.order_requests set assigned_picker_id = :usr where id = :ord_r1;

set local "request.jwt.claim.sub" to 'b0247000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- C1 — short one-click stages available (30), does NOT crash
-- ════════════════════════════════════════════════════════════════════════════
select lives_ok(
  $$ select public.complete_picking('b0247000-0000-0000-0000-0000000000a1'::uuid) $$,
  'C1: one-click complete_picking on a short order does not raise');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_c1),
  30::numeric(14,4),
  'C1: staged the available 30 (owed 100 clamped to on_hand 30)');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_c1),
  0::numeric(14,4),
  'C1: hardened exactly the available 30 (30 -> 0)');

-- ════════════════════════════════════════════════════════════════════════════
-- C2 — one-click clamps to on_hand net of OTHER orders' reservations
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.complete_picking('b0247000-0000-0000-0000-0000000000b1'::uuid); end $$;
select is(
  (select quantity_picked from public.order_request_lines where id = :line_c2),
  30::numeric(14,4),
  'C2: staged 30 = on_hand 50 minus the other order''s 20-unit hold');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_c2),
  20::numeric(14,4),
  'C2: left the 20 reserved for the other order on hand (50 -> 20)');

-- ════════════════════════════════════════════════════════════════════════════
-- R1 — resume clears the picker claim
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.resume_fulfillment('b0247000-0000-0000-0000-0000000000d1'::uuid); end $$;
select is(
  (select assigned_picker_id from public.order_requests where id = :ord_r1),
  null,
  'R1: resume_fulfillment clears assigned_picker_id (fresh claim)');
select is(
  (select status from public.order_requests where id = :ord_r1),
  'pick_slip_generated',
  'R1: resume moved the order to pick_slip_generated');

select * from finish();
rollback;
