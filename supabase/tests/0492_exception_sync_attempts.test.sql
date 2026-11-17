-- supabase/tests/0492_exception_sync_attempts.test.sql
-- Proves migration 0492 (placeholder number): public.exception_sync_attempts,
-- one row per organization, written and read only by the Exception Center
-- sync cron on the service-role client.
--
-- WHAT IS WORTH PINNING
--   1. Shape: organization_id is the primary key and cascades with the
--      organization; last_attempt_at is required; consecutive_failures
--      defaults to 0 and is never negative.
--   2. RLS is on and there is no policy, so no API role but service_role can
--      see or write a row.
--   3. anon and authenticated have no privilege at all (a signed-in member of
--      the organization cannot read its row either); service_role can select,
--      insert, update (the cron's upsert) and delete.
--
-- Namespace a0492000. Wrapped in begin/rollback: nothing leaks.
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(17);

\set orgA '\'a0492000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0492000-0000-0000-0000-0000000000b1\''
\set userA '\'a0492000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a-sync-attempts@test.local', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'Attempts Org A', 'a0492000-org-a'),
  (:orgB, 'Attempts Org B', 'a0492000-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :userA, 'owner', now());

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select has_table('public', 'exception_sync_attempts', '0492/1: table exists');
select col_is_pk('public', 'exception_sync_attempts', 'organization_id', '0492/2: one row per organization');
select columns_are('public', 'exception_sync_attempts',
  array['organization_id', 'last_attempt_at', 'consecutive_failures'],
  '0492/3: exactly organization_id, last_attempt_at and consecutive_failures');
select col_not_null('public', 'exception_sync_attempts', 'last_attempt_at', '0492/4: last_attempt_at is required');
select col_default_is('public', 'exception_sync_attempts', 'consecutive_failures', '0',
  '0492/5: consecutive_failures defaults to 0');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.exception_sync_attempts'::regclass and contype = 'f'
      and confrelid = 'public.organizations'::regclass),
  'c',
  '0492/6: organization_id cascades from organizations');

-- ── 2. RLS on, no policy ────────────────────────────────────────────────────
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'exception_sync_attempts'),
  '0492/7: RLS is enabled');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'exception_sync_attempts'),
  0,
  '0492/8: there is no policy');

-- ── 3. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'exception_sync_attempts', 'anon', array[]::text[],
  '0492/9: anon has no privilege at all');
select table_privs_are('public', 'exception_sync_attempts', 'authenticated', array[]::text[],
  '0492/10: authenticated has no privilege at all');
select ok(
  has_table_privilege('service_role', 'public.exception_sync_attempts', 'select')
  and has_table_privilege('service_role', 'public.exception_sync_attempts', 'insert')
  and has_table_privilege('service_role', 'public.exception_sync_attempts', 'update')
  and has_table_privilege('service_role', 'public.exception_sync_attempts', 'delete'),
  '0492/11: service_role has select, insert, update and delete');

-- The service role writes the way the cron does: an upsert on the key.
set local role service_role;
insert into public.exception_sync_attempts (organization_id, last_attempt_at)
  values (:orgA, '2026-11-01 00:00:00+00'), (:orgB, '2026-11-01 00:00:00+00');
insert into public.exception_sync_attempts (organization_id, last_attempt_at, consecutive_failures)
  values (:orgA, '2026-11-02 00:00:00+00', 2)
  on conflict (organization_id) do update
    set last_attempt_at = excluded.last_attempt_at,
        consecutive_failures = excluded.consecutive_failures;
select results_eq(
  $$ select last_attempt_at, consecutive_failures from public.exception_sync_attempts
       where organization_id = 'a0492000-0000-0000-0000-0000000000a1' $$,
  $$ values ('2026-11-02 00:00:00+00'::timestamptz, 2) $$,
  '0492/12: the service role reads back its upsert');
select throws_ok(
  $$ update public.exception_sync_attempts set consecutive_failures = -1
       where organization_id = 'a0492000-0000-0000-0000-0000000000a1' $$,
  '23514', null, '0492/13: consecutive_failures is never negative');
reset role;

-- A signed-in owner of the organization: no read, no write.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0492000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select count(*) from public.exception_sync_attempts $$,
  '42501', null, '0492/14: a signed-in member cannot read the table');
select throws_ok(
  $$ insert into public.exception_sync_attempts (organization_id, last_attempt_at)
       values ('a0492000-0000-0000-0000-0000000000a1', now())
       on conflict (organization_id) do update set last_attempt_at = excluded.last_attempt_at $$,
  '42501', null, '0492/15: a signed-in member cannot write the table');
reset role;

set local role anon;
select throws_ok(
  $$ select count(*) from public.exception_sync_attempts $$,
  '42501', null, '0492/16: a signed-out caller cannot read the table');
reset role;

-- ── 4. Cascade ──────────────────────────────────────────────────────────────
delete from public.organizations where id = :orgB;
select is(
  (select count(*)::int from public.exception_sync_attempts
    where organization_id = 'a0492000-0000-0000-0000-0000000000b1'),
  0,
  '0492/17: deleting the organization deletes its row');

select * from finish();
rollback;
