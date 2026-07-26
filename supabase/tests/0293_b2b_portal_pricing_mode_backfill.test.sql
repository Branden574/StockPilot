-- supabase/tests/0293_b2b_portal_pricing_mode_backfill.test.sql
--
-- Proves migration 0293's backfill: an org that ALREADY has a price list ends up
-- on the 'priced' portal pricing mode, an org without one is left completely
-- alone (it keeps the 'no_charge' default), and no sibling key in the shared
-- organization_modules.settings jsonb is clobbered on the way.
--
-- The migration already ran during `supabase db reset`, before these fixtures
-- existed, so the test re-invokes the SAME function the migration called
-- (public._backfill_portal_pricing_mode) against its own rows — the real
-- statement, not a transcription of it. Same shape as 0270's test.
--
-- Fixtures (four b2b_portal module rows):
--   orgA  price list, settings '{}'                          -> becomes priced
--   orgB  NO price list, settings '{}'                       -> untouched
--   orgC  price list, settings has a sibling key + no mode   -> priced, key kept
--   orgD  price list, settings already says 'no_charge'      -> NOT overwritten
--
-- Namespace: b2930000. Wrapped in begin/rollback -- nothing leaks.

begin;

select plan(9);

\set orgA '\'b2930000-0000-0000-0000-000000000001\''
\set orgB '\'b2930000-0000-0000-0000-000000000002\''
\set orgC '\'b2930000-0000-0000-0000-000000000003\''
\set orgD '\'b2930000-0000-0000-0000-000000000004\''

insert into public.organizations (id, name, slug) values
  (:orgA, 'Priced Org 0293',      'priced-org-0293'),
  (:orgB, 'No Charge Org 0293',   'no-charge-org-0293'),
  (:orgC, 'Sibling Keys Org 0293','sibling-keys-org-0293'),
  (:orgD, 'Explicit Org 0293',    'explicit-org-0293') on conflict (id) do nothing;

-- The portal is enabled for all four; only the DATA differs.
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'b2b_portal', true, 'optional', '{}'::jsonb),
  (:orgB, 'b2b_portal', true, 'optional', '{}'::jsonb),
  (:orgC, 'b2b_portal', true, 'optional', '{"portalWelcomeNote":"hello","someFlag":true}'::jsonb),
  (:orgD, 'b2b_portal', true, 'optional', '{"pricingMode":"no_charge"}'::jsonb)
  on conflict (organization_id, module_id) do update set settings = excluded.settings;

-- A second module row on orgA proves the backfill is scoped to b2b_portal and
-- does not spray pricingMode across every module's settings bucket.
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'inventory', true, 'core', '{}'::jsonb)
  on conflict (organization_id, module_id) do update set settings = excluded.settings;

-- Everyone EXCEPT orgB has a price list — that is the whole signal.
insert into public.price_lists (organization_id, name) values
  (:orgA, 'Schools 2026'),
  (:orgC, 'Wholesale'),
  (:orgD, 'Legacy');

-- 1. Fixture sanity: nothing carries a mode yet except the explicit orgD.
--    Without this the file could pass vacuously if a default ever appeared.
select is(
  (select count(*)::int from public.organization_modules
    where module_id = 'b2b_portal'
      and organization_id in (:orgA, :orgB, :orgC)
      and settings ? 'pricingMode'),
  0,
  'fixture: no pricingMode on orgA/orgB/orgC before the backfill');

-- Re-run the migration's own statement over these fixtures.
select lives_ok(
  $$ select public._backfill_portal_pricing_mode() $$,
  'the backfill runs');

-- 2. An org WITH a price list ends up priced.
select is(
  (select settings->>'pricingMode' from public.organization_modules
    where organization_id = :orgA and module_id = 'b2b_portal'),
  'priced',
  'org with a price list is backfilled to priced');

-- 3. An org WITHOUT a price list is untouched — still no key at all, so
--    resolvePortalPricingMode keeps returning the no_charge default.
select is(
  (select settings from public.organization_modules
    where organization_id = :orgB and module_id = 'b2b_portal'),
  '{}'::jsonb,
  'org with no price list is left exactly as it was');

-- 4. Pre-existing sibling keys survive the merge.
select is(
  (select settings->>'portalWelcomeNote' from public.organization_modules
    where organization_id = :orgC and module_id = 'b2b_portal'),
  'hello',
  'a pre-existing settings key survives the backfill');
select is(
  (select settings->'someFlag' from public.organization_modules
    where organization_id = :orgC and module_id = 'b2b_portal'),
  'true'::jsonb,
  'a second pre-existing settings key survives the backfill');
select is(
  (select settings->>'pricingMode' from public.organization_modules
    where organization_id = :orgC and module_id = 'b2b_portal'),
  'priced',
  'and that org is still backfilled to priced');

-- 5. An EXPLICIT no_charge choice is never overwritten, price list or not.
select is(
  (select settings->>'pricingMode' from public.organization_modules
    where organization_id = :orgD and module_id = 'b2b_portal'),
  'no_charge',
  'an explicit pricing mode is never overwritten');

-- 6. Scoped to b2b_portal: another module's settings bucket is not touched.
select is(
  (select settings from public.organization_modules
    where organization_id = :orgA and module_id = 'inventory'),
  '{}'::jsonb,
  'a different module''s settings are untouched');

select * from finish();
rollback;
