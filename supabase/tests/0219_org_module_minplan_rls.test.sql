-- pgTAP: module minPlan entitlement enforced at RLS (migration 0219).
-- New orgs auto-seed an organization_modules row per module, so the real op is
-- UPDATE (flip `enabled`). We force the rows to a known DISABLED state as the
-- superuser (RLS/gate bypassed), then test the admin UPDATE path.
begin;
select plan(5);

\set orgFree '\'c9f00000-0000-0000-0000-0000000000f0\''
\set orgBiz  '\'c9b00000-0000-0000-0000-0000000000b0\''
\set orgComp '\'c9c00000-0000-0000-0000-0000000000c0\''
\set admFree '\'c9af0000-0000-0000-0000-0000000000af\''
\set admBiz  '\'c9ab0000-0000-0000-0000-0000000000ab\''
\set admComp '\'c9ac0000-0000-0000-0000-0000000000ac\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:admFree, 'free@mod.test', '{}'::jsonb),
  (:admBiz,  'biz@mod.test',  '{}'::jsonb),
  (:admComp, 'comp@mod.test', '{}'::jsonb);

insert into public.organizations (id, name, slug, access_tier, all_modules_comp) values
  (:orgFree, 'Free Org', 'free-mod-org', null,       false),  -- effective: free
  (:orgBiz,  'Biz Org',  'biz-mod-org',  'business', false),  -- effective: business
  (:orgComp, 'Comp Org', 'comp-mod-org', null,       true);   -- free plan but comped

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgFree, :admFree, 'admin', now()),
  (:orgBiz,  :admBiz,  'admin', now()),
  (:orgComp, :admComp, 'admin', now());

-- Force the rows we exercise into a known DISABLED state (superuser bypasses RLS
-- + the gate; upsert tolerates any auto-seeded rows).
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:orgFree, 'api_access',   false, 'premium'),
  (:orgFree, 'integrations', false, 'optional'),
  (:orgBiz,  'lot_serial',   false, 'premium'),
  (:orgComp, 'api_access',   false, 'premium')
on conflict (organization_id, module_id) do update set enabled = false, tier = excluded.tier;

-- ── free-plan admin ─────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'c9af0000-0000-0000-0000-0000000000af';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ update public.organization_modules set enabled = true
       where organization_id = 'c9f00000-0000-0000-0000-0000000000f0' and module_id = 'api_access' $$,
  '42501',
  null,
  'free-plan admin CANNOT enable api_access (enterprise minPlan)'
);
select lives_ok(
  $$ update public.organization_modules set enabled = true
       where organization_id = 'c9f00000-0000-0000-0000-0000000000f0' and module_id = 'integrations' $$,
  'free-plan admin CAN enable a non-premium (no minPlan) module'
);
select lives_ok(
  $$ update public.organization_modules set enabled = false
       where organization_id = 'c9f00000-0000-0000-0000-0000000000f0' and module_id = 'api_access' $$,
  'free-plan admin CAN keep/disable a premium module (no gate on disable)'
);
reset role;

-- ── business-plan admin ─────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'c9ab0000-0000-0000-0000-0000000000ab';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ update public.organization_modules set enabled = true
       where organization_id = 'c9b00000-0000-0000-0000-0000000000b0' and module_id = 'lot_serial' $$,
  'business-plan admin CAN enable a business-minPlan module'
);
reset role;

-- ── comped (free plan, all_modules_comp) admin ──────────────────────────────
set local "request.jwt.claim.sub" to 'c9ac0000-0000-0000-0000-0000000000ac';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ update public.organization_modules set enabled = true
       where organization_id = 'c9c00000-0000-0000-0000-0000000000c0' and module_id = 'api_access' $$,
  'comped org CAN enable any premium module regardless of plan'
);
reset role;

select * from finish();
rollback;
