-- ============================================================================
-- 0174_enable_returns_module.sql
-- ENABLE the 'returns' (RMA) module platform-wide — owner decision 2026-06-11,
-- made after the pre-go-live gate cleared: pnpm db:test GREEN on a live local
-- stack (all 57 pgTAP assertions incl. 0158_returns_invariants.test.sql —
-- over-return cap, cross-item reject, status-flip/delete inflation, scrap
-- net-zero, cancel-after-return double-restock all proven in live Postgres).
--
-- Two parts, mirroring how 0153 turned it off:
--   1. Existing orgs: 0153 grandfathered 'returns' enabled=false for every org.
--      Flip those rows to enabled=true (upsert covers orgs created in between
--      that have no row at all).
--   2. New orgs: redefine seed_org_modules() — byte-for-byte the 0165 version —
--      with ('returns','optional', true) added, so brand-new orgs get the
--      module ON (it is now advertised platform functionality, not an
--      experiment).
--
-- Runtime effect: module_enabled(org,'returns') flips true → the
-- /dashboard/returns staff UI + 'Returns' sidebar entry surface for roles
-- holding 'returns:manage' (owner/admin/manager), and /api/returns unlocks.
-- Mobile is intentionally untouched (no mobile returns route → no placement).
-- ============================================================================

-- 1. Flip 'returns' ON for every existing org -------------------------------
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'returns', true, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id)
  do update set enabled = true, enabled_at = now();

-- 2. Seed new orgs with 'returns' ON ----------------------------------------
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
    -- returns: gate cleared + owner-enabled 2026-06-11 (this migration)
    ('returns','optional', true),
    -- net-new opt-in optional (OFF)
    ('planning','optional', false),
    ('lot_serial','premium', false),
    ('price_tracking','optional', false),
    ('live_tracking','optional', false),
    -- net-new opt-in optional (OFF)
    ('zendesk','optional', false)
  ) as m(module_id, tier, enabled)
  on conflict (organization_id, module_id) do nothing;
  return new;
exception
  when others then
    raise warning 'seed_org_modules failed for org %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_org_modules on public.organizations;
create trigger trg_seed_org_modules
  after insert on public.organizations
  for each row execute function public.seed_org_modules();
