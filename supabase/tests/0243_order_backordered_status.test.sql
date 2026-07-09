-- supabase/tests/0243_order_backordered_status.test.sql
-- Proves migration 0243: the `backordered` order status + its transition edges.
--
--   • the CHECK constraint accepts 'backordered',
--   • the hand-over fork staged_for_pickup → backordered is allowed,
--   • backordered → pick_slip_generated (resume) is allowed,
--   • backordered → completed (close-partial) is allowed,
--   • backordered → approved is REJECTED (only the three exits are legal),
--   • completed stays terminal (completed → backordered rejected).
--
-- Source states are forced by briefly disabling the transition trigger — the
-- test only exercises the trigger on the transitions under test. Namespace
-- ab024300. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(6);

\set org '\'ab024300-0000-0000-0000-000000000001\''
\set usr '\'ab024300-0000-0000-0000-000000000002\''
\set wh  '\'ab024300-0000-0000-0000-000000000003\''
\set ord '\'ab024300-0000-0000-0000-000000000011\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bo-0243@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Backorder Org 0243', 'backorder-org-0243') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'BO WH 0243', 'WH-BO-0243', 'active') on conflict (id) do nothing;

-- 1. The CHECK constraint accepts 'backordered' as a valid status. (pickup +
-- a requester satisfy the unrelated fulfillment/identity checks.)
select lives_ok(
  $$ insert into public.order_requests
       (id, organization_id, warehouse_id, status, fulfillment_type, requester_user_id)
       values ('ab024300-0000-0000-0000-000000000011',
               'ab024300-0000-0000-0000-000000000001',
               'ab024300-0000-0000-0000-000000000003', 'pending_confirmation',
               'pickup', 'ab024300-0000-0000-0000-000000000002') $$,
  'a fresh order_request inserts (constraint intact)'
);

-- Force it to staged_for_pickup, bypassing the transition trigger.
alter table public.order_requests disable trigger trg_order_requests_validate_transition;
update public.order_requests set status = 'staged_for_pickup' where id = :ord;
alter table public.order_requests enable trigger trg_order_requests_validate_transition;

-- 2. Hand-over fork: staged_for_pickup → backordered is allowed.
select lives_ok(
  $$ update public.order_requests set status = 'backordered'
       where id = 'ab024300-0000-0000-0000-000000000011' $$,
  'staged_for_pickup → backordered (hand-over fork) is allowed'
);

-- 3. Resume: backordered → pick_slip_generated is allowed.
select lives_ok(
  $$ update public.order_requests set status = 'pick_slip_generated'
       where id = 'ab024300-0000-0000-0000-000000000011' $$,
  'backordered → pick_slip_generated (resume) is allowed'
);

-- Back to backordered for the next case.
alter table public.order_requests disable trigger trg_order_requests_validate_transition;
update public.order_requests set status = 'backordered' where id = :ord;
alter table public.order_requests enable trigger trg_order_requests_validate_transition;

-- 4. Close-partial: backordered → completed is allowed.
select lives_ok(
  $$ update public.order_requests set status = 'completed'
       where id = 'ab024300-0000-0000-0000-000000000011' $$,
  'backordered → completed (close-partial) is allowed'
);

-- Back to backordered.
alter table public.order_requests disable trigger trg_order_requests_validate_transition;
update public.order_requests set status = 'backordered' where id = :ord;
alter table public.order_requests enable trigger trg_order_requests_validate_transition;

-- 5. backordered → approved is rejected (not one of the three exits).
select throws_ok(
  $$ update public.order_requests set status = 'approved'
       where id = 'ab024300-0000-0000-0000-000000000011' $$,
  'P0001', null,
  'backordered → approved is rejected (illegal transition)'
);

-- 6. completed stays terminal — completed → backordered is rejected.
alter table public.order_requests disable trigger trg_order_requests_validate_transition;
update public.order_requests set status = 'completed' where id = :ord;
alter table public.order_requests enable trigger trg_order_requests_validate_transition;
select throws_ok(
  $$ update public.order_requests set status = 'backordered'
       where id = 'ab024300-0000-0000-0000-000000000011' $$,
  'P0001', null,
  'completed → backordered is rejected (completed is terminal)'
);

select * from finish();
rollback;
