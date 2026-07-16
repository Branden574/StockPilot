-- supabase/tests/0236_picking_rpcs_warehouse_scoped.test.sql
-- Proves migration 0236: the picking RPCs enforce WAREHOUSE-scoped write access,
-- not just an org-level staff role — closing the direct-RPC bypass where a
-- warehouse-scoped staff member could pick/complete another warehouse's order.
--
--   • a staff user assigned ONLY to warehouse A can partial_pick_line a line on
--     an A-warehouse order (auth passes),
--   • the SAME staff user is FORBIDDEN from partial_pick_line-ing a line on a
--     B-warehouse order (they have no write access to B),
--   • …and FORBIDDEN from complete_picking a B-warehouse order,
--   • a manager (all-warehouse access) CAN partial_pick_line a B-warehouse line.
--
-- Namespace: ac023600. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(6);

\set org   '\'ac023600-0000-0000-0000-000000000001\''
\set mgr   '\'ac023600-0000-0000-0000-000000000002\''
\set stf   '\'ac023600-0000-0000-0000-000000000003\''
\set whA   '\'ac023600-0000-0000-0000-00000000000a\''
\set whB   '\'ac023600-0000-0000-0000-00000000000b\''
\set item  '\'ac023600-0000-0000-0000-000000000010\''
\set ordA  '\'ac023600-0000-0000-0000-0000000000a0\''
\set ordB  '\'ac023600-0000-0000-0000-0000000000b0\''
\set lineA '\'ac023600-0000-0000-0000-0000000000a1\''
\set lineB '\'ac023600-0000-0000-0000-0000000000b1\''

-- ── Fixtures (superuser — RLS off) ──────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr-0236@test.local', '{}'::jsonb),
  (:stf, 'stf-0236@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Pick Scope Org 0236', 'pick-scope-org-0236') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now()),
  (:org, :stf, 'staff',   now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org, 'WH A 0236', 'WH-A-0236', 'active'),
  (:whB, :org, 'WH B 0236', 'WH-B-0236', 'active') on conflict (id) do nothing;

-- staff is assigned to warehouse A ONLY.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:org, :stf, :whA) on conflict do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :whA, 'SKU-0236', 'Pick Item 0236', 100, 'active', 'none')
  on conflict (id) do nothing;

-- source defaults to 'internal', which requires requester_user_id or
-- requester_email (order_requests_identity_chk, 0116/0251).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, fulfillment_type, requester_user_id) values
  (:ordA, :org, :whA, 'pick_slip_generated', 'pickup', :mgr),
  (:ordB, :org, :whB, 'pick_slip_generated', 'pickup', :mgr) on conflict (id) do nothing;

insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested) values
  (:lineA, :ordA, :item, 1),
  (:lineB, :ordB, :item, 1) on conflict (id) do nothing;

-- ── 1-2. Functions still exist + are SECURITY DEFINER (body transcribed ok) ──
select is(
  (select prosecdef from pg_proc where proname='partial_pick_line'
     and pronamespace='public'::regnamespace),
  true, 'partial_pick_line is SECURITY DEFINER');
select is(
  (select prosecdef from pg_proc where proname='complete_picking'
     and pronamespace='public'::regnamespace),
  true, 'complete_picking is SECURITY DEFINER');

-- ── As the warehouse-A-scoped STAFF user ────────────────────────────────────
set local "request.jwt.claim.sub" to 'ac023600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 3. Can pick a line on the A-warehouse order (assigned → write access).
select lives_ok(
  $$ select public.partial_pick_line('ac023600-0000-0000-0000-0000000000a1', 0) $$,
  'staff assigned to WH A can partial_pick_line an A-warehouse order line');

-- 4. FORBIDDEN on a B-warehouse order line (no write access to B).
select throws_ok(
  $$ select public.partial_pick_line('ac023600-0000-0000-0000-0000000000b1', 0) $$,
  '42501', null,
  'staff scoped to WH A is FORBIDDEN from picking a WH B order line');

-- 5. FORBIDDEN from completing a B-warehouse order.
select throws_ok(
  $$ select public.complete_picking('ac023600-0000-0000-0000-0000000000b0') $$,
  '42501', null,
  'staff scoped to WH A is FORBIDDEN from completing a WH B order');

-- ── As a MANAGER (all-warehouse access) ─────────────────────────────────────
set local "request.jwt.claim.sub" to 'ac023600-0000-0000-0000-000000000002';

-- 6. Manager can pick a B-warehouse line (manager+ → any warehouse).
select lives_ok(
  $$ select public.partial_pick_line('ac023600-0000-0000-0000-0000000000b1', 0) $$,
  'a manager can pick any warehouse''s order line');

reset role;
select * from finish();
rollback;
