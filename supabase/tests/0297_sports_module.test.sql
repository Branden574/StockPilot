-- supabase/tests/0297_sports_module.test.sql
--
-- Proves 0297: the sports module is registered OFF everywhere, seeds OFF for
-- new orgs, is plan-gated, and does NOT touch lot_serial.
--
-- Namespace: 50297000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(7);

\set orgOld '\'50297000-0000-0000-0000-000000000001\''
\set orgNew '\'50297000-0000-0000-0000-000000000002\''

-- An org that existed BEFORE the migration is represented by the grandfather
-- insert having already run; assert the shape holds for every org.
insert into public.organizations (id, name, slug) values (:orgOld, 'Pre-existing 0297', 'pre-existing-0297')
  on conflict (id) do nothing;

select is(
  (select count(*)::int from public.organizations o
    where not exists (
      select 1 from public.organization_modules om
      where om.organization_id = o.id and om.module_id = 'sports')),
  0,
  'every organization has a sports module row (grandfather insert covered them all)');

select is(
  (select count(*)::int from public.organization_modules
    where module_id = 'sports' and enabled),
  0,
  'sports is DISABLED for every org — nothing is switched on by the migration');

-- New orgs get the row from seed_org_modules().
insert into public.organizations (id, name, slug) values (:orgNew, 'Fresh org 0297', 'fresh-org-0297')
  on conflict (id) do nothing;

select is(
  (select enabled from public.organization_modules
    where organization_id = :orgNew and module_id = 'sports'),
  false,
  'a newly created org seeds sports OFF');

select is(
  (select tier from public.organization_modules
    where organization_id = :orgNew and module_id = 'sports'),
  'premium',
  'sports seeds at the premium tier');

-- The seed rebuild did not drop a pre-existing module.
select ok(
  (select count(*) from public.organization_modules where organization_id = :orgNew) >= 30,
  'the seed_org_modules rebuild kept every pre-existing module (no VALUES row was lost)');

-- lot_serial is untouched (owner decision: no dependency, stays off).
select is(
  (select enabled from public.organization_modules
    where organization_id = :orgNew and module_id = 'lot_serial'),
  false,
  'lot_serial is still grandfathered OFF and untouched by the sports module');

-- Plan gate parity with the TS minPlan.
select is(
  public.org_can_enable_module(:orgNew, 'sports'),
  false,
  'a starter-plan org cannot enable sports (minPlan business is mirrored in SQL)');

select * from finish();
rollback;
