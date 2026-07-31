-- supabase/tests/0311_restrict_disable_reason_visibility.test.sql
-- Pins migration 0311: an org-mate may still read the columns the product needs
-- off user_profiles, but NOT the operator-only disable reason or the identity of
-- the platform admin who disabled the account.
--
-- ── WHAT THIS FILE IS DEFENDING ────────────────────────────────────────────
-- 0308 added disabled_at / disabled_reason / disabled_by to user_profiles, a
-- table whose 0003 policy `user_profiles_select_orgmates` returns the WHOLE row
-- to anyone sharing an organization. RLS is row-level, so the reason and the
-- god-admin's uid rode along. Reproduced before the fix as a plain `staff`
-- member reading a colleague's row.
--
-- ── THE ASSERTION THAT MATTERS MOST IS THE POSITIVE ONE ────────────────────
-- Section 2 asserts authenticated KEEPS SELECT on disabled_at. That is not
-- symmetry for its own sake: all five enforcement funnels read disabled_at with
-- the USER's own client (loadAccountStatus / the session select, both asking for
-- ACCOUNT_STATUS_COLUMNS = 'disabled_at'), and the guard fails CLOSED. Revoking
-- disabled_at would not weaken the guard — it would lock every user out of the
-- product. If a future migration narrows this further, section 2 is the tripwire.
--
-- ── SECTION 3 IS A MAINTENANCE TRIPWIRE, NOT A TAUTOLOGY ───────────────────
-- 0311 had to DROP the table-level SELECT grant and re-grant an enumerated list,
-- because a bare `revoke select (col)` cannot subtract from a table-level grant
-- and is a silent no-op. The consequence: a column added to user_profiles later
-- is NOT readable by authenticated/anon until someone adds it to that list, and
-- `select *` ERRORS rather than quietly omitting it. Section 3 pins the exact
-- expected set so that lands as a red test naming the decision, rather than as a
-- production read that fails at 3am.
--
-- Wrapped in begin/rollback — nothing leaks. Namespace 03111111.

begin;

select plan(27);

\set org    '\'03111111-0000-0000-0000-000000000001\''
\set u_dis  '\'03111111-0000-0000-0000-0000000000a1\''
\set u_peer '\'03111111-0000-0000-0000-0000000000a2\''
\set u_gadm '\'03111111-0000-0000-0000-0000000000a3\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_dis,  'subject@ad11.test', '{"full_name":"Disabled Subject"}'::jsonb),
  (:u_peer, 'peer@ad11.test',    '{"full_name":"Ordinary Colleague"}'::jsonb),
  (:u_gadm, 'god@ad11.test',     '{"full_name":"Platform Admin"}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan)
values (:org, 'AD11 Org', 'ad11-org', 'UTC', 'USD', 'pro');

-- The reader is a plain `staff` member: no admin rights, no permissions beyond
-- the floor. If THIS user can read the reason, so can everyone.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :u_dis,  'manager', now()),
  (:org, :u_peer, 'staff',   now());

-- Exactly what the disable service writes through createAdminClient (0308 §1).
update public.user_profiles
   set disabled_at     = now(),
       disabled_reason = 'Suspected account compromise - notes: pending SOC review',
       disabled_by     = :u_gadm
 where id = :u_dis;

-- ── 1. The two operator-only columns are unreadable by the request roles ────
select ok(not has_column_privilege('authenticated', 'public.user_profiles', 'disabled_reason', 'SELECT'),
  'authenticated has NO SELECT on disabled_reason');
select ok(not has_column_privilege('authenticated', 'public.user_profiles', 'disabled_by', 'SELECT'),
  'authenticated has NO SELECT on disabled_by');
select ok(not has_column_privilege('anon', 'public.user_profiles', 'disabled_reason', 'SELECT'),
  'anon has NO SELECT on disabled_reason');
select ok(not has_column_privilege('anon', 'public.user_profiles', 'disabled_by', 'SELECT'),
  'anon has NO SELECT on disabled_by');

-- service_role is the platform console's client (createAdminClient) and must
-- keep full visibility — the fix must not blind the operator.
select ok(has_column_privilege('service_role', 'public.user_profiles', 'disabled_reason', 'SELECT'),
  'service_role RETAINS SELECT on disabled_reason');
select ok(has_column_privilege('service_role', 'public.user_profiles', 'disabled_by', 'SELECT'),
  'service_role RETAINS SELECT on disabled_by');

-- ── 2. The columns the product genuinely needs are RETAINED ────────────────
-- disabled_at first and by name: this is the load-bearing one.
select ok(has_column_privilege('authenticated', 'public.user_profiles', 'disabled_at', 'SELECT'),
  'authenticated KEEPS SELECT on disabled_at — all five enforcement funnels read it with the USER client');
select ok(has_column_privilege('authenticated', 'public.user_profiles', 'id', 'SELECT'),
  'authenticated KEEPS SELECT on id');
select ok(has_column_privilege('authenticated', 'public.user_profiles', 'full_name', 'SELECT'),
  'authenticated KEEPS SELECT on full_name');
select ok(has_column_privilege('authenticated', 'public.user_profiles', 'avatar_url', 'SELECT'),
  'authenticated KEEPS SELECT on avatar_url');
select ok(has_column_privilege('authenticated', 'public.user_profiles', 'email', 'SELECT'),
  'authenticated KEEPS SELECT on email');
select ok(has_column_privilege('anon', 'public.user_profiles', 'disabled_at', 'SELECT'),
  'anon KEEPS SELECT on disabled_at');
select ok(has_column_privilege('service_role', 'public.user_profiles', 'disabled_at', 'SELECT'),
  'service_role KEEPS SELECT on disabled_at');

-- ── 3. The exact readable column set, pinned ───────────────────────────────
select is(
  (select array_agg(c.column_name::text order by c.ordinal_position)
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'user_profiles'
      and has_column_privilege('authenticated', 'public.user_profiles', c.column_name, 'SELECT')),
  array['id','email','full_name','avatar_url','default_organization_id','created_at',
        'updated_at','email_digest_optin','digest_section_low_stock','digest_section_open_pos',
        'digest_section_cycle_counts','deleted_at','onboarding_dismissed_at','disabled_at'],
  'authenticated reads EXACTLY the 14 non-operator columns (add a column? decide here, then update 0311)'
);
select is(
  (select array_agg(c.column_name::text order by c.ordinal_position)
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'user_profiles'
      and has_column_privilege('anon', 'public.user_profiles', c.column_name, 'SELECT')),
  array['id','email','full_name','avatar_url','default_organization_id','created_at',
        'updated_at','email_digest_optin','digest_section_low_stock','digest_section_open_pos',
        'digest_section_cycle_counts','deleted_at','onboarding_dismissed_at','disabled_at'],
  'anon reads EXACTLY the same 14 columns'
);
select is(
  (select count(*)::int
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'user_profiles'
      and has_column_privilege('service_role', 'public.user_profiles', c.column_name, 'SELECT')),
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles'),
  'service_role reads EVERY column'
);

-- ── 4. Behaviour: the ordinary org-mate ────────────────────────────────────
set local "request.jwt.claim.sub"  to '03111111-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- The colleague is still a colleague: the legitimate profile read is unchanged.
select is(
  (select full_name from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a1'),
  'Disabled Subject',
  'org-mate still reads the peer profile columns the UI needs'
);
-- Knowing THAT an account is disabled is not the leak; knowing WHY is.
select ok(
  (select disabled_at is not null from public.user_profiles
    where id = '03111111-0000-0000-0000-0000000000a1'),
  'org-mate may still see THAT the peer is disabled (disabled_at)'
);
select throws_ok(
  $$select disabled_reason from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a1'$$,
  '42501', null,
  'org-mate CANNOT read disabled_reason — the leak is closed'
);
select throws_ok(
  $$select disabled_by from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a1'$$,
  '42501', null,
  'org-mate CANNOT read disabled_by — the God Admin identity stays hidden'
);
-- PostgREST serves /user_profiles?select=* as a literal star. It must FAIL loudly
-- for this role rather than silently return the operator columns.
select throws_ok(
  $$select * from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a1'$$,
  '42501', null,
  'select * is REFUSED for authenticated (no wildcard read can leak the columns)'
);
reset role;

-- ── 5. Behaviour: the DISABLED user reading their OWN row ──────────────────
-- The brief: "The internal reason must not automatically be shown to the
-- disabled user." Column privileges bind on the user's own row too, via
-- user_profiles_select_self — which is what makes that true by construction
-- rather than by the UI declining to render it.
set local "request.jwt.claim.sub"  to '03111111-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Load-bearing: the guard must still resolve `disabled` for this user, or they
-- get a 500 instead of the disabled screen.
select ok(
  (select disabled_at is not null from public.user_profiles
    where id = '03111111-0000-0000-0000-0000000000a1'),
  'the DISABLED user can still read their OWN disabled_at — the guard resolves, so they get the disabled screen not a 5xx'
);
select throws_ok(
  $$select disabled_reason from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a1'$$,
  '42501', null,
  'the DISABLED user CANNOT read their own disabled_reason'
);
reset role;

-- ── 6. The guard's real read path, verbatim, for a normal ACTIVE user ──────
set local "request.jwt.claim.sub"  to '03111111-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- loadAccountStatus: .from('user_profiles').select('disabled_at').eq('id', uid)
select is(
  (select disabled_at from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a2'),
  null,
  'loadAccountStatus read path works for an active user and reports ACTIVE'
);
-- loadSessionAndContext's widened select, column for column (session.ts:102).
select lives_ok(
  $$select id, email, full_name, avatar_url, default_organization_id, disabled_at
      from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a2'$$,
  'the loadSessionAndContext select still runs for authenticated'
);
reset role;

-- ── 7. service_role still sees everything ──────────────────────────────────
set local role to 'service_role';
select is(
  (select disabled_reason from public.user_profiles
    where id = '03111111-0000-0000-0000-0000000000a1'),
  'Suspected account compromise - notes: pending SOC review',
  'service_role (the platform console) still reads the reason'
);
select lives_ok(
  $$select * from public.user_profiles where id = '03111111-0000-0000-0000-0000000000a1'$$,
  'service_role select * still works'
);
reset role;

select * from finish();
rollback;
