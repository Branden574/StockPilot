-- pgTAP: the no-escalation RLS guard on permission overrides (migration 0215).
-- An admin may only write a granted=true override for a permission they ALREADY
-- hold; granting an owner-reserved permission (billing:manage) is RLS-denied.
-- Revokes (granted=false) stay unrestricted; the owner can grant anything.
begin;
select plan(5);

\set org   '\'f5000000-0000-0000-0000-0000000000f5\''
\set owner '\'f5b00000-0000-0000-0000-0000000000b5\''
\set admin '\'f5a00000-0000-0000-0000-0000000000a5\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:owner, 'owner@esc.test', '{}'::jsonb),
  (:admin, 'admin@esc.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values (:org, 'Esc Test Org', 'esc-test-org');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :owner, 'owner', now()),
  (:org, :admin, 'admin', now());

-- Become the admin.
set local "request.jwt.claim.sub" to 'f5a00000-0000-0000-0000-0000000000a5';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Escalation BLOCKED: admin can't grant a permission they don't hold.
select throws_ok(
  $$ insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
       values ('f5000000-0000-0000-0000-0000000000f5','f5a00000-0000-0000-0000-0000000000a5','billing:manage', true) $$,
  '42501',
  null,
  'admin CANNOT grant themselves billing:manage (a permission they do not hold)'
);
select throws_ok(
  $$ insert into public.role_permission_overrides (organization_id, role, permission, granted)
       values ('f5000000-0000-0000-0000-0000000000f5','staff','billing:manage', true) $$,
  '42501',
  null,
  'admin CANNOT grant billing:manage to a role (escalation blocked at RLS)'
);

-- ALLOWED: admin grants a permission they DO hold.
select lives_ok(
  $$ insert into public.role_permission_overrides (organization_id, role, permission, granted)
       values ('f5000000-0000-0000-0000-0000000000f5','staff','items:create', true) $$,
  'admin CAN grant items:create (a permission they hold)'
);

-- ALLOWED: a granted=false (deny/revoke) override is unrestricted.
select lives_ok(
  $$ insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
       values ('f5000000-0000-0000-0000-0000000000f5','f5a00000-0000-0000-0000-0000000000a5','billing:manage', false) $$,
  'admin CAN write a granted=false override for any permission'
);

reset role;

-- Owner CAN grant billing:manage (owner holds every permission).
set local "request.jwt.claim.sub" to 'f5b00000-0000-0000-0000-0000000000b5';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.role_permission_overrides (organization_id, role, permission, granted)
       values ('f5000000-0000-0000-0000-0000000000f5','manager','billing:manage', true) $$,
  'owner CAN grant billing:manage (owner holds all permissions)'
);
reset role;

select * from finish();
rollback;
