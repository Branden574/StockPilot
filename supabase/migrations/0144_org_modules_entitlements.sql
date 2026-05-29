-- ============================================================================
-- 0144_org_modules_entitlements.sql
-- Entitlement axis: per-org module on/off + the domain pack identity.
--
-- Adds the DB side of the module registry (packages/core/src/modules/registry.ts):
--   - organizations.domain_pack — which domain pack an org runs (default charter_school).
--   - organization_modules      — per-org module enablement (tier, settings, who/when).
--   - module_enabled(org, mod)  — STABLE SECURITY DEFINER predicate for gating.
--
-- RLS helpers re-used verbatim from 0001_init.sql:
--   is_org_member(org_id uuid) -> boolean
--   has_org_role(org_id uuid, min_role text) -> boolean   (role arg is text)
-- Policies wrap helper calls in (SELECT ...) per the InitPlan convention (0140).
-- ============================================================================

-- Domain pack identity on the org ------------------------------------------
alter table public.organizations
  add column if not exists domain_pack text not null default 'charter_school'
  check (domain_pack in ('charter_school','distribution','agriculture_food','retail_backroom','light_3pl'));

-- Per-org module enablement ------------------------------------------------
create table if not exists public.organization_modules (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  module_id   text not null,
  enabled     boolean not null default true,
  tier        text not null check (tier in ('core','optional','premium')),
  settings    jsonb not null default '{}'::jsonb,
  enabled_at  timestamptz not null default now(),
  enabled_by  uuid references public.user_profiles(id),
  primary key (organization_id, module_id)
);

create index if not exists org_modules_enabled_idx
  on public.organization_modules (organization_id) where enabled;

-- Gating predicate ---------------------------------------------------------
create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_modules om
    where om.organization_id = p_org
      and om.module_id = p_module
      and om.enabled
  );
$$;

-- Explicitly grant EXECUTE (don't rely on the PUBLIC default) so the service /
-- API layer (Tasks 6-8) can call it; matches the repo's explicit-grant
-- convention for app-facing helpers.
grant execute on function public.module_enabled(uuid, text) to authenticated;

-- RLS ----------------------------------------------------------------------
alter table public.organization_modules enable row level security;

drop policy if exists org_modules_read on public.organization_modules;
create policy org_modules_read on public.organization_modules
  for select using ((SELECT public.is_org_member(organization_id)));

drop policy if exists org_modules_admin on public.organization_modules;
create policy org_modules_admin on public.organization_modules
  for all using ((SELECT public.has_org_role(organization_id, 'admin')))
          with check ((SELECT public.has_org_role(organization_id, 'admin')));

grant select, insert, update, delete on public.organization_modules to authenticated;
