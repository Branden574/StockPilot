-- pgTAP: crown-jewel critical RLS fixes (migration 0217).
--   #6 organization_members self-insert can no longer self-grant owner.
--   #3 has_permission() ignores EXPIRED impersonation grants.
begin;
select plan(6);

\set org        '\'e6000000-0000-0000-0000-0000000000e6\''
\set owner      '\'e6010000-0000-0000-0000-000000000001\''
\set admin      '\'e6020000-0000-0000-0000-000000000002\''
\set outsider   '\'e6030000-0000-0000-0000-000000000003\''
\set impExpired '\'e6040000-0000-0000-0000-000000000004\''
\set impActive  '\'e6050000-0000-0000-0000-000000000005\''
\set newmember  '\'e6060000-0000-0000-0000-000000000006\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:owner,      'owner@cj.test',    '{}'::jsonb),
  (:admin,      'admin@cj.test',    '{}'::jsonb),
  (:outsider,   'outsider@cj.test', '{}'::jsonb),
  (:impExpired, 'impx@cj.test',     '{}'::jsonb),
  (:impActive,  'impa@cj.test',     '{}'::jsonb),
  (:newmember,  'new@cj.test',      '{}'::jsonb);

insert into public.organizations (id, name, slug) values (:org, 'CJ Test Org', 'cj-test-org');

insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:org, :owner,      'owner', now(), null),
  (:org, :admin,      'admin', now(), null),
  (:org, :impExpired, 'owner', now(), now() - interval '1 hour'),  -- EXPIRED act-as
  (:org, :impActive,  'owner', now(), now() + interval '1 hour');  -- active act-as
-- :outsider is intentionally NOT a member.

-- ── #6: a non-member cannot self-insert ANY role into the org ───────────────
set local "request.jwt.claim.sub" to 'e6030000-0000-0000-0000-000000000003'; -- outsider
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('e6000000-0000-0000-0000-0000000000e6','e6030000-0000-0000-0000-000000000003','owner', now()) $$,
  '42501',
  null,
  '#6: a non-member CANNOT self-insert as owner (cross-tenant takeover blocked)'
);
select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('e6000000-0000-0000-0000-0000000000e6','e6030000-0000-0000-0000-000000000003','viewer', now()) $$,
  '42501',
  null,
  '#6: a non-member CANNOT self-insert ANY role (even viewer)'
);
reset role;

-- ── #6: an admin CAN still add a member to their own org ────────────────────
set local "request.jwt.claim.sub" to 'e6020000-0000-0000-0000-000000000002'; -- admin
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.organization_members (organization_id, user_id, role)
       values ('e6000000-0000-0000-0000-0000000000e6','e6060000-0000-0000-0000-000000000006','staff') $$,
  '#6: an admin CAN still add a member to their own org (legit path preserved)'
);
reset role;

-- ── #3: has_permission honors impersonation expiry ──────────────────────────
set local "request.jwt.claim.sub" to 'e6040000-0000-0000-0000-000000000004'; -- EXPIRED impersonation owner
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(
  not public.has_permission(:org, 'items:create'),
  '#3: EXPIRED impersonation owner has NO permission (expiry honored)'
);
reset role;

set local "request.jwt.claim.sub" to 'e6050000-0000-0000-0000-000000000005'; -- ACTIVE impersonation owner
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(
  public.has_permission(:org, 'items:create'),
  '#3: ACTIVE impersonation owner has permission'
);
reset role;

set local "request.jwt.claim.sub" to 'e6010000-0000-0000-0000-000000000001'; -- normal owner (null expiry)
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(
  public.has_permission(:org, 'items:create'),
  '#3: a normal (non-impersonation) owner is unaffected'
);
reset role;

select * from finish();
rollback;
