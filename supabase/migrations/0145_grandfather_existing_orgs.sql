-- ============================================================================
-- 0145_grandfather_existing_orgs.sql
-- Grandfather every existing org with the FULL charter module set ENABLED so
-- behaviour is byte-for-byte identical to before the entitlement axis existed,
-- and seed new orgs on insert.
--
-- Module ids + tiers are the source-of-truth from
-- packages/core/src/modules/registry.ts (ModuleId union):
--   12 core + 13 optional + 3 premium that L4L already exercises
--   (lot_serial, ai_shelf_scan, reports_advanced) = 28 grandfathered.
-- api_access is intentionally NOT included.
--
-- New-org seed trigger inserts only core + optional (25); the 3 premium
-- modules are grandfathered onto existing orgs but are NOT auto-seeded for
-- brand-new orgs (they remain plan-gated entitlements).
-- ============================================================================

-- Backfill any org missing a domain pack (defensive; 0144 set NOT NULL default).
update public.organizations set domain_pack = 'charter_school' where domain_pack is null;

-- ── Grandfather existing orgs: 28 modules (core + optional + 3 premium) ─────
insert into public.organization_modules (organization_id, module_id, tier, enabled)
select o.id, m.module_id, m.tier, true
from public.organizations o
cross join (values
  -- 12 core
  ('overview','core'),
  ('inventory','core'),
  ('movements','core'),
  ('categories','core'),
  ('locations','core'),
  ('reports','core'),
  ('notifications','core'),
  ('team','core'),
  ('settings','core'),
  ('admin_tools','core'),
  ('charters','core'),
  ('scan','core'),
  -- 13 optional
  ('books','optional'),
  ('rentals','optional'),
  ('bundles','optional'),
  ('orders','optional'),
  ('cycle_counts','optional'),
  ('procedures','optional'),
  ('purchase_orders','optional'),
  ('receiving','optional'),
  ('po_imports','optional'),
  ('suppliers','optional'),
  ('schedule','optional'),
  ('ai','optional'),
  ('public_requests','optional'),
  -- 3 premium L4L exercises
  ('lot_serial','premium'),
  ('ai_shelf_scan','premium'),
  ('reports_advanced','premium')
) as m(module_id, tier)
on conflict (organization_id, module_id) do nothing;

-- ── New-org seed trigger: core + optional only (25) ────────────────────────
-- SECURITY DEFINER: the trigger fires AFTER INSERT on organizations, before any
-- membership exists, so an `authenticated` creator would fail the
-- has_org_role(...,'admin') write check on the brand-new org. DEFINER (with a
-- locked search_path) lets the seed succeed regardless of the caller's role.
-- The insert body is wrapped so a seed failure can NEVER abort tenant creation
-- (it degrades to a module-less org, which the grandfather backfill repairs).
create or replace function public.seed_org_modules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_modules (organization_id, module_id, tier, enabled)
  select new.id, m.module_id, m.tier, true
  from (values
    -- 12 core
    ('overview','core'),
    ('inventory','core'),
    ('movements','core'),
    ('categories','core'),
    ('locations','core'),
    ('reports','core'),
    ('notifications','core'),
    ('team','core'),
    ('settings','core'),
    ('admin_tools','core'),
    ('charters','core'),
    ('scan','core'),
    -- 13 optional
    ('books','optional'),
    ('rentals','optional'),
    ('bundles','optional'),
    ('orders','optional'),
    ('cycle_counts','optional'),
    ('procedures','optional'),
    ('purchase_orders','optional'),
    ('receiving','optional'),
    ('po_imports','optional'),
    ('suppliers','optional'),
    ('schedule','optional'),
    ('ai','optional'),
    ('public_requests','optional')
  ) as m(module_id, tier)
  on conflict (organization_id, module_id) do nothing;
  return new;
exception
  when others then
    -- Best-effort: never let a module-seed failure roll back org creation.
    -- The org is created module-less; the grandfather backfill (or a re-run
    -- of this migration's insert) will populate it.
    raise warning 'seed_org_modules failed for org %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_org_modules on public.organizations;
create trigger trg_seed_org_modules
  after insert on public.organizations
  for each row execute function public.seed_org_modules();
