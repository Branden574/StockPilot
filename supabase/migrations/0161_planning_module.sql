-- ============================================================================
-- 0161_planning_module.sql
-- Net-new optional module 'planning' (Demand Planning — velocity-based reorder
-- suggestions + auto-draft POs, Phase 4 T1) defaults OFF for every EXISTING org.
--
-- Like the 0147 'integrations' grandfather (and unlike the 0145 full-charter
-- grandfather), 'planning' is brand-new functionality NO org has ever exercised.
-- It must be explicit opt-in (admin enables it from the modules settings page,
-- or it ships on for the supply-heavy domain packs on brand-new orgs only). We
-- therefore seed the row with enabled=false for every existing org. The off row
-- makes module_enabled(org,'planning') return false and lets the UI show a
-- "not enabled" state without a missing-row special case.
--
-- Column set is the source-of-truth from 0144_org_modules_entitlements.sql:
--   organization_modules(organization_id, module_id, enabled, tier,
--                        settings default '{}', enabled_at default now(),
--                        enabled_by); tier check allows 'optional'.
-- ============================================================================

-- ── Grandfather existing orgs: 'planning' OFF (explicit opt-in) ─────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'planning', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── New-org seed trigger: append 'planning' seeded OFF ──────────────────────
-- 0145's seed_org_modules() enumerates a hardcoded module list and seeds every
-- entry enabled=true. 'planning' is opt-in, so we re-define the function with
-- 'planning' added seeded enabled=FALSE (an explicit per-row enabled flag),
-- keeping the rest of the list byte-for-byte identical to 0145. This keeps
-- brand-new orgs consistent with existing orgs (planning present but OFF);
-- pack-driven default-on for distribution/agriculture_food/light_3pl is applied
-- by the application layer's pack provisioning, not this base trigger.
create or replace function public.seed_org_modules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_modules (organization_id, module_id, tier, enabled)
  select new.id, m.module_id, m.tier, m.enabled
  from (values
    -- 12 core (enabled)
    ('overview','core', true),
    ('inventory','core', true),
    ('movements','core', true),
    ('categories','core', true),
    ('locations','core', true),
    ('reports','core', true),
    ('notifications','core', true),
    ('team','core', true),
    ('settings','core', true),
    ('admin_tools','core', true),
    ('charters','core', true),
    ('scan','core', true),
    -- 13 optional (enabled)
    ('books','optional', true),
    ('rentals','optional', true),
    ('bundles','optional', true),
    ('orders','optional', true),
    ('cycle_counts','optional', true),
    ('procedures','optional', true),
    ('purchase_orders','optional', true),
    ('receiving','optional', true),
    ('po_imports','optional', true),
    ('suppliers','optional', true),
    ('schedule','optional', true),
    ('ai','optional', true),
    ('public_requests','optional', true),
    -- net-new opt-in optional (OFF)
    ('planning','optional', false)
  ) as m(module_id, tier, enabled)
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
