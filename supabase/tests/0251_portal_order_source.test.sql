-- supabase/tests/0251_portal_order_source.test.sql
-- Proves migration 0251: the 'portal' order source + its identity rule.
--   P1. A portal order with requester_user_id inserts.
--   P2. A portal order WITHOUT requester_user_id is rejected (identity_chk).
--   P3. An unknown source is still rejected (source_check).
-- Namespace ab025100. Wrapped in begin/rollback.

begin;

select plan(3);

\set org '\'ab025100-0000-0000-0000-000000000001\''
\set usr '\'ab025100-0000-0000-0000-000000000002\''
\set wh  '\'ab025100-0000-0000-0000-000000000003\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'portal-0251@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Portal Org 0251', 'portal-0251') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'P WH', 'WH-P-0251', 'active') on conflict (id) do nothing;

select lives_ok(
  $$ insert into public.order_requests
       (organization_id, warehouse_id, status, source, fulfillment_type, requester_user_id)
       values ('ab025100-0000-0000-0000-000000000001', 'ab025100-0000-0000-0000-000000000003',
               'pending_approval', 'portal', 'pickup', 'ab025100-0000-0000-0000-000000000002') $$,
  'P1: portal order with a requester_user_id inserts');

select throws_ok(
  $$ insert into public.order_requests
       (organization_id, warehouse_id, status, source, fulfillment_type)
       values ('ab025100-0000-0000-0000-000000000001', 'ab025100-0000-0000-0000-000000000003',
               'pending_approval', 'portal', 'pickup') $$,
  '23514', null,
  'P2: portal order WITHOUT requester_user_id violates identity_chk');

select throws_ok(
  $$ insert into public.order_requests
       (organization_id, warehouse_id, status, source, fulfillment_type, requester_user_id)
       values ('ab025100-0000-0000-0000-000000000001', 'ab025100-0000-0000-0000-000000000003',
               'pending_approval', 'bogus', 'pickup', 'ab025100-0000-0000-0000-000000000002') $$,
  '23514', null,
  'P3: an unknown source violates source_check');

select * from finish();
rollback;
