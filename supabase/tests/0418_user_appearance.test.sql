-- supabase/tests/0418_user_appearance.test.sql
-- Proves migration 0418 (placeholder number): public.user_appearance, one
-- row per person holding their chosen Design (style) and Theme.
--
-- WHAT IS WORTH PINNING
--   1. A person can only ever read and write their own row: another person's
--      row is invisible, cannot be inserted, updated or taken over (changing
--      user_id), and a signed-out caller has no privilege at all.
--   2. Only the known words are stored (two CHECKs): style is 'liquid-glass'
--      or 'classic', theme is 'light', 'dark' or 'system', never a label such
--      as 'Liquid Glass', the other column's word, an empty string or another
--      case. Each column may be null (not chosen), but never both (a third
--      CHECK).
--   3. A save names only the column the person chose: an upsert of one column
--      leaves the other as it was, so a Theme save never clears a Design.
--   4. No delete for a signed-in caller (no policy and no privilege); the row
--      goes with the account (ON DELETE CASCADE).
--   5. updated_at is the reconcile clock: the update trigger moves it, and the
--      apps' upsert (insert ... on conflict do update) works under RLS.
--   6. The privileges are exactly what the migration grants (D1 rule).
--
-- Namespace a0418000. Wrapped in begin/rollback: nothing leaks.
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(51);

\set userA '\'a0418000-0000-0000-0000-0000000000a1\''
\set userB '\'a0418000-0000-0000-0000-0000000000b1\''
\set userC '\'a0418000-0000-0000-0000-0000000000c1\''
\set userD '\'a0418000-0000-0000-0000-0000000000d1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a-appearance@test.local', '{}'::jsonb),
  (:userB, 'b-appearance@test.local', '{}'::jsonb),
  (:userC, 'c-appearance@test.local', '{}'::jsonb),
  (:userD, 'd-appearance@test.local', '{}'::jsonb);

-- Seeded as superuser (RLS not active). B's row gives A something to fail to
-- see; C's row has a fixed PAST updated_at so the trigger test is unambiguous
-- (INSERT does not fire the BEFORE UPDATE trigger, so the seed value sticks).
-- D is used only for the CHECK tests and keeps no row.
insert into public.user_appearance (user_id, style, theme) values (:userB, 'classic', 'dark');
insert into public.user_appearance (user_id, theme, updated_at)
  values (:userC, 'light', '2020-01-01 00:00:00+00');

-- ── 1. Structure and posture ────────────────────────────────────────────────
select has_table('public', 'user_appearance', '0418/1: table exists');
select col_is_pk('public', 'user_appearance', 'user_id', '0418/2: one row per person');
select columns_are('public', 'user_appearance', array['user_id', 'style', 'theme', 'updated_at'],
  '0418/3: exactly user_id, style, theme and updated_at (no single appearance column)');
select col_is_null('public', 'user_appearance', 'style', '0418/4: style may be null (not chosen)');
select col_is_null('public', 'user_appearance', 'theme', '0418/5: theme may be null (not chosen)');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid = 'public.user_appearance'::regclass and contype = 'c'),
  array['user_appearance_something_chosen', 'user_appearance_style_known', 'user_appearance_theme_known'],
  '0418/6: exactly the three CHECKs');
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_appearance'),
  '0418/7: RLS is enabled');
select is(
  (select array_agg(policyname::text order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'user_appearance'),
  array['user_appearance_insert', 'user_appearance_select', 'user_appearance_update'],
  '0418/8: exactly select, insert and update policies; there is no delete policy');
select is(
  (select array_agg(distinct r order by r) from pg_policies, unnest(roles) r
    where schemaname = 'public' and tablename = 'user_appearance'),
  array['authenticated']::name[],
  '0418/9: every policy is for authenticated only');
select table_privs_are('public', 'user_appearance', 'anon', array[]::text[],
  '0418/10: anon has no privilege at all');
select table_privs_are('public', 'user_appearance', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'],
  '0418/11: authenticated has select, insert and update only (no delete, truncate, references, trigger)');
select ok(
  has_table_privilege('service_role', 'public.user_appearance', 'select')
  and has_table_privilege('service_role', 'public.user_appearance', 'insert')
  and has_table_privilege('service_role', 'public.user_appearance', 'update')
  and has_table_privilege('service_role', 'public.user_appearance', 'delete'),
  '0418/12: service_role has select, insert, update and delete');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.user_appearance'::regclass and contype = 'f'
      and confrelid = 'auth.users'::regclass),
  'c',
  '0418/13: user_id cascades from auth.users');
select is(
  (select array_agg(t.tgname::text) from pg_trigger t
    where t.tgrelid = 'public.user_appearance'::regclass and not t.tgisinternal),
  array['user_appearance_touch_updated_at'],
  '0418/14: the one trigger is the shared updated_at touch');
select ok(
  (select p.proname = 'tg_set_updated_at' and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16 and (t.tgtype & 4) = 0
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.user_appearance'::regclass and t.tgname = 'user_appearance_touch_updated_at'),
  '0418/15: it runs tg_set_updated_at BEFORE UPDATE (not on insert)');

-- ── 2. The CHECKs: only the known words, and something chosen ───────────────
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000d1', 'Liquid Glass') $$,
  '23514', null, '0418/16: a display label is refused as a style');
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000d1', 'CLASSIC') $$,
  '23514', null, '0418/17: a different case is refused as a style');
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000d1', 'dark') $$,
  '23514', null, '0418/18: a theme word is refused as a style');
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000d1', '') $$,
  '23514', null, '0418/19: an empty string is refused as a style');
select throws_ok(
  $$ insert into public.user_appearance (user_id, theme) values ('a0418000-0000-0000-0000-0000000000d1', 'Dark') $$,
  '23514', null, '0418/20: a different case is refused as a theme');
select throws_ok(
  $$ insert into public.user_appearance (user_id, theme) values ('a0418000-0000-0000-0000-0000000000d1', 'liquid-glass') $$,
  '23514', null, '0418/21: a style word is refused as a theme');
select throws_ok(
  $$ insert into public.user_appearance (user_id, theme) values ('a0418000-0000-0000-0000-0000000000d1', 'auto') $$,
  '23514', null, '0418/22: an unknown word is refused as a theme');
select throws_ok(
  $$ insert into public.user_appearance (user_id) values ('a0418000-0000-0000-0000-0000000000d1') $$,
  '23514', null, '0418/23: a row with neither a style nor a theme is refused');
select throws_ok(
  $$ insert into public.user_appearance (user_id, style, theme) values ('a0418000-0000-0000-0000-0000000000d1', null, null) $$,
  '23514', null, '0418/24: and so are two explicit nulls');
select lives_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000d1', 'liquid-glass') $$,
  '0418/25: a style alone is stored');
delete from public.user_appearance where user_id = :userD;
select lives_ok(
  $$ insert into public.user_appearance (user_id, theme) values ('a0418000-0000-0000-0000-0000000000d1', 'system') $$,
  '0418/26: a theme alone is stored');
delete from public.user_appearance where user_id = :userD;
select lives_ok(
  $$ insert into public.user_appearance (user_id, style, theme) values ('a0418000-0000-0000-0000-0000000000d1', 'classic', 'light') $$,
  '0418/27: both together are stored');
delete from public.user_appearance where user_id = :userD;
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000ff', 'classic') $$,
  '23503', null, '0418/28: a row for a person who does not exist is refused');

-- ── 3. Signed out: nothing ──────────────────────────────────────────────────
set local role to 'anon';
select throws_ok(
  $$ select count(*) from public.user_appearance $$,
  '42501', null, '0418/29: anon cannot read the table');
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000a1', 'classic') $$,
  '42501', null, '0418/30: anon cannot write the table');
reset role;

-- ── 4. Become user A ────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'a0418000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.user_appearance),
  0,
  '0418/31: A sees none of B''s or C''s rows');
select throws_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000b1', 'liquid-glass') $$,
  '42501', null, '0418/32: A cannot insert a row for B');
select lives_ok(
  $$ insert into public.user_appearance (user_id, style) values ('a0418000-0000-0000-0000-0000000000a1', 'liquid-glass') $$,
  '0418/33: A can insert their own row, Design only');
select throws_ok(
  $$ insert into public.user_appearance (user_id, theme) values ('a0418000-0000-0000-0000-0000000000a1', 'dark') $$,
  '23505', null, '0418/34: a second row for A is refused (one row per person)');
-- The apps' upsert names only the column the person chose (PostgREST's merge
-- upsert updates exactly the payload's columns).
select lives_ok(
  $$ insert into public.user_appearance as u (user_id, theme)
       values ('a0418000-0000-0000-0000-0000000000a1', 'dark')
     on conflict (user_id) do update set theme = excluded.theme $$,
  '0418/35: a Theme-only upsert works on A''s own row');
select is(
  (select style || ' / ' || theme from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000a1'),
  'liquid-glass / dark',
  '0418/36: the Theme save kept the Design');
select lives_ok(
  $$ insert into public.user_appearance as u (user_id, style)
       values ('a0418000-0000-0000-0000-0000000000a1', 'classic')
     on conflict (user_id) do update set style = excluded.style $$,
  '0418/37: a Design-only upsert works on A''s own row');
select is(
  (select style || ' / ' || theme from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000a1'),
  'classic / dark',
  '0418/38: the Design save kept the Theme');
select throws_ok(
  $$ insert into public.user_appearance as u (user_id, style)
       values ('a0418000-0000-0000-0000-0000000000b1', 'liquid-glass')
     on conflict (user_id) do update set style = excluded.style $$,
  '42501', null, '0418/39: an upsert naming B is refused, even though B''s row exists');
-- RLS hides B's row from the UPDATE, so it matches nothing and raises
-- nothing; 0418/46 checks B's row afterwards.
select lives_ok(
  $$ update public.user_appearance set style = 'liquid-glass', theme = 'light'
      where user_id = 'a0418000-0000-0000-0000-0000000000b1' $$,
  '0418/40: an update aimed at B''s row is a silent no-op');
select throws_ok(
  $$ update public.user_appearance set user_id = 'a0418000-0000-0000-0000-0000000000c1'
      where user_id = 'a0418000-0000-0000-0000-0000000000a1' $$,
  '42501', null, '0418/41: A cannot hand their row to another person (WITH CHECK)');
select throws_ok(
  $$ update public.user_appearance set style = 'Liquid Glass'
      where user_id = 'a0418000-0000-0000-0000-0000000000a1' $$,
  '23514', null, '0418/42: A cannot store a style outside the two words');
select throws_ok(
  $$ update public.user_appearance set theme = 'Dark'
      where user_id = 'a0418000-0000-0000-0000-0000000000a1' $$,
  '23514', null, '0418/43: A cannot store a theme outside the three words');
select throws_ok(
  $$ update public.user_appearance set style = null, theme = null
      where user_id = 'a0418000-0000-0000-0000-0000000000a1' $$,
  '23514', null, '0418/44: A cannot empty both columns');
select throws_ok(
  $$ delete from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000a1' $$,
  '42501', null, '0418/45: A cannot delete, not even their own row');

-- ── 5. Back as superuser: what actually happened ────────────────────────────
reset role;
select is(
  (select style || ' / ' || theme from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000b1'),
  'classic / dark',
  '0418/46: B''s row is untouched by everything A tried');
select is(
  (select count(*)::int from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000a1'),
  1,
  '0418/47: A still has exactly one row');

update public.user_appearance set style = 'liquid-glass' where user_id = 'a0418000-0000-0000-0000-0000000000c1';
select is(
  (select updated_at from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000c1'),
  now(),
  '0418/48: an update moves updated_at to the time of the write');
select ok(
  (select updated_at > '2020-01-01 00:00:00+00'::timestamptz
     from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000c1'),
  '0418/49: and away from the seeded past value');

-- ── 6. The row goes with the account ────────────────────────────────────────
delete from auth.users where id = :userB;
select is(
  (select count(*)::int from public.user_appearance where user_id = 'a0418000-0000-0000-0000-0000000000b1'),
  0,
  '0418/50: deleting the account deletes its appearance row');
select is(
  (select count(*)::int from public.user_appearance where user_id in (
     'a0418000-0000-0000-0000-0000000000a1', 'a0418000-0000-0000-0000-0000000000c1')),
  2,
  '0418/51: and nobody else''s');

select * from finish();
rollback;
