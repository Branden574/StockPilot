-- supabase/tests/0432_user_appearance.test.sql
-- Proves migration 0432 (placeholder number): public.user_appearance, one
-- row per person holding their chosen appearance.
--
-- WHAT IS WORTH PINNING
--   1. A person can only ever read and write their own row: another person's
--      row is invisible, cannot be inserted, updated or taken over (changing
--      user_id), and a signed-out caller has no privilege at all.
--   2. Only the four appearance words are stored (CHECK), never a label such
--      as 'Liquid Glass', an empty string or null.
--   3. No delete for a signed-in caller (no policy and no privilege); the row
--      goes with the account (ON DELETE CASCADE).
--   4. updated_at is the reconcile clock: the update trigger moves it, and the
--      phone's upsert (insert ... on conflict do update) works under RLS.
--   5. The privileges are exactly what the migration grants (D1 rule).
--
-- Namespace a0432000. Wrapped in begin/rollback: nothing leaks.
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(35);

\set userA '\'a0432000-0000-0000-0000-0000000000a1\''
\set userB '\'a0432000-0000-0000-0000-0000000000b1\''
\set userC '\'a0432000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a-appearance@test.local', '{}'::jsonb),
  (:userB, 'b-appearance@test.local', '{}'::jsonb),
  (:userC, 'c-appearance@test.local', '{}'::jsonb);

-- Seeded as superuser (RLS not active). B's row gives A something to fail to
-- see; C's row has a fixed PAST updated_at so the trigger test is unambiguous
-- (INSERT does not fire the BEFORE UPDATE trigger, so the seed value sticks).
insert into public.user_appearance (user_id, appearance) values (:userB, 'dark');
insert into public.user_appearance (user_id, appearance, updated_at)
  values (:userC, 'light', '2020-01-01 00:00:00+00');

-- ── 1. Structure and posture ────────────────────────────────────────────────
select has_table('public', 'user_appearance', '0432/1: table exists');
select col_is_pk('public', 'user_appearance', 'user_id', '0432/2: one row per person');
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_appearance'),
  '0432/3: RLS is enabled');
select is(
  (select array_agg(policyname::text order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'user_appearance'),
  array['user_appearance_insert', 'user_appearance_select', 'user_appearance_update'],
  '0432/4: exactly select, insert and update policies; there is no delete policy');
select is(
  (select array_agg(distinct r order by r) from pg_policies, unnest(roles) r
    where schemaname = 'public' and tablename = 'user_appearance'),
  array['authenticated']::name[],
  '0432/5: every policy is for authenticated only');
select table_privs_are('public', 'user_appearance', 'anon', array[]::text[],
  '0432/6: anon has no privilege at all');
select table_privs_are('public', 'user_appearance', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'],
  '0432/7: authenticated has select, insert and update only (no delete, truncate, references, trigger)');
select ok(
  has_table_privilege('service_role', 'public.user_appearance', 'select')
  and has_table_privilege('service_role', 'public.user_appearance', 'insert')
  and has_table_privilege('service_role', 'public.user_appearance', 'update')
  and has_table_privilege('service_role', 'public.user_appearance', 'delete'),
  '0432/8: service_role has select, insert, update and delete');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.user_appearance'::regclass and contype = 'f'
      and confrelid = 'auth.users'::regclass),
  'c',
  '0432/9: user_id cascades from auth.users');
select is(
  (select array_agg(t.tgname::text) from pg_trigger t
    where t.tgrelid = 'public.user_appearance'::regclass and not t.tgisinternal),
  array['user_appearance_touch_updated_at'],
  '0432/10: the one trigger is the shared updated_at touch');
select ok(
  (select p.proname = 'tg_set_updated_at' and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16 and (t.tgtype & 4) = 0
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.user_appearance'::regclass and t.tgname = 'user_appearance_touch_updated_at'),
  '0432/11: it runs tg_set_updated_at BEFORE UPDATE (not on insert)');

-- ── 2. The CHECK: only the four words ───────────────────────────────────────
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', 'Liquid Glass') $$,
  '23514', null, '0432/12: a display label is refused');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', '') $$,
  '23514', null, '0432/13: an empty string is refused');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', 'DARK') $$,
  '23514', null, '0432/14: a different case is refused');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', null) $$,
  '23502', null, '0432/15: null is refused');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000ff', 'dark') $$,
  '23503', null, '0432/16: a row for a person who does not exist is refused');

-- ── 3. Signed out: nothing ──────────────────────────────────────────────────
set local role to 'anon';
select throws_ok(
  $$ select count(*) from public.user_appearance $$,
  '42501', null, '0432/17: anon cannot read the table');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', 'dark') $$,
  '42501', null, '0432/18: anon cannot write the table');
reset role;

-- ── 4. Become user A ────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'a0432000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.user_appearance),
  0,
  '0432/19: A sees none of B''s or C''s rows');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000b1', 'liquid-glass') $$,
  '42501', null, '0432/20: A cannot insert a row for B');
select lives_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', 'liquid-glass') $$,
  '0432/21: A can insert their own row');
select throws_ok(
  $$ insert into public.user_appearance (user_id, appearance) values ('a0432000-0000-0000-0000-0000000000a1', 'dark') $$,
  '23505', null, '0432/22: a second row for A is refused (one row per person)');
select lives_ok(
  $$ insert into public.user_appearance as u (user_id, appearance)
       values ('a0432000-0000-0000-0000-0000000000a1', 'light')
     on conflict (user_id) do update set appearance = excluded.appearance $$,
  '0432/23: the upsert the phone sends works on A''s own row');
select is(
  (select appearance from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000a1'),
  'light',
  '0432/24: the upsert stored the new value');
select throws_ok(
  $$ insert into public.user_appearance as u (user_id, appearance)
       values ('a0432000-0000-0000-0000-0000000000b1', 'light')
     on conflict (user_id) do update set appearance = excluded.appearance $$,
  '42501', null, '0432/25: an upsert naming B is refused, even though B''s row exists');
-- RLS hides B's row from the UPDATE, so it matches nothing and raises
-- nothing; 0432/30 checks B's row afterwards.
select lives_ok(
  $$ update public.user_appearance set appearance = 'liquid-glass'
      where user_id = 'a0432000-0000-0000-0000-0000000000b1' $$,
  '0432/26: an update aimed at B''s row is a silent no-op');
select throws_ok(
  $$ update public.user_appearance set user_id = 'a0432000-0000-0000-0000-0000000000c1'
      where user_id = 'a0432000-0000-0000-0000-0000000000a1' $$,
  '42501', null, '0432/27: A cannot hand their row to another person (WITH CHECK)');
select throws_ok(
  $$ update public.user_appearance set appearance = 'Liquid Glass'
      where user_id = 'a0432000-0000-0000-0000-0000000000a1' $$,
  '23514', null, '0432/28: A cannot store a value outside the four words');
select throws_ok(
  $$ delete from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000a1' $$,
  '42501', null, '0432/29: A cannot delete, not even their own row');

-- ── 5. Back as superuser: what actually happened ────────────────────────────
reset role;
select is(
  (select appearance from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000b1'),
  'dark',
  '0432/30: B''s row is untouched by everything A tried');
select is(
  (select count(*)::int from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000a1'),
  1,
  '0432/31: A still has exactly one row');

update public.user_appearance set appearance = 'system' where user_id = 'a0432000-0000-0000-0000-0000000000c1';
select is(
  (select updated_at from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000c1'),
  now(),
  '0432/32: an update moves updated_at to the time of the write');
select ok(
  (select updated_at > '2020-01-01 00:00:00+00'::timestamptz
     from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000c1'),
  '0432/33: and away from the seeded past value');

-- ── 6. The row goes with the account ────────────────────────────────────────
delete from auth.users where id = :userB;
select is(
  (select count(*)::int from public.user_appearance where user_id = 'a0432000-0000-0000-0000-0000000000b1'),
  0,
  '0432/34: deleting the account deletes its appearance row');
select is(
  (select count(*)::int from public.user_appearance where user_id in (
     'a0432000-0000-0000-0000-0000000000a1', 'a0432000-0000-0000-0000-0000000000c1')),
  2,
  '0432/35: and nobody else''s');

select * from finish();
rollback;
