-- pgTAP: org_members INSERT owner-guard (migration 0220).
-- An authenticated admin cannot mint an owner row, but can add a non-owner; the
-- service-role provisioning path can still create the first owner.
begin;
select plan(3);

\set org    '\'c2000000-0000-0000-0000-0000000000c2\''
\set admin  '\'c2a00000-0000-0000-0000-0000000000a2\''
\set target '\'c2b00000-0000-0000-0000-0000000000b2\''
\set owner2 '\'c2c00000-0000-0000-0000-0000000000c2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:admin,  'admin@guard.test',  '{}'::jsonb),
  (:target, 'target@guard.test', '{}'::jsonb),
  (:owner2, 'owner2@guard.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values (:org, 'Guard Org', 'guard-org');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :admin, 'admin', now());

-- Become the org admin (the 0217 INSERT policy lets an admin INSERT; the trigger
-- must block role='owner').
set local "request.jwt.claim.sub" to 'c2a00000-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('c2000000-0000-0000-0000-0000000000c2','c2c00000-0000-0000-0000-0000000000c2','owner', now()) $$,
  '42501',
  null,
  'admin CANNOT mint an owner row via direct insert (admin->owner escalation blocked)'
);
select lives_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('c2000000-0000-0000-0000-0000000000c2','c2b00000-0000-0000-0000-0000000000b2','staff', now()) $$,
  'admin CAN still add a non-owner member (legit path preserved)'
);
reset role;

-- The service-role provisioning path (auth.uid() IS NULL) can still create an
-- owner row. Clear the JWT subject first so auth.uid() resolves to NULL (the
-- trigger's service-role bypass key), as it would for a real admin-client call.
set local "request.jwt.claim.sub" to '';
set local role to 'service_role';
select lives_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('c2000000-0000-0000-0000-0000000000c2','c2c00000-0000-0000-0000-0000000000c2','owner', now()) $$,
  'service_role CAN create an owner row (provisioning/transfer path preserved)'
);
reset role;

select * from finish();
rollback;
