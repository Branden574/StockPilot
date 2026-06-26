-- 0201_assert_location_in_org.sql
-- Tenant-isolation hardening for the stock mutators. transfer_stock (0191) and
-- adjust_stock's explicit-location path (0194) accepted a caller-supplied
-- location_id and stamped the new item_stock_levels row with the ITEM's org
-- without verifying the location itself belongs to that org. Both are
-- security-invoker + granted to `authenticated`, so a staff user could call them
-- directly with a foreign-org location_id, writing a level row that references
-- another tenant's location (cross-tenant integrity write). This guard validates
-- every caller-supplied location_id against the item's org before use.

create or replace function public.assert_location_in_org(
  p_location_id uuid,
  p_org_id      uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_location_id is null then
    return;
  end if;
  if not exists (
    select 1 from public.locations
    where id = p_location_id
      and organization_id = p_org_id
  ) then
    raise exception 'location_org_mismatch' using errcode = '42501';
  end if;
end;
$$;

grant execute on function public.assert_location_in_org(uuid, uuid) to authenticated;

-- Re-create transfer_stock (0191) with org-guard on both location params.
-- Body is verbatim from 0191; only the two `perform assert_location_in_org` lines
-- immediately after the has_org_role check are new.
create or replace function public.transfer_stock(
  p_item_id           uuid,
  p_from_location_id  uuid,
  p_to_location_id    uuid,
  p_quantity          numeric,
  p_notes             text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_from_qty numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_item.deleted_at is not null then raise exception 'item_deleted' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify both location IDs belong to the item's org ***
  perform public.assert_location_in_org(p_from_location_id, v_item.organization_id);
  perform public.assert_location_in_org(p_to_location_id,   v_item.organization_id);

  -- Decrement source (create the row at 0 first so the guard can fire).
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_from_location_id, 0)
  on conflict (item_id, location_id) do nothing;

  update public.item_stock_levels
    set quantity = quantity - p_quantity, updated_at = now()
  where item_id = p_item_id and location_id = p_from_location_id
  returning quantity into v_from_qty;

  if v_from_qty < 0 then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;

  -- Increment destination.
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_to_location_id, p_quantity)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  -- Net-zero on quantity_on_hand: only the location changed.
  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, 'transfer',
    0, v_item.quantity_on_hand, v_item.quantity_on_hand,
    p_from_location_id, p_to_location_id, p_notes, auth.uid()
  );

  return v_item;
end;
$$;

grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text) to authenticated;

-- Re-create adjust_stock (0194, 7-arg) with org-guard on the explicit-location path.
-- Body is verbatim from 0194; only the `perform assert_location_in_org` line
-- immediately after the has_org_role check (before v_prev :=) is new.
-- p_location_id is null on the auto-allocate path -> guard is a no-op.
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

  -- *** 0201: verify the caller-supplied location_id belongs to the item's org ***
  perform public.assert_location_in_org(p_location_id, v_item.organization_id);

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

grant execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text, text)
  to authenticated;
