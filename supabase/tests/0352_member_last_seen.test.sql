-- supabase/tests/0352_member_last_seen.test.sql
-- Proves migration 0352: the per-organization "last seen" beacon, and the
-- fourth column it adds to platform_member_activity.
--
-- WHY THIS TEST EXISTS
--   touch_member_last_seen() is the first function in this feature that
--   `authenticated` may call and that WRITES. Its whole safety is its in-body
--   gate: a caller can stamp only themselves, only where they are a real
--   accepted member, never through an impersonation grant, never while
--   disabled. Section 3 attacks each of those; every refusal must be SILENT
--   (zero rows written, no error), because an error would tell a caller which
--   organization ids exist.
--
--   platform_member_activity() was DROPPED and recreated to gain a column. A
--   function recreated without its revoke is open to every signed-in user via
--   the public default ACL, so section 2 restates its posture from scratch.
--
-- HOW THE CALLER IS SIMULATED
--   As the test superuser with `set local "request.jwt.claim.sub"`, the 0331 /
--   0346 form. auth.uid() reads that claim, and the function is SECURITY
--   DEFINER, so the gate under test behaves exactly as it does for a real
--   caller. No role ever calls a function it is denied here: closed grants are
--   asserted through the catalog only (see the 0351 test header for why).
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(29);

\set orgA   '\'03520000-0000-0000-0000-00000000000a\''
\set orgB   '\'03520000-0000-0000-0000-00000000000b\''
\set orgNo  '\'03520000-0000-0000-0000-0000000000ee\''
\set uMem   '\'03520000-0000-0000-0000-0000000000a1\''
\set uOther '\'03520000-0000-0000-0000-0000000000a2\''
\set uInvit '\'03520000-0000-0000-0000-0000000000a3\''
\set uPlat  '\'03520000-0000-0000-0000-0000000000a4\''
\set uOff   '\'03520000-0000-0000-0000-0000000000a5\''
\set uGone  '\'03520000-0000-0000-0000-0000000000a6\''
\set uBoth  '\'03520000-0000-0000-0000-0000000000a7\''

insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at) values
  (:uMem,   'mem-0352@test.local',    '{}'::jsonb, now() - interval '60 days'),
  (:uOther, 'other-0352@test.local',  '{}'::jsonb, now() - interval '1 day'),
  (:uInvit, 'invite-0352@test.local', '{}'::jsonb, null),
  (:uPlat,  'plat-0352@test.local',   '{}'::jsonb, now()),
  (:uOff,   'off-0352@test.local',    '{}'::jsonb, now() - interval '2 days'),
  (:uGone,  'gone-0352@test.local',   '{}'::jsonb, now() - interval '3 days'),
  (:uBoth,  'both-0352@test.local',   '{}'::jsonb, now() - interval '9 days')
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Seen Org A 0352', 'seen-org-a-0352'),
  (:orgB, 'Seen Org B 0352', 'seen-org-b-0352')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :uMem,   'viewer', now()),
  (:orgA, :uInvit, 'viewer', null),
  (:orgA, :uOff,   'viewer', now()),
  (:orgA, :uGone,  'viewer', now()),
  (:orgB, :uOther, 'viewer', now()),
  (:orgA, :uBoth,  'viewer', now()),
  (:orgB, :uBoth,  'manager', now())
on conflict do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :uPlat, 'owner', now(), now() + interval '45 minutes')
on conflict do nothing;

-- ── 1. The table is sealed ──────────────────────────────────────────────────
select has_table('public', 'member_activity', '0352/1: member_activity exists');
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'member_activity'),
  '0352/2: RLS is enabled');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'member_activity'),
  0,
  '0352/3: and it has NO policies - nothing reads or writes it except the two functions');
select ok(
  not has_table_privilege('authenticated', 'public.member_activity', 'select')
  and not has_table_privilege('authenticated', 'public.member_activity', 'insert')
  and not has_table_privilege('authenticated', 'public.member_activity', 'update')
  and not has_table_privilege('anon', 'public.member_activity', 'select'),
  '0352/4: table privileges are revoked from anon and authenticated as well');

-- ── 2. Function posture ─────────────────────────────────────────────────────
select function_privs_are('public', 'touch_member_last_seen', array['uuid'], 'anon',
  array[]::text[], '0352/5: anon cannot execute the beacon');
select function_privs_are('public', 'touch_member_last_seen', array['uuid'], 'authenticated',
  array['EXECUTE'], '0352/6: authenticated can - it is how a signed-in client reports itself');
select ok(
  (select p.prosecdef
          and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
          and p.prosrc ~* 'auth\.uid'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_member_last_seen'),
  '0352/7: the beacon is SECURITY DEFINER, pins search_path, and gates on auth.uid() in its body (INV-25)');

select function_privs_are('public', 'platform_member_activity', array['uuid', 'uuid[]'], 'anon',
  array[]::text[], '0352/8: RECREATED platform_member_activity: anon still cannot execute it');
select function_privs_are('public', 'platform_member_activity', array['uuid', 'uuid[]'], 'authenticated',
  array[]::text[], '0352/9: authenticated still cannot - a drop/create silently reopens this through the default ACL');
select function_privs_are('public', 'platform_member_activity', array['uuid', 'uuid[]'], 'service_role',
  array['EXECUTE'], '0352/10: service_role still can');
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
          and p.prosecdef and p.provolatile = 's'
          and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'platform_member_activity'),
  '0352/11: its ACL is explicit with no PUBLIC entry; still SECURITY DEFINER, STABLE, search_path pinned');

-- ── 3. The gate ─────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to :uMem;
select lives_ok(
  format('select public.touch_member_last_seen(%L)', '03520000-0000-0000-0000-00000000000a'),
  '0352/12: a real member can stamp themselves');
select is(
  (select count(*)::int from public.member_activity where organization_id = :orgA and user_id = :uMem),
  1,
  '0352/13: and exactly one row exists for them');
select is(
  (select last_seen_at from public.member_activity where organization_id = :orgA and user_id = :uMem),
  now(),
  '0352/14: stamped with the current time');

-- A member of A asks to be stamped in B, and in an organization that does not exist.
select lives_ok(
  format('select public.touch_member_last_seen(%L)', '03520000-0000-0000-0000-00000000000b'),
  '0352/15: stamping an organization you do not belong to does not raise');
select lives_ok(
  format('select public.touch_member_last_seen(%L)', '03520000-0000-0000-0000-0000000000ee'),
  '0352/16: nor does an organization that does not exist - the two are indistinguishable to the caller');
select is(
  (select count(*)::int from public.member_activity where user_id = :uMem and organization_id <> :orgA),
  0,
  '0352/17: and neither wrote anything');

set local "request.jwt.claim.sub" to :uInvit;
select public.touch_member_last_seen(:orgA);
set local "request.jwt.claim.sub" to :uPlat;
select public.touch_member_last_seen(:orgA);
set local "request.jwt.claim.sub" to '';
select public.touch_member_last_seen(:orgA);
select public.touch_member_last_seen(null::uuid);
select is(
  (select count(*)::int from public.member_activity where organization_id = :orgA),
  1,
  '0352/18: a pending invite, an impersonation grant, a caller with no identity and a null organization all write nothing');

-- A disabled account, disabled exactly the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :uOff;
reset role;
set local "request.jwt.claim.sub" to :uOff;
select public.touch_member_last_seen(:orgA);
select is(
  (select count(*)::int from public.member_activity where user_id = :uOff),
  0,
  '0352/19: a disabled account cannot stamp itself');

-- ── 4. The throttle lives in the database too ───────────────────────────────
-- Age the row directly (superuser), then stamp again as the member.
set local "request.jwt.claim.sub" to :uMem;
update public.member_activity set last_seen_at = now() - interval '4 minutes'
 where organization_id = :orgA and user_id = :uMem;
select public.touch_member_last_seen(:orgA);
select is(
  (select last_seen_at from public.member_activity where organization_id = :orgA and user_id = :uMem),
  now() - interval '4 minutes',
  '0352/20: a stamp younger than five minutes is left alone');
update public.member_activity set last_seen_at = now() - interval '6 minutes'
 where organization_id = :orgA and user_id = :uMem;
select public.touch_member_last_seen(:orgA);
select is(
  (select last_seen_at from public.member_activity where organization_id = :orgA and user_id = :uMem),
  now(),
  '0352/21: an older one is refreshed');

-- ── 5. The platform console reads it, scoped like everything else ───────────
set local "request.jwt.claim.sub" to '';
update public.member_activity set last_seen_at = now() - interval '2 hours'
 where organization_id = :orgA and user_id = :uMem;

set local role to 'service_role';
select is(
  (select last_seen_at from public.platform_member_activity(:orgA, array[:uMem]::uuid[])),
  now() - interval '2 hours',
  '0352/22: platform_member_activity returns last_seen_at for the member');
select is(
  (select last_sign_in_at from public.platform_member_activity(:orgA, array[:uMem]::uuid[])),
  now() - interval '60 days',
  '0352/23: alongside the 0351 signals, unchanged');
select is(
  (select last_seen_at from public.platform_member_activity(:orgA, array[:uGone]::uuid[])),
  null::timestamptz,
  '0352/24: a member the app has never reported is null, not a guess');
select is(
  (select count(*)::int from public.platform_member_activity(:orgA, array[:uPlat]::uuid[])),
  0,
  '0352/25: the impersonation grant is still not a member');

-- One person, two organizations, two different stamps. The stamp is the only
-- one of the four signals besides the audit leg that is per ORGANIZATION, which
-- is the point of it: each console view must get its own.
reset role;
insert into public.member_activity (organization_id, user_id, last_seen_at) values
  (:orgA, :uBoth, now() - interval '3 hours'),
  (:orgB, :uBoth, now() - interval '10 minutes');
set local role to 'service_role';
select is(
  (select last_seen_at from public.platform_member_activity(:orgA, array[:uBoth]::uuid[])),
  now() - interval '3 hours',
  '0352/26: a person in two organizations shows organization A''s stamp in A');
select is(
  (select last_seen_at from public.platform_member_activity(:orgB, array[:uBoth]::uuid[])),
  now() - interval '10 minutes',
  '0352/27: and organization B''s stamp in B');
reset role;

-- ── 6. Removing a member removes their activity ─────────────────────────────
set local "request.jwt.claim.sub" to :uGone;
select public.touch_member_last_seen(:orgA);
set local "request.jwt.claim.sub" to '';
select is(
  (select count(*)::int from public.member_activity where user_id = :uGone), 1,
  '0352/28: (setup) the departing member has a row');
delete from public.organization_members where organization_id = :orgA and user_id = :uGone;
select is(
  (select count(*)::int from public.member_activity where user_id = :uGone), 0,
  '0352/29: and it goes with the membership, with no code');

select * from finish();
rollback;
