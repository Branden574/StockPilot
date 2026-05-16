-- 0113_notification_prefs_orders.sql
--
-- Phase 6 of the orders workflow refactor: per-event notification
-- toggles for the new order lifecycle. Internal requesters (org
-- members with requester_user_id set on their orders) respect these
-- toggles; public requesters always get the emails (transactional,
-- no opt-out beyond not submitting again).
--
-- The columns default `true` so the rollout is opt-out per row,
-- not opt-in.

begin;

alter table public.notification_preferences
  add column if not exists email_order_received        boolean not null default true,
  add column if not exists email_order_status_changed  boolean not null default true,
  add column if not exists email_order_in_transit      boolean not null default true,
  add column if not exists email_order_completed       boolean not null default true,
  add column if not exists push_order_assigned_to_me   boolean not null default true;

commit;

comment on column public.notification_preferences.email_order_received is
  'Internal requester opt-out for the order-received confirmation email.';
comment on column public.notification_preferences.email_order_status_changed is
  'Internal requester opt-out for approved/denied/staged/in-transit interim emails.';
comment on column public.notification_preferences.email_order_in_transit is
  'Internal requester opt-out specifically for the in-transit email (separate from generic status changes).';
comment on column public.notification_preferences.email_order_completed is
  'Internal requester opt-out for the post-signature completion email.';
comment on column public.notification_preferences.push_order_assigned_to_me is
  'In-app bell + live-toast opt-out when a manager assigns this user as picker or driver.';
