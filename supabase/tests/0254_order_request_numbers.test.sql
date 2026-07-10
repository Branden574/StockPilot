-- supabase/tests/0254_order_request_numbers.test.sql
-- Proves migration 0254: per-org sequential order numbers.
--   P1. order_number column exists.
--   P2. First order in a fresh org gets #1; second gets #2 (trigger).
--   P3. Numbers are PER-ORG: a different org starts at #1.
-- Namespace ab025400. Wrapped in begin/rollback.

begin;

select plan(3);

\set orga '\'ab025400-0000-0000-0000-00000000000a\''
\set orgb '\'ab025400-0000-0000-0000-00000000000b\''
\set wha  '\'ab025400-0000-0000-0000-0000000000a1\''
\set whb  '\'ab025400-0000-0000-0000-0000000000b1\''

insert into public.organizations (id, name, slug) values
  (:orga, 'OrderNum Org A', 'ordernum-a-0254'),
  (:orgb, 'OrderNum Org B', 'ordernum-b-0254')
  on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wha, :orga, 'A WH', 'WH-A-0254', 'active'),
  (:whb, :orgb, 'B WH', 'WH-B-0254', 'active')
  on conflict (id) do nothing;

select has_column('public', 'order_requests', 'order_number', 'P1: order_number exists');

insert into public.order_requests (organization_id, warehouse_id, status, fulfillment_type, requester_name)
  values (:orga, :wha, 'pending_approval', 'pickup', 'Test A1'),
         (:orga, :wha, 'pending_approval', 'pickup', 'Test A2');

select results_eq(
  format($q$ select order_number from public.order_requests
             where organization_id = %L order by created_at, id $q$, 'ab025400-0000-0000-0000-00000000000a'),
  $$values (1::bigint), (2::bigint)$$,
  'P2: sequential per-org assignment starting at 1');

insert into public.order_requests (organization_id, warehouse_id, status, fulfillment_type, requester_name)
  values (:orgb, :whb, 'pending_approval', 'pickup', 'Test B1');

select is(
  (select order_number from public.order_requests where organization_id = :orgb),
  1::bigint,
  'P3: numbering is per-org (org B starts at 1)');

select * from finish();

rollback;
