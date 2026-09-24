-- supabase/tests/0363_order_lines_and_approvals.test.sql
-- Proves migration 0363.
--
-- PART 1 (1-3)  Grants and policies: order lines are never updated or
--               deleted by an API role; approvals take no API-role writes.
-- PART 2 (4-12) order_request_lines INSERT: the ship gate is back in the
--               policy (and the nine editable statuses still take lines);
--               a line starts unfulfilled and unpriced; its cost snapshot
--               is the item's; the owner (service role, SECDEF RPCs) is
--               exempt.
-- PART 3 (13-14) Review hardening: a line's created_at is the database's (the
--               pick-slip staleness check reads it); the real service_role
--               (portal, public order route) is exempt.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(14);

\set orgA  '\'03630000-0000-0000-0000-00000000000a\''
\set u_req '\'03630000-0000-0000-0000-0000000000a1\''
\set whA   '\'03630000-0000-0000-0000-0000000000c1\''
\set item  '\'03630000-0000-0000-0000-0000000000d1\''
\set oPend '\'03630000-0000-0000-0000-0000000000e1\''
\set oAppr '\'03630000-0000-0000-0000-0000000000e2\''
\set oShip '\'03630000-0000-0000-0000-0000000000e3\''
\set oCanc '\'03630000-0000-0000-0000-0000000000e4\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_req, 'req-0363@test.local', '{}'::jsonb)
on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:orgA, 'Order Org 0363', 'order-org-0363');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_req, 'staff', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'Order WH 0363', 'O0363', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :u_req, :whA, true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, unit_cost, status, item_type) values
  (:item, :orgA, :whA, 'O0363-1', 'Chromebook', 212.5, 'active', 'product');

-- Orders at four statuses, created as the owner (status transitions are
-- validated by trg_order_requests_validate_transition only on UPDATE).
insert into public.order_requests (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type) values
  (:oPend, :orgA, :whA, 'pending_approval', :u_req, 'internal', 'pickup'),
  (:oAppr, :orgA, :whA, 'approved',         :u_req, 'internal', 'pickup'),
  (:oShip, :orgA, :whA, 'in_transit',       :u_req, 'internal', 'pickup'),
  (:oCanc, :orgA, :whA, 'cancelled',        :u_req, 'internal', 'pickup');

-- ═══ PART 1 ═════════════════════════════════════════════════════════════════
select ok(
  not exists (select 1 from unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) p
               where has_table_privilege('authenticated', 'public.order_request_lines', p)
                  or has_table_privilege('anon', 'public.order_request_lines', p))
  and not has_table_privilege('anon', 'public.order_request_lines', 'INSERT')
  and has_table_privilege('authenticated', 'public.order_request_lines', 'INSERT'),
  '1: order lines: authenticated may insert (the app adds lines), never update or delete; anon writes nothing');
select ok(
  not exists (select 1 from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
               where has_table_privilege('authenticated', 'public.approvals', p)
                  or has_table_privilege('anon', 'public.approvals', p)),
  '2: approvals take no API-role writes');
select is(
  array(select policyname::text from pg_policies where tablename = 'approvals' order by 1),
  array['approvals_select'],
  '3: only the approvals read policy remains');

-- ═══ PART 2 ═════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_req;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested, unit_cost_at_request, notes)
           values (%L, %L, 3, 0.01, 'for the lab')$$, :oPend, :item),
  '4: the requester adds a line to their pending order (the service''s shape)');
select is(
  (select trim_scale(unit_cost_at_request) from public.order_request_lines where order_request_id = :oPend),
  212.5::numeric,
  '5: ... and its cost snapshot is the item''s cost, not the 0.01 sent');
select lives_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
           values (%L, %L, 1)$$, :oAppr, :item),
  '6: an approved order still takes lines (0049''s pending-only gate is NOT restored)');
select throws_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
           values (%L, %L, 1)$$, :oShip, :item),
  '42501', null,
  '7: an order in transit takes no more lines');
select throws_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
           values (%L, %L, 1)$$, :oCanc, :item),
  '42501', null,
  '8: nor does a cancelled one');
select throws_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled)
           values (%L, %L, 5, 5)$$, :oPend, :item),
  '42501', 'A new order line starts unfulfilled; picking, packing, fulfilment and pricing are recorded by the order workflow.',
  '9: a line cannot arrive already fulfilled (the return flow would restock units that never shipped)');
select throws_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_picked, picked_at)
           values (%L, %L, 5, 5, now())$$, :oPend, :item),
  '42501', 'A new order line starts unfulfilled; picking, packing, fulfilment and pricing are recorded by the order workflow.',
  '10: nor already picked');
select throws_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested, unit_price_at_request)
           values (%L, %L, 5, 0)$$, :oPend, :item),
  '42501', 'A new order line starts unfulfilled; picking, packing, fulfilment and pricing are recorded by the order workflow.',
  '11: nor carry a price (prices come from the portal, as the service role)');
reset role;

insert into public.order_request_lines (order_request_id, item_id, quantity_requested, unit_cost_at_request, unit_price_at_request)
values (:oPend, :item, 1, 9, 19);
select is(
  (select row(trim_scale(unit_cost_at_request), trim_scale(unit_price_at_request))::text
     from public.order_request_lines where order_request_id = :oPend and unit_price_at_request is not null),
  row(9::numeric, 19::numeric)::text,
  '12: the owner (portal and public route as service role) is not held to the API-role rules');

-- ═══ PART 3: review hardening ═══════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_req;
set local role to 'authenticated';
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, created_at)
values ('03630000-0000-0000-0000-0000000000f1', :oAppr, :item, 1, '2001-01-01');
reset role;
select ok(
  (select created_at > now() - interval '1 minute' from public.order_request_lines
    where id = '03630000-0000-0000-0000-0000000000f1'),
  '13: a backdated line is recorded as added now (it cannot hide from the pick-slip staleness check)');
set local role to 'service_role';
select lives_ok(
  format($$insert into public.order_request_lines (order_request_id, item_id, quantity_requested, unit_price_at_request)
           values (%L, %L, 1, 25)$$, :oPend, :item),
  '14: the service_role (portal pricing) is not held to the API-role rules');
reset role;

select * from finish();
rollback;
