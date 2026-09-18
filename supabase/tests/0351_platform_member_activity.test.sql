-- supabase/tests/0351_platform_member_activity.test.sql
-- Proves migration 0351: platform_member_activity(uuid, uuid[]) is a READ-ONLY,
-- service_role-ONLY reader of auth.users / auth.sessions / audit_logs, scoped
-- to the accepted members of ONE organization.
--
-- WHY THIS TEST EXISTS
--   The function has no in-body authorization gate by design, so its EXECUTE
--   posture is the whole control. An `authenticated` grant would let any
--   signed-in user of any tenant read other people's activity timestamps at
--   POST /rest/v1/rpc. Section 2 pins that posture from both sides of the
--   catalog. Section 4 pins the three things that make the NUMBER wrong rather
--   than the access: automation counted as a person, another tenant's audit
--   rows, and the refreshed_at time zone.
--
-- HOW THE ROLES ARE SIMULATED
--   Closed grants are asserted through the CATALOG, never by executing:
--   `set local role authenticated` + throws_ok segfaulted local Postgres 17
--   during the 0345 work. Behaviour runs under `set local role to
--   'service_role'` with plain is()/ok(), the 0345 section-D form.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(31);

\set orgA   '\'03510000-0000-0000-0000-00000000000a\''
\set orgB   '\'03510000-0000-0000-0000-00000000000b\''
\set uA     '\'03510000-0000-0000-0000-0000000000a1\''
\set uB     '\'03510000-0000-0000-0000-0000000000a2\''
\set uNever '\'03510000-0000-0000-0000-0000000000a3\''
\set uOther '\'03510000-0000-0000-0000-0000000000a4\''
\set uOwner '\'03510000-0000-0000-0000-0000000000a5\''
\set uInvit '\'03510000-0000-0000-0000-0000000000a6\''
\set uOut   '\'03510000-0000-0000-0000-0000000000a7\''
\set uInOnl '\'03510000-0000-0000-0000-0000000000a8\''
\set uPlat  '\'03510000-0000-0000-0000-0000000000a9\''
\set uGhost '\'03510000-0000-0000-0000-0000000000ff\''
\set sA1    '\'03510000-0000-0000-0000-0000000000b1\''
\set sA2    '\'03510000-0000-0000-0000-0000000000b2\''
\set sB1    '\'03510000-0000-0000-0000-0000000000c1\''
\set sO1    '\'03510000-0000-0000-0000-0000000000d1\''

-- ── Fixtures (superuser) ────────────────────────────────────────────────────
-- now() is the transaction start time, so the same expression below compares
-- equal to the microsecond.
insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at) values
  (:uA,     'a-0351@test.local',      '{}'::jsonb, now() - interval '90 days'),
  (:uB,     'b-0351@test.local',      '{}'::jsonb, now() - interval '1 hour'),
  (:uNever, 'never-0351@test.local',  '{}'::jsonb, null),
  (:uOther, 'other-0351@test.local',  '{}'::jsonb, now() - interval '1 day'),
  (:uOwner, 'owner-0351@test.local',  '{}'::jsonb, now() - interval '40 days'),
  (:uInvit, 'invite-0351@test.local', '{}'::jsonb, now() - interval '2 days'),
  (:uOut,   'out-0351@test.local',    '{}'::jsonb, now() - interval '5 days'),
  (:uInOnl, 'inonly-0351@test.local', '{}'::jsonb, now() - interval '1 day'),
  (:uPlat,  'plat-0351@test.local',   '{}'::jsonb, now() - interval '10 minutes')
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Activity Org A 0351', 'activity-org-a-0351'),
  (:orgB, 'Activity Org B 0351', 'activity-org-b-0351')
on conflict (id) do nothing;

-- uA belongs to BOTH orgs (the multi-org case). uOther belongs to B only.
-- uInvit has been invited to A but has NOT accepted.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :uA,     'manager', now()),
  (:orgA, :uB,     'viewer',  now()),
  (:orgA, :uNever, 'viewer',  now()),
  (:orgA, :uOwner, 'owner',   now()),
  (:orgA, :uInvit, 'viewer',  null),
  (:orgA, :uOut,   'viewer',  now()),
  (:orgA, :uInOnl, 'viewer',  now()),
  (:orgB, :uA,     'viewer',  now()),
  (:orgB, :uOther, 'viewer',  now())
on conflict do nothing;

-- uPlat is a platform admin ACTING AS org A: startActingAs upserts an accepted
-- owner row with impersonation_expires_at set. Every other member reader in the
-- platform service excludes it; so must this function.
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :uPlat, 'owner', now(), now() + interval '45 minutes')
on conflict do nothing;

-- refreshed_at is seeded as the UTC wall clock, which is what GoTrue writes.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at) values
  (:sA1, :uA,     now() - interval '90 days', now(), (now() - interval '5 minutes') at time zone 'utc'),
  (:sA2, :uA,     now() - interval '10 days', now(), (now() - interval '2 days')    at time zone 'utc'),
  (:sB1, :uB,     now() - interval '1 hour',  now(), null),
  (:sO1, :uOther, now(),                      now(), now() at time zone 'utc');

-- Audit trail. uA acted in org A three days ago and in org B one minute ago.
--
-- uOwner is the member whose id the crons borrow. The newest row written from a
-- PERSON's client is the twenty-day-old mobile approval; everything newer is
-- automation or a script and must be ignored: Vercel's scheduler, the same
-- agent in another case, a header-less background write, a cron route invoked
-- by hand with curl, a node script, and the web sign-in row (which only
-- restates last_sign_in_at). Assertion 24 pins all six at once; the mutation
-- run deletes each clause in turn and each one turns it red.
insert into public.audit_logs (organization_id, user_id, event, user_agent, created_at) values
  (:orgA, :uA,     'stock.transferred',      'Mozilla/5.0 (Macintosh)',                               now() - interval '3 days'),
  (:orgA, :uA,     'inventory.item.updated', 'Mozilla/5.0 (Macintosh)',                               now() - interval '9 days'),
  (:orgB, :uA,     'order_request.created',  'Mozilla/5.0 (Macintosh)',                               now() - interval '1 minute'),
  (:orgA, :uOwner, 'order_request.approved', 'StockPilot/54 CFNetwork/3896.100.1.2.1 Darwin/27.0.0',  now() - interval '20 days'),
  (:orgA, :uOwner, 'restore_point.created',  'vercel-cron/1.0',                                       now() - interval '2 hours'),
  (:orgA, :uOwner, 'inventory.item.updated', null,                                                    now() - interval '1 hour'),
  (:orgA, :uOwner, 'restore_point.created',  'curl/8.7.1',                                            now() - interval '50 minutes'),
  (:orgA, :uOwner, 'inventory.item.deleted', 'node',                                                  now() - interval '40 minutes'),
  (:orgA, :uOwner, 'purchase_order.created', 'Vercel-Cron/1.0',                                       now() - interval '30 minutes'),
  (:orgA, :uOwner, 'user.signed_in',         'Mozilla/5.0 (Macintosh)',                               now() - interval '10 minutes'),
  -- Android (React Native) sends okhttp. Not shipped yet; pinned so that launch
  -- cannot silently blank the column for Android-only users.
  (:orgA, :uB,     'stock.adjusted',         'okhttp/4.12.0',                                         now() - interval '6 hours'),
  -- uOut signed in, only read, and signed out a day later. The sign-out row is
  -- the last evidence of them and it outlives the session rows it deleted.
  (:orgA, :uOut,   'user.signed_in',         'Mozilla/5.0 (Windows NT 10.0)',                         now() - interval '5 days'),
  (:orgA, :uOut,   'user.signed_out',        'Mozilla/5.0 (Windows NT 10.0)',                         now() - interval '4 days'),
  -- uInOnl has nothing but the sign-in row.
  (:orgA, :uInOnl, 'user.signed_in',         'Mozilla/5.0 (X11; Linux)',                              now() - interval '1 day'),
  -- uPlat's work while acting as org A.
  (:orgA, :uPlat,  'inventory.item.updated', 'Mozilla/5.0 (Macintosh)',                               now() - interval '5 minutes');

-- ── 1. Structure ────────────────────────────────────────────────────────────
select has_function('public', 'platform_member_activity', array['uuid', 'uuid[]'],
  '0351/1: platform_member_activity(uuid, uuid[]) exists');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'platform_member_activity'),
  true,
  '0351/2: SECURITY DEFINER - the only way a PostgREST caller reaches the auth schema');
select ok(
  (select p.proconfig is not null
          and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'platform_member_activity'),
  '0351/3: pins search_path');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'platform_member_activity'),
  's',
  '0351/4: declared STABLE - it may not write');
select ok(
  (select p.prosrc !~* '\m(insert|update|delete|truncate)\M'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'platform_member_activity'),
  '0351/5: the body contains no write statement');

-- ── 2. EXECUTE posture (catalog only - see header) ──────────────────────────
select function_privs_are('public', 'platform_member_activity', array['uuid', 'uuid[]'], 'anon',
  array[]::text[], '0351/6: anon cannot execute it');
select function_privs_are('public', 'platform_member_activity', array['uuid', 'uuid[]'], 'authenticated',
  array[]::text[], '0351/7: authenticated cannot execute it - the body has no gate, so this grant IS the control');
select function_privs_are('public', 'platform_member_activity', array['uuid', 'uuid[]'], 'service_role',
  array['EXECUTE'], '0351/8: service_role can execute it - the platform console admin client');
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'platform_member_activity'),
  '0351/9: the ACL is explicit and carries no PUBLIC entry');
select is(
  has_function_privilege('authenticated', 'public.platform_member_activity(uuid, uuid[])', 'EXECUTE'),
  false,
  '0351/10: the same fact from the other side of the catalog');

-- ── 3. Shape and scope, as the role that actually calls it ──────────────────
set local role to 'service_role';

select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uA, :uB, :uNever]::uuid[])),
  3,
  '0351/11: exactly one row per requested member');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uA, :uB]::uuid[])
    where user_id = :uNever),
  0,
  '0351/12: a member who was not asked for is never returned');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uOther]::uuid[])),
  0,
  '0351/13: a user who is NOT a member of the organization returns no row, even when asked for by id');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uInvit]::uuid[])),
  0,
  '0351/14: an invited member who has not accepted returns no row');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, '{}'::uuid[])), 0,
  '0351/15: an empty id list returns nothing');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uGhost]::uuid[])), 0,
  '0351/16: an unknown id returns nothing and does not raise');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, null::uuid[])), 0,
  '0351/17: a null id list returns nothing and does not raise');
select is(
  (select count(*)::int from public.platform_member_activity(null::uuid, array[:uA]::uuid[])), 0,
  '0351/18: a null organization returns nothing and does not raise');

-- ── 4. The three timestamps ─────────────────────────────────────────────────
select is(
  (select last_sign_in_at from public.platform_member_activity(:orgA, array[:uA]::uuid[])),
  now() - interval '90 days',
  '0351/19: last_sign_in_at passes through unchanged - the understating value stays visible');
select is(
  (select last_session_at from public.platform_member_activity(:orgA, array[:uA]::uuid[])),
  now() - interval '5 minutes',
  '0351/20: last_session_at is the most recent REFRESH across every session, not the most recent sign-in');
select is(
  (select last_session_at from public.platform_member_activity(:orgA, array[:uB]::uuid[])),
  now() - interval '1 hour',
  '0351/21: a never-refreshed session (null refreshed_at) falls back to its created_at');
select is(
  (select last_action_at from public.platform_member_activity(:orgA, array[:uA]::uuid[])),
  now() - interval '3 days',
  '0351/22: last_action_at is the newest audit row IN THIS organization - the one-minute-old row in org B is not counted');
select is(
  (select last_action_at from public.platform_member_activity(:orgB, array[:uA]::uuid[])),
  now() - interval '1 minute',
  '0351/23: the same person asked about in org B gets org B''s answer');
select is(
  (select last_action_at from public.platform_member_activity(:orgA, array[:uOwner]::uuid[])),
  now() - interval '20 days',
  '0351/24: automation is not activity - cron (either case), agent-less, curl, node and the sign-in row are all ignored; the mobile approval is the answer');
select ok(
  (select last_sign_in_at is null and last_session_at is null and last_action_at is null
     from public.platform_member_activity(:orgA, array[:uNever]::uuid[])),
  '0351/25: a member who never signed in still gets a row, with all three values null');
select is(
  (select last_session_at from public.platform_member_activity(:orgA, array[:uOwner]::uuid[])),
  null::timestamptz,
  '0351/26: a member with no surviving session reports a null last_session_at, not a guess');

select is(
  (select last_action_at from public.platform_member_activity(:orgA, array[:uB]::uuid[])),
  now() - interval '6 hours',
  '0351/27: an Android client (okhttp) counts as a person');
select is(
  (select last_action_at from public.platform_member_activity(:orgA, array[:uOut]::uuid[])),
  now() - interval '4 days',
  '0351/28: user.signed_out counts - it is the last evidence of someone who only read, and it survives the sign-out');
select ok(
  (select last_action_at is null and last_sign_in_at = now() - interval '1 day'
     from public.platform_member_activity(:orgA, array[:uInOnl]::uuid[])),
  '0351/29: user.signed_in does NOT count as an action - it would always outrank last_sign_in_at and hide the case the console must hedge');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uPlat]::uuid[])),
  0,
  '0351/30: a platform admin acting as the organization (impersonation grant) is not a member and returns no row');

reset role;

-- ── 5. refreshed_at is converted as UTC, whatever the caller's TimeZone ─────
-- Mutation check: swap `at time zone 'utc'` for `::timestamptz` in the
-- function and this assertion goes red by the Los Angeles UTC offset.
set local timezone to 'America/Los_Angeles';
set local role to 'service_role';
select is(
  (select last_session_at from public.platform_member_activity(:orgA, array[:uA]::uuid[])),
  now() - interval '5 minutes',
  '0351/31: the refreshed_at conversion does not depend on the session TimeZone');
reset role;

select * from finish();
rollback;
