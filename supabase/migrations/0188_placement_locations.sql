-- 0188_placement_locations.sql
-- Foundation for PO receiving staging + multi-rack placement.
--
-- Racks/areas/crates become real `locations` rows (warehouse_id already exists
-- from 0007). Each warehouse gets exactly one Staging and one Unplaced location.
-- item_stock_levels (dormant since 0071) becomes the per-location source of truth
-- in later migrations.

alter table public.locations
  add column if not exists kind text
    check (kind in ('staging','area','rack','crate','unplaced')),
  add column if not exists rack_number text,
  add column if not exists rack_row    text,
  add column if not exists crate_color  text,
  add column if not exists crate_number text;

-- At most one staging and one unplaced location per warehouse.
create unique index if not exists locations_one_special_per_wh
  on public.locations(warehouse_id, kind)
  where kind in ('staging','unplaced') and deleted_at is null;

-- Idempotently ensure a warehouse has its Staging + Unplaced locations.
create or replace function public.ensure_warehouse_placement_locations(p_warehouse_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.warehouses where id = p_warehouse_id;
  if v_org is null then return; end if;

  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (v_org, p_warehouse_id, 'Staging', 'other', 'staging')
  on conflict do nothing;

  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (v_org, p_warehouse_id, 'Unplaced', 'other', 'unplaced')
  on conflict do nothing;
end;
$$;

-- Auto-create on new warehouses (mirrors the seed-trigger pattern in 0161).
create or replace function public.tg_seed_warehouse_locations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_warehouse_placement_locations(new.id);
  return new;
exception
  when others then
    raise warning 'seed warehouse locations failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_warehouse_locations on public.warehouses;
create trigger trg_seed_warehouse_locations
  after insert on public.warehouses
  for each row execute function public.tg_seed_warehouse_locations();

-- Backfill existing warehouses.
do $$
declare wh record;
begin
  for wh in select id from public.warehouses loop
    perform public.ensure_warehouse_placement_locations(wh.id);
  end loop;
end$$;
