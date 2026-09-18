-- 0354: module_enabled() honours organizations.all_modules_comp.
--
-- Pins the truth table, the unchanged security posture, and the point of the
-- whole change: the same rule decides what RLS lets a comped organization DO,
-- not only what its navigation offers.
begin;
select plan(23);

\set org_comp  '''c0354000-0000-0000-0000-00000000000c'''
\set org_plain '''c0354000-0000-0000-0000-00000000000d'''
\set mgr_comp  '''c0354000-0000-0000-0000-0000000000a1'''
\set mgr_plain '''c0354000-0000-0000-0000-0000000000a2'''

insert into auth.users (id, email) values
  (:mgr_comp, 'mgr-comp@test.local'), (:mgr_plain, 'mgr-plain@test.local');
insert into public.organizations (id, name, slug, all_modules_comp) values
  (:org_comp,  'Comped Org', 'comped-org-0354', true),
  (:org_plain, 'Plain Org',  'plain-org-0354',  false);
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_comp,  :mgr_comp,  'manager', now()),
  (:org_plain, :mgr_plain, 'manager', now());

-- ── The fixture this whole file stands on ───────────────────────────────────
-- seed_org_modules() wrote a maintenance_requests row for both organizations,
-- switched OFF. If that ever stops being true the comped assertions below would
-- pass for the wrong reason, so it is asserted, not assumed.
select is(
  (select count(*)::int from public.organization_modules
    where organization_id in (:org_comp, :org_plain)
      and module_id = 'maintenance_requests' and not enabled),
  2,
  'fixture: both organizations start with an explicit maintenance_requests row that is OFF');

-- ── 1. The function, as the catalog sees it ─────────────────────────────────
select ok(
  (select p.prosecdef from pg_proc p where p.oid = 'public.module_enabled(uuid, text)'::regprocedure),
  'still SECURITY DEFINER: it has to read past the caller''s RLS, from inside RLS');
select is(
  (select p.provolatile::text from pg_proc p where p.oid = 'public.module_enabled(uuid, text)'::regprocedure),
  's', 'still STABLE: safe to evaluate once per statement inside a policy');
select ok(
  (select exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%pg_temp%')
     from pg_proc p where p.oid = 'public.module_enabled(uuid, text)'::regprocedure),
  'search_path is pinned, pg_temp included');
select ok(not has_function_privilege('anon', 'public.module_enabled(uuid, text)', 'execute'),
  'anon still holds no EXECUTE');
select ok(has_function_privilege('authenticated', 'public.module_enabled(uuid, text)', 'execute'),
  'authenticated keeps EXECUTE: RLS policies evaluate it as the user');
select ok(has_function_privilege('service_role', 'public.module_enabled(uuid, text)', 'execute'),
  'service_role keeps EXECUTE');

-- ── 2. An organization that is NOT comped: exactly as before ────────────────
select is(public.module_enabled(:org_plain, 'maintenance_requests'), false,
  'not comped, row OFF: off');
update public.organization_modules set enabled = true
 where organization_id = :org_plain and module_id = 'maintenance_requests';
select is(public.module_enabled(:org_plain, 'maintenance_requests'), true,
  'not comped, row ON: on');
delete from public.organization_modules
 where organization_id = :org_plain and module_id = 'maintenance_requests';
select is(public.module_enabled(:org_plain, 'maintenance_requests'), false,
  'not comped, no row: off');

-- ── 3. A comped organization ────────────────────────────────────────────────
select is(public.module_enabled(:org_comp, 'maintenance_requests'), true,
  'comped, row explicitly OFF: ON. The comp wins, and this is the ordinary state of a comped org');
delete from public.organization_modules
 where organization_id = :org_comp and module_id = 'price_tracking';
select is(public.module_enabled(:org_comp, 'price_tracking'), true,
  'comped, no row at all: on');
select is(public.module_enabled('00000000-0000-0000-0000-00000000dead', 'maintenance_requests'), false,
  'an organization that does not exist has nothing, comp or no comp');

-- ── 4. What the rule is FOR: RLS lets the comped organization act ───────────
set local "request.jwt.claim.sub" to 'c0354000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok($$
  insert into public.maintenance_requests
    (organization_id, requester_user_id, requester_name_snapshot, subject, description)
  values ('c0354000-0000-0000-0000-00000000000c', 'c0354000-0000-0000-0000-0000000000a1',
          'Mgr Comp', 'Comped org files a request', 'Its module row says OFF; the comp says ON.')
$$, 'RLS: a manager in the COMPED organization can file a maintenance request although the module row is OFF');

set local role to postgres;
set local "request.jwt.claim.sub" to 'c0354000-0000-0000-0000-0000000000a2';
set local role to 'authenticated';
select throws_ok($$
  insert into public.maintenance_requests
    (organization_id, requester_user_id, requester_name_snapshot, subject, description)
  values ('c0354000-0000-0000-0000-00000000000d', 'c0354000-0000-0000-0000-0000000000a2',
          'Mgr Plain', 'Plain org files a request', 'No row, no comp.')
$$, '42501', null,
  'RLS: the same insert is still REFUSED for an organization that is not comped and has the module off');

-- The comp is per organization: being comped in one grants nothing in another.
select throws_ok($$
  insert into public.maintenance_requests
    (organization_id, requester_user_id, requester_name_snapshot, subject, description)
  values ('c0354000-0000-0000-0000-00000000000c', 'c0354000-0000-0000-0000-0000000000a2',
          'Mgr Plain', 'Reaching into the comped org', 'Not a member there.')
$$, '42501', null,
  'RLS: a manager of ANOTHER organization cannot use the comped organization''s entitlement');

-- ── 4b. Not a cross-tenant oracle ───────────────────────────────────────────
-- Still acting as the manager of the PLAIN organization, a stranger to the
-- comped one. An unconditional comp arm would answer true to an invented module
-- id exactly when the target is comped: a billing fact about someone else.
select is(public.module_enabled('c0354000-0000-0000-0000-00000000000c', 'not-a-real-module'), false,
  'a STRANGER probing the comped organization with an invented module learns nothing');
select is(public.module_enabled('c0354000-0000-0000-0000-00000000000c', 'maintenance_requests'), false,
  'a stranger gets the rows-only answer for a real module too: exactly the pre-0354 behaviour');

set local role to postgres;
set local "request.jwt.claim.sub" to 'c0354000-0000-0000-0000-0000000000a1';
set local role to 'authenticated';
select is(public.module_enabled('c0354000-0000-0000-0000-00000000000c', 'maintenance_requests'), true,
  'the comped organization''s OWN manager gets the comp');
select is(public.module_enabled('c0354000-0000-0000-0000-00000000000d', 'not-a-real-module'), false,
  'and being comped at home says nothing about any other organization');

-- ── 5. Withdrawing the comp puts the rows back in charge ────────────────────
set local role to postgres;
update public.organizations set all_modules_comp = false where id = :org_comp;
select is(public.module_enabled(:org_comp, 'maintenance_requests'), false,
  'comp withdrawn: the explicit OFF row decides again');
select is(public.module_enabled(:org_comp, 'price_tracking'), false,
  'comp withdrawn: a module with no row is off again');

-- org_can_enable_module() reads the same flag and must keep agreeing with it.
update public.organizations set all_modules_comp = true where id = :org_comp;
select ok(
  public.module_enabled(:org_comp, 'api_access') and public.org_can_enable_module(:org_comp, 'api_access'),
  'the two predicates that read the comp agree: enterprise-only api_access is both enable-able and ON');

select * from finish();
rollback;
