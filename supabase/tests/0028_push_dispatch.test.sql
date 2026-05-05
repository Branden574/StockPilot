-- supabase/tests/0028_push_dispatch.test.sql
-- pgTAP tests for migration 0028 — push dispatch trigger.
--
-- We can't actually verify the HTTP POST went out without a fake net
-- server, so these tests focus on:
--   1. The trigger + function exist and are wired correctly
--   2. The trigger doesn't break the originating insert when pg_net is
--      missing or the call fails (it's wrapped in EXCEPTION WHEN OTHERS)

begin;

select plan(4);

select ok(
  exists(
    select 1 from pg_trigger
    where tgrelid = 'public.notifications'::regclass
      and tgname = 'trg_notifications_dispatch_push'
  ),
  'trg_notifications_dispatch_push trigger is installed on notifications'
);

select ok(
  exists(
    select 1 from pg_proc
    where proname = '_dispatch_push_for_notification'
      and pronamespace = 'public'::regnamespace
  ),
  '_dispatch_push_for_notification function exists in public schema'
);

-- ─────────────────────────────────────────────────────────────────────
-- The trigger should swallow errors so a failed pg_net call doesn't
-- block notification inserts. We can't easily simulate a pg_net
-- failure, but we CAN insert a notification for a user with no tokens
-- and assert the row got persisted (the loop short-circuits cleanly).
-- ─────────────────────────────────────────────────────────────────────

\set org_id '\'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\''
\set user_id '\'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:user_id, 'push@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org_id, 'Test', 'test-push')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org_id, :user_id, 'admin', now())
  on conflict do nothing;

insert into public.notifications (organization_id, user_id, type, title, body, link)
  values (:org_id, :user_id, 'test', 'Hello', 'World', '/dashboard');

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id and user_id = :user_id),
  1,
  'Notification row persists even when no push tokens exist for the user'
);

-- With an old (>120 days) token, the loop should skip it. Insert a
-- stale token and assert the notification still saves.
insert into public.push_tokens (user_id, token, platform, last_used_at)
  values (:user_id, 'ExponentPushToken[stale]', 'ios', now() - interval '200 days')
  on conflict (token) do nothing;

insert into public.notifications (organization_id, user_id, type, title, body, link)
  values (:org_id, :user_id, 'test2', 'Hello2', 'World2', '/dashboard');

select is(
  (select count(*)::int from public.notifications
    where organization_id = :org_id and user_id = :user_id),
  2,
  'Stale tokens (>120d) do not break the trigger; insert succeeds'
);

select * from finish();
rollback;
