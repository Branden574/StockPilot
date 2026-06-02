-- ============================================================================
-- 0163_price_tracking_module_observations.sql
-- Phase 6 v1 — Google Books price monitoring.
-- 1) Grandfather the optional 'price_tracking' module OFF for existing orgs.
-- 2) Re-seed new orgs with it present-but-OFF.
-- 3) item_price_observations — append-only price/metadata history (RLS).
-- ============================================================================

set check_function_bodies = off;

-- ── 1) Grandfather existing orgs: 'price_tracking' OFF ──────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'price_tracking', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: byte-identical to 0162 + 'price_tracking' optional OFF ──
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
    ('planning','optional', false),
    ('lot_serial','premium', false),
    -- net-new opt-in optional (OFF)
    ('price_tracking','optional', false)
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

-- ── 2b) Catalog-rotation cursor on inventory_items ──────────────────────────
-- Stamped ONLY by the gated price_tracking write path (recordBookObservation)
-- so the cron can `order by last_priced_at nulls first` and rotate fairly
-- across catalogs larger than one run's limit. Nullable; never set elsewhere.
alter table public.inventory_items
  add column if not exists last_priced_at timestamptz;

-- ── 3) item_price_observations (append-only history) ────────────────────────
create table if not exists public.item_price_observations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  source           text not null default 'google_books',
  isbn             text,
  list_price       numeric(12,2),
  retail_price     numeric(12,2),
  currency         text,
  title            text,
  authors          text,
  average_rating   numeric(3,2),
  ratings_count    integer,
  categories       text,
  thumbnail_url    text,
  info_link        text,
  saleability      text,
  observed_at      timestamptz not null default now()
);

create index if not exists item_price_observations_item_idx
  on public.item_price_observations (organization_id, item_id, observed_at desc);

alter table public.item_price_observations enable row level security;

drop policy if exists item_price_observations_select on public.item_price_observations;
create policy item_price_observations_select on public.item_price_observations
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = item_price_observations.organization_id
        and m.accepted_at is not null
    )
  );

-- Floor = 'staff' to match the service gate (assertPermission items:update,
-- which staff holds). Mirrors 0162's lot_pick_events fix — a 'manager' floor
-- here would let a staff user clear the service gate then trip a raw RLS
-- denial surfaced as internal_error.
drop policy if exists item_price_observations_write on public.item_price_observations;
create policy item_price_observations_write on public.item_price_observations
  for all using (public.has_org_role(organization_id, 'staff'));
