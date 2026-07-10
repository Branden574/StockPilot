-- supabase/tests/0255_orders_schedule_reminders.test.sql
-- Proves migration 0255: needed_by + schedule-event linkage columns.
--   P1. order_requests.needed_by exists.
--   P2. schedule_events gains order_request_id/assigned_user_id/reminded_*_at.
--   P3. One auto-event per order (partial unique index) — second insert fails.
--   P4. Deleting the order cascades the linked event away.
-- Namespace ab025500. Wrapped in begin/rollback.

begin;

select plan(5);

\set org '\'ab025500-0000-0000-0000-000000000001\''
\set usr '\'ab025500-0000-0000-0000-000000000002\''
\set wh  '\'ab025500-0000-0000-0000-000000000003\''
\set ord '\'ab025500-0000-0000-0000-000000000004\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'sched-0255@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Sched Org 0255', 'sched-0255') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'S WH', 'WH-S-0255', 'active') on conflict (id) do nothing;

select has_column('public', 'order_requests', 'needed_by', 'P1: needed_by exists');
select columns_are(
  'public', 'schedule_events',
  array['id','organization_id','title','starts_at','ends_at','all_day','location_text',
        'warehouse_id','requester_name','details','status','bundle_id','bundle_quantity',
        'bundle_warehouse_id','created_by','updated_by','created_at','updated_at',
        'order_request_id','assigned_user_id','reminded_24h_at','reminded_1h_at'],
  'P2: schedule_events carries the four new columns');

insert into public.order_requests (id, organization_id, warehouse_id, status, fulfillment_type, requester_name, needed_by)
  values (:ord, :org, :wh, 'pending_approval', 'pickup', 'Sched Tester', now() + interval '2 days');

insert into public.schedule_events (organization_id, title, starts_at, status, order_request_id, created_by)
  values (:org, 'SO-000001 pickup', now() + interval '2 days', 'scheduled', :ord, :usr);

select throws_ok(
  format($q$ insert into public.schedule_events (organization_id, title, starts_at, status, order_request_id, created_by)
             values (%L, 'dup', now(), 'scheduled', %L, %L) $q$,
         'ab025500-0000-0000-0000-000000000001',
         'ab025500-0000-0000-0000-000000000004',
         'ab025500-0000-0000-0000-000000000002'),
  '23505', null,
  'P3: one auto-event per order (partial unique index)');

select is(
  (select count(*)::int from public.schedule_events where order_request_id = :ord), 1,
  'P4a: linked event present before delete');

delete from public.order_requests where id = :ord;

select is(
  (select count(*)::int from public.schedule_events where order_request_id = :ord), 0,
  'P4b: deleting the order cascades the linked event');

select * from finish();

rollback;
