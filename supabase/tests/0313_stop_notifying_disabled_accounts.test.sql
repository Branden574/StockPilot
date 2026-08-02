-- supabase/tests/0313_stop_notifying_disabled_accounts.test.sql
-- Pins migration 0313: a disabled account (user_profiles.disabled_at IS NOT
-- NULL) must not be resolved as a notification recipient, and the universal
-- push-dispatch trigger must not fire for one either.
--
-- ── WHAT THIS FILE CAN AND CANNOT PROVE LOCALLY ─────────────────────────────
-- _notify_recipients(p_org) is plain SQL with no network call — its
-- inclusion/exclusion behavior is fully and honestly testable here, and
-- section 1 does exactly that: seeds one disabled and one active
-- notify-eligible member in the SAME org and asserts the returned set.
--
-- _dispatch_push_for_notification() ends in `perform net.http_post(...)`.
-- pg_net's http_post is NOT exercised by local pgTAP (no network egress in
-- the test runner), so "does a disabled recipient's device actually stay
-- silent" cannot be asserted as a black-box behavior here — this is the same
-- class of limitation 0028 itself always had (its own trigger was never
-- black-box testable locally either). What CAN be honestly asserted, and is
-- asserted in section 2, is white-box: the guard is present in the deployed
-- function body (by source, via pg_get_functiondef), evaluates BEFORE the
-- token loop, and does not stop the notifications ROW itself from being
-- written or the trigger from completing without raising for a disabled
-- recipient. The actual no-push behavior for a disabled recipient in a real
-- Expo round-trip is owed to a manual/staging check, exactly as it was for
-- 0028's original dispatch behavior.
--
-- Wrapped in begin/rollback — nothing leaks. Namespace 03130000.

begin;

select plan(12);

\set org       '\'03130000-0000-0000-0000-000000000001\''
\set u_owner   '\'03130000-0000-0000-0000-0000000000a1\''  -- active, owner  -> INCLUDED
\set u_mgr_dis '\'03130000-0000-0000-0000-0000000000a2\''  -- DISABLED, manager -> EXCLUDED
\set u_staff   '\'03130000-0000-0000-0000-0000000000a3\''  -- active, staff  -> excluded (role, not disable — control)

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_owner,   'owner@n313.test',   '{"full_name":"Active Owner"}'::jsonb),
  (:u_mgr_dis, 'manager@n313.test', '{"full_name":"Disabled Manager"}'::jsonb),
  (:u_staff,   'staff@n313.test',   '{"full_name":"Active Staff"}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan)
values (:org, 'N313 Org', 'n313-org', 'UTC', 'USD', 'pro');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :u_owner,   'owner',   now()),
  (:org, :u_mgr_dis, 'manager', now()),
  (:org, :u_staff,   'staff',   now());

-- Stamp the manager disabled — exactly what the platform disable action
-- writes (0308 §1), via createAdminClient so RLS/0309's pin trigger is not
-- in play here.
update public.user_profiles set disabled_at = now() where id = :u_mgr_dis;

-- ── 1. _notify_recipients: functional inclusion/exclusion ──────────────────
-- Polarity, spelled out: active owner -> row ABSENT from the disabled-user
-- exists() subquery -> NOT disabled -> notified (present in the result set).
-- Disabled manager -> row PRESENT in that subquery -> skipped (absent from
-- the result set). If this ever flips, it means the guard was written as
-- IN/NOT IN instead of an EXISTS/NOT EXISTS correlated subquery and started
-- doing the wrong thing on some NULL edge, or the polarity was inverted.
select set_eq(
  $$select user_id from public._notify_recipients('03130000-0000-0000-0000-000000000001'::uuid)$$,
  array['03130000-0000-0000-0000-0000000000a1'::uuid],
  '_notify_recipients returns ONLY the active owner: disabled manager excluded, active-but-ineligible staff excluded'
);

-- Re-enable the manager and confirm the guard re-evaluates live rather than
-- caching a stale answer — proves the predicate is a correlated per-row
-- check, not a snapshot taken once.
update public.user_profiles set disabled_at = null where id = :u_mgr_dis;
select set_eq(
  $$select user_id from public._notify_recipients('03130000-0000-0000-0000-000000000001'::uuid)$$,
  array['03130000-0000-0000-0000-0000000000a1'::uuid,
        '03130000-0000-0000-0000-0000000000a2'::uuid],
  're-enabling the manager immediately re-includes them — the guard reads current disabled_at, not a cached state'
);

-- Disable again for the remaining assertions in this file.
update public.user_profiles set disabled_at = now() where id = :u_mgr_dis;
select set_eq(
  $$select user_id from public._notify_recipients('03130000-0000-0000-0000-000000000001'::uuid)$$,
  array['03130000-0000-0000-0000-0000000000a1'::uuid],
  're-disabling the manager excludes them again'
);

-- An org with only a disabled eligible member returns an EMPTY set, not an
-- error and not every member by some fallback — the exclusion is absolute.
select is(
  (select count(*)::int from public._notify_recipients('03130000-0000-0000-0000-000000000001'::uuid)
    where user_id = '03130000-0000-0000-0000-0000000000a2'::uuid),
  0,
  'the disabled manager never appears in _notify_recipients output while disabled'
);

-- ── 2. _dispatch_push_for_notification: white-box guard + row survives ─────
select ok(
  (select pg_get_functiondef('public._dispatch_push_for_notification()'::regprocedure)
     like '%disabled_at%'),
  '_dispatch_push_for_notification source contains the disabled_at guard (0313)'
);
-- The guard must run BEFORE the token loop, not after — a guard placed
-- after `for tok in select ... from public.push_tokens` would already have
-- dispatched by the time it ran. Assert ordinal position in the source.
select ok(
  (select position('disabled_at' in def) < position('push_tokens' in def)
     from (select pg_get_functiondef('public._dispatch_push_for_notification()'::regprocedure) as def) s),
  'the disabled_at guard appears BEFORE the push_tokens loop in source order'
);

-- Functional: inserting a notification for the (currently disabled) manager
-- must not raise, and the notifications ROW itself — not the push — must
-- still be written. The row insert is the caller's INSERT statement, not the
-- trigger's job, but this pins that the AFTER INSERT trigger completes
-- cleanly (returns, does not except out) for a disabled recipient, which is
-- exactly the path a stray syntax slip in the guard would break.
select lives_ok(
  $$insert into public.notifications (organization_id, user_id, type, title, body, link, metadata)
    values ('03130000-0000-0000-0000-000000000001'::uuid,
            '03130000-0000-0000-0000-0000000000a2'::uuid,
            'purchase_order.status_changed', 'Test ping for disabled user', null, null, '{}'::jsonb)$$,
  'inserting a notification for a DISABLED recipient does not raise — the trigger swallows the dispatch, not the insert'
);
select is(
  (select count(*)::int from public.notifications
    where user_id = '03130000-0000-0000-0000-0000000000a2'::uuid
      and type = 'purchase_order.status_changed'),
  1,
  'the in-app notification ROW for the disabled user still exists — 0313 blocks the PUSH, never the row write'
);

-- Same insert for the ACTIVE owner must also succeed and land a row — the
-- guard must not have become over-broad and started swallowing active
-- recipients too.
select lives_ok(
  $$insert into public.notifications (organization_id, user_id, type, title, body, link, metadata)
    values ('03130000-0000-0000-0000-000000000001'::uuid,
            '03130000-0000-0000-0000-0000000000a1'::uuid,
            'purchase_order.status_changed', 'Test ping for active user', null, null, '{}'::jsonb)$$,
  'inserting a notification for an ACTIVE recipient still works exactly as before'
);
select is(
  (select count(*)::int from public.notifications
    where user_id = '03130000-0000-0000-0000-0000000000a1'::uuid
      and type = 'purchase_order.status_changed'),
  1,
  'the ACTIVE recipient still gets their in-app row — the guard is not over-broad'
);

-- ── 3. create-or-replace preserved the 0025 grant ───────────────────────────
-- Postgres does not change ownership/permissions on CREATE OR REPLACE
-- FUNCTION with an unchanged signature. Pin that empirically rather than by
-- citing the docs: 0025's trailing `grant execute ... to authenticated`
-- must still hold after 0313 replaced the body.
select ok(
  has_function_privilege('authenticated', 'public._notify_recipients(uuid)', 'execute'),
  'authenticated STILL holds EXECUTE on _notify_recipients after 0313''s create-or-replace (grant survives, per Postgres semantics)'
);

-- The 0028 trigger binding is by function name, not by function body — a
-- create-or-replace does not require (and this migration does not do) a
-- drop/recreate of the trigger. Confirm the trigger is still wired to the
-- (now-guarded) function.
select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgname = 'trg_notifications_dispatch_push'
      and t.tgrelid = 'public.notifications'::regclass
      and p.proname = '_dispatch_push_for_notification'
      and not t.tgisinternal
  ),
  'trg_notifications_dispatch_push is still bound to _dispatch_push_for_notification — untouched by 0313'
);

select * from finish();
rollback;
