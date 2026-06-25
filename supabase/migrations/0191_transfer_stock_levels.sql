-- 0191_transfer_stock_levels.sql
-- Revive transfer_stock to the full two-table mutation (0071 left it audit-only
-- and explicitly anticipated this). Moves quantity between item_stock_levels
-- rows; net-zero on quantity_on_hand (total owned is unchanged, only location).
-- Used by Phase 2 "Place" (Staging -> rack) and by future inter-rack moves.

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
