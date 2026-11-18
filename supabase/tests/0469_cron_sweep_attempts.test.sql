-- supabase/tests/0469_cron_sweep_attempts.test.sql
-- Proves migration 0469: public.cron_sweep_attempts,
-- one row per (job, organization), written and read only by the scheduled
-- jobs on the service-role client.
--
-- WHAT IS WORTH PINNING
--   1. Shape: the key is (job, organization_id); organization_id cascades
--      with the organization and is indexed for that cascade; last_attempt_at
--      is required; consecutive_failures defaults to 0 and is never negative;
--      a job is a short lower-case name.
--   2. RLS is on and there is no policy, so no API role but service_role can
--      see or write a row.
--   3. anon and authenticated have no privilege at all (a signed-in owner of
--      the organization cannot read its rows either); service_role can
--      select, insert, update (the crons' upsert) and delete.
--   4. Two jobs keep separate rows for one organization.
--
-- Namespace a0469000. Wrapped in begin/rollback: nothing leaks.
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(21);

\set orgA '\'a0469000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0469000-0000-0000-0000-0000000000b1\''
\set userA '\'a0469000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a-sweep-attempts@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'Attempts Org A', 'a0469000-org-a'),
  (:orgB, 'Attempts Org B', 'a0469000-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :userA, 'owner', now());

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select has_table('public', 'cron_sweep_attempts', '0469/1: table exists');
select col_is_pk('public', 'cron_sweep_attempts', array['job', 'organization_id'],
  '0469/2: one row per job and organization');
select columns_are('public', 'cron_sweep_attempts',
  array['job', 'organization_id', 'last_attempt_at', 'consecutive_failures'],
  '0469/3: exactly job, organization_id, last_attempt_at and consecutive_failures');
select col_not_null('public', 'cron_sweep_attempts', 'last_attempt_at', '0469/4: last_attempt_at is required');
select col_default_is('public', 'cron_sweep_attempts', 'consecutive_failures', '0',
  '0469/5: consecutive_failures defaults to 0');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.cron_sweep_attempts'::regclass and contype = 'f'
      and confrelid = 'public.organizations'::regclass),
  'c',
  '0469/6: organization_id cascades from organizations');
select has_index('public', 'cron_sweep_attempts', 'cron_sweep_attempts_organization_id_idx',
  array['organization_id'], '0469/7: organization_id is indexed for the cascade');

-- ── 2. RLS on, no policy ────────────────────────────────────────────────────
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cron_sweep_attempts'),
  '0469/8: RLS is enabled');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'cron_sweep_attempts'),
  0,
  '0469/9: there is no policy');

-- ── 3. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'cron_sweep_attempts', 'anon', array[]::text[],
  '0469/10: anon has no privilege at all');
select table_privs_are('public', 'cron_sweep_attempts', 'authenticated', array[]::text[],
  '0469/11: authenticated has no privilege at all');
select ok(
  has_table_privilege('service_role', 'public.cron_sweep_attempts', 'select')
  and has_table_privilege('service_role', 'public.cron_sweep_attempts', 'insert')
  and has_table_privilege('service_role', 'public.cron_sweep_attempts', 'update')
  and has_table_privilege('service_role', 'public.cron_sweep_attempts', 'delete'),
  '0469/12: service_role has select, insert, update and delete');

-- The service role writes the way the crons do: an upsert on the key.
set local role service_role;
insert into public.cron_sweep_attempts (job, organization_id, last_attempt_at) values
  ('exception_sync', :orgA, '2026-11-01 00:00:00+00'),
  ('restore_points', :orgA, '2026-11-01 02:00:00+00'),
  ('exception_sync', :orgB, '2026-11-01 00:00:00+00');
insert into public.cron_sweep_attempts (job, organization_id, last_attempt_at, consecutive_failures)
  values ('exception_sync', :orgA, '2026-11-02 00:00:00+00', 2)
  on conflict (job, organization_id) do update
    set last_attempt_at = excluded.last_attempt_at,
        consecutive_failures = excluded.consecutive_failures;
select results_eq(
  $$ select job, last_attempt_at, consecutive_failures from public.cron_sweep_attempts
       where organization_id = 'a0469000-0000-0000-0000-0000000000a1' order by job $$,
  $$ values ('exception_sync'::text, '2026-11-02 00:00:00+00'::timestamptz, 2),
            ('restore_points'::text, '2026-11-01 02:00:00+00'::timestamptz, 0) $$,
  '0469/13: the upsert changes its own job''s row and leaves the other job''s alone');
select throws_ok(
  $$ update public.cron_sweep_attempts set consecutive_failures = -1
       where organization_id = 'a0469000-0000-0000-0000-0000000000a1' $$,
  '23514', null, '0469/14: consecutive_failures is never negative');
select throws_ok(
  $$ insert into public.cron_sweep_attempts (job, organization_id, last_attempt_at)
       values ('Exception Sync', 'a0469000-0000-0000-0000-0000000000b1', now()) $$,
  '23514', null, '0469/15: a job name is lower case with no spaces');
select throws_ok(
  $$ insert into public.cron_sweep_attempts (job, organization_id, last_attempt_at)
       values ('', 'a0469000-0000-0000-0000-0000000000b1', now()) $$,
  '23514', null, '0469/16: a job name is never empty');
reset role;

-- A signed-in owner of the organization: no read, no write.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0469000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select count(*) from public.cron_sweep_attempts $$,
  '42501', null, '0469/17: a signed-in member cannot read the table');
select throws_ok(
  $$ insert into public.cron_sweep_attempts (job, organization_id, last_attempt_at)
       values ('exception_sync', 'a0469000-0000-0000-0000-0000000000a1', now())
       on conflict (job, organization_id) do update set last_attempt_at = excluded.last_attempt_at $$,
  '42501', null, '0469/18: a signed-in member cannot write the table');
reset role;

set local role anon;
select throws_ok(
  $$ select count(*) from public.cron_sweep_attempts $$,
  '42501', null, '0469/19: a signed-out caller cannot read the table');
reset role;

-- ── 4. Cascade ──────────────────────────────────────────────────────────────
delete from public.organizations where id = :orgB;
select is(
  (select count(*)::int from public.cron_sweep_attempts
    where organization_id = 'a0469000-0000-0000-0000-0000000000b1'),
  0,
  '0469/20: deleting the organization deletes its rows');
select is(
  (select count(*)::int from public.cron_sweep_attempts
    where organization_id = 'a0469000-0000-0000-0000-0000000000a1'),
  2,
  '0469/21: another organization''s rows stay');

select * from finish();
rollback;
