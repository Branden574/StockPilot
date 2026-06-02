-- ============================================================================
-- 0162_lot_serial_module_expiry.sql
-- Phase 5 v1 — food lot/expiry/FEFO (LIGHT model, no per-lot stock).
--
-- 1) Grandfather the premium 'lot_serial' module OFF for every existing org
--    (explicit opt-in; on for agriculture_food via applyIndustryPackAction's
--    modulesForPack, NOT this base trigger). Mirrors 0161/0147.
-- 2) Re-seed new orgs with 'lot_serial' present-but-OFF (premium).
-- 3) Per-item shelf life + expiry policy.
-- 4) lot_pick_events — FEFO traceability audit. NO stock impact.
-- ============================================================================

set check_function_bodies = off;

-- ── 1) Grandfather existing orgs: 'lot_serial' OFF ──────────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'lot_serial', false, 'premium', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: byte-identical to 0161 + 'lot_serial' premium OFF ──────
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
    -- net-new opt-in premium (OFF)
    ('lot_serial','premium', false)
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

-- ── 3) Per-item shelf life + expiry policy ──────────────────────────────────
alter table public.inventory_items
  add column if not exists shelf_life_days integer
    check (shelf_life_days is null or shelf_life_days > 0),
  add column if not exists expiry_policy text not null default 'warn'
    check (expiry_policy in ('none','warn','block'));

-- ── 4) lot_pick_events — FEFO traceability audit (NO stock impact) ──────────
create table if not exists public.lot_pick_events (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  order_request_id      uuid references public.order_requests(id) on delete set null,
  order_request_line_id uuid references public.order_request_lines(id) on delete set null,
  item_id               uuid not null references public.inventory_items(id) on delete restrict,
  lot_number            text not null,
  expiration_date       date,
  qty                   numeric(18,4) not null check (qty > 0),
  picked_by             uuid references auth.users(id) on delete set null,
  picked_at             timestamptz not null default now()
);

create index if not exists lot_pick_events_item_lot_idx
  on public.lot_pick_events(organization_id, item_id, lot_number);
create index if not exists lot_pick_events_line_idx
  on public.lot_pick_events(order_request_line_id);

alter table public.lot_pick_events enable row level security;

drop policy if exists lot_pick_events_select on public.lot_pick_events;
create policy lot_pick_events_select on public.lot_pick_events
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = lot_pick_events.organization_id
        and m.accepted_at is not null
    )
  );

-- Recording a lot pick is part of the staff picking workflow. The app-layer
-- pick flow (OrderRequestsService.recordPickedLine) requires the 'items:update'
-- permission, which staff hold; LotsService.recordLotPicks asserts the same.
-- The RLS floor is therefore set to 'staff' so a legitimate picker isn't
-- blocked at the database layer.
drop policy if exists lot_pick_events_write on public.lot_pick_events;
create policy lot_pick_events_write on public.lot_pick_events
  for all using (public.has_org_role(organization_id, 'staff'));
