-- ============================================================================
-- 0164_live_tracking.sql — Live delivery tracking (web v1).
-- 1) Grandfather the optional 'live_tracking' module OFF for existing orgs.
-- 2) Re-seed new orgs with it present-but-OFF (byte-identical to 0163 + 1 row).
-- 3) delivery_locations — latest driver point per active delivery order.
-- 4) charters geocode cache (destination lat/lng).
-- ============================================================================
set check_function_bodies = off;

-- ── 1) Grandfather existing orgs: 'live_tracking' OFF ───────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'live_tracking', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: byte-identical to 0163 + 'live_tracking' optional OFF ──
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
    -- net-new opt-in optional (OFF)
    ('live_tracking','optional', false)
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

-- ── 3) delivery_locations — latest driver point per active delivery order ───
create table if not exists public.delivery_locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  driver_user_id   uuid references public.user_profiles(id) on delete set null,
  lat              double precision not null,
  lng              double precision not null,
  heading          double precision,
  accuracy         double precision,
  recorded_at      timestamptz not null default now(),
  unique (order_request_id)
);
create index if not exists delivery_locations_org_idx
  on public.delivery_locations (organization_id);

alter table public.delivery_locations enable row level security;

drop policy if exists delivery_locations_select on public.delivery_locations;
create policy delivery_locations_select on public.delivery_locations
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = delivery_locations.organization_id
        and m.accepted_at is not null
    )
  );

-- Floor = 'staff' to match the service gate; the assigned-driver check is
-- enforced in the service/action. Customers never read via RLS — the public
-- poll endpoint uses the service-role admin client after verifying token+id+email.
drop policy if exists delivery_locations_write on public.delivery_locations;
create policy delivery_locations_write on public.delivery_locations
  for all using (public.has_org_role(organization_id, 'staff'));

-- ── 4) Destination geocode cache on charters (geocode each address once) ────
alter table public.charters
  add column if not exists geocoded_lat double precision,
  add column if not exists geocoded_lng double precision,
  add column if not exists geocoded_at  timestamptz;
