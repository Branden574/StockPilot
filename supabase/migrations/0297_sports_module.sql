-- 0297_sports_module.sql
--
-- Registers the self-contained 'sports' premium module and its permission.
--
-- OWNER DECISION 2026-07-27: sports is self-contained. It grants its own
-- serial modes for sports categories and has NO lot_serial dependency;
-- lot_serial stays grandfathered OFF and untouched for every org.
--
-- Note: 'instant_size_count' was never added to seed_org_modules() nor
-- grandfathered — that is pre-existing drift and this migration does not
-- attempt to fix it (a separate decision).

-- ── 1) Grandfather every existing org: 'sports' OFF ─────────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'sports', false, 'premium', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: the 0174 list verbatim + 'sports' premium OFF ──────────
-- Copied byte-for-byte from 0174_enable_returns_module.sql (the latest
-- rewrite of this function; 0219 changes RLS only, not this body), with the
-- final ('sports','premium', false) row appended. Do not re-order, do not
-- tidy, do not drop a module — this function is rewritten wholesale by each
-- module migration and any omission silently stops seeding that module for
-- every org created afterwards.
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
    -- returns: gate cleared + owner-enabled 2026-06-11 (0174)
    ('returns','optional', true),
    -- net-new opt-in optional (OFF)
    ('planning','optional', false),
    ('lot_serial','premium', false),
    ('price_tracking','optional', false),
    ('live_tracking','optional', false),
    -- net-new opt-in optional (OFF)
    ('zendesk','optional', false),
    -- sports: self-contained premium module, OFF by default (this migration)
    ('sports','premium', false)
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

-- ── 3) minPlan parity with the TS registry (mirrors 0219) ───────────────────
-- The TS entry sets minPlan 'business'. Without this arm the SQL falls to
-- `else 0` and RLS would let any plan enable it — the exact drift
-- instant_size_count already has.
create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select all_modules_comp from public.organizations where id = org_id), false)
    or (
      case public.org_effective_tier(org_id)
        when 'pro' then 1 when 'business' then 2 when 'enterprise' then 3 else 0
      end
    ) >= (
      case p_module
        when 'lot_serial' then 2
        when 'reports_advanced' then 2
        when 'ai_shelf_scan' then 2
        when 'sports' then 2
        when 'api_access' then 3
        else 0
      end
    );
$$;

-- ── 4) Seed the permission defaults (mirrors 0279) ──────────────────────────
-- Owner/admin derive from ALL_PERMISSIONS in TS; the table flattens
-- admin/manager/staff/viewer, so two rows here. The 0207 pgTAP count moves
-- from 109 to 111.
insert into public.role_default_permissions (role, permission) values
  ('admin',   'sports:manage'),
  ('manager', 'sports:manage')
on conflict (role, permission) do nothing;
