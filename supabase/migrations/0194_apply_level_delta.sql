-- 0194_apply_level_delta.sql
-- Shared per-location allocation helper + adjust_stock null-location wiring.
-- Makes item_stock_levels authoritative: every null-location adjust_stock call
-- (picking, shipping, cancel-restore, manual adjust, etc.) now maintains levels.
-- + qty -> Staging; - qty -> draw down placed (mode 'placed') or Staging-first
-- (mode 'staging_first'); raises insufficient_placed_stock when short.

-- Partial unique index: at most one staging + one unplaced org-level bucket
-- (warehouse_id IS NULL). The existing locations_one_special_per_wh covers
-- warehouse-scoped buckets but does NOT cover NULL warehouse rows. This index
-- makes `on conflict do nothing` work correctly in ensure_org_placement_locations.
create unique index if not exists locations_one_special_per_org
  on public.locations(organization_id, kind)
  where warehouse_id is null and kind in ('staging','unplaced') and deleted_at is null;

-- SECURITY DEFINER helper: create org-level Staging + Unplaced buckets
-- (warehouse_id = NULL) when an item has no warehouse. Runs as table owner to
-- bypass locations_insert RLS (which requires manager), so staff-role
-- null-location positive adjustments on warehouseless items succeed.
create or replace function public.ensure_org_placement_locations(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then return; end if;
  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (p_org, null, 'Staging', 'other', 'staging') on conflict do nothing;
  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (p_org, null, 'Unplaced', 'other', 'unplaced') on conflict do nothing;
end; $$;

grant execute on function public.ensure_org_placement_locations(uuid) to authenticated;

create or replace function public.apply_level_delta(
  p_item_id uuid,
  p_qty     numeric,
  p_mode    text default 'placed'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_take   numeric;
  v_lvl    record;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;
  if v_org is null then return; end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
      -- Use SECURITY DEFINER helper to bypass locations_insert RLS (requires manager)
      -- so staff-role positive adjustments on warehouseless items also succeed.
      perform public.ensure_org_placement_locations(v_org);
      select id into v_loc from public.locations
        where organization_id = v_org and warehouse_id is null
          and kind = 'staging' and deleted_at is null limit 1;
    end if;
    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (v_org, p_item_id, v_loc, p_qty)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return;
  end if;

  -- ---- DECREMENT: draw down by mode --------------------------------------
  v_need := -p_qty;  -- positive amount to remove

  -- staging_first: drain the Staging level(s) before placed.
  if p_mode = 'staging_first' then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  for v_lvl in
    select s.location_id, s.quantity
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = p_item_id and s.quantity > 0 and l.kind <> 'staging'
     order by (case when l.kind = 'unplaced' then 1 else 0 end), l.created_at
  loop
    exit when v_need <= 0;
    v_take := least(v_lvl.quantity, v_need);
    update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
      where item_id = p_item_id and location_id = v_lvl.location_id;
    v_need := v_need - v_take;
  end loop;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
end;
$$;

-- Drop the previous 6-param overload so the new 7-param signature is unambiguous.
-- Callers that pass exactly 6 args with a null p_location_id would be ambiguous
-- between the old 6-param and the new 7-param overloads otherwise.
drop function if exists public.adjust_stock(uuid, numeric, text, uuid, text, text);

-- Rewire adjust_stock: null-location path now maintains levels via the helper.
-- (Verbatim copy of the 0189 body with the level block replaced.)
create or replace function public.adjust_stock(
  p_item_id          uuid,
  p_quantity_change  numeric,
  p_movement_type    text,
  p_location_id      uuid default null,
  p_reason           text default null,
  p_notes            text default null,
  p_mode             text default 'placed'   -- draw-down mode for the null-location negative path
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_prev numeric;
  v_new  numeric;
  v_user uuid := auth.uid();
begin
  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + p_quantity_change;
  if v_new < 0 then raise exception 'insufficient_stock' using errcode = 'P0001'; end if;

  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
  where id = p_item_id
  returning * into v_item;

  -- Per-location maintenance:
  if p_location_id is not null then
    -- Explicit location (e.g. receiving into Staging): mutate that level.
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_item.organization_id, p_item_id, p_location_id, p_quantity_change)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  else
    -- Null location: auto-allocate. + -> Staging, - -> draw-down by p_mode
    -- ('placed' for picks/ships; 'staging_first' for reversals/scrap write-offs).
    perform public.apply_level_delta(p_item_id, p_quantity_change, p_mode);
  end if;

  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, reason, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, p_movement_type,
    p_quantity_change, v_prev, v_new,
    case when p_quantity_change < 0 then p_location_id else null end,
    case when p_quantity_change > 0 then p_location_id else null end,
    p_reason, p_notes, v_user
  );

  return v_item;
end;
$$;

-- Re-grant: the DROP above removed the 0004 grant on the 6-arg signature.
-- Restore it on the new 7-arg signature so the explicit grant (and any future
-- revoke-public hardening) keeps adjust_stock callable by authenticated.
grant execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text, text)
  to authenticated;
