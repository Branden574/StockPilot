-- supabase/tests/NNNN_module_plan_check_matches_registry.test.sql (NNNN = the
-- migration's number, given in ship order; nothing in this file reads it)
--
-- pgTAP for the migration that restates public.org_can_enable_module with a
-- minimum plan for every module the registry
-- (packages/core/src/modules/registry.ts) gives one. The organization_modules
-- write policies (org_modules_admin_insert / _update) let an admin turn a
-- module on only while org_can_enable_module is true for it, so this file
-- checks the function's answers and the policies' outcome for instant size
-- count, and pins that every other module answers as it did.
--
-- Personas: one admin per organization.
--   oFree   no plan override (effective plan free)
--   oPro    access_tier pro
--   oBiz    access_tier business
--   oEnt    access_tier enterprise
--   oComp   no plan override, all_modules_comp on
--   oTrial  base plan free, an active business trial
--
-- F.  The fixture: each organization's effective plan (F1).
-- M.  The function's answers: instant size count needs business (M1); the
--     five modules it already named, and a module with no minimum plan,
--     answer as before on every plan (M2).
-- I.  Insert through the policies as each admin: below business, a row that
--     turns instant size count on is refused (I1, I2); a row that keeps it
--     off is accepted (I3); business, enterprise, the comped organization
--     and the business trial turn it on (I4-I7).
-- U.  Update through the policies: below business, turning the row on is
--     refused (U1, U2) and nothing changed (U3); business turns it on (U4).
-- E.  The modules the function already named, through the policies, as
--     before (E1-E4).
-- P.  The function keeps its posture (P1-P4).
--
-- Written to fail against the function before this migration in M1, I1, I2,
-- U1, U2 and U3; every other line passes there too.
begin;
select plan(24);

\set oFree  '\'d6500000-0000-0000-0000-0000000000f0\''
\set oPro   '\'d6500000-0000-0000-0000-0000000000a1\''
\set oBiz   '\'d6500000-0000-0000-0000-0000000000b2\''
\set oEnt   '\'d6500000-0000-0000-0000-0000000000e3\''
\set oComp  '\'d6500000-0000-0000-0000-0000000000c4\''
\set oTrial '\'d6500000-0000-0000-0000-0000000000d5\''
\set aFree  '\'d65a0000-0000-0000-0000-0000000000f0\''
\set aPro   '\'d65a0000-0000-0000-0000-0000000000a1\''
\set aBiz   '\'d65a0000-0000-0000-0000-0000000000b2\''
\set aEnt   '\'d65a0000-0000-0000-0000-0000000000e3\''
\set aComp  '\'d65a0000-0000-0000-0000-0000000000c4\''
\set aTrial '\'d65a0000-0000-0000-0000-0000000000d5\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:aFree,  'free@plan-check.test',  '{}'::jsonb),
  (:aPro,   'pro@plan-check.test',   '{}'::jsonb),
  (:aBiz,   'biz@plan-check.test',   '{}'::jsonb),
  (:aEnt,   'ent@plan-check.test',   '{}'::jsonb),
  (:aComp,  'comp@plan-check.test',  '{}'::jsonb),
  (:aTrial, 'trial@plan-check.test', '{}'::jsonb);

insert into public.organizations (id, name, slug, access_tier, all_modules_comp, trial_tier, trial_ends_at) values
  (:oFree,  'Plan Free',  'plan-check-free',  null,         false, null,       null),
  (:oPro,   'Plan Pro',   'plan-check-pro',   'pro',        false, null,       null),
  (:oBiz,   'Plan Biz',   'plan-check-biz',   'business',   false, null,       null),
  (:oEnt,   'Plan Ent',   'plan-check-ent',   'enterprise', false, null,       null),
  (:oComp,  'Plan Comp',  'plan-check-comp',  null,         true,  null,       null),
  (:oTrial, 'Plan Trial', 'plan-check-trial', null,         false, 'business', now() + interval '7 days');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:oFree,  :aFree,  'admin', now()),
  (:oPro,   :aPro,   'admin', now()),
  (:oBiz,   :aBiz,   'admin', now()),
  (:oEnt,   :aEnt,   'admin', now()),
  (:oComp,  :aComp,  'admin', now()),
  (:oTrial, :aTrial, 'admin', now());

-- Known state for the rows the update checks use (as the superuser, past row
-- level security): instant size count is off for oPro and oBiz and absent
-- for the others; the named modules are off where E flips them.
delete from public.organization_modules
 where organization_id in (:oFree, :oPro, :oBiz, :oEnt, :oComp, :oTrial)
   and module_id = 'instant_size_count';
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:oPro, 'instant_size_count', false, 'premium'),
  (:oBiz, 'instant_size_count', false, 'premium'),
  (:oPro, 'sports',             false, 'premium'),
  (:oBiz, 'api_access',         false, 'premium'),
  (:oEnt, 'api_access',         false, 'premium'),
  (:oFree, 'integrations',      false, 'optional')
on conflict (organization_id, module_id) do update set enabled = false, tier = excluded.tier;

-- ── F. fixture ──────────────────────────────────────────────────────────────
select results_eq(
  $$ select public.org_effective_tier(id) from public.organizations
      where id in ('d6500000-0000-0000-0000-0000000000f0', 'd6500000-0000-0000-0000-0000000000a1',
                   'd6500000-0000-0000-0000-0000000000b2', 'd6500000-0000-0000-0000-0000000000e3',
                   'd6500000-0000-0000-0000-0000000000c4', 'd6500000-0000-0000-0000-0000000000d5')
      order by id $$,
  $$ values ('pro'::text), ('business'), ('free'), ('business'), ('enterprise'), ('free') $$,
  'F1: the organizations have the effective plans the checks assume (ordered by id: a1 b2 c4 d5 e3 f0)'
);

-- ── M. the function's answers ───────────────────────────────────────────────
select results_eq(
  $$ select o.slug::text, public.org_can_enable_module(o.id, 'instant_size_count')
       from public.organizations o
      where o.slug like 'plan-check-%'
      order by o.slug $$,
  $$ values ('plan-check-biz'::text, true), ('plan-check-comp', true), ('plan-check-ent', true),
            ('plan-check-free', false), ('plan-check-pro', false), ('plan-check-trial', true) $$,
  'M1: instant size count can be enabled on business, enterprise, a business trial or the comp, and not on free or pro'
);

select results_eq(
  $$ select m.module_id,
            public.org_can_enable_module('d6500000-0000-0000-0000-0000000000f0', m.module_id),
            public.org_can_enable_module('d6500000-0000-0000-0000-0000000000a1', m.module_id),
            public.org_can_enable_module('d6500000-0000-0000-0000-0000000000b2', m.module_id),
            public.org_can_enable_module('d6500000-0000-0000-0000-0000000000e3', m.module_id),
            public.org_can_enable_module('d6500000-0000-0000-0000-0000000000c4', m.module_id)
       from (values ('ai_shelf_scan'), ('api_access'), ('integrations'), ('lot_serial'),
                    ('reports_advanced'), ('sports')) m(module_id)
      order by m.module_id $$,
  $$ values ('ai_shelf_scan'::text,    false, false, true,  true,  true),
            ('api_access',             false, false, false, true,  true),
            ('integrations',           true,  true,  true,  true,  true),
            ('lot_serial',             false, false, true,  true,  true),
            ('reports_advanced',       false, false, true,  true,  true),
            ('sports',                 false, false, true,  true,  true) $$,
  'M2: the modules already named, and one with no minimum plan, answer as before (free, pro, business, enterprise, comp)'
);

-- ── I. insert through the policies ──────────────────────────────────────────
set local role to 'authenticated';

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000f0';
select throws_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000f0', 'instant_size_count', true, 'premium') $$,
  '42501', null,
  'I1: a free organization''s admin cannot insert instant size count turned on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000a1';
select throws_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000a1', 'instant_size_count', true, 'premium')
     on conflict (organization_id, module_id) do update set enabled = true $$,
  '42501', null,
  'I2: a pro organization''s admin cannot upsert instant size count turned on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000f0';
select lives_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000f0', 'instant_size_count', false, 'premium')
     on conflict (organization_id, module_id) do update set enabled = false $$,
  'I3: a free organization''s admin can upsert instant size count turned off'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000e3';
select lives_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000e3', 'instant_size_count', true, 'premium') $$,
  'I4: an enterprise organization''s admin can insert instant size count turned on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000c4';
select lives_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000c4', 'instant_size_count', true, 'premium') $$,
  'I5: the comped organization''s admin can insert instant size count turned on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000d5';
select lives_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000d5', 'instant_size_count', true, 'premium') $$,
  'I6: the admin of an organization on a business trial can insert instant size count turned on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000b2';
select lives_ok(
  $$ insert into public.organization_modules (organization_id, module_id, enabled, tier)
     values ('d6500000-0000-0000-0000-0000000000b2', 'instant_size_count', true, 'premium')
     on conflict (organization_id, module_id) do update set enabled = true $$,
  'I7: a business organization''s admin can upsert instant size count turned on'
);

-- ── U. update through the policies ──────────────────────────────────────────
set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000f0';
select throws_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000f0' and module_id = 'instant_size_count' $$,
  '42501', null,
  'U1: a free organization''s admin cannot turn instant size count on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000a1';
select throws_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000a1' and module_id = 'instant_size_count' $$,
  '42501', null,
  'U2: a pro organization''s admin cannot turn instant size count on'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000a1';
select lives_ok(
  $$ update public.organization_modules set enabled = false
      where organization_id = 'd6500000-0000-0000-0000-0000000000a1' and module_id = 'instant_size_count' $$,
  'U4a: a pro organization''s admin can keep instant size count off'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000b2';
select lives_ok(
  $$ update public.organization_modules set enabled = false
      where organization_id = 'd6500000-0000-0000-0000-0000000000b2' and module_id = 'instant_size_count' $$,
  'U4b: a business organization''s admin can turn instant size count off'
);
select lives_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000b2' and module_id = 'instant_size_count' $$,
  'U4c: a business organization''s admin can turn instant size count back on'
);

-- ── E. the modules already named, through the policies ──────────────────────
set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000a1';
select throws_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000a1' and module_id = 'sports' $$,
  '42501', null,
  'E1: a pro organization''s admin cannot turn sports on, as before'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000b2';
select throws_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000b2' and module_id = 'api_access' $$,
  '42501', null,
  'E2: a business organization''s admin cannot turn API access on, as before'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000e3';
select lives_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000e3' and module_id = 'api_access' $$,
  'E3: an enterprise organization''s admin can turn API access on, as before'
);

set local "request.jwt.claim.sub" to 'd65a0000-0000-0000-0000-0000000000f0';
select lives_ok(
  $$ update public.organization_modules set enabled = true
      where organization_id = 'd6500000-0000-0000-0000-0000000000f0' and module_id = 'integrations' $$,
  'E4: a free organization''s admin can turn on a module with no minimum plan, as before'
);

reset role;

-- U3 (as the superuser): what the refused statements left behind.
select results_eq(
  $$ select o.slug::text, om.enabled
       from public.organization_modules om
       join public.organizations o on o.id = om.organization_id
      where o.slug like 'plan-check-%' and om.module_id = 'instant_size_count'
      order by o.slug $$,
  $$ values ('plan-check-biz'::text, true), ('plan-check-comp', true), ('plan-check-ent', true),
            ('plan-check-free', false), ('plan-check-pro', false), ('plan-check-trial', true) $$,
  'U3: instant size count is on only where the plan or the comp allows it'
);

-- ── P. posture ──────────────────────────────────────────────────────────────
select is(
  (select format('%s|%s|%s|%s|%s', pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile,
                 p.proconfig::text, pg_get_function_result(p.oid))
     from pg_proc p where p.oid = 'public.org_can_enable_module(uuid, text)'::regprocedure),
  'postgres|t|s|{search_path=public}|boolean',
  'P1: owner postgres, SECURITY DEFINER, STABLE, search_path public, returns boolean'
);

select ok(
  has_function_privilege('authenticated', 'public.org_can_enable_module(uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.org_can_enable_module(uuid, text)', 'execute'),
  'P2: authenticated and service_role may execute it'
);

select ok(
  not has_function_privilege('anon', 'public.org_can_enable_module(uuid, text)', 'execute'),
  'P3: anon may not execute it'
);

select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.org_can_enable_module(uuid, text)'::regprocedure
       and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ),
  'P4: PUBLIC holds no EXECUTE on it'
);

select * from finish();
rollback;
