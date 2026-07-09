-- supabase/tests/0246_approve_partial.test.sql
-- Proves migration 0246's approve_partial:
--
--   P1. Short line: item on_hand 50, a competing order already reserves 20
--       (available 30). approve_partial on a request for 100 reserves min(100,
--       30) = 30 and approves (the other 70 will backorder at hand-over).
--   P2. Fully stocked: reserves the full requested (parity with strict approve).
--   G1. Rejects a non-pending_approval order.
--
-- Wrapped in begin/rollback — nothing leaks. Namespace b0246000.

begin;

select plan(4);

\set org  '\'b0246000-0000-0000-0000-000000000001\''
\set usr  '\'b0246000-0000-0000-0000-000000000002\''
\set wh   '\'b0246000-0000-0000-0000-000000000003\''

\set item_p1  '\'b0246000-0000-0000-0000-0000000000a0\''
\set ord_p1   '\'b0246000-0000-0000-0000-0000000000a1\''
\set line_p1  '\'b0246000-0000-0000-0000-0000000000a2\''
\set ord_other '\'b0246000-0000-0000-0000-0000000000af\''
\set item_p2  '\'b0246000-0000-0000-0000-0000000000b0\''
\set ord_p2   '\'b0246000-0000-0000-0000-0000000000b1\''
\set line_p2  '\'b0246000-0000-0000-0000-0000000000b2\''
\set ord_g1   '\'b0246000-0000-0000-0000-0000000000d1\''
\set line_g1  '\'b0246000-0000-0000-0000-0000000000d2\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bo-0246-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Approve Partial Org 0246', 'approve-partial-0246') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'AP WH', 'WH-AP-0246', 'active') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_p1, :org, :wh, 'AP-P1', 'P1', 50, 'active', 'none'),
    (:item_p2, :org, :wh, 'AP-P2', 'P2', 100, 'active', 'none')
  on conflict (id) do nothing;

-- Orders: p1/p2 pending_approval (approvable); g1 already approved (guard).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values
    (:ord_other, :org, :wh, 'approved',         :usr, 'internal', 'pickup'),
    (:ord_p1,    :org, :wh, 'pending_approval',  :usr, 'internal', 'pickup'),
    (:ord_p2,    :org, :wh, 'pending_approval',  :usr, 'internal', 'pickup'),
    (:ord_g1,    :org, :wh, 'approved',          :usr, 'internal', 'pickup')
  on conflict (id) do nothing;

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested)
  values
    (:line_p1, :ord_p1, :item_p1, 100),
    (:line_p2, :ord_p2, :item_p2, 100),
    (:line_g1, :ord_g1, :item_p2,  10)
  on conflict (id) do nothing;

-- A competing order holds 20 of item_p1, so only 30 of the 50 is available.
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity)
  values (:org, :item_p1, :wh, :ord_other, 20);

set local "request.jwt.claim.sub" to 'b0246000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- P1 — short line reserves only what's available.
do $$ begin perform public.approve_partial('b0246000-0000-0000-0000-0000000000a1'::uuid); end $$;
select is(
  (select coalesce(sum(quantity), 0) from public.stock_reservations
     where order_request_id = :ord_p1 and released_at is null),
  30::numeric(14,4),
  'P1: approve_partial reserved min(requested 100, available 30) = 30');
select is(
  (select status from public.order_requests where id = :ord_p1),
  'approved',
  'P1: order moves to approved despite the shortfall');

-- P2 — fully stocked reserves the whole requested qty.
do $$ begin perform public.approve_partial('b0246000-0000-0000-0000-0000000000b1'::uuid); end $$;
select is(
  (select coalesce(sum(quantity), 0) from public.stock_reservations
     where order_request_id = :ord_p2 and released_at is null),
  100::numeric(14,4),
  'P2: fully stocked reserves the full requested 100 (parity with strict approve)');

-- G1 — non-pending_approval is rejected.
select throws_ok(
  $$ select public.approve_partial('b0246000-0000-0000-0000-0000000000d1'::uuid) $$,
  'P0001', null,
  'G1: approve_partial rejects a non-pending_approval order');

select * from finish();
rollback;
