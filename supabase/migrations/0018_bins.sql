-- 0018_bins.sql
-- ─────────────────────────────────────────────────────────────────────
-- First-class bins per warehouse + per-bin stock breakdown.
--
-- inventory_items.quantity_on_hand stays as the warehouse-total. The new
-- inventory_stock table tracks the qty per (warehouse, bin, item) for
-- finer-grained location and putaway flows.
--
-- Each warehouse gets a default 'Receiving' bin auto-created so the
-- existing receive flow continues to work without UI changes — it just
-- writes inventory_stock rows in addition to the existing
-- inventory_items.quantity_on_hand bump.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- bins
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.bins (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete cascade,
  code            text not null,
  name            text not null,
  bin_type        text not null check (bin_type in (
    'receiving','storage','qa_hold','damaged','rejected','shipping'
  )),
  is_default       boolean not null default false,
  pick_sequence    integer,
  putaway_sequence integer,
  status          text not null default 'active'
                    check (status in ('active','inactive','archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (warehouse_id, code)
);

-- One default per (warehouse, bin_type)
create unique index if not exists bins_default_per_type
  on public.bins(warehouse_id, bin_type)
  where is_default;

create index if not exists bins_warehouse_idx
  on public.bins(warehouse_id, status);

create trigger bins_updated_at
  before update on public.bins
  for each row execute function public.tg_set_updated_at();

alter table public.bins enable row level security;

drop policy if exists bins_select on public.bins;
create policy bins_select on public.bins
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = bins.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists bins_write on public.bins;
create policy bins_write on public.bins
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- inventory_stock — per-bin breakdown
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.inventory_stock (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete restrict,
  bin_id          uuid not null references public.bins(id) on delete restrict,
  item_id         uuid not null references public.inventory_items(id) on delete restrict,
  qty_on_hand     numeric(18,4) not null default 0 check (qty_on_hand >= 0),
  updated_at      timestamptz not null default now(),
  version         integer not null default 0,
  unique (warehouse_id, bin_id, item_id)
);

create index if not exists inventory_stock_item_idx
  on public.inventory_stock(item_id, warehouse_id);

create trigger inventory_stock_updated_at
  before update on public.inventory_stock
  for each row execute function public.tg_set_updated_at();

alter table public.inventory_stock enable row level security;

drop policy if exists inventory_stock_select on public.inventory_stock;
create policy inventory_stock_select on public.inventory_stock
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = inventory_stock.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists inventory_stock_write on public.inventory_stock;
create policy inventory_stock_write on public.inventory_stock
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- Backfill: every existing non-archived warehouse gets a Receiving bin.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  w record;
begin
  for w in
    select id, organization_id from public.warehouses where status <> 'archived'
  loop
    insert into public.bins(organization_id, warehouse_id, code, name, bin_type, is_default)
    values (w.organization_id, w.id, 'RECEIVING', 'Receiving Dock', 'receiving', true)
    on conflict (warehouse_id, code) do nothing;
  end loop;
end$$;

-- Convenience: default-bin lookup. Returns the default bin id of a given
-- type for a warehouse, or null if none.
create or replace function public.default_bin_for(
  p_warehouse_id uuid,
  p_bin_type     text
)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select id from public.bins
   where warehouse_id = p_warehouse_id
     and bin_type = p_bin_type
     and is_default
     and status = 'active'
   limit 1;
$$;

grant execute on function public.default_bin_for(uuid, text) to authenticated;
