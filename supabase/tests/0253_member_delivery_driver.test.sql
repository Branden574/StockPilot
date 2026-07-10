-- supabase/tests/0253_member_delivery_driver.test.sql
-- Proves migration 0253: organization_members.is_delivery_driver.
--   P1. Column exists with boolean type.
--   P2. Defaults to false on insert (existing members are NOT drivers).
--   P3. Can be flipped to true.
-- Namespace ab025300. Wrapped in begin/rollback.

begin;

select plan(3);

\set org '\'ab025300-0000-0000-0000-000000000001\''
\set usr '\'ab025300-0000-0000-0000-000000000002\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'driver-0253@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Driver Org 0253', 'driver-0253') on conflict (id) do nothing;

select has_column(
  'public', 'organization_members', 'is_delivery_driver',
  'P1: is_delivery_driver column exists');

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'staff', now());

select is(
  (select is_delivery_driver from public.organization_members
    where organization_id = :org and user_id = :usr),
  false,
  'P2: new members default to NOT a delivery driver');

update public.organization_members
  set is_delivery_driver = true
  where organization_id = :org and user_id = :usr;

select is(
  (select is_delivery_driver from public.organization_members
    where organization_id = :org and user_id = :usr),
  true,
  'P3: flag can be flipped to true');

select * from finish();

rollback;
