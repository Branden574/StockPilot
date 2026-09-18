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

select plan(27);

\set orgA   '\'03510000-0000-0000-0000-00000000000a\''
\set orgB   '\'03510000-0000-0000-0000-00000000000b\''
\set uA     '\'03510000-0000-0000-0000-0000000000a1\''
\set uB     '\'03510000-0000-0000-0000-0000000000a2\''
\set uNever '\'03510000-0000-0000-0000-0000000000a3\''
\set uOther '\'03510000-0000-0000-0000-0000000000a4\''
\set uOwner '\'03510000-0000-0000-0000-0000000000a5\''
\set uInvit '\'03510000-0000-0000-0000-0000000000a6\''
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
  (:uInvit, 'invite-0351@test.local', '{}'::jsonb, now() - interval '2 days')
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
  (:orgB, :uA,     'viewer',  now()),
  (:orgB, :uOther, 'viewer',  now())
on conflict do nothing;

-- refreshed_at is seeded as the UTC wall clock, which is what GoTrue writes.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at) values
  (:sA1, :uA,     now() - interval '90 days', now(), (now() - interval '5 minutes') at time zone 'utc'),
  (:sA2, :uA,     now() - interval '10 days', now(), (now() - interval '2 days')    at time zone 'utc'),
  (:sB1, :uB,     now() - interval '1 hour',  now(), null),
  (:sO1, :uOther, now(),                      now(), now() at time zone 'utc');

-- Audit trail. uA acted in org A three days ago and in org B one minute ago.
-- uOwner's newest rows in org A are the nightly cron and a header-less
-- background write; the newest HUMAN row is twenty days old. Assertion 24 pins
-- BOTH exclusions. Mutation note (2026-09-18): deleting the function's
-- `user_agent is not null` line alone is an EQUIVALENT mutant, because
-- `NULL not ilike ...` is NULL and already drops the row. The line stays so the
-- intent does not rest on three-valued logic; a "fix" to
-- `coalesce(user_agent, '') not ilike` would surface the one-hour-old row here.
insert into public.audit_logs (organization_id, user_id, event, user_agent, created_at) values
  (:orgA, :uA,     'stock.transferred',     'Mozilla/5.0 (Macintosh)',  now() - interval '3 days'),
  (:orgA, :uA,     'inventory.item.updated','Mozilla/5.0 (Macintosh)',  now() - interval '9 days'),
  (:orgB, :uA,     'order_request.created', 'Mozilla/5.0 (Macintosh)',  now() - interval '1 minute'),
  (:orgA, :uOwner, 'order_request.approved','StockPilot/1.4.0 CFNetwork', now() - interval '20 days'),
  (:orgA, :uOwner, 'restore_point.created', 'vercel-cron/1.0',          now() - interval '2 hours'),
  (:orgA, :uOwner, 'inventory.item.updated', null,                      now() - interval '1 hour');

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
  '0351/24: automation is not activity - the vercel-cron row and the agent-less row under a borrowed owner id are ignored');
select ok(
  (select last_sign_in_at is null and last_session_at is null and last_action_at is null
     from public.platform_member_activity(:orgA, array[:uNever]::uuid[])),
  '0351/25: a member who never signed in still gets a row, with all three values null');
select is(
  (select last_session_at from public.platform_member_activity(:orgA, array[:uOwner]::uuid[])),
  null::timestamptz,
  '0351/26: a member with no surviving session reports a null last_session_at, not a guess');

reset role;

-- ── 5. refreshed_at is converted as UTC, whatever the caller's TimeZone ─────
-- Mutation check: swap `at time zone 'utc'` for `::timestamptz` in the
-- function and this assertion goes red by the Los Angeles UTC offset.
set local timezone to 'America/Los_Angeles';
set local role to 'service_role';
select is(
  (select last_session_at from public.platform_member_activity(:orgA, array[:uA]::uuid[])),
  now() - interval '5 minutes',
  '0351/27: the refreshed_at conversion does not depend on the session TimeZone');
reset role;

select * from finish();
rollback;
