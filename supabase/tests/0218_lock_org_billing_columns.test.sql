-- pgTAP: billing-column lockdown (migration 0218).
-- A tenant admin (authenticated) cannot change entitlement columns; can still
-- change ordinary columns; the service-role path (platform panel / Stripe) can.
begin;
select plan(3);

\set org   '\'b8000000-0000-0000-0000-0000000000b8\''
\set admin '\'b8a00000-0000-0000-0000-0000000000a8\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:admin, 'admin@billing.test', '{}'::jsonb);
insert into public.organizations (id, name, slug, access_tier) values
  (:org, 'Billing Test Org', 'billing-test-org', null);
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :admin, 'admin', now());

-- Become the org admin (RLS lets an admin UPDATE the org row; the trigger is
-- what must block the entitlement-column change).
set local "request.jwt.claim.sub" to 'b8a00000-0000-0000-0000-0000000000a8';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ update public.organizations set access_tier = 'enterprise'
       where id = 'b8000000-0000-0000-0000-0000000000b8' $$,
  '42501',
  null,
  'admin CANNOT self-upgrade access_tier (billing column locked)'
);
select lives_ok(
  $$ update public.organizations set name = 'Renamed Org'
       where id = 'b8000000-0000-0000-0000-0000000000b8' $$,
  'admin CAN still update an ordinary column (name)'
);
reset role;

-- The service-role path (platform billing panel + Stripe webhook) must still set
-- the entitlement columns.
set local role to 'service_role';
select lives_ok(
  $$ update public.organizations set access_tier = 'enterprise'
       where id = 'b8000000-0000-0000-0000-0000000000b8' $$,
  'service_role CAN set the billing columns (platform/Stripe path preserved)'
);
reset role;

select * from finish();
rollback;
