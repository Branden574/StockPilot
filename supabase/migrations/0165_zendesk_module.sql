-- ============================================================================
-- 0165_zendesk_module.sql — Zendesk integration shell (Phase 1).
-- 1) Grandfather the optional 'zendesk' module OFF for existing orgs.
-- 2) Re-seed new orgs with it present-but-OFF (byte-identical to 0164 + 1 row).
-- No new tables: Zendesk rides org_connections (provider_id is free-text).
-- ============================================================================
set check_function_bodies = off;

insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'zendesk', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

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
