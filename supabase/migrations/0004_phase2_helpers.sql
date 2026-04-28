-- ============================================================================
-- 0004_phase2_helpers.sql — RPCs and helpers used by Phase 2 services
-- ============================================================================

-- ----------------------------------------------------------------------------
-- adjust_stock: atomic stock change + ledger row.
-- Returns the updated item row.
-- ----------------------------------------------------------------------------
create or replace function public.adjust_stock(
  p_item_id          uuid,
  p_quantity_change  numeric,
  p_movement_type    text,
  p_location_id      uuid default null,
  p_reason           text default null,
  p_notes            text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item        public.inventory_items%rowtype;
  v_prev        numeric;
  v_new         numeric;
  v_user        uuid := auth.uid();
begin
  -- Lock the row for update so concurrent adjustments serialize.
  select * into v_item
  from public.inventory_items
  where id = p_item_id
  for update;

  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + p_quantity_change;

  if v_new < 0 then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;

  update public.inventory_items
    set quantity_on_hand = v_new,
        updated_at       = now(),
        updated_by       = v_user
  where id = p_item_id
  returning * into v_item;

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

-- ----------------------------------------------------------------------------
-- transfer_stock: move quantity between locations atomically.
-- ----------------------------------------------------------------------------
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
  v_to_qty   numeric;
begin
  if p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Decrement source
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

  -- Increment destination
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_to_location_id, p_quantity)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now()
  returning quantity into v_to_qty;

  -- Ledger entry (transfer doesn't change quantity_on_hand)
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

-- ----------------------------------------------------------------------------
-- low_stock_count: items below their reorder_point.
-- ----------------------------------------------------------------------------
create or replace function public.low_stock_count(p_org_id uuid)
returns int
language sql
stable
security invoker
as $$
  select count(*)::int
  from public.inventory_items
  where organization_id = p_org_id
    and status = 'active'
    and deleted_at is null
    and reorder_point > 0
    and quantity_on_hand <= reorder_point
$$;

-- ----------------------------------------------------------------------------
-- low_stock_items: list items below reorder point with deficit.
-- ----------------------------------------------------------------------------
create or replace function public.low_stock_items(p_org_id uuid, p_limit int default 50)
returns table (
  id                uuid,
  name              text,
  sku               text,
  quantity_on_hand  numeric,
  reorder_point     numeric,
  reorder_quantity  numeric,
  primary_location  text
)
language sql
stable
security invoker
as $$
  select
    i.id,
    i.name,
    i.sku,
    i.quantity_on_hand,
    i.reorder_point,
    i.reorder_quantity,
    l.name as primary_location
  from public.inventory_items i
  left join public.locations l on l.id = i.primary_location_id
  where i.organization_id = p_org_id
    and i.status = 'active'
    and i.deleted_at is null
    and i.reorder_point > 0
    and i.quantity_on_hand <= i.reorder_point
  order by (i.quantity_on_hand - i.reorder_point) asc, i.name asc
  limit p_limit
$$;

-- ----------------------------------------------------------------------------
-- inventory_value: sum of unit_cost * quantity_on_hand for active items.
-- ----------------------------------------------------------------------------
create or replace function public.inventory_value(p_org_id uuid)
returns numeric
language sql
stable
security invoker
as $$
  select coalesce(sum(unit_cost * quantity_on_hand), 0)
  from public.inventory_items
  where organization_id = p_org_id
    and status = 'active'
    and deleted_at is null
$$;

-- ----------------------------------------------------------------------------
-- generate_sku: produces a unique SKU within an org.
-- Format: <PREFIX>-<base36 epoch>-<base36 rand>
-- ----------------------------------------------------------------------------
create or replace function public.generate_sku(p_org_id uuid, p_prefix text default 'SP')
returns text
language plpgsql
stable
as $$
declare
  v_candidate text;
  v_attempts  int := 0;
begin
  loop
    v_candidate := upper(p_prefix) || '-' ||
                   upper(to_hex(extract(epoch from now())::bigint))::text ||
                   '-' || upper(substr(md5(random()::text), 1, 4));
    if not exists (
      select 1 from public.inventory_items
      where organization_id = p_org_id and sku = v_candidate
    ) then
      return v_candidate;
    end if;
    v_attempts := v_attempts + 1;
    exit when v_attempts > 5;
  end loop;
  return v_candidate;
end;
$$;

-- Grant execute to authenticated users (RLS still applies to the underlying tables).
grant execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text) to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text)        to authenticated;
grant execute on function public.low_stock_count(uuid)                                   to authenticated;
grant execute on function public.low_stock_items(uuid, int)                              to authenticated;
grant execute on function public.inventory_value(uuid)                                   to authenticated;
grant execute on function public.generate_sku(uuid, text)                                to authenticated;
