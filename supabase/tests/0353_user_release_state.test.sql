-- supabase/tests/0353_user_release_state.test.sql
-- Proves migration 0353: per-person release state (dismissed / opened / read),
-- its own-row RLS, the one writer record_release_state(), and the backfill.
--
-- WHAT IS WORTH PINNING
--   1. DISMISSING IS NOT READING. The whole reason for a table over the old
--      single "seen" flag. A closed popup must leave the release unread.
--   2. A person can only ever touch their own rows, including through the
--      function, which is SECURITY INVOKER and therefore has no power of its own.
--   3. Revisions: first write wins within one; a newer one clears the older
--      stamps; a stale tab reporting an older one is ignored.
--   4. The backfill marks exactly the legacy announcements a person had already
--      seen, tolerates every shape that map has ever held, and never overwrites.
--
-- The backfill section re-runs the migration's own INSERT, because pgTAP runs
-- after migrations: a user seeded here did not exist when 0353 ran.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(32);

\set userA '\'a0353000-0000-0000-0000-0000000000a1\''
\set userB '\'a0353000-0000-0000-0000-0000000000b1\''
\set userC '\'a0353000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a-release@test.local', '{}'::jsonb),
  (:userB, 'b-release@test.local', '{}'::jsonb),
  (:userC, 'c-release@test.local', '{}'::jsonb);

-- B already has a row (seeded as superuser) so A has something to fail to see.
insert into public.user_release_state (user_id, release_id, revision, opened_at, read_at)
  values (:userB, 'b-only-release', 1, '2026-05-05 00:00:00+00', '2026-05-05 00:00:00+00');

-- ── 1. Structure and posture ────────────────────────────────────────────────
select has_table('public', 'user_release_state', '0353/1: table exists');
select col_is_pk('public', 'user_release_state', array['user_id', 'release_id'], '0353/2: one row per person per release');
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_release_state'),
  '0353/3: RLS is enabled');
select is(
  (select array_agg(policyname::text order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'user_release_state'),
  array['user_release_state_insert', 'user_release_state_select', 'user_release_state_update'],
  '0353/4: exactly select, insert and update policies - there is no delete policy');
select ok(
  not has_table_privilege('anon', 'public.user_release_state', 'select')
  and not has_table_privilege('authenticated', 'public.user_release_state', 'delete')
  and not has_table_privilege('authenticated', 'public.user_release_state', 'truncate'),
  '0353/5: anon has nothing; authenticated cannot delete or truncate');
select function_privs_are('public', 'record_release_state', array['text', 'integer', 'text'], 'anon',
  array[]::text[], '0353/6: anon cannot execute the writer');
select function_privs_are('public', 'record_release_state', array['text', 'integer', 'text'], 'authenticated',
  array['EXECUTE'], '0353/7: authenticated can');
select ok(
  (select not p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_release_state'),
  '0353/8: the writer is SECURITY INVOKER (RLS authorizes it) and pins search_path');

-- ── 2. Become user A ────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'a0353000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.user_release_state),
  0,
  '0353/9: A sees none of B''s rows');

-- Dismissing is not reading.
select lives_ok($$ select public.record_release_state('september-2026', 1, 'dismiss') $$, '0353/10: A can dismiss a notification');
select ok(
  (select dismissed_at is not null and opened_at is null and read_at is null
     from public.user_release_state where release_id = 'september-2026'),
  '0353/11: DISMISSING IS NOT READING - only dismissed_at is set');

select public.record_release_state('september-2026', 1, 'open');
select ok(
  (select dismissed_at is not null and opened_at is not null and read_at is null
     from public.user_release_state where release_id = 'september-2026'),
  '0353/12: opening sets opened_at, keeps the dismissal, and still is not reading');

select public.record_release_state('september-2026', 1, 'read');
select ok(
  (select read_at is not null and opened_at is not null
     from public.user_release_state where release_id = 'september-2026'),
  '0353/13: reading sets read_at');
select is(
  (select count(*)::int from public.user_release_state where release_id = 'september-2026'),
  1,
  '0353/14: three transitions, still one row');

-- A release read without ever being opened still satisfies read-implies-opened.
select public.record_release_state('read-directly', 1, 'read');
select ok(
  (select read_at is not null and opened_at is not null from public.user_release_state where release_id = 'read-directly'),
  '0353/15: a direct read records the open as well');

-- First write wins within a revision.
reset role;
update public.user_release_state set read_at = '2026-01-01 00:00:00+00', opened_at = '2026-01-01 00:00:00+00'
 where user_id = :userA and release_id = 'september-2026';
set local role to 'authenticated';
select public.record_release_state('september-2026', 1, 'read');
select is(
  (select read_at from public.user_release_state where release_id = 'september-2026'),
  '2026-01-01 00:00:00+00'::timestamptz,
  '0353/16: reading again at the same revision keeps the ORIGINAL read time');

-- A deliberate re-announcement (revision 2) clears the older stamps.
select public.record_release_state('september-2026', 2, 'dismiss');
select ok(
  (select revision = 2 and dismissed_at is not null and opened_at is null and read_at is null
     from public.user_release_state where release_id = 'september-2026'),
  '0353/17: a newer revision clears the stamps taken against the older one - it is unread again');

-- A stale tab still on revision 1 must not be able to mark revision 2 read.
select public.record_release_state('september-2026', 1, 'read');
select ok(
  (select revision = 2 and read_at is null from public.user_release_state where release_id = 'september-2026'),
  '0353/18: a report against an OLDER revision is ignored');

-- Reading stamps the legacy map for mobile, once, without clobbering other keys.
select ok(
  (select viewed_announcements ? 'read-directly' and viewed_announcements -> 'read-directly' ->> 'outcome' = 'seen'
     from public.user_onboarding where user_id = :userA),
  '0353/19: reading also stamps the legacy viewed_announcements key, so a phone does not re-announce it');
reset role;
update public.user_onboarding
   set viewed_announcements = viewed_announcements || '{"kept":{"at":"2026-02-02T00:00:00Z","outcome":"dismissed"},"another-release":{"at":"2026-03-03T00:00:00Z","outcome":"dismissed"}}'::jsonb
 where user_id = :userA;
set local role to 'authenticated';
select public.record_release_state('another-release', 1, 'read');
select ok(
  (select viewed_announcements -> 'kept' ->> 'outcome' = 'dismissed'
          and viewed_announcements -> 'another-release' ->> 'at' = '2026-03-03T00:00:00Z'
     from public.user_onboarding where user_id = :userA),
  '0353/20: the merge touches only its own key, and never overwrites one already there (first write wins)');
select ok(
  (select not (viewed_announcements ? 'dismissed-only') from public.user_onboarding where user_id = :userA),
  '0353/21: (control) a release that was never read has no legacy key');

-- Bad input.
select throws_ok($$ select public.record_release_state('september-2026', 1, 'unread') $$, '22023', null,
  '0353/22: an unknown action is refused');
select throws_ok($$ select public.record_release_state('../etc/passwd', 1, 'read') $$, '23514', null,
  '0353/23: a release id that is not a slug is refused by the table');
select throws_ok($$ select public.record_release_state('september-2026', 0, 'read') $$, '23514', null,
  '0353/24: a revision below 1 is refused');

-- A cannot write a row for B, with or without the function.
select throws_ok(
  $$ insert into public.user_release_state (user_id, release_id) values ('a0353000-0000-0000-0000-0000000000b1', 'forged') $$,
  '42501', null,
  '0353/25: A cannot insert a row for B');
select lives_ok(
  $$ update public.user_release_state set read_at = now(), opened_at = now()
      where user_id = 'a0353000-0000-0000-0000-0000000000b1' $$,
  '0353/26: A''s update aimed at B''s row does not raise - RLS simply matches nothing');

reset role;
select ok(
  (select count(*) = 1 and bool_and(read_at = '2026-05-05 00:00:00+00'::timestamptz)
     from public.user_release_state where user_id = :userB),
  '0353/27: and B''s data is exactly as it was');

-- No identity at all.
set local "request.jwt.claim.sub" to '';
set local role to 'authenticated';
select throws_ok($$ select public.record_release_state('september-2026', 1, 'read') $$, '28000', null,
  '0353/28: a caller with no identity is refused');
reset role;

-- ── 3. The backfill, replayed for a user seeded in this test ────────────────
--
-- The map is user-writable text. Two of these values LOOK like timestamps and
-- fail the cast; before the handler existed, either one aborted the migration.
insert into public.user_onboarding (user_id, viewed_announcements, updated_at) values
  (:userC,
   '{"backorders-2026-07": {"at": "2026-07-09T15:00:00.000Z", "outcome": "seen"},
     "order-numbers-2026-07": {"v": 1, "completedWalkthrough": true},
     "support-feedback-2026-07": true,
     "schedule-reminders-2026-07": {"at": "2026-13-45T25:61", "outcome": "seen"},
     "onboarding-tours-2026-07": {"at": "2026-07-09T15:00 and then junk", "outcome": "seen"},
     "not-a-legacy-release": {"at": "2026-07-01T00:00:00.000Z", "outcome": "seen"}}'::jsonb,
   '2026-08-01 12:00:00+00')
on conflict (user_id) do update set viewed_announcements = excluded.viewed_announcements, updated_at = excluded.updated_at;

create function pg_temp.release_backfill_ts(p_text text)
returns timestamptz
language plpgsql
immutable
as $fn$
begin
  return p_text::timestamptz;
exception when others then
  return null;
end;
$fn$;

select lives_ok($bf$
  insert into public.user_release_state (user_id, release_id, revision, opened_at, read_at)
  select o.user_id, legacy.id, 1, seen.at, seen.at
    from public.user_onboarding o
   cross join (values
     ('maintenance-requests-2026-08'), ('support-feedback-2026-07'), ('onboarding-tours-2026-07'),
     ('schedule-reminders-2026-07'), ('order-numbers-2026-07'), ('backorders-2026-07')
   ) as legacy(id)
   cross join lateral (
     select coalesce(
              case when jsonb_typeof(o.viewed_announcements -> legacy.id) = 'object'
                   then pg_temp.release_backfill_ts(o.viewed_announcements -> legacy.id ->> 'at')
              end,
              o.updated_at,
              now()
            ) as at
   ) seen
   where jsonb_typeof(o.viewed_announcements) = 'object'
     and o.viewed_announcements ? legacy.id
     and o.user_id = 'a0353000-0000-0000-0000-0000000000c1'
  on conflict (user_id, release_id) do nothing
$bf$, '0353/29: the backfill survives an "at" that looks like a timestamp and is not one');

select is(
  (select array_agg(release_id order by release_id) from public.user_release_state where user_id = :userC),
  array['backorders-2026-07', 'onboarding-tours-2026-07', 'order-numbers-2026-07',
        'schedule-reminders-2026-07', 'support-feedback-2026-07'],
  '0353/30: backfill marks exactly the LEGACY announcements already seen - not the unseen ones, not unknown ids');
select ok(
  (select (select read_at from public.user_release_state where user_id = :userC and release_id = 'backorders-2026-07') = '2026-07-09 15:00:00+00'::timestamptz
      and (select read_at from public.user_release_state where user_id = :userC and release_id = 'order-numbers-2026-07') = '2026-08-01 12:00:00+00'::timestamptz
      and (select read_at from public.user_release_state where user_id = :userC and release_id = 'support-feedback-2026-07') = '2026-08-01 12:00:00+00'::timestamptz),
  '0353/31: it keeps the time they saw it, and tolerates every shape that map has held (no "at", a bare true)');
select ok(
  (select (select read_at from public.user_release_state where user_id = :userC and release_id = 'schedule-reminders-2026-07') = '2026-08-01 12:00:00+00'::timestamptz
      and (select read_at from public.user_release_state where user_id = :userC and release_id = 'onboarding-tours-2026-07') = '2026-08-01 12:00:00+00'::timestamptz),
  '0353/32: an unparseable time falls back to the row''s updated_at instead of failing');

select * from finish();
rollback;
