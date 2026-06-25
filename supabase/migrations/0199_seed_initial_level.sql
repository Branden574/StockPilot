-- 0199_seed_initial_level.sql
-- Phase 2a make item_stock_levels authoritative from item CREATION: the create
-- /import paths set quantity_on_hand directly without seeding a level, which
-- (post-2a) would make a new stocked item un-pickable (Σlevels=0<on_hand ->
-- insufficient_placed_stock on first decrement). An AFTER INSERT trigger seeds
-- the initial level for ALL create paths in one place. Destination = primary
-- location (if a real non-staging loc) else warehouse Unplaced else org Unplaced
-- -- pickable, mirroring the Phase 1 backfill's treatment of existing stock.

create or replace function public.tg_seed_initial_level()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc uuid;
begin
  if coalesce(new.quantity_on_hand, 0) <= 0 then return new; end if;

  -- Prefer the item's primary location if it's a real, non-staging placed bin.
  -- Scoped to the item's own org (and warehouse when set) so a forged/cross-tenant
  -- primary_location_id falls through to the org's own Unplaced bucket instead of
  -- seeding stock at another org's location (tenant-isolation guard).
  if new.primary_location_id is not null then
    select id into v_loc from public.locations
      where id = new.primary_location_id
        and organization_id = new.organization_id
        and deleted_at is null
        and kind is distinct from 'staging'
        and (new.warehouse_id is null or warehouse_id is not distinct from new.warehouse_id)
      limit 1;
  end if;

  -- Else the warehouse Unplaced location (create placement locs if needed).
  if v_loc is null and new.warehouse_id is not null then
    perform public.ensure_warehouse_placement_locations(new.warehouse_id);
    select id into v_loc from public.locations
      where warehouse_id = new.warehouse_id and kind = 'unplaced' and deleted_at is null
      limit 1;
  end if;

  -- Else an org-level Unplaced bucket (no warehouse), created on demand.
  if v_loc is null then
    select id into v_loc from public.locations
      where organization_id = new.organization_id and warehouse_id is null
        and kind = 'unplaced' and deleted_at is null
      limit 1;
    if v_loc is null then
      insert into public.locations(organization_id, name, type, kind)
      values (new.organization_id, 'Unplaced', 'other', 'unplaced')
      returning id into v_loc;
    end if;
  end if;

  insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
  values (new.organization_id, new.id, v_loc, new.quantity_on_hand)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  return new;
exception
  when others then
    -- Never block item creation on a seeding hiccup (mirror the 0188 trigger).
    raise warning 'seed initial level failed for item %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_initial_level on public.inventory_items;
create trigger trg_seed_initial_level
  after insert on public.inventory_items
  for each row execute function public.tg_seed_initial_level();
