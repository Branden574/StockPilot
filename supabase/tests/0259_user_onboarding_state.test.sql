-- supabase/tests/0259_user_onboarding_state.test.sql
-- pgTAP tests for migration 0259 — public.user_onboarding (one row per user,
-- backend-persisted onboarding/product-adoption state).
--
-- Covers:
--   1. Schema: table exists, user_id is the PK (enforces one-row-per-user),
--      the jsonb tour/announcement map columns exist.
--   2. One-row-per-user: a second insert with the same user_id violates the
--      PK (23505) even though RLS's WITH CHECK happily lets it through.
--   3. RLS: an authenticated user can read/write ONLY their own row —
--      can't read another user's row, can't insert a row for someone else,
--      and an UPDATE targeting another user's row is a silent RLS no-op.
--   4. The jsonb maps (completed_tours, dismissed_tours, viewed_announcements,
--      last_tour_state) accept keyed writes with no migration needed.
--   5. The updated_at trigger (tg_set_updated_at, shared/generic) bumps on
--      a real update — seeded with a fixed PAST value so any change is
--      unambiguous (mirrors the 0242 updated_at test convention: INSERT
--      does not fire the BEFORE UPDATE trigger, so the seed value sticks
--      until a real UPDATE runs).
--
-- Namespace a0259000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(20);

\set userA '\'a0259000-0000-0000-0000-0000000000a1\''
\set userB '\'a0259000-0000-0000-0000-0000000000b1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a-onboard@test.local', '{}'::jsonb),
  (:userB, 'b-onboard@test.local', '{}'::jsonb);

-- ── Fixtures: seed as superuser (RLS not active). A's row gets a fixed PAST
--    updated_at so the trigger-bump test later is unambiguous.
insert into public.user_onboarding (user_id, updated_at)
  values ('a0259000-0000-0000-0000-0000000000a1', '2020-01-01 00:00:00+00');
insert into public.user_onboarding (user_id)
  values ('a0259000-0000-0000-0000-0000000000b1');

-- ─────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────
select has_table('public', 'user_onboarding', 'user_onboarding table exists');
select col_is_pk('public', 'user_onboarding', 'user_id', 'user_id is the primary key (one row per user)');
select has_column('public', 'user_onboarding', 'completed_tours', 'has completed_tours');
select has_column('public', 'user_onboarding', 'dismissed_tours', 'has dismissed_tours');
select has_column('public', 'user_onboarding', 'viewed_announcements', 'has viewed_announcements');
select has_column('public', 'user_onboarding', 'last_tour_state', 'has last_tour_state');

-- ─────────────────────────────────────────────────────────────────────
-- Become user A (authenticated).
-- ─────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'a0259000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- One-row-per-user: RLS's WITH CHECK passes (it's A's own id) but the PK
-- constraint blocks the duplicate.
select throws_ok(
  $$ insert into public.user_onboarding (user_id) values ('a0259000-0000-0000-0000-0000000000a1') $$,
  '23505', null,
  'a second row for the same user_id violates the PK (one row per user)'
);

-- RLS read floor: A sees only their own row, not B's.
select is(
  (select count(*)::int from public.user_onboarding),
  1,
  'A sees exactly 1 row (their own) — B''s row is RLS-filtered out'
);
select is(
  (select count(*)::int from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000b1'),
  0,
  'A cannot read B''s row even by explicit id filter'
);

-- RLS write floor: A cannot insert a row attributed to B.
select throws_ok(
  $$ insert into public.user_onboarding (user_id) values ('a0259000-0000-0000-0000-0000000000b1') $$,
  '42501', null,
  'A cannot insert a row for another user (WITH CHECK blocks it)'
);

-- A's UPDATE targeting B's row matches zero visible rows — silent no-op, no error.
update public.user_onboarding set onboarding_version = 99
  where user_id = 'a0259000-0000-0000-0000-0000000000b1';

-- jsonb maps accept keyed writes with no new migration needed.
select lives_ok(
  $$ update public.user_onboarding
       set completed_tours = completed_tours || jsonb_build_object(
             'items-page', jsonb_build_object('v', 1, 'platform', 'web')
           )
     where user_id = 'a0259000-0000-0000-0000-0000000000a1' $$,
  'A can write a keyed value into completed_tours'
);
select lives_ok(
  $$ update public.user_onboarding
       set dismissed_tours = dismissed_tours || jsonb_build_object(
             'reorder-flow', jsonb_build_object('v', 1)
           )
     where user_id = 'a0259000-0000-0000-0000-0000000000a1' $$,
  'A can write a keyed value into dismissed_tours'
);
select lives_ok(
  $$ update public.user_onboarding
       set viewed_announcements = viewed_announcements || jsonb_build_object(
             'claim-picking', jsonb_build_object('v', 1, 'completedWalkthrough', true)
           )
     where user_id = 'a0259000-0000-0000-0000-0000000000a1' $$,
  'A can write a keyed value into viewed_announcements'
);
select lives_ok(
  $$ update public.user_onboarding
       set last_tour_state = jsonb_build_object('tourId', 'items-page', 'step', 3)
     where user_id = 'a0259000-0000-0000-0000-0000000000a1' $$,
  'A can write last_tour_state (mid-tour resume)'
);

reset role;

-- ─────────────────────────────────────────────────────────────────────
-- Verify persisted values (back as superuser to also see B's row).
-- ─────────────────────────────────────────────────────────────────────
select is(
  (select onboarding_version from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000b1'),
  1,
  'A''s no-op UPDATE attempt left B''s row untouched (RLS filtered the WHERE match)'
);
select is(
  (select completed_tours -> 'items-page' ->> 'platform'
     from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000a1'),
  'web',
  'completed_tours keyed value was actually stored'
);
select is(
  (select dismissed_tours -> 'reorder-flow' ->> 'v'
     from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000a1'),
  '1',
  'dismissed_tours keyed value was actually stored'
);
select is(
  (select viewed_announcements -> 'claim-picking' ->> 'completedWalkthrough'
     from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000a1'),
  'true',
  'viewed_announcements keyed value was actually stored'
);
select is(
  (select last_tour_state ->> 'step'
     from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000a1'),
  '3',
  'last_tour_state was actually stored'
);
select isnt(
  (select updated_at from public.user_onboarding where user_id = 'a0259000-0000-0000-0000-0000000000a1'),
  '2020-01-01 00:00:00+00'::timestamptz,
  'a real update bumps updated_at away from the seeded past value (tg_set_updated_at fired)'
);

select * from finish();
rollback;
