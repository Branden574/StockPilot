-- supabase/tests/0365_s2_fulfilment_fixes.test.sql
-- Proves migration 0365 (Phase 0 S2, fulfilment).
--
-- PART 1 (1-7)   approve_order_request: duplicate lines for one item are
--                checked against their TOTAL; an order with no lines is never
--                approved; single lines behave as before.
-- PART 2 (8-10)  complete_picking: a one-click pick nets out a rental's hold
--                (order_request_id NULL) as well as other orders' holds.
-- PART 3 (11-16) create_order_request: header and lines in one transaction,
--                SECURITY INVOKER, closed to anon.
-- PART 4 (17-22) bundles: components (and pre-assembled kits) are drawn only
--                in the warehouse the kit is built or handed out at.
-- PART 5 (23-26) transfer_stock: below manager, both ends must be in the
--                caller's warehouses; a manager is not limited.
-- PART 6 (27)    assemble_bundle: a kit built at B cannot use A's component.
--
-- Roles: `set local role authenticated` with request.jwt.claim.sub, as the
-- house tests do. Run via `supabase test db` after `supabase db reset`.

begin;
select plan(27);

\set org     '\'03650000-0000-0000-0000-00000000000a\''
\set u_mgr   '\'03650000-0000-0000-0000-0000000000a1\''
\set u_stf   '\'03650000-0000-0000-0000-0000000000a2\''
\set whA     '\'03650000-0000-0000-0000-0000000000b1\''
\set whB     '\'03650000-0000-0000-0000-0000000000b2\''
\set rackA2  '\'03650000-0000-0000-0000-0000000000b3\''
\set rackB   '\'03650000-0000-0000-0000-0000000000b4\''
\set itemM   '\'03650000-0000-0000-0000-0000000000c1\''
\set itemN   '\'03650000-0000-0000-0000-0000000000c2\''
\set itemR   '\'03650000-0000-0000-0000-0000000000c3\''
\set compA   '\'03650000-0000-0000-0000-0000000000c4\''
\set compB   '\'03650000-0000-0000-0000-0000000000c5\''
\set phA     '\'03650000-0000-0000-0000-0000000000c6\''
\set itemT   '\'03650000-0000-0000-0000-0000000000c7\''
\set ordDup  '\'03650000-0000-0000-0000-0000000000d1\''
\set ordOk   '\'03650000-0000-0000-0000-0000000000d2\''
\set ordNone '\'03650000-0000-0000-0000-0000000000d3\''
\set ordOne  '\'03650000-0000-0000-0000-0000000000d4\''
\set ordOver '\'03650000-0000-0000-0000-0000000000d5\''
\set ordPick '\'03650000-0000-0000-0000-0000000000d6\''
\set rentR   '\'03650000-0000-0000-0000-0000000000e1\''
\set bunA    '\'03650000-0000-0000-0000-0000000000f1\''
\set bunP    '\'03650000-0000-0000-0000-0000000000f2\''
\set bunAsm  '\'03650000-0000-0000-0000-0000000000f3\''

-- ── Fixtures (as postgres: RLS bypassed, guards exempt) ─────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgr, 'mgr-0365@test.local', '{}'::jsonb),
  (:u_stf, 'stf-0365@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values (:org, 'S2 Org 0365', 's2-org-0365');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :u_mgr, 'manager', now()),
  (:org, :u_stf, 'staff',   now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:org, 'orders',  true, 'optional', '{}'::jsonb),
  (:org, 'bundles', true, 'optional', '{}'::jsonb),
  (:org, 'rentals', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org, 'S2 WH A 0365', 'S2A0365', 'active'),
  (:whB, :org, 'S2 WH B 0365', 'S2B0365', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rackA2, :org, :whA, 'Rack A2 0365', 'bin', 'rack'),
  (:rackB,  :org, :whB, 'Rack B 0365',  'bin', 'rack');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:org, :u_stf, :whA, true);

-- Opening stock lands in each warehouse's Unplaced location (0199 seed).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, item_type, is_rental) values
  (:itemM, :org, :whA, 'S2-M', 'Dup-line item 0365',  7, 2, 'active', 'product', false),
  (:itemN, :org, :whA, 'S2-N', 'Single-line item 0365', 10, 2, 'active', 'product', false),
  (:itemR, :org, :whA, 'S2-R', 'Rental item 0365',    3, 2, 'active', 'product', true),
  (:compA, :org, :whA, 'S2-CA', 'Component A 0365',   5, 1, 'active', 'product', false),
  (:compB, :org, :whB, 'S2-CB', 'Component B 0365',   5, 1, 'active', 'product', false),
  (:itemT, :org, :whA, 'S2-T', 'Transfer item 0365',  6, 1, 'active', 'product', false);
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, is_bundle) values
  (:phA, :org, :whA, '__BUNDLE__P0365KIT', 'Kit P (pre-assembled) 0365', 4, 'active', 'product', true);

insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:ordDup,  :org, :whA, 'pending_approval', 'internal', :u_stf, 'pickup'),
  (:ordOk,   :org, :whA, 'pending_approval', 'internal', :u_stf, 'pickup'),
  (:ordNone, :org, :whA, 'pending_approval', 'internal', :u_stf, 'pickup'),
  (:ordOne,  :org, :whA, 'pending_approval', 'internal', :u_stf, 'pickup'),
  (:ordOver, :org, :whA, 'pending_approval', 'internal', :u_stf, 'pickup'),
  (:ordPick, :org, :whA, 'pick_slip_generated', 'internal', :u_stf, 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:ordDup,  :itemM, 5), (:ordDup, :itemM, 5),
  (:ordOk,   :itemM, 3), (:ordOk,  :itemM, 4),
  (:ordOne,  :itemN, 4),
  (:ordOver, :itemN, 20),
  (:ordPick, :itemR, 3);

-- The picked order holds 1 of the rental item; a rental that is out holds 2.
insert into public.rentals (id, organization_id, warehouse_id, borrower_name, expected_return_at, status)
values (:rentR, :org, :whA, 'Borrower 0365', now() + interval '7 days', 'out');
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, rental_id, quantity) values
  (:org, :itemR, :whA, :ordPick, null,   1),
  (:org, :itemR, :whA, null,     :rentR, 2);

insert into public.bundles (id, organization_id, name, is_active, preassembly_enabled, phantom_item_id) values
  (:bunA,   :org, 'Kit A 0365',   true, false, null),
  (:bunP,   :org, 'Kit P 0365',   true, true,  :phA),
  (:bunAsm, :org, 'Kit Asm 0365', true, true,  null);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  (:bunA,   :compA, 1, false),
  (:bunP,   :compB, 1, false),
  (:bunAsm, :compA, 1, false);

-- ═══ PART 1: approve_order_request ══════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  format($$select public.approve_order_request(%L)$$, :ordDup),
  'P0001', 'insufficient_stock',
  '1: two lines of 5 against 7 on hand are refused (checked as 10, not 5 and 5)');
select is(
  (select count(*)::int from public.stock_reservations where order_request_id = :ordDup),
  0, '2: ... and hold nothing');
select lives_ok(
  format($$select public.approve_order_request(%L)$$, :ordOk),
  '3: two lines of 3 and 4 against 7 approve');
select is(
  (select sum(quantity) from public.stock_reservations where order_request_id = :ordOk and released_at is null),
  7::numeric, '4: ... holding exactly 7');
select throws_ok(
  format($$select public.approve_order_request(%L)$$, :ordNone),
  'P0001', 'order_has_no_lines',
  '5: an order with no lines is never approved');
select lives_ok(
  format($$select public.approve_order_request(%L)$$, :ordOne),
  '6: a single line within stock still approves');
select throws_ok(
  format($$select public.approve_order_request(%L)$$, :ordOver),
  'P0001', 'insufficient_stock',
  '7: a single line over stock is still refused');

-- ═══ PART 2: complete_picking and rental holds ══════════════════════════════
select lives_ok(
  format($$select public.complete_picking(%L)$$, :ordPick),
  '8: a one-click pick completes');
select is(
  (select -sum(quantity_change) from public.stock_movements
    where item_id = :itemR and created_at = now() and reason like 'Order pick%'),
  1::numeric,
  '9: ... taking 1 (3 on hand less the rental''s 2), not all 3');
select is(
  (select count(*)::int from public.stock_reservations where rental_id = :rentR and released_at is null),
  1, '10: ... and the rental''s hold is untouched');
reset role;

-- ═══ PART 3: create_order_request ═══════════════════════════════════════════
select ok(
  (select not prosecdef from pg_proc where oid = 'public.create_order_request(jsonb, jsonb)'::regprocedure)
  and not has_function_privilege('anon', 'public.create_order_request(jsonb, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.create_order_request(jsonb, jsonb)', 'execute'),
  '11: SECURITY INVOKER (the insert policies still decide), closed to anon');

create temp table created_req (id uuid) on commit drop;
grant all on created_req to authenticated;
set local "request.jwt.claim.sub"  to :u_stf;
set local role to 'authenticated';
-- Created in one statement and read in the next: a query cannot see rows its
-- own function call inserts (they are after its snapshot).
insert into created_req
select (public.create_order_request(
          jsonb_build_object('organization_id', :org, 'warehouse_id', :whA, 'requester_user_id', :u_stf,
                             'fulfillment_type', 'pickup', 'notes', 'walk 0365'),
          jsonb_build_array(jsonb_build_object('item_id', :itemN, 'quantity', 1),
                            jsonb_build_object('item_id', :compA, 'quantity', 2)))).id;
select is(
  (select o.status || '|' || o.source || '|' || (select count(*) from public.order_request_lines where order_request_id = o.id)
          || '|' || (select trim_scale(min(unit_cost_at_request)) from public.order_request_lines where order_request_id = o.id)
     from public.order_requests o where o.id = (select id from created_req)),
  'pending_approval|internal|2|1',
  '12: a request is created with its lines, costs snapshotted by the line guard');
select throws_ok(
  format($$select public.create_order_request(%L::jsonb, '[]'::jsonb)$$,
         jsonb_build_object('organization_id', :org, 'warehouse_id', :whA, 'requester_user_id', :u_stf, 'fulfillment_type', 'pickup')),
  '22023', 'A request needs at least one line',
  '13: a request with no lines is refused');
reset role;
create temp table orders_before on commit drop as
  select count(*) as n from public.order_requests where organization_id = :org;
set local "request.jwt.claim.sub"  to :u_stf;
set local role to 'authenticated';
select throws_ok(
  format($$select public.create_order_request(%L::jsonb, %L::jsonb)$$,
         jsonb_build_object('organization_id', :org, 'warehouse_id', :whA, 'requester_user_id', :u_stf, 'fulfillment_type', 'pickup'),
         jsonb_build_array(jsonb_build_object('item_id', :itemN, 'quantity', 1),
                           jsonb_build_object('item_id', :itemN, 'quantity', 0))),
  null, null,
  '14: a bad line fails the whole request');
reset role;
select is(
  (select count(*) from public.order_requests where organization_id = :org),
  (select n from orders_before),
  '15: ... leaving no order behind (the old two-request create left one with no lines)');
set local "request.jwt.claim.sub"  to :u_stf;
set local role to 'authenticated';
select throws_ok(
  format($$select public.create_order_request(%L::jsonb, %L::jsonb)$$,
         jsonb_build_object('organization_id', :org, 'warehouse_id', :whA, 'requester_user_id', :u_mgr, 'fulfillment_type', 'pickup'),
         jsonb_build_array(jsonb_build_object('item_id', :itemN, 'quantity', 1))),
  '42501', null,
  '16: RLS still applies: staff cannot file a request as someone else');
reset role;

-- ═══ PART 4: bundles stay in their warehouse ════════════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local role to 'authenticated';

select throws_ok(
  format($$select public.distribute_bundle(%L, 1, %L, false, null, 'x', null)$$, :bunA, :whB),
  'P0001', 'insufficient_stock',
  '17: handing out at B cannot use a component that is in A');
select lives_ok(
  format($$select public.distribute_bundle(%L, 1, %L, true, null, 'x', null)$$, :bunA, :whB),
  '18: with shortages allowed it records a shortage instead');
select is(
  (select trim_scale(quantity_on_hand) from public.inventory_items where id = :compA),
  5::numeric, '19: ... and A''s component is untouched');
select lives_ok(
  format($$select public.distribute_bundle(%L, 2, %L, false, null, 'x', null)$$, :bunA, :whA),
  '20: handing out at A draws A''s component');
select is(
  (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :phA)
    || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :compB),
  '4|5',
  '21 (setup check): kit P has 4 pre-assembled in A, its component 5 in B');
select lives_ok(
  format($$select public.distribute_bundle(%L, 1, %L, false, null, 'x', null)$$, :bunP, :whB),
  '22: handing out kit P at B builds it from B''s component, leaving A''s kits alone');
reset role;

-- ═══ PART 5: transfer_stock scope ═══════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_stf;
set local role to 'authenticated';
select lives_ok(
  format($$select public.transfer_stock(%L,
           (select id from public.locations where warehouse_id = %L and kind = 'unplaced' and deleted_at is null limit 1),
           %L, 1, 'inside A')$$, :itemT, :whA, :rackA2),
  '23: staff move stock inside their warehouse');
select throws_ok(
  format($$select public.transfer_stock(%L,
           (select id from public.locations where warehouse_id = %L and kind = 'unplaced' and deleted_at is null limit 1),
           %L, 1, 'into B')$$, :itemT, :whA, :rackB),
  '42501', 'forbidden',
  '24: staff scoped to A cannot move stock into B');
reset role;
set local "request.jwt.claim.sub"  to :u_mgr;
set local role to 'authenticated';
select lives_ok(
  format($$select public.transfer_stock(%L,
           (select id from public.locations where warehouse_id = %L and kind = 'unplaced' and deleted_at is null limit 1),
           %L, 1, 'into B')$$, :itemT, :whA, :rackB),
  '25: a manager may move stock between warehouses');
reset role;
select is(
  (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :phA)
    || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :compB),
  '4|4',
  '26: kit P''s pre-assembled stock in A stayed 4; B''s component went 5 -> 4');

-- ═══ PART 6: assemble_bundle stays in its warehouse ═════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$select public.assemble_bundle(%L, 1, %L, 'x')$$, :bunAsm, :whB),
  'P0001', 'insufficient_stock',
  '27: a kit assembled at B cannot consume a component that is in A');
reset role;

select * from finish();
rollback;
