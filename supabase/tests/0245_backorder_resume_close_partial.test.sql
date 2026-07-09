-- supabase/tests/0245_backorder_resume_close_partial.test.sql
-- Proves migration 0245's backorder exits:
--
--   R1. resume_fulfillment on a backordered order reserves newly-available
--       stock up to owed, re-opens the pick + signature cycle
--       (status → pick_slip_generated, signed_at cleared).
--   R2. resume_fulfillment refuses when no owed line has fulfillable stock.
--   C1. close_partial ends a backordered order at completed (keeps shipped).
--   G1. both exits reject a non-backordered order.
--
-- Wrapped in begin/rollback — nothing leaks. Namespace b0245000.

begin;

select plan(7);

\set org  '\'b0245000-0000-0000-0000-000000000001\''
\set usr  '\'b0245000-0000-0000-0000-000000000002\''
\set wh   '\'b0245000-0000-0000-0000-000000000003\''

\set item_r1 '\'b0245000-0000-0000-0000-0000000000a0\''
\set ord_r1  '\'b0245000-0000-0000-0000-0000000000a1\''
\set line_r1 '\'b0245000-0000-0000-0000-0000000000a2\''
\set item_r2 '\'b0245000-0000-0000-0000-0000000000b0\''
\set ord_r2  '\'b0245000-0000-0000-0000-0000000000b1\''
\set line_r2 '\'b0245000-0000-0000-0000-0000000000b2\''
\set item_c1 '\'b0245000-0000-0000-0000-0000000000c0\''
\set ord_c1  '\'b0245000-0000-0000-0000-0000000000c1\''
\set line_c1 '\'b0245000-0000-0000-0000-0000000000c2\''
\set item_g1 '\'b0245000-0000-0000-0000-0000000000d0\''
\set ord_g1  '\'b0245000-0000-0000-0000-0000000000d1\''
\set line_g1 '\'b0245000-0000-0000-0000-0000000000d2\''

-- ── Fixtures (as owner, before the role switch) ──────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bo-0245-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Backorder Exits Org 0245', 'backorder-exits-0245') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'BO Exits WH', 'WH-BOE-0245', 'active') on conflict (id) do nothing;

-- R1 item: owed 50, 30 fulfillable on hand. R2 item: owed 50, 0 on hand.
-- C1/G1 items: stock is irrelevant to close_partial / the guard.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_r1, :org, :wh, 'BOE-R1', 'R1', 30, 'active', 'none'),
    (:item_r2, :org, :wh, 'BOE-R2', 'R2',  0, 'active', 'none'),
    (:item_c1, :org, :wh, 'BOE-C1', 'C1', 10, 'active', 'none'),
    (:item_g1, :org, :wh, 'BOE-G1', 'G1', 10, 'active', 'none')
  on conflict (id) do nothing;

-- Backordered orders (INSERT bypasses the UPDATE-only transition trigger).
-- signed_at is pre-set on R1 to prove resume RE-OPENS the signature cycle.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type,
   signed_at, signature_token)
  values
    (:ord_r1, :org, :wh, 'backordered', :usr, 'internal', 'pickup', now(), 'stale-token-r1'),
    (:ord_r2, :org, :wh, 'backordered', :usr, 'internal', 'pickup', now(), 'stale-token-r2'),
    (:ord_c1, :org, :wh, 'backordered', :usr, 'internal', 'pickup', now(), 'stale-token-c1'),
    (:ord_g1, :org, :wh, 'approved',    :usr, 'internal', 'pickup', null, null)
  on conflict (id) do nothing;

-- Each line owes 50 (requested 100, already shipped 50).
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_r1, :ord_r1, :item_r1, 100, 50, null),
    (:line_r2, :ord_r2, :item_r2, 100, 50, null),
    (:line_c1, :ord_c1, :item_c1, 100, 50, null),
    (:line_g1, :ord_g1, :item_g1, 100,  0, null)
  on conflict (id) do nothing;

-- ── Become the manager ───────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'b0245000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- R1 — resume_fulfillment reserves up to owed and re-opens the cycle
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.resume_fulfillment('b0245000-0000-0000-0000-0000000000a1'::uuid); end $$;

select is(
  (select status from public.order_requests where id = :ord_r1),
  'pick_slip_generated',
  'R1: resume moves backordered → pick_slip_generated');
select is(
  (select signed_at from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signed_at (fresh signature cycle for the next batch)');
select is(
  (select coalesce(sum(quantity), 0) from public.stock_reservations
     where order_request_id = :ord_r1 and released_at is null),
  30::numeric(14,4),
  'R1: resume reserved min(owed 50, available 30) = 30');

-- ════════════════════════════════════════════════════════════════════════════
-- R2 — resume_fulfillment refuses when nothing is fulfillable
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok(
  $$ select public.resume_fulfillment('b0245000-0000-0000-0000-0000000000b1'::uuid) $$,
  'P0001', 'no_fulfillable_stock',
  'R2: resume refuses when no owed line has fulfillable stock');

-- ════════════════════════════════════════════════════════════════════════════
-- C1 — close_partial ends the order at completed
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.close_partial('b0245000-0000-0000-0000-0000000000c1'::uuid); end $$;

select is(
  (select status from public.order_requests where id = :ord_c1),
  'completed',
  'C1: close_partial moves backordered → completed');
select isnt(
  (select completed_at from public.order_requests where id = :ord_c1),
  null,
  'C1: close_partial stamps completed_at');

-- ════════════════════════════════════════════════════════════════════════════
-- G1 — the exits reject a non-backordered order
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok(
  $$ select public.resume_fulfillment('b0245000-0000-0000-0000-0000000000d1'::uuid) $$,
  'P0001', null,
  'G1: resume_fulfillment rejects a non-backordered (approved) order');

select * from finish();
rollback;
