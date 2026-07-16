-- supabase/tests/0265_notify_order_request_created_pref.test.sql
-- pgTAP tests for migration 0265 — per-user opt-out
-- (notification_preferences.push_order_request_created, default true) gating
-- the 'order_request.created' ping fired by _notify_order_request_changes
-- (trigger trg_order_requests_notify, 0044, rewritten by 0157/0265) on BOTH
-- gated code paths:
--   • a plain INSERT with status <> 'pending_confirmation'
--   • the pending_confirmation -> pending_approval UPDATE (0108's
--     public-link "real creation" event)
-- Gate pattern (0092 respect-pref convention):
--   prefs row missing       -> notify (legacy default = on)
--   prefs row, pref = true  -> notify
--   prefs row, pref = false -> skip
--
-- _notify_recipients (0025) returns accepted owner/admin/manager members —
-- three managers here cover the three preference states.
--
-- Namespace a0265000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(10);

\set org       '\'a0265000-0000-0000-0000-000000000001\''
\set wh        '\'a0265000-0000-0000-0000-000000000002\''
\set mgr_def   '\'a0265000-0000-0000-0000-000000000003\''
\set mgr_in    '\'a0265000-0000-0000-0000-000000000004\''
\set mgr_out   '\'a0265000-0000-0000-0000-000000000005\''
\set requester '\'a0265000-0000-0000-0000-000000000006\''
\set freshusr  '\'a0265000-0000-0000-0000-000000000007\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr_def,   'mgr-def-0265@test.local',  '{}'::jsonb),
  (:mgr_in,    'mgr-in-0265@test.local',   '{}'::jsonb),
  (:mgr_out,   'mgr-out-0265@test.local',  '{}'::jsonb),
  (:requester, 'req-0265@test.local',      '{}'::jsonb),
  (:freshusr,  'fresh-0265@test.local',    '{}'::jsonb);

insert into public.organizations (id, name, slug)
  values (:org, 'Notify Pref Org 0265', 'notify-pref-org-0265');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr_def,   'manager', now()),
  (:org, :mgr_in,    'manager', now()),
  (:org, :mgr_out,   'manager', now()),
  (:org, :requester, 'staff',   now());

insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Notify Pref WH', 'WH-NOTPREF-0265', 'active');

-- mgr_def deliberately gets NO notification_preferences row at all (proves
-- the legacy-default-on / missing-row branch).
insert into public.notification_preferences (user_id, push_order_request_created)
  values ('a0265000-0000-0000-0000-000000000004', true);
insert into public.notification_preferences (user_id, push_order_request_created)
  values ('a0265000-0000-0000-0000-000000000005', false);

-- ─────────────────────────────────────────────────────────────────────
-- 1. Schema: the column exists.
-- ─────────────────────────────────────────────────────────────────────
select has_column(
  'public', 'notification_preferences', 'push_order_request_created',
  'push_order_request_created column exists'
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Default is true: a fresh row that omits the column reads back true.
-- ─────────────────────────────────────────────────────────────────────
insert into public.notification_preferences (user_id)
  values ('a0265000-0000-0000-0000-000000000007');
select is(
  (select push_order_request_created from public.notification_preferences
     where user_id = 'a0265000-0000-0000-0000-000000000007'),
  true,
  'push_order_request_created defaults to true when unspecified'
);

-- ─────────────────────────────────────────────────────────────────────
-- 3-6. INSERT path — a brand-new internal order_request defaults to
-- status='pending_approval', so the trigger's INSERT branch fires
-- immediately. fulfillment_type is pinned to 'pickup' to satisfy
-- order_requests_delivery_target_chk (0110/0254) without a charter
-- fixture; requester_user_id satisfies order_requests_identity_chk.
-- ─────────────────────────────────────────────────────────────────────
insert into public.order_requests
  (id, organization_id, warehouse_id, source, requester_user_id, fulfillment_type)
values
  ('a0265000-0000-0000-0000-0000000000a1', 'a0265000-0000-0000-0000-000000000001',
   'a0265000-0000-0000-0000-000000000002', 'internal', 'a0265000-0000-0000-0000-000000000006',
   'pickup');

select is(
  (select count(*)::int from public.notifications
     where user_id = 'a0265000-0000-0000-0000-000000000003'
       and type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a1'),
  1,
  'manager with NO prefs row IS notified on order_request.created (legacy default = on)'
);
select is(
  (select count(*)::int from public.notifications
     where user_id = 'a0265000-0000-0000-0000-000000000004'
       and type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a1'),
  1,
  'manager with push_order_request_created=true IS notified'
);
select is(
  (select count(*)::int from public.notifications
     where user_id = 'a0265000-0000-0000-0000-000000000005'
       and type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a1'),
  0,
  'manager with push_order_request_created=false is NOT notified (opt-out honored)'
);
select is(
  (select count(*)::int from public.notifications
     where type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a1'),
  2,
  'exactly 2 notifications fired for the insert (mgr_def + mgr_in only, not mgr_out)'
);

-- ─────────────────────────────────────────────────────────────────────
-- 7-10. UPDATE path — pending_confirmation -> pending_approval (0108's
-- public-link "real creation" event) is gated by the SAME pref.
-- ─────────────────────────────────────────────────────────────────────
insert into public.order_requests
  (id, organization_id, warehouse_id, source, requester_user_id, fulfillment_type, status)
values
  ('a0265000-0000-0000-0000-0000000000a2', 'a0265000-0000-0000-0000-000000000001',
   'a0265000-0000-0000-0000-000000000002', 'internal', 'a0265000-0000-0000-0000-000000000006',
   'pickup', 'pending_confirmation');

select is(
  (select count(*)::int from public.notifications
     where type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a2'),
  0,
  'inserting as pending_confirmation fires no notification yet (early return)'
);

update public.order_requests set status = 'pending_approval'
  where id = 'a0265000-0000-0000-0000-0000000000a2';

select is(
  (select count(*)::int from public.notifications
     where user_id = 'a0265000-0000-0000-0000-000000000005'
       and type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a2'),
  0,
  'the pending_confirmation -> pending_approval UPDATE also honors the opt-out (mgr_out still skipped)'
);
select is(
  (select count(*)::int from public.notifications
     where user_id = 'a0265000-0000-0000-0000-000000000003'
       and type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a2'),
  1,
  'the UPDATE path notifies the no-prefs-row manager too'
);
select is(
  (select count(*)::int from public.notifications
     where user_id = 'a0265000-0000-0000-0000-000000000004'
       and type = 'order_request.created'
       and metadata->>'order_request_id' = 'a0265000-0000-0000-0000-0000000000a2'),
  1,
  'the UPDATE path notifies the opted-in manager too'
);

select * from finish();
rollback;
