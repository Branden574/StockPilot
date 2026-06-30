-- supabase/tests/0221_user_connections_rls.test.sql
-- pgTAP: per-user RLS isolation for user_connections (migration 0221).
--
-- Seeds two users in the same org, inserts one connection row per user as
-- superuser, then switches to each user and asserts they each see exactly 1 row
-- (their own) — proving cross-user isolation within a shared org.
--
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(6);

\set orgId  '\'e2210000-0000-0000-0000-000000000001\''
\set userA  '\'e2210000-0000-0000-0000-0000000000a1\''
\set userB  '\'e2210000-0000-0000-0000-0000000000b2\''
\set connA  '\'e2210000-0000-0000-0000-000000000011\''
\set connB  '\'e2210000-0000-0000-0000-000000000022\''

-- ── Fixtures (seeded as superuser) ───────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'usera@uc-rls.test', '{}'::jsonb),
  (:userB, 'userb@uc-rls.test', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:orgId, 'UC RLS Test Org', 'uc-rls-test-org-0221')
  on conflict (id) do nothing;

-- Both users are accepted members of the same org.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgId, :userA, 'manager', now()),
  (:orgId, :userB, 'manager', now())
  on conflict do nothing;

-- One connection row per user, seeded as superuser bypassing RLS.
insert into public.user_connections (id, organization_id, user_id, provider_id, status) values
  (:connA, :orgId, :userA, 'zendesk', 'active'),
  (:connB, :orgId, :userB, 'zendesk', 'active')
  on conflict (organization_id, user_id, provider_id) do nothing;

-- ── Sanity: superuser sees both rows ─────────────────────────────────────────
select is(
  (select count(*)::int from public.user_connections
    where id in (:connA, :connB)),
  2,
  'superuser sees both seeded rows'
);

-- ── Become user A ─────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'e2210000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.user_connections),
  1,
  'user A sees exactly 1 row'
);
select ok(
  not exists (select 1 from public.user_connections where id = 'e2210000-0000-0000-0000-000000000022'),
  'user A cannot see user B''s connection row'
);

-- ── Become user B ─────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'e2210000-0000-0000-0000-0000000000b2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.user_connections),
  1,
  'user B sees exactly 1 row'
);
select ok(
  not exists (select 1 from public.user_connections where id = 'e2210000-0000-0000-0000-000000000011'),
  'user B cannot see user A''s connection row'
);

-- ── Insert guard: user B cannot insert a row claiming to be user A ────────────
select throws_ok(
  $$ insert into public.user_connections
       (id, organization_id, user_id, provider_id, status)
     values (
       'e2210000-0000-0000-0000-000000000033',
       'e2210000-0000-0000-0000-000000000001',
       'e2210000-0000-0000-0000-0000000000a1',  -- user A's id, but caller is B
       'zendesk2', 'active'
     ) $$,
  '42501',
  null,
  'user B cannot insert a row with user_id = user A (RLS insert check rejects it)'
);

select * from finish();
rollback;
